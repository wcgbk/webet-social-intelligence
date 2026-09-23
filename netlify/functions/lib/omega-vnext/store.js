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

/**
 * Where a card write is allowed to go.
 * shadow:true → omega-shadow/picks-{date} only. Never latest-date, picks-dates,
 * live picks-{date}, or OVERWRITE_GUARD. See docs/OMEGA-SHADOW-DRYRUN.md.
 */
function resolvePicksStoreTarget(dateISO, { simMode = false, shadow = false } = {}) {
  if (shadow) {
    return {
      key: `omega-shadow/picks-${dateISO}`,
      touchLatestDate: false,
      touchPicksDates: false,
      overwriteGuard: false,
      shadow: true,
    };
  }
  if (simMode) {
    return {
      key: `picks-sim-${dateISO}`,
      touchLatestDate: false,
      touchPicksDates: false,
      overwriteGuard: false,
      shadow: false,
    };
  }
  return {
    key: `picks-${dateISO}`,
    touchLatestDate: true,
    touchPicksDates: true,
    overwriteGuard: true,
    shadow: false,
  };
}

function shadowPayload(dateISO, picksData, key) {
  return {
    ...(picksData || {}),
    shadow: true,
    storeKey: key,
    date: (picksData && picksData.date) || dateISO,
  };
}

async function storePicks(dateISO, picksData, opts = {}) {
  const force = !!opts.force;
  // A shadow-marked payload must not fall through onto live keys.
  const shadow = opts.shadow === true || !!(picksData && picksData.shadow === true);
  const simMode = shadow ? false : !!opts.simMode;
  const target = resolvePicksStoreTarget(dateISO, { simMode, shadow });
  const pickKey = target.key;
  if (target.shadow && !String(pickKey).startsWith('omega-shadow/')) {
    throw new Error(`shadow store refused non-shadow key: ${pickKey}`);
  }
  const payload = target.shadow ? shadowPayload(dateISO, picksData, pickKey) : picksData;

  if (target.overwriteGuard && !force) {
    const existing = await readPicks(dateISO);
    if (existing && Array.isArray(existing.picks) && existing.picks.length > 0) {
      const err = new Error(`REFUSING overwrite: picks-${dateISO} already has ${existing.picks.length} picks. Pass force:true to override.`);
      err.code = 'OVERWRITE_GUARD';
      throw err;
    }
  }

  // Prefer SDK. Shadow returns before any latest-date / picks-dates write.
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);
    await store.setJSON(pickKey, payload);
    if (target.touchLatestDate) {
      await store.set('latest-date', dateISO);
    }
    if (target.touchPicksDates) {
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
    console.log(`[omega-vnext/store] wrote ${pickKey} (${(payload.picks || []).length} picks)${target.shadow ? ' shadow' : ''}`);
    return true;
  } catch (sdkErr) {
    console.error(`[omega-vnext/store] SDK failed: ${sdkErr.message} — trying REST`);
  }

  const resp = await blobFetch(pickKey, { method: 'PUT', body: payload });
  if (!resp.ok) throw new Error(`blob PUT ${pickKey} → ${resp.status}`);
  if (target.touchLatestDate) {
    await blobFetch('latest-date', { method: 'PUT', body: JSON.stringify(dateISO) });
  }
  if (target.touchPicksDates) {
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
  console.log(`[omega-vnext/store] REST wrote ${pickKey}${target.shadow ? ' shadow' : ''}`);
  return true;
}

/** Isolated shadow card. Does not touch live picks, latest-date, or picks-dates. */
async function storeShadowPicks(dateISO, picksData) {
  return storePicks(dateISO, picksData, { shadow: true, force: true });
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

function assertPmDate(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`pm-observer refused bad date: ${dateISO}`);
  }
  return d;
}

/** post → omega-pm-observer/{date}; open → omega-pm-observer/{date}-open. */
function pmObserverStorageKey(dateISO, slot) {
  const d = assertPmDate(dateISO);
  if (slot === 'open') return `omega-pm-observer/${d}-open`;
  if (slot && slot !== 'post') throw new Error(`pm-observer refused slot: ${slot}`);
  return `omega-pm-observer/${d}`;
}

function pmObserverAliasKey(dateISO, slot) {
  const d = assertPmDate(dateISO);
  if (slot === 'open') return `pm-sidecar-${d}-open`;
  if (slot && slot !== 'post') throw new Error(`pm-observer refused slot: ${slot}`);
  return `pm-sidecar-${d}`;
}

/** Observer audit. Keys: omega-pm-observer/{date} + alias pm-sidecar-{date}. */
async function storePmObserver(dateISO, artifact) {
  const primary = pmObserverStorageKey(dateISO, 'post');
  const alias = pmObserverAliasKey(dateISO, 'post');
  await storeJson(primary, artifact);
  try { await storeJson(alias, artifact); } catch (e) {
    console.error(`[omega-vnext/store] pm alias ${alias}: ${e.message}`);
  }
  return primary;
}

/**
 * Morning open snap for pmMove. Does not touch the post-card audit key
 * or the live picks card.
 */
