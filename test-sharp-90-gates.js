'use strict';
/**
 * Omega cutover smoke: live path is omega-vnext v12.
 * Legacy v11 gate unit tests retired with the megascript archive.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const live = require('./netlify/functions/generate-picks-omega-background');
const { applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');

assert.strictEqual(live.MODEL_VERSION, 'v12.2.1-omega-vnext-placeability');
assert.ok(fs.existsSync(path.join(__dirname, 'archive/generate-picks-omega-legacy-v11.js')));

const future = new Date(Date.now() + 864e5).toISOString();
const yes = {
  sport: 'NFL', matchup: 'A @ B', side: 'B -3', market: 'Spread',
  odds: -110, coverProb: 0.56, ev: 0.05, predictedClv: 1, liquid: true,
  commenceTime: future, edgePct: 0.04,
};
const no = { ...yes, ev: 0.005, predictedClv: -2 };
const { yesPool, rejected } = applyGates([yes, no]);
assert.strictEqual(yesPool.length, 1);
assert.ok(rejected.length >= 1);

const pool = [
  yes,
  { ...yes, sport: 'MLB', matchup: 'C @ D', side: 'Under 8.5', market: 'Total', coverProb: 0.55, ev: 0.04 },
  { ...yes, sport: 'NCAAF', matchup: 'E @ F', side: 'F -7', market: 'Spread', coverProb: 0.54, ev: 0.035 },
];
const parlays = optimizeParlay(pool, []);
assert.ok(Array.isArray(parlays));
console.log('PASS test-sharp-90-gates (v12 omega-vnext)');
