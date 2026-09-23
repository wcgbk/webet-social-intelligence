'use strict';
/** Omega historical replay — store isolation + scored summary. No network. */
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

assert.ok(store.OPS_KEY_RE);
assert.doesNotThrow(() => store.assertOpsKey('omega-ops/capture-health-latest'));
assert.doesNotThrow(() => store.assertOpsKey('omega-ops/capture-health-2026-09-22'));
for (const bad of [
  'picks-2026-09-22',
  'latest-date',
  'picks-dates',
  'omega-ops/other',
  'omega-ops/capture-health',
]) {
  assert.throws(() => store.assertOpsKey(bad), /refused/, bad);
}

const { dates, truncated } = replay.parseDateRange('2026-09-15', '2026-09-30', { maxDays: 7 });
assert.strictEqual(dates.length, 7);
assert.strictEqual(dates[0], '2026-09-15');
assert.strictEqual(dates[6], '2026-09-21');
assert.strictEqual(truncated, true);

assert.strictEqual(replay.historicalTimestampForDate('2026-09-18'), '2026-09-18T13:00:00Z');
assert.strictEqual(replay.estimateQuotaCalls(7, ['MLB', 'NFL', 'NCAAF']), 21);

// Soft-fail summary when no score attached
const emptySummary = replay.summarizeReplay({
  runId: 't', dryRun: true, from: '2026-09-15', to: '2026-09-16',
  estimatedOddsCalls: 6,
  days: [{ date: '2026-09-15', nPicks: 2 }, { date: '2026-09-16', nPicks: 0 }],
});
assert.strictEqual(emptySummary.nDays, 2);
assert.strictEqual(emptySummary.nPicks, 2);
assert.strictEqual(emptySummary.meanClvCents, null);
assert.strictEqual(emptySummary.roiUnits, null);
assert.strictEqual(emptySummary.clvPlaceholder, null);
assert.strictEqual(emptySummary.roiPlaceholder, null);
assert.ok(emptySummary.notes.some(n => /never wrote live/i.test(n)));

// scoreReplayDay with closes + settles
const card = {
  picks: [
    { pickId: 'a', pick: 'Yankees', matchup: 'BOS @ NYY', sport: 'MLB', market: 'Moneyline', odds: '-120', units: '1u' },
    { pickId: 'b', pick: 'Over 8.5', matchup: 'BOS @ NYY', sport: 'MLB', market: 'Total', odds: '-110', units: '0.5u' },
  ],
};
const clvBlob = {
  picks: [
    {
      pickId: 'a', pick: 'Yankees', matchup: 'BOS @ NYY', market: 'Moneyline',
      clv: 0.012, clvCents: 1.2, beatClosing: true, result: 'win', profit: 0.8333, units: '1u', pickTimeOdds: '-120',
    },
  ],
};
const picksBlob = {
  picks: [
    { pickId: 'b', pick: 'Over 8.5', matchup: 'BOS @ NYY', market: 'Total', result: 'loss', odds: '-110', units: '0.5u' },
  ],
};
const scored = replay.scoreReplayDay(card, '2026-09-18', { clvBlob, picksBlob });
assert.strictEqual(scored.nScoredClv, 1);
assert.ok(scored.nScoredSettle >= 1);
assert.strictEqual(scored.meanClvCents, 1.2);
assert.ok(scored.roiUnits != null);
assert.strictEqual(scored.scoreReason, 'partial');

const missing = replay.scoreReplayDay(card, '2026-09-18', { clvBlob: null, picksBlob: null });
assert.strictEqual(missing.nScoredClv, 0);
assert.strictEqual(missing.meanClvCents, null);
assert.strictEqual(missing.scoreReason, 'closes_missing');

const scoredSummary = replay.summarizeReplay({
  runId: 's', dryRun: true, from: '2026-09-18', to: '2026-09-18',
  estimatedOddsCalls: 3,
  days: [{ date: '2026-09-18', nPicks: 2, score: scored }],
});
assert.strictEqual(scoredSummary.meanClvCents, 1.2);
assert.strictEqual(scoredSummary.nScoredClv, 1);
assert.ok(scoredSummary.roiUnits != null);
assert.ok(scoredSummary.notes.some(n => /clv-\{date\}/i.test(n) || /joined/i.test(n)));

