'use strict';
// Capture health requires the 3:00 and 10:00 ET pulls. Retired morning slots do not warn.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const linePath = require('./netlify/functions/lib/omega-vnext/line_path');
const { assessPullCaptureHealth, warnCaptureHealth, PULL_SLOTS_ET, RETIRED_MORNING_SLOTS_ET } = linePath;

const DATE = '2026-10-13';
const quote = { home: { price: -110 } };

function morningPolls() {
  return RETIRED_MORNING_SLOTS_ET.map((hhmm) => ({
    hhmm,
    slot: hhmm,
    gameCount: 2,
    games: { a: { homeTeam: 'A' }, b: { homeTeam: 'B' } },
  }));
}

function pinnacleDoc(slots) {
  return {
    events: [{
      sport: 'NFL',
      eventId: 'ev1',
      checks: slots.map((slot) => ({
        slot,
        at: slot === '0300' ? '2026-10-13T07:00:00Z' : '2026-10-13T14:00:00Z',
        books: { pinnacle: quote, draftkings: quote },
      })),
    }],
  };
}

assert.deepStrictEqual(PULL_SLOTS_ET, ['0300', '1000']);
assert.deepStrictEqual(RETIRED_MORNING_SLOTS_ET, ['0600', '0730', '0900', '0915']);

const both = assessPullCaptureHealth(DATE, {
  pinnacleDoc: pinnacleDoc(['0300', '1000']),
  linePath: { path: { polls: [] } },
});
assert.deepStrictEqual(both.requiredSlotsET, ['0300', '1000']);
assert.deepStrictEqual(both.presentSlotsET, ['0300', '1000']);
assert.deepStrictEqual(both.missingSlotsET, []);
assert.strictEqual(both.warning, null);
assert.strictEqual(both.ok, true);
assert.strictEqual(both.hardFail, false);
for (const slot of RETIRED_MORNING_SLOTS_ET) {
  assert.ok(!both.missingSlotsET.includes(slot), slot);
  assert.ok(!both.requiredSlotsET.includes(slot), slot);
}

const morningAbsent = assessPullCaptureHealth(DATE, {
  pinnacleDoc: pinnacleDoc(['0300', '1000']),
});
assert.strictEqual(morningAbsent.warning, null);
assert.deepStrictEqual(morningAbsent.missingSlotsET, []);

const morningOnly = assessPullCaptureHealth(DATE, {
  linePath: { path: { polls: morningPolls() } },
});
assert.deepStrictEqual(morningOnly.presentSlotsET, []);
assert.deepStrictEqual(morningOnly.missingSlotsET, ['0300', '1000']);
assert.ok(morningOnly.warning);
for (const slot of RETIRED_MORNING_SLOTS_ET) {
  assert.ok(!String(morningOnly.warning).includes(slot), slot);
}

const only0300 = assessPullCaptureHealth(DATE, { pinnacleDoc: pinnacleDoc(['0300']) });
assert.deepStrictEqual(only0300.presentSlotsET, ['0300']);
assert.deepStrictEqual(only0300.missingSlotsET, ['1000']);
assert.strictEqual(only0300.hardFail, false);
assert.ok(only0300.warning);
assert.ok(!String(only0300.warning).includes('0600'));

const emptyCheck = assessPullCaptureHealth(DATE, {
  pinnacleDoc: { events: [{ checks: [{ slot: '0300', books: { pinnacle: {} } }, { slot: '1000', books: {} }] }] },
});
assert.deepStrictEqual(emptyCheck.presentSlotsET, []);
assert.strictEqual(emptyCheck.hardFail, true);

const fromRoles = assessPullCaptureHealth(DATE, {
  oddsMaster: {
    prices: {
      a: { role: 'baseline-0300', roles: ['baseline-0300', 'check-0300'] },
      b: { role: 'check-1000', roles: ['check-1000'] },
    },
  },
  linePath: { path: { polls: morningPolls() } },
});
assert.deepStrictEqual(fromRoles.presentSlotsET, ['0300', '1000']);
assert.strictEqual(fromRoles.warning, null);

const fromChecks = assessPullCaptureHealth(DATE, {
  oddsMaster: {
    baseline0300: { at: '2026-10-13T07:00:00Z' },
    checks: { '1000': { at: '2026-10-13T14:00:00Z' } },
  },
});
assert.deepStrictEqual(fromChecks.presentSlotsET, ['0300', '1000']);
assert.strictEqual(fromChecks.warning, null);

const fromCheck0300 = assessPullCaptureHealth(DATE, {
  oddsMaster: { checks: { '0300': { at: '2026-10-13T07:00:00Z' }, '1000': { at: '2026-10-13T14:00:00Z' } } },
});
assert.strictEqual(fromCheck0300.ok, true);

const polls = assessPullCaptureHealth(DATE, {
  linePath: { path: { polls: [
    { hhmm: '0300', slot: '0300', gameCount: 3, games: { a: 1 } },
    { hhmm: '1000', slot: '1000', gameCount: 3, games: { a: 1 } },
    { hhmm: '0600', slot: '0600', gameCount: 0, games: {} },
  ] } },
});
assert.strictEqual(polls.warning, null);
assert.deepStrictEqual(polls.missingSlotsET, []);

const none = assessPullCaptureHealth(DATE, {}, { retriedCapture: true, retryOk: false });
assert.strictEqual(none.hardFail, true);
assert.deepStrictEqual(none.missingSlotsET, ['0300', '1000']);
const warned = warnCaptureHealth(none, DATE);
assert.strictEqual(warned.hardFail, false);
assert.strictEqual(warned.reason, null);
assert.ok(warned.warning);
assert.ok(!String(warned.warning).includes('0600'));

const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
assert.ok(indexSrc.includes('assessPullCaptureHealth'));
assert.ok(!indexSrc.includes('LINE_MOVE.captureSlotsET'));
assert.ok(indexSrc.includes('warnCaptureHealth(captureHealth, dateISO)'));
assert.ok(indexSrc.includes("code: 'CAPTURE_HEALTH'"));

console.log('PASS test-omega-capture-health');
