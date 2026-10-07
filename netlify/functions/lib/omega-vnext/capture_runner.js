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
const { sportsForCard } = require('./season_calendar');
const {
  etDateISO, hhmmET, extractGameBooks, storeLinePoll, gameKey, snapBlobKey, readJsonBlob,
} = require('./line_path');
const { isSameEtDay } = require('./odds_math');
const {
  slateOddsGate, isFreshReusableSnap, snapCoversSports, FRESH_SNAP_MS, runWithFetchMemo,
} = require('./fetch_memo');

const CAPTURE_BOOKMAKERS = [
  ...US_BOOK_PRIORITY,
  ...SHARP_BOOKS,
];

/**
 * Always eligible. NBA stays on this list for includeDisabled / shadow capture
 * even while SPORTS_ENABLED.NBA is false. NHL stays on this list while the
 * engine is live. Disabled labels are skipped unless includeDisabled.
 */
const CAPTURE_SPORTS = ['MLB', 'NFL', 'NCAAF', 'NBA', 'NHL'];

function captureLabels(includeDisabled, dateISO) {
  const onCard = dateISO ? new Set(sportsForCard(dateISO)) : null;
  return CAPTURE_SPORTS.filter((label) => {
    if (includeDisabled) return true;
    if (onCard) return onCard.has(label);
    return !!SPORTS_ENABLED[label];
  });
}

async function fetchSportOdds(sportKey, apiKey, fetchImpl = fetch) {
  const books = [...new Set(CAPTURE_BOOKMAKERS)].join(',');
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
    + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american`
    + `&bookmakers=${encodeURIComponent(books)}&apiKey=${apiKey}`;
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    const url2 = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
      + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
    const resp2 = await fetchImpl(url2, { signal: AbortSignal.timeout(20000) });
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
  return runWithFetchMemo(() => runOmegaLineCaptureInner(opts));
}

async function runOmegaLineCaptureInner(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateISO = opts.dateISO || etDateISO(now);
  const etSlot = opts.etSlot || opts.slot || hhmmET(now);
  const includeDisabled = !!opts.includeDisabled;
  const apiKey = opts.apiKey || process.env.ODDS_API_KEY;
  const token = opts.token || process.env.NETLIFY_AUTH_TOKEN;
  if (!apiKey || !token) {
    const err = new Error('Missing ODDS_API_KEY or NETLIFY_AUTH_TOKEN');
    err.code = 'CAPTURE_CONFIG';
    throw err;
  }

  const writePoll = opts.storeLinePoll || storeLinePoll;
  const readSnap = opts.readSnap || ((date, slot) => readJsonBlob(snapBlobKey(date, slot)));
  const gateFn = opts.slateGate || slateOddsGate;
  const fetchOdds = opts.fetchSportOdds || ((sportKey, key) => fetchSportOdds(sportKey, key, opts.fetchImpl || fetch));
  const labels = captureLabels(includeDisabled, dateISO);
  const freshMs = opts.freshSnapMs != null ? opts.freshSnapMs : FRESH_SNAP_MS;

  console.log(`[capture-omega-lines] START date=${dateISO} etSlot=${etSlot} store=${BLOB_STORE} force=${!!opts.force}`);

  if (!opts.forceRefresh) {
    let existing = null;
    try { existing = await readSnap(dateISO, etSlot); } catch (_) { existing = null; }
    if (isFreshReusableSnap(existing, now, freshMs) && snapCoversSports(existing, labels)) {
      const ageMs = now.getTime() - Date.parse(existing.capturedAt);
      console.log(`[capture-omega-lines] reuse fresh snap ${dateISO} ${etSlot} ageMs=${ageMs} (no Odds pull)`);
      const poll = {
        hhmm: etSlot,
        slot: etSlot,
        capturedAt: existing.capturedAt,
        games: existing.games,
        sports: existing.sports || [],
        bookmakers: existing.bookmakers || [...new Set(CAPTURE_BOOKMAKERS)],
      };
      const stored = await writePoll(dateISO, poll);
      const body = {
        ok: stored.gameCount > 0,
        reused: true,
        date: dateISO,
        etSlot,
        gameCount: stored.gameCount,
        sports: poll.sports,
        snapKey: stored.snapKey,
        pathKey: stored.pathKey,
        store: BLOB_STORE,
      };
      console.log('[capture-omega-lines] DONE', body);
      return body;
    }
  }

  const games = {};
  const sportsHit = [];

  for (const label of labels) {
    const sportKey = ODDS_SPORT_KEYS[label];
    if (!sportKey) continue;
    try {
      const gate = await gateFn({ sportKey, apiKey, dateISO, fetchImpl: opts.fetchImpl });
      if (gate && gate.skip) {
        sportsHit.push(`${label}:skip-empty`);
        console.log(`[capture-omega-lines] ${label}: skip Odds API (${gate.reason}, events=${gate.events})`);
        continue;
      }
      const data = await fetchOdds(sportKey, apiKey);
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

  const stored = await writePoll(dateISO, poll);
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
  captureLabels,
  fetchSportOdds,
};
