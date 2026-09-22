'use strict';
/**
 * capture-omega-lines.js — Omega-dedicated US morning line-path capture.
 * Writes ONLY to edge-picks-omega (Alpha / edge-picks untouched).
 *
 * Cron slots (EDT = UTC-4): 6:00, 7:30, 9:00 ET → 10:00, 11:30, 13:00 UTC.
 * Netlify one-schedule union fires extras; we no-op outside ALLOWED_UTC_HHMM.
 */

const {
  ODDS_SPORT_KEYS, SPORTS_ENABLED, US_BOOK_PRIORITY, SHARP_BOOKS, BLOB_STORE,
} = require('./lib/omega-vnext/config');
const {
  etDateISO, hhmmET, extractGameBooks, storeLinePoll, gameKey,
} = require('./lib/omega-vnext/line_path');
const { isSameEtDay } = require('./lib/omega-vnext/odds_math');

/** UTC HHMM windows that map to 6:00 / 7:30 / 9:00 ET during EDT. */
const ALLOWED_UTC_HHMM = new Set(['1000', '1130', '1300']);

const CAPTURE_BOOKMAKERS = [
  ...US_BOOK_PRIORITY,
  ...SHARP_BOOKS,
];

/** Always capture these; NBA/NHL stubs ready when SPORTS_ENABLED flips on. */
const CAPTURE_SPORTS = ['MLB', 'NFL', 'NCAAF', 'NBA', 'NHL'];

function utcHHMM(d = new Date()) {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

function nearestAllowedSlot(utcHmm) {
  // Allow ±5 min jitter around allowed slots
  const mins = parseInt(utcHmm.slice(0, 2), 10) * 60 + parseInt(utcHmm.slice(2), 10);
  for (const slot of ALLOWED_UTC_HHMM) {
    const sm = parseInt(slot.slice(0, 2), 10) * 60 + parseInt(slot.slice(2), 10);
    if (Math.abs(mins - sm) <= 5) return slot;
  }
  return null;
}

function etSlotLabel(utcSlot) {
  // EDT: UTC-4
  const map = { '1000': '0600', '1130': '0730', '1300': '0900' };
  return map[utcSlot] || hhmmET();
}

async function fetchSportOdds(sportKey, apiKey) {
  const books = [...new Set(CAPTURE_BOOKMAKERS)].join(',');
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
    + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american`
    + `&bookmakers=${encodeURIComponent(books)}&apiKey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    // Fallback without bookmakers filter (some keys unavailable)
    const url2 = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
      + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
    const resp2 = await fetch(url2, { signal: AbortSignal.timeout(20000) });
    if (!resp2.ok) throw new Error(`Odds ${sportKey} HTTP ${resp.status}/${resp2.status}`);
    return resp2.json();
  }
  return resp.json();
}

exports.handler = async (event) => {
  const force = !!(event && (event.queryStringParameters || {}).force);
  const now = new Date();
  const utcSlot = nearestAllowedSlot(utcHHMM(now));
  if (!force && !utcSlot) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        skipped: true,
        reason: 'outside Omega morning slots',
        utcHHMM: utcHHMM(now),
        allowed: [...ALLOWED_UTC_HHMM],
      }),
    };
  }

  const apiKey = process.env.ODDS_API_KEY;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!apiKey || !token) {
    return { statusCode: 500, body: 'Missing ODDS_API_KEY or NETLIFY_AUTH_TOKEN' };
  }

  const dateISO = (event && (event.queryStringParameters || {}).date) || etDateISO(now);
  const etSlot = force
    ? ((event.queryStringParameters || {}).slot || hhmmET(now))
    : etSlotLabel(utcSlot || '1000');

  console.log(`[capture-omega-lines] START date=${dateISO} etSlot=${etSlot} store=${BLOB_STORE}`);

  const games = {};
  const sportsHit = [];

  for (const label of CAPTURE_SPORTS) {
    // Skip disabled except force stubs listed — still skip NBA/NHL when disabled to save quota
    if (!SPORTS_ENABLED[label] && !force) continue;
    const sportKey = ODDS_SPORT_KEYS[label];
    if (!sportKey) continue;
    try {
      const data = await fetchSportOdds(sportKey, apiKey);
      const events = Array.isArray(data) ? data : [];
      let n = 0;
      for (const ev of events) {
        const t = ev.commence_time;
        if (t && !isSameEtDay(t, dateISO)) continue;
        const extracted = extractGameBooks(ev);
        const key = gameKey(extracted.awayTeam, extracted.homeTeam);
        games[key] = {
          sport: label,
          oddsKey: sportKey,
          ...extracted,
        };
        n++;
      }
      sportsHit.push(`${label}:${n}`);
      console.log(`[capture-omega-lines] ${label}: ${n} same-ET-day games`);
    } catch (e) {
      console.log(`[capture-omega-lines] ${label} error: ${e.message}`);
      sportsHit.push(`${label}:err`);
    }
  }

  const poll = {
    hhmm: etSlot,
    slot: etSlot,
    capturedAt: now.toISOString(),
    games,
    sports: sportsHit,
    bookmakers: [...new Set(CAPTURE_BOOKMAKERS)],
  };

  let stored;
  try {
    stored = await storeLinePoll(dateISO, poll);
  } catch (e) {
    console.error(`[capture-omega-lines] store failed: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  const body = {
    date: dateISO,
    etSlot,
    utcSlot: utcSlot || 'forced',
    gameCount: stored.gameCount,
    sports: sportsHit,
    snapKey: stored.snapKey,
    pathKey: stored.pathKey,
    store: BLOB_STORE,
  };
  console.log(`[capture-omega-lines] DONE`, body);
  return { statusCode: 200, body: JSON.stringify(body) };
};
