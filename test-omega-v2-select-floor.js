'use strict';

/**
 * Selection ranks on price EV after the no-vig shrink, and the uncertainty
 * floor is continuous across the 0.35 bucket wall.
 */

const assert = require('assert');
const {
  EDGE_FLOOR_K, NO_VIG_BUCKETS, NHL_ML_SHRINK_K,
} = require('./netlify/functions/lib/omega-v2/constants');
const {
  annotateCandidate, selectStraights, uncertaintyFloor, smoothedNovigStats,
  BOUNDARY_BLEND, bucketForNovig,
} = require('./netlify/functions/lib/omega-v2/select');
const { shrinkP, applyCalibration } = require('./netlify/functions/lib/omega-v2/calibrate');
const { evAtOdds } = require('./netlify/functions/lib/omega-vnext/odds_math');

const AS_OF = Date.parse('2026-11-03T16:00:00Z');
const COMMENCE = '2026-11-04T00:00:00Z';

function leg(over) {
  return annotateCandidate({
    sport: over.sport || 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: over.market || 'Moneyline',
    odds: over.odds,
    gameKey: String(over.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    calibration: over.calibration,
  });
}

const mid = NO_VIG_BUCKETS.find((b) => b.lo === 0.35);
const longshot = NO_VIG_BUCKETS.find((b) => b.lo === 0.2);
const tail = NO_VIG_BUCKETS.find((b) => b.lo === 0);
assert.ok(mid && longshot && tail);

// Interior of a bucket is the fitted SE. The blend does not move it.
const center = uncertaintyFloor(0.55, 0.50);
assert.strictEqual(center.se, mid.se);
assert.strictEqual(center.penalty, 0);
assert.ok(Math.abs(center.floor - EDGE_FLOOR_K * mid.se) < 1e-12);

const deep = uncertaintyFloor(0.30, 0.25);
assert.strictEqual(deep.se, longshot.se);
assert.strictEqual(deep.penalty, longshot.penalty);

// +575 example stays under the under-0.20 floor (at least 7pp).
const plus = uncertaintyFloor(0.167, 0.140);
assert.ok(plus.floor >= 0.07, `under-0.20 floor ${plus.floor}`);
assert.strictEqual(plus.se, tail.se);
assert.strictEqual(plus.ok, false);

// 0.001 of probability cannot move the floor by 4pp, at the wall or elsewhere.
let maxStep = 0;
for (let p = 0.001; p < 0.999; p += 0.001) {
  const step = Math.abs(uncertaintyFloor(0.5, p + 0.001).floor - uncertaintyFloor(0.5, p).floor);
  if (step > maxStep) maxStep = step;
}
assert.ok(maxStep < 0.04, `max floor step on 0.001 is ${maxStep}, want < 0.04`);

const hardGap = EDGE_FLOOR_K * (longshot.se - mid.se);
assert.ok(hardGap > 0.04, 'the unblended 0.35 step is the 4pp cliff this test guards');

// Nashville's stored fair (0.3501) and a fair of 0.349 are the same side.
const nashPCal = 0.40213828169303695;
const nashFair = 0.350142641428195;
const atCard = uncertaintyFloor(nashPCal, nashFair);
const at349 = uncertaintyFloor(nashPCal, 0.349);
assert.strictEqual(atCard.ok, at349.ok, `Nashville side ${atCard.ok} vs 0.349 ${at349.ok}`);
assert.ok(Math.abs(atCard.floor - at349.floor) < 0.04, `floor jump ${(atCard.floor - at349.floor)}`);
assert.ok(Math.abs((atCard.floor + atCard.penalty) - (at349.floor + at349.penalty)) < 0.04);

// Thunder's stored fair sits outside the blend and keeps the middle floor.
const thunder = uncertaintyFloor(0.41, 0.38895365010787597);
assert.strictEqual(thunder.se, mid.se);
assert.ok(thunder.bucket === bucketForNovig(0.38895365010787597));

// Blend endpoints match the adjacent buckets.
const leftEdge = smoothedNovigStats(0.35 - BOUNDARY_BLEND);
const rightEdge = smoothedNovigStats(0.35 + BOUNDARY_BLEND);
assert.ok(Math.abs(leftEdge.se - longshot.se) < 1e-12);
assert.ok(Math.abs(leftEdge.penalty - longshot.penalty) < 1e-12);
assert.ok(Math.abs(rightEdge.se - mid.se) < 1e-12);
assert.strictEqual(rightEdge.penalty, 0);

// A Platt lift can print a higher price EV than the shrink. Rank uses the shrink.
const dog = leg({
  matchup: 'A @ B',
  pick: 'Dog',
  odds: 150,
  calibration: { pModel: 0.44, pMkt: 0.38, pShrink: 0.40, pCal: 0.48 },
});
const fav = leg({
  matchup: 'C @ D',
  pick: 'Fav',
  odds: -110,
  calibration: { pModel: 0.78, pMkt: 0.52, pShrink: 0.60, pCal: 0.55 },
});
assert.strictEqual(dog.qualified, true, dog.rejectReason);
assert.strictEqual(fav.qualified, true, fav.rejectReason);
assert.ok(dog.ev > fav.ev, `pCal EV dog ${dog.ev} should beat fav ${fav.ev}`);
assert.ok(fav.evShrink > dog.evShrink, `shrink EV fav ${fav.evShrink} should beat dog ${dog.evShrink}`);
assert.ok(Math.abs(dog.evShrink - evAtOdds(0.40, 150)) < 1e-12);
assert.strictEqual(
  selectStraights([dog, fav], { pregameAsOfMs: AS_OF })[0].pick,
  'Fav',
  'top straight is the post-shrink EV, not the Platt EV',
);

// Shrink weights are the shipped calibrate.js values. This file does not refit them.
const oilers = {
  sport: 'NHL',
  market: 'Moneyline',
  pick: 'Edmonton Oilers',
  pModel: 0.47384426883708364,
  pMkt: 0.410886027132864,
};
const cal = applyCalibration(oilers, { bySport: {}, pooled: { method: 'platt', k: 0.7, platt: { a: 0.079, b: 0.78 } } });
assert.strictEqual(cal.shrinkK, NHL_ML_SHRINK_K);
assert.ok(Math.abs(cal.pShrink - shrinkP(oilers.pModel, oilers.pMkt, NHL_ML_SHRINK_K)) < 1e-12);
assert.ok(Math.abs(cal.pCal - oilers.pMkt) < 1e-12);

const ranked = leg({
  matchup: 'E @ F',
  pick: 'Oilers',
  sport: 'NHL',
  odds: 130,
  calibration: cal,
});
assert.ok(Math.abs(ranked.evShrink - evAtOdds(cal.pShrink, 130)) < 1e-12);
assert.strictEqual(ranked.qualified, false, 'k=1 NHL moneyline has no price edge');

// Rows that never stored pShrink still rank on ev.
const legacy = [
  { pick: 'Low', matchup: 'G @ H', gameKey: 'g @ h', qualified: true, ev: 0.02, edge: 0.03, commenceTime: COMMENCE },
  { pick: 'High', matchup: 'I @ J', gameKey: 'i @ j', qualified: true, ev: 0.05, edge: 0.01, commenceTime: COMMENCE },
];
assert.strictEqual(selectStraights(legacy, { pregameAsOfMs: AS_OF })[0].pick, 'High');

console.log('PASS test-omega-v2-select-floor');
