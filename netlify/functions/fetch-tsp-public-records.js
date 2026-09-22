'use strict';
/**
 * On-demand / one-shot downloader for PUBLIC TSP Performance Terminal records.
 * Writes isolated tsp-research blob snapshots. NEVER writes edge-picks-omega.
 * Does NOT scrape tsp.live member pages. Member fetch-tsp-live is a separate
 * isolated /live-ai job (hold lifted 2026-09-22) and is not imported here.
 */

const {
  downloadPublicRecords,
  buildDailyDigest,
  storeSnapshot,
  storeDigest,
  TSP_FETCH_ON_HOLD,
  BLOB_STORE,
} = require('./lib/tsp-research');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function run(dateISO) {
  const date = dateISO || todayET();
  const snapshot = await downloadPublicRecords();
  snapshot.date = date;
  let storeKey = null;
  let digestKey = null;
  try {
    storeKey = await storeSnapshot(date, snapshot);
    const digest = buildDailyDigest(snapshot, { dateISO: date });
    digestKey = await storeDigest(date, digest);
  } catch (e) {
    console.error(`[tsp-public] blob store soft-fail: ${e.message}`);
    snapshot.storeError = e.message;
  }
  return { snapshot, storeKey, digestKey, blobStore: BLOB_STORE, tspFetchOnHold: TSP_FETCH_ON_HOLD };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  console.log(`[tsp-public] download start date=${dateISO || todayET()} hold=${TSP_FETCH_ON_HOLD}`);
  try {
    const { snapshot, storeKey, digestKey, blobStore } = await run(dateISO);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        date: snapshot.date,
        okCount: snapshot.okCount,
        feedCount: snapshot.feedCount,
        errors: snapshot.errors,
        storeKey,
        digestKey,
        blobStore,
        tspLiveMemberFetch: 'ON_HOLD',
      }),
    };
  } catch (e) {
    console.error(`[tsp-public] fatal: ${e.message}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, blobStore: BLOB_STORE }),
    };
  }
};

exports.run = run;