async function storePmObserverOpen(dateISO, artifact) {
  const primary = pmObserverStorageKey(dateISO, 'open');
  const alias = pmObserverAliasKey(dateISO, 'open');
  const payload = { ...(artifact || {}), slot: 'open', date: assertPmDate(dateISO) };
  await storeJson(primary, payload);
  try { await storeJson(alias, payload); } catch (e) {
    console.error(`[omega-vnext/store] pm open alias ${alias}: ${e.message}`);
  }
  return primary;
}

async function readPmObserver(dateISO) {
  return (await readJson(`omega-pm-observer/${dateISO}`))
    || (await readJson(`pm-sidecar-${dateISO}`));
}

/** Prior open snap. Null on a bad date or a missing blob. Never throws. */
async function readPmObserverOpen(dateISO) {
  let primary;
  let alias;
  try {
    primary = pmObserverStorageKey(dateISO, 'open');
    alias = pmObserverAliasKey(dateISO, 'open');
  } catch (_) {
    return null;
  }
  try {
    return (await readJson(primary)) || (await readJson(alias));
  } catch (e) {
    console.warn(`[omega-vnext/store] pm open read soft-fail: ${e.message}`);
    return null;
  }
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

/** Historical replay eval store — NEVER live picks-{date} / latest-date. */
const REPLAY_KEY_RE = /^omega-replay\/[A-Za-z0-9._-]+\/(?:picks-\d{4}-\d{2}-\d{2}|summary|meta)$/;

function assertReplayKey(key) {
  const k = String(key || '');
  if (/^(?:picks-\d{4}-\d{2}-\d{2}|latest-date|picks-dates|picks-sim-)/.test(k)) {
    throw new Error(`omega-replay refused live key: ${k}`);
  }
  if (!REPLAY_KEY_RE.test(k)) {
    throw new Error(`omega-replay refused key: ${k}`);
  }
  return k;
}

async function storeReplayCard(runId, dateISO, picksData) {
  const safeRun = String(runId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  if (!safeRun) throw new Error('omega-replay refused empty runId');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) {
    throw new Error(`omega-replay refused bad date: ${dateISO}`);
  }
  const key = assertReplayKey(`omega-replay/${safeRun}/picks-${dateISO}`);
  const payload = {
    ...(picksData || {}),
    replay: true,
    evalStore: true,
    runId: safeRun,
    isolation: { neverWrites: ['picks-{date}', 'latest-date', 'picks-dates'] },
  };
  await storeJson(key, payload);
  return key;
}

async function storeReplaySummary(runId, summary) {
  const safeRun = String(runId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const key = assertReplayKey(`omega-replay/${safeRun}/summary`);
  await storeJson(key, summary);
  return key;
}

/** Ops-only capture-health snapshots — NEVER live picks / latest-date. */
const OPS_KEY_RE = /^omega-ops\/capture-health(?:-latest|-\d{4}-\d{2}-\d{2})$/;

function assertOpsKey(key) {
  const k = String(key || '');
  if (/^(?:picks-\d{4}-\d{2}-\d{2}|latest-date|picks-dates|picks-sim-)/.test(k)) {
    throw new Error(`omega-ops refused live key: ${k}`);
  }
  if (!OPS_KEY_RE.test(k)) {
    throw new Error(`omega-ops refused key: ${k}`);
  }
  return k;
}

/**
 * Persist last captureHealth snapshot for ops dashboards / alerts.
 * Does not change hardFail policy. Soft-fail at call sites.
 */
async function storeCaptureHealthSnapshot(dateISO, snapshot) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`omega-ops refused bad date: ${dateISO}`);
  }
  const payload = {
    ...(snapshot || {}),
    date: d,
    opsOnly: true,
    storedAt: new Date().toISOString(),
  };
  const dated = assertOpsKey(`omega-ops/capture-health-${d}`);
  const latest = assertOpsKey('omega-ops/capture-health-latest');
  await storeJson(dated, payload);
  try {
    await storeJson(latest, payload);
  } catch (e) {
    console.error(`[omega-vnext/store] capture-health latest: ${e.message}`);
  }
  return { dated, latest };
}

async function readCaptureHealthLatest() {
  return readJson(assertOpsKey('omega-ops/capture-health-latest'));
}

async function readCaptureHealthDate(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return readJson(assertOpsKey(`omega-ops/capture-health-${d}`));
}

module.exports = {
  storePicks, storeShadowPicks, resolvePicksStoreTarget, readPicks, storeJson, readJson,
  storePmObserver, readPmObserver, storePmObserverOpen, readPmObserverOpen,
  pmObserverStorageKey, pmObserverAliasKey,
  WALKFORWARD_KEY_RE, assertWalkforwardKey,
  storeWalkforwardSamples, storeWalkforwardReport, storeWalkforwardPriorsOffline,
  REPLAY_KEY_RE, assertReplayKey, storeReplayCard, storeReplaySummary,
  OPS_KEY_RE, assertOpsKey, storeCaptureHealthSnapshot, readCaptureHealthLatest, readCaptureHealthDate,
};
