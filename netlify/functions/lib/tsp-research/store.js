'use strict';

const { SITE_ID, BLOB_STORE } = require('./config');

async function blobFetch(path, { method = 'GET', body } = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${BLOB_STORE}/${path}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(url, opts);
}

async function storeJson(key, data) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: BLOB_STORE, siteID: SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
    await store.setJSON(key, data);
    console.log(`[tsp-research/store] wrote ${key}`);
    return true;
  } catch (e) {
    console.error(`[tsp-research/store] SDK ${key}: ${e.message} — REST`);
  }
  const resp = await blobFetch(key, { method: 'PUT', body: data });
  if (!resp.ok) throw new Error(`blob PUT ${key} → ${resp.status}`);
  console.log(`[tsp-research/store] REST wrote ${key}`);
  return true;
}

async function readJson(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: BLOB_STORE, siteID: SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
    return await store.get(key, { type: 'json' });
  } catch (_) {
    try {
      const resp = await blobFetch(key);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    }
  }
}

/** Guard: refuse any key that looks like Omega live picks/config. */
function assertResearchKey(key) {
  const k = String(key || '');
  if (/^picks-|edge-picks-omega|omega-live|latest-date|picks-dates/.test(k)) {
    throw new Error(`tsp-research refused Omega live key: ${k}`);
  }
}

async function storeSnapshot(dateISO, snapshot) {
  assertResearchKey(`snapshots/${dateISO}`);
  await storeJson(`snapshots/${dateISO}`, snapshot);
  await storeJson('snapshots/latest', snapshot);
  return `snapshots/${dateISO}`;
}

async function storeDigest(dateISO, digest) {
  assertResearchKey(`digests/${dateISO}`);
  await storeJson(`digests/${dateISO}`, digest);
  await storeJson('digests/latest', digest);
  return `digests/${dateISO}`;
}

async function storeManualImport(name, payload) {
  const safe = String(name || 'import').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const key = `manual/${safe}`;
  assertResearchKey(key);
  await storeJson(key, payload);
  return key;
}

module.exports = {
  storeJson,
  readJson,
  storeSnapshot,
  storeDigest,
  storeManualImport,
  assertResearchKey,
  BLOB_STORE,
};
