#!/usr/bin/env node
// Unit tests for Omega live card date resolution + sticky fallback.
'use strict';

const assert = require('assert');
const {
  todayET,
  tomorrowET,
  hasRealPicks,
  normalizeDateList,
  liveTryDates,
  stickyTryDates,
  resolveCard,
} = require('./netlify/functions/lib/omega-live-date');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + ': ' + e.message);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + ': ' + e.message);
  }
}

(async () => {
  console.log('omega-live-date');

  check('todayET is YYYY-MM-DD', () => {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayET()));
  });

  check('tomorrowET is calendar day after todayET', () => {
    // Fixed instant: Mon 2026-09-21 23:30 ET = Tue 03:30 UTC
    const monEveningUtc = new Date('2026-09-22T03:30:00Z');
    assert.strictEqual(todayET(monEveningUtc), '2026-09-21');
    assert.strictEqual(tomorrowET(monEveningUtc), '2026-09-22');
  });

  check('hasRealPicks requires non-empty picks[]', () => {
    assert.strictEqual(hasRealPicks(null), false);
    assert.strictEqual(hasRealPicks({ picks: [] }), false);
    assert.strictEqual(hasRealPicks({ picks: [{ pick: 'X' }] }), true);
  });

  check('liveTryDates prefers newest ≤ tomorrow (Mon evening → Tue first)', () => {
    const monEveningUtc = new Date('2026-09-22T03:30:00Z');
    const dates = liveTryDates(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-25'], {
      now: monEveningUtc,
    });
    assert.strictEqual(dates[0], '2026-09-22');
    assert.ok(dates.includes('2026-09-21'));
    assert.ok(!dates.includes('2026-09-25'), 'far-future sim must be capped');
  });

  check('stickyTryDates stays at/prior to requested', () => {
    const dates = stickyTryDates(['2026-09-19', '2026-09-20', '2026-09-22'], '2026-09-21');
    assert.deepStrictEqual(dates, ['2026-09-21', '2026-09-20', '2026-09-19']);
  });

  check('normalizeDateList dedupes and sorts', () => {
    assert.deepStrictEqual(
      normalizeDateList(['2026-09-22', '2026-09-21'], '2026-09-22', ['bad', null]),
      ['2026-09-21', '2026-09-22']
    );
  });

  await checkAsync('resolveCard stickies over empty Tue to Mon', async () => {
    const store = {
      '2026-09-22': { date: '2026-09-22', picks: [], noPlays: 'empty' },
      '2026-09-21': { date: '2026-09-21', picks: [{ pick: 'A' }] },
    };
    const resolved = await resolveCard(
      ['2026-09-22', '2026-09-21'],
      async (d) => store[d] || null,
      { requirePicks: true }
    );
    assert.strictEqual(resolved.dateKey, '2026-09-21');
    assert.ok(hasRealPicks(resolved.picksData));
  });

  await checkAsync('resolveCard live prefers Tue when it has picks', async () => {
    const store = {
      '2026-09-22': { date: '2026-09-22', picks: [{ pick: 'MLB Over' }] },
      '2026-09-21': { date: '2026-09-21', picks: [{ pick: 'NFL' }] },
    };
    const resolved = await resolveCard(
      ['2026-09-22', '2026-09-21'],
      async (d) => store[d] || null,
      { requirePicks: true }
    );
    assert.strictEqual(resolved.dateKey, '2026-09-22');
  });

  await checkAsync('Tue morning with only Mon card stickies to Mon', async () => {
    // 2026-09-22T12:00Z = Tue 08:00 ET
    const tueMorning = new Date('2026-09-22T12:00:00Z');
    assert.strictEqual(todayET(tueMorning), '2026-09-22');
    const store = {
      '2026-09-21': { date: '2026-09-21', picks: [{ pick: 'prior' }] },
    };
    const resolved = await resolveCard(
      liveTryDates(['2026-09-21'], { now: tueMorning }),
      async (d) => store[d] || null,
      { requirePicks: true }
    );
    assert.strictEqual(resolved.dateKey, '2026-09-21');
  });

  check('get-picks-omega exports handler', () => {
    const mod = require('./netlify/functions/get-picks-omega');
    assert.strictEqual(typeof mod.handler, 'function');
  });

  if (failed) {
    console.error('\n' + failed + ' failed');
    process.exit(1);
  }
  console.log('\nall passed');
})();
