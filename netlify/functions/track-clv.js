// track-clv.js
// API endpoint: GET/POST /.netlify/functions/track-clv
// Captures closing lines for today's picks by re-fetching current odds from The Odds API,
// compares them to the odds stored at pick time, and calculates CLV (Closing Line Value).
// Positive CLV = we got better odds than closing (good model). Negative = line moved against us.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Sport label → Odds API key mapping ──
const ODDS_SPORTS_MAP = {
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
  // Exact normalized match
  if (na === nb) return true;
  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  // Last-word match (e.g. "Arizona Wildcats" vs "Arizona")
  if (lastWord(a) === lastWord(b)) return true;
  // First word match for single-name teams (e.g. "Arsenal" vs "Arsenal FC")
  const fa = na.split(' ')[0];
  const fb = nb.split(' ')[0];
  if (fa.length > 3 && fa === fb) return true;
  return false;
}

// ── Convert American odds to implied probability ──
function impliedProbability(americanOdds) {
  const odds = parseInt(americanOdds, 10);
  if (isNaN(odds)) return null;
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  } else {
    return 100 / (odds + 100);
  }
}

// ── Extract consensus odds from bookmaker data for a specific team/side ──
function extractConsensusOdds(game, pickText, betType) {
  if (!game || !game.bookmakers || game.bookmakers.length === 0) return null;

  // Determine which team/side the pick is on
  const pickLower = pickText.toLowerCase();
  const homeTeam = game.home_team;
  const awayTeam = game.away_team;

  const isHome = teamsMatch(pickLower, homeTeam) || pickLower.includes(normalizeTeam(homeTeam));
  const isAway = teamsMatch(pickLower, awayTeam) || pickLower.includes(normalizeTeam(awayTeam));

  // Determine market key based on bet type
  let marketKey = 'h2h'; // default to moneyline
  const btLower = (betType || '').toLowerCase();
  if (btLower === 'spread' || btLower === 'puck line') {
    marketKey = 'spreads';
  } else if (btLower === 'total') {
    marketKey = 'totals';
  } else if (btLower === 'ml' || btLower === 'moneyline' || btLower === 'draw') {
    marketKey = 'h2h';
  }

  // Check for over/under in pick text
  const isOver = pickLower.includes('over');
  const isUnder = pickLower.includes('under');

  // Collect odds across all bookmakers
  const oddsValues = [];

  for (const book of game.bookmakers) {
    const market = book.markets.find(m => m.key === marketKey);
    if (!market) continue;

    for (const outcome of market.outcomes) {
      const outcomeName = outcome.name.toLowerCase();

      if (marketKey === 'totals') {
        if ((isOver && outcomeName === 'over') || (isUnder && outcomeName === 'under')) {
          oddsValues.push(outcome.price);
        }
      } else if (marketKey === 'h2h') {
        if (btLower === 'draw' && outcomeName === 'draw') {
          oddsValues.push(outcome.price);
        } else if (isHome && teamsMatch(outcome.name, homeTeam)) {
          oddsValues.push(outcome.price);
        } else if (isAway && teamsMatch(outcome.name, awayTeam)) {
          oddsValues.push(outcome.price);
        }
      } else {
        // spreads
        if (isHome && teamsMatch(outcome.name, homeTeam)) {
          oddsValues.push(outcome.price);
        } else if (isAway && teamsMatch(outcome.name, awayTeam)) {
          oddsValues.push(outcome.price);
        }
      }
    }
  }

  if (oddsValues.length === 0) return null;

  // Return median odds as "consensus"
  oddsValues.sort((a, b) => a - b);
  const mid = Math.floor(oddsValues.length / 2);
  const consensus = oddsValues.length % 2 === 0
    ? Math.round((oddsValues[mid - 1] + oddsValues[mid]) / 2)
    : oddsValues[mid];

  return consensus;
}

