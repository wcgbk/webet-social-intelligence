#!/usr/bin/env node
// Today's unpublished ET date is not a pass day. A published 0-pick card still is.
// A final ESPN copy beats a stale in-progress copy of the same game.
'use strict';

const assert = require('assert');
const grader = require('./netlify/functions/get-results-omega')._test;
const mirror = require('./netlify/functions/lib/supa-mirror');
const board = require('./netlify/functions/lib/espn-scoreboard');

const TODAY = '2026-11-18';
const YDAY = '2026-11-17';

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

function placeholder(date) {
  return {
    date,
    source: 'no-picks',
    noPlays: true,
    picks: [],
    wins: 0,
    losses: 0,
    pushes: 0,
    pending: 0,
    record: '0-0-0',
    profit: 0,
    parlayResult: 'skip',
  };
}

function passDay(date) {
  return {
    date,
    source: 'omega',
    noPlays: true,
    picks: [],
    wins: 0,
    losses: 0,
    pushes: 0,
    pending: 0,
    record: '0-0-0',
    profit: 0,
    parlayResult: 'skip',
  };
}

function logFetch(log) {
  return async (url, opts = {}) => {
    const href = String(url);
    assert.ok(!href.includes('the-odds-api.com'), href);
    assert.ok(!href.includes('site.api.espn.com'), href);
    log.push({ url: href, opts });
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  };
}

function memBlobs(seed) {
  const data = new Map();
  for (const [key, value] of Object.entries(seed || {})) data.set(key, JSON.parse(JSON.stringify(value)));
  return {
    async get(store, key) {
      const id = `${store}:${key}`;
      return data.has(id) ? JSON.parse(JSON.stringify(data.get(id))) : null;
    },
  };
}

const pendingPicks = {
  _source: 'omega',
  picks: [
    { sport: 'NHL', matchup: 'Boston Bruins @ Toronto Maple Leafs', pick: 'Boston Bruins ML', odds: '-110', units: '0.5u' },
  ],
};

