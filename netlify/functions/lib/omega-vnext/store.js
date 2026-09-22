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


async function storeJson(key, data) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    await store.setJSON(key, data);
    console.log(`[omega-vnext/store] wrote ${key}`);
    return true;
  } catch (sdkErr) {
    console.error(`[omega-vnext/store] SDK setJSON ${key}: ${sdkErr.message} — REST`);
  }
  const resp = await blobFetch(key, { method: 'PUT', body: data });
  if (!resp.ok) throw new Error(`blob PUT ${key} → ${resp.status}`);
  console.log(`[omega-vnext/store] REST wrote ${key}`);
  return true;
}

async function readJson(key) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    return await store.get(key, { type: 'json' });
  } catch (_) {
    try {
      const resp = await blobFetch(key);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  }
}

/** Observer-only PM sidecar. Keys: omega-pm-observer/{date} + alias pm-sidecar-{date}. */
async function storePmObserver(dateISO, artifact) {
  const primary = `omega-pm-observer/${dateISO}`;
  const alias = `pm-sidecar-${dateISO}`;
  await storeJson(primary, artifact);
  try { await storeJson(alias, artifact); } catch (e) {
    console.error(`[omega-vnext/store] pm alias ${alias}: ${e.message}`);
  }
  return primary;
}

async function readPmObserver(dateISO) {
  return (await readJson(`omega-pm-observer/${dateISO}`))
    || (await readJson(`pm-sidecar-${dateISO}`));
}


/** Walk-forward observer keys only — never live picks / fit blobs. */
const { WALKFORWARD_KEY_RE, LIVE_KEY_RE, assertWalkforwardKey: assertWfKey } = (() => {
  try { return require('./walk_forward'); }
  catch (_) {
    return {
      WALKFORWARD_KEY_RE: /^omega-walkforward\/(?:samples\/\d{4}-\d{2}-\d{2}|reports\/(?:\d{4}-\d{2}-\d{2}|latest)|priors-offline)$/,
      LIVE_KEY_RE: /^(?:picks-\d{4}-\d{2}-\d{2}|picks-sim-|latest-date|picks-dates|self-optimize-params)/,
      assertWalkforwardKey: null,
    };
  }
})();

function assertWalkforwardKey(key) {
  if (typeof assertWfKey === 'function') return assertWfKey(key);
  const k = String(key || '');
  if (LIVE_KEY_RE.test(k) || k.includes('self-optimize-params') || k.startsWith('omega-walkforward/fit')) {
    throw new Error(`omega-walkforward refused live key: ${k}`);
  }
  if (!WALKFORWARD_KEY_RE.test(k)) {
    throw new Error(`omega-walkforward refused key: ${k}`);
  }
  return k;
}

function refuseFitPayload(label, payload) {
  if (payload && payload.fitApplied === true) {
    throw new Error(`omega-walkforward refused ${label}: fitApplied`);
  }
  if (payload && payload.appliedToCalibrate === true) {
    throw new Error(`omega-walkforward refused ${label}: appliedToCalibrate`);
  }
  if (payload && payload.coefficients != null) {
    throw new Error(`omega-walkforward refused ${label}: coefficients present`);
  }
}

async function storeWalkforwardSamples(dateISO, samplesBlob) {
  const key = assertWalkforwardKey(`omega-walkforward/samples/${dateISO}`);
  refuseFitPayload('samples', samplesBlob);
  await storeJson(key, samplesBlob);
  return key;
}

async function storeWalkforwardReport(dateISO, report) {
  const key = assertWalkforwardKey(`omega-walkforward/reports/${dateISO}`);
  refuseFitPayload('report', report);
  await storeJson(key, report);
  try {
    await storeJson(assertWalkforwardKey('omega-walkforward/reports/latest'), report);
  } catch (e) {
    console.error(`[omega-vnext/store] walkforward report latest: ${e.message}`);
  }
  return key;
}

async function storeWalkforwardPriorsOffline(priors) {
  const key = assertWalkforwardKey('omega-walkforward/priors-offline');
  refuseFitPayload('priors-offline', priors);
  await storeJson(key, priors);
  return key;
}

module.exports = {
  storePicks, readPicks, storeJson, readJson, storePmObserver, readPmObserver,
  WALKFORWARD_KEY_RE, assertWalkforwardKey,
  storeWalkforwardSamples, storeWalkforwardReport, storeWalkforwardPriorsOffline,
};