// ── Find matching game in odds data for a pick ──
function findMatchingGame(pick, oddsData) {
  const matchup = (pick.matchup || '').toLowerCase();
  const pickText = (pick.pick || '').toLowerCase();

  for (const game of oddsData) {
    const home = normalizeTeam(game.home_team);
    const away = normalizeTeam(game.away_team);

    // Check if both teams from the game appear in the matchup string
    const homeInMatchup = teamsMatch(game.home_team, matchup) ||
      matchup.includes(lastWord(game.home_team));
    const awayInMatchup = teamsMatch(game.away_team, matchup) ||
      matchup.includes(lastWord(game.away_team));

    if (homeInMatchup && awayInMatchup) return game;

    // Also check if either team appears in the pick text itself
    const homeInPick = teamsMatch(game.home_team, pickText) ||
      pickText.includes(lastWord(game.home_team));
    const awayInPick = teamsMatch(game.away_team, pickText) ||
      pickText.includes(lastWord(game.away_team));

    if ((homeInMatchup || homeInPick) && (awayInMatchup || awayInPick)) return game;
  }

  return null;
}

// ── Fetch current odds from The Odds API ──
async function fetchCurrentOdds(sports, dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY not configured');

  const allOdds = {};

  // Deduplicate sport keys
  const sportKeys = [...new Set(sports.map(s => ODDS_SPORTS_MAP[s]).filter(Boolean))];

  for (const sportKey of sportKeys) {
    try {
      const markets = sportKey.includes('icehockey')
        ? 'h2h,spreads,totals'
        : 'h2h,spreads,totals';

      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?regions=us&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);

      if (resp.ok) {
        const data = await resp.json();
        // Filter to today's games
        const todayGames = data.filter(g => {
          const gameDate = new Date(g.commence_time).toISOString().split('T')[0];
          return gameDate === dateISO;
        });
        if (todayGames.length > 0) {
          allOdds[sportKey] = todayGames;
        }
        console.log(`[track-clv] ${sportKey}: ${todayGames.length} games today (${data.length} total)`);
      } else {
        console.log(`[track-clv] ${sportKey}: API returned ${resp.status}`);
      }
    } catch (err) {
      console.error(`[track-clv] Error fetching ${sportKey}:`, err.message);
    }
  }

  return allOdds;
}

// ── ESPN score fetching for settlement grading ──
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
      return {
        awayTeam: away.team?.displayName || '', awayAbbr: away.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeTeam: home.team?.displayName || '', homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        state: status.type?.state || 'pre',
      };
    }).filter(Boolean);
  } catch (e) { return []; }
}

