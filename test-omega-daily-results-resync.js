#!/usr/bin/env node
// Stale clv.daily_results is replaced by the graded day. KPI math is gradeDay. No network.
'use strict';

const assert = require('assert');
const grader = require('./netlify/functions/get-results-omega')._test;
const mirror = require('./netlify/functions/lib/supa-mirror');

const DATE = '2026-11-16';

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

function finalGame(sport, away, home, awayScore, homeScore) {
  return {
    _sport: sport,
    awayTeam: away,
    homeTeam: home,
    awayAbbr: '',
    homeAbbr: '',
    awayScore,
    homeScore,
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
  };
}

function memBlobs(seed) {
  const data = new Map();
  for (const [key, value] of Object.entries(seed || {})) data.set(key, JSON.parse(JSON.stringify(value)));
  return {
    data,
    async get(store, key) {
      const id = `${store}:${key}`;
      return data.has(id) ? JSON.parse(JSON.stringify(data.get(id))) : null;
    },
    async set(store, key, value) {
      data.set(`${store}:${key}`, JSON.parse(JSON.stringify(value)));
      return true;
    },
    async list() { return []; },
  };
}

function logFetch(log) {
  return async (url, opts = {}) => {
    const href = String(url);
    assert.ok(!href.includes('the-odds-api.com'), href);
    assert.ok(!href.includes('site.api.espn.com'), href);
    log.push({ url: href, opts });
    return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
  };
}

const picks = {
  picks: [
    { sport: 'NHL', matchup: 'Boston Bruins @ Toronto Maple Leafs', pick: 'Boston Bruins ML', odds: '-110', units: '0.5u' },
    { sport: 'NHL', matchup: 'Chicago Blackhawks @ Detroit Red Wings', pick: 'Chicago Blackhawks ML', odds: '-110', units: '0.5u' },
    { sport: 'NHL', matchup: 'Edmonton Oilers @ Calgary Flames', pick: 'Edmonton Oilers ML', odds: '-110', units: '0.5u' },
  ],
  parlayLegs: [{
    units: '0.25u',
    legs: [
      { sport: 'NHL', matchup: 'Boston Bruins @ Toronto Maple Leafs', pick: 'Boston Bruins ML', odds: '-110' },
      { sport: 'NHL', matchup: 'Chicago Blackhawks @ Detroit Red Wings', pick: 'Chicago Blackhawks ML', odds: '-110' },
      { sport: 'NHL', matchup: 'Edmonton Oilers @ Calgary Flames', pick: 'Edmonton Oilers ML', odds: '-110' },
    ],
  }],
};

const games = [
  finalGame('NHL', 'Boston Bruins', 'Toronto Maple Leafs', 1, 4),
  finalGame('NHL', 'Chicago Blackhawks', 'Detroit Red Wings', 0, 3),
  finalGame('NHL', 'Edmonton Oilers', 'Calgary Flames', 2, 5),
];

const stale = {
  date: DATE, record: '0-0-0', wins: 0, losses: 0, pushes: 0, pending: 3,
  wagered: 0, profit: 0, roi: '--', parlayResult: 'pending', parlayProfit: 0,
};

function dailyPost(log) {
  const hit = log.find((row) => row.url.includes('/daily_results') && row.opts && row.opts.method === 'POST');
  assert.ok(hit, 'daily_results upsert');
  return JSON.parse(hit.opts.body)[0];
}

