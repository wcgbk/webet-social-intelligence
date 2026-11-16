'use strict';

/**
 * OMEGA_MIRROR_PRUNE_CARD_PICKS. After a successful card_picks upsert,
 * stale keys for that date and kind are deleted. Current keys stay.
 * Empty, short, and non-3-straight cards do not delete. Flag off and
 * dry-run do not delete. A failed upsert does not delete.
 */

const assert = require('assert');
const mirror = require('./netlify/functions/lib/supa-mirror');

const DATE = '2026-11-15';
const FLAG = 'OMEGA_MIRROR_PRUNE_CARD_PICKS';

function memBlobs(data) {
  const store = new Map(Object.entries(data || {}));
  return {
    async get(s, k) { return store.has(`${s}:${k}`) ? store.get(`${s}:${k}`) : null; },
    async list() { return []; },
    async set(s, k, v) { store.set(`${s}:${k}`, v); },
  };
}

function pick(id) {
  return {
    pickId: id,
    pick: `Side ${id}`,
    matchup: `Away ${id} @ Home ${id}`,
    sport: 'NBA',
    odds: -110,
    units: '0.25u',
  };
}

function card(ids, extra) {
  return Object.assign({
    date: DATE,
    model: 'omega-v2',
    engine: 'omega-v2',
    picks: ids.map(pick),
    summary: { totalPicks: ids.length },
  }, extra || {});
}

function blobsFor(body) {
  return memBlobs({ [`edge-picks-omega:picks-${DATE}`]: body });
}

function baseEnv(over) {
  return Object.assign({
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    NETLIFY_AUTH_TOKEN: 't',
    SUPABASE_MIRROR_V2: 'on',
  }, over || {});
}