function findGameForGrading(pick, games) {
  const matchup = (pick.matchup || '').toLowerCase();
  const parts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  for (const g of games) {
    const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
    const awayMatch = parts.some(p => teamsMatch(p, g.awayTeam)) || (awayLast.length > 3 && matchup.includes(awayLast));
    const homeMatch = parts.some(p => teamsMatch(p, g.homeTeam)) || (homeLast.length > 3 && matchup.includes(homeLast));
    if (awayMatch && homeMatch) return g;
  }
  return null;
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  const { awayScore, homeScore } = game;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam);

  if (betType === 'total' || /over|under/i.test(pickStr)) {
    const lineMatch = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (lineMatch) {
      const ou = lineMatch[1].toLowerCase(), line = parseFloat(lineMatch[2]), total = awayScore + homeScore;
      if (total === line) return 'push';
      return (ou === 'over' && total > line) || (ou === 'under' && total < line) ? 'win' : 'loss';
    }
  }
  if (betType === 'spread' || betType === 'puck line' || betType === 'run line' || /[+-]\d+(\.\d+)?/.test(pickStr)) {
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // Determine date — default to today EST
    const params = event.queryStringParameters || {};
    const now = new Date();
    const estOffset = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dateISO = params.date || estOffset.toISOString().split('T')[0];

    console.log(`[track-clv] Tracking CLV for date: ${dateISO}`);

    // Morning runs also settle YESTERDAY's picks — evening games finish after the last
    // same-day run (7pm ET), so without this, night-game results never reach the blobs
    // (blinding the drawdown detector and self-optimize). Fire-and-forget; the ?date=
    // param on the child call prevents recursion.
    const etHour = estOffset.getHours();
    if (!params.date && etHour < 12) {
      const yest = new Date(estOffset); yest.setDate(yest.getDate() - 1);
      const yestISO = yest.toISOString().split('T')[0];
      const siteURL = process.env.URL || 'https://webetsocial.com';
      fetch(`${siteURL}/.netlify/functions/track-clv?date=${yestISO}`, { method: 'POST' })
        .then(() => console.log(`[track-clv] Triggered overnight settle for ${yestISO}`))
        .catch((e) => console.log(`[track-clv] Yesterday settle trigger failed: ${e.message}`));
    }

    // ── Step 1: Load today's picks from Blobs ──
    let picksData;
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('edge-picks-alpha');
      picksData = await store.get(`picks-${dateISO}`, { type: 'json' });
    } catch (blobErr) {
      console.log('[track-clv] Blobs SDK failed, trying API fallback:', blobErr.message);
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
      if (token) {
        const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha/picks-${dateISO}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (resp.ok) {
          picksData = await resp.json();
        }
      }
    }

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

    // ── Step 2: Determine which sports to fetch ──
    const sportsInPicks = [...new Set(picksData.picks.map(p => p.sport).filter(Boolean))];
    console.log(`[track-clv] Sports in picks: ${sportsInPicks.join(', ')}`);

    // ── Step 3: Fetch current odds ──
    const currentOdds = await fetchCurrentOdds(sportsInPicks, dateISO);

    // Flatten all games into one array for matching
    const allGames = Object.values(currentOdds).flat();
    console.log(`[track-clv] Total games with current odds: ${allGames.length}`);

    // ── Step 3.5: Load existing CLV data (merge mode — don't overwrite already-tracked picks) ──
    let existingClv = null;
    const existingTracked = new Set();
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('edge-picks-alpha');
      existingClv = await store.get(`clv-${dateISO}`, { type: 'json' });
    } catch (e) {
      try {
        const token = process.env.NETLIFY_AUTH_TOKEN;
        const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
        if (token) {
          const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha/clv-${dateISO}`;
          const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (resp.ok) existingClv = await resp.json();
        }
      } catch (e2) { /* ignore */ }
    }
    if (existingClv && existingClv.picks) {
      for (const p of existingClv.picks) {
        if (p.clv !== null && p.clv !== undefined) existingTracked.add(p.pick);
      }
      console.log(`[track-clv] Existing CLV data found: ${existingTracked.size} already tracked`);
    }

    // ── Step 4: Calculate CLV for each pick ──
    const clvPicks = [];

    for (const pick of picksData.picks) {
      // Skip picks already successfully tracked in a previous run
      if (existingTracked.has(pick.pick)) {
        const existing = existingClv.picks.find(p => p.pick === pick.pick);
        if (existing) { clvPicks.push(existing); continue; }
      }

      const game = findMatchingGame(pick, allGames);

      // Base record with sport/market fields for aggregation
      const baseRecord = {
        pick: pick.pick,
        matchup: pick.matchup,
        sport: pick.sport || null,
        market: pick.betType || null,
        units: pick.units || null,
        pickTimeOdds: pick.odds || 'N/A',
      };

      if (!game) {
        console.log(`[track-clv] No matching game found for: ${pick.matchup} — ${pick.pick}`);
        clvPicks.push({
          ...baseRecord,
          closingOdds: null, pickTimeImplied: null, closingImplied: null,
          clv: null, clvCents: null, beatClosing: null,
          error: 'No matching game found in current odds data',
        });
        continue;
      }

      // Extract closing consensus odds for this pick's market
      const closingOdds = extractConsensusOdds(game, pick.pick, pick.betType);
      const pickTimeOddsStr = pick.odds || null;

      if (!closingOdds || !pickTimeOddsStr) {
        console.log(`[track-clv] Missing odds data for: ${pick.pick} (closing: ${closingOdds}, pickTime: ${pickTimeOddsStr})`);
        clvPicks.push({
          ...baseRecord,
          closingOdds: closingOdds ? String(closingOdds) : null,
          pickTimeImplied: impliedProbability(pickTimeOddsStr),
          closingImplied: closingOdds ? impliedProbability(String(closingOdds)) : null,
          clv: null, clvCents: null, beatClosing: null,
          error: closingOdds ? 'Missing pick-time odds' : 'Could not extract closing odds for this market',
        });
        continue;
      }

      const pickTimeImpl = impliedProbability(pickTimeOddsStr);
      const closingImpl = impliedProbability(String(closingOdds));

      if (pickTimeImpl === null || closingImpl === null) {
        clvPicks.push({
          ...baseRecord,
          closingOdds: String(closingOdds),
          pickTimeImplied: pickTimeImpl, closingImplied: closingImpl,
          clv: null, clvCents: null, beatClosing: null,
          error: 'Could not parse odds to implied probability',
        });
        continue;
      }

      // CLV = closing implied prob - pick time implied prob
      // Positive means closing line moved toward our side (we got better odds)
      const clv = parseFloat((closingImpl - pickTimeImpl).toFixed(4));
      const clvCents = parseFloat((clv * 100).toFixed(2));
      const beatClosing = clv > 0;

      clvPicks.push({
        ...baseRecord,
        closingOdds: String(closingOdds),
        pickTimeImplied: parseFloat(pickTimeImpl.toFixed(4)),
        closingImplied: parseFloat(closingImpl.toFixed(4)),
        clv, clvCents, beatClosing,
      });

      console.log(`[track-clv] ${pick.sport} ${pick.pick}: pickOdds=${pickTimeOddsStr} closingOdds=${closingOdds} CLV=${clvCents} cents`);
    }

    // ── Step 4.5: Grade outcomes via ESPN final scores ──
    // Fetch final scores for all sports in today's picks and determine win/loss/push.
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

    // ── Step 5: Compute summary stats ──
    const validClvPicks = clvPicks.filter(p => p.clv !== null);
    const avgCLV = validClvPicks.length > 0
      ? parseFloat((validClvPicks.reduce((sum, p) => sum + p.clv, 0) / validClvPicks.length).toFixed(4))
      : 0;
    const picksBeatClosing = validClvPicks.filter(p => p.beatClosing).length;

    // By sport/market aggregation
    const bySport = {}, byMarket = {};
    for (const p of validClvPicks) {
      const s = p.sport || 'unknown';
      const m = p.market || 'unknown';
      if (!bySport[s]) bySport[s] = { count: 0, clvSum: 0, beat: 0 };
      bySport[s].count++; bySport[s].clvSum += p.clv; if (p.beatClosing) bySport[s].beat++;
      if (!byMarket[m]) byMarket[m] = { count: 0, clvSum: 0, beat: 0 };
      byMarket[m].count++; byMarket[m].clvSum += p.clv; if (p.beatClosing) byMarket[m].beat++;
    }

    const settledResults = clvPicks.filter(p => p.result && p.result !== 'pending');
    const wins = settledResults.filter(p => p.result === 'win').length;
    const losses = settledResults.filter(p => p.result === 'loss').length;
    const pushes = settledResults.filter(p => p.result === 'push').length;
    const totalProfit = settledResults.reduce((s, p) => s + (p.profit || 0), 0);

    const clvData = {
      date: dateISO,
      capturedAt: new Date().toISOString(),
      picks: clvPicks,
      avgCLV,
      avgCLVCents: parseFloat((avgCLV * 100).toFixed(2)),
      picksBeatClosing,
      totalTracked: validClvPicks.length,
      totalPicks: picksData.picks.length,
      bySport, byMarket,
      // Settlement results
      wins, losses, pushes,
      totalProfit,
      settled: settledResults.length,
      pending: clvPicks.length - settledResults.length,
    };

    // ── Step 6: Store CLV data in Blobs ──
    try {
      const { getStore } = await import('@netlify/blobs');
      const store = getStore('edge-picks-alpha');
      await store.setJSON(`clv-${dateISO}`, clvData);
      console.log(`[track-clv] Stored CLV data at clv-${dateISO}`);
    } catch (blobErr) {
      console.error('[track-clv] Failed to store CLV via SDK, trying API:', blobErr.message);
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
      if (token) {
        try {
          const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha/clv-${dateISO}`;
          await fetch(url, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(clvData),
          });
          console.log('[track-clv] Stored CLV data via API fallback');
        } catch (apiErr) {
          console.error('[track-clv] API fallback failed:', apiErr.message);
        }
      }
    }

    // ── Step 6.5: Write results back to picks blob (settlement) ──
    // Update the stored pick objects with win/loss/push so the calibration system
    // and CLV feedback loop can read settled results directly from the picks blob.
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
            const store = getStore('edge-picks-alpha');
            await store.setJSON(`picks-${dateISO}`, updatedPicksData);
            console.log(`[track-clv] Wrote ${settledPicks.length} results back to picks-${dateISO}`);
          } catch (wbErr) {
            const token = process.env.NETLIFY_AUTH_TOKEN;
            const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
            if (token) {
              await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha/picks-${dateISO}`, {
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
