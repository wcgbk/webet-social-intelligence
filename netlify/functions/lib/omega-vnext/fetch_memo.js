'use strict';

/**
 * In-run fetch memo and pick-neutral Odds API skips.
 *
 * The memo lives in AsyncLocalStorage, so a warm Netlify container cannot
 * serve one invocation's odds or standings to the next. Outside a run the
 * helpers always hit the network. Cached JSON is deep-cloned on the way in
 * and out so a caller cannot mutate another caller's copy.
 *
 * GET /v4/sports/{sport}/events does not count against the Odds API quota
 * and lists the same in-play and pre-match events as /odds. A successful
 * events list with zero commence times on the card's ET date is the same
 * empty slate the odds response would be filtered down to.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { isSameEtDay } = require('./odds_math');

const als = new AsyncLocalStorage();

/** Same-slot line snap younger than this is reused instead of a second Odds pull. */
const FRESH_SNAP_MS = 10 * 60 * 1000;

/**
 * Live Alpha odds keys that cannot change a published side.
 * computeEdgeTable skips every soccer league (SOCCER_DISABLED). The conference
 * league is not on the ESPN slate at all. Historical sims still fetch them.
 */
const ALPHA_LIVE_ODDS_SKIP = new Set([
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_france_ligue_one',
  'soccer_usa_mls',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_uefa_europa_conference_league',
]);

function runWithFetchMemo(fn) {
  if (als.getStore()) return fn();
  return als.run({ json: new Map(), values: new Map() }, fn);
}

function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * One successful JSON body per exact URL per run. Failures are not cached.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchImpl]
 */
async function memoFetchJson(url, timeoutMs = 12000, fetchImpl = fetch) {
  const store = als.getStore();
  const key = String(url);
  if (store && store.json.has(key)) return cloneJson(store.json.get(key));
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for ${key.split('?')[0]}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  if (store) store.json.set(key, cloneJson(data));
  return cloneJson(data);
}

/** Cache a computed value for this run. No-op cache outside a run. */
async function memoValue(key, producer) {
  const store = als.getStore();
  const id = String(key);
  if (store && store.values.has(id)) return cloneJson(store.values.get(id));
  const value = await producer();
  if (store) store.values.set(id, cloneJson(value));
  return cloneJson(value);
}

function countSameEtDay(events, dateISO) {
  let n = 0;
  for (const ev of events || []) {
    const t = ev && (ev.commence_time || ev.commenceTime || ev.date);
    if (t && isSameEtDay(t, dateISO)) n += 1;
  }
  return n;
}

/**
 * Free events preflight. skip is true only when the call succeeds and zero
 * events commence on dateISO. Errors and the historical path never skip —
 * the caller pulls odds exactly as before.
 */
async function slateOddsGate({
  sportKey, apiKey, dateISO, historical = false, fetchImpl = fetch, timeoutMs = 12000,
} = {}) {
  if (historical) return { skip: false, reason: 'historical', sameDay: null, events: null };
  if (!apiKey || !sportKey || !dateISO) {
    return { skip: false, reason: 'missing-args', sameDay: null, events: null };
  }
  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/events`
    + `?dateFormat=iso&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const body = await memoFetchJson(url, timeoutMs, fetchImpl);
    const list = Array.isArray(body) ? body : [];
    const sameDay = countSameEtDay(list, dateISO);
    if (sameDay === 0) {
      return { skip: true, reason: 'no-same-et-day', sameDay: 0, events: list.length };
    }
    return { skip: false, reason: 'has-same-et-day', sameDay, events: list.length };
  } catch (e) {
    return { skip: false, reason: 'events-unavailable', error: e.message, sameDay: null, events: null };
  }
}

function skipAlphaLiveOdds(sportKey, { historical = false } = {}) {
  if (historical) return false;
  return ALPHA_LIVE_ODDS_SKIP.has(sportKey);
}

/**
 * A usable snap for this exact slot, captured within maxAgeMs.
 * Empty snaps are not reusable — a later pull may be the first real book.
 */
function isFreshReusableSnap(snap, now, maxAgeMs = FRESH_SNAP_MS) {
  if (!snap || typeof snap !== 'object') return false;
  const games = snap.games;
  const n = games && typeof games === 'object' ? Object.keys(games).length : 0;
  const declared = Number(snap.gameCount);
  const usable = (Number.isFinite(declared) && declared > 0) || n > 0;
  if (!usable) return false;
  const at = Date.parse(snap.capturedAt || '');
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(t)) return false;
  const age = t - at;
  return age >= 0 && age <= maxAgeMs;
}

/** True when every requested sport label was recorded on the snap (`MLB:3`, `NHL:skip-empty`). */
function snapCoversSports(snap, labels) {
  const tags = snap && Array.isArray(snap.sports) ? snap.sports : null;
  if (!tags || !tags.length) return false;
  const have = new Set(tags.map((s) => String(s).split(':')[0]));
  return (labels || []).every((label) => have.has(label));
}

/**
 * Stored CLV row is already the historical close at commence.
 * captureScore 0 is the best possible score, so another pull of the same
 * timestamp cannot replace it.
 */
function hasTrueClosingCapture(prev) {
  if (!prev || typeof prev.clv !== 'number' || !Number.isFinite(prev.clv)) return false;
  if (prev.captureMinsToCommence !== 0) return false;
  if (prev.captureScore !== 0) return false;
  return true;
}

/** Identical narrate retries cannot succeed on a rejected request. 429/5xx/parse still retry. */
function narrateErrorShouldRetry(err) {
  const msg = String((err && err.message) || '');
  if (/Anthropic HTTP (400|401|403)\b/.test(msg)) return false;
  return true;
}

module.exports = {
  runWithFetchMemo,
  memoFetchJson,
  memoValue,
  countSameEtDay,
  slateOddsGate,
  skipAlphaLiveOdds,
  ALPHA_LIVE_ODDS_SKIP,
  isFreshReusableSnap,
  snapCoversSports,
  hasTrueClosingCapture,
  narrateErrorShouldRetry,
  FRESH_SNAP_MS,
};