async function main() {
  await check('omit drops today no-picks and keeps a real pass and yesterday', async () => {
    const days = [placeholder(YDAY), passDay(TODAY), placeholder(TODAY), { date: TODAY, source: 'omega', noPlays: false, picks: [{ pick: 'x' }] }];
    const out = grader.omitUnpublishedToday(days, TODAY, {});
    assert.strictEqual(out.length, 3);
    assert.ok(out.some((day) => day.date === YDAY && day.source === 'no-picks'));
    assert.ok(out.some((day) => day.date === TODAY && day.source === 'omega' && day.noPlays));
    assert.ok(!out.some((day) => day.source === 'no-picks' && day.date === TODAY));
  });

  await check('flag off keeps the today placeholder', async () => {
    const days = [placeholder(TODAY)];
    const out = grader.omitUnpublishedToday(days, TODAY, { OMEGA_KPI_TODAY_PENDING: 'off' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].source, 'no-picks');
  });

  await check('a pending card outranks the no-picks placeholder', async () => {
    const graded = await grader.gradeDay(TODAY, pendingPicks, { games: [] });
    assert.ok(graded);
    assert.strictEqual(graded.pending, 1);
    assert.ok(mirror.settlementRank(placeholder(TODAY)) > mirror.settlementRank(graded));
    const chosen = mirror.chooseSettledDay(placeholder(TODAY), graded, {});
    assert.strictEqual(chosen.source, 'omega');
    assert.strictEqual(chosen.noPlays, false);
    assert.strictEqual(chosen.pending, 1);
    const rolled = mirror.chooseSettledDay(placeholder(TODAY), graded, { OMEGA_KPI_TODAY_PENDING: 'off' });
    assert.strictEqual(rolled.source, 'no-picks');
  });

  await check('buildResultRows skips today placeholder and keeps a pass', async () => {
    const opts = { env: {}, todayET: TODAY };
    assert.deepStrictEqual(mirror.buildResultRows({ days: [placeholder(TODAY)] }, TODAY, opts), []);
    const y = mirror.buildResultRows({ days: [placeholder(YDAY)] }, YDAY, opts);
    assert.strictEqual(y.length, 1);
    assert.strictEqual(y[0].no_plays, true);
    const pass = mirror.buildResultRows({ days: [passDay(TODAY)] }, TODAY, opts);
    assert.strictEqual(pass.length, 1);
    assert.strictEqual(pass[0].no_plays, true);
    const off = mirror.buildResultRows({ days: [placeholder(TODAY)] }, TODAY, { env: { OMEGA_KPI_TODAY_PENDING: 'off' }, todayET: TODAY });
    assert.strictEqual(off.length, 1);
    assert.strictEqual(off[0].no_plays, true);
  });

  await check('mirror deletes a stale no_plays row and does not rewrite it', async () => {
    const log = [];
    const blobs = memBlobs({
      [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [placeholder(TODAY)] },
    });
    const live = await mirror.mirrorDay(TODAY, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      todayET: TODAY,
      gradeDay: grader.gradeDay,
      games: [],
      picks: { picks: [] },
    });
    assert.strictEqual(live.ok, true);
    assert.ok(!log.some((row) => row.opts && row.opts.method === 'POST' && row.url.includes('/daily_results')));
    const del = log.find((row) => row.opts && row.opts.method === 'DELETE');
    assert.ok(del, 'delete');
    assert.ok(del.url.includes(`date=eq.${TODAY}`));
    assert.ok(del.url.includes('no_plays=eq.true'));
  });

  await check('mirror overwrites no_plays once the card exists', async () => {
    const log = [];
    const blobs = memBlobs({
      [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [placeholder(TODAY)] },
      [`edge-picks-omega:picks-${TODAY}`]: pendingPicks,
    });
    await mirror.mirrorDay(TODAY, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k', OMEGA_DAILY_RESULTS_RESYNC: 'on' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      todayET: TODAY,
      gradeDay: grader.gradeDay,
      games: [],
      picks: pendingPicks,
    });
    const post = log.find((row) => row.url.includes('/daily_results') && row.opts && row.opts.method === 'POST');
    assert.ok(post, 'upsert');
    const row = JSON.parse(post.opts.body)[0];
    assert.strictEqual(row.no_plays, false);
    assert.strictEqual(row.pending, 1);
    assert.ok(!log.some((row) => row.opts && row.opts.method === 'DELETE'));
  });

  await check('a published pass day is still mirrored', async () => {
    const log = [];
    const blobs = memBlobs({
      [`edge-picks-omega:${mirror.RESULTS_KEY}`]: { days: [passDay(TODAY)] },
    });
    await mirror.mirrorDay(TODAY, {
      env: { SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fetch: logFetch(log),
      blobs,
      parts: ['results'],
      todayET: TODAY,
    });
    const post = log.find((row) => row.url.includes('/daily_results') && row.opts && row.opts.method === 'POST');
    assert.ok(post, 'pass upsert');
    const row = JSON.parse(post.opts.body)[0];
    assert.strictEqual(row.no_plays, true);
    assert.strictEqual(row.date, TODAY);
  });

  await check('changed-day upsert removes a stale today placeholder', async () => {
    const log = [];
    const out = await mirror.upsertChangedDailyResults(
      { days: [placeholder(TODAY), passDay(YDAY)] },
      { days: [passDay(YDAY)] },
      { env: { SUPABASE_SERVICE_ROLE_KEY: 'k' }, fetch: logFetch(log), todayET: TODAY }
    );
    assert.strictEqual(out.upserted, 0);
    const del = log.find((row) => row.opts && row.opts.method === 'DELETE');
    assert.ok(del && del.url.includes(`date=eq.${TODAY}`));
  });

  await check('final beats a stale in-progress copy and a rolled start time', async () => {
    const live = { awayAbbr: 'SHSU', homeAbbr: 'WYO', startISO: '2026-11-18T03:00:00Z', state: 'in', awayScore: 40, homeScore: 41 };
    const final = { awayAbbr: 'SHSU', homeAbbr: 'WYO', startISO: '2026-11-18T03:00Z', state: 'post', completed: true, awayScore: 79, homeScore: 81 };
    const on = board.mergeGames([[live], [final]], {});
    assert.strictEqual(on.length, 1);
    assert.strictEqual(on[0].state, 'post');
    assert.strictEqual(on[0].homeScore, 81);
    const off = board.mergeGames([[live], [final]], { OMEGA_GRADE_FINAL_WINS: 'off' });
    assert.strictEqual(off.length, 2);
    const offSame = board.mergeGames([[live], [Object.assign({}, final, { startISO: live.startISO })]], { OMEGA_GRADE_FINAL_WINS: 'off' });
    assert.strictEqual(offSame.length, 1);
    assert.strictEqual(offSame[0].state, 'in');
  });

  if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
  }
  console.log('kpi today pending ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
