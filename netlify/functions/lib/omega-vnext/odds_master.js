'use strict';

/**
 * odds-master — append-only Pinnacle / DraftKings price tape.
 *
 * Phase B merge: this store is the single price log. A later pass can fold
 * omega-pinnacle-line-moves, clv-candidates-v2, and clv-{date} onto these
 * keys. Do not write picks-{date}, latest-date, or picks-dates here.
 *
 * Store: odds-master
 *
 * Price key (write-once):
 *   {sport}/{eventId}/{book}/{market}/{timestamp}
 *   sport: MLB | NFL | NCAAF | NHL
 *   book: pinnacle | draftkings
 *   market: h2h | spreads | totals
 *   timestamp: ISO time of the price (historical snapshot, or the check time)
 *
 * Price value (schema odds-master-v1):
 *   {
 *     schema, store, appendOnly: true,
 *     role,            // first role that created the key: open | baseline-0300 |
 *                      // check-0300 | check-1000 | close
 *     roles,           // every role this same price satisfies
 *     sport, eventId, book, market, timestamp,
 *     homeTeam, awayTeam, commenceTime,
 *     snapshotAt,      // Odds API snapshot timestamp; null on a live check
 *     requestedAt,     // historical date= param; null on a live check
 *     pregame,         // closes are true only when snapshotAt <= commenceTime
 *     source,          // live | historical | adopted
 *     sides: { home|away|over|under: { team, price, line, noVig } }
 *   }
 *
 * Dedupe index (the only keys rewritten in place):
 *   index/{sport}/{eventId}   schema odds-master-index-v1
 *     prices: { "{book}/{market}/{timestamp}": { role, roles } }
 *     open, baseline0300, close, checks: slot -> { at }
 *   by-date/{YYYY-MM-DD}      schema odds-master-date-v1
 *     events commenced on that ET day, so a stored game is not re-pulled
 *     (by-date, not date/, so this store does not share a key with
 *     omega-pinnacle-line-moves even when a test writer is shared)
 *
 * A price key is written once. A second role for that same key is recorded
 * on the index only. A game with index.close is not historical-pulled again.
 * dryRun and OMEGA_REPLAY_NO_WRITE write nothing.
 *
 * Historical Odds API cost for this tape: 10 credits per region per market.
 * regions=eu is one region and markets=h2h,spreads,totals is three, so one
 * historical pull is 30 credits. Games that share a commence_time share that
 * one pull. A typical day is about 10 distinct kickoffs that are not already
 * stored (a live candidate close or a prior clv-{date} capture skips the
 * game), about 300 historical credits, on top of the existing live checks.
 */

const { SITE_ID, BLOB_STORE, ODDS_SPORT_KEYS, PINNACLE_LINE_MOVE } = require('./config');
const { replayNoWrite, logBlocked } = require('./no_write');
const { resolveFetch, auditBlobCall } = require('./audit_log');
const { hasTrueClosingCapture } = require('./fetch_memo');
const { quotesFromEvent } = require('./pinnacle_line_move');
const { canonicalBlobKey, legacyEncodedBlobKey, blobHasSlash, blobRestUrl } = require('./blob_key');
const { opsAlert } = require('./ops_alert');

const STORE = 'odds-master';
const SCHEMA = 'odds-master-v1';
const INDEX_SCHEMA = 'odds-master-index-v1';
const DATE_SCHEMA = 'odds-master-date-v1';
/** 10 × 1 eu region × 3 markets. Live pinnacle/eu is 3; historical is 10×. */
const HISTORICAL_CREDITS_PER_PULL = 30;
const EARLY_REUSE_MS = 5 * 60 * 1000;

const CARD_KEY = /^(?:picks-\d{4}-\d{2}-\d{2}|picks-sim-|latest-date|picks-dates)$/;

function historicalCreditsPerPull() {
  const configured = Number(PINNACLE_LINE_MOVE && PINNACLE_LINE_MOVE.historicalCreditsPerPull);
  return Number.isFinite(configured) && configured > 0 ? configured : HISTORICAL_CREDITS_PER_PULL;
}