const shadowTarget = store.resolvePicksStoreTarget('2026-09-22', { shadow: true, simMode: true });
assert.strictEqual(shadowTarget.key, 'omega-shadow/picks-2026-09-22');
assert.strictEqual(shadowTarget.touchLatestDate, false);
assert.strictEqual(shadowTarget.touchPicksDates, false);
assert.strictEqual(shadowTarget.overwriteGuard, false);
assert.strictEqual(shadowTarget.shadow, true);
const liveTarget = store.resolvePicksStoreTarget('2026-09-22', {});
assert.strictEqual(liveTarget.key, 'picks-2026-09-22');
assert.strictEqual(liveTarget.touchLatestDate, true);
assert.strictEqual(liveTarget.touchPicksDates, true);
assert.strictEqual(liveTarget.overwriteGuard, true);
const shadowDoc = fs.readFileSync(path.join(__dirname, 'docs/OMEGA-SHADOW-DRYRUN.md'), 'utf8');
assert.ok(/omega-shadow\/picks-/.test(shadowDoc));
assert.ok(/latest-date/.test(shadowDoc));
assert.ok(/9:05/.test(shadowDoc));

let storePicksCalled = false;
const fakeGenerate = async (opts) => {
  assert.strictEqual(opts.dryRun, true, 'generate must be dry for live store');
  assert.ok(opts.historicalSnapshot);
  assert.strictEqual(opts.skipNarrate, true);
  return { date: opts.date, model: 'test', picks: [{ pick: 'A', pickId: 'x', odds: '-110', units: '1u' }], parlayLegs: [] };
};

(async () => {
  const day = await replay.runReplayDay({
    dateISO: '2026-09-18',
    dryRun: true,
    runId: 'unit',
    skipNarrate: true,
    generateFn: fakeGenerate,
    readClvFn: async () => null,
    readPicksFn: async () => null,
  });
  assert.strictEqual(day.nPicks, 1);
  assert.strictEqual(day.key, null);
  assert.strictEqual(day.dryRun, true);
  assert.ok(day.score);
  assert.strictEqual(day.score.scoreReason, 'closes_missing');

  const orig = store.storePicks;
  store.storePicks = async () => { storePicksCalled = true; throw new Error('should not write live'); };
  const range = await replay.runReplayRange({
    from: '2026-09-18', to: '2026-09-19', dryRun: true, maxDays: 2,
    runId: 'unit-range', generateFn: fakeGenerate,
    readClvFn: async () => null,
    readPicksFn: async () => null,
  });
  store.storePicks = orig;
  assert.strictEqual(storePicksCalled, false);
  assert.strictEqual(range.days.length, 2);
  assert.strictEqual(range.dryRun, true);
  assert.strictEqual(range.summaryKey, null);
  assert.strictEqual(range.summary.meanClvCents, null);
  assert.ok(range.summary.nDaysMissingCloses >= 1);

  const idxSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(/skipNarrate/.test(idxSrc));
  assert.ok(/emitCaptureHealthOps/.test(idxSrc));
  assert.ok(/OMEGA_OPS_WEBHOOK_URL/.test(idxSrc));
  assert.ok(/storeCaptureHealthSnapshot/.test(idxSrc));
  const storeSrc = fs.readFileSync(path.join(root, 'store.js'), 'utf8');
  assert.ok(/storeReplayCard/.test(storeSrc));
  assert.ok(/assertReplayKey/.test(storeSrc));
  assert.ok(/assertOpsKey/.test(storeSrc));
  assert.ok(!/storePicks\(dateISO/.test(storeSrc.slice(storeSrc.indexOf('storeReplayCard'))));

  const cfg = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  assert.ok(/v12\.3\.5-omega-vnext-replay-score/.test(cfg));

  const doc = fs.readFileSync(path.join(__dirname, 'docs/OMEGA-HISTORICAL-REPLAY.md'), 'utf8');
  assert.ok(/Quota caution/i.test(doc));
  assert.ok(/Never/i.test(doc));
  assert.ok(/dryRun/i.test(doc));
  assert.ok(/scoreReason/i.test(doc));
  assert.ok(/meanClvCents/i.test(doc));

  const fnSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/replay-omega-historical.js'), 'utf8');
  assert.ok(/dryRun/.test(fnSrc));
  assert.ok(!/discord/i.test(fnSrc));

  const getter = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-omega-capture-health.js'), 'utf8');
  assert.ok(/readCaptureHealthLatest/.test(getter));
  assert.ok(/opsOnly/.test(getter));
  assert.ok(!/discord/i.test(getter));

  console.log('PASS test-omega-replay', {
    dates: dates.length,
    estCalls: replay.estimateQuotaCalls(7, ['MLB', 'NFL', 'NCAAF']),
    meanClv: scoredSummary.meanClvCents,
    model: require(path.join(root, 'config')).MODEL_VERSION,
  });
})().catch((e) => { console.error(e); process.exit(1); });
