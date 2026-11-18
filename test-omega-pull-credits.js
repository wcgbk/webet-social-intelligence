#!/usr/bin/env node
'use strict';
// 3 AM and 10 AM pulls save x-requests-remaining into credits/{date}.
// OMEGA_PULL_CREDITS_PERSIST=off skips the write. No extra Odds API call.
const assert = require('assert');
const { persistPullCredits, CREDIT_STORE } = require('./netlify/functions/lib/odds-master/credits');
const { runOddsMasterPull } = require('./netlify/functions/lib/odds-master/pull');
const { latestRemaining, creditStatus } = require('./netlify/functions/lib/omega-vnext/daily_check');

const DATE = '2026-11-18';
const AT = '2026-11-18T15:00:00.000Z';
const CLOSE_AT = '2026-11-18T08:00:00.000Z';

function resp(remaining, used) {
  const map = {};
  if (remaining != null) map['x-requests-remaining'] = String(remaining);
  if (used != null) map['x-requests-used'] = String(used);
  return { headers: { get(name) { return map[String(name).toLowerCase()] || null; } } };
}

function mem() {
  const kv = new Map();
  return {
    kv,
    async read(key, store) { return kv.has(`${store}:${key}`) ? kv.get(`${store}:${key}`) : null; },
    async write(key, value, store) { kv.set(`${store}:${key}`, value); return true; },
  };
}

async function main() {
  const prior = {
    date: DATE,
    used: 5,
    remaining: 50000,
    calls: [{
      at: CLOSE_AT,
      path: 'closes-3am-historical',
      sport: 'NCAAM',
      remaining: 50000,
      estCost: 0,
    }],
  };
  const store = mem();
  await store.write(`credits/${DATE}`, prior, CREDIT_STORE);
  const off = await persistPullCredits({
    dateISO: DATE,
    slot: '1000',
    at: AT,
    responses: [{ sport: 'NCAAM', resp: resp(44000, 12) }],
    env: { OMEGA_PULL_CREDITS_PERSIST: 'off' },
    read: store.read,
    write: store.write,
  });
  assert.deepStrictEqual(off, { skipped: 'flag-off' });
  assert.strictEqual((await store.read(`credits/${DATE}`, CREDIT_STORE)).used, 5);
  assert.strictEqual((await store.read(`credits/${DATE}`, CREDIT_STORE)).calls.length, 1);

  const quiet = await persistPullCredits({
    dateISO: DATE,
    slot: '1000',
    at: AT,
    responses: [{ sport: 'NCAAM', resp: resp(null, 12) }],
    env: {},
    read: store.read,
    write: store.write,
  });
  assert.deepStrictEqual(quiet, { wrote: false, calls: 0 });
  assert.strictEqual((await store.read(`credits/${DATE}`, CREDIT_STORE)).calls.length, 1);

  const wrote = await persistPullCredits({
    dateISO: DATE,
    slot: '1000',
    at: AT,
    responses: [
      { sport: 'NCAAM', resp: resp(44000, 12) },
      { sport: 'NBA', resp: resp(43991, 21) },
    ],
    env: {},
    read: store.read,
    write: store.write,
  });
  assert.strictEqual(wrote.wrote, true);
  assert.strictEqual(wrote.calls, 2);
  assert.strictEqual(wrote.remaining, 43991);
  const doc = await store.read(`credits/${DATE}`, CREDIT_STORE);
  assert.strictEqual(doc.used, 5);
  assert.strictEqual(doc.calls.length, 3);
  assert.strictEqual(doc.calls[0].path, 'closes-3am-historical');
  assert.ok(doc.calls.every((call) => call.path !== 'closes-3am-historical' || call === doc.calls[0]));
  assert.ok(doc.calls.some((call) => call.path === 'odds-master-1000' && call.sport === 'NBA' && call.remaining === 43991 && call.used === 21));
  const again = await persistPullCredits({
    dateISO: DATE,
    slot: '1000',
    at: AT,
    responses: [{ sport: 'NCAAM', resp: resp(44000, 12) }],
    env: {},
    read: store.read,
    write: store.write,
  });
  assert.strictEqual(again.calls, 0);
  assert.strictEqual((await store.read(`credits/${DATE}`, CREDIT_STORE)).calls.length, 3);

  const samples = doc.calls.map((call) => ({ remaining: call.remaining, at: call.at, source: 'clv-close-capture' }));
  const latest = latestRemaining(samples);
  assert.strictEqual(latest.remaining, 43991);
  assert.strictEqual(creditStatus(latest.remaining, latest.source).code, 'ok');
  assert.notStrictEqual(creditStatus(null).code, 'ok');

  const kv = new Map();
  let oddsCalls = 0;
  const pull = await runOddsMasterPull({
    slot: '0300',
    dateISO: DATE,
    now: new Date(AT),
    env: { ODDS_API_KEY: 'test-key', OMEGA_PULL_SLOT_LOCK: 'off', OMEGA_PULL_BOOK_PRICES: 'off' },
    read: async (key, store) => kv.get(`${store || 'odds-master'}:${key}`) || null,
    write: async (key, value, store) => { kv.set(`${store || 'odds-master'}:${key}`, value); return true; },
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      const href = String(url);
      assert.ok(href.includes('the-odds-api.com'), href);
      oddsCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return String(name).toLowerCase() === 'x-requests-remaining' ? '42000' : null; } },
        json: async () => [],
      };
    },
  });
  assert.strictEqual(oddsCalls, 6);
  assert.strictEqual(pull.credits.remaining, 42000);
  const saved = kv.get(`${CREDIT_STORE}:credits/${DATE}`);
  assert.ok(saved);
  assert.strictEqual(saved.calls.length, 6);
  assert.ok(saved.calls.every((call) => call.path === 'odds-master-0300' && call.remaining === 42000));
  assert.ok(!JSON.stringify(saved).includes('test-key'));

  console.log('test-omega-pull-credits: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
