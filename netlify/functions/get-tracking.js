'use strict';

/**
 * GET /.netlify/functions/get-tracking
 * Public read of omega-tracking/index. No auth token, no secret.
 * If the blob is missing, returns the seeded 2026-10-12 table.
 * Does not write. Does not change a price or a pick.
 */

const path = require('path');
const tracking = require('./lib/tracking-report');
const SEED = require('../../tracking/report.json');

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

function seedIndex() {
  return {
    ...SEED,
    source: (SEED && SEED.source) || 'seed',
    observerOnly: true,
    displayOnly: true,
    applied: false,
  };
}

// SDK first, then the REST blob API. report-tracking-omega writes through
// store.storeJson, which lands in the REST namespace when the SDK has no
// blobs context (v1 handlers). The SDK-only read never saw that index.
async function readIndexFromStore() {
  const store = require('./lib/omega-vnext/store');
  return store.readJson(tracking.INDEX_KEY);
}

async function handle(event, deps) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  const readIndex = deps && deps.readIndex ? deps.readIndex : readIndexFromStore;
  let latest = null;
  try {
    latest = await readIndex();
  } catch (e) {
    console.error(`[get-tracking] index read: ${e.message}`);
    latest = null;
  }
  if (tracking.isIndex(latest)) {
    return json(200, {
      ...latest,
      source: latest.source || 'omega-tracking/index',
      observerOnly: true,
      displayOnly: true,
      applied: false,
    });
  }
  return json(200, seedIndex());
}

exports.handler = (event) => handle(event, null);
exports.handle = handle;
exports.seedIndex = seedIndex;
exports.SEED_PATH = path.join(__dirname, '..', '..', 'tracking', 'report.json');
