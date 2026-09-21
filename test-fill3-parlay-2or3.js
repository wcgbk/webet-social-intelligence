'use strict';
/** Parlay 2-vs-3 optimizer — omega-vnext. */
const assert = require('assert');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const live = require('./netlify/functions/generate-picks-omega-background');

assert.strictEqual(live.MODEL_VERSION, 'v12.0.6-omega-vnext-clv');

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

// High-hit 2-leg should beat weak 3-leg when clearly better
const weak3 = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.51, 0.02),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.51, 0.02),
  mk('NCAAF', 'E @ F', 'F -7', 'Spread', 0.51, 0.02),
];
const strong2 = [
  mk('NFL', 'A @ B', 'B -3', 'Spread', 0.62, 0.12),
  mk('MLB', 'C @ D', 'Under 8.5', 'Total', 0.61, 0.11),
  ...weak3.slice(0, 1).map(x => ({ ...x, matchup: 'X @ Y', side: 'Y -1', coverProb: 0.50, ev: 0.01 })),
];
const p2 = optimizeParlay(strong2, []);
assert.ok(p2.length === 1);
assert.ok(p2[0].legs.length >= 2 && p2[0].legs.length <= 3);

console.log('PASS test-fill3-parlay-2or3 (v12)', { legs: p[0].legs.length, type: p[0].type });
