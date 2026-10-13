'use strict';
/**
 * NFL wind-band and key-number report splits. Display only. No prices change.
 */
const assert = require('assert');
const recal = require('./netlify/functions/lib/omega-vnext/recal_report');

const rows = [
  { sport: 'NFL', market: 'Total', windMph: 10, clv: 0.02, result: 'win' },
  { sport: 'NFL', market: 'Total', weather: { windMph: 16 }, clv: -0.01, result: 'loss' },
  { sport: 'NFL', market: 'Total', fbWeather: { windMph: 30 }, result: 'win' },
  { sport: 'NFL', market: 'Total', result: 'win', clv: 0.05 },
  { sport: 'NFL', market: 'Spread', result: 'push', line: 3 },
  { sport: 'NFL', market: 'Spread', result: 'push', line: -7 },
  { sport: 'NFL', market: 'Spread', result: 'push', line: 6 },
  { sport: 'NFL', market: 'Spread', result: 'win', line: 3 },
  { sport: 'NCAAF', market: 'Total', windMph: 20, clv: 0.04, result: 'win' },
  { sport: 'NFL', market: 'Spread', result: 'push', margin: 3, line: 2.5 },
];

const splits = recal.nflCalibrationSplits(rows);
assert.strictEqual(splits.displayOnly, true);
assert.strictEqual(splits.applied, false);
assert.strictEqual(splits.totalsByWind['under-15'].n, 1);
assert.ok(Math.abs(splits.totalsByWind['under-15'].meanClv - 0.02) < 1e-12);
assert.strictEqual(splits.totalsByWind['15-to-25'].n, 1);
assert.ok(Math.abs(splits.totalsByWind['15-to-25'].meanClv - (-0.01)) < 1e-12);
assert.strictEqual(splits.totalsByWind['25-plus'].n, 1);
assert.strictEqual(splits.totalsByWind['25-plus'].nClv, 0);
assert.strictEqual(splits.totalsByWind['25-plus'].meanClv, null);
assert.strictEqual(splits.keyNumberPushes.spreadPushes, 4);
assert.strictEqual(splits.keyNumberPushes.margin3, 2);
assert.strictEqual(splits.keyNumberPushes.margin7, 1);

const report = recal.buildRecalReport({
  asOf: '2026-10-13',
  generatedAt: '2026-10-13T13:15:00.000Z',
  rows,
});
assert.strictEqual(report.applied, false);
assert.strictEqual(report.nflSplits.keyNumberPushes.margin7, 1);
assert.strictEqual(report.nflSplits.totalsByWind['under-15'].n, 1);
assert.ok(/not applied/i.test(report.recommendation.text));

console.log('test-omega-nfl-splits: ok');