function earlyReuseMs() {
  const configured = Number(PINNACLE_LINE_MOVE && PINNACLE_LINE_MOVE.earlyReuseMs);
  return Number.isFinite(configured) && configured > 0 ? configured : EARLY_REUSE_MS;
}

function priceKey(sport, eventId, book, market, timestamp) {
  return `${sport}/${eventId}/${book}/${market}/${timestamp}`;
}

function indexKey(sport, eventId) {
  return `index/${sport}/${eventId}`;
}

function dateKey(ymd) {
  return `by-date/${ymd}`;
}

/** Write-once marker. A lost read-modify-write on by-date cannot drop this. */
function dateEventMarkerKey(ymd, sport, eventId) {
  return `by-date/${ymd}/event/${sport}/${eventId}`;
}

function isDateIndexKey(key) {
  const text = String(key || '');
  return text.startsWith('by-date/') && text.indexOf('/event/') === -1 && text.split('/').length === 2;
}

function unionDateEvents(lists) {
  const out = [];
  const at = new Map();
  for (const list of lists) {
    const rows = Array.isArray(list) ? list : ((list && list.events) || []);
    for (const row of rows) {
      if (!row || !row.sport || row.eventId == null) continue;
      const id = `${row.sport}/${String(row.eventId)}`;
      const next = {
        sport: row.sport,
        eventId: String(row.eventId),
        homeTeam: row.homeTeam || null,
        awayTeam: row.awayTeam || null,
        commenceTime: row.commenceTime || null,
        close: !!row.close,
        open: !!row.open,
        baseline0300: !!row.baseline0300,
      };
      if (!at.has(id)) {
        at.set(id, out.length);
        out.push(next);
        continue;
      }
      const prev = out[at.get(id)];
      out[at.get(id)] = {
        sport: next.sport,
        eventId: next.eventId,
        homeTeam: next.homeTeam || prev.homeTeam,
        awayTeam: next.awayTeam || prev.awayTeam,
        commenceTime: next.commenceTime || prev.commenceTime,
        close: prev.close || next.close,
        open: prev.open || next.open,
        baseline0300: prev.baseline0300 || next.baseline0300,
      };
    }
  }
  return out;
}

function mergeDateBodies(key, bodies) {
  const docs = (bodies || []).filter((body) => body && typeof body === 'object' && !Array.isArray(body));
  if (!docs.length) return null;
  if (!isDateIndexKey(key)) return docs[0];
  const events = unionDateEvents(docs);
  const base = docs[0];
  return {
    schema: base.schema || DATE_SCHEMA,
    store: base.store || STORE,
    date: base.date || String(key).slice('by-date/'.length),
    events,
  };
}

function priceToken(book, market, timestamp) {
  return `${book}/${market}/${timestamp}`;
}

function apiMarket(market) {
  const m = String(market || '');
  if (m === 'h2h' || m === 'Moneyline') return 'h2h';
  if (m === 'spreads' || m === 'Spread') return 'spreads';
  if (m === 'totals' || m === 'Total') return 'totals';
  return m.toLowerCase();
}

