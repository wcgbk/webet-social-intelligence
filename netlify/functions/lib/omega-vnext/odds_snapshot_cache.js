'use strict';

/**
 * Cross-run Odds API snapshot cache.
 *
 * Key: sport + snapshot + markets + regions + bookmakers, plus eventId on
 * a per-event URL. List params are trimmed, lowercased, de-duplicated, and
 * sorted. apiKey is never part of the key and is never written.
 *
 * snapshot is the historical `date` param when the URL has one. A live URL
 * uses the pregame clock (pregameAsOfMs when a run set one, otherwise now),
 * floored to FRESH_SNAP_MS (10 minutes).
 *
 * ODDS_SNAPSHOT_CACHE_DIR: read-through JSON files for dry runs and replays.
 * Atomic write. The file holds the body, x-requests headers, and fetchedAt.
 * On Netlify with no directory, responses write through to the
 * "odds-snapshots" blob store. That path never throws and never blocks a
 * run past a short timeout. Live production reads stay on the network
 * except a slate snapshot already stored for the current bucket. Per-event
 * live polls (DraftKings retry) are saved but not served back on Netlify,
 * so a line that appears inside the bucket is still fetched.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const BLOB_STORE = 'odds-snapshots';
const X_HEADERS = ['x-requests-last', 'x-requests-remaining', 'x-requests-used'];
const SECRET_PARAMS = ['apiKey', 'api_key', 'api-key', 'key', 'token', 'access_token'];
const BLOB_TIMEOUT_MS = 1500;

const clockAls = new AsyncLocalStorage();
const memory = new Map();
const lookedUp = new Map();
/** Last live x-requests-remaining seen by this process. Cache hits do not update it. */
let knownRequestsRemaining = null;

function noteKnownRequestsRemaining(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value['x-requests-remaining']
    : value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return knownRequestsRemaining;
  knownRequestsRemaining = n;
  return knownRequestsRemaining;
}

function knownRequestsRemainingValue() {
  return knownRequestsRemaining;
}

function resetKnownRequestsRemainingForTests() {
  knownRequestsRemaining = null;
}

function freshSnapMs() {
  return require('./fetch_memo').FRESH_SNAP_MS;
}

function cacheDir() {
  const raw = process.env.ODDS_SNAPSHOT_CACHE_DIR;
  if (raw == null) return '';
  return String(raw).trim();
}

function blobEnabled() {
  if (cacheDir()) return false;
  if (process.env.ODDS_SNAPSHOT_CACHE_BLOBS === '0') return false;
  if (process.env.ODDS_SNAPSHOT_CACHE_BLOBS === '1') return true;
  if (process.env.NETLIFY === 'true' || process.env.NETLIFY === '1') return true;
  if (process.env.NETLIFY_BLOBS_CONTEXT) return true;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
  return false;
}

function enabled() {
  return !!cacheDir() || blobEnabled();
}

function clockMs() {
  const store = clockAls.getStore();
  if (store && Number.isFinite(store.ms)) return store.ms;
  return Date.now();
}

/** Keep an outer pregame clock. A nested capture must not replace it. */
function runWithSnapshotClock(ms, fn) {
  if (clockAls.getStore()) return fn();
  const n = Number(ms);
  if (!Number.isFinite(n)) return fn();
  return clockAls.run({ ms: n }, fn);
}

function snapshotBucket(ms) {
  const windowMs = freshSnapMs();
  const t = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  const width = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 10 * 60 * 1000;
  return new Date(Math.floor(t / width) * width).toISOString();
}

function listParam(params, name) {
  const raw = params.get(name);
  if (raw == null) return '';
  const items = new Set();
  for (const part of String(raw).split(',')) {
    const item = part.trim().toLowerCase();
    if (item) items.add(item);
  }
  return [...items].sort().join(',');
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return value; }
}

function parseUrl(url) {
  const u = new URL(String(url));
  const parts = u.pathname.split('/').filter(Boolean);
  const sportsIdx = parts.indexOf('sports');
  const sport = sportsIdx >= 0 && parts[sportsIdx + 1] ? decodePart(parts[sportsIdx + 1]) : '';
  const eventsIdx = parts.indexOf('events');
  let eventId = '';
  if (eventsIdx >= 0 && parts[eventsIdx + 1] && parts[eventsIdx + 1] !== 'odds') {
    eventId = decodePart(parts[eventsIdx + 1]);
  }
  const date = u.searchParams.get('date');
  const snapshot = date != null && String(date).trim() !== ''
    ? String(date).trim()
    : snapshotBucket(clockMs());
  return canonicalKey({
    sport,
    snapshot,
    markets: listParam(u.searchParams, 'markets'),
    regions: listParam(u.searchParams, 'regions'),
    bookmakers: listParam(u.searchParams, 'bookmakers'),
    eventId,
  });
}

