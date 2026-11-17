#!/usr/bin/env node
// One Odds pull per ET slot. In-memory blobs, fake fetch. No network.
'use strict';

const assert = require('assert');
const cap3 = require('./netlify/functions/capture-odds-3am');
const cap10 = require('./netlify/functions/capture-odds-10am');
const closes = require('./netlify/functions/capture-closes-3am-background');
const track = require('./netlify/functions/track-clv-omega');
const { SPORTS } = require('./netlify/functions/lib/odds-master/pull');
const { pullLockKey, closesLockKey, trackLockKey, LOCK_TTL_MS } = require('./netlify/functions/lib/slot-lock');

const PER_PULL = SPORTS.length;
const DATE = '2026-11-17';
const T0 = new Date('2026-11-17T08:00:59Z');

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function memKv() {
  const data = new Map();
  return {
    data,
    async read(key) {
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null;
    },
    async write(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
  };
}

function oddsOk() {
  return { ok: true, status: 200, json: async () => [] };
}

function json(res) {
  return JSON.parse(res.body);
}

function pullDeps(kv, extra) {
  const odds = [];
  const closesHit = [];
  let hold = null;
  let releaseHold = null;
  let arm = null;
  const gate = {
    armFirst() {
      hold = new Promise((resolve) => { releaseHold = resolve; });
      arm = true;
    },
    release() { if (releaseHold) releaseHold(); },
  };
  const deps = {
    env: Object.assign({
      ODDS_API_KEY: 'test-key',
      URL: 'https://webetsocial.com',
      OMEGA_PULL_SLOT_LOCK: 'on',
    }, extra && extra.env),
    dateISO: DATE,
    now: (extra && extra.now) || T0,
    read: extra && extra.read ? extra.read : (key) => kv.read(key),
    write: (key, value) => kv.write(key, value),
    apiKey: 'test-key',
    oddsFetch: async (url) => {
      const href = String(url);
      assert.ok(href.includes('api.the-odds-api.com'), href);
      odds.push(href);
      if (arm && odds.length === 1 && hold) await hold;
      return oddsOk();
    },
    fetch: async (url) => {
      closesHit.push(String(url));
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    },
  };
  return { deps, odds, closesHit, gate };
}

async function main() {
  assert.strictEqual(PER_PULL, 6);

  await check('3 overlapping 3 AM invocations make one pull and one closes trigger', async () => {
    const kv = memKv();
    const a = pullDeps(kv);
    const b = pullDeps(kv, { now: new Date(T0.getTime() + 15000) });
    const c = pullDeps(kv, { now: new Date(T0.getTime() + 30000) });
    b.deps.oddsFetch = a.deps.oddsFetch;
    c.deps.oddsFetch = a.deps.oddsFetch;
    b.deps.fetch = a.deps.fetch;
    c.deps.fetch = a.deps.fetch;
    a.gate.armFirst();
    const p1 = cap3.handle({ headers: {} }, a.deps);
    await new Promise((resolve) => setImmediate(resolve));
    while (a.odds.length < 1) await new Promise((resolve) => setImmediate(resolve));
    const r2 = json(await cap3.handle({ headers: {} }, b.deps));
    const r3 = json(await cap3.handle({ headers: {} }, c.deps));
    a.gate.release();
    const r1 = json(await p1);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.skipped, 'slot-locked');
    assert.strictEqual(r3.skipped, 'slot-locked');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.skipped, undefined);
    assert.strictEqual(a.odds.length, PER_PULL);
    assert.strictEqual(a.closesHit.length, 1);
    assert.ok(a.closesHit[0].includes('/capture-closes-3am-background'));
    const done = await kv.read(`pulls/${DATE}/0300`);
    assert.strictEqual(typeof done.at, 'string');
  });

  await check('10 AM slot locks the same way and does not fire closes', async () => {
    const kv = memKv();
    const a = pullDeps(kv);
    const b = pullDeps(kv, { now: new Date(T0.getTime() + 15000) });
    const c = pullDeps(kv, { now: new Date(T0.getTime() + 30000) });
    b.deps.oddsFetch = a.deps.oddsFetch;
    c.deps.oddsFetch = a.deps.oddsFetch;
    b.deps.fetch = a.deps.fetch;
    c.deps.fetch = a.deps.fetch;
    a.gate.armFirst();
    const p1 = cap10.handle({ headers: {} }, a.deps);
    while (a.odds.length < 1) await new Promise((resolve) => setImmediate(resolve));
    const r2 = json(await cap10.handle({ headers: {} }, b.deps));
    const r3 = json(await cap10.handle({ headers: {} }, c.deps));
    a.gate.release();
    const r1 = json(await p1);
    assert.strictEqual(r2.skipped, 'slot-locked');
    assert.strictEqual(r2.slot, '1000');
    assert.strictEqual(r3.skipped, 'slot-locked');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.skipped, undefined);
    assert.strictEqual(a.odds.length, PER_PULL);
    assert.strictEqual(a.closesHit.length, 0);
    assert.ok(await kv.read(`pulls/${DATE}/1000`));
  });

  await check('an expired lock can be taken over', async () => {
    const kv = memKv();
    const old = new Date(T0.getTime() - LOCK_TTL_MS - 60000).toISOString();
    await kv.write(pullLockKey(DATE, '0300'), { holder: 'stale', acquiredAt: old, ttlMs: LOCK_TTL_MS });
    const a = pullDeps(kv);
    const res = json(await cap3.handle({ headers: {} }, a.deps));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, undefined);
    assert.strictEqual(a.odds.length, PER_PULL);
    assert.strictEqual(a.closesHit.length, 1);
    const lock = await kv.read(pullLockKey(DATE, '0300'));
    assert.notStrictEqual(lock.holder, 'stale');
  });

  await check('a lock store error fails open and still pulls', async () => {
    const kv = memKv();
    let reads = 0;
    const errors = [];
    const orig = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      const a = pullDeps(kv, {
        read: async (key) => {
          reads += 1;
          if (reads === 1) throw new Error('blob down');
          return kv.read(key);
        },
      });
      const res = json(await cap3.handle({ headers: {} }, a.deps));
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.skipped, undefined);
      assert.strictEqual(a.odds.length, PER_PULL);
      assert.strictEqual(a.closesHit.length, 1);
      assert.ok(errors.some((line) => /failed open/.test(line)));
    } finally {
      console.error = orig;
    }
  });

  await check('flag off restores three full pulls', async () => {
    const kv = memKv();
    const odds = [];
    const closesHit = [];
    const base = {
      env: { ODDS_API_KEY: 'test-key', URL: 'https://webetsocial.com', OMEGA_PULL_SLOT_LOCK: 'off' },
      dateISO: DATE,
      read: (key) => kv.read(key),
      write: (key, value) => kv.write(key, value),
      apiKey: 'test-key',
      oddsFetch: async (url) => { odds.push(String(url)); return oddsOk(); },
      fetch: async (url) => { closesHit.push(String(url)); return { ok: true, status: 200 }; },
    };
    for (let i = 0; i < 3; i += 1) {
      const res = json(await cap3.handle({ headers: {} }, Object.assign({}, base, { now: new Date(T0.getTime() + i * 15000) })));
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.skipped, undefined);
    }
    assert.strictEqual(odds.length, PER_PULL * 3);
    assert.strictEqual(closesHit.length, 3);
  });

  await check('a completed pull doc is slot-done and force=1 needs the secret', async () => {
    const kv = memKv();
    await kv.write(`pulls/${DATE}/0300`, { date: DATE, slot: '0300', at: T0.toISOString(), games: 1 });
    const quiet = pullDeps(kv);
    const skipped = json(await cap3.handle({ headers: {} }, quiet.deps));
    assert.strictEqual(skipped.skipped, 'slot-done');
    assert.strictEqual(quiet.odds.length, 0);
    assert.strictEqual(quiet.closesHit.length, 0);
    const bare = pullDeps(kv);
    const noSecret = json(await cap3.handle({
      headers: {},
      queryStringParameters: { force: '1' },
    }, bare.deps));
    assert.strictEqual(noSecret.skipped, 'slot-done');
    assert.strictEqual(bare.odds.length, 0);
    const authed = pullDeps(kv, { env: { PICKS_SECRET_KEY: 'secret' } });
    const forced = json(await cap3.handle({
      headers: { 'x-picks-secret': 'secret' },
      body: JSON.stringify({ force: 1 }),
    }, authed.deps));
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(forced.skipped, undefined);
    assert.strictEqual(authed.odds.length, PER_PULL);
    assert.strictEqual(authed.closesHit.length, 1);
  });

  await check('closes worker and track-clv each run once per date', async () => {
    const kv = memKv();
    const tracks = [];
    const odds = [];
    const event = {
      headers: { 'x-picks-secret': 'secret' },
      body: JSON.stringify({ scheduled: true }),
    };
    const env = {
      PICKS_SECRET_KEY: 'secret',
      OMEGA_PULL_SLOT_LOCK: 'on',
      OMEGA_CLOSES_AT_3AM: 'on',
      OMEGA_CLOSES_HISTORICAL: 'off',
    };
    const blobs = {
      async get() { return null; },
      async set() { return true; },
      async list() { return []; },
    };
    for (let i = 0; i < 3; i += 1) {
      const res = await closes.handle(event, {
        env,
        now: new Date(T0.getTime() + i * 15000),
        lockRead: (key) => kv.read(key),
        lockWrite: (key, value) => kv.write(key, value),
        blobs,
        slateEvents: [],
        card: { picks: [] },
        skipGrade: true,
        skipMirror: true,
        invokeTrack: async () => { tracks.push('track'); return { ok: true, status: 200 }; },
        writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
        fetch: async (url) => { odds.push(String(url)); throw new Error('odds ' + url); },
      });
      const body = json(res);
      if (i === 0) {
        assert.strictEqual(body.skipped, undefined);
        assert.strictEqual(body.calls, 0);
      } else {
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.skipped, 'slot-locked');
      }
    }
    assert.strictEqual(tracks.length, 1);
    assert.strictEqual(odds.length, 0);
    assert.ok(await kv.read(closesLockKey('2026-11-16')));

    const trackHits = [];
    const store = { async get() { return null; } };
    for (let i = 0; i < 3; i += 1) {
      const res = await track.handle({
        headers: {},
        body: JSON.stringify({ date: '2026-11-16', storedCloses: true, sweep: true }),
      }, {
        env: { OMEGA_PULL_SLOT_LOCK: 'on', OMEGA_CLOSES_AT_3AM: 'on', OMEGA_CLV_TRUE_CLOSE: 'off' },
        now: new Date(T0.getTime() + i * 15000),
        store,
        lockRead: (key) => kv.read(key),
        lockWrite: (key, value) => kv.write(key, value),
        fetch: async (url) => { trackHits.push(String(url)); throw new Error('net ' + url); },
      });
      const body = json(res);
      if (i === 0) assert.notStrictEqual(body.skipped, 'slot-locked');
      else assert.strictEqual(body.skipped, 'slot-locked');
    }
    assert.ok(trackHits.every((url) => !url.includes('the-odds-api.com')));
    assert.ok(await kv.read(trackLockKey('2026-11-16')));
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('pull slot lock ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