function displayMarket(market) {
  const api = apiMarket(market);
  if (api === 'h2h') return 'Moneyline';
  if (api === 'spreads') return 'Spread';
  if (api === 'totals') return 'Total';
  return market;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function commenceEtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** True when commence_time falls on the ET calendar day before todayISO. DST-safe. */
function isPreviousEtDay(commenceISO, todayISO) {
  if (!commenceISO || !todayISO) return false;
  return commenceEtDate(commenceISO) === shiftYmd(todayISO, -1);
}

/**
 * Odds API historical `date` returns the snapshot at or before that instant.
 * A missing timestamp, or one after commence, is in-game or unproven. Reject it.
 */
function snapshotAtOrBefore(snapshotAt, commenceISO) {
  const snap = Date.parse(snapshotAt);
  const commence = Date.parse(commenceISO);
  if (!Number.isFinite(snap) || !Number.isFinite(commence)) return false;
  return snap <= commence;
}

function writeBlocked(opts) {
  if (opts && opts.dryRun) return 'dryRun';
  if (replayNoWrite(opts && opts.env)) return 'OMEGA_REPLAY_NO_WRITE';
  return null;
}

function assertPriceKey(key) {
  if (CARD_KEY.test(String(key || ''))) {
    throw new Error(`odds-master refused card key: ${key}`);
  }
}

function emptyIndex(sport, eventId, meta) {
  return {
    schema: INDEX_SCHEMA,
    store: STORE,
    sport,
    eventId: String(eventId),
    homeTeam: (meta && meta.homeTeam) || null,
    awayTeam: (meta && meta.awayTeam) || null,
    commenceTime: (meta && meta.commenceTime) || null,
    date: (meta && meta.date) || commenceEtDate(meta && meta.commenceTime) || null,
    prices: {},
    open: null,
    baseline0300: null,
    close: null,
    checks: {},
  };
}

function applyMeta(index, meta) {
  if (!meta) return index;
  if (meta.homeTeam) index.homeTeam = meta.homeTeam;
  if (meta.awayTeam) index.awayTeam = meta.awayTeam;
  if (meta.commenceTime) index.commenceTime = meta.commenceTime;
  if (meta.date) index.date = meta.date;
  else if (meta.commenceTime && !index.date) index.date = commenceEtDate(meta.commenceTime);
  return index;
}

function noteRole(index, role, timestamp, extra) {
  const at = timestamp || null;
  if (role === 'open' && !index.open) index.open = { at, book: 'pinnacle' };
  if (role === 'baseline-0300' && !index.baseline0300) index.baseline0300 = { at };
  if (role === 'close' && !index.close) {
    index.close = {
      at,
      snapshotAt: (extra && extra.snapshotAt) || at,
      book: 'pinnacle',
      pregame: true,
      source: (extra && extra.source) || null,
    };
  }
  const slot = role && String(role).startsWith('check-') ? String(role).slice(6) : null;
  if (slot) {
    index.checks = index.checks || {};
    if (!index.checks[slot]) index.checks[slot] = { at };
  }
  return index;
}

function quotesByMarket(quotes) {
  const out = {};
  for (const quote of Object.values(quotes || {})) {
    if (!quote) continue;
    const market = apiMarket(quote.market);
    if (!market) continue;
    if (!out[market]) out[market] = {};
    const side = quote.side || 'side';
    out[market][side] = {
      team: quote.team || null,
      price: quote.price,
      line: quote.line == null ? null : quote.line,
      noVig: quote.noVig == null ? null : quote.noVig,
    };
  }
  return out;
}

async function restGetBlob(url) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  const resp = await resolveFetch(fetch, { kind: 'blob', provider: 'netlify-blobs' })(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp || !resp.ok) return null;
  return await resp.json();
}

async function defaultRead(key) {
  assertPriceKey(key);
  // SDK key and canonical REST key are the same object. A REST write that
  // encodeURIComponent'd the whole key stored by-date%2F… beside by-date/….
  // Both are read and, for the date index, unioned. A null SDK get is not
  // proof the blob is missing. New writes use the canonical key only.
  const bodies = [];
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE);
    const got = await auditBlobCall('GET', `${STORE}/${key}`, () => store.get(key, { type: 'json' }));
    if (got != null) bodies.push(got);
  } catch (_) { /* REST below */ }
  const slash = blobHasSlash(key);
  const encodingsDiffer = legacyEncodedBlobKey(key) !== canonicalBlobKey(key);
  if (!bodies.length || (slash && encodingsDiffer && isDateIndexKey(key))) {
    try {
      if (!bodies.length) {
        const canon = await restGetBlob(blobRestUrl(SITE_ID, STORE, key, 'canonical'));
        if (canon) bodies.push(canon);
      }
      if (slash && encodingsDiffer) {
        const old = await restGetBlob(blobRestUrl(SITE_ID, STORE, key, 'legacy'));
        if (old) bodies.push(old);
      }
    } catch (_) { /* soft */ }
  }
  return mergeDateBodies(key, bodies);
}

