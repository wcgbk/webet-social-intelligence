'use strict';
/**
 * Per-slot blob lock for the 3 AM / 10 AM pull and the jobs it fires.
 *
 * Installed @netlify/blobs 8.2.0 exposes etag on getWithMetadata (If-None-Match
 * for reads). set / setJSON accept only { metadata }. There is no onlyIfNew
 * or onlyIfMatch. A store whose setJSON source mentions onlyIfNew is used
 * when one is passed in. Otherwise this is read-then-write plus a re-read
 * of the holder id. A store error is thrown so the caller can fail open.
 * A holder that throws releases its own lock so the scheduler retry can run.
 */
const crypto = require('crypto');
const S = require('./clv-supabase');

const LOCK_TTL_MS = 20 * 60 * 1000;

function truthy(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
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

/** force=1 (body or query) counts only when the existing picks secret matches. */
function forceOverride(event, env) {
  const qs = (event && event.queryStringParameters) || {};
  const body = readBody(event);
  const raw = qs.force != null ? qs.force : body.force;
  if (!truthy(raw)) return false;
  return S.isAuthorized(event, env);
}

function pullLockKey(dateISO, slot) {
  return `locks/pull/${dateISO}/${slot}`;
}

function closesLockKey(dateISO) {
  return `locks/closes/${dateISO}`;
}

function trackLockKey(dateISO) {
  return `locks/track-clv/${dateISO}`;
}

function fresh(doc, nowMs, ttlMs) {
  if (!doc || !doc.holder || !doc.acquiredAt) return false;
  if (doc.released === true) return false;
  const at = Date.parse(doc.acquiredAt);
  if (!Number.isFinite(at)) return false;
  return (nowMs - at) < ttlMs;
}

function setAcceptsOnlyIfNew(store) {
  if (!store || typeof store.setJSON !== 'function') return false;
  try {
    return Function.prototype.toString.call(store.setJSON).includes('onlyIfNew');
  } catch (_) {
    return false;
  }
}

function newHolder() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Take key when it is missing or older than ttlMs.
 * Returns { ok:true, holder, acquiredAt } or { ok:false, reason:'held', holder }.
 * Throws if read or write throws.
 */
async function acquireBlobLock({ read, write, key, now, ttlMs, store, holder }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ttl = ttlMs == null ? LOCK_TTL_MS : ttlMs;
  const id = holder || newHolder();
  const acquiredAt = new Date(nowMs).toISOString();
  const claim = { holder: id, acquiredAt, ttlMs: ttl };

  if (store && setAcceptsOnlyIfNew(store)) {
    try {
      await store.setJSON(key, claim, { onlyIfNew: true });
    } catch (err) {
      const msg = String((err && (err.message || err.status)) || err || '');
      if (!/409|412|precondition|already exists|onlyIfNew|conflict/i.test(msg)) throw err;
    }
    const seenNew = await read(key);
    if (seenNew && seenNew.holder === id) return { ok: true, holder: id, acquiredAt };
    if (fresh(seenNew, nowMs, ttl)) return { ok: false, reason: 'held', holder: seenNew && seenNew.holder };
  }

  const current = await read(key);
  if (fresh(current, nowMs, ttl) && current.holder !== id) {
    return { ok: false, reason: 'held', holder: current.holder, acquiredAt: current.acquiredAt };
  }
  await write(key, claim);
  const seen = await read(key);
  if (!seen || seen.holder !== id) {
    return { ok: false, reason: 'held', holder: seen && seen.holder };
  }
  return { ok: true, holder: id, acquiredAt };
}

/**
 * Completed pulls/{date}/{slot} (has at) is slot-done.
 * A live lock is slot-locked. Store errors return null (caller pulls).
 * force or a disabled flag returns null.
 * An acquired lock returns { holder, key, acquiredAt } so the caller can release it.
 */
async function guardPullSlot({ enabled, force, read, write, dateISO, slot, now, ttlMs, store }) {
  if (!enabled || force) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let doc = null;
  try {
    doc = await read(`pulls/${dateISO}/${slot}`);
  } catch (err) {
    console.error(`[odds-master] slot lock read failed open: ${err && err.message ? err.message : err}`);
    return null;
  }
  if (doc && doc.at) return { skipped: 'slot-done', date: dateISO, slot };
  try {
    const lock = await acquireBlobLock({
      read,
      write,
      key: pullLockKey(dateISO, slot),
      now: nowMs,
      ttlMs,
      store,
    });
    if (!lock.ok) return { skipped: 'slot-locked', date: dateISO, slot };
    return { holder: lock.holder, key: pullLockKey(dateISO, slot), acquiredAt: lock.acquiredAt };
  } catch (err) {
    console.error(`[odds-master] slot lock failed open: ${err && err.message ? err.message : err}`);
    return null;
  }
}

async function defaultLockRead(key) {
  const { getStore } = require('@netlify/blobs');
  const store = getStore('odds-master');
  const value = await store.get(key, { type: 'json' });
  return value == null ? null : value;
}

async function defaultLockWrite(key, data) {
  const { getStore } = require('@netlify/blobs');
  const store = getStore('odds-master');
  await store.setJSON(key, data);
  return true;
}

/**
 * One run per date. Returns a skip object, a held claim, or null.
 * null means the caller should run and holds no lock (flag, force, or fail open).
 * Store errors return null (fail open).
 */
async function guardDateLock({ enabled, force, read, write, key, now, ttlMs, label }) {
  if (!enabled || force) return null;
  const readFn = read || defaultLockRead;
  const writeFn = write || defaultLockWrite;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  try {
    const lock = await acquireBlobLock({
      read: readFn,
      write: writeFn,
      key,
      now: nowMs,
      ttlMs,
    });
    if (!lock.ok) return { skipped: 'slot-locked' };
    return { holder: lock.holder, key, acquiredAt: lock.acquiredAt };
  } catch (err) {
    console.error(`[${label || 'slot-lock'}] lock failed open: ${err && err.message ? err.message : err}`);
    return null;
  }
}

/**
 * Drop a lock this run holds so a scheduler retry can take the slot.
 * Read, compare holder, then overwrite with an expired doc. A different
 * holder is left untouched. Read or write failures are logged and swallowed.
 */
async function releaseHeldLock({ read, write, key, holder, now }) {
  if (!key || !holder) return false;
  const readFn = read || defaultLockRead;
  const writeFn = write || defaultLockWrite;
  try {
    const doc = await readFn(key);
    if (!doc || doc.holder !== holder) return false;
    const releasedAt = (now instanceof Date ? now : new Date()).toISOString();
    await writeFn(key, {
      holder,
      acquiredAt: '1970-01-01T00:00:00.000Z',
      ttlMs: 0,
      released: true,
      releasedAt,
    });
    return true;
  } catch (err) {
    console.error(`[slot-lock] release failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

module.exports = {
  LOCK_TTL_MS,
  truthy,
  readBody,
  forceOverride,
  pullLockKey,
  closesLockKey,
  trackLockKey,
  fresh,
  setAcceptsOnlyIfNew,
  acquireBlobLock,
  guardPullSlot,
  guardDateLock,
  releaseHeldLock,
  defaultLockRead,
  defaultLockWrite,
};
