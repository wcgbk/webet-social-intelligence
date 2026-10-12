'use strict';

/**
 * GET /.netlify/functions/get-clv-report
 * Public read of omega-clv-report/latest. No auth token, no secret.
 * If the blob is missing, returns the seeded running total.
 * Does not write. Does not change a price or a pick.
 */

const { BLOB_STORE } = require('./lib/omega-vnext/config');
const ledger = require('./lib/clv-ledger');
const SEED = require('../../data/clv-ledger-seed.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: CORS,
    body: JSON.stringify(body),
  };
}

function seedReport(now) {
  const when = now instanceof Date ? now : new Date();
  const asOf = (SEED && SEED.asOf) || ledger.etYmd(when);
  return ledger.buildReport({
    rows: (SEED && SEED.rows) || [],
    asOf,
    generatedAt: (SEED && SEED.generatedAt) || when.toISOString(),
    source: 'seed',
  });
}

async function readLatestFromStore() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore(BLOB_STORE);
  return store.get(ledger.LATEST_KEY, { type: 'json' });
}

function isReport(value) {
  return !!(value && value.schema === 'omega-clv-report-v1' && value.totals);
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const readLatest = deps && deps.readLatest ? deps.readLatest : readLatestFromStore;
  const now = deps && deps.now instanceof Date ? deps.now : new Date();
  let latest = null;
  try {
    latest = await readLatest();
  } catch (e) {
    console.error(`[get-clv-report] latest read: ${e.message}`);
    latest = null;
  }
  if (isReport(latest)) {
    return json(200, {
      ...latest,
      source: latest.source || 'omega-clv-report/latest',
      observerOnly: true,
      displayOnly: true,
      applied: false,
    });
  }
  return json(200, seedReport(now));
}

exports.handler = (event) => handle(event, null);
exports.handle = handle;
exports.seedReport = seedReport;