async function defaultList(prefix) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(STORE);
  const listed = await store.list({ prefix: String(prefix || '') });
  const blobs = (listed && listed.blobs) || [];
  return blobs.map((blob) => (blob && blob.key) || blob).filter(Boolean);
}

async function defaultWrite(key, data) {
  assertPriceKey(key);
  if (replayNoWrite()) {
    logBlocked(`odds-master ${key}`);
    return false;
  }
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE);
    await auditBlobCall('PUT', `${STORE}/${key}`, () => store.setJSON(key, data));
    return true;
  } catch (sdkErr) {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw sdkErr;
    const url = blobRestUrl(SITE_ID, STORE, key, 'canonical');
    const resp = await resolveFetch(fetch, { kind: 'blob', provider: 'netlify-blobs' })(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!resp || !resp.ok) throw new Error(`blob PUT ${key} → ${resp && resp.status}`);
    return true;
  }
}

function reader(opts) {
  return (opts && opts.read) || defaultRead;
}

function writer(opts) {
  return (opts && opts.write) || defaultWrite;
}

async function markerRowsForDate(ymd, opts) {
  const list = (opts && opts.list) || ((opts && opts.read) ? null : defaultList);
  if (typeof list !== 'function') return [];
  const read = reader(opts);
  let keys = [];
  try {
    keys = await list(`by-date/${ymd}/event/`);
  } catch (err) {
    opsAlert('odds-date-index-list-failed', `date=${ymd} ${err && err.message}`);
    return [];
  }
  const rows = [];
  for (const key of keys || []) {
    let doc = null;
    try { doc = await read(key); } catch (_) { doc = null; }
    if (doc && doc.sport && doc.eventId != null) rows.push(doc);
  }
  return rows;
}

async function readMasterKey(key, opts) {
  try {
    const doc = await reader(opts)(key);
    if (!isDateIndexKey(key)) return doc;
    const ymd = String(key).slice('by-date/'.length);
    const markers = await markerRowsForDate(ymd, opts);
    if (!markers.length) return doc;
    const fromDoc = doc && Array.isArray(doc.events) ? doc.events : [];
    const events = unionDateEvents([fromDoc, markers]);
    if (events.length > fromDoc.length) {
      opsAlert('odds-date-index-short', `date=${ymd} index=${fromDoc.length} withMarkers=${events.length}`);
    }
    return {
      schema: (doc && doc.schema) || DATE_SCHEMA,
      store: STORE,
      date: (doc && doc.date) || ymd,
      events,
    };
  } catch (err) {
    console.error(`[odds-master] read soft-fail: ${err && err.message}`);
    opsAlert('odds-master-read-failed', `key=${key} ${err && err.message}`);
    return null;
  }
}

async function readIndex(sport, eventId, opts) {
  if (!sport || eventId == null) return null;
  try {
    const doc = await reader(opts)(indexKey(sport, eventId));
    if (!doc || doc.schema !== INDEX_SCHEMA) return null;
    return doc;
  } catch (err) {
    console.error(`[odds-master] index read soft-fail: ${err && err.message}`);
    return null;
  }
}

async function touchDateIndex(index, opts, write) {
  const ymd = index.date || commenceEtDate(index.commenceTime);
  if (!ymd) return { wrote: false, reason: 'no-date' };
  const markerKey = dateEventMarkerKey(ymd, index.sport, index.eventId);
  const row = {
    sport: index.sport,
    eventId: String(index.eventId),
    homeTeam: index.homeTeam || null,
    awayTeam: index.awayTeam || null,
    commenceTime: index.commenceTime || null,
    close: !!(index.close && index.close.at),
    open: !!(index.open && index.open.at),
    baseline0300: !!(index.baseline0300 && index.baseline0300.at),
  };
  try {
    await write(markerKey, {
      schema: DATE_SCHEMA,
      marker: true,
      store: STORE,
      date: ymd,
      ...row,
    });
  } catch (err) {
    opsAlert('odds-date-index-marker-failed', `date=${ymd} sport=${index.sport} event=${index.eventId} ${err && err.message}`);
  }
  const key = dateKey(ymd);
  let doc = null;
  let failed = false;
  try { doc = await reader(opts)(key); } catch (err) {
    failed = true;
    opsAlert('odds-date-index-read-failed', `date=${ymd} sport=${index.sport} event=${index.eventId} ${err && err.message}`);
  }
  if (failed) return { wrote: true, reason: 'marker-only', key: markerKey };
  const prev = doc && Array.isArray(doc.events) ? doc.events : [];
  const events = unionDateEvents([prev, [row]]);
  if (prev.length && events.length < prev.length) {
    opsAlert('odds-date-index-shrink-blocked', `date=${ymd} prev=${prev.length} next=${events.length}`);
    return { wrote: true, reason: 'shrink-blocked', key: markerKey };
  }
  const prevNorm = unionDateEvents([prev]);
  if (JSON.stringify(prevNorm) === JSON.stringify(events)) {
    return { wrote: false, reason: 'indexed', key };
  }
  await write(key, { schema: DATE_SCHEMA, store: STORE, date: ymd, events });
  return { wrote: true, reason: null, key };
}