function canonicalKey(parts) {
  const src = parts || {};
  return {
    sport: src.sport || '',
    snapshot: src.snapshot || '',
    markets: src.markets || '',
    regions: src.regions || '',
    bookmakers: src.bookmakers || '',
    eventId: src.eventId || '',
  };
}

function hashKey(key) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalKey(key))).digest('hex');
}

function fileFor(key) {
  const sport = String(key.sport || 'sport').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'sport';
  return path.join(cacheDir(), `${sport}--${hashKey(key)}.json`);
}

function isOddsUrl(url) {
  try { return new URL(String(url)).hostname === 'api.the-odds-api.com'; }
  catch (_) { return String(url || '').includes('api.the-odds-api.com'); }
}

function isGet(init) {
  const method = init && init.method ? String(init.method).toUpperCase() : 'GET';
  return method === 'GET';
}

function secretValues(url) {
  const out = [];
  try {
    const u = new URL(String(url));
    for (const name of SECRET_PARAMS) {
      const value = u.searchParams.get(name);
      if (value && value.length >= 4 && value !== 'REDACTED') out.push(value);
    }
  } catch (_) { /* no query secrets */ }
  return out;
}

function headerLookup(resp, name) {
  if (!resp || resp.headers == null) return null;
  const headers = resp.headers;
  try {
    if (typeof headers.get === 'function') {
      const direct = headers.get(name);
      if (direct != null && direct !== '') return Array.isArray(direct) ? direct[0] : direct;
    }
  } catch (_) { /* mock headers */ }
  if (typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === name && typeof headers[k] !== 'function' && headers[k] != null && headers[k] !== '') {
        return Array.isArray(headers[k]) ? headers[k][0] : headers[k];
      }
    }
  }
  return null;
}

function readXHeaders(resp) {
  const headers = {};
  for (const name of X_HEADERS) {
    const value = headerLookup(resp, name);
    headers[name] = value == null || value === '' ? null : String(value);
  }
  return headers;
}

function creditCost(headers) {
  const n = Number(headers && headers['x-requests-last']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function scrubbedPayload(record, secrets) {
  let text;
  try { text = JSON.stringify(record); }
  catch (_) { return null; }
  for (const secret of secrets || []) {
    if (secret) text = text.split(secret).join('');
  }
  if (/apiKey/i.test(text)) return null;
  for (const secret of secrets || []) {
    if (secret && text.includes(secret)) return null;
  }
  try { JSON.parse(text); }
  catch (_) { return null; }
  return text;
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const left = canonicalKey(a);
  const right = canonicalKey(b);
  return left.sport === right.sport
    && left.snapshot === right.snapshot
    && left.markets === right.markets
    && left.regions === right.regions
    && left.bookmakers === right.bookmakers
    && left.eventId === right.eventId;
}

function usableRecord(record, key) {
  return !!(record && typeof record === 'object'
    && Object.prototype.hasOwnProperty.call(record, 'body')
    && record.fetchedAt
    && sameKey(record.key, key));
}

function shouldRead(key) {
  if (cacheDir()) return true;
  if (!blobEnabled()) return false;
  // Live per-event polls change inside the 10-minute bucket. Keep the
  // saved body, but do not replay it on Netlify.
  if (key.eventId) return false;
  // A historical date is a different snapshot. Production re-pulls it.
  // A live key's snapshot is the current bucket, so this is the one read.
  return key.snapshot === snapshotBucket(clockMs());
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('odds-snapshot-cache timeout')), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function atomicWrite(file, payload) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing landed */ }
    throw err;
  }
}

async function openBlobs() {
  const { getStore } = await import('@netlify/blobs');
  return getStore(BLOB_STORE);
}

async function readRecord(key) {
  const id = hashKey(key);
  if (memory.has(id)) {
    const cached = memory.get(id);
    return usableRecord(cached, key) ? cached : null;
  }
  const dir = cacheDir();
  if (dir) {
    const file = fileFor(key);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!usableRecord(parsed, key)) return null;
    memory.set(id, parsed);
    return parsed;
  }
  if (blobEnabled()) {
    const parsed = await withTimeout((async () => {
      const store = await openBlobs();
      return store.get(id, { type: 'json' });
    })(), BLOB_TIMEOUT_MS);
    if (!usableRecord(parsed, key)) return null;
    memory.set(id, parsed);
    return parsed;
  }
  return null;
}

