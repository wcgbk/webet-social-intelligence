'use strict';
/** Parlay 2-vs-3 optimizer — omega-vnext. */
const assert = require('assert');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const live = require('./netlify/functions/generate-picks-omega-background');
const { MODEL_VERSION } = require('./netlify/functions/lib/omega-vnext/config');

assert.strictEqual(live.MODEL_VERSION, MODEL_VERSION);

const future = new Date(Date.now() + 864e5).toISOString();
const mk = (sport, matchup, side, market, cp, ev) => ({
  sport, matchup, side, market, odds: -110, coverProb: cp, ev,
  edgePct: 0.03, predictedClv: 1, liquid: true, commenceTime: future,
  homeTeam: matchup.split(' @ ')[1], awayTeam: matchup.split(' @ ')[0],
});

const pool3 = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.56, 0.05),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.55, 0.045),
  mk('NCAAF', 'E @ F', 'F -7', 'Spread', 0.54, 0.04),
  mk('NFL', 'G @ H', 'Over 44.5', 'Total', 0.53, 0.035),
];
const p = optimizeParlay(pool3, []);
assert.ok(p.length === 1);
assert.ok(p[0].legs.length === 3, 'prefer 3-leg when available');

// A 1% EV third leg is below the 3% publish floor. It is not a parlay leg.
// The two floor legs still publish.
const strong2 = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
  mk('NCAAF', 'X @ Y', 'Y -1', 'Spread', 0.50, 0.01),
];
const pPrefer3 = optimizeParlay(strong2, []);
assert.strictEqual(pPrefer3.length, 1);
assert.strictEqual(pPrefer3[0].legs.length, 2);
assert.ok(!pPrefer3[0].legs.some(l => l.pick === 'Y -1' || l.side === 'Y -1'));

// A third leg under 45% cover is not parlay-eligible. The +EV 2-leg remains.
// A 3-leg whose combined EV is not positive falls back to that 2-leg.
const thinThird = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
  mk('NCAAF', 'X @ Y', 'Y -1', 'Spread', 0.36, 0.02),
];
const p2 = optimizeParlay(thinThird, []);
assert.strictEqual(p2.length, 1);
assert.strictEqual(p2[0].legs.length, 2);
assert.ok(parseFloat(p2[0].ev) > 0, p2[0].ev);
const negThree = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.55, 0.04),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.55, 0.04),
  mk('NCAAF', 'X @ Y', 'Y -1', 'Spread', 0.46, 0.02),
];
const pNeg = optimizeParlay(negThree, []);
assert.strictEqual(pNeg.length, 1);
assert.strictEqual(pNeg[0].legs.length, 2);
assert.ok(parseFloat(pNeg[0].ev) > 0, pNeg[0].ev);
const underCover = [
  mk('NFL', 'A @ B', 'B ML', 'Moneyline', 0.40, 0.08),
  mk('MLB', 'C @ D', 'D ML', 'Moneyline', 0.42, 0.07),
  mk('NCAAF', 'E @ F', 'F ML', 'Moneyline', 0.44, 0.06),
];
assert.strictEqual(optimizeParlay(underCover, []).length, 0);

const twoGames = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
];
const pTwo = optimizeParlay(twoGames, []);
assert.strictEqual(pTwo.length, 1);
assert.strictEqual(pTwo[0].legs.length, 2);

console.log('PASS test-fill3-parlay-2or3 (v12)', { legs: p[0].legs.length, type: p[0].type });
