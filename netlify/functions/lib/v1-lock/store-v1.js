'use strict';
/**
 * V1 storage — its OWN blob store (edge-picks-v1lock) and its OWN keys
 * (picks-v1-{date}, latest-date, picks-dates inside that store).
 * Omega's store (edge-picks-omega) is touched READ-ONLY for the stored
 * board, via the shared blob helpers' store. No Omega key is ever written.
 */
const { BLOB_STORE_V1, OMEGA_BOARD_STORE } = require('./config-v1');
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
async function getStoreV1(name) {
  const { getStore } = await import('@netlify/blobs');
  const token = process.env.NETLIFY_AUTH_TOKEN;
  // Background runtimes may lack automatic Blobs context (same failure
  // Omega logs); supply manual config when a token is available.
  try { return token ? getStore({ name, siteID: SITE_ID, token }) : getStore(name); }
  catch (_) { return getStore(name); }
}
async function restFetch(storeName, key, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${storeName}/${key}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20000);
  try { return await fetch(url, { method: opts.method || 'GET', signal: ctrl.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined }); }
  finally { clearTimeout(timer); }
}
async function readJsonFromStore(storeName, key) {
  try { const s = await getStoreV1(storeName); const v = await s.get(key, { type: 'json' }); if (v != null) return v; } catch (_) {}
  try { const r = await restFetch(storeName, key); if (!r.ok) return null; return await r.json(); } catch (_) { return null; }
}
async function writeJsonToStore(storeName, key, data) {
  try { const s = await getStoreV1(storeName); await s.setJSON(key, data); return true; } catch (_) {}
  const r = await restFetch(storeName, key, { method: 'PUT', body: data });
  if (!r.ok) throw new Error(`blob PUT ${storeName}/${key} -> ${r.status}`);
  return true;
}
/** READ-ONLY: stored morning board from Omega's capture store. */
async function readStoredBoardV1(dateISO) {
  return readJsonFromStore(OMEGA_BOARD_STORE, `omega-line-path/${dateISO}`);
}
async function storeCardV1(dateISO, card) {
  await writeJsonToStore(BLOB_STORE_V1, `picks-v1-${dateISO}`, card);
  try { const s = await getStoreV1(BLOB_STORE_V1); await s.set('latest-date', dateISO); } catch (_) {
    try { await restFetch(BLOB_STORE_V1, 'latest-date', { method: 'PUT', body: JSON.stringify(dateISO) }); } catch (_) {}
  }
  try {
    let dates = await readJsonFromStore(BLOB_STORE_V1, 'picks-dates');
    if (!Array.isArray(dates)) dates = [];
    if (!dates.includes(dateISO)) { dates.push(dateISO); dates.sort(); await writeJsonToStore(BLOB_STORE_V1, 'picks-dates', dates); }
  } catch (_) {}
  return `picks-v1-${dateISO}`;
}
async function readCardV1(dateISO) { return readJsonFromStore(BLOB_STORE_V1, `picks-v1-${dateISO}`); }
module.exports = { readStoredBoardV1, storeCardV1, readCardV1, readJsonFromStore, writeJsonToStore };
