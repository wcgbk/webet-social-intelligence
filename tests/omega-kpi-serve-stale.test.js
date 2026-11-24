'use strict';
// Stale Edge KPI blobs are served immediately. A background refresh is kicked once.
// OMEGA_KPI_SERVE_STALE=off recomputes in the request. No cache recomputes too.
// No network. Fetch is replaced for the whole file.

const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cacheControlFor } = require('../netlify/functions/lib/kpi-cache');
const { kpiServeStaleEnabled } = require('../netlify/functions/lib/default_on_flag');

const ROOT = path.join(__dirname, '..');
const REFRESH_PATH = '/.netlify/functions/refresh-results-omega-background';
const CACHE_KEY = 'results-omega-cache-v9-kpi1030';
const LOCK_KEY = 'results-omega-refresh-lock';

const savedFetch = global.fetch;
const savedEnv = {};
for (const key of ['NETLIFY_AUTH_TOKEN', 'URL', 'DEPLOY_PRIME_URL', 'OMEGA_KPI_SERVE_STALE', 'OMEGA_DAILY_RESULTS_RESYNC']) {
  savedEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
}

process.env.NETLIFY_AUTH_TOKEN = 'test-token';
process.env.URL = 'https://kpi-refresh.test';
delete process.env.DEPLOY_PRIME_URL;
delete process.env.OMEGA_KPI_SERVE_STALE;
process.env.OMEGA_DAILY_RESULTS_RESYNC = 'off';

const store = { cache: null, lock: null, cachePuts: 0 };
const calls = [];

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body == null ? null : body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || 'GET').toUpperCase();
  calls.push({ url: u, method });
  if (opts.signal && opts.signal.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  if (u.includes(REFRESH_PATH)) {
    return new Promise((resolve, reject) => {
      if (store.hangRefresh) {
        const timer = setTimeout(() => resolve(jsonResponse(202, {})), 10000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
        return;
      }
      resolve(jsonResponse(202, {}));
    });
  }
  if (u.includes('/' + LOCK_KEY)) {
    if (method === 'PUT') {
      store.lock = JSON.parse(opts.body);
      return jsonResponse(200, store.lock);
    }
    if (store.lock) return jsonResponse(200, store.lock);
    return jsonResponse(404, {});
  }
  if (u.includes('/' + CACHE_KEY)) {
    if (method === 'PUT') {
      store.cachePuts += 1;
      return jsonResponse(200, {});
    }
    if (store.cache) return jsonResponse(200, store.cache);
    return jsonResponse(404, {});
  }
  if (u.includes('/picks-dates')) return jsonResponse(200, []);
  return jsonResponse(404, {});
};

const results = require('../netlify/functions/get-results-omega');
const background = require('../netlify/functions/refresh-results-omega-background');

function staleCache() {
  return {
    servedMarker: 'stale-blob',
    cachedAt: Date.now() - (10 * 60 * 1000),
    days: [{
      date: '2026-11-23',
      source: 'omega',
      picks: [],
      wins: 1,
      losses: 0,
      pushes: 0,
      pending: 1,
      parlayResult: 'pending',
      profit: 10,
    }],
    cumulative: { pending: 1, totalProfit: 10, roi: '5%' },
    straight: { wins: 1, losses: 0, pushes: 0, accuracy: '100%' },
    parlay: {},
    scope: { label: 'stale-cache', from: '2026-11-23', omegaStart: '2026-09-22', kpiScope: 'stale' },
  };
}

function freshCache() {
  return Object.assign({}, staleCache(), { cachedAt: Date.now() });
}

function resetStore(cache) {
  store.cache = cache || null;
  store.lock = null;
  store.cachePuts = 0;
  store.hangRefresh = false;
  calls.length = 0;
}

function count(part, method) {
  return calls.filter((c) => c.url.includes(part) && (!method || c.method === method)).length;
}

function event(query) {
  return { httpMethod: 'GET', queryStringParameters: query || {} };
}

describe('omega kpi serve stale', { concurrency: 1 }, () => {

test('flag defaults on and off restores the recompute switch', () => {
  assert.strictEqual(kpiServeStaleEnabled({}), true);
  assert.strictEqual(kpiServeStaleEnabled({ OMEGA_KPI_SERVE_STALE: '' }), true);
  assert.strictEqual(kpiServeStaleEnabled({ OMEGA_KPI_SERVE_STALE: 'off' }), false);
  assert.strictEqual(kpiServeStaleEnabled({ OMEGA_KPI_SERVE_STALE: '0' }), false);
});

test('stale cache is served and the refresh is kicked once', async () => {
  delete process.env.OMEGA_KPI_SERVE_STALE;
  resetStore(staleCache());
  const first = await results.handler(event({ range: '7', t: '1' }));
  const body = JSON.parse(first.body);
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(body.servedMarker, 'stale-blob');
  assert.strictEqual(first.headers['Cache-Control'], cacheControlFor(store.cache));
  assert.strictEqual(count('picks-dates'), 0);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 1);
  assert.strictEqual(count(LOCK_KEY, 'PUT'), 1);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url === 'https://kpi-refresh.test' + REFRESH_PATH));

  const second = await results.handler(event({ range: '7' }));
  assert.strictEqual(JSON.parse(second.body).servedMarker, 'stale-blob');
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 1);
  assert.strictEqual(count(LOCK_KEY, 'PUT'), 1);
  assert.strictEqual(count('picks-dates'), 0);
});

