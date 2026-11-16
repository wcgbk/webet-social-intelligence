'use strict';

/**
 * Copy the current main card onto the v1 picks blob after a successful
 * main write. Keeps every other field on an existing v1 doc. Replaces
 * picks, parlayLegs, summary, shortCard, edgeSummary, and meta.
 * OMEGA_V1_SYNC_MAIN defaults on. Unset stays on. on/1/true/yes are on.
 * off/0/false/blank are off (=off rolls back). Errors are logged and
 * never thrown. OMEGA_REPLAY_NO_WRITE does not touch the v1 blob.
 * This module does not write edge-picks-omega. Callers lock the main card
 * (11:00 ET, OMEGA_CARD_LOCK_11AM) before they pass mainDoc here, so the
 * v1 mirror copies the locked picks, legs, prices, and stakes.
 */
const { replayNoWrite } = require('../omega-vnext/no_write');

const V1_STORE = 'edge-picks-omega-v1ab';
const V1_SYNC_FLAG = 'OMEGA_V1_SYNC_MAIN';
const V1_SYNC_FIELDS = Object.freeze([
  'picks',
  'parlayLegs',
  'summary',
  'shortCard',
  'edgeSummary',
  'meta',
]);

function v1SyncMainEnabled(env) {
  const source = env == null ? process.env : env;
  if (source == null || source[V1_SYNC_FLAG] == null) return true;
  const v = String(source[V1_SYNC_FLAG]).trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === '') return false;
  return false;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Missing v1 doc → full clone of the main doc.
 * Existing v1 doc → same other fields, six card fields replaced.
 * A key missing on the main doc is removed so a stale value cannot linger.
 * null is kept.
 */
function cardForV1(existing, main) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return jsonClone(main);
  }
  const out = jsonClone(existing);
  for (const field of V1_SYNC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(main, field) || main[field] === undefined) {
      delete out[field];
    } else {
      out[field] = jsonClone(main[field]);
    }
  }
  return out;
}

async function maintainPicksDates(store, dateISO) {
  try {
    let dates = await store.getJSON('picks-dates');
    if (!Array.isArray(dates)) dates = [];
    else dates = dates.slice();
    if (!dates.includes(dateISO)) {
      dates.push(dateISO);
      dates.sort();
      await store.setJSON('picks-dates', dates);
    }
  } catch (e) {
    console.error(`[v1-sync] picks-dates: ${e && e.message ? e.message : e}`);
  }
}

/**
 * Read-modify-write picks-{date} on the v1 store. Also adds the date to
 * picks-dates when that list is readable. Does not move latest-date.
 * Never throws.
 */
async function syncMainCardToV1(dateISO, mainDoc, opts) {
  const options = opts || {};
  try {
    if (!v1SyncMainEnabled(options.env)) return { synced: false, reason: 'flag-off' };
    if (replayNoWrite(options.env)) return { synced: false, reason: 'replay-no-write' };
    const date = String(dateISO || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { synced: false, reason: 'bad-date' };
    if (!mainDoc || typeof mainDoc !== 'object' || Array.isArray(mainDoc)) {
      return { synced: false, reason: 'bad-doc' };
    }
    const blobStore = options.store || require('./blob').store(V1_STORE);
    const key = `picks-${date}`;
    let existing = null;
    try {
      existing = await blobStore.getJSON(key);
    } catch (e) {
      console.error(`[v1-sync] read ${key}: ${e && e.message ? e.message : e}`);
      return { synced: false, reason: 'read-failed' };
    }
    const next = cardForV1(existing, mainDoc);
    await blobStore.setJSON(key, next);
    await maintainPicksDates(blobStore, date);
    return { synced: true, created: !existing || typeof existing !== 'object' || Array.isArray(existing) };
  } catch (e) {
    console.error(`[v1-sync] ${e && e.message ? e.message : e}`);
    return { synced: false, reason: 'error' };
  }
}

module.exports = {
  V1_STORE,
  V1_SYNC_FIELDS,
  v1SyncMainEnabled,
  cardForV1,
  syncMainCardToV1,
};