/**
 * Write one price per market. The price blob is created once. A repeat of
 * the same sport/event/book/market/timestamp does not write the blob again.
 * Extra roles are recorded on the dedupe index.
 */
async function storeQuotes(input, opts = {}) {
  const sport = input && input.sport;
  const eventId = input && input.eventId != null ? String(input.eventId) : '';
  const book = String((input && input.book) || 'pinnacle').toLowerCase();
  const role = input && input.role;
  const timestamp = input && input.timestamp;
  if (!sport || !eventId || !role || !timestamp) {
    return { wrote: false, reason: 'incomplete', keys: [] };
  }
  const markets = quotesByMarket(input.quotes);
  const names = Object.keys(markets);
  if (!names.length) return { wrote: false, reason: 'no-quotes', keys: [] };
  const block = writeBlocked(opts);
  const read = reader(opts);
  const write = writer(opts);
  let index = null;
  let readFailed = false;
  try { index = await read(indexKey(sport, eventId)); } catch (err) {
    readFailed = true;
    opsAlert('odds-index-read-failed', `sport=${sport} event=${eventId} ${err && err.message}`);
  }
  if (readFailed) return { wrote: false, reason: 'read-failed', keys: [] };
  if (!index || index.schema !== INDEX_SCHEMA) index = emptyIndex(sport, eventId, input);
  else index = clone(index);
  applyMeta(index, input);
  const keys = [];
  let wrotePrice = false;
  let duplicate = false;
  for (const market of names) {
    const token = priceToken(book, market, timestamp);
    const key = priceKey(sport, eventId, book, market, timestamp);
    assertPriceKey(key);
    const seen = index.prices[token];
    if (seen) {
      duplicate = true;
      const roles = Array.isArray(seen.roles) ? seen.roles.slice() : [seen.role].filter(Boolean);
      if (!roles.includes(role)) roles.push(role);
      index.prices[token] = { role: seen.role || role, roles };
      keys.push(key);
      continue;
    }
    if (block) {
      keys.push(key);
      continue;
    }
    const doc = {
      schema: SCHEMA,
      store: STORE,
      appendOnly: true,
      role,
      roles: [role],
      sport,
      eventId,
      book,
      market,
      timestamp,
      homeTeam: input.homeTeam || null,
      awayTeam: input.awayTeam || null,
      commenceTime: input.commenceTime || null,
      snapshotAt: input.snapshotAt || null,
      requestedAt: input.requestedAt || null,
      pregame: role === 'close' ? snapshotAtOrBefore(input.snapshotAt || timestamp, input.commenceTime) : true,
      source: input.source || 'live',
      sides: markets[market],
    };
    await write(key, doc);
    index.prices[token] = { role, roles: [role] };
    wrotePrice = true;
    keys.push(key);
  }
  noteRole(index, role, timestamp, input);
  if (block) {
    if (block === 'OMEGA_REPLAY_NO_WRITE') logBlocked(`odds-master ${sport}/${eventId}`);
    return { wrote: false, reason: block, keys, index };
  }
  await write(indexKey(sport, eventId), index);
  await touchDateIndex(index, opts, write);
  if (!wrotePrice && duplicate) return { wrote: false, reason: 'duplicate', keys, index };
  return { wrote: wrotePrice, reason: null, keys, index };
}

