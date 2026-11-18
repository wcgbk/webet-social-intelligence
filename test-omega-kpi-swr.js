#!/usr/bin/env node
'use strict';
// KPI page must not keep a day-old CDN copy. t= does not regrade.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cacheControlFor, wantFresh, cacheIsFresh } = require('./netlify/functions/lib/kpi-cache');

const pending = { cumulative: { pending: 1 }, days: [{ pending: 1 }], cachedAt: Date.now() };
const settled = { cumulative: { pending: 0 }, days: [{ pending: 0, parlayResult: 'win' }], cachedAt: Date.now() };

assert.ok(cacheControlFor(pending, {}).includes('stale-while-revalidate=60'));
assert.ok(cacheControlFor(settled, {}).includes('max-age=300'));
assert.ok(cacheControlFor(settled, { OMEGA_KPI_SWR_SHORT: 'off' }).includes('stale-while-revalidate=86400'));
assert.ok(cacheControlFor(pending, { OMEGA_KPI_SWR_SHORT: '0' }).includes('stale-while-revalidate=86400'));

const bust = { queryStringParameters: { t: '1700000000' } };
assert.strictEqual(wantFresh(bust), false);
assert.strictEqual(cacheIsFresh(settled, bust), true);
assert.strictEqual(cacheIsFresh(settled, { queryStringParameters: { t: '1', refresh: '1' } }), false);

for (const rel of ['daily-omega/index.html', 'v1/index.html', 'daily-omega-v1/index.html']) {
  const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  assert.ok(html.includes("cache: 'no-store'"), rel);
  assert.ok(html.includes('Math.floor(Date.now() / 60000)'), rel);
  assert.ok(html.includes('renderResults(data)'), rel);
  assert.ok(html.includes("getElementById('hero-accuracy')"), rel);
  assert.ok(html.includes("getElementById('results-body')"), rel);
}
const daily = fs.readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
assert.ok(daily.includes("localStorage.getItem('edgeKpi7')"));
assert.ok(daily.includes('/api/get-results-omega?'));

console.log('test-omega-kpi-swr: PASS');
