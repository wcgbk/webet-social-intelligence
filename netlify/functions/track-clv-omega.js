// track-clv.js
// API endpoint: GET/POST /.netlify/functions/track-clv
//
// Captures the TRUE closing line for each of today's picks and computes a real,
// two-sided no-vig Closing Line Value (CLV) — the north-star KPI for a sharp model.
//
// What "true close" means here (upgraded 2026-06-25):
//   1. SHARP ANCHOR, not soft-book median. We prefer Pinnacle, then a sharp-book
//      consensus (Betfair Exchange / Matchbook / Circa), and only fall back to an
//      all-book median when no sharp book is present. Regions us,us2,eu surface them.
//   2. AS CLOSE TO FIRST PITCH AS POSSIBLE. For games that have already started
//      (e.g. a past/graded date, or the morning settle pass) we pull the Odds API
//      HISTORICAL snapshot at the game's commence_time — the actual close. For
//      upcoming games we use the current line and let a later run (closer to first
//      pitch, or the next-morning historical pass) overwrite it via captureScore.
//   3. TWO-SIDED NO-VIG, not a flat haircut. CLV = noVig(closing) − noVig(bet),
//      where the no-vig probability is the side's raw implied divided by the market
//      overround (sum of both/all sides' raw implied) from the sharp anchor.
//
// Positive CLV = the fair (de-vigged) closing probability for our side is higher
// than the fair probability we bet at → the line moved toward us → we beat the close.
//
// CONTRACT (do NOT break — consumed by other functions):
//   • generate-picks-alpha-background.js fetchCLVFeedback() reads clv-{date}.bySport
//     and .byMarket, each entry having { count, clvSum, beat }. We keep those exactly
//     and only ADD fields (beatRate, bySource, byGameType, byCohort, ...).
//   • get-analytics.js reads clvData.picks[i].clv positionally aligned to the picks
//     blob. We keep clv numeric and the picks array in picks-blob order, 1:1.
//   • Results grading (win/loss/push + profit, written back to the picks blob) is
//     preserved unchanged.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Sport label → Odds API key mapping ──
// (MLB was missing — the now-MLB-primary alpha pipeline produced zero CLV because
//  fetch mapped 'MLB' → undefined and dropped it. Added baseball_mlb.)
const ODDS_SPORTS_MAP = {
  'MLB': 'baseball_mlb',
  'NBA': 'basketball_nba',
  'NHL': 'icehockey_nhl',
  'NCAAB': 'basketball_ncaab',
  'EPL': 'soccer_epl',
  'La Liga': 'soccer_spain_la_liga',
  'Serie A': 'soccer_italy_serie_a',
  'Bundesliga': 'soccer_germany_bundesliga',
  'Ligue 1': 'soccer_france_ligue_one',
  'MLS': 'soccer_usa_mls',
  'UCL': 'soccer_uefa_champs_league',
  'UEL': 'soccer_uefa_europa_league',
  'Europa': 'soccer_uefa_europa_league',
};

// ── Sharp-book anchor priority (the-odds-api book keys) ──
// Pinnacle first (the reference sharp), then exchanges / sharp US books. Surfaced by
// regions us,us2,eu. If none are present for a market we fall back to an all-book median.
const SHARP_BOOKS = ['pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'betfair', 'matchbook', 'circasports'];

// Full-game vs first-five-innings (F5) market keys. F5 is ONLY served by the per-event
// odds endpoint (the bulk /odds call rejects it), so F5 closes are fetched per game.
const FULL_MARKETS = 'h2h,spreads,totals';
const F5_MARKETS = 'h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings';
const ODDS_REGIONS = 'us,us2,eu';

// Treat a capture taken within this many minutes BEFORE first pitch as "at the close".
const PRE_PITCH_BUFFER_MIN = 3;

// ── Normalize team name for fuzzy matching ──
function normalizeTeam(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the last word (usually the mascot/club name) for matching
function lastWord(name) {
  const parts = normalizeTeam(name).split(' ');
  return parts[parts.length - 1] || '';
}

// Check if two team names are a fuzzy match
function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (lastWord(a) === lastWord(b)) return true;
  const fa = na.split(' ')[0];
  const fb = nb.split(' ')[0];
  if (fa.length > 3 && fa === fb) return true;
  return false;
}

// ── Convert American odds to implied probability (raw, with vig) ──
function impliedProbability(americanOdds) {
  const odds = parseInt(americanOdds, 10);
  if (isNaN(odds)) return null;
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  } else {
    return 100 / (odds + 100);
  }
}

// ── Small numeric helpers ──
function median(arr) {
  const xs = (arr || []).filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}
function medianOdds(arr) {
  const m = median(arr);
  return m === null ? null : Math.round(m);
}

// ET calendar date (America/New_York) for an ISO timestamp — the product runs on ET.
function etDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
      .toISOString().split('T')[0];
  } catch (e) { return null; }
}