function hasCloseIndex(index) {
  return !!(index && index.close && index.close.at);
}

async function hasStoredClose(sport, eventId, opts) {
  const index = await readIndex(sport, eventId, opts);
  return hasCloseIndex(index);
}

function sidesToOutcomes(market, sides, homeTeam, awayTeam) {
  const rows = [];
  const api = apiMarket(market);
  if (api === 'totals') {
    if (sides.over) rows.push({ name: 'Over', price: sides.over.price, point: sides.over.line });
    if (sides.under) rows.push({ name: 'Under', price: sides.under.price, point: sides.under.line });
    return rows;
  }
  if (sides.home) {
    const row = { name: sides.home.team || homeTeam, price: sides.home.price };
    if (api === 'spreads') row.point = sides.home.line;
    rows.push(row);
  }
  if (sides.away) {
    const row = { name: sides.away.team || awayTeam, price: sides.away.price };
    if (api === 'spreads') row.point = sides.away.line;
    rows.push(row);
  }
  return rows;
}

/** Odds API event built from stored close prices. CLV and candidate grading read this. */
async function readCloseEvent(query, opts = {}) {
  try {
    const sport = query && (query.sport === 'CFB' ? 'NCAAF' : query.sport);
    let eventId = query && (query.eventId || query.event_id);
    let index = eventId ? await readIndex(sport, eventId, opts) : null;
    if (!hasCloseIndex(index) && query && query.homeTeam && query.awayTeam && query.commenceTime) {
      const ymd = commenceEtDate(query.commenceTime);
      const dated = ymd ? await readMasterKey(dateKey(ymd), opts) : null;
      const events = dated && Array.isArray(dated.events) ? dated.events : [];
      const home = String(query.homeTeam).toLowerCase();
      const away = String(query.awayTeam).toLowerCase();
      const hit = events.find((row) => row && row.close && String(row.homeTeam || '').toLowerCase() === home
        && String(row.awayTeam || '').toLowerCase() === away
        && row.commenceTime === query.commenceTime
        && (!sport || row.sport === sport));
      if (hit) {
        eventId = hit.eventId;
        index = await readIndex(hit.sport, hit.eventId, opts);
      }
    }
    if (!hasCloseIndex(index)) return null;
    const markets = {};
    for (const [token, meta] of Object.entries(index.prices || {})) {
      const parts = String(token).split('/');
      if (parts.length < 3) continue;
      const [book, market, timestamp] = parts;
      if (book !== 'pinnacle') continue;
      if (timestamp !== index.close.at && timestamp !== index.close.snapshotAt) continue;
      const doc = await reader(opts)(priceKey(index.sport, index.eventId, book, market, timestamp));
      if (!doc || !doc.sides) continue;
      markets[market] = doc.sides;
    }
    if (!Object.keys(markets).length) return null;
    const bookmakers = [{
      key: 'pinnacle',
      title: 'Pinnacle',
      markets: Object.keys(markets).map((market) => ({
        key: market,
        outcomes: sidesToOutcomes(market, markets[market], index.homeTeam, index.awayTeam),
      })),
    }];
    return {
      sport: index.sport,
      eventId: index.eventId,
      snapshotAt: index.close.snapshotAt || index.close.at,
      source: index.close.source || 'odds-master',
      event: {
        id: index.eventId,
        home_team: index.homeTeam,
        away_team: index.awayTeam,
        commence_time: index.commenceTime,
        bookmakers,
      },
    };
  } catch (err) {
    console.error(`[odds-master] close read soft-fail: ${err && err.message}`);
    return null;
  }
}

function rowHasClose(row) {
  if (!row) return false;
  if (row.closeNoVig != null && Number.isFinite(Number(row.closeNoVig))) return true;
  return hasTrueClosingCapture(row);
}

