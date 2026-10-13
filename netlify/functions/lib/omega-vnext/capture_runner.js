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
  ODDS_SPORT_KEYS, SPORTS_ENABLED, US_BOOK_PRIORITY, SHARP_BOOKS, BLOB_STORE, PINNACLE_LINE_MOVE,
} = require('./config');
const { sportsForCard } = require('./season_calendar');
const {
  etDateISO, hhmmET, extractGameBooks, storeLinePoll, gameKey, snapBlobKey, readJsonBlob,
} = require('./line_path');
const { isSameEtDay } = require('./odds_math');
const {
  slateOddsGate, isFreshReusableSnap, snapCoversSports, FRESH_SNAP_MS, runWithFetchMemo,
  creditFloorReached, responseRequestsRemaining,
} = require('./fetch_memo');
const { resolveFetch } = require('./audit_log');
const {
  runWithSnapshotClock, noteKnownRequestsRemaining, knownRequestsRemainingValue,
} = require('./odds_snapshot_cache');
const {
  PINNACLE_SPORTS, quotesFromEvents, quotesByEvent, storeOpen, storeCheck, LINE_MOVE_STORE,
  eventKey, CHECK_SLOTS, commenceEtDate, readLineMoveKey,
} = require('./pinnacle_line_move');

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
  const resp = await resolveFetch(fetchImpl)(url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    const url2 = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`
      + `?regions=us,us2,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
    const resp2 = await resolveFetch(fetchImpl)(url2, { signal: AbortSignal.timeout(20000) });
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
  const explicit = Number(opts.pregameAsOfMs);
  const ms = Number.isFinite(explicit) ? explicit : now.getTime();
  return runWithSnapshotClock(ms, () => runWithFetchMemo(() => runOmegaLineCaptureInner(opts)));
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

/**
 * Live board only. regions=eu, one bookmaker, h2h/spreads/totals.
 * No historical path and no date snapshot param.
 * Repo live cost is regions × markets (see clv_candidates): 1 × 3 = 3 credits.
 * /events is 0. A check is Pinnacle + DraftKings = 6 credits per sport.
 */
function bookOddsUrl(sportKey, apiKey, bookmakers) {
  const params = new URLSearchParams();
  params.set('regions', PINNACLE_LINE_MOVE.regions);
  params.set('markets', PINNACLE_LINE_MOVE.markets);
  params.set('oddsFormat', 'american');
  params.set('bookmakers', bookmakers);
  params.set('apiKey', apiKey);
  return `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds?${params.toString()}`;
}

function pinnacleOddsUrl(sportKey, apiKey) {
  return bookOddsUrl(sportKey, apiKey, PINNACLE_LINE_MOVE.bookmakers);
}

function draftkingsOddsUrl(sportKey, apiKey) {
  return bookOddsUrl(sportKey, apiKey, PINNACLE_LINE_MOVE.secondaryBookmakers);
}

/** Free event list. apiKey only. No markets, regions, bookmakers, or date. */
function pinnacleEventsUrl(sportKey, apiKey) {
  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  return `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/events?${params.toString()}`;
}

function pinnacleLabels(dateISO, opts) {
  const allow = new Set(PINNACLE_SPORTS);
  if (opts && Array.isArray(opts.labels)) return opts.labels.filter((label) => allow.has(label));
  const onCard = new Set(sportsForCard(dateISO));
  return PINNACLE_SPORTS.filter((label) => onCard.has(label));
}

async function fetchOddsApi(url, fetchImpl) {
  const resp = await resolveFetch(fetchImpl)(url, { signal: AbortSignal.timeout(20000) });
  const requestsRemaining = responseRequestsRemaining(resp);
  const cacheHit = !!(resp && resp.oddsSnapshotHit);
  if (!resp || !resp.ok) {
    const err = new Error(`Odds HTTP ${resp ? resp.status : 'no-response'}`);
    err.status = resp && resp.status;
    err.requestsRemaining = requestsRemaining;
    err.cacheHit = cacheHit;
    err.url = url;
    throw err;
  }
  const body = await resp.json();
  return {
    events: Array.isArray(body) ? body : [],
    requestsRemaining,
    cacheHit,
    url,
  };
}

async function fetchPinnacleOdds(sportKey, apiKey, fetchImpl = fetch) {
  return fetchOddsApi(pinnacleOddsUrl(sportKey, apiKey), fetchImpl);
}

async function fetchBookOdds(sportKey, apiKey, bookmakers, fetchImpl = fetch) {
  return fetchOddsApi(bookOddsUrl(sportKey, apiKey, bookmakers), fetchImpl);
}

async function fetchSportEvents(sportKey, apiKey, fetchImpl = fetch) {
  return fetchOddsApi(pinnacleEventsUrl(sportKey, apiKey), fetchImpl);
}

/**
 * Open watcher or a 3:00 / 9:00 / 10:30 check.
 * Opens poll /events (0 credits) and pull Pinnacle once per sport that has a
 * new event id. Checks pull Pinnacle and DraftKings, one call per sport,
 * through the snapshot cache. Priced pulls stop below the credit floor.
 * Writes only omega-pinnacle-line-moves. Never the published card.
 */
async function runPinnacleLineCapture(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const explicit = Number(opts.pregameAsOfMs);
  const ms = Number.isFinite(explicit) ? explicit : now.getTime();
  return runWithSnapshotClock(ms, () => runWithFetchMemo(() => runPinnacleLineCaptureInner(opts)));
}

function bookmakerFor(book) {
  if (book === 'draftkings') return PINNACLE_LINE_MOVE.secondaryBookmakers;
  return PINNACLE_LINE_MOVE.bookmakers;
}

function noteLiveRemaining(state, remaining, cacheHit) {
  if (cacheHit) return;
  if (remaining == null) return;
  noteKnownRequestsRemaining(remaining);
  state.requestsRemaining = remaining;
}

function rememberPull(state, pulled, label, book, floor) {
  state.pulls += 1;
  const remaining = pulled && pulled.requestsRemaining != null ? pulled.requestsRemaining : null;
  const cacheHit = !!(pulled && pulled.cacheHit);
  if (cacheHit) state.cacheHits += 1;
  noteLiveRemaining(state, remaining, cacheHit);
  if (remaining != null && state.requestsRemaining == null) state.requestsRemaining = remaining;
  console.log(`[pinnacle-line-move] x-requests-remaining=${remaining == null ? 'null' : remaining} sport=${label} book=${book} cacheHit=${cacheHit ? 1 : 0}`);
  if (!cacheHit && creditFloorReached(remaining, floor)) {
    state.stoppedForCredits = true;
    console.log(`[pinnacle-line-move] x-requests-remaining=${remaining} credit floor stop after ${label} ${book}`);
  }
}

function rememberError(state, err, label, book, floor) {
  state.pulls += 1;
  const remaining = err && err.requestsRemaining != null ? err.requestsRemaining : null;
  noteLiveRemaining(state, remaining, !!(err && err.cacheHit));
  console.log(`[pinnacle-line-move] x-requests-remaining=${remaining == null ? 'null' : remaining} sport=${label} book=${book} error=${err && err.message}`);
  if (!(err && err.cacheHit) && creditFloorReached(remaining, floor)) {
    state.stoppedForCredits = true;
    console.log(`[pinnacle-line-move] x-requests-remaining=${remaining} credit floor stop after ${label} ${book}`);
  }
}

async function runPinnacleLineCaptureInner(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateISO = opts.dateISO;
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) {
    const err = new Error(`pinnacle line-move refused bad date: ${dateISO}`);
    err.code = 'CAPTURE_CONFIG';
    throw err;
  }
  const apiKey = opts.apiKey || process.env.ODDS_API_KEY;
  if (!apiKey) {
    const err = new Error('Missing ODDS_API_KEY');
    err.code = 'CAPTURE_CONFIG';
    throw err;
  }
  const mode = opts.mode === 'open' ? 'open' : 'check';
  const etSlot = opts.etSlot ? String(opts.etSlot).replace(':', '') : null;
  if (mode === 'check' && !CHECK_SLOTS.includes(etSlot)) {
    return {
      ok: true,
      mode,
      date: dateISO,
      etSlot,
      skipped: 'slot',
      wrote: false,
      pulls: 0,
      eventPolls: 0,
      store: LINE_MOVE_STORE,
    };
  }
  const floor = opts.creditFloor != null ? Number(opts.creditFloor) : PINNACLE_LINE_MOVE.creditFloor;
  const labels = pinnacleLabels(dateISO, opts);
  const fetchImpl = opts.fetchImpl || fetch;
  const fetchEvents = opts.fetchEvents || ((sportKey, key) => fetchSportEvents(sportKey, key, fetchImpl));
  const fetchOdds = opts.fetchBookOdds || ((sportKey, key, book) => fetchBookOdds(sportKey, key, bookmakerFor(book), fetchImpl));
  const capturedAt = now.toISOString();
  const storeOpts = {
    dryRun: !!opts.dryRun,
    env: opts.env,
    read: opts.read,
    write: opts.write,
  };
  const state = {
    pulls: 0,
    eventPolls: 0,
    cacheHits: 0,
    requestsRemaining: knownRequestsRemainingValue(),
    stoppedForCredits: false,
  };
  const sportsHit = [];
  const touched = new Set();
  let wrote = false;
  let reason = null;
  let moveCount = 0;
  let steamCount = 0;

  console.log(`[pinnacle-line-move] START mode=${mode} date=${dateISO} etSlot=${etSlot || ''} floor=${floor} remaining=${state.requestsRemaining == null ? 'null' : state.requestsRemaining}`);

  const noteStored = (stored, id) => {
    if (!stored) return;
    if (stored.wrote) wrote = true;
    else if (!wrote && stored.reason && stored.reason !== 'open-exists' && stored.reason !== 'duplicate' && stored.reason !== 'indexed') {
      reason = stored.reason;
    }
    moveCount += (stored.moves || []).length;
    steamCount += (stored.steams || []).length;
    if (id) touched.add(id);
  };

  for (const label of labels) {
    const sportKey = ODDS_SPORT_KEYS[label];
    if (!sportKey) continue;
    if (mode === 'open') {
      let discovered = [];
      try {
        const listed = await fetchEvents(sportKey, apiKey);
        state.eventPolls += 1;
        const remaining = listed && listed.requestsRemaining != null ? listed.requestsRemaining : null;
        const cacheHit = !!(listed && listed.cacheHit);
        if (cacheHit) state.cacheHits += 1;
        noteLiveRemaining(state, remaining, cacheHit);
        console.log(`[pinnacle-line-move] x-requests-remaining=${remaining == null ? 'null' : remaining} sport=${label} book=events cacheHit=${cacheHit ? 1 : 0}`);
        discovered = listed && Array.isArray(listed.events) ? listed.events : [];
      } catch (err) {
        const remaining = err && err.requestsRemaining != null ? err.requestsRemaining : null;
        noteLiveRemaining(state, remaining, !!(err && err.cacheHit));
        console.log(`[pinnacle-line-move] x-requests-remaining=${remaining == null ? 'null' : remaining} sport=${label} book=events error=${err.message}`);
        sportsHit.push(`${label}:err`);
        continue;
      }
      const fresh = [];
      for (const event of discovered) {
        if (!event || event.id == null) continue;
        const id = String(event.id);
        const prev = await readLineMoveKey(eventKey(label, id), storeOpts);
        if (prev && prev.open) continue;
        fresh.push(event);
      }
      if (!fresh.length) {
        sportsHit.push(`${label}:0`);
        continue;
      }
      const known = knownRequestsRemainingValue();
      if (state.stoppedForCredits || creditFloorReached(known, floor)) {
        state.stoppedForCredits = true;
        state.requestsRemaining = known != null ? known : state.requestsRemaining;
        console.log(`[pinnacle-line-move] x-requests-remaining=${known == null ? 'null' : known} credit floor stop before ${label} pinnacle`);
        sportsHit.push(`${label}:held`);
        continue;
      }
      let pulled = null;
      try {
        pulled = await fetchOdds(sportKey, apiKey, 'pinnacle');
        rememberPull(state, pulled, label, 'pinnacle', floor);
      } catch (err) {
        rememberError(state, err, label, 'pinnacle', floor);
        sportsHit.push(`${label}:err`);
        continue;
      }
      const found = quotesByEvent(quotesFromEvents(pulled.events, label, { at: capturedAt, book: 'pinnacle' }, 'pinnacle'));
      let n = 0;
      for (const event of fresh) {
        const id = String(event.id);
        const quotes = found.get(id);
        if (!quotes || !Object.keys(quotes).length) continue;
        const stored = await storeOpen(label, id, {
          at: capturedAt,
          homeTeam: event.home_team || null,
          awayTeam: event.away_team || null,
          commenceTime: event.commence_time || null,
          date: commenceEtDate(event.commence_time),
          quotes,
        }, storeOpts);
        if (stored.wrote || stored.reason === 'dryRun' || stored.reason === 'OMEGA_REPLAY_NO_WRITE') n += 1;
        noteStored(stored, id);
      }
      sportsHit.push(`${label}:${n}`);
      continue;
    }

    const known = knownRequestsRemainingValue();
    if (state.stoppedForCredits || creditFloorReached(known, floor)) {
      state.stoppedForCredits = true;
      state.requestsRemaining = known != null ? known : state.requestsRemaining;
      console.log(`[pinnacle-line-move] x-requests-remaining=${known == null ? 'null' : known} credit floor stop before ${label}`);
      sportsHit.push(`${label}:held`);
      break;
    }
    let pin = null;
    let dk = null;
    try {
      pin = await fetchOdds(sportKey, apiKey, 'pinnacle');
      rememberPull(state, pin, label, 'pinnacle', floor);
    } catch (err) {
      rememberError(state, err, label, 'pinnacle', floor);
      sportsHit.push(`${label}:err`);
      if (state.stoppedForCredits) break;
      continue;
    }
    if (!state.stoppedForCredits) {
      try {
        dk = await fetchOdds(sportKey, apiKey, 'draftkings');
        rememberPull(state, dk, label, 'draftkings', floor);
      } catch (err) {
        rememberError(state, err, label, 'draftkings', floor);
      }
    }
    const pinQuotes = quotesByEvent(quotesFromEvents(pin ? pin.events : [], label, { at: capturedAt, dateISO, book: 'pinnacle' }, 'pinnacle'));
    const dkQuotes = quotesByEvent(quotesFromEvents(dk ? dk.events : [], label, { at: capturedAt, dateISO, book: 'draftkings' }, 'draftkings'));
    const meta = new Map();
    for (const event of [].concat((pin && pin.events) || [], (dk && dk.events) || [])) {
      if (event && event.id != null) meta.set(String(event.id), event);
    }
    const ids = new Set([...pinQuotes.keys(), ...dkQuotes.keys()]);
    for (const id of ids) {
      const event = meta.get(id) || {};
      const stored = await storeCheck(label, id, {
        slot: etSlot,
        at: capturedAt,
        homeTeam: event.home_team || null,
        awayTeam: event.away_team || null,
        commenceTime: event.commence_time || null,
        date: commenceEtDate(event.commence_time) || dateISO,
        books: {
          pinnacle: pinQuotes.get(id) || {},
          draftkings: dkQuotes.get(id) || {},
        },
        requestsRemaining: state.requestsRemaining,
      }, storeOpts);
      noteStored(stored, id);
    }
    sportsHit.push(`${label}:${ids.size}`);
    if (state.stoppedForCredits) break;
  }

  const body = {
    ok: true,
    mode,
    date: dateISO,
    etSlot,
    wrote,
    reason,
    gameCount: touched.size,
    moveCount,
    steamCount,
    sports: sportsHit,
    pulls: state.pulls,
    eventPolls: state.eventPolls,
    requestsRemaining: state.requestsRemaining == null ? null : state.requestsRemaining,
    stoppedForCredits: state.stoppedForCredits,
    store: LINE_MOVE_STORE,
    cacheHits: state.cacheHits,
  };
  console.log('[pinnacle-line-move] DONE', {
    mode: body.mode,
    date: body.date,
    wrote: body.wrote,
    reason: body.reason,
    gameCount: body.gameCount,
    moveCount: body.moveCount,
    steamCount: body.steamCount,
    stoppedForCredits: body.stoppedForCredits,
    requestsRemaining: body.requestsRemaining,
  });
  return body;
}

module.exports = {
  runOmegaLineCapture,
  runPinnacleLineCapture,
  CAPTURE_SPORTS,
  captureLabels,
  fetchSportOdds,
  fetchPinnacleOdds,
  fetchBookOdds,
  fetchSportEvents,
  pinnacleOddsUrl,
  draftkingsOddsUrl,
  pinnacleEventsUrl,
  pinnacleLabels,
};
