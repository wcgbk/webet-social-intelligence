'use strict';
/** Omega walk-forward scaffold — observer only, no fit, no live-key writes. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const wf = require(path.join(root, 'walk_forward'));
const store = require(path.join(root, 'store'));
const config = require(path.join(root, 'config'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.0-omega-vnext-game-day');
assert.strictEqual(config.CLV_KPI_FLOOR, '2026-09-22');
assert.strictEqual(wf.KPI_FLOOR, config.CLV_KPI_FLOOR);
assert.strictEqual(wf.OBSERVER_ONLY, true);
assert.strictEqual(wf.FIT_ENABLED, false);
assert.strictEqual(wf.FIT_EARLIEST, '2026-09-29');
assert.strictEqual(wf.getFitParams(), null);
assert.strictEqual(wf.getFitParams({ force: true }), null);

const pick = {
  date: '2026-09-22',
  pickId: 'abc123',
  sport: 'MLB',
  betType: 'Moneyline',
  pick: 'New York Yankees',
  matchup: 'Tampa Bay Rays @ New York Yankees',
  odds: '-115',
  lockSnapshot: { odds: '-115', line: null, book: 'draftkings' },
  coverProb: '55%',
  p_model: 0.57,
  fair_sharp_p: 0.52,
  edgePct: '3.2%',
  units: '1.25u',
  modelVersion: 'v12.3.0-omega-vnext-game-day',
};
const clv = {
  pickId: 'abc123',
  pick: 'New York Yankees',
  matchup: pick.matchup,
  sport: 'MLB',
  market: 'Moneyline',
  pickTimeOdds: '-115',
  closingOdds: '-130',
  clv: 0.021,
  clvCents: 2.1,
  beatClosing: true,
  result: 'win',
};
const sample = wf.buildSampleFromPickClv(pick, clv);
assert.strictEqual(sample.date, '2026-09-22');
assert.strictEqual(sample.pickId, 'abc123');
assert.strictEqual(sample.sport, 'MLB');
assert.strictEqual(sample.market, 'Moneyline');
assert.strictEqual(sample.side, 'New York Yankees');
assert.strictEqual(sample.matchup, pick.matchup);
assert.strictEqual(sample.lockOdds, -115);
assert.strictEqual(sample.closeOdds, -130);
assert.strictEqual(sample.clvCents, 2.1);
assert.strictEqual(sample.beatClosing, true);
assert.strictEqual(sample.coverProb, 0.55);
assert.strictEqual(sample.p_model, 0.57);
assert.strictEqual(sample.fair_sharp_p, 0.52);
assert.strictEqual(sample.edgePct, 3.2);
assert.strictEqual(sample.units, 1.25);
assert.strictEqual(sample.modelVersion, pick.modelVersion);
assert.strictEqual(sample.result, 'win');

const pending = wf.buildSampleFromPickClv(
  { ...pick, pickId: 'pending1', result: 'pending', edgePct: 0.032, coverProb: 0.55, units: 1 },
  { closingOdds: null, clv: null, beatClosing: null }
);
assert.strictEqual(pending.closeOdds, null);
assert.strictEqual(pending.clvCents, null);
assert.strictEqual(pending.beatClosing, null);
assert.strictEqual(pending.edgePct, 3.2);
assert.strictEqual(pending.coverProb, 0.55);
assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'result'), 'pending result is omitted');

const report = wf.buildDailyReport('2026-09-22', [sample, pending]);
assert.strictEqual(report.observerOnly, true);
assert.strictEqual(report.fitEnabled, false);
assert.strictEqual(report.fitApplied, false);
assert.strictEqual(report.date, '2026-09-22');
assert.strictEqual(report.n, 2);
assert.strictEqual(report.graded, 1);
assert.strictEqual(report.kpiFloor, '2026-09-22');
assert.strictEqual(report.notes[0], 'scaffold only — no coefficient fit');
assert.strictEqual(report.bySportMarket.MLB.Moneyline.n, 2);
assert.strictEqual(report.bySportMarket.MLB.Moneyline.graded, 1);
assert.strictEqual(report.bySportMarket.MLB.Moneyline.meanClvCents, 2.1);
assert.strictEqual(report.bySportMarket.MLB.Moneyline.beatClosePct, 100);

const early = wf.planCapture('2026-09-21', { picks: [pick] }, { picks: [clv] });
assert.strictEqual(early.write, false);
assert.strictEqual(early.skipped, true);
assert.strictEqual(early.reason, 'before-kpi-floor');
assert.deepStrictEqual(early.samples, []);

const card = {
  model: 'v12.3.0-omega-vnext-game-day',
  picks: [pick],
  parlayLegs: [{
    legs: [
      pick,
      {
        pickId: 'leg-only',
        sport: 'NFL',
        market: 'Spread',
        pick: 'Bills -2.5',
        matchup: 'Jets @ Bills',
        odds: '-110',
        units: '0.5u',
        coverProb: 0.53,
        p_model: 0.54,
        fair_sharp_p: 0.51,
        edgePct: '2.1%',
        modelVersion: pick.modelVersion,
      },
    ],
  }],
};
const clvBlob = {
  picks: [clv],
  parlayLegs: [{
    pickId: 'leg-only',
    pick: 'Bills -2.5',
    matchup: 'Jets @ Bills',
    sport: 'NFL',
    market: 'Spread',
    closingOdds: '-105',
    clvCents: 0.8,
    beatClosing: true,
    result: 'pending',
  }],
};
const planned = wf.planCapture('2026-09-22', card, clvBlob);
assert.strictEqual(planned.write, true);
assert.strictEqual(planned.samples.length, 2, 'straight + unique parlay leg; no double count');
assert.strictEqual(planned.samplesBlob.fitApplied, false);
assert.strictEqual(planned.samplesBlob.fitEnabled, false);
assert.strictEqual(planned.samplesBlob.observerOnly, true);
assert.strictEqual(planned.samplesBlob.sourceModel, card.model);
assert.strictEqual(planned.report.fitApplied, false);
const leg = planned.samples.find((s) => s.pickId === 'leg-only');
assert.ok(leg);
assert.strictEqual(leg.closeOdds, -105);
assert.strictEqual(leg.clvCents, 0.8);
assert.ok(!Object.prototype.hasOwnProperty.call(leg, 'result'));

const priors = wf.loadOfflinePriors();
assert.strictEqual(priors.role, 'OFFLINE PRIORS ONLY');
assert.strictEqual(priors.appliedToCalibrate, false);
assert.strictEqual(priors.coefficients, null);
assert.strictEqual(priors.fitEnabled, false);
assert.ok(priors.honesty.some((h) => /empirical CLV percentile/i.test(h)));
assert.ok(priors.honesty.some((h) => /2026-09-29/.test(h)));
assert.ok(priors.sources.some((s) => /ON HOLD/.test(s.note) && /not a decade/i.test(s.note)));
assert.ok(priors.sources.some((s) => s.id === 'alpha-public-blobs' && /not an Omega empirical CLV percentile/i.test(s.note)));

const poisoned = wf.sanitizePriors({
  appliedToCalibrate: true,
  coefficients: { Total: 0.1, Spread: 0.2 },
  fitEnabled: true,
  sources: priors.sources,
  honesty: priors.honesty,
});
assert.strictEqual(poisoned.appliedToCalibrate, false);
assert.strictEqual(poisoned.coefficients, null);
assert.strictEqual(poisoned.fitEnabled, false);

const calibrateSrc = fs.readFileSync(path.join(root, 'calibrate.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
assert.strictEqual(wf.assertGeneratorDoesNotReadFit(calibrateSrc, indexSrc), true);
for (const key of wf.FIT_PARAM_KEYS) {
  assert.ok(!calibrateSrc.includes(key), `calibrate.js must not contain ${key}`);
  assert.ok(!indexSrc.includes(key), `index.js must not contain ${key}`);
}
assert.ok(!/walk_forward/.test(calibrateSrc));
assert.ok(!/walk_forward/.test(indexSrc));
assert.ok(!/\bgetFitParams\s*\(/.test(calibrateSrc));
assert.ok(!/\bgetFitParams\s*\(/.test(indexSrc));
assert.ok(/SHRINK_K/.test(calibrateSrc), 'shrink stays on static config K');
assert.ok(/walk-forward/i.test(indexSrc), 'generator documents the separate observer');
assert.throws(
  () => wf.assertGeneratorDoesNotReadFit("const { getFitParams } = require('./walk_forward');\ngetFitParams();", indexSrc),
  /walk_forward|getFitParams|fit/
);

assert.strictEqual(store.WALKFORWARD_KEY_RE.source, wf.WALKFORWARD_KEY_RE.source);
assert.doesNotThrow(() => store.assertWalkforwardKey('omega-walkforward/samples/2026-09-22'));
assert.doesNotThrow(() => store.assertWalkforwardKey('omega-walkforward/reports/2026-09-22'));
assert.doesNotThrow(() => store.assertWalkforwardKey('omega-walkforward/reports/latest'));
assert.doesNotThrow(() => store.assertWalkforwardKey('omega-walkforward/priors-offline'));
for (const bad of [
  'picks-2026-09-22',
  'latest-date',
  'picks-dates',
  'self-optimize-params',
  'omega-walkforward/fit',
  'omega-walkforward/fit/2026-09-29',
  'omega-walkforward/samples/latest',
  'omega-walkforward/samples/../picks-2026-09-22',
  'picks-sim-2026-09-22',
]) {
  assert.throws(() => store.assertWalkforwardKey(bad), /refused/, bad);
}

assert.rejects(
  () => store.storeWalkforwardSamples('2026-09-21-nope', { fitApplied: false }),
  /refused/
);
assert.rejects(
  () => store.storeWalkforwardSamples('2026-09-22', { fitApplied: true, samples: [] }),
  /refused/
);
assert.rejects(
  () => store.storeWalkforwardPriorsOffline({ appliedToCalibrate: true, coefficients: { Total: 0.2 } }),
  /refused/
);

const storeSrc = fs.readFileSync(path.join(root, 'store.js'), 'utf8');
const block = storeSrc.slice(storeSrc.indexOf('function assertWalkforwardKey'));
assert.ok(block.includes('async function storeWalkforwardSamples'));
assert.ok(block.includes('async function storeWalkforwardReport'));
assert.ok(block.includes('async function storeWalkforwardPriorsOffline'));
assert.ok(!/storePicks\(/.test(block));
assert.ok(!/storeJson\(\s*[`'"]picks-/.test(block));
assert.ok(!/storeJson\(\s*[`'"]latest-date/.test(block));
assert.ok(!/storeJson\(\s*[`'"]self-optimize-params/.test(block));
assert.ok(/omega-walkforward\/samples/.test(block));
assert.ok(/omega-walkforward\/reports/.test(block));
assert.ok(/omega-walkforward\/priors-offline/.test(block));

const captureSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-omega-walkforward.js'), 'utf8');
assert.ok(!/discord/i.test(captureSrc));
assert.ok(!/storePicks\(/.test(captureSrc));
assert.ok(!/self-optimize-params/.test(captureSrc));
assert.ok(!/getFitParams\(/.test(captureSrc));
assert.ok(!/calibrateAll\(/.test(captureSrc));
assert.ok(/readPicks\(/.test(captureSrc));
assert.ok(/clv-\$\{dateISO\}/.test(captureSrc));
assert.ok(/storeWalkforwardSamples/.test(captureSrc));

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
assert.ok(/\[functions\."capture-omega-walkforward"\]\s*\n\s*schedule = "15 15 \* \* \*"/.test(toml));

const doc = fs.readFileSync(path.join(__dirname, 'docs/OMEGA-WALKFORWARD-SCAFFOLD.md'), 'utf8');
assert.ok(/scaffold/i.test(doc));
assert.ok(/2026-09-29/.test(doc));
assert.ok(/11:00/.test(doc));
assert.ok(/ON HOLD/.test(doc));
assert.ok(/not a decade/i.test(doc));
assert.ok(/empirical CLV percentile/i.test(doc));
assert.ok(/offline/i.test(doc));
assert.ok(/2026-09-22/.test(doc));
assert.ok(/not regenerated/i.test(doc));

assert.deepStrictEqual(
  wf.datesForRun(null, new Date('2026-09-22T15:00:00Z')),
  ['2026-09-21', '2026-09-22']
);
assert.deepStrictEqual(wf.datesForRun('2026-09-22'), ['2026-09-22']);

console.log('PASS test-omega-walkforward', {
  model: config.MODEL_VERSION,
  fitEnabled: wf.FIT_ENABLED,
  kpiFloor: wf.KPI_FLOOR,
  fitEarliest: wf.FIT_EARLIEST,
});
