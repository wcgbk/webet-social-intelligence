'use strict';

/**
 * GET /.netlify/functions/agentics-ledger
 *
 * READ ONLY. Reads Netlify Blobs store `agentics`, key
 * `omega-shadow/latest.json`, and returns that JSON. Does not write,
 * delete, or list other keys. Does not touch Omega pick logic.
 *
 * Cache: public, max-age=60. Missing key → 200 empty-state JSON
 * (`empty: true`), not a 404.
 *
 * Publish (operator CLI, not this function). Verified against Netlify CLI
 * `blobs:set` — arguments are store, key, optional value; `--input` reads
 * the value from a file (`netlify blobs:set my-store my-key --input ./file`):
 *
 *   netlify blobs:set agentics omega-shadow/latest.json --input <file>
 *
 * Schema: docs/agentics-dashboard-schema.json
 */

const { getStore } = require('@netlify/blobs');

const STORE = 'agentics';
const KEY = 'omega-shadow/latest.json';
const CACHE = 'public, max-age=60';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const JSON_HEADERS = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS);

function emptyLedger(extra) {
  const body = {
    ok: true,
    empty: true,
    schemaVersion: '1',
    asOf: new Date().toISOString(),
    etDate: null,
    mode: null,
    currency: 'USD',
    bankroll: null,
    sample: false,
    source: {
      store: STORE,
      key: KEY,
    },
    limits: {
      dailyDrawdownPct: 5,
      weeklyDrawdownPct: 7.5,
      totalDrawdownPct: 12,
    },
    gate: {
      daysRequired: 14,
      tradesRequired: 20,
      daysElapsed: 0,
      trades: 0,
      startedOn: null,
      met: false,
    },
    summary: {
      wins: 0,
      losses: 0,
      pushes: 0,
      open: 0,
      record: '0-0-0',
      pl: 0,
      roiPct: 0,
      staked: 0,
    },
    drawdown: {
      dailyPct: 0,
      weeklyPct: 0,
      totalPct: 0,
      dailyLimitPct: 5,
      weeklyLimitPct: 7.5,
      totalLimitPct: 12,
      withinLimits: true,
    },
    clv: {
      vs: 'polymarket-close',
      date: null,
      avgClvCents: null,
      n: 0,
      byDay: [],
    },
    today: {
      date: null,
      picks: [],
    },
    ledger: [],
  };
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach((k) => {
      body[k] = extra[k];
    });
  }
  return body;
}

function respond(statusCode, payload, cache) {
  const headers = Object.assign({}, JSON_HEADERS);
  if (cache) headers['Cache-Control'] = cache;
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload),
  };
}

async function readRaw() {
  const store = getStore(STORE);
  return store.get(KEY, { type: 'text' });
}

exports.handler = async (event) => {
  const method = event && event.httpMethod ? String(event.httpMethod).toUpperCase() : 'GET';
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (method !== 'GET') {
    return respond(405, { ok: false, error: 'GET only' }, 'no-store');
  }

  try {
    const raw = await readRaw();
    if (raw == null || String(raw).trim() === '') {
      return respond(200, emptyLedger({ reason: 'missing' }), CACHE);
    }
    let parsed;
    try {
      parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    } catch (err) {
      return respond(200, emptyLedger({
        ok: false,
        reason: 'invalid-json',
        error: 'Stored ledger is not valid JSON',
      }), CACHE);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return respond(200, emptyLedger({
        ok: false,
        reason: 'invalid-shape',
        error: 'Stored ledger is not a JSON object',
      }), CACHE);
    }
    return respond(200, parsed, CACHE);
  } catch (err) {
    return respond(200, emptyLedger({
      ok: false,
      reason: 'read-error',
      error: err && err.message ? String(err.message) : 'read failed',
    }), 'no-store');
  }
};

exports._test = {
  STORE,
  KEY,
  CACHE,
  emptyLedger,
};
