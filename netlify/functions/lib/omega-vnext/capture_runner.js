'use strict';

/**
 * Shared Omega morning line capture.
 * Writes omega-line-snap-* and omega-line-path/* in edge-picks-omega only.
 * Does not write picks-{date}, latest-date, or picks-dates.
 *
 * force: true means "capture now" (callers already decided the slot).
 * includeDisabled: also pull NBA/NHL stubs. Cron and the generate health
 * retry leave this false so disabled sports do not burn Odds quota.
 */

const {
  ODDS_SPORT_KEYS, SPORTS_ENABLED, US_BOOK_PRIORITY, SHARP_BOOKS, BLOB_STORE,
} = require('./config');
const {
  etDateISO, hhmmET, extractGameBooks, storeLinePoll, gameKey,
} = require('./line_path');
const { isSameEtDay } = require('./odds_math');

const CAPTURE_BOOKMAKERS = [
  ...US_BOOK_PRIORITY,
  ...SHARP_BOOKS,
];

/** Always eligible; NBA/NHL run only when enabled or includeDisabled. */
const CAPTURE_SPORTS = ['MLB', 'NFL', 'NCAAF', 'NBA', 'NHL'];

async function fetchSportOdds(sportKey, apiKey) {
  const books = [...new Set(CAPTURE_BOOKMAKERS)].join(',');
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
    + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american`
    + `&bookmakers=${encodeURIComponent(books)}&apiKey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    const url2 = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
      + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
    const resp2 = await fetch(url2, { signal: AbortSignal.timeout(20000) });
    if (!resp2.ok) throw new Error(`Odds ${sportKey} HTTP ${resp.status}/${resp2.status}`);
    return resp2.json();
  }
  return resp.json();
}

/**
 * Fetch today's ET slate and store one poll under the given ET slot (default: now ET).
 * Does not invent games or backfill a missing 0600/0730/0900/0915 label.
 */
async function runOmegaLineCapture(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateISO = opts.dateISO || etDateISO(now);
  const etSlot = opts.etSlot || opts.slot || hhmmET(now);
  const includeDisabled = !!opts.includeDisabled;
  const apiKey = process.env.ODDS_API_KEY;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!apiKey || !token) {
    const err = new Error('Missing ODDS_API_KEY or NETLIFY_AUTH_TOKEN');
    err.code = 'CAPTURE_CONFIG';
    throw err;
  }

  console.log(`[capture-omega-lines] START date=${dateISO} etSlot=${etSlot} store=${BLOB_STORE} force=${!!opts.force}`);

  const games = {};
  const sportsHit = [];

  for (const label of CAPTURE_SPORTS) {
    if (!SPORTS_ENABLED[label] && !includeDisabled) continue;
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

  const stored = await storeLinePoll(dateISO, poll);
  const body = {
    ok: stored.gameCount > 0,
    date: dateISO,
    etSlot,
    gameCount: stored.gameCount,
    sports: sportsHit,
    snapKey: stored.snapKey,
    pathKey: stored.pathKey,
    store: BLOB_STORE,
  };
  console.log('[capture-omega-lines] DONE', body);
  return body;
}

module.exports = {
  runOmegaLineCapture,
  CAPTURE_SPORTS,
};
