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
  const resp = await fetch(url, opts);
  return resp;
}

async function readPicks(dateISO) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    return await store.get(`picks-${dateISO}`, { type: 'json' });
  } catch (_) {
    try {
      const resp = await blobFetch(`picks-${dateISO}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  }
}

async function storePicks(dateISO, picksData, { force = false, simMode = false } = {}) {
  const pickKey = simMode ? `picks-sim-${dateISO}` : `picks-${dateISO}`;

  if (!simMode && !force) {
    const existing = await readPicks(dateISO);
    if (existing && Array.isArray(existing.picks) && existing.picks.length > 0) {
      const err = new Error(`REFUSING overwrite: picks-${dateISO} already has ${existing.picks.length} picks. Pass force:true to override.`);
      err.code = 'OVERWRITE_GUARD';
      throw err;
    }
  }

  // Prefer SDK
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    await store.setJSON(pickKey, picksData);
    if (!simMode) {
      await store.set('latest-date', dateISO);
      try {
        let dates = await store.get('picks-dates', { type: 'json' });
        if (!Array.isArray(dates)) dates = [];
        if (!dates.includes(dateISO)) {
          dates.push(dateISO);
          dates.sort();
          await store.setJSON('picks-dates', dates);
        }
      } catch (e) {
        console.error(`[omega-vnext/store] picks-dates: ${e.message}`);
      }
    }
    console.log(`[omega-vnext/store] wrote ${pickKey} (${(picksData.picks || []).length} picks)`);
    return true;
  } catch (sdkErr) {
    console.error(`[omega-vnext/store] SDK failed: ${sdkErr.message} — trying REST`);
  }

  const resp = await blobFetch(pickKey, { method: 'PUT', body: picksData });
  if (!resp.ok) throw new Error(`blob PUT ${pickKey} → ${resp.status}`);
  if (!simMode) {
    await blobFetch('latest-date', { method: 'PUT', body: JSON.stringify(dateISO) });
    try {
      const dResp = await blobFetch('picks-dates');
      let dates = dResp.ok ? await dResp.json() : [];
      if (!Array.isArray(dates)) dates = [];
      if (!dates.includes(dateISO)) {
        dates.push(dateISO);
        dates.sort();
        await blobFetch('picks-dates', { method: 'PUT', body: dates });
      }
    } catch (e) {
      console.error(`[omega-vnext/store] picks-dates REST: ${e.message}`);
    }
  }
  console.log(`[omega-vnext/store] REST wrote ${pickKey}`);
  return true;
}

module.exports = { storePicks, readPicks };