async function writeRecord(key, payload) {
  const id = hashKey(key);
  const parsed = JSON.parse(payload);
  memory.set(id, parsed);
  const dir = cacheDir();
  if (dir) {
    atomicWrite(fileFor(key), payload);
    return;
  }
  if (!blobEnabled()) return;
  const pending = (async () => {
    const store = await openBlobs();
    if (typeof store.setJSON === 'function') await store.setJSON(id, parsed);
    else await store.set(id, payload);
  })();
  pending.catch(() => {});
  try {
    await withTimeout(pending, BLOB_TIMEOUT_MS);
  } catch (_) { /* best-effort write; the network response still returns */ }
}

function synthetic(record, hit) {
  const body = cloneJson(record.body);
  const text = JSON.stringify(body);
  const headers = record.headers || {};
  return {
    ok: true,
    status: 200,
    oddsSnapshotHit: !!hit,
    headers: {
      get(name) {
        const want = String(name || '').toLowerCase();
        if (want === 'content-type') return 'application/json';
        if (want === 'content-length') return String(Buffer.byteLength(text));
        const value = headers[want];
        if (value == null || value === '') return null;
        return String(value);
      },
    },
    json: async () => cloneJson(body),
    text: async () => text,
  };
}

function textResponse(resp, text) {
  return {
    ok: !!resp.ok,
    status: resp.status,
    headers: resp.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function rememberLookup(key, info) {
  lookedUp.set(hashKey(key), info);
}

function oddsSnapshotSavedCredits(url) {
  try {
    const info = lookedUp.get(hashKey(parseUrl(url)));
    if (!info || !info.hit) return { hit: false, credits: 0 };
    return { hit: true, credits: Number(info.credits) || 0 };
  } catch (_) {
    return { hit: false, credits: 0 };
  }
}

function auditNote(info) {
  try {
    const { currentAudit } = require('./audit_log');
    const log = currentAudit();
    if (!log) return;
    if (typeof log.noteOddsCache === 'function') log.noteOddsCache(info);
    if (info && info.hit && typeof log.record === 'function') {
      log.record({
        kind: 'http',
        provider: 'odds-api',
        method: 'GET',
        url: info.url,
        status: 200,
        ms: 0,
        bytes: null,
        ok: true,
        error: null,
        note: `odds-snapshot-cache hit creditsSaved=${Number(info.credits) || 0}`,
        'x-requests-last': null,
        'x-requests-remaining': null,
      });
    }
  } catch (err) {
    console.error(`[odds-snapshot-cache] audit soft-fail: ${err && err.message}`);
  }
}

async function materialize(resp, key, secrets) {
  let text = null;
  let body;
  if (typeof resp.text === 'function') {
    text = await resp.text();
    try { body = JSON.parse(text); }
    catch (_) { return textResponse(resp, text); }
  } else if (typeof resp.json === 'function') {
    body = await resp.json();
  } else {
    return resp;
  }
  const headers = readXHeaders(resp);
  noteKnownRequestsRemaining(headers);
  const record = {
    key,
    body,
    headers,
    fetchedAt: new Date().toISOString(),
  };
  const payload = scrubbedPayload(record, secrets);
  const unchanged = payload != null && payload === JSON.stringify(record);
  if (unchanged) {
    try { await writeRecord(key, payload); }
    catch (err) {
      console.error(`[odds-snapshot-cache] write soft-fail: ${err && err.message}`);
    }
  }
  return synthetic(record, false);
}

function stripCacheInit(init) {
  if (!init || !Object.prototype.hasOwnProperty.call(init, 'oddsSnapshotMaxAgeMs')) return init;
  const next = { ...init };
  delete next.oddsSnapshotMaxAgeMs;
  return next;
}

function hitIsFresh(hit, maxAgeMs) {
  if (!Number.isFinite(maxAgeMs)) return true;
  const at = Date.parse(hit && hit.fetchedAt);
  if (!Number.isFinite(at)) return false;
  const age = clockMs() - at;
  return age >= 0 && age < maxAgeMs;
}

async function cachedFetch(fetchImpl, url, init) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const maxAgeMs = init && Number(init.oddsSnapshotMaxAgeMs);
  const netInit = stripCacheInit(init);
  if (!enabled() || !isGet(init) || !isOddsUrl(url)) return impl(url, netInit);
  let key;
  try { key = parseUrl(url); }
  catch (_) { return impl(url, netInit); }
  const secrets = secretValues(url);
  if (shouldRead(key)) {
    try {
      const hit = await readRecord(key);
      if (hit && hitIsFresh(hit, maxAgeMs)) {
        const credits = creditCost(hit.headers);
        rememberLookup(key, { hit: true, credits });
        auditNote({ hit: true, credits, url });
        return synthetic(hit, true);
      }
    } catch (err) {
      console.error(`[odds-snapshot-cache] read soft-fail: ${err && err.message}`);
    }
  }
  let resp;
  try {
    resp = await impl(url, netInit);
  } catch (err) {
    rememberLookup(key, { hit: false, credits: 0 });
    auditNote({ hit: false, credits: 0, url });
    throw err;
  }
  rememberLookup(key, { hit: false, credits: 0 });
  auditNote({ hit: false, credits: 0, url });
  if (!resp || !resp.ok) return resp;
  try {
    return await materialize(resp, key, secrets);
  } catch (err) {
    console.error(`[odds-snapshot-cache] store soft-fail: ${err && err.message}`);
    return resp;
  }
}

function wrap(fetchImpl) {
  if (fetchImpl && fetchImpl.__oddsSnapshotWrapped) return fetchImpl;
  const inner = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  async function oddsSnapshotFetch(url, init) {
    return cachedFetch(inner, url, init);
  }
  Object.defineProperty(oddsSnapshotFetch, '__oddsSnapshotWrapped', { value: true });
  return oddsSnapshotFetch;
}

function clearMemoryForTests() {
  memory.clear();
  lookedUp.clear();
}

function liveBucket(snapshot) {
  const t = Date.parse(snapshot);
  if (!Number.isFinite(t)) return false;
  const width = freshSnapMs();
  return t === Math.floor(t / width) * width;
}

/**
 * Same sport + markets + regions + bookmakers, fetched strictly younger than
 * maxAgeMs. Looks across the current and previous live buckets so a pull that
 * crossed the 10-minute cache boundary is still reused. Historical date=
 * snapshots are not live pulls.
 */
async function findFreshSportPull(query = {}) {
  const nowMs = Number.isFinite(Number(query.nowMs)) ? Number(query.nowMs) : clockMs();
  const maxAgeMs = Number.isFinite(Number(query.maxAgeMs)) ? Number(query.maxAgeMs) : 5 * 60 * 1000;
  const want = {
    sport: query.sport || '',
    markets: query.markets || '',
    regions: query.regions || '',
    bookmakers: query.bookmakers || '',
  };
  let best = null;
  const consider = (record) => {
    if (!record || !record.key || !record.fetchedAt || record.body == null) return;
    if (record.key.eventId) return;
    if (record.key.sport !== want.sport) return;
    if (want.markets && record.key.markets !== want.markets) return;
    if (want.regions && record.key.regions !== want.regions) return;
    if (want.bookmakers && record.key.bookmakers !== want.bookmakers) return;
    if (!liveBucket(record.key.snapshot)) return;
    const at = Date.parse(record.fetchedAt);
    if (!Number.isFinite(at)) return;
    const age = nowMs - at;
    if (age < 0 || age >= maxAgeMs) return;
    if (!best || age < best.ageMs) best = { record, ageMs: age };
  };
  for (const record of memory.values()) consider(record);
  const snapshots = [snapshotBucket(nowMs), snapshotBucket(nowMs - freshSnapMs())];
  for (const snapshot of snapshots) {
    const key = canonicalKey({ ...want, snapshot, eventId: '' });
    const id = hashKey(key);
    if (memory.has(id)) continue;
    try {
      const rec = await readRecord(key);
      consider(rec);
    } catch (_) { /* a missing bucket is a miss */ }
  }
  if (!best) return null;
  return {
    body: cloneJson(best.record.body),
    fetchedAt: best.record.fetchedAt,
    ageMs: best.ageMs,
    headers: best.record.headers || {},
  };
}

/** Test and in-process seed. Same record shape the cache writes after a live pull. */
function rememberLivePull(input = {}) {
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  const at = Date.parse(fetchedAt);
  const key = canonicalKey({
    sport: input.sport || '',
    snapshot: snapshotBucket(Number.isFinite(at) ? at : Date.now()),
    markets: input.markets || '',
    regions: input.regions || '',
    bookmakers: input.bookmakers || '',
    eventId: '',
  });
  const record = {
    key,
    body: input.body,
    headers: input.headers || {},
    fetchedAt,
  };
  memory.set(hashKey(key), record);
  return record;
}

module.exports = {
  enabled,
  wrap,
  cachedFetch,
  runWithSnapshotClock,
  snapshotBucket,
  oddsSnapshotSavedCredits,
  clearMemoryForTests,
  findFreshSportPull,
  rememberLivePull,
  noteKnownRequestsRemaining,
  knownRequestsRemainingValue,
  resetKnownRequestsRemainingForTests,
  BLOB_STORE,
};
