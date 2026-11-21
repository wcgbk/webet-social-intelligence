#!/usr/bin/env node
// A killed 10 AM pull finishes from the checkpoint. No second Odds API call.
'use strict';

const assert = require('assert');
const cap10 = require('./netlify/functions/capture-odds-10am');
const { loadMasterBoard } = require('./netlify/functions/lib/odds-master/board');
const { planWrites } = require('./netlify/functions/lib/odds-master/pull');
const { pullLockKey } = require('./netlify/functions/lib/slot-lock');

const DATE = '2026-11-21';
const AT = '2026-11-21T15:01:01.749Z';
const NOW = new Date('2026-11-21T15:05:00.000Z');
const A03 = '2026-11-21T08:01:00.532Z';

function memKv() {
  const data = new Map();
  return {
    async read(key) {
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null;
    },
    async write(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
    get(key) { return data.has(key) ? data.get(key) : null; },
  };
}

function ncaamEvent() {
  return {
    id: 'sp1',
    home_team: 'Saint Peters',
    away_team: 'Stony Brook',
    commence_time: '2026-11-21T23:00:00Z',
    bookmakers: [],
  };
}

function seedKilled(kv, acquiredAt) {
  kv.write(`pulls/${DATE}/1000/checkpoint`, {
    phase: 'fetched',
    at: AT,
    date: DATE,
    slot: '1000',
    sports: ['NCAAM'],
    errors: [],
    credits: [{ sport: 'NCAAM', remaining: 77306, used: 12 }],
  });
  kv.write(`pulls/${DATE}/1000/fetched/NCAAM`, [ncaamEvent()]);
  kv.write(pullLockKey(DATE, '1000'), {
    holder: 'dead-holder',
    acquiredAt,
    ttlMs: 20 * 60 * 1000,
  });
}

function deps(kv, extra) {
  let fetches = 0;
  const env = Object.assign({
    ODDS_API_KEY: 'test-key',
    OMEGA_PULL_SLOT_LOCK: 'on',
    OMEGA_PULL_RESUME: 'on',
    OMEGA_PULL_BOOK_PRICES: 'off',
    OMEGA_PULL_CREDITS_PERSIST: 'on',
  }, extra && extra.env);
  return {
    fetches: () => fetches,
    deps: {
      env,
      dateISO: DATE,
      now: (extra && extra.now) || NOW,
      read: (key) => kv.read(key),
      write: (key, value) => kv.write(key, value),
      apiKey: 'test-key',
      oddsFetch: async () => {
        fetches += 1;
        throw new Error('odds fetch not allowed');
      },
    },
  };
}

function json(res) {
  return JSON.parse(res.body);
}

async function main() {
  {
    const kv = memKv();
    await seedKilled(kv, AT);
    const run = deps(kv);
    const res = await cap10.handle({ headers: {} }, run.deps);
    const body = json(res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.skipped, undefined);
    assert.strictEqual(run.fetches(), 0, 'resume must not call the Odds API');
    const doc = await kv.read(`pulls/${DATE}/1000`);
    assert.strictEqual(doc.phase, 'complete');
    assert.strictEqual(doc.at, AT);
    assert.strictEqual(doc.games, 1);
    assert.strictEqual(doc.credits.remaining, 77306);
    const byDate = await kv.read(`by-date/${DATE}`);
    assert.strictEqual(byDate.updatedAt, AT);
    assert.strictEqual(byDate.events.length, 1);
    const lock = await kv.read(pullLockKey(DATE, '1000'));
    assert.notStrictEqual(lock.holder, 'dead-holder');
    console.log('  ok  stale lock resumes from checkpoint with zero fetches');
  }

  {
    const kv = memKv();
    const freshAt = new Date(NOW.getTime() - 5000).toISOString();
    await seedKilled(kv, freshAt);
    const run = deps(kv);
    const res = await cap10.handle({ headers: {} }, run.deps);
    const body = json(res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.skipped, 'slot-locked');
    assert.strictEqual(body.resumable, true);
    assert.strictEqual(run.fetches(), 0);
    assert.strictEqual(await kv.read(`pulls/${DATE}/1000`), null);
    console.log('  ok  fresh lock with a checkpoint returns 503 and does not fetch');
  }

  {
    const kv = memKv();
    await seedKilled(kv, AT);
    const run = deps(kv, { env: { OMEGA_PULL_RESUME: 'off' } });
    const res = await cap10.handle({ headers: {} }, run.deps);
    const body = json(res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.skipped, 'slot-locked');
    assert.strictEqual(body.resumable, false);
    assert.strictEqual(run.fetches(), 0);
    assert.strictEqual(await kv.read(`pulls/${DATE}/1000`), null);
    console.log('  ok  OMEGA_PULL_RESUME=off does not finish the checkpoint');
  }

  {
    const ev = {
      id: 'ev1', sport: 'americanfootball_nfl', home_team: 'Home', away_team: 'Away',
      commence_time: '2026-11-21T23:00:00Z',
      bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -150 }, { name: 'Away', price: 130 }] }] }],
    };
    const open = planWrites({ NFL: [ev] }, '0300', A03, DATE);
    const late = planWrites({ NFL: [ev] }, '1000', AT, DATE);
    const store = {};
    for (const w of open.writes) if (!w.merge) store[w.key] = w.data;
    for (const w of late.writes) if (!w.merge) store[w.key] = w.data;
    store[`by-date/${DATE}`] = { date: DATE, events: open.events };
    store['index/NFL/ev1'] = {
      sport: 'NFL', eventId: 'ev1', books: ['pinnacle'],
      baseline0300: { at: A03 },
      checks: { '1000': { at: AT } },
    };
    const read = async (key) => store[key] || null;
    const partial = await loadMasterBoard(DATE, read, { OMEGA_PULL_RESUME: 'on' });
    assert.ok(partial);
    assert.deepStrictEqual(partial.polls.map((p) => p.hhmm), ['0300']);
    assert.strictEqual(partial.at1000, null);
    const home = partial.eventsBySport.NFL[0].bookmakers[0].markets[0].outcomes.find((o) => o.name === 'Home');
    assert.strictEqual(home.price, -150);
    store[`pulls/${DATE}/1000`] = { date: DATE, slot: '1000', at: AT, phase: 'complete' };
    const full = await loadMasterBoard(DATE, read, { OMEGA_PULL_RESUME: 'on' });
    assert.deepStrictEqual(full.polls.map((p) => p.hhmm), ['0300', '1000']);
    const legacy = await loadMasterBoard(DATE, async (key) => (key === `pulls/${DATE}/1000` ? null : store[key] || null), { OMEGA_PULL_RESUME: 'off' });
    assert.deepStrictEqual(legacy.polls.map((p) => p.hhmm), ['0300', '1000']);
    console.log('  ok  incomplete 1000 is not a usable snap; =off keeps the stamp');
  }

  console.log('test-omega-pull-resume: ALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
