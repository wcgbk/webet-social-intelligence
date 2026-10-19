'use strict';
/** odds-master shared blob I/O (store: odds-master).
 *  Same access pattern as v1-lock/store-v1: @netlify/blobs SDK first
 *  (statically required so the bundler traces it), REST fallback with
 *  canonical per-segment key encoding. Used by the 3AM/10AM pull writer
 *  and by both models' board readers. No Odds API calls here. */
let blobsPkg = null;
try { blobsPkg = require('@netlify/blobs'); } catch (_) { blobsPkg = null; }
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const MASTER_STORE = 'odds-master';
async function getStore(name) {
  const pkg = blobsPkg || await import('@netlify/blobs');
  return pkg.getStore(name);
}
async function restFetch(storeName, key, opts = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const encKey = String(key).split('/').map(encodeURIComponent).join('/');
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${storeName}/${encKey}`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20000);
  try { return await fetch(url, { method: opts.method || 'GET', signal: ctrl.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined }); }
  finally { clearTimeout(timer); }
}
async function readJson(key, storeName = MASTER_STORE) {
  try { const s = await getStore(storeName); const v = await s.get(key, { type: 'json' }); if (v != null) return v; } catch (_) {}
  try { const r = await restFetch(storeName, key); if (!r.ok) return null; return await r.json(); } catch (_) { return null; }
}
async function writeJson(key, data, storeName = MASTER_STORE) {
  try { const s = await getStore(storeName); await s.setJSON(key, data); return true; } catch (_) {}
  const r = await restFetch(storeName, key, { method: 'PUT', body: data });
  if (!r.ok) throw new Error(`blob PUT ${storeName}/${key} -> ${r.status}`);
  return true;
}
module.exports = { readJson, writeJson, MASTER_STORE, SITE_ID };
