'use strict';
/** Omega historical replay — store isolation + range guards. No network. */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const store = require(path.join(root, 'store'));
const replay = require(path.join(root, 'replay'));

assert.ok(store.REPLAY_KEY_RE);
assert.doesNotThrow(() => store.assertReplayKey('omega-replay/run1/picks-2026-09-15'));
assert.doesNotThrow(() => store.assertReplayKey('omega-replay/run1/summary'));
for (const bad of [
  'picks-2026-09-22',
  'picks-2026-09-15',
  'latest-date',
  'picks-dates',
  'picks-sim-2026-09-22',
  'omega-replay/run1/../picks-2026-09-22',
  'omega-replay//picks-2026-09-15',
]) {
  assert.throws(() => store.assertReplayKey(bad), /refused/, bad);
}

const { dates, truncated } = replay.parseDateRange('2026-09-15', '2026-09-30', { maxDays: 7 });
assert.strictEqual(dates.length, 7);
assert.strictEqual(dates[0], '2026-09-15');
assert.strictEqual(dates[6], '2026-09-21');
assert.strictEqual(truncated, true);

assert.strictEqual(replay.historicalTimestampForDate('2026-09-18'), '2026-09-18T13:00:00Z');
assert.strictEqual(replay.estimateQuotaCalls(7, ['MLB', 'NFL', 'NCAAF']), 21);

const summary = replay.summarizeReplay({
  runId: 't', dryRun: true, from: '2026-09-15', to: '2026-09-16',
  estimatedOddsCalls: 6,
  days: [{ date: '2026-09-15', nPicks: 2 }, { date: '2026-09-16', nPicks: 0 }],
});
assert.strictEqual(summary.nDays, 2);
assert.strictEqual(summary.nPicks, 2);
assert.strictEqual(summary.clvPlaceholder, null);
assert.strictEqual(summary.roiPlaceholder, null);
assert.ok(summary.notes.some(n => /never wrote live/i.test(n)));

let storePicksCalled = false;
const fakeGenerate = async (opts) => {
  assert.strictEqual(opts.dryRun, true, 'generate must be dry for live store');
  assert.ok(opts.historicalSnapshot);
  assert.strictEqual(opts.skipNarrate, true);
  return { date: opts.date, model: 'test', picks: [{ pick: 'A' }], parlayLegs: [] };
};

(async () => {
  const day = await replay.runReplayDay({
    dateISO: '2026-09-18',
    dryRun: true,
    runId: 'unit',
    skipNarrate: true,
    generateFn: fakeGenerate,
  });
  assert.strictEqual(day.nPicks, 1);
  assert.strictEqual(day.key, null);
  assert.strictEqual(day.dryRun, true);

  // Patch storePicks to detect live writes
  const orig = store.storePicks;
  store.storePicks = async () => { storePicksCalled = true; throw new Error('should not write live'); };
  const range = await replay.runReplayRange({
    from: '2026-09-18', to: '2026-09-19', dryRun: true, maxDays: 2,
    runId: 'unit-range', generateFn: fakeGenerate,
  });
  store.storePicks = orig;
  assert.strictEqual(storePicksCalled, false);
  assert.strictEqual(range.days.length, 2);
  assert.strictEqual(range.dryRun, true);
  assert.strictEqual(range.summaryKey, null);

  const idxSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(/skipNarrate/.test(idxSrc));
  const storeSrc = fs.readFileSync(path.join(root, 'store.js'), 'utf8');
  assert.ok(/storeReplayCard/.test(storeSrc));
  assert.ok(/assertReplayKey/.test(storeSrc));
  assert.ok(!/storePicks\(dateISO/.test(storeSrc.slice(storeSrc.indexOf('storeReplayCard'))));

  const doc = fs.readFileSync(path.join(__dirname, 'docs/OMEGA-HISTORICAL-REPLAY.md'), 'utf8');
  assert.ok(/Quota caution/i.test(doc));
  assert.ok(/Never/i.test(doc));
  assert.ok(/dryRun/i.test(doc));

  const fnSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/replay-omega-historical.js'), 'utf8');
  assert.ok(/dryRun/.test(fnSrc));
  assert.ok(!/discord/i.test(fnSrc));

  console.log('PASS test-omega-replay', {
    dates: dates.length,
    estCalls: replay.estimateQuotaCalls(7, ['MLB', 'NFL', 'NCAAF']),
  });
})().catch((e) => { console.error(e); process.exit(1); });
