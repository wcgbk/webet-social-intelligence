'use strict';
/**
 * Closes for the previous ET day. No schedule of its own.
 * capture-odds-3am fires this after the board pull when OMEGA_CLOSES_AT_3AM
 * is on (default). OMEGA_CLOSES_AT_3AM=off returns immediately.
 * The scheduled run writes closing lines from the last saved Pinnacle board
 * (10 AM, else 3 AM) and does not call the Odds API.
 * OMEGA_CLOSES_HISTORICAL=on restores the paid historical-close path.
 * A manual backfill sends { date, onlyMissing|picksOnly, retryNoClose, missingGames }
 * with x-picks-secret. retryNoClose reopens saved no-close card and
 * candidate legs (primary snapshot, then the 15-minute fallback).
 * missingGames plans buckets for slate games that have no close yet, plus
 * those no-close card and candidate legs, and does not overwrite a done-ev
 * close. Scheduled runs send { scheduled: true } and never set retryNoClose
 * or missingGames.
 * Dates must be within the last 7 ET days, and not today.
 * After the closes are saved, invokes track-clv-omega in stored-closes mode
 * (sweep on) so yesterday's CLV and settlement run with zero Odds API credits.
 * Then grades stored candidate closes, then mirrors that date's card into
 * Supabase (card_picks result/profit). The mirror is hash-gated inside
 * mirrorTodayCard, soft-fails inside a 20s budget, and does not write picks
 * or the card. dryRun and skipMirror skip it. Legacy track-clv /
 * track-clv-nfl / track-clv-cfb are not called.
 */

const S = require('./lib/clv-supabase');
const C = require('./lib/closes-3am');
const { closesAt3amEnabled } = require('./lib/default_on_flag');

const TRACK_TIMEOUT_MS = 60000;
const MIRROR_BUDGET_MS = 20000;

function raceTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => v,
      (e) => ({ ok: false, error: C.scrub(e && e.message ? e.message : e) })
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function truthy(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

async function invokeTrack(date, env, fetchImpl) {
  const siteURL = (env && env.URL) || 'https://webetsocial.com';
  const headers = { 'Content-Type': 'application/json' };
  if (env && env.PICKS_SECRET_KEY) headers['x-picks-secret'] = env.PICKS_SECRET_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${siteURL}/.netlify/functions/track-clv-omega`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date, storedCloses: true, sweep: true }),
      signal: controller.signal,
    });
    return { ok: !!(response && response.ok), status: response && response.status };
  } catch (err) {
    console.error(`[closes-3am] track-clv-omega: ${err && err.message ? err.message : err}`);
    return { ok: false, error: 'track-failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultStoreClose(eventRow, info, env, fetchImpl) {
  const oddsMaster = require('./lib/omega-vnext/odds_master');
  return oddsMaster.storeCloseFromOddsEvent(eventRow, info, { env, fetch: fetchImpl });
}

async function defaultGrade(date, env, now) {
  const { gradeStoredClosesForDate } = require('./lib/omega-vnext/candidate_closes_v2');
  return gradeStoredClosesForDate(date, { env, now });
}

async function handle(event, deps) {
  const options = deps || {};
  const env = options.env || process.env;
  if (!closesAt3amEnabled(env)) {
    return S.json(200, { ok: true, skipped: 'flag-off' });
  }
  if (!S.isAuthorized(event, env)) {
    return S.json(401, { ok: false, error: 'unauthorized' });
  }
  const body = readBody(event);
  const qs = (event && event.queryStringParameters) || {};
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const today = S.etYmd(now);
  let date = body.date || qs.date || null;
  if (!date) date = S.addDays(today, -1);
  else if (!C.dateAllowed(String(date), today)) {
    return S.json(400, { ok: false, error: 'date-window', date: String(date) });
  }
  const picksOnly = truthy(body.picksOnly) || truthy(qs.picksOnly);
  const onlyMissing = picksOnly || truthy(body.onlyMissing) || truthy(qs.onlyMissing);
  const scheduled = truthy(body.scheduled) || truthy(qs.scheduled);
  const retryNoClose = !scheduled && (truthy(body.retryNoClose) || truthy(qs.retryNoClose));
  const missingGames = !scheduled && (truthy(body.missingGames) || truthy(qs.missingGames));
  const fetchImpl = options.fetch || fetch;
  const blobs = options.blobs || S.blobClient(env, fetchImpl);
  let storeClose = null;
  if (Object.prototype.hasOwnProperty.call(options, 'storeClose')) storeClose = options.storeClose;
  else if (!options.dryRun) {
    storeClose = (eventRow, info) => defaultStoreClose(eventRow, info, env, fetchImpl);
  }
  let result;
  try {
    result = await C.runCloses({
      now,
      env,
      date,
      onlyMissing,
      picksOnly,
      retryNoClose,
      missingGames,
      dryRun: !!options.dryRun,
      blobs,
      fetch: fetchImpl,
      readBoard: options.readBoard,
      readMaster: options.readMaster,
      card: options.card,
      candidates: options.candidates,
      slateEvents: options.slateEvents,
      writeRows: options.writeRows,
      storeClose,
      requestsRemaining: options.requestsRemaining,
    });
  } catch (err) {
    const message = C.scrub(err && err.message ? err.message : err);
    return S.json(500, { ok: false, error: message });
  }
  let track = null;
  if (!options.skipTrack && !options.dryRun) {
    const invoke = options.invokeTrack || ((d) => invokeTrack(d, env, fetchImpl));
    try { track = await invoke(date); } catch (err) {
      track = { ok: false, error: 'track-failed' };
    }
  }
  let graded = null;
  if (!options.skipGrade && !options.dryRun) {
    try { graded = await defaultGrade(date, env, now); } catch (err) {
      graded = { ok: false, error: C.scrub(err && err.message) };
    }
  }
  // Settled card only. Hash-gated inside mirrorTodayCard; no picks or card writes.
  let mirror = null;
  if (!options.skipMirror && !options.dryRun) {
    try {
      const pending = options.mirrorTodayCard
        ? options.mirrorTodayCard(date, { env, fetch: fetchImpl, blobs })
        : require('./lib/supa-mirror').mirrorTodayCard(date, { env, fetch: fetchImpl, blobs });
      mirror = await raceTimeout(pending, MIRROR_BUDGET_MS);
    } catch (err) {
      mirror = { ok: false, error: C.scrub(err && err.message ? err.message : err) };
    }
  }
  const status = result && result.ok ? 200 : 207;
  return S.json(status, {
    ok: !!(result && result.ok),
    date,
    calls: result ? result.calls.length : 0,
    reserveGuard: !!(result && result.reserveGuard),
    skippedDone: result ? result.skippedDone : 0,
    missingGames: !!(result && result.missingGames),
    picks: result ? result.picks : [],
    games: (result && result.games) || [],
    errors: result ? result.errors : [],
    track,
    graded,
    mirror,
  });
}

exports.handler = (event) => handle(event);
exports.handle = handle;
