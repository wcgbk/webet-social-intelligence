'use strict';

/**
 * capture-omega-walkforward.js — scheduled observer for lock→close samples.
 *
 * Reads picks-{date} and clv-{date} from edge-picks-omega.
 * Writes only omega-walkforward/samples|reports|priors-offline.
 * Does not regenerate the live card, does not call calibrate, does not post.
 * Soft-fail. Fit stays off (Monday 11:00 ET on or after 2026-09-29).
 */

const store = require('./lib/omega-vnext/store');
const wf = require('./lib/omega-vnext/walk_forward');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function safeRead(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[omega-walkforward] read soft-fail ${label}: ${e.message}`);
    return null;
  }
}

async function captureOne(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) {
    return { date: dateISO || null, skipped: true, reason: 'bad-date', write: false };
  }
  const picksBlob = await safeRead(`picks-${dateISO}`, () => store.readPicks(dateISO));
  const clvBlob = await safeRead(`clv-${dateISO}`, () => store.readJson(`clv-${dateISO}`));
  const plan = wf.planCapture(dateISO, picksBlob, clvBlob);
  if (!plan.write) {
    console.log(`[omega-walkforward] skip ${dateISO} (${plan.reason})`);
    return {
      date: dateISO,
      skipped: true,
      reason: plan.reason,
      write: false,
      n: 0,
    };
  }
  let wrote = false;
  let storeError = null;
  try {
    await store.storeWalkforwardSamples(dateISO, plan.samplesBlob);
    await store.storeWalkforwardReport(dateISO, plan.report);
    wrote = true;
    console.log(`[omega-walkforward] wrote ${dateISO} n=${plan.samples.length}`);
  } catch (e) {
    storeError = e.message;
    console.error(`[omega-walkforward] store soft-fail ${dateISO}: ${e.message}`);
  }
  return {
    date: dateISO,
    skipped: false,
    write: wrote,
    n: plan.samples.length,
    graded: plan.report ? plan.report.graded : 0,
    storeError,
  };
}

async function runCapture(explicitDate) {
  const dates = wf.datesForRun(explicitDate || null);
  const results = [];
  for (const dateISO of dates) {
    results.push(await captureOne(dateISO));
  }
  let priorsKey = null;
  let priorsError = null;
  try {
    priorsKey = await store.storeWalkforwardPriorsOffline(wf.loadOfflinePriors());
  } catch (e) {
    priorsError = e.message;
    console.error(`[omega-walkforward] priors soft-fail: ${e.message}`);
  }
  return {
    ok: true,
    observerOnly: true,
    fitEnabled: false,
    fitApplied: false,
    dates: results,
    priorsKey,
    priorsError,
  };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const explicit = qs.date || null;
  console.log(`[omega-walkforward] start observer date=${explicit || 'yesterday+today'}`);
  try {
    if (explicit && !/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
      return json(200, { ok: false, error: 'bad date', observerOnly: true, fitEnabled: false });
    }
    const out = await runCapture(explicit);
    return json(200, out);
  } catch (e) {
    console.error(`[omega-walkforward] fatal soft-fail: ${e.message}`);
    return json(200, {
      ok: false,
      error: e.message,
      observerOnly: true,
      fitEnabled: false,
      fitApplied: false,
    });
  }
};

exports.runCapture = runCapture;
exports.captureOne = captureOne;
