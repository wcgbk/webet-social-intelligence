'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fresh = require('../netlify/functions/check-supabase-freshness');

const NOW = new Date('2026-10-30T13:45:00Z'); // 9:45 ET
const AUTH = { headers: { authorization: 'Bearer s3cret' }, queryStringParameters: {} };
const ENV = { PICKS_SECRET_KEY: 's3cret', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_MIRROR_V2: 'off' };
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
  assert.equal(JSON.parse(r.body).checks, undefined);
});

function countResp(n, rows) {
  return {
    ok: true,
    status: 200,
    json: async () => (rows || (n > 0 ? [{}] : [])),
    text: async () => '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-range' ? (n > 0 ? `0-0/${n}` : '*/0') : null) },
  };
}

function mirrorFetch(overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('order=created_at')) {
      return { ok: true, status: 200, json: async () => [{ created_at: overrides.latest || '2026-10-30T13:25:05Z' }], headers: { get: () => null } };
    }
    if (u.includes('/cards?')) return countResp(overrides.cards == null ? 1 : overrides.cards, overrides.cardRows || [{ date: '2026-10-29', total_picks: 2 }]);
    if (u.includes('board_candidates')) return countResp(overrides.board == null ? 4 : overrides.board);
    if (u.includes('card_picks')) return countResp(overrides.picks == null ? 2 : overrides.picks);
    if (u.includes('pick_clv')) return countResp(overrides.clv == null ? 2 : overrides.clv);
    if (u.includes('daily_results')) return countResp(overrides.results == null ? 1 : overrides.results);
    if (u.includes('kpi_snapshots')) return countResp(overrides.kpi == null ? 1 : overrides.kpi);
    if (u.includes('/scores?')) return countResp(overrides.scores == null ? 3 : overrides.scores);
    if (u.includes('book_prices')) return countResp(overrides.books == null ? 2 : overrides.books);
    if (u.includes('book=eq.hardrockbet')) return countResp(overrides.hardrock == null ? 5 : overrides.hardrock);
    if (u.includes('mirror_runs')) {
      return { ok: true, status: 200, json: async () => (overrides.runs || [{ ok: true }]), headers: { get: () => null } };
    }
    return { ok: false, status: 404, json: async () => [], text: async () => 'miss', headers: { get: () => null } };
  };
  return { fn, calls };
}

const ON = { ...ENV, SUPABASE_MIRROR_V2: 'on' };

test('handler flag on: yesterday tables fresh -> 200 with checks', async () => {
  const { fn, calls } = mirrorFetch();
  const r = await fresh.handle(AUTH, NOW, { env: ON, fetch: fn, getStore });
  const body = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.cards.ok, true);
  assert.equal(body.checks.board_candidates.n, 4);
  assert.equal(body.checks.mirror_runs.ok, true);
  assert.ok(calls.some((u) => u.includes('book=eq.hardrockbet') && u.includes('gte.2026-10-29T04')));
});

test('handler flag on: empty board -> 500 and alert', async () => {
  const alerts = [];
  const { fn } = mirrorFetch({ board: 0 });
  const r = await fresh.handle(AUTH, NOW, { env: ON, fetch: fn, getStore: () => ({ setJSON: async (k, v) => alerts.push([k, v]) }) });
  const body = JSON.parse(r.body);
  assert.equal(r.statusCode, 500);
  assert.equal(body.fresh, false);
  assert.equal(body.checks.board_candidates.ok, false);
  assert.equal(alerts.at(-1)[0], 'freshness/2026-10-30');
});

test('handler flag on: stale odds snapshot still 500 when mirror tables pass', async () => {
  const { fn } = mirrorFetch({ latest: '2026-10-13T16:45:18Z' });
  const r = await fresh.handle(AUTH, NOW, { env: ON, fetch: fn, getStore });
  const body = JSON.parse(r.body);
  assert.equal(r.statusCode, 500);
  assert.equal(body.fresh, false);
  assert.equal(body.checks.cards.ok, true);
});

test('handler flag on: card_picks not required when total_picks is 0', async () => {
  const { fn } = mirrorFetch({ picks: 0, clv: 0, cardRows: [{ date: '2026-10-29', total_picks: 0 }] });
  const r = await fresh.handle(AUTH, NOW, { env: ON, fetch: fn, getStore });
  const body = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(body.checks.card_picks.ok, true);
  assert.equal(body.checks.pick_clv.ok, true);
});

test('handler flag on: mirror_runs not ok -> stale', async () => {
  const { fn } = mirrorFetch({ runs: [{ ok: false }] });
  const r = await fresh.handle(AUTH, NOW, { env: ON, fetch: fn, getStore });
  assert.equal(r.statusCode, 500);
  assert.equal(JSON.parse(r.body).checks.mirror_runs.ok, false);
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
