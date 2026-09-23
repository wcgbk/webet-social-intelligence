'use strict';
/** Parlay 2-vs-3 optimizer — omega-vnext. */
const assert = require('assert');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const live = require('./netlify/functions/generate-picks-omega-background');

assert.strictEqual(live.MODEL_VERSION, 'v12.3.10-omega-vnext-sharp-blend');

const future = new Date(Date.now() + 864e5).toISOString();
const mk = (sport, matchup, side, market, cp, ev) => ({
  sport, matchup, side, market, odds: -110, coverProb: cp, ev,
  predictedClv: 1, liquid: true, commenceTime: future,
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

// A +EV 3-leg is preferred even when its best 2-leg subset converts more often.
const strong2 = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
  mk('NCAAF', 'X @ Y', 'Y -1', 'Spread', 0.50, 0.01),
];
const pPrefer3 = optimizeParlay(strong2, []);
assert.strictEqual(pPrefer3.length, 1);
assert.strictEqual(pPrefer3[0].legs.length, 3);

// A 3-leg whose combined EV is negative falls back to the best 2-leg.
const onlyTwo = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
  mk('NCAAF', 'X @ Y', 'Y -1', 'Spread', 0.36, 0.02),
];
const p2 = optimizeParlay(onlyTwo, []);
assert.strictEqual(p2.length, 1);
assert.strictEqual(p2[0].legs.length, 2);

console.log('PASS test-fill3-parlay-2or3 (v12)', { legs: p[0].legs.length, type: p[0].type });