function parseEq(url, name) {
  const m = String(url).match(new RegExp(`[?&]${name}=eq\\.([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function parseNotIn(url) {
  const m = String(url).match(/[?&]pick_key=not\.in\.\((.*)\)(?:&|$)/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.replace(/^"|"$/g, ''));
}

function seedRows() {
  return [
    { date: DATE, kind: 'straight', pick_key: 'k0' },
    { date: DATE, kind: 'straight', pick_key: 'k1' },
    { date: DATE, kind: 'straight', pick_key: 'k2' },
    { date: DATE, kind: 'straight', pick_key: 'stale-a' },
    { date: DATE, kind: 'straight', pick_key: 'stale-b' },
    { date: DATE, kind: 'parlay', pick_key: 'p1' },
    { date: DATE, kind: 'parlay', pick_key: 'stale-p' },
    { date: '2026-11-14', kind: 'straight', pick_key: 'other-day' },
  ];
}

function fakeFetch(log, db) {
  return async (url, opts = {}) => {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    log.push({ url: String(url), opts, method });
    if (method === 'DELETE') {
      const date = parseEq(url, 'date');
      const kind = parseEq(url, 'kind');
      const keep = new Set(parseNotIn(url) || []);
      const gone = [];
      for (let i = db.length - 1; i >= 0; i -= 1) {
        const row = db[i];
        if (row.date === date && row.kind === kind && !keep.has(row.pick_key)) {
          gone.push(db.splice(i, 1)[0]);
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => gone,
        text: async () => JSON.stringify(gone),
        headers: { get: () => null },
      };
    }
    return { ok: true, status: 201, text: async () => '', json: async () => ({}), headers: { get: () => null } };
  };
}

function keysOf(db, kind) {
  return db.filter((r) => r.date === DATE && r.kind === kind).map((r) => r.pick_key).sort();
}

const savedFlag = process.env[FLAG];
delete process.env[FLAG];

function restoreFlag() {
  if (savedFlag == null) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
}

async function main() {
  assert.strictEqual(mirror.pruneCardPicksEnabled({}), true);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'on' }), true);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: '1' }), true);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'true' }), true);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'yes' }), true);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'off' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: '0' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'false' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: '' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: '   ' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled({ [FLAG]: 'maybe' }), false);
  assert.strictEqual(mirror.pruneCardPicksEnabled(), true);

  const full = card(['k0', 'k1', 'k2'], {
    parlayLegs: [{
      legs: [{ pickId: 'p1', pick: 'Leg', matchup: 'C @ D', sport: 'NHL', odds: -110 }],
    }],
  });

  const log = [];
  const db = seedRows();
  const live = await mirror.mirrorDay(DATE, {
    env: baseEnv(),
    fetch: fakeFetch(log, db),
    blobs: blobsFor(full),
    parts: ['card'],
    job: 'daily',
  });
  const deletes = log.filter((c) => c.method === 'DELETE');
  assert.strictEqual(deletes.length, 2);
  assert.ok(deletes.every((c) => c.opts.headers['Content-Profile'] === 'clv'));
  assert.ok(deletes.every((c) => c.opts.headers.apikey === 'k'));
  assert.ok(deletes.every((c) => c.opts.headers.Authorization === 'Bearer k'));
  assert.ok(deletes.every((c) => /return=representation/.test(c.opts.headers.Prefer)));
  const straightDel = deletes.find((c) => c.url.includes('kind=eq.straight'));
  const parlayDel = deletes.find((c) => c.url.includes('kind=eq.parlay'));
  assert.ok(straightDel.url.includes(`date=eq.${DATE}`));
  assert.ok(straightDel.url.includes('pick_key=not.in.'));
  assert.deepStrictEqual(parseNotIn(straightDel.url).sort(), ['k0', 'k1', 'k2']);
  assert.deepStrictEqual(parseNotIn(parlayDel.url).sort(), ['p1']);
  assert.deepStrictEqual(keysOf(db, 'straight'), ['k0', 'k1', 'k2']);
  assert.deepStrictEqual(keysOf(db, 'parlay'), ['p1']);
  assert.ok(db.some((r) => r.pick_key === 'other-day'));
  assert.strictEqual(live.counts.card_picks, 4);
  assert.strictEqual(live.counts.card_picks_pruned, 3);
  assert.ok(log.some((c) => c.method === 'POST' && c.url.includes('/card_picks')));
  const postsBeforeDelete = log.findIndex((c) => c.method === 'DELETE');
  const upsertAt = log.findIndex((c) => c.method === 'POST' && c.url.includes('/card_picks'));
  assert.ok(upsertAt >= 0 && upsertAt < postsBeforeDelete);

  const todayLog = [];
  const todayDb = seedRows();
  const today = await mirror.mirrorTodayCard(DATE, {
    env: baseEnv(),
    fetch: fakeFetch(todayLog, todayDb),
    blobs: blobsFor(full),
  });
  assert.strictEqual(todayLog.filter((c) => c.method === 'DELETE').length, 2);
  assert.deepStrictEqual(keysOf(todayDb, 'straight'), ['k0', 'k1', 'k2']);
  assert.deepStrictEqual(keysOf(todayDb, 'parlay'), ['p1']);
  assert.strictEqual(today.counts.card_picks_pruned, 3);
  assert.ok(todayDb.some((r) => r.pick_key === 'other-day'));

  async function noDelete(body, envOver, opts) {
    const calls = [];
    const rows = seedRows();
    const result = await mirror.mirrorDay(DATE, Object.assign({
      env: baseEnv(envOver),
      fetch: fakeFetch(calls, rows),
      blobs: body ? blobsFor(body) : memBlobs({}),
      parts: ['card'],
    }, opts || {}));
    assert.strictEqual(calls.filter((c) => c.method === 'DELETE').length, 0);
    assert.strictEqual(rows.length, seedRows().length);
    assert.strictEqual(result.counts.card_picks_pruned, undefined);
    return { calls, result };
  }

  await noDelete(card(['k0', 'k1']));
  await noDelete(card(['k0']));
  await noDelete(card([]));
  await noDelete(card(['k0', 'k1', 'k2', 'k3']));
  await noDelete(null);
  const off = await noDelete(full, { [FLAG]: 'off' });
  assert.ok(off.calls.some((c) => c.method === 'POST' && c.url.includes('/card_picks')));
  await noDelete(full, { [FLAG]: '' });
  await noDelete(full, { [FLAG]: '0' });
  await noDelete(full, { [FLAG]: 'false' });
  const dry = await noDelete(full, {}, { dry: true });
  assert.strictEqual(dry.calls.length, 0);
  assert.strictEqual(dry.result.counts.card_picks, 4);

  const failLog = [];
  const failDb = seedRows();
  const failed = await mirror.mirrorDay(DATE, {
    env: baseEnv(),
    blobs: blobsFor(full),
    parts: ['card'],
    fetch: async (url, opts = {}) => {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      failLog.push({ url: String(url), method });
      if (method === 'POST' && String(url).includes('/card_picks')) {
        return { ok: false, status: 500, text: async () => 'nope k', json: async () => ({}) };
      }
      if (method === 'DELETE') {
        failDb.splice(0, failDb.length);
        return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
      }
      return { ok: true, status: 201, text: async () => '', json: async () => ({}), headers: { get: () => null } };
    },
  });
  assert.strictEqual(failLog.filter((c) => c.method === 'DELETE').length, 0);
  assert.strictEqual(failDb.length, seedRows().length);
  assert.strictEqual(failed.counts.card_picks_pruned, undefined);
  assert.ok(failed.errors.some((e) => /card_picks/.test(e)));
  assert.ok(!failed.errors.join(' ').includes('nope k') || !failed.errors.join(' ').includes('Bearer'));
  assert.ok(!JSON.stringify(failed).includes('NETLIFY'));

  console.log('PASS mirror prune card picks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  restoreFlag();
});
