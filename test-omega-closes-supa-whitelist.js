#!/usr/bin/env node
// clv.games posts omit boardAt. The blob row keeps it. Saved boards only. No network.
'use strict';

const assert = require('assert');
const S = require('./netlify/functions/lib/clv-supabase');
const C = require('./netlify/functions/lib/closes-3am');
const bg = require('./netlify/functions/capture-closes-3am-background');

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

function memBlobs(seed) {
  const data = new Map();
  for (const [key, value] of Object.entries(seed || {})) data.set(key, value);
  return {
    data,
    async get(store, key) {
      const id = `${store}:${key}`;
      return data.has(id) ? data.get(id) : null;
    },
    async set(store, key, value) {
      data.set(`${store}:${key}`, JSON.parse(JSON.stringify(value)));
      return true;
    },
    async list() { return []; },
  };
}

function memKv() {
  const data = new Map();
  return {
    async read(key) { return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null; },
    async write(key, value) { data.set(key, JSON.parse(JSON.stringify(value))); return true; },
  };
}

function boardEvent(id, home, away, commence, bookKey, homePrice, awayPrice) {
  return {
    id,
    commence_time: commence,
    home_team: home,
    away_team: away,
    bookmakers: [{
      key: bookKey,
      last_update: commence,
      markets: [{
        key: 'spreads',
        last_update: commence,
        outcomes: [
          { name: home, price: homePrice, point: -1.5 },
          { name: away, price: awayPrice, point: 1.5 },
        ],
      }],
    }],
  };
}

function putBoard(master, sport, eventId, at03, raw03) {
  master[`index/${sport}/${eventId}`] = { sport, eventId, baseline0300: { at: at03 } };
  master[`${sport}/${eventId}/raw/${at03}`] = raw03;
}

const AT = '2026-11-16T08:00:59Z';
const COMMENCE = '2026-11-16T23:00:00Z';

function masterFor() {
  const master = {};
  putBoard(master, 'NHL', 'bruins', AT, boardEvent('bruins', 'Toronto Maple Leafs', 'Boston Bruins', COMMENCE, 'pinnacle', -118, -102));
  return master;
}

function slate() {
  return [{
    sport: 'NHL', eventId: 'bruins', homeTeam: 'Toronto Maple Leafs', awayTeam: 'Boston Bruins', commenceTime: COMMENCE,
  }];
}

async function postBodies(env, rowExtra) {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    assert.ok(String(url).includes('/rest/v1/'));
    assert.ok(!String(url).includes('the-odds-api.com'));
    bodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => '' };
  };
  const game = Object.assign({
    game_id: 'bruins', sport: 'NHL', season: '2026-27', commence_time: COMMENCE,
    home_team: 'Toronto Maple Leafs', away_team: 'Boston Bruins', source: 'odds-master-board:capture-closes-3am',
    boardAt: AT, slot: '0300',
  }, rowExtra);
  const snap = {
    game_id: 'bruins', sport: 'NHL', book: 'pinnacle', market: 'spreads', side: 'Toronto Maple Leafs',
    point: -1.5, price: -118, line_type: 'closing', snapshot_ts: AT, source: game.source, slot: '0300',
  };
  await S.writeRows({ games: [game], snaps: [snap] }, env, fetchImpl);
  return bodies;
}

