'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fresh = require('../netlify/functions/check-supabase-freshness');

const NOW = new Date('2026-10-30T13:45:00Z'); // 9:45 ET
const AUTH = { headers: { authorization: 'Bearer s3cret' }, queryStringParameters: {} };
const ENV = { PICKS_SECRET_KEY: 's3cret', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const fakeFetch = (rows, status = 200) => async () => ({ ok: status === 200, status, json: async () => rows });
const blobs = []; const getStore = () => ({ setJSON: async (k, v) => blobs.push([k, v]) });

test('evaluate: yesterday ET counts as fresh, older is stale', () => {
  assert.equal(fresh.evaluate('2026-10-29T14:00:00Z', NOW).fresh, true);
  assert.equal(fresh.evaluate('2026-10-29T04:30:00Z', NOW).fresh, true); // 00:30 ET 10/29
  assert.equal(fresh.evaluate('2026-10-29T03:30:00Z', NOW).fresh, false); // 23:30 ET 10/28
  assert.equal(fresh.evaluate('2026-10-13T16:45:18Z', NOW).fresh, false);
  assert.equal(fresh.evaluate(null, NOW).fresh, false);
});

test('handler: fresh -> 200', async () => {
  const r = await fresh.handle(AUTH, NOW, { env: ENV, fetch: fakeFetch([{ created_at: '2026-10-30T13:25:05Z' }]), getStore });
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).ok, true);
});

test('handler: stale -> 500 + alert blob', async () => {
  const r = await fresh.handle(AUTH, NOW, { env: ENV, fetch: fakeFetch([{ created_at: '2026-10-13T16:45:18Z' }]), getStore });
  assert.equal(r.statusCode, 500); assert.equal(JSON.parse(r.body).fresh, false);
  assert.equal(blobs.at(-1)[0], 'freshness/2026-10-30');
});

test('handler: missing key -> 500', async () => {
  const r = await fresh.handle(AUTH, NOW, { env: { PICKS_SECRET_KEY: 's3cret' }, fetch: fakeFetch([]), getStore });
  assert.equal(r.statusCode, 500); assert.match(JSON.parse(r.body).error, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('handler: unauthorized manual call -> 401', async () => {
  const r = await fresh.handle({ headers: {}, queryStringParameters: {} }, NOW, { env: ENV, fetch: fakeFetch([]), getStore });
  assert.equal(r.statusCode, 401);
});