// ── Describe which side/market a pick is on ──
function pickSideInfo(pick) {
  const pickLower = (pick.pick || '').toLowerCase();
  const bt = (pick.betType || pick.market || '').toLowerCase();
  const src = (pick.source || '').toLowerCase();
  const isF5 = bt.startsWith('f5') || /\bf5\b/.test(pickLower) || src === 'f5';

  let marketBase = 'h2h';
  if (bt.includes('total')) marketBase = 'totals';
  else if (bt.includes('spread') || bt.includes('puck') || bt.includes('run line')) marketBase = 'spreads';
  else if (bt.includes('moneyline') || bt === 'ml' || bt.includes('draw')) marketBase = 'h2h';
  // No explicit betType but pick text carries over/under → total
  else if (/\b(over|under)\b/.test(pickLower)) marketBase = 'totals';
  // A bare +/- number with no over/under → spread
  else if (/[+-]\d+(\.\d+)?/.test(pickLower) && !/\b(over|under)\b/.test(pickLower)) marketBase = 'spreads';

  const marketKey = isF5
    ? (marketBase === 'h2h' ? 'h2h_1st_5_innings'
      : marketBase === 'spreads' ? 'spreads_1st_5_innings'
        : 'totals_1st_5_innings')
    : marketBase;

  return {
    isF5,
    marketBase,
    marketKey,
    isOver: pickLower.includes('over'),
    isUnder: pickLower.includes('under'),
    isDraw: /\bdraw\b/.test(pickLower) || bt.includes('draw'),
  };
}

