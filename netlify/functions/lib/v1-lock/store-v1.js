'use strict';
/**
 * V1 storage — its OWN blob store (edge-picks-v1lock) and its OWN keys
 * (picks-v1-{date}, latest-date, picks-dates inside that store).
 * Omega's store (edge-picks-omega) is touched READ-ONLY for the stored
 * board, via the shared blob helpers' store. No Omega key is ever written.
 */
const { BLOB_STORE_V1, OMEGA_BOARD_STORE } = require('./config-v1');
// Static require so the Netlify bundler traces @netlify/blobs into every
// V1 function zip (dynamic import alone was not bundled, so SDK reads
// silently fell through to REST, which cannot see line-path snaps).
let blobsPkg = null;
try { blobsPkg = require('@netlify/blobs'); } catch (_) { blobsPkg = null; }
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
async function getStoreV1(name) {
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
  const path = await readJsonFromStore(OMEGA_BOARD_STORE, `omega-line-path/${dateISO}`);
  if (path && Array.isArray(path.polls) && path.polls.length) {
    // 3 AM feed for V1: merge the odds-master baseline-0300 Hard Rock line
    // as openBooks (opening read for Filter 4), even when the board itself
    // comes from the Omega 0600/0730/0900/0915 line-path. Read-only, no
    // Odds pull. If odds-master has no 0300 for the date, openBooks stays
    // unset and index-v1 falls back to the earliest line-path poll (0600).
    try {
      const { reconstructBoardFromMasterV1 } = require('./board-master-v1');
      const master = await reconstructBoardFromMasterV1((st, k) => readJsonFromStore(st, k), dateISO);
      if (master && master.polls && master.polls.length) {
        const mgames = (master.polls[0] && master.polls[0].games) || {};
        let merged = 0;
        for (const poll of path.polls) {
          for (const [key, g] of Object.entries(poll.games || {})) {
            if (!g || g.openBooks) continue;
            const mg = mgames[key] || mgames[`${g.awayTeam} @ ${g.homeTeam}`];
            if (!mg) continue;
            const open = mg.openBooks || (String(master.polls[0].hhmm) === '0300' ? mg.books : null);
            if (open) { g.openBooks = open; merged++; }
          }
        }
        if (merged) { path.openSource = 'odds-master-baseline-0300'; path.openGamesMerged = merged; }
      }
    } catch (_) {}
    return path;
  }
  // Era morning snaps were suspended 2026-10-13..18 by the pre-reset pipeline;
  // its morning pulls live in odds-master (03:00 / 10:00 ET). Rebuild the
  // stored board from those genuine stored lines (board-master-v1).
  try {
    const { reconstructBoardFromMasterV1 } = require('./board-master-v1');
    const master = await reconstructBoardFromMasterV1((s, k) => readJsonFromStore(s, k), dateISO);
    if (master && master.polls && master.polls.length) return master;
  } catch (_) {}
  // Fallback mirroring Omega loadLinePath: per-slot snap keys (no slash).
  const polls = [];
  for (const hhmm of ['0300','0600','0730','0900','0915','1000','1030','1100']) {
    const snap = await readJsonFromStore(OMEGA_BOARD_STORE, `omega-line-snap-${dateISO}-${hhmm}`);
    if (snap && snap.games && Object.keys(snap.games).length) polls.push({ hhmm, slot: snap.slot || hhmm, capturedAt: snap.capturedAt || null, games: snap.games });
  }
  if (polls.length) return { date: dateISO, polls };
  return path;
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
