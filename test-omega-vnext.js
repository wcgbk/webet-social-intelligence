'use strict';
/** Smoke test for omega-vnext — no network required. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const math = require(path.join(root, 'odds_math'));
const calibrate = require(path.join(root, 'calibrate'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));
const clv = require(path.join(root, 'clv_log'));
const mlb = require(path.join(root, 'sports/mlb'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const nba = require(path.join(root, 'sports/nba'));
const nhl = require(path.join(root, 'sports/nhl'));
const { MODEL_VERSION } = require(path.join(root, 'index'));

assert.strictEqual(config.MODEL_VERSION, 'v12.0.3-omega-vnext-clv');
assert.strictEqual(MODEL_VERSION, config.MODEL_VERSION);
assert.strictEqual(config.LEAN_PAD, false);
assert.ok(math.americanToImplied(-110) > 0.52 && math.americanToImplied(-110) < 0.53);
assert.ok(Math.abs(math.evAtOdds(0.55, -110) - (0.55 * (100/110 + 1) - 1)) < 1e-9);

const pCal = calibrate.shrinkTowardSharp(0.60, 0.52, 'Spread');
assert.ok(pCal > 0.52 && pCal < 0.60);

const synth = [
  { sport: 'NFL', matchup: 'A @ B', side: 'B -3', market: 'Spread', odds: -110, coverProb: 0.56, ev: 0.05, predictedClv: 2.5, liquid: true, uncertainty: 0.1, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'B', awayTeam: 'A' },
  { sport: 'MLB', matchup: 'C @ D', side: 'Under 8.5', market: 'Total', odds: -105, coverProb: 0.55, ev: 0.045, predictedClv: 1.2, liquid: true, uncertainty: 0.12, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'D', awayTeam: 'C' },
  { sport: 'NCAAF', matchup: 'E @ F', side: 'F -7', market: 'Spread', odds: -110, coverProb: 0.54, ev: 0.04, predictedClv: 0.8, liquid: true, uncertainty: 0.2, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'F', awayTeam: 'E' },
  { sport: 'NFL', matchup: 'G @ H', side: 'Over 45.5', market: 'Total', odds: -110, coverProb: 0.53, ev: 0.035, predictedClv: 0.5, liquid: true, uncertainty: 0.15, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'H', awayTeam: 'G' },
];

const { yesPool, rejected } = gates.applyGates(synth);
assert.ok(yesPool.length >= 3);
assert.ok(Array.isArray(rejected));

const picked = select.selectStraights(yesPool, 3);
assert.ok(picked.length <= 3);
assert.ok(picked.length >= 1);

const picks = picked.map(c => select.toPickObject(c, { modelVersion: MODEL_VERSION }));
const withClv = clv.attachClvFields(picks);
assert.ok(withClv[0].modelVersion === MODEL_VERSION);

const parlays = parlay.optimizeParlay(yesPool, picks);
assert.ok(Array.isArray(parlays));
if (parlays.length) {
  assert.ok(parlays[0].legs.length >= 2 && parlays[0].legs.length <= 3);
  assert.ok(parlays[0].type.includes('parlay'));
}

assert.deepStrictEqual(nba.project({}), []);
assert.deepStrictEqual(nhl.project({}), []);
assert.strictEqual(typeof mlb.project, 'function');
assert.strictEqual(typeof nfl.project, 'function');
assert.strictEqual(typeof cfb.project, 'function');

const narrate = require(path.join(root, 'narrate'));
const fb = narrate.buildFallbackNarrative({ pick: 'Under 45.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Total', odds: '-105' });
assert.ok(fb.includes('WeBetAI'));
assert.ok(!/clears Omega vNext gates|predicted CLV/i.test(fb));
const replaced = narrate.ensureNarrative({
  pick: 'Lakers ML', matchup: 'A @ B', sport: 'NBA', odds: '+120',
  coreReasoning: 'clears Omega vNext gates: calibrated cover 67%, predicted CLV 3¢. Method: sport-hybrid.',
});
assert.ok(!/clears Omega vNext gates/i.test(replaced.coreReasoning));
assert.ok(replaced.coreReasoning.length > 40);

// Parlay legs should expose coreReasoning field for public cards
if (parlays.length) {
  assert.ok('coreReasoning' in parlays[0].legs[0]);
}

console.log('PASS test-omega-vnext', {
  MODEL_VERSION,
  yesPool: yesPool.length,
  straights: picks.length,
  parlayLegs: parlays.length ? parlays[0].legs.length : 0,
});