// Strip odds/line tokens from pick text to get the team-ish portion (ML/spread side)
function stripLine(text) {
  return (text || '')
    .replace(/\bF5\b/gi, '')
    .replace(/[+-]?\d+(\.\d+)?/g, '')
    .replace(/\bML\b/gi, '')
    .replace(/\b(over|under|moneyline|run line|puck line|spread|total|draw)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The bet's own line (total number or spread number) parsed from the pick text
function parseBetLine(pick, sideInfo) {
  const t = pick.pick || '';
  if (sideInfo.marketBase === 'totals') {
    const m = t.match(/(over|under)\s*([\d.]+)/i);
    return m ? parseFloat(m[2]) : null;
  }
  if (sideInfo.marketBase === 'spreads') {
    const m = t.match(/([+-]\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

// Full-game vs F5 segment, and a normalized "source" bucket for per-source beat-rate.
function segmentOf(pick) {
  const bt = (pick.betType || pick.market || '').toLowerCase();
  const src = (pick.source || '').toLowerCase();
  return (src === 'f5' || bt.startsWith('f5')) ? 'f5' : 'fullgame';
}
function sourceKey(pick) {
  if (segmentOf(pick) === 'f5') return 'F5';
  const s = (pick.source || '').trim().toLowerCase();
  if (s === 'kalshi') return 'Kalshi';
  if (s === 'polymarket') return 'Polymarket';
  return 'full-game';
}

// ── Extract the sharp-anchor closing price + market overround for a pick's side ──
// gameObj may be a full-game bulk game object OR a per-event (F5) object — both carry
// { home_team, away_team, bookmakers:[{ key, title, markets:[{ key, outcomes:[{name, price, point}] }] }] }.
// Returns { sideOdds, sideRaw, overround, closingLine, anchor, anchorBook } or null.
function extractClose(gameObj, sideInfo, pick) {
  if (!gameObj || !gameObj.bookmakers) return null;
  const teamText = stripLine(pick.pick || '');
  const isTeamMarket = sideInfo.marketBase !== 'totals' && !sideInfo.isDraw;
  const pickedHome = isTeamMarket && teamsMatch(teamText, gameObj.home_team);
  const pickedAway = isTeamMarket && teamsMatch(teamText, gameObj.away_team);

  // Per-book view of the target market's outcomes
  const perBook = [];
  for (const b of gameObj.bookmakers) {
    const mkt = (b.markets || []).find(m => m.key === sideInfo.marketKey);
    if (!mkt || !mkt.outcomes || mkt.outcomes.length < 2) continue;
    perBook.push({ key: (b.key || '').toLowerCase(), title: b.title || b.key, outcomes: mkt.outcomes });
  }
  if (!perBook.length) return null;

  // From one book's outcomes: our side's price/line + the overround across all sides.
  const selectFrom = (outcomes) => {
    const allRaw = [];
    for (const o of outcomes) {
      const r = impliedProbability(o.price);
      if (r != null) allRaw.push(r);
    }
    if (allRaw.length < 2) return null; // need both/all sides for a real overround
    let sidePrice = null, line = null;
    for (const o of outcomes) {
      const n = (o.name || '').toLowerCase();
      let hit = false;
      if (sideInfo.marketBase === 'totals') hit = (sideInfo.isOver && n === 'over') || (sideInfo.isUnder && n === 'under');
      else if (sideInfo.isDraw) hit = (n === 'draw');
      else hit = (pickedHome && teamsMatch(o.name, gameObj.home_team)) || (pickedAway && teamsMatch(o.name, gameObj.away_team));
      if (hit) { sidePrice = o.price; line = (o.point !== undefined ? o.point : null); break; }
    }
    if (sidePrice == null) return null;
    const sideRaw = impliedProbability(sidePrice);
    if (sideRaw == null) return null;
    return { sidePrice, sideRaw, line, overround: allRaw.reduce((a, c) => a + c, 0) };
  };

  // 1) Single sharp book by priority (Pinnacle first)
  for (const sb of SHARP_BOOKS) {
    const b = perBook.find(x => x.key === sb);
    if (!b) continue;
    const s = selectFrom(b.outcomes);
    if (s) return {
      sideOdds: s.sidePrice, sideRaw: s.sideRaw, overround: s.overround, closingLine: s.line,
      anchor: sb === 'pinnacle' ? 'pinnacle' : 'sharp', anchorBook: b.title,
    };
  }

  // 2) Sharp consensus (median across 2+ present sharp books)
  const sharps = perBook.filter(x => SHARP_BOOKS.includes(x.key)).map(x => selectFrom(x.outcomes)).filter(Boolean);
  if (sharps.length >= 2) {
    return {
      sideOdds: medianOdds(sharps.map(s => s.sidePrice)),
      sideRaw: median(sharps.map(s => s.sideRaw)),
      overround: median(sharps.map(s => s.overround)),
      closingLine: median(sharps.map(s => s.line).filter(v => v != null)),
      anchor: 'sharp-consensus', anchorBook: `${sharps.length} sharp books`,
    };
  }

  // 3) All-book soft median (last resort — flagged so gating can discount it)
  const all = perBook.map(x => selectFrom(x.outcomes)).filter(Boolean);
  if (all.length) {
    return {
      sideOdds: medianOdds(all.map(s => s.sidePrice)),
      sideRaw: median(all.map(s => s.sideRaw)),
      overround: median(all.map(s => s.overround)),
      closingLine: median(all.map(s => s.line).filter(v => v != null)),
      anchor: 'soft-median', anchorBook: `${all.length}-book median`,
    };
  }
  return null;
}

// ── Find matching game in an odds-feed array for a pick ──
function findMatchingGame(pick, oddsData) {
  const matchup = (pick.matchup || '').toLowerCase();
  const pickText = (pick.pick || '').toLowerCase();

  for (const game of oddsData) {
    const homeInMatchup = teamsMatch(game.home_team, matchup) || matchup.includes(lastWord(game.home_team));
    const awayInMatchup = teamsMatch(game.away_team, matchup) || matchup.includes(lastWord(game.away_team));
    if (homeInMatchup && awayInMatchup) return game;

    const homeInPick = teamsMatch(game.home_team, pickText) || pickText.includes(lastWord(game.home_team));
    const awayInPick = teamsMatch(game.away_team, pickText) || pickText.includes(lastWord(game.away_team));
    if ((homeInMatchup || homeInPick) && (awayInMatchup || awayInPick)) return game;
  }
  return null;
}

// ── Odds API fetchers (live or historical-at-timestamp), with in-run caching ──
function oddsBase(historical) {
  return historical ? 'https://api.the-odds-api.com/v4/historical' : 'https://api.the-odds-api.com/v4';
}

// Bulk full-game odds for a sport. atISO=null → current line; atISO set → historical snapshot.
async function fetchBulk(sportKey, atISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { console.log('[track-clv] ODDS_API_KEY missing — skipping odds fetch'); return []; }
  const dateParam = atISO ? `&date=${encodeURIComponent(atISO)}` : '';
  const url = `${oddsBase(!!atISO)}/sports/${sportKey}/odds?regions=${ODDS_REGIONS}&markets=${FULL_MARKETS}&oddsFormat=american&apiKey=${apiKey}${dateParam}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) { console.log(`[track-clv] bulk ${sportKey} (${atISO || 'live'}): API ${resp.status}`); return []; }
    const json = await resp.json();
    return Array.isArray(json) ? json : (json.data || []); // historical wraps games in .data
  } catch (e) {
    console.log(`[track-clv] bulk ${sportKey} fetch failed: ${e.message}`);
    return [];
  }
}

// Per-event F5 odds for one MLB game. atISO=null → current; atISO set → historical at that time.
async function fetchEventF5(sportKey, eventId, atISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;
  const dateParam = atISO ? `&date=${encodeURIComponent(atISO)}` : '';
  const url = `${oddsBase(!!atISO)}/sports/${sportKey}/events/${eventId}/odds?regions=${ODDS_REGIONS}&markets=${F5_MARKETS}&oddsFormat=american&apiKey=${apiKey}${dateParam}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json && json.data ? json.data : json; // historical wraps event in .data; live is the event
  } catch (e) { return null; }
}

// ── ESPN score fetching for settlement grading (unchanged) ──
const ESPN_ENDPOINTS = {
  'NBA': 'basketball/nba', 'NHL': 'hockey/nhl', 'NCAAB': 'basketball/mens-college-basketball',
  'MLB': 'baseball/mlb', 'EPL': 'soccer/eng.1', 'La Liga': 'soccer/esp.1',
  'Serie A': 'soccer/ita.1', 'Bundesliga': 'soccer/ger.1', 'Ligue 1': 'soccer/fra.1',
  'MLS': 'soccer/usa.1', 'UCL': 'soccer/uefa.champions', 'UEL': 'soccer/uefa.europa',
  'Europa': 'soccer/uefa.europa',
};

async function fetchESPNScores(dateISO, sport) {
  const endpoint = ESPN_ENDPOINTS[sport];
  if (!endpoint) return [];
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard?dates=${dateParam}`, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) return null;
      const status = comp.status || ev.status || {};
      // First-5-innings (F5) score from per-inning linescores (MLB only). An F5 bet settles on the
      // score THROUGH 5 innings and is locked once the bottom of the 5th is complete (we've advanced
      // past the 5th, or the game is final with >=5 innings on both sides).
      const isMLB = sport === 'MLB';
      const parseLS = (c) => Array.isArray(c?.linescores) ? c.linescores.map(l => Number(l.value ?? l.displayValue ?? 0) || 0) : [];
      const awayLS = isMLB ? parseLS(away) : [];
      const homeLS = isMLB ? parseLS(home) : [];
      const sum5 = (a) => a.slice(0, 5).reduce((s, v) => s + v, 0);
      const period = status.period || 0;
      const st = status.type?.state || 'pre';
      const f5Complete = isMLB && ((period > 5) || (st === 'post' && awayLS.length >= 5 && homeLS.length >= 5));
      return {
        awayTeam: away.team?.displayName || '', awayAbbr: away.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeTeam: home.team?.displayName || '', homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        state: st,
        statusName: status.type?.name || '',
        completed: status.type?.completed === undefined ? null : !!status.type.completed,
        startISO: ev.date || comp.date || null,
        awayScoreF5: isMLB ? sum5(awayLS) : null,
        homeScoreF5: isMLB ? sum5(homeLS) : null,
        awayInnings: awayLS.length,
        homeInnings: homeLS.length,
        f5Complete: !!f5Complete,
      };
    }).filter(Boolean);
  } catch (e) { return []; }
}

function findGameForGrading(pick, games) {
  const matchup = (pick.matchup || '').toLowerCase();
  const parts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  const matches = [];
  for (const g of games) {
    const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
    const awayMatch = parts.some(p => teamsMatch(p, g.awayTeam)) || (awayLast.length > 3 && matchup.includes(awayLast));
    const homeMatch = parts.some(p => teamsMatch(p, g.homeTeam)) || (homeLast.length > 3 && matchup.includes(homeLast));
    if (awayMatch && homeMatch) matches.push(g);
  }
  if (matches.length <= 1) return matches[0] || null;
  // Day-night doubleheader: both games match by team name. Settle against the game whose
  // start is nearest the pick's commenceTime (ported from get-results-alpha) — the first
  // match is the opener, and grading the nightcap against it wrote false losses.
  const ct = pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
  if (isNaN(ct)) return matches[0];
  let best = matches[0], bestDiff = Infinity;
  for (const g of matches) {
    const gt = g.startISO ? Date.parse(g.startISO) : NaN;
    if (isNaN(gt)) continue;
    const diff = Math.abs(gt - ct);
    if (diff < bestDiff) { bestDiff = diff; best = g; }
  }
  return best;
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  // Postponed / canceled / suspended games are voided by every major US book (no action).
  // ESPN marks them state:'post' with completed:false — catch BEFORE score-based grading,
  // or a PPD game settles as a real 0-0 final (false Under win / RL loss / ML push).
  if (/POSTPONED|CANCELL?ED|SUSPENDED/i.test(game.statusName || '') ||
      (game.state === 'post' && game.completed === false)) return 'push';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || pick.market || '').toLowerCase();
  const src = (pick.source || '').toLowerCase();
  const isF5 = src === 'f5' || betType.startsWith('f5') || /\bf5\b/.test(pickStr.toLowerCase());
  // F5 bets settle on the score THROUGH 5 innings. Require >=5 recorded innings per side —
  // a final game missing linescores must stay pending (retried next run), never settle as
  // a phantom 0-0 F5 final or a false void.
  if (isF5 && ((game.awayInnings || 0) < 5 || (game.homeInnings || 0) < 5)) return 'pending';
  const awayScore = isF5 ? (game.awayScoreF5 ?? 0) : game.awayScore;
  const homeScore = isF5 ? (game.homeScoreF5 ?? 0) : game.homeScore;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\bF5\b/gi, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam);

  if (betType === 'total' || betType === 'f5 total' || /over|under/i.test(pickStr)) {
    const lineMatch = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (lineMatch) {
      const ou = lineMatch[1].toLowerCase(), line = parseFloat(lineMatch[2]), total = awayScore + homeScore;
      if (total === line) return 'push';
      return (ou === 'over' && total > line) || (ou === 'under' && total < line) ? 'win' : 'loss';
    }
  }
  if (/spread|puck|run line/.test(betType) || /[+-]\d+(\.\d+)?/.test(pickStr)) {
    const spreadMatch = pickStr.match(/([+-]\d+(\.\d+)?)/);
    if (spreadMatch && (pickedAway || pickedHome)) {
      const spread = parseFloat(spreadMatch[1]);
      const pickedScore = pickedAway ? awayScore : homeScore;
      const oppScore = pickedAway ? homeScore : awayScore;
      const adj = pickedScore + spread;
      if (adj === oppScore) return 'push';
      return adj > oppScore ? 'win' : 'loss';
    }
  }
  if (pickedAway || pickedHome) {
    const pickedScore = pickedAway ? awayScore : homeScore;
    const oppScore = pickedAway ? homeScore : awayScore;
    if (pickedScore === oppScore) return 'push';
    return pickedScore > oppScore ? 'win' : 'loss';
  }
  if (/draw/i.test(pickStr)) return awayScore === homeScore ? 'win' : 'loss';
  return 'pending';
}

function calcProfit(result, units, oddsStr) {
  if (result === 'pending' || result === 'push') return 0;
  const u = parseFloat((units || '1u').toString().replace(/u$/i, '')) || 1;
  const dollarPerUnit = 150;
  const risk = u * dollarPerUnit;
  const odds = parseInt((oddsStr || '-110').replace(/[^0-9+-]/g, ''));
  if (result === 'loss') return -risk;
  const win = odds > 0 ? risk * (odds / 100) : risk * (100 / Math.abs(odds));
  return Math.round(win);
}

// Aggregation bucket helper — keeps the {count, clvSum, beat} contract shape.
function bump(map, key, clv, beat) {
  if (!map[key]) map[key] = { count: 0, clvSum: 0, beat: 0 };
  map[key].count++;
  map[key].clvSum = +(map[key].clvSum + clv).toFixed(4);
  if (beat) map[key].beat++;
}
function finalizeBuckets(map) {
  for (const k of Object.keys(map)) {
    const d = map[k];
    d.beatRate = d.count ? +(d.beat / d.count).toFixed(4) : 0;
    d.avgCLV = d.count ? +(d.clvSum / d.count).toFixed(4) : 0;
  }
  return map;
}

// ── Picks blob I/O + ESPN-only settlement ──
// Used by the early settle (Step 1.5) and the awaited morning sweep. Grading runs on cheap
// ESPN scoreboard calls and writes results back IMMEDIATELY — it must never wait behind the
// slow per-pick historical close capture (that ordering is how whole days stayed unsettled).
async function loadPicksData(dateISO) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-omega');
    const data = await store.get(`picks-${dateISO}`, { type: 'json' });
    if (data) return data;
  } catch (e) { /* fall through to REST */ }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  if (!token) return null;
  try {
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/picks-${dateISO}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) return await resp.json();
  } catch (e) { /* ignore */ }
  return null;
}

async function writePicksData(dateISO, picksData) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-omega');
    await store.setJSON(`picks-${dateISO}`, picksData);
    return true;
  } catch (e) { /* fall through to REST */ }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  if (!token) return false;
  try {
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/picks-${dateISO}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(picksData),
    });
    return resp.ok;
  } catch (e) { return false; }
}

// Grade every unsettled pick for a date via ESPN finals and write results back to the picks
// blob. Mutates picksData in place (so later steps in the same run see the results and the
// Step 6.5 guard doesn't re-write). Returns the number of picks settled this call.
async function settleResultsForDate(dateISO, picksData) {
  const unsettled = (picksData.picks || []).filter(p => !p.result || p.result === 'pending');
  if (!unsettled.length) return 0;
  const sports = [...new Set(unsettled.map(p => p.sport).filter(Boolean))];
  const scoresBySport = {};
  await Promise.all(sports.map(async s => { scoresBySport[s] = await fetchESPNScores(dateISO, s); }));
  let settledCount = 0;
  for (const p of picksData.picks) {
    if (p.result && p.result !== 'pending') continue;
    const game = findGameForGrading(p, scoresBySport[p.sport] || []);
    if (!game) continue;
    const result = gradePick(p, game);
    if (result === 'pending') continue;
    p.result = result;
    p.profit = calcProfit(result, p.units, p.odds || p.pickTimeOdds);
    p.finalScore = `${game.awayScore}-${game.homeScore}`;
    p.settledAt = new Date().toISOString();
    settledCount++;
  }
  if (settledCount > 0) {
    const ok = await writePicksData(dateISO, picksData);
    if (!ok) console.log(`[track-clv] WARNING: settled ${settledCount} picks for ${dateISO} but blob write failed`);
  }
  return settledCount;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // Determine date — default to today ET
    const params = event.queryStringParameters || {};
    const now = new Date();
    const estOffset = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dateISO = params.date || estOffset.toISOString().split('T')[0];
    const nowMs = Date.now();

    console.log(`[track-clv] Tracking CLV for date: ${dateISO}`);

    // Morning runs also settle YESTERDAY's picks — evening games finish after the last
    // same-day run (7pm ET). This next-morning pass also captures yesterday's TRUE closes
    // via the historical path (all of yesterday's games are now in the past).
    const etHour = estOffset.getHours();
    if (!params.date && etHour < 12) {
      // Settle recent days INLINE and AWAITED. The old fire-and-forget self-POST usually died
      // with the lambda before the request left the process — any date whose games all ended
      // after the 7pm run stayed unsettled forever (55% of picks at one point). ESPN grading
      // is cheap; sweep the last 7 days here. Dates with nothing unsettled cost one blob read.
      const sweepDates = [];
      for (let back = 1; back <= 7; back++) {
        const d = new Date(estOffset); d.setDate(d.getDate() - back);
        sweepDates.push(d.toISOString().split('T')[0]);
      }
      for (const swISO of sweepDates) {
        try {
          const swPicks = await loadPicksData(swISO);
          if (!swPicks || !Array.isArray(swPicks.picks) || !swPicks.picks.length) continue;
          const n = await settleResultsForDate(swISO, swPicks);
          if (n > 0) console.log(`[track-clv] Sweep settled ${n} picks for ${swISO}`);
        } catch (e) { console.log(`[track-clv] Sweep ${swISO} failed: ${e.message}`); }
      }
      // Yesterday's TRUE close capture (historical odds) still runs via self-POST — best
      // effort only; settlement above no longer depends on it surviving.
      const yestISO = sweepDates[0];
      const siteURL = process.env.URL || 'https://webetsocial.com';
      fetch(`${siteURL}/.netlify/functions/track-clv?date=${yestISO}`, { method: 'POST' })
        .then(() => console.log(`[track-clv] Triggered overnight CLV capture for ${yestISO}`))
        .catch((e) => console.log(`[track-clv] Yesterday CLV trigger failed: ${e.message}`));
    }

    // ── Step 1: Load today's picks from Blobs ──
    const picksData = await loadPicksData(dateISO);

    if (!picksData || !picksData.picks || picksData.picks.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          message: `No picks found for ${dateISO}. Generate picks first.`,
          date: dateISO,
        }),
      };
    }

    console.log(`[track-clv] Found ${picksData.picks.length} picks for ${dateISO}`);

    // ── Step 1.5: Settle results FIRST. The per-pick historical close capture below is the
    // slow part of this sync function; if it times out, grading must already be on disk.
    try {
      const early = await settleResultsForDate(dateISO, picksData);
      if (early > 0) console.log(`[track-clv] Early-settled ${early} picks for ${dateISO}`);
    } catch (e) { console.log(`[track-clv] Early settle failed (non-fatal): ${e.message}`); }

    // ── Step 2: Load existing CLV data (merge mode — keep the capture closest to first pitch) ──
    let existingClv = null;
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('edge-picks-omega');
      existingClv = await store.get(`clv-${dateISO}`, { type: 'json' });
    } catch (e) {
      try {
        const token = process.env.NETLIFY_AUTH_TOKEN;
        const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
        if (token) {
          const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/clv-${dateISO}`;
          const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (resp.ok) existingClv = await resp.json();
        }
      } catch (e2) { /* ignore */ }
    }
    const findExisting = (pick) => (existingClv && Array.isArray(existingClv.picks))
      ? existingClv.picks.find(p => p.pick === pick.pick && p.matchup === pick.matchup)
      : null;

    // ── Step 3: Per-pick close capture ──
    // Caches keyed within this run so multiple picks on the same game/snapshot reuse one call.
    const bulkCache = new Map();   // `${sportKey}|${atISO||'live'}` -> games[]
    const eventCache = new Map();  // `${eventId}|${atISO||'live'}`  -> eventObj
    const getBulk = async (sportKey, atISO) => {
      const k = `${sportKey}|${atISO || 'live'}`;
      if (!bulkCache.has(k)) bulkCache.set(k, await fetchBulk(sportKey, atISO));
      return bulkCache.get(k);
    };
    const getEventF5 = async (sportKey, eventId, atISO) => {
      const k = `${eventId}|${atISO || 'live'}`;
      if (!eventCache.has(k)) eventCache.set(k, await fetchEventF5(sportKey, eventId, atISO));
      return eventCache.get(k);
    };

    const clvPicks = [];

    for (const pick of picksData.picks) {
      const sideInfo = pickSideInfo(pick);
      const sportKey = ODDS_SPORTS_MAP[pick.sport];
      const prev = findExisting(pick);

      const baseRecord = {
        pick: pick.pick,
        matchup: pick.matchup,
        sport: pick.sport || null,
        betType: pick.betType || pick.market || null,
        market: pick.betType || pick.market || null,
        segment: segmentOf(pick),
        source: sourceKey(pick),
        units: pick.units || null,
        pickTimeOdds: pick.odds || 'N/A',
        betLine: parseBetLine(pick, sideInfo),
        // Carried so findGameForGrading can disambiguate doubleheaders in the CLV grading
        // pass too (older clv records without it fall back to first-match).
        commenceTime: pick.commenceTime || null,
      };

      if (!sportKey) {
        // Unmapped sport — carry forward any prior capture, else record untracked.
        clvPicks.push(prev || { ...baseRecord, closingOdds: null, clv: null, clvCents: null, beatClosing: null, error: `Sport not mapped: ${pick.sport}` });
        continue;
      }

      // Resolve the game + decide live vs historical close.
      let commenceISO = pick.commenceTime || null;
      let commenceMs = commenceISO ? Date.parse(commenceISO) : NaN;
      let gameObj = null;
      let snapAt = null; // null → live current; ISO → historical snapshot

      // Upcoming (or commence unknown) → current line.
      if (!commenceISO || !Number.isFinite(commenceMs) || commenceMs >= nowMs - PRE_PITCH_BUFFER_MIN * 60000) {
        const games = await getBulk(sportKey, null);
        gameObj = findMatchingGame(pick, games);
        if (gameObj) { commenceISO = gameObj.commence_time || commenceISO; commenceMs = Date.parse(commenceISO); }
      }
      // Past/started, or live miss but we know commence → historical snapshot AT first pitch (the true close).
      if (!gameObj && Number.isFinite(commenceMs)) {
        const games = await getBulk(sportKey, commenceISO);
        gameObj = findMatchingGame(pick, games);
        if (gameObj) snapAt = commenceISO;
      }

      // F5 markets live only on the per-event endpoint.
      let extractObj = gameObj;
      if (gameObj && sideInfo.isF5 && gameObj.id) {
        const ev = await getEventF5(sportKey, gameObj.id, snapAt);
        if (ev) extractObj = ev;
      }

      const close = gameObj ? extractClose(extractObj, sideInfo, pick) : null;

      // Capture provenance: how close to first pitch this snapshot was.
      let captureMinsToCommence = null;
      if (snapAt) captureMinsToCommence = 0; // historical snapshot is taken AT commence
      else if (Number.isFinite(commenceMs)) captureMinsToCommence = Math.round((commenceMs - nowMs) / 60000);
      // Lower captureScore = closer to (and ideally just before) first pitch.
      const captureScore = captureMinsToCommence == null ? 5e5
        : (captureMinsToCommence >= -PRE_PITCH_BUFFER_MIN ? Math.max(0, captureMinsToCommence) : 1e6 + Math.abs(captureMinsToCommence));

      let rec;
      if (!close || !close.overround) {
        rec = {
          ...baseRecord,
          closingOdds: close ? String(close.sideOdds) : null,
          closingLine: close ? (close.closingLine ?? null) : null,
          anchor: close ? close.anchor : null,
          anchorBook: close ? close.anchorBook : null,
          pickTimeImplied: impliedProbability(pick.odds),
          closingImplied: close && close.sideRaw != null ? +close.sideRaw.toFixed(4) : null,
          pickTimeNoVig: null, closingNoVig: null, closingOverround: null, betDevigMethod: null,
          clv: null, clvCents: null, clvRaw: null, beatClosing: null,
          closeSnapshotAt: null, captureMinsToCommence, captureScore: 5e5,
          error: gameObj ? 'Could not extract sharp closing price for this market' : 'No matching game found in odds feed',
        };
      } else {
        const betRaw = impliedProbability(pick.odds);
        const closingNoVig = +(close.sideRaw / close.overround).toFixed(4);
        // De-vig the price we bet with the close market's two-sided overround as the
        // entry-overround proxy (vig is ~stable intraday). This is a real two-sided
        // de-vig, not a flat haircut — the haircut is the actual per-game/market overround.
        const pickTimeNoVig = betRaw != null ? +(betRaw / close.overround).toFixed(4) : null;
        const clv = (pickTimeNoVig != null) ? +(closingNoVig - pickTimeNoVig).toFixed(4) : null;
        const clvRaw = (betRaw != null && close.sideRaw != null) ? +(close.sideRaw - betRaw).toFixed(4) : null;

        rec = {
          ...baseRecord,
          closingOdds: String(close.sideOdds),
          closingLine: close.closingLine ?? null,
          anchor: close.anchor,
          anchorBook: close.anchorBook,
          pickTimeImplied: betRaw != null ? +betRaw.toFixed(4) : null,
          closingImplied: close.sideRaw != null ? +close.sideRaw.toFixed(4) : null,
          pickTimeNoVig,
          closingNoVig,
          closingOverround: +close.overround.toFixed(4),
          betDevigMethod: 'closing-overround',
          // 'clv' is the TRUE two-sided no-vig CLV. Field name preserved for the generator's
          // CLV-feedback loop and get-analytics, which both read pick.clv numerically.
          clv,
          clvCents: clv != null ? +(clv * 100).toFixed(2) : null,
          clvRaw, // legacy raw-implied (closing − bet) difference, for transparency
          beatClosing: clv != null ? clv > 0 : null,
          closeSnapshotAt: snapAt || new Date().toISOString(),
          captureMinsToCommence,
          captureScore,
        };
        console.log(`[track-clv] ${pick.sport} ${pick.pick}: bet=${pick.odds} close=${close.sideOdds}@${close.anchorBook}(${close.anchor}) noVigCLV=${rec.clvCents}c min2pitch=${captureMinsToCommence}`);
      }

      // Merge: keep whichever capture is closer to first pitch (and ideally pre-pitch).
      const prevScore = (prev && prev.clv != null && typeof prev.captureScore === 'number') ? prev.captureScore : Infinity;
      if (rec.clv != null && rec.captureScore <= prevScore) {
        clvPicks.push(rec);
      } else if (prev && prev.clv != null) {
        clvPicks.push({ ...prev, ...{ betType: rec.betType, market: rec.market, segment: rec.segment, source: rec.source } });
      } else {
        clvPicks.push(rec);
      }
    }

    // ── Step 4: Grade outcomes via ESPN final scores (unchanged contract) ──
    const sportsInPicks = [...new Set(picksData.picks.map(p => p.sport).filter(Boolean))];
    const espnScoresBySport = {};
    await Promise.all(sportsInPicks.map(async sport => {
      espnScoresBySport[sport] = await fetchESPNScores(dateISO, sport);
    }));

    let settledCount = 0;
    for (const clvPick of clvPicks) {
      const sportGames = espnScoresBySport[clvPick.sport] || [];
      const game = findGameForGrading(clvPick, sportGames);
      const result = gradePick(clvPick, game);
      const profit = calcProfit(result, clvPick.units, clvPick.pickTimeOdds);
      clvPick.result = result;
      clvPick.profit = profit;
      if (game && game.state === 'post') {
        clvPick.finalScore = `${game.awayScore}-${game.homeScore}`;
        settledCount++;
      }
    }
    console.log(`[track-clv] Graded ${settledCount}/${clvPicks.length} picks via ESPN scores`);

    // ── Step 5: Summary stats + beat-rate breakouts (per source / market / segment / cohort) ──
    const validClvPicks = clvPicks.filter(p => p.clv !== null && p.clv !== undefined);
    const avgCLV = validClvPicks.length > 0
      ? parseFloat((validClvPicks.reduce((sum, p) => sum + p.clv, 0) / validClvPicks.length).toFixed(4))
      : 0;
    const picksBeatClosing = validClvPicks.filter(p => p.beatClosing).length;

    const bySport = {}, byMarket = {}, bySource = {}, byGameType = {}, byCohort = {};
    const anchorBreakdown = {};
    for (const p of validClvPicks) {
      const s = p.sport || 'unknown';
      const m = p.market || 'unknown';
      const seg = p.segment || 'fullgame';
      const src = p.source || 'full-game';
      // Existing contract buckets ({count, clvSum, beat}) + added beatRate via finalizeBuckets.
      bump(bySport, s, p.clv, p.beatClosing);
      bump(byMarket, m, p.clv, p.beatClosing);
      // New breakouts for later gating/weighting (additive; nothing reads these yet).
      bump(bySource, src, p.clv, p.beatClosing);
      bump(byGameType, seg, p.clv, p.beatClosing);
      bump(byCohort, `${seg}|${s}|${m}`, p.clv, p.beatClosing);
      const a = p.anchor || 'none';
      anchorBreakdown[a] = (anchorBreakdown[a] || 0) + 1;
    }
    finalizeBuckets(bySport); finalizeBuckets(byMarket); finalizeBuckets(bySource);
    finalizeBuckets(byGameType); finalizeBuckets(byCohort);

    const sharpAnchored = validClvPicks.filter(p => p.anchor && p.anchor !== 'soft-median' && p.anchor !== 'none').length;

    const settledResults = clvPicks.filter(p => p.result && p.result !== 'pending');
    const wins = settledResults.filter(p => p.result === 'win').length;
    const losses = settledResults.filter(p => p.result === 'loss').length;
    const pushes = settledResults.filter(p => p.result === 'push').length;
    const totalProfit = settledResults.reduce((s, p) => s + (p.profit || 0), 0);

    const clvData = {
      date: dateISO,
      capturedAt: new Date().toISOString(),
      clvMethod: 'no-vig-sharp-anchor-v2',
      picks: clvPicks,
      avgCLV,
      avgCLVCents: parseFloat((avgCLV * 100).toFixed(2)),
      picksBeatClosing,
      totalTracked: validClvPicks.length,
      totalPicks: picksData.picks.length,
      sharpAnchoredCount: sharpAnchored,
      sharpAnchorPct: validClvPicks.length ? +((sharpAnchored / validClvPicks.length) * 100).toFixed(1) : 0,
      anchorBreakdown,
      bySport, byMarket,
      bySource, byGameType, byCohort, // ADDED — full-game vs F5 + per-source/market/cohort beat-rate
      // Settlement results (unchanged)
      wins, losses, pushes,
      totalProfit,
      settled: settledResults.length,
      pending: clvPicks.length - settledResults.length,
    };

    // ── Step 6: Store CLV data in Blobs ──
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('edge-picks-omega');
      await store.setJSON(`clv-${dateISO}`, clvData);
      console.log(`[track-clv] Stored CLV data at clv-${dateISO}`);
    } catch (blobErr) {
      console.error('[track-clv] Failed to store CLV via SDK, trying API:', blobErr.message);
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
      if (token) {
        try {
          const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/clv-${dateISO}`;
          await fetch(url, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(clvData),
          });
          console.log('[track-clv] Stored CLV data via API fallback');
        } catch (apiErr) {
          console.error('[track-clv] API fallback failed:', apiErr.message);
        }
      }
    }

    // ── Step 6.5: Write results back to picks blob (settlement) — unchanged ──
    const settledPicks = clvPicks.filter(p => p.result && p.result !== 'pending');
    if (settledPicks.length > 0) {
      try {
        const resultMap = new Map(settledPicks.map(p => [`${p.pick}||${p.matchup}`, p]));
        let anyChanged = false;
        const updatedPicksArr = picksData.picks.map(p => {
          const key = `${p.pick}||${p.matchup}`;
          const settled = resultMap.get(key);
          if (settled && (!p.result || p.result === 'pending')) {
            anyChanged = true;
            return { ...p, result: settled.result, profit: settled.profit, finalScore: settled.finalScore || null, settledAt: new Date().toISOString() };
          }
          return p;
        });

        if (anyChanged) {
          const updatedPicksData = { ...picksData, picks: updatedPicksArr };
          try {
            const { getStore } = await import('@netlify/blobs');
            const store = getStore('edge-picks-omega');
            await store.setJSON(`picks-${dateISO}`, updatedPicksData);
            console.log(`[track-clv] Wrote ${settledPicks.length} results back to picks-${dateISO}`);
          } catch (wbErr) {
            const token = process.env.NETLIFY_AUTH_TOKEN;
            const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
            if (token) {
              await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega/picks-${dateISO}`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedPicksData),
              });
              console.log(`[track-clv] Results written via API fallback`);
            }
          }
        }
      } catch (wbErr) {
        console.error(`[track-clv] Result write-back failed (non-fatal): ${wbErr.message}`);
      }
    }

    // ── Step 7: Return CLV summary ──
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(clvData),
    };

  } catch (err) {
    console.error('[track-clv] Error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: `CLV tracking failed: ${err.message}` }),
    };
  }
};

// ── Test-only exports (offline validation; no effect on the deployed handler) ──
// Mirrors the generator's `module.exports.extractF5FromEvent` pattern so the de-vig /
// sharp-anchor / side-parsing logic can be unit-tested without network or blob writes.
module.exports._test = {
  impliedProbability, median, medianOdds, teamsMatch, stripLine, parseBetLine,
  pickSideInfo, segmentOf, sourceKey, extractClose, findMatchingGame, SHARP_BOOKS,
  gradePick, calcProfit, findGameForGrading, fetchESPNScores, settleResultsForDate,
};