async function main() {
  await check('supabase payload drops boardAt and slot; blob row keeps boardAt', async () => {
    const bodies = await postBodies({ SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const game = bodies[0].body[0];
    const snap = bodies[1].body[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(game, 'boardAt'));
    assert.ok(!Object.prototype.hasOwnProperty.call(game, 'slot'));
    assert.strictEqual(game.game_id, 'bruins');
    assert.strictEqual(game.home_team, 'Toronto Maple Leafs');
    assert.ok(S.GAMES_COLUMNS.every((col) => Object.prototype.hasOwnProperty.call(game, col)));
    assert.ok(!Object.prototype.hasOwnProperty.call(snap, 'slot'));
    assert.strictEqual(snap.price, -118);

    const master = masterFor();
    const seen = [];
    const http = [];
    const blobs = memBlobs();
    const run = await C.runCloses({
      now: new Date('2026-11-17T16:00:00Z'),
      env: { OMEGA_CLOSES_HISTORICAL: 'off' },
      date: '2026-11-16',
      slateEvents: slate(),
      blobs,
      readMaster: async (key) => (Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null),
      writeRows: async (built) => {
        seen.push(built);
        return S.writeRows(built, { SUPABASE_SERVICE_ROLE_KEY: 'k' }, async (url, opts) => {
          http.push(JSON.parse(opts.body));
          return { ok: true, status: 201, text: async () => '' };
        });
      },
      storeClose: async () => ({ wrote: true }),
      fetch: async (url) => { throw new Error('odds api must not be called ' + url); },
    });
    assert.deepStrictEqual(run.calls, []);
    assert.strictEqual(seen[0].games[0].slot, '0300');
    assert.strictEqual(seen[0].games[0].boardAt, AT);
    assert.ok(!Object.prototype.hasOwnProperty.call(http[0][0], 'boardAt'));
    assert.ok(!Object.prototype.hasOwnProperty.call(http[0][0], 'slot'));
    const summary = blobs.data.get('clv-close-capture:closes-3am/2026-11-16');
    const row = summary.games.find((gameRow) => gameRow.eventId === 'bruins');
    assert.strictEqual(row.boardAt, AT);
    assert.strictEqual(row.slot, '0300');
    const marker = blobs.data.get('clv-close-capture:done-ev/NHL/bruins');
    assert.strictEqual(marker.boardAt, AT);
    assert.strictEqual(marker.via, 'closes-3am');
  });

  await check('flag off sends boardAt', async () => {
    for (const flag of ['off', '0', 'false', 'no']) {
      const bodies = await postBodies({ SUPABASE_SERVICE_ROLE_KEY: 'k', OMEGA_CLOSES_SUPA_WHITELIST: flag });
      assert.strictEqual(bodies[0].body[0].boardAt, AT, flag);
      assert.strictEqual(bodies[0].body[0].slot, '0300', flag);
      assert.strictEqual(bodies[1].body[0].slot, '0300', flag);
    }
  });

  await check('a failed supabase write leaves no done marker and the next run retries', async () => {
    const master = masterFor();
    const blobs = memBlobs();
    const readMaster = async (key) => (Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null);
    const first = await C.runCloses({
      now: new Date('2026-11-17T16:00:00Z'),
      env: { OMEGA_CLOSES_HISTORICAL: 'off' },
      date: '2026-11-16',
      slateEvents: slate(),
      blobs,
      readMaster,
      writeRows: async () => { throw new Error('PGRST204 boardAt'); },
      fetch: async (url) => { throw new Error('odds api must not be called ' + url); },
    });
    assert.strictEqual(first.games.find((row) => row.eventId === 'bruins').reason, 'write-failed');
    assert.ok(!blobs.data.has('clv-close-capture:done-ev/NHL/bruins'));
    const wrote = [];
    const second = await C.runCloses({
      now: new Date('2026-11-17T16:10:00Z'),
      env: { OMEGA_CLOSES_HISTORICAL: 'off' },
      date: '2026-11-16',
      slateEvents: slate(),
      blobs,
      readMaster,
      writeRows: async (built) => {
        wrote.push(built.games[0].game_id);
        return { games: 1, odds_snapshots: built.snaps.length, requests: 1 };
      },
      storeClose: async () => ({ wrote: true }),
      fetch: async (url) => { throw new Error('odds api must not be called ' + url); },
    });
    assert.deepStrictEqual(wrote, ['bruins']);
    assert.strictEqual(second.games.find((row) => row.eventId === 'bruins').status, 'closed');
    assert.strictEqual(second.games.find((row) => row.eventId === 'bruins').boardAt, AT);
    assert.ok(blobs.data.has('clv-close-capture:done-ev/NHL/bruins'));
    assert.deepStrictEqual(second.calls, []);
  });

  await check('manual past-date rerun uses saved boards and zero Odds API calls', async () => {
    const master = masterFor();
    const blobs = memBlobs();
    const kv = memKv();
    const odds = [];
    const http = [];
    const res = await bg.handle({
      headers: { 'x-picks-secret': 'secret' },
      body: JSON.stringify({ date: '2026-11-16' }),
    }, {
      env: {
        PICKS_SECRET_KEY: 'secret',
        OMEGA_CLOSES_AT_3AM: 'on',
        OMEGA_CLOSES_HISTORICAL: 'off',
        OMEGA_CLOSES_SUPA_WHITELIST: 'on',
      },
      now: new Date('2026-11-17T18:00:00Z'),
      lockRead: (key) => kv.read(key),
      lockWrite: (key, value) => kv.write(key, value),
      blobs,
      slateEvents: slate(),
      readMaster: async (key) => (Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null),
      skipGrade: true,
      skipMirror: true,
      skipTrack: true,
      writeRows: async (built) => S.writeRows(built, { SUPABASE_SERVICE_ROLE_KEY: 'k' }, async (url, opts) => {
        assert.ok(!String(url).includes('the-odds-api.com'));
        http.push(JSON.parse(opts.body));
        return { ok: true, status: 201, text: async () => '' };
      }),
      storeClose: async () => ({ wrote: true }),
      fetch: async (url) => { odds.push(String(url)); throw new Error('odds api must not be called'); },
    });
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.date, '2026-11-16');
    assert.strictEqual(body.calls, 0);
    assert.strictEqual(odds.length, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(http[0][0], 'boardAt'));
    const summary = blobs.data.get('clv-close-capture:closes-3am/2026-11-16');
    assert.strictEqual(summary.games.find((row) => row.eventId === 'bruins').boardAt, AT);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('closes supabase whitelist ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
