'use strict';

/**
 * OMEGA_CAL_MODE. Unset is A: hand-set shrink, no unfitted band.
 * Legacy is the hand-set shrink plus the unfitted band (exact rollback).
 * B fits K in [0.3, 1]. C fits Platt or isotonic on the shrunk probability.
 * Gates are not part of the switch.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./netlify/functions/lib/omega-vnext/config');
const cal = require('./netlify/functions/lib/omega-vnext/calibrate');
const fit = require('./tools/omega-calibration/cal4-fit');

function withEnv(extra, fn) {
  const prev = {};
  for (const key of Object.keys(extra)) {
    prev[key] = process.env[key];
    if (extra[key] == null) delete process.env[key];
    else process.env[key] = String(extra[key]);
  }
  cal.clearCalParamsCache();
  try {
    return fn();
  } finally {
    for (const key of Object.keys(extra)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
    cal.clearCalParamsCache();
  }
}

const savedMode = process.env.OMEGA_CAL_MODE;
const savedFile = process.env.OMEGA_CAL_PARAMS_FILE;
const savedDate = process.env.OMEGA_CAL_CARD_DATE;
delete process.env.OMEGA_CAL_MODE;
delete process.env.OMEGA_CAL_PARAMS_FILE;
delete process.env.OMEGA_CAL_CARD_DATE;
cal.clearCalParamsCache();

assert.strictEqual(cal.CAL_MODE_DEFAULT, 'A');
assert.strictEqual(cal.resolveCalMode(), 'A');
assert.strictEqual(cal.resolveCalMode(''), 'A');
assert.strictEqual(cal.resolveCalMode('legacy'), 'legacy');
assert.strictEqual(cal.resolveCalMode('0'), 'legacy');
assert.strictEqual(config.MODEL_VERSION, 'v12.3.19-omega-vnext-parlay-decorr');
assert.ok(/shrink K is still hand-set/i.test(config.MODEL_NOTES));
assert.ok(/Mode B stays selectable/.test(config.MODEL_NOTES));
assert.ok(/Mode C stays selectable/.test(config.MODEL_NOTES));
assert.ok(/exact rollback/.test(config.MODEL_NOTES));
assert.ok(/2026-10-10 and 2026-10-11/.test(config.MODEL_NOTES));
assert.ok(/0 picks/.test(config.MODEL_NOTES));
assert.ok(/valid-card requirement/.test(config.MODEL_NOTES));
assert.ok(/empties the live card/.test(config.MODEL_NOTES));
assert.ok(/fitted-K mode B/.test(config.MODEL_NOTES));
assert.ok(/-0\.012840/.test(config.MODEL_NOTES));
assert.ok(/-0\.017171\.\.-0\.008556/.test(config.MODEL_NOTES));
assert.ok(/1\.765\/day/.test(config.MODEL_NOTES));

// Unset mode is A: hand-set shrink, no band, and it does not read the ship file.
const unset = cal.calibrateCandidate({
  sport: 'NFL', market: 'Spread', modelRawP: 0.80, fair_sharp_p: 0.50, cardDate: '2026-10-10',
});
assert.strictEqual(unset.calMode, 'A');
assert.strictEqual(unset.calParamsSource, 'none');
assert.strictEqual(unset.calibK, 0.68);
assert.strictEqual(unset.calLevel, 'handset');
assert.strictEqual(unset.calMap, null);
assert.ok(Math.abs(unset.coverProb - ((1 - 0.68) * 0.80 + 0.68 * 0.50)) < 1e-12);
const unsetMlb = cal.calibrateCandidate({
  sport: 'MLB', market: 'Spread', modelRawP: 0.80, fair_sharp_p: 0.50, cardDate: '2026-10-10',
});
assert.strictEqual(unsetMlb.calMode, 'A');
assert.strictEqual(unsetMlb.calibK, 0.62);
assert.strictEqual(unsetMlb.calLevel, 'handset');
assert.strictEqual(unsetMlb.calParamsSource, 'none');
assert.ok(Math.abs(unsetMlb.coverProb - ((1 - 0.62) * 0.80 + 0.62 * 0.50)) < 1e-12);

// Mode B still reads the ship record after the study window.
const modeBShip = withEnv({ OMEGA_CAL_MODE: 'B' }, () => cal.calibrateCandidate({
  sport: 'NFL', market: 'Spread', modelRawP: 0.80, fair_sharp_p: 0.50, cardDate: '2026-10-10',
}));
assert.strictEqual(modeBShip.calMode, 'B');
assert.strictEqual(modeBShip.calParamsSource, 'ship');
assert.strictEqual(modeBShip.calibK, 1);
assert.ok(Math.abs(modeBShip.coverProb - 0.50) < 1e-12);
const modeBMlb = withEnv({ OMEGA_CAL_MODE: 'B' }, () => cal.calibrateCandidate({
  sport: 'MLB', market: 'Spread', modelRawP: 0.80, fair_sharp_p: 0.50, cardDate: '2026-10-10',
}));
assert.strictEqual(modeBMlb.calibK, 0.3);
assert.strictEqual(modeBMlb.calLevel, 'cell');
assert.strictEqual(cal.resolveCalMode('nope'), 'legacy');
assert.strictEqual(cal.resolveCalMode('a'), 'A');
assert.strictEqual(cal.resolveCalMode('B'), 'B');
assert.strictEqual(cal.resolveCalMode('c'), 'C');

assert.strictEqual(cal.BAND_CLIP.fitted, false);
assert.strictEqual(cal.BAND_CLIP.name, 'bandRetainClip');
assert.strictEqual(cal.BAND_CLIP.historicalName, 'isotonicClip');
assert.strictEqual(cal.BAND_CLIP.lo, 0.42);
assert.strictEqual(cal.BAND_CLIP.hi, 0.58);
assert.strictEqual(cal.BAND_CLIP.keep, 0.25);
assert.strictEqual(cal.K_POLICY.min, 0.3);
assert.strictEqual(cal.K_POLICY.max, 1);
assert.strictEqual(cal.K_POLICY.minIsProductConstraint, true);
assert.ok(/not the log-loss/i.test(cal.K_POLICY.note));

assert.strictEqual(cal.bandRetainClip(0.5), cal.isotonicClip(0.5));
assert.ok(Math.abs(cal.bandRetainClip(0.72) - (0.58 + (0.72 - 0.58) * 0.25)) < 1e-12);
assert.ok(Math.abs(cal.bandRetainClip(0.30) - (0.42 - (0.42 - 0.30) * 0.25)) < 1e-12);
assert.strictEqual(cal.bandRetainClip(0.50), 0.50);
assert.ok(cal.isotonicClip(0.60) <= 0.60);
assert.ok(cal.isotonicClip(0.72) < 0.65);

// NFL spread hand-set K = 0.68. Outside the band, legacy and A disagree.
const pModel = 0.80;
const pSharp = 0.50;
const shrunk = (1 - 0.68) * pModel + 0.68 * pSharp;
assert.ok(Math.abs(shrunk - 0.596) < 1e-12);
const band = 0.58 + (shrunk - 0.58) * 0.25;
const base = { sport: 'NFL', market: 'Spread', modelRawP: pModel, fair_sharp_p: pSharp, odds: -110 };

const legacy = withEnv({ OMEGA_CAL_MODE: 'legacy' }, () => cal.calibrateCandidate(base));
const modeA = withEnv({ OMEGA_CAL_MODE: 'A' }, () => cal.calibrateCandidate(base));
assert.ok(Math.abs(legacy.coverProb - band) < 1e-12, legacy.coverProb);
assert.ok(Math.abs(modeA.coverProb - shrunk) < 1e-12, modeA.coverProb);
assert.ok(modeA.coverProb > legacy.coverProb);
assert.strictEqual(legacy.calMap, 'bandRetainClip');
assert.strictEqual(modeA.calMap, null);
assert.strictEqual(modeA.calParamsSource, 'none');
assert.strictEqual(legacy.calibK, 0.68);
assert.strictEqual(modeA.calibK, 0.68);

// MLB moneyline keeps the hand-set 0.30, not the global 0.73.
const mlb = withEnv({ OMEGA_CAL_MODE: 'A' }, () => cal.calibrateCandidate({
  sport: 'MLB', market: 'Moneyline', modelRawP: 0.60, fair_sharp_p: 0.52,
}));
assert.ok(Math.abs(mlb.coverProb - (0.70 * 0.60 + 0.30 * 0.52)) < 1e-12);
assert.strictEqual(mlb.calibK, 0.30);

// Gates stay the published floors. This switch does not retune them.
assert.deepStrictEqual(config.GATES.minEV, {
  MLB: 0.03, NFL: 0.025, NCAAF: 0.03, NBA: 0.03, NHL: 0.03, default: 0.03,
});
assert.deepStrictEqual(config.GATES.minCoverProb, {
  MLB: 0.48, NFL: 0.48, NCAAF: 0.48, default: 0.48,
});
assert.deepStrictEqual(config.SHRINK_K, { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 });
assert.deepStrictEqual(config.MLB_CALIBRATION.shrinkK, {
  Total: 0.46, Spread: 0.62, Moneyline: 0.30, default: 0.46,
});

function many(sport, market, nGames, y, pModelRow, pSharpRow) {
  const rows = [];
  for (let g = 0; g < nGames; g++) {
    for (let i = 0; i < 4; i++) {
      rows.push({
        date: '2026-01-01',
        sport,
        market,
        marketFamily: market,
        gameId: `${sport}-${g}`,
        matchup: `A${g} @ B${g}`,
        p_model: pModelRow,
        fair_sharp_p: pSharpRow,
        y,
      });
    }
  }
  return rows;
}

const trustSharp = fit.fitShrinkTable(many('NFL', 'Spread', 20, 1, 0.2, 0.8));
assert.strictEqual(trustSharp.cells['NFL|Spread'].k, 1);
assert.strictEqual(trustSharp.cells['NFL|Spread'].kMle, 1);
assert.strictEqual(trustSharp.cells['NFL|Spread'].level, 'cell');
assert.strictEqual(trustSharp.kMinIsProductConstraint, true);

const trustModel = fit.fitShrinkTable(many('NFL', 'Spread', 20, 1, 0.9, 0.2));
assert.strictEqual(trustModel.cells['NFL|Spread'].k, 0.3);
assert.strictEqual(trustModel.cells['NFL|Spread'].kMle, 0);
assert.strictEqual(trustModel.cells['NFL|Spread'].bound, 'policy-floor');
assert.ok(/product floor/.test(trustModel.cells['NFL|Spread'].note));

const tiny = fit.fitShrinkTable(many('NHL', 'Total', 2, 1, 0.9, 0.2));
assert.strictEqual(tiny.cells['NHL|Total'].level, 'handset');
assert.strictEqual(tiny.cells['NHL|Total'].k, config.SHRINK_K.Total);

const knots = fit.fitIsotonic([
  { sport: 'NFL', market: 'Spread', p_model: 0.2, fair_sharp_p: 0.2, y: 0, gameId: 'a' },
  { sport: 'NFL', market: 'Spread', p_model: 0.4, fair_sharp_p: 0.4, y: 0, gameId: 'b' },
  { sport: 'NFL', market: 'Spread', p_model: 0.7, fair_sharp_p: 0.7, y: 1, gameId: 'c' },
  { sport: 'NFL', market: 'Spread', p_model: 0.9, fair_sharp_p: 0.9, y: 1, gameId: 'd' },
]);
for (let i = 1; i < knots.length; i++) assert.ok(knots[i].v + 1e-12 >= knots[i - 1].v);
const mapped = cal.applyProbabilityMap(0.9, { type: 'isotonic', knots });
assert.ok(mapped > cal.applyProbabilityMap(0.2, { type: 'isotonic', knots }));

const plattRows = many('NFL', 'Total', 20, 1, 0.75, 0.55);
const platt = fit.fitPlatt(plattRows);
assert.ok(platt.b >= 0 && platt.b <= 2);
assert.ok(platt.a >= -2 && platt.a <= 2);
const shrunkP = cal.linearShrink(0.75, 0.55, config.SHRINK_K.Total);
const lifted = cal.applyProbabilityMap(shrunkP, { type: 'platt', a: platt.a, b: platt.b });
assert.ok(lifted + 1e-9 >= shrunkP, `platt should not move a winning cell down (${lifted} vs ${shrunkP})`);

// A negative slope in a file is clamped to 0 at apply time. The map cannot flip.
const flat = cal.applyProbabilityMap(0.8, { type: 'platt', a: 0, b: -3 });
assert.ok(Math.abs(flat - 0.5) < 1e-9);

const tmp = path.join(os.tmpdir(), `omega-cal-mode-test-${process.pid}.json`);
const doc = {
  byDate: {
    '2026-10-04': {
      trainedThrough: '2026-10-03',
      B: {
        cells: {
          'NFL|Spread': { k: 0.25, level: 'cell', n: 100, nGames: 30 },
          'MLB|Moneyline': { k: 1, level: 'cell', n: 100, nGames: 30 },
        },
      },
      C: {
        cells: {
          'NFL|Spread': { type: 'platt', a: 0, b: 1, level: 'cell' },
          'MLB|Total': { type: 'identity', level: 'identity' },
        },
      },
    },
  },
  ship: {
    trainedThrough: '2026-10-08',
    B: { cells: { 'NFL|Spread': { k: 0.9, level: 'cell' } } },
    C: { cells: { 'NFL|Spread': { type: 'platt', a: 0, b: 0.5, level: 'cell' } } },
  },
};
fs.writeFileSync(tmp, JSON.stringify(doc));

const bClamped = withEnv({
  OMEGA_CAL_MODE: 'B',
  OMEGA_CAL_PARAMS_FILE: tmp,
  OMEGA_CAL_CARD_DATE: '2026-10-04',
}, () => cal.calibrateCandidate(base));
// File said 0.25. The product floor lifts it to 0.3. Not the hand-set 0.68.
assert.strictEqual(bClamped.calibK, 0.3);
assert.ok(Math.abs(bClamped.coverProb - cal.linearShrink(pModel, pSharp, 0.3)) < 1e-12);
assert.strictEqual(bClamped.calParamsSource, 'byDate');
assert.notStrictEqual(bClamped.calMap, 'bandRetainClip');

const bShip = withEnv({
  OMEGA_CAL_MODE: 'B',
  OMEGA_CAL_PARAMS_FILE: tmp,
  OMEGA_CAL_CARD_DATE: '2026-10-10',
}, () => cal.calibrateCandidate(base));
assert.strictEqual(bShip.calParamsSource, 'ship');
assert.strictEqual(bShip.calibK, 0.9);

const cIdent = withEnv({
  OMEGA_CAL_MODE: 'C',
  OMEGA_CAL_PARAMS_FILE: tmp,
  OMEGA_CAL_CARD_DATE: '2026-10-04',
}, () => cal.calibrateCandidate({
  sport: 'MLB', market: 'Total', modelRawP: 0.7, fair_sharp_p: 0.48,
}));
const mlbTotalK = config.MLB_CALIBRATION.shrinkK.Total;
const mlbShrunk = cal.linearShrink(0.7, 0.48, mlbTotalK);
assert.ok(Math.abs(cIdent.coverProb - mlbShrunk) < 1e-12);
assert.strictEqual(cIdent.calMap, 'identity');
assert.ok(Math.abs(cIdent.coverProb - cal.bandRetainClip(mlbShrunk)) > 1e-6);

const found = cal.recordForCardDate(doc, '2026-10-04');
assert.strictEqual(found.source, 'byDate');
assert.ok(found.record.trainedThrough < '2026-10-04');
const later = cal.recordForCardDate(doc, '2026-10-09');
assert.strictEqual(later.source, 'ship');

const bundledPath = path.join(__dirname, 'netlify/functions/lib/omega-vnext/data/omega-cal-mode.json');
assert.ok(fs.existsSync(bundledPath), 'walk-forward params are bundled for replay');
const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
assert.strictEqual(bundled.kPolicy.minIsProductConstraint, true);
assert.strictEqual(bundled.bandClip.fitted, false);
const dates = Object.keys(bundled.byDate).sort();
assert.deepStrictEqual(dates[0], '2026-09-22');
assert.deepStrictEqual(dates[dates.length - 1], '2026-10-08');
for (const date of dates) {
  const rec = bundled.byDate[date];
  if (rec.trainedThrough) assert.ok(rec.trainedThrough < date, `${date} trained through ${rec.trainedThrough}`);
  assert.ok(!rec.B.cells['MLB|Spread'] || rec.B.cells['MLB|Spread'].k >= 0.3);
  assert.ok(!rec.B.cells['MLB|Spread'] || rec.B.cells['MLB|Spread'].k <= 1);
}
assert.ok(bundled.ship.trainedThrough === '2026-10-08');
assert.ok(/including the last day/.test(bundled.ship.trainedOn));
assert.ok(/byDate/.test(bundled.ship.note));

const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
const calSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/calibrate.js'), 'utf8');
assert.ok(indexSrc.includes('calibrateAll(candidates, { cardDate: dateISO })'));
assert.ok(/SHRINK_K/.test(calSrc));
assert.ok(!/walk_forward/.test(calSrc));
assert.ok(!/walk_forward/.test(indexSrc));
assert.ok(!/\bgetFitParams\s*\(/.test(calSrc));
assert.ok(!calSrc.includes('fittedShrinkK'));
assert.ok(!calSrc.includes('isotonicFit'));

fs.unlinkSync(tmp);

if (savedMode == null) delete process.env.OMEGA_CAL_MODE;
else process.env.OMEGA_CAL_MODE = savedMode;
if (savedFile == null) delete process.env.OMEGA_CAL_PARAMS_FILE;
else process.env.OMEGA_CAL_PARAMS_FILE = savedFile;
if (savedDate == null) delete process.env.OMEGA_CAL_CARD_DATE;
else process.env.OMEGA_CAL_CARD_DATE = savedDate;
cal.clearCalParamsCache();

console.log('PASS test-omega-cal-mode');