function sameGame(row, game) {
  if (!row || !game) return false;
  if (row.eventId != null && game.eventId != null && String(row.eventId) === String(game.eventId)) return true;
  if (row.event_id != null && String(row.event_id) === String(game.eventId)) return true;
  const home = String(game.homeTeam || '').toLowerCase();
  const away = String(game.awayTeam || '').toLowerCase();
  if (!home || !away) return false;
  return String(row.homeTeam || '').toLowerCase() === home
    && String(row.awayTeam || '').toLowerCase() === away
    && row.commenceTime && game.commenceTime && row.commenceTime === game.commenceTime;
}

async function readEdgeBlob(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    return await auditBlobCall('GET', key, () => store.get(key, { type: 'json' }));
  } catch (_) {
    return null;
  }
}

function rowsOf(blob) {
  if (!blob) return [];
  if (Array.isArray(blob.candidates)) return blob.candidates;
  if (Array.isArray(blob.picks)) return blob.picks;
  if (Array.isArray(blob.sides)) return blob.sides;
  return [];
}

/** Candidate-close and CLV rows already on disk. A hit means do not re-pull. */
async function externalCloseRows(dateISO, opts = {}) {
  if (opts && typeof opts.readCandidateCloses === 'function') {
    try {
      const rows = await opts.readCandidateCloses(dateISO);
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }
  if (opts && opts.skipExternalCloses) return [];
  const out = [];
  const candidate = await readEdgeBlob(`clv-candidates-v2/${dateISO}`);
  const clv = await readEdgeBlob(`clv-${dateISO}`);
  out.push(...rowsOf(candidate), ...rowsOf(clv));
  return out;
}

async function closeAlreadyStored(game, opts = {}) {
  if (!game) return false;
  if (await hasStoredClose(game.sport, game.eventId, opts)) return true;
  if (typeof opts.closeStored === 'function') {
    try {
      if (await opts.closeStored(game)) return true;
    } catch (_) { /* caller hook is best-effort */ }
  }
  const ymd = commenceEtDate(game.commenceTime);
  if (!ymd) return false;
  const rows = await externalCloseRows(ymd, opts);
  return rows.some((row) => rowHasClose(row) && sameGame(row, game));
}

/**
 * One historical response → close prices for the games in that kickoff group.
 * snapshotAt must be <= commence. Other events in the payload are ignored.
 */
async function storeHistoricalCloses(group, payload, opts = {}) {
  const snapshotAt = payload && payload.snapshotAt;
  const commence = group && group.commenceTime;
  if (!snapshotAtOrBefore(snapshotAt, commence)) {
    const rejected = (group && group.games || []).length;
    opsAlert('close-snapshot-after-commence', `sport=${group && group.sport} commence=${commence} snapshot=${snapshotAt} rejected=${rejected}`);
    return { stored: 0, rejected, reason: 'snapshot-after-commence' };
  }
  const byId = new Map();
  for (const event of payload.events || []) {
    if (event && event.id != null) byId.set(String(event.id), event);
  }
  let stored = 0;
  const missed = [];
  for (const game of group.games || []) {
    const event = byId.get(String(game.eventId));
    if (!event) {
      missed.push(game.eventId);
      continue;
    }
    const quotes = quotesFromEvent(event, game.sport, { at: snapshotAt, book: 'pinnacle' }, 'pinnacle');
    const saved = await storeQuotes({
      sport: game.sport,
      eventId: game.eventId,
      book: 'pinnacle',
      role: 'close',
      timestamp: snapshotAt,
      quotes,
      homeTeam: event.home_team || game.homeTeam || null,
      awayTeam: event.away_team || game.awayTeam || null,
      commenceTime: event.commence_time || game.commenceTime,
      snapshotAt,
      requestedAt: commence,
      source: 'historical',
    }, opts);
    if (saved.reason === 'dryRun' || saved.reason === 'OMEGA_REPLAY_NO_WRITE') stored += 1;
    else if (saved.wrote || saved.reason === 'duplicate') stored += 1;
  }
  if (missed.length) {
    opsAlert('close-event-missed', `sport=${group && group.sport} commence=${commence} missed=${missed.length}`);
  }
  return { stored, rejected: 0, missed, reason: null };
}

/** Live or historical Odds API event → pinnacle close rows. No card write. */
async function storeCloseFromOddsEvent(event, info = {}, opts = {}) {
  if (!event || event.id == null) return { wrote: false, reason: 'no-event' };
  const sport = info.sport;
  const snapshotAt = info.snapshotAt || info.requestedAt || null;
  const commence = event.commence_time || info.commenceTime || null;
  if (!snapshotAtOrBefore(snapshotAt, commence)) return { wrote: false, reason: 'snapshot-after-commence' };
  const quotes = quotesFromEvent(event, sport, { at: snapshotAt, book: 'pinnacle' }, 'pinnacle');
  return storeQuotes({
    sport,
    eventId: event.id,
    book: 'pinnacle',
    role: 'close',
    timestamp: snapshotAt,
    quotes,
    homeTeam: event.home_team || null,
    awayTeam: event.away_team || null,
    commenceTime: commence,
    snapshotAt,
    requestedAt: info.requestedAt || snapshotAt,
    source: info.source || 'historical',
  }, opts);
}

function groupByCommence(games) {
  const map = new Map();
  for (const game of games || []) {
    if (!game || !game.commenceTime || !game.sport) continue;
    const sportKey = game.sportKey || ODDS_SPORT_KEYS[game.sport] || null;
    if (!sportKey) continue;
    const id = `${game.sport}|${game.commenceTime}`;
    if (!map.has(id)) {
      map.set(id, {
        id,
        sport: game.sport,
        sportKey,
        commenceTime: game.commenceTime,
        games: [],
      });
    }
    map.get(id).games.push(game);
  }
  return [...map.values()].sort((a, b) => (a.commenceTime < b.commenceTime ? -1 : a.commenceTime > b.commenceTime ? 1 : 0));
}

/**
 * CLV KPIs from a clv-candidates-v2 blob already on disk.
 * Read-only. Does not grade closes and does not write.
 */
function clvKpisFromCandidateBlob(blob, opts) {
  const ledger = require('../clv-ledger');
  const kpis = ledger.clvKpis(ledger.rowsFromCandidateBlob(blob, opts));
  kpis.source = 'clv-candidates-v2';
  kpis.readOnly = true;
  return kpis;
}

/**
 * Read clv-candidates-v2/{date} and return per-pick, per-candidate, and
 * per-sport CLV. Pass opts.readJson to avoid a store read. Never writes.
 */
async function clvKpisForDate(dateISO, opts = {}) {
  const read = opts && typeof opts.readJson === 'function' ? opts.readJson : readEdgeBlob;
  let blob = null;
  try {
    blob = await read(`clv-candidates-v2/${dateISO}`);
  } catch (_) {
    blob = null;
  }
  return clvKpisFromCandidateBlob(blob, { date: dateISO });
}

function sportKeyForLabel(sport) {
  if (!sport) return null;
  if (sport === 'CFB') return ODDS_SPORT_KEYS.NCAAF || null;
  return ODDS_SPORT_KEYS[sport] || null;
}

module.exports = {
  STORE,
  SCHEMA,
  INDEX_SCHEMA,
  DATE_SCHEMA,
  HISTORICAL_CREDITS_PER_PULL,
  EARLY_REUSE_MS,
  historicalCreditsPerPull,
  earlyReuseMs,
  priceKey,
  indexKey,
  dateKey,
  dateEventMarkerKey,
  isDateIndexKey,
  unionDateEvents,
  apiMarket,
  displayMarket,
  commenceEtDate,
  shiftYmd,
  isPreviousEtDay,
  snapshotAtOrBefore,
  quotesByMarket,
  storeQuotes,
  readMasterKey,
  readIndex,
  hasStoredClose,
  readCloseEvent,
  closeAlreadyStored,
  externalCloseRows,
  clvKpisFromCandidateBlob,
  clvKpisForDate,
  storeHistoricalCloses,
  storeCloseFromOddsEvent,
  groupByCommence,
  rowHasClose,
  sameGame,
  sportKeyForLabel,
  writeBlocked,
};
