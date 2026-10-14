'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { americanToImplied, americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { applyPureModel, PURE_MODEL_VERSION } = require('./netlify/functions/lib/omega-vnext/pure_model');
const { gateReason } = require('./netlify/functions/lib/omega-vnext/gates');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');

assert.strictEqual(PURE_MODEL_VERSION, 'pure-model-1014');

const implied = americanToImplied(-110);
const dec = americanToDecimal(-110);
const blended = 0.53;
const pure = 0.58;
const fair = 0.52;
const row = applyPureModel([{
  sport: 'MLB',
  market: 'Moneyline',
  side: 'Milwaukee Brewers',
  matchup: 'Milwaukee Brewers @ Chicago Cubs',
  homeTeam: 'Chicago Cubs',
  awayTeam: 'Milwaukee Brewers',
  odds: 118,
  book: 'draftkings',
  modelRawP: blended,
  modelPureP: pure,
  coverProb: fair,
  fair_sharp_p: fair,
  sharpFairPriced: true,
  sharpFairReject: null,
  movementDrop: true,
  movementDropReason: 'sharp_prob_against: -0.0300',
  liquid: false,
  lineMove: { against: true },
}])[0];

assert.strictEqual(row.pureModelPriced, true);
assert.strictEqual(row.sharpFairPriced, false);
assert.strictEqual(row.sharpFairReject, null);
assert.strictEqual(row.movementDrop, false);
assert.strictEqual(row.coverProb, pure);
assert.strictEqual(row.p_model, pure);
assert.notStrictEqual(row.coverProb, blended);
assert.notStrictEqual(row.coverProb, fair);
assert.strictEqual(row.fair_sharp_p, fair);
const betImplied = americanToImplied(118);
const betDec = americanToDecimal(118);
assert.ok(Math.abs(row.edgePct - (pure - betImplied)) < 1e-6, row.edgePct);
assert.ok(Math.abs(row.ev - (pure * betDec - 1)) < 1e-6, row.ev);
assert.strictEqual(row.edgeBasis, 'pure-model-edge-vs-bet-price');
assert.strictEqual(row.liquid, true);

const missing = applyPureModel([{
  sport: 'MLB', market: 'Moneyline', odds: -110, modelRawP: 0.6, fair_sharp_p: 0.55, coverProb: 0.57,
}])[0];
assert.strictEqual(missing.pureModelMissing, true);
assert.strictEqual(missing.coverProb, null);
assert.strictEqual(missing.ev, null);
assert.notStrictEqual(missing.coverProb, 0.6);

const gated = gateReason({
  ...row,
  ev: 0.04,
  edgePct: 0.03,
  commenceTime: new Date(Date.now() + 864e5).toISOString(),
  liquid: true,
  movementDrop: true,
  movementDropReason: 'sharp_prob_against: -0.0300',
  lineMove: { steamAgainst: true, cents: 40 },
});
assert.strictEqual(gated, null);

const pick = toPickObject({
  ...row,
  ev: pure * betDec - 1,
  edgePct: pure - betImplied,
  tier: 'floor',
  uncertainty: 0.2,
  predictedClv: -5,
});
assert.strictEqual(pick.edgeBasis, 'pure-model-edge-vs-bet-price');
assert.strictEqual(pick.gradeBasis, 'pure-model-edge-vs-bet-price');
assert.strictEqual(pick.pureModelPriced, true);
assert.ok(pick.rating === 'aplus' || pick.rating === 'a' || pick.rating === 'aminus' || pick.rating === 'b');

const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
assert.ok(indexSrc.includes('applyPureModel(candidates)'));
assert.ok(!indexSrc.includes('applySharpFair('));
assert.ok(Math.abs(implied - 0.5238) < 0.01);
assert.ok(dec > 1);

console.log('test-omega-pure-model-1014 ok');
