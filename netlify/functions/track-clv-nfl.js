// track-clv-nfl.js
// Captures Pinnacle/sharp closing-line value for the NFL card (edge-picks-nfl).
// Separate store from alpha so this can later merge into the unified CLV loop.
// Invoked by trigger-clv after the alpha pass.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const STORE = 'edge-picks-nfl';
const NFL_SPORTS = ['americanfootball_nfl', 'americanfootball_nfl_preseason'];
const SHARP_BOOKS = ['pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'betfair', 'matchbook', 'circasports'];
const PRE_PITCH_BUFFER_MIN = 3;

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function impliedProbability(americanOdds) {
  const odds = parseInt(americanOdds, 10);
  if (isNaN(odds)) return null;
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function lastWord(name) {
  const parts = normalizeTeam(name).split(' ');
  return parts[parts.length - 1] || '';
}
function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = normalizeTeam(a), nb = normalizeTeam(b);
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  return lastWord(a) === lastWord(b);
}

function pickSideInfo(pick) {
  const pickLower = (pick.pick || '').toLowerCase();
  const bt = (pick.betType || pick.market || '').toLowerCase();
  let marketKey = 'h2h';
  if (bt.includes('total') || /\b(over|under)\b/.test(pickLower)) marketKey = 'totals';
  else if (bt.includes('spread') || (/[+-]\d/.test(pickLower) && !/\b(over|under)\b/.test(pickLower))) marketKey = 'spreads';
  return {
    marketKey,
    isOver: pickLower.includes('over'),
    isUnder: pickLower.includes('under'),
  };
}

function stripLine(text) {
  return (text || '')
    .replace(/[+-]?\d+(\.\d+)?/g, '')
    .replace(/\bML\b/gi, '')
    .replace(/\b(over|under|moneyline|spread|total)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(arr) {
  const xs = (arr || []).filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

function extractClose(gameObj, sideInfo, pick) {
  if (!gameObj || !gameObj.bookmakers) return null;
  const teamText = stripLine(pick.pick || '');
  const isTeam = sideInfo.marketKey !== 'totals';
  const pickedHome = isTeam && teamsMatch(teamText, gameObj.home_team);
  const pickedAway = isTeam && teamsMatch(teamText, gameObj.away_team);
  const perBook = [];
  for (const b of gameObj.bookmakers) {
    const mkt = (b.markets || []).find(m => m.key === sideInfo.marketKey);
    if (!mkt || !mkt.outcomes || mkt.outcomes.length < 2) continue;
    perBook.push({ key: (b.key || '').toLowerCase(), title: b.title || b.key, outcomes: mkt.outcomes });
  }
  if (!perBook.length) return null;

  const selectFrom = (outcomes) => {
    const allRaw = outcomes.map(o => impliedProbability(o.price)).filter(v => v != null);
    if (allRaw.length < 2) return null;
    let sidePrice = null, line = null;
    for (const o of outcomes) {
      const n = (o.name || '').toLowerCase();
      const hit = sideInfo.marketKey === 'totals'
        ? (sideInfo.isOver && n === 'over') || (sideInfo.isUnder && n === 'under')
        : (pickedHome && teamsMatch(o.name, gameObj.home_team)) || (pickedAway && teamsMatch(o.name, gameObj.away_team));
      if (hit) { sidePrice = o.price; line = o.point != null ? o.point : null; break; }
    }
    if (sidePrice == null) return null;
    const sideRaw = impliedProbability(sidePrice);
    if (sideRaw == null) return null;
    return { sidePrice, sideRaw, line, overround: allRaw.reduce((a, c) => a + c, 0) };
  };

  for (const sb of SHARP_BOOKS) {
    const b = perBook.find(x => x.key === sb);
    if (!b) continue;
    const s = selectFrom(b.outcomes);
    if (s) return { sideOdds: s.sidePrice, sideRaw: s.sideRaw, overround: s.overround, closingLine: s.line, anchor: sb === 'pinnacle' ? 'pinnacle' : 'sharp', anchorBook: b.title };
  }
  const sharps = perBook.filter(x => SHARP_BOOKS.includes(x.key)).map(x => selectFrom(x.outcomes)).filter(Boolean);
  if (sharps.length >= 2) {
    return {
      sideOdds: Math.round(median(sharps.map(s => s.sidePrice))),
      sideRaw: median(sharps.map(s => s.sideRaw)),
      overround: median(sharps.map(s => s.overround)),
      closingLine: median(sharps.map(s => s.line).filter(v => v != null)),
      anchor: 'sharp-consensus', anchorBook: `${sharps.length} sharp books`,
    };
  }
  const all = perBook.map(x => selectFrom(x.outcomes)).filter(Boolean);
  if (!all.length) return null;
  return {
    sideOdds: Math.round(median(all.map(s => s.sidePrice))),
    sideRaw: median(all.map(s => s.sideRaw)),
    overround: median(all.map(s => s.overround)),
    closingLine: median(all.map(s => s.line).filter(v => v != null)),
    anchor: 'soft-median', anchorBook: `${all.length}-book median`,
  };
}

function findMatchingGame(pick, oddsData) {
  const matchup = (pick.matchup || '').toLowerCase();
  const pickText = (pick.pick || '').toLowerCase();
  for (const game of oddsData) {
    const homeIn = teamsMatch(game.home_team, matchup) || matchup.includes(lastWord(game.home_team));
    const awayIn = teamsMatch(game.away_team, matchup) || matchup.includes(lastWord(game.away_team));
    if (homeIn && awayIn) return game;
    const homePick = teamsMatch(game.home_team, pickText) || pickText.includes(lastWord(game.home_team));
    const awayPick = teamsMatch(game.away_team, pickText) || pickText.includes(lastWord(game.away_team));
    if ((homeIn || homePick) && (awayIn || awayPick)) return game;
  }
  return null;
}

async function fetchBulk(sportKey, atISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];
  const base = atISO ? 'https://api.the-odds-api.com/v4/historical' : 'https://api.the-odds-api.com/v4';
  const dateParam = atISO ? `&date=${encodeURIComponent(atISO)}` : '';
  const url = `${base}/sports/${sportKey}/odds?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}${dateParam}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];
    const json = await resp.json();
    return Array.isArray(json) ? json : (json.data || []);
  } catch (e) {
    return [];
  }
}

async function blobGet(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    return await getStore(STORE).get(key, { type: 'json' });
  } catch (e) {}
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) return await resp.json();
  } catch (e) {}
  return null;
}

async function blobPut(key, data) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return false;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${key}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return resp.ok;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const params = event.queryStringParameters || {};
    const dateISO = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : getEasternDateToday();
    const nowMs = Date.now();
    const picksData = await blobGet(`picks-${dateISO}`);
    if (!picksData || !Array.isArray(picksData.picks) || !picksData.picks.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: false, message: `No NFL picks for ${dateISO}`, date: dateISO, totalTracked: 0, totalPicks: 0 }) };
    }

    const existingClv = await blobGet(`clv-${dateISO}`);
    const findExisting = (pick) => (existingClv && Array.isArray(existingClv.picks))
      ? existingClv.picks.find(p => p.pick === pick.pick && p.matchup === pick.matchup)
      : null;

    const bulkCache = new Map();
    const getBulk = async (sportKey, atISO) => {
      const k = `${sportKey}|${atISO || 'live'}`;
      if (!bulkCache.has(k)) bulkCache.set(k, await fetchBulk(sportKey, atISO));
      return bulkCache.get(k);
    };
    const findGameAcross = async (pick, atISO) => {
      for (const sport of NFL_SPORTS) {
        const games = await getBulk(sport, atISO);
        const g = findMatchingGame(pick, games);
        if (g) return g;
      }
      return null;
    };

    const clvPicks = [];
    for (const pick of picksData.picks) {
      const sideInfo = pickSideInfo(pick);
      const prev = findExisting(pick);
      const baseRecord = {
        pick: pick.pick, matchup: pick.matchup, sport: 'NFL',
        betType: pick.betType || pick.market || null, market: pick.betType || pick.market || null,
        units: pick.units || null, pickTimeOdds: pick.odds || 'N/A',
        commenceTime: pick.commenceTime || null,
      };
      let commenceISO = pick.commenceTime || null;
      let commenceMs = commenceISO ? Date.parse(commenceISO) : NaN;
      let gameObj = null;
      let snapAt = null;
      if (!commenceISO || !Number.isFinite(commenceMs) || commenceMs >= nowMs - PRE_PITCH_BUFFER_MIN * 60000) {
        gameObj = await findGameAcross(pick, null);
        if (gameObj) { commenceISO = gameObj.commence_time || commenceISO; commenceMs = Date.parse(commenceISO); }
      }
      if (!gameObj && Number.isFinite(commenceMs)) {
        gameObj = await findGameAcross(pick, commenceISO);
        if (gameObj) snapAt = commenceISO;
      }
      const close = gameObj ? extractClose(gameObj, sideInfo, pick) : null;
      let captureMinsToCommence = null;
      if (snapAt) captureMinsToCommence = 0;
      else if (Number.isFinite(commenceMs)) captureMinsToCommence = Math.round((commenceMs - nowMs) / 60000);
      const captureScore = captureMinsToCommence == null ? 5e5
        : (captureMinsToCommence >= -PRE_PITCH_BUFFER_MIN ? Math.max(0, captureMinsToCommence) : 1e6 + Math.abs(captureMinsToCommence));

      let rec;
      if (!close || !close.overround) {
        rec = { ...baseRecord, closingOdds: null, clv: null, clvCents: null, beatClosing: null, captureScore: 5e5, error: gameObj ? 'no sharp close' : 'no matching game' };
      } else {
        const betRaw = impliedProbability(pick.odds);
        const closingNoVig = +(close.sideRaw / close.overround).toFixed(4);
        const pickTimeNoVig = betRaw != null ? +(betRaw / close.overround).toFixed(4) : null;
        const clv = pickTimeNoVig != null ? +(closingNoVig - pickTimeNoVig).toFixed(4) : null;
        rec = {
          ...baseRecord,
          closingOdds: String(close.sideOdds),
          closingLine: close.closingLine ?? null,
          anchor: close.anchor, anchorBook: close.anchorBook,
          pickTimeImplied: betRaw != null ? +betRaw.toFixed(4) : null,
          closingImplied: +close.sideRaw.toFixed(4),
          pickTimeNoVig, closingNoVig,
          closingOverround: +close.overround.toFixed(4),
          clv, clvCents: clv != null ? +(clv * 100).toFixed(2) : null,
          beatClosing: clv != null ? clv > 0 : null,
          closeSnapshotAt: snapAt || new Date().toISOString(),
          captureMinsToCommence, captureScore,
        };
        console.log(`[track-clv-nfl] ${pick.pick}: bet=${pick.odds} close=${close.sideOdds} clv=${rec.clvCents}c`);
      }
      const prevScore = (prev && prev.clv != null && typeof prev.captureScore === 'number') ? prev.captureScore : Infinity;
      if (rec.clv != null && rec.captureScore <= prevScore) clvPicks.push(rec);
      else if (prev && prev.clv != null) clvPicks.push(prev);
      else clvPicks.push(rec);
    }

    const valid = clvPicks.filter(p => p.clv != null);
    const avgCLV = valid.length ? +(valid.reduce((s, p) => s + p.clv, 0) / valid.length).toFixed(4) : 0;
    const payload = {
      date: dateISO,
      generatedAt: new Date().toISOString(),
      model: picksData.model || 'v1.1-nfl',
      totalPicks: picksData.picks.length,
      totalTracked: valid.length,
      avgCLV,
      avgCLVCents: +(avgCLV * 100).toFixed(2),
      beatClose: valid.filter(p => p.beatClosing).length,
      picks: clvPicks,
    };
    await blobPut(`clv-${dateISO}`, payload);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, date: dateISO, totalTracked: valid.length, totalPicks: picksData.picks.length, avgCLVCents: payload.avgCLVCents }) };
  } catch (err) {
    console.error('[track-clv-nfl]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message }) };
  }
};
