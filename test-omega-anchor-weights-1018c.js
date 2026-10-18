'use strict';
// Anchor weights by sport and market, plus the replay-only env override.
// 2026-10-18 fit on audit2-rows.json. w=0.05 must blend, not fall through.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  modelWeightFor, anchorProbability, applyMarketAnchor,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');

assert.deepStrictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT, {
  NCAAF: { spread: 0.05, ml: 0.05, total: 0.10 },
  NFL: { spread: 0.40, ml: 0.40, total: 0 },
  NHL: { spread: 0.05, ml: 0.25, total: 0.25 },
  MLB: { spread: 0.25, ml: 0.05, total: 0.25 },
});
assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.40);
assert.strictEqual(modelWeightFor('NFL', 'Total'), 0);
assert.strictEqual(modelWeightFor('NCAAF', 'Moneyline'), 0.05);
assert.strictEqual(modelWeightFor('NCAAF', 'Spread'), 0.05);
assert.strictEqual(modelWeightFor('NCAAF', 'Total'), 0.10);
assert.strictEqual(modelWeightFor('NHL', 'Puck Line'), 0.05);
assert.strictEqual(modelWeightFor('NHL', 'Moneyline'), 0.25);
assert.strictEqual(modelWeightFor('NHL', 'Total'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Moneyline'), 0.05);
assert.strictEqual(modelWeightFor('MLB', 'Run Line'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Total'), 0.25);
assert.strictEqual(modelWeightFor('NBA', 'Spread'), null);
assert.ok(!Object.prototype.hasOwnProperty.call(config.MARKET_ANCHOR_MODEL_WEIGHT, 'NBA'));

// 0.05 is honoured: p = 0.05*pm + 0.95*pf. Not the fair, and not the old 0.25 blend.
const pm = 0.80;
const pf = 0.42;
assert.strictEqual(modelWeightFor('MLB', 'Moneyline'), 0.05);
const blended = anchorProbability(pm, pf, modelWeightFor('NCAAF', 'Spread'));
assert.ok(Math.abs(blended - (0.05 * pm + 0.95 * pf)) < 1e-12, blended);
assert.notStrictEqual(blended, pf);
assert.ok(Math.abs(blended - (0.25 * pm + 0.75 * pf)) > 1e-4);

const [ncaafSpread] = applyMarketAnchor([{
  sport: 'NCAAF', market: 'Spread', side: 'Home -3', line: -3,
  modelPureP: pm, coverProb: 0.70,
  matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
  pinnacleSide: { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 },
}]);
assert.strictEqual(ncaafSpread.anchorWeight, 0.05);
assert.ok(Math.abs(ncaafSpread.coverProb - anchorProbability(pm, 0.5, 0.05)) < 1e-12);
assert.ok(Math.abs(ncaafSpread.coverProb - 0.5) > 1e-4);

const saved = {};
function setEnv(name, value) {
  if (!Object.prototype.hasOwnProperty.call(saved, name)) saved[name] = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
function restoreEnv() {
  for (const name of Object.keys(saved)) {
    if (saved[name] == null) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

try {
  // Read at call time. The shipped table does not change.
  setEnv('OMEGA_ANCHOR_W_NFL_ML', '0.6');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.6);
  assert.strictEqual(modelWeightFor('NFL', 'ML'), 0.6);
  assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.40);
  assert.strictEqual(modelWeightFor('NFL', 'Total'), 0);
  assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NFL.ml, 0.40);

  // 0 and 0.05 are real overrides. They must not fall through to the table.
  setEnv('OMEGA_ANCHOR_W_NFL_TOTAL', '0');
  assert.strictEqual(modelWeightFor('NFL', 'Total'), 0);
  setEnv('OMEGA_ANCHOR_W_NFL_SPREAD', '0.05');
  assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.05);
  const overridden = anchorProbability(pm, pf, modelWeightFor('NFL', 'Spread'));
  assert.ok(Math.abs(overridden - (0.05 * pm + 0.95 * pf)) < 1e-12, overridden);
  const [swept] = applyMarketAnchor([{
    sport: 'NFL', market: 'Spread', side: 'Home -3', line: -3,
    modelPureP: pm, coverProb: 0.70,
    matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
    pinnacleSide: { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 },
  }]);
  assert.strictEqual(swept.anchorWeight, 0.05);
  assert.ok(Math.abs(swept.coverProb - anchorProbability(pm, 0.5, 0.05)) < 1e-12);

  setEnv('OMEGA_ANCHOR_W_NHL_SPREAD', '0.05');
  assert.strictEqual(modelWeightFor('NHL', 'Puck Line'), 0.05);
  setEnv('OMEGA_ANCHOR_W_MLB_ML', '1');
  assert.strictEqual(modelWeightFor('MLB', 'Moneyline'), 1);
  setEnv('OMEGA_ANCHOR_W_NCAAF_TOTAL', '0');
  assert.strictEqual(modelWeightFor('NCAAF', 'Total'), 0);

  // Outside [0, 1], blank, and non-numeric leave the table.
  setEnv('OMEGA_ANCHOR_W_NFL_ML', '1.5');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
  setEnv('OMEGA_ANCHOR_W_NFL_ML', '-0.1');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
  setEnv('OMEGA_ANCHOR_W_NFL_ML', '');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
  setEnv('OMEGA_ANCHOR_W_NFL_ML', 'nope');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
  setEnv('OMEGA_ANCHOR_W_NFL_ML', ' 0.6 ');
  assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.6);

  // NBA stays unanchored until a valid replay override is set.
  assert.strictEqual(modelWeightFor('NBA', 'Moneyline'), null);
  setEnv('OMEGA_ANCHOR_W_NBA_ML', '0.05');
  assert.strictEqual(modelWeightFor('NBA', 'Moneyline'), 0.05);
  assert.strictEqual(modelWeightFor('NBA', 'Spread'), null);
} finally {
  restoreEnv();
}

assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.40);
assert.strictEqual(modelWeightFor('NBA', 'Moneyline'), null);
assert.ok(/ASSUMED INTERIM/.test(String(config.MODEL_NOTES)));
assert.ok(/OMEGA_ANCHOR_W_/.test(String(config.MODEL_NOTES)));
assert.ok(/OMEGA_ANCHOR_W_/.test(
  require('fs').readFileSync(require('path').join(__dirname, 'netlify/functions/lib/omega-vnext/prob_anchor.js'), 'utf8'),
));

console.log('test-omega-anchor-weights-1018c ok');
