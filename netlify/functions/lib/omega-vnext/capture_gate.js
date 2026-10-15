'use strict';

/**
 * Live scheduled card build waits until the 10:00 ET capture has finished.
 * Reads the capture-done marker and, if that is missing, stored line moves.
 * Does not call the Odds API. Never throws. A timeout still returns so the
 * caller can publish the best card from whatever is already stored.
 */

const { opsAlert } = require('./ops_alert');
const { sportsForCard } = require('./season_calendar');
const {
  readPinnacleLineMoves,
  readLineMoveKey,
  captureDoneKey,
  CAPTURE_DONE_SCHEMA,
  isCaptureDoneDoc,
} = require('./pinnacle_line_move');

const DEFAULT_MAX_WAIT_MS = 240000;
const DEFAULT_POLL_MS = 15000;
const DATA_PRESENT_AGE_MS = 60000;

function shouldWaitForCapture(opts = {}) {
  if (!opts || opts.scheduled !== true) return false;
  if (opts.dryRun) return false;
  if (opts.replay || opts.historicalSnapshot) return false;
  if (opts.shadow) return false;
  if (opts.simMode) return false;
  return true;
}

function nowMs(now) {
  if (typeof now === 'function') {
    const value = now();
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (now instanceof Date) return now.getTime();
  return Date.now();
}

function defaultSleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * Age of the newest stored check for slot, when every such check has a
 * parseable timestamp. Null when none exist or a timestamp is missing.
 */
function newestSettledAgeMs(doc, slot, atMs) {
  let newest = null;
  let saw = false;
  for (const eventDoc of (doc && doc.events) || []) {
    for (const check of (eventDoc && eventDoc.checks) || []) {
      if (!check || String(check.slot) !== String(slot)) continue;
      saw = true;
      const at = Date.parse(check.at || '');
      if (!Number.isFinite(at)) return null;
      if (newest == null || at > newest) newest = at;
    }
  }
  if (!saw || newest == null) return null;
  return atMs - newest;
}

async function readCaptureDone(dateISO, slot, opts = {}) {
  const slotId = String(slot || '1000').replace(':', '');
  const read = (opts && typeof opts.read === 'function') ? opts.read : null;
  if (!read) {
    try {
      const doc = await readLineMoveKey(captureDoneKey(dateISO, slotId), opts);
      if (!isCaptureDoneDoc(doc)) return null;
      if (doc.slot && String(doc.slot) !== slotId) return null;
      return doc;
    } catch (_) {
      return null;
    }
  }
  let doc = null;
  try {
    doc = await read(captureDoneKey(dateISO, slotId));
  } catch (_) {
    return null;
  }
  if (!isCaptureDoneDoc(doc)) return null;
  if (doc.schema && doc.schema !== CAPTURE_DONE_SCHEMA) return null;
  if (doc.slot && String(doc.slot) !== slotId) return null;
  return doc;
}

async function waitForCapture(dateISO, slot = '1000', opts = {}) {
  try {
    return await waitForCaptureInner(dateISO, slot, opts);
  } catch (err) {
    const slotId = String(slot || '1000').replace(':', '');
    opsAlert('capture-1000-not-finished', `date=${dateISO} slot=${slotId} ${err && err.message}`);
    return { ready: false, waitedMs: 0, polls: 0, reason: 'timeout' };
  }
}

async function waitForCaptureInner(dateISO, slot, opts) {
  const slotId = String(slot || '1000').replace(':', '');
  const maxWaitMs = opts.maxWaitMs != null ? Number(opts.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
  const pollMs = opts.pollMs != null ? Number(opts.pollMs) : DEFAULT_POLL_MS;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const sportsFn = typeof opts.sportsForCard === 'function' ? opts.sportsForCard : sportsForCard;
  const readMoves = typeof opts.readPinnacleLineMoves === 'function'
    ? opts.readPinnacleLineMoves
    : readPinnacleLineMoves;
  let sports = null;
  try {
    sports = sportsFn(dateISO, { env: opts.env });
  } catch (_) {
    sports = null;
  }
  if (Array.isArray(sports) && sports.length === 0) {
    return { ready: true, waitedMs: 0, polls: 0, reason: 'no-sports-today' };
  }
  const start = nowMs(opts.now);
  const cap = Math.max(1, Math.ceil((Number.isFinite(maxWaitMs) ? maxWaitMs : DEFAULT_MAX_WAIT_MS) / Math.max(1, pollMs)) + 2);
  let polls = 0;
  while (polls < cap) {
    polls += 1;
    const at = nowMs(opts.now);
    const waitedMs = at - start;
    let marker = null;
    try {
      marker = await readCaptureDone(dateISO, slotId, opts);
    } catch (_) {
      marker = null;
    }
    if (marker) {
      if (marker.ok === false) {
        return { ready: true, waitedMs, polls, reason: 'marker-not-ok' };
      }
      return { ready: true, waitedMs, polls, reason: 'marker' };
    }
    let moves = null;
    try {
      moves = await readMoves(dateISO, opts);
    } catch (_) {
      moves = null;
    }
    const age = newestSettledAgeMs(moves, slotId, at);
    if (age != null && age > DATA_PRESENT_AGE_MS) {
      return { ready: true, waitedMs, polls, reason: 'data-present' };
    }
    if (waitedMs >= maxWaitMs) {
      opsAlert('capture-1000-not-finished', `date=${dateISO} slot=${slotId} waitedMs=${waitedMs} polls=${polls}`);
      return { ready: false, waitedMs, polls, reason: 'timeout' };
    }
    const nap = Math.min(pollMs, Math.max(0, maxWaitMs - waitedMs));
    await sleep(nap);
  }
  const waitedMs = nowMs(opts.now) - start;
  opsAlert('capture-1000-not-finished', `date=${dateISO} slot=${slotId} waitedMs=${waitedMs} polls=${polls}`);
  return { ready: false, waitedMs, polls, reason: 'timeout' };
}

/**
 * Null when this run must not wait. Otherwise the gate result.
 * A thrown wait becomes ready:false so generate still builds the card.
 */
async function awaitLiveCaptureGate(opts = {}) {
  if (!shouldWaitForCapture(opts)) return null;
  const dateISO = opts.dateISO || opts.date;
  return waitForCapture(dateISO, opts.slot || '1000', opts);
}

module.exports = {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_MS,
  DATA_PRESENT_AGE_MS,
  shouldWaitForCapture,
  readCaptureDone,
  waitForCapture,
  awaitLiveCaptureGate,
};