test('flag off recomputes a stale cache inside the request', async () => {
  process.env.OMEGA_KPI_SERVE_STALE = 'off';
  resetStore(staleCache());
  const res = await results.handler(event({ range: '7' }));
  const body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.servedMarker, undefined);
  assert.strictEqual(body.scope.kpiScope, 'record=straightsOnly,roi=allIn');
  assert.ok(body.totalDays > 1);
  assert.ok(count('picks-dates') >= 1);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 0);
  assert.strictEqual(count(LOCK_KEY, 'PUT'), 0);
  assert.ok(store.cachePuts >= 1);
  assert.ok(String(res.headers['Cache-Control']).includes('stale-while-revalidate='));
  delete process.env.OMEGA_KPI_SERVE_STALE;
});

test('flag off still serves a fresh cache', async () => {
  process.env.OMEGA_KPI_SERVE_STALE = 'off';
  resetStore(freshCache());
  const res = await results.handler(event({}));
  const body = JSON.parse(res.body);
  assert.strictEqual(body.servedMarker, 'stale-blob');
  assert.strictEqual(count('picks-dates'), 0);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 0);
  delete process.env.OMEGA_KPI_SERVE_STALE;
});

test('no cache computes synchronously and does not kick a refresh', async () => {
  delete process.env.OMEGA_KPI_SERVE_STALE;
  resetStore(null);
  const res = await results.handler(event({ range: '7' }));
  const body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.servedMarker, undefined);
  assert.strictEqual(body.scope.kpiScope, 'record=straightsOnly,roi=allIn');
  assert.ok(count('picks-dates') >= 1);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 0);
  assert.ok(store.cachePuts >= 1);
});

test('refresh=1 recomputes and the background handler does not kick itself', async () => {
  delete process.env.OMEGA_KPI_SERVE_STALE;
  resetStore(staleCache());
  const direct = await results.handler(event({ refresh: '1', range: 'all' }));
  assert.strictEqual(JSON.parse(direct.body).servedMarker, undefined);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 0);
  assert.ok(count('picks-dates') >= 1);

  resetStore(staleCache());
  const bg = await background.handler();
  const body = JSON.parse(bg.body);
  assert.strictEqual(bg.statusCode, 200);
  assert.strictEqual(body.servedMarker, undefined);
  assert.strictEqual(body.range, 'all');
  assert.strictEqual(body.scope.kpiScope, 'record=straightsOnly,roi=allIn');
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 0);
  assert.ok(store.cachePuts >= 1);
});

test('a hung refresh kick is capped near 1.5s', async () => {
  delete process.env.OMEGA_KPI_SERVE_STALE;
  resetStore(staleCache());
  store.hangRefresh = true;
  const started = Date.now();
  const res = await results.handler(event({}));
  const elapsed = Date.now() - started;
  assert.strictEqual(JSON.parse(res.body).servedMarker, 'stale-blob');
  assert.ok(elapsed < 3000, 'elapsed ' + elapsed);
  assert.ok(elapsed >= 1200, 'elapsed ' + elapsed);
  assert.strictEqual(count(REFRESH_PATH, 'POST'), 1);
});

test('daily-omega keeps a rendered snapshot and retries once', () => {
  const html = fs.readFileSync(path.join(ROOT, 'daily-omega/index.html'), 'utf8');
  const start = html.indexOf('async function loadResults');
  const slice = html.slice(start, start + 1800);
  assert.ok(slice.includes('kpiRetried'));
  assert.ok(slice.includes('4000'));
  assert.ok(slice.includes('if (resultsSnapshot) return;'));
  assert.ok(slice.includes('Failed to load results. Try again later.'));
  assert.ok(slice.indexOf('kpiRetried') < slice.indexOf('Failed to load results. Try again later.'));
  assert.ok(slice.indexOf('if (resultsSnapshot) return;') < slice.indexOf('Failed to load results. Try again later.'));
});

after(() => {
  global.fetch = savedFetch;
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

});
