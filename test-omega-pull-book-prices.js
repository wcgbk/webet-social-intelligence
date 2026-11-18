#!/usr/bin/env node
'use strict';
// 10 AM (and 3 AM) pulls upsert clv.book_prices. OMEGA_PULL_BOOK_PRICES=off skips it.
// No Odds API call in this file. The backfill reader uses the same upsert.
const assert = require('assert');
const { upsertPulledBookPrices, loadSlotEvents } = require('./netlify/functions/lib/odds-master/book-prices');
const { runOddsMasterPull } = require('./netlify/functions/lib/odds-master/pull');

const AT = '2026-11-18T11:30:00.000Z'; // 6:30 AM ET. slotFor() would say "other".
const TIP = '2026-11-18T23:00:00.000Z';
const NEXT = '2026-11-19T23:00:00.000Z';

function event(id, home, away, commence, books) {
  return {
    id,
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: books,
  };
}

function book(key, price) {
  return {
    key,
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'Home Team', price: -price },
        { name: 'Away Team', price },
      ],
    }],
  };
}

const board = {
  NCAAM: [
    event('g1', 'Home Team', 'Away Team', TIP, [book('pinnacle', 140), book('not-a-saved-book', 150)]),
    event('tomorrow', 'Home Team', 'Away Team', NEXT, [book('pinnacle', 130)]),
  ],
};

function headers(extra) {
  const map = Object.assign({
    'x-requests-remaining': '44000',
    'x-requests-used': '12',
  }, extra || {});
  return { get(name) { return map[String(name).toLowerCase()] || null; } };
}

async function main() {
  let calls = 0;
  const off = await upsertPulledBookPrices({
    dateISO: '2026-11-18',
    slot: '1000',
    at: AT,
    eventsBySport: board,
    env: { OMEGA_PULL_BOOK_PRICES: 'off', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' },
    fetchImpl: async () => { calls += 1; throw new Error('supabase must not be called'); },
  });
  assert.deepStrictEqual(off, { skipped: 'flag-off' });
  assert.strictEqual(calls, 0);

  const empty = await upsertPulledBookPrices({
    dateISO: '2026-11-18',
    slot: '1000',
    at: AT,
    eventsBySport: { NCAAM: [] },
    env: {},
    fetchImpl: async () => { calls += 1; throw new Error('empty board must not require supabase'); },
  });
  assert.deepStrictEqual(empty, { upserted: 0 });
  assert.strictEqual(calls, 0);

  const posted = [];
  const on = await upsertPulledBookPrices({
    dateISO: '2026-11-18',
    slot: '1000',
    at: AT,
    eventsBySport: board,
    env: { SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' },
    fetchImpl: async (url, opts) => {
      assert.ok(String(url).includes('/book_prices'), url);
      assert.ok(!String(url).includes('the-odds-api.com'));
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 201 };
    },
  });
  assert.strictEqual(on.upserted, 1);
  assert.strictEqual(posted.length, 1);
  const row = posted[0][0];
  assert.strictEqual(row.game_id, 'g1');
  assert.strictEqual(row.book, 'pinnacle');
  assert.strictEqual(row.slot, '1000');
  assert.strictEqual(row.snapshot_ts, AT);
  assert.strictEqual(row.date, '2026-11-18');
  assert.ok(row.markets.h2h.away.price === 140);
  assert.ok(!posted[0].some((item) => item.book === 'not-a-saved-book' || item.game_id === 'tomorrow'));
  assert.ok(!JSON.stringify(posted).includes('service-key-value'));

  const kv = new Map();
  const read = async (key) => (kv.has(key) ? kv.get(key) : null);
  const write = async (key, value) => { kv.set(key, value); return true; };
  let oddsCalls = 0;
  const pull = await runOddsMasterPull({
    slot: '1000',
    dateISO: '2026-11-18',
    now: new Date(AT),
    env: { ODDS_API_KEY: 'test-key', OMEGA_PULL_SLOT_LOCK: 'off', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' },
    read,
    write,
    apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      const href = String(url);
      if (href.includes('the-odds-api.com')) {
        oddsCalls += 1;
        const sport = href.includes('basketball_ncaab') ? board.NCAAM : [];
        return { ok: true, status: 200, headers: headers(), json: async () => sport };
      }
      assert.ok(href.includes('/book_prices'), href);
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 201, headers: headers() };
    },
  });
  assert.strictEqual(pull.slot, '1000');
  assert.ok(pull.bookPrices.upserted >= 1);
  assert.strictEqual(oddsCalls, 6);
  assert.ok(kv.get('pulls/2026-11-18/1000').at);

  const loaded = await loadSlotEvents('2026-11-18', '1000', read);
  assert.strictEqual(loaded.at, pull.at);
  assert.ok(loaded.eventsBySport.NCAAM.some((ev) => ev.id === 'g1'));
  assert.ok(!loaded.eventsBySport.NCAAM.some((ev) => ev.id === 'tomorrow'));

  const failed = await runOddsMasterPull({
    slot: '0300',
    dateISO: '2026-11-18',
    now: new Date('2026-11-18T08:00:00.000Z'),
    env: { ODDS_API_KEY: 'test-key', OMEGA_PULL_SLOT_LOCK: 'off', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' },
    read,
    write,
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('the-odds-api.com')) {
        return { ok: true, status: 200, headers: headers(), json: async () => board.NCAAM };
      }
      return { ok: false, status: 500, text: async () => 'nope' };
    },
  });
  assert.strictEqual(failed.games > 0, true);
  assert.ok(failed.errors.some((line) => line.startsWith('book-prices:')));
  assert.ok(kv.get('pulls/2026-11-18/0300').at);
  const again = await runOddsMasterPull({
    slot: '0300',
    dateISO: '2026-11-18',
    now: new Date('2026-11-18T08:05:00.000Z'),
    env: { ODDS_API_KEY: 'test-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' },
    read,
    write,
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('paid pull must not retry'); },
  });
  assert.strictEqual(again.skipped, 'slot-done');

  console.log('test-omega-pull-book-prices: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