async function main() {
  const graded = await grader.gradeDay(DATE, picks, { games });
  assert.strictEqual(graded.record, '0-3-0');
  assert.strictEqual(graded.wins, 0);
  assert.strictEqual(graded.losses, 3);
  assert.strictEqual(graded.pending, 0);
  assert.strictEqual(graded.parlayResult, 'loss');

  await check('mirror upserts the settled day over a stale pending cache', async () => {
    const log = [];
    const blobs = memBlobs({
      [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [stale] },
      [`edge-picks-omega:picks-${DATE}`]: picks,
    });
    const live = await mirror.mirrorDay(DATE, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k', OMEGA_DAILY_RESULTS_RESYNC: 'on' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      gradeDay: grader.gradeDay,
      games,
      picks,
    });
    assert.strictEqual(live.counts.daily_results, 1);
    const row = dailyPost(log);
    const expected = mirror.buildResultRows({ days: [graded] }, DATE)[0];
    assert.strictEqual(row.losses, 3);
    assert.strictEqual(row.pending, 0);
    assert.strictEqual(row.wins, 0);
    assert.strictEqual(row.record, '0-3-0');
    assert.strictEqual(row.parlay_result, 'loss');
    assert.strictEqual(row.profit, expected.profit);
    assert.strictEqual(row.parlay_profit, expected.parlay_profit);
    assert.strictEqual(row.wagered, expected.wagered);
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'boardAt'));
  });

  await check('flag off writes the stale cache row', async () => {
    for (const flag of ['off', '0', 'false', 'no']) {
      const log = [];
      const blobs = memBlobs({ [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [stale] } });
      await mirror.mirrorDay(DATE, {
        env: { SUPABASE_SERVICE_ROLE_KEY: 'k', OMEGA_DAILY_RESULTS_RESYNC: flag },
        fetch: logFetch(log),
        blobs,
        parts: ['results'],
        gradeDay: grader.gradeDay,
        games,
        picks,
      });
      const row = dailyPost(log);
      assert.strictEqual(row.pending, 3, flag);
      assert.strictEqual(row.record, '0-0-0', flag);
      assert.strictEqual(row.parlay_result, 'pending', flag);
      assert.strictEqual(row.losses, 0, flag);
    }
  });

  await check('an already-settled cache is kept when the graded day matches', async () => {
    const cacheDay = Object.assign({}, graded, { note: 'cache-copy' });
    const log = [];
    const blobs = memBlobs({ [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [cacheDay] } });
    await mirror.mirrorDay(DATE, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      gradeDay: grader.gradeDay,
      games,
      picks,
    });
    const row = dailyPost(log);
    assert.strictEqual(row.raw.note, 'cache-copy');
    assert.strictEqual(row.losses, 3);
    assert.strictEqual(row.pending, 0);
  });

  await check('a settled mirror is not replaced by a staler grade', async () => {
    const log = [];
    const settled = Object.assign({}, graded, { note: 'already-settled' });
    const blobs = memBlobs({ [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [settled] } });
    await mirror.mirrorDay(DATE, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      gradeDay: async () => stale,
      games,
      picks,
    });
    const row = dailyPost(log);
    assert.strictEqual(row.pending, 0);
    assert.strictEqual(row.losses, 3);
    assert.strictEqual(row.raw.note, 'already-settled');
  });

  await check('missing supabase key soft-fails', async () => {
    const blobs = memBlobs({ [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [stale] } });
    const live = await mirror.mirrorDay(DATE, {
      env: { OMEGA_DAILY_RESULTS_RESYNC: 'on' },
      fetch: async () => { throw new Error('should not fetch'); },
      blobs,
      parts: ['results'],
      gradeDay: grader.gradeDay,
      games,
      picks,
    });
    assert.strictEqual(live.ok, false);
    assert.ok(live.errors.length > 0);
  });

  await check('resync and changed-day upsert write the settled row once', async () => {
    const log = [];
    const fetchImpl = logFetch(log);
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'k' };
    const synced = await mirror.resyncDailyResults(DATE, {
      env,
      fetch: fetchImpl,
      gradeDay: grader.gradeDay,
      games,
      picks,
      resultsCache: { days: [stale] },
    });
    assert.strictEqual(synced.ok, true);
    assert.strictEqual(synced.pending, 0);
    assert.strictEqual(synced.record, '0-3-0');
    assert.strictEqual(dailyPost(log).parlay_result, 'loss');

    log.length = 0;
    const same = await mirror.upsertChangedDailyResults(
      { days: [graded] },
      { days: [graded] },
      { env, fetch: fetchImpl }
    );
    assert.strictEqual(same.upserted, 0);
    assert.strictEqual(log.length, 0);

    const changed = await mirror.upsertChangedDailyResults(
      { days: [stale] },
      { days: [graded] },
      { env, fetch: fetchImpl }
    );
    assert.strictEqual(changed.upserted, 1);
    assert.strictEqual(dailyPost(log).losses, 3);
    assert.strictEqual(dailyPost(log).pending, 0);

    log.length = 0;
    const off = await mirror.upsertChangedDailyResults(
      { days: [stale] },
      { days: [graded] },
      { env: { SUPABASE_SERVICE_ROLE_KEY: 'k', OMEGA_DAILY_RESULTS_RESYNC: 'off' }, fetch: fetchImpl }
    );
    assert.strictEqual(off.skipped, 'flag-off');
    assert.strictEqual(log.length, 0);

    const cold = await mirror.upsertChangedDailyResults(null, { days: [graded] }, { env, fetch: fetchImpl });
    assert.strictEqual(cold.upserted, 1);
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('daily results resync ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
