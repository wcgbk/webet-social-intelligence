'use strict';
// NFL margin SD law and NFL totals anchor weight (2026-10-18).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  modelWeightFor, anchorProbability, applyMarketAnchor, ratingSeOf, pinnacleFair,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { edgeFloorSe, failsEdgeFloorSe } = require('./netlify/functions/lib/omega-vnext/edge_floor');

const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/config.js'), 'utf8');
const sdBlock = src.slice(src.indexOf('Margin residual SD'), src.indexOf('function ratingKind'));
assert.ok(sdBlock.length > 200, 'SD block missing');
assert.ok(sdBlock.includes('FITTED'), 'FITTED provenance comment');
assert.ok(sdBlock.includes('ASSUMED'), 'ASSUMED provenance comment');
assert.ok(sdBlock.includes('13.2'), 'fitted NFL margin game SD cited');
assert.ok(sdBlock.includes('10.5'), 'NFL total SD decision cited');
assert.ok(/95% CI/.test(sdBlock), 'NFL total bootstrap CI cited');

assert.strictEqual(config.SPORT_SPREAD_STD.NFL, 13.2);
assert.strictEqual(config.SPORT_TOTAL_STD.NFL, 10.5);
assert.strictEqual(config.NFL_PRIOR_K, 16);
assert.deepStrictEqual(config.RATING_ERROR_SD.NFL.margin, { base: 4, k: 16 });
assert.strictEqual(config.RATING_ERROR_SD.NFL.margin.k, config.NFL_PRIOR_K);
assert.strictEqual(config.RATING_ERROR_SD.NFL.total, 6);

function nflMarginRating(n) {
  const k = config.NFL_PRIOR_K;
  return 4 * Math.sqrt(k / (k + n));
}
function nflMarginEff(n) {
  const game = config.SPORT_SPREAD_STD.NFL;
  const rating = nflMarginRating(n);
  return Math.sqrt(game * game + rating * rating);
}

for (const n of [6, 17]) {
  assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin', n) - nflMarginRating(n)) < 1e-12, `rating n=${n}`);
  assert.ok(Math.abs(config.ratingErrorSd('NFL', 'spread', n) - nflMarginRating(n)) < 1e-12, `spread kind n=${n}`);
  assert.ok(Math.abs(config.effectiveSd('NFL', 'margin', n) - nflMarginEff(n)) < 1e-12, `eff n=${n}`);
  assert.ok(Math.abs(
    config.effectiveSd('NFL', 'margin', n)
    - Math.sqrt(13.2 ** 2 + (4 * Math.sqrt(16 / (16 + n))) ** 2),
  ) < 1e-12, `closed form n=${n}`);
}

assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin') - nflMarginRating(6)) < 1e-12);
assert.ok(Math.abs(config.effectiveSd('NFL', 'margin') - nflMarginEff(6)) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin', 0) - nflMarginRating(6)) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin', 3) - nflMarginRating(3)) < 1e-12);
assert.ok(config.ratingErrorSd('NFL', 'margin', 3) > config.ratingErrorSd('NFL', 'margin', 6));
assert.ok(config.effectiveSd('NFL', 'margin', 17) < config.effectiveSd('NFL', 'margin', 6));
assert.ok(config.effectiveSd('NFL', 'margin', 6) > config.SPORT_SPREAD_STD.NFL);

assert.ok(Math.abs(config.ratingErrorSd('NFL', 'total', 6) - 6) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'total', 2) - 6) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'total', 17) - 6 * Math.sqrt(6 / 17)) < 1e-12);
assert.ok(Math.abs(
  config.effectiveSd('NFL', 'total', 6) - Math.sqrt(10.5 * 10.5 + 6 * 6),
) < 1e-12);

assert.strictEqual(config.SPORT_SPREAD_STD.NCAAF, 16.0);
assert.strictEqual(config.SPORT_TOTAL_STD.NCAAF, 13.5);
assert.strictEqual(config.SPORT_SPREAD_STD.NBA, 12.0);
assert.strictEqual(config.SPORT_TOTAL_STD.NBA, 18.0);
assert.strictEqual(config.SPORT_SPREAD_STD.NHL, 2.5);
assert.strictEqual(config.SPORT_TOTAL_STD.NHL, 1.8);
assert.strictEqual(config.SPORT_SPREAD_STD.MLB, 4.2);
assert.strictEqual(config.SPORT_TOTAL_STD.MLB, 3.5);
assert.strictEqual(config.RATING_ERROR_SD.NCAAF.margin, 8);
assert.strictEqual(config.RATING_ERROR_SD.NCAAF.total, 6);
assert.ok(Math.abs(config.ratingErrorSd('NCAAF', 'margin', 17) - 8 * Math.sqrt(6 / 17)) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NCAAF', 'margin', 2) - 8) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NHL', 'total', 17) - 0.9 * Math.sqrt(6 / 17)) < 1e-12);
assert.strictEqual(config.ratingErrorSd('NBA', 'margin', 10), 0);
assert.strictEqual(config.effectiveSd('NBA', 'margin', 10), config.SPORT_SPREAD_STD.NBA);

const anchorSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/config.js'), 'utf8');
const anchorAt = anchorSrc.indexOf('OMEGA_MARKET_ANCHOR is ignored');
assert.ok(anchorAt > 0, 'anchor comment rewritten');
const anchorBlock = anchorSrc.slice(anchorAt, anchorAt + 1200);
assert.ok(anchorBlock.includes('FITTED'), 'NFL totals weight provenance');
assert.ok(anchorBlock.includes('ASSUMED'), 'other weights stay assumed');
assert.ok(/NFL totals w = 0/.test(anchorBlock));
assert.ok(!/published probability is the pure model/.test(anchorBlock));

assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NFL.total, 0);
// 2026-10-18: NFL ml/spread anchor weight is 0.40 (ASSUMED INTERIM), was 0.25. MLB ml is the 0.05 token floor.
assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NFL.spread, 0.40);
assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NFL.ml, 0.40);
assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NCAAF.total, 0.10);
assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.NHL.total, 0.25);
assert.strictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT.MLB.ml, 0.05);
assert.strictEqual(config.NFL_TOTAL_MODEL_WEIGHT, 1);

assert.strictEqual(modelWeightFor('NFL', 'Total'), 0);
assert.strictEqual(modelWeightFor('NFL', 'total'), 0);
assert.notStrictEqual(modelWeightFor('NFL', 'Total'), null);
assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.40);
assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.40);
assert.strictEqual(modelWeightFor('NCAAF', 'Total'), 0.10);
assert.strictEqual(modelWeightFor('NHL', 'Total'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Run Line'), 0.25);
assert.strictEqual(modelWeightFor('NBA', 'Total'), null);

assert.strictEqual(anchorProbability(0.80, 0.42, 0), 0.42);
assert.strictEqual(anchorProbability(0.80, 0.42, modelWeightFor('NFL', 'Total')), 0.42);
assert.ok(Math.abs(
  anchorProbability(0.80, 0.42, modelWeightFor('NFL', 'Spread')) - (0.40 * 0.80 + 0.60 * 0.42),
) < 1e-12);

const totalRow = {
  sport: 'NFL', market: 'Total', side: 'Over 45.5', line: 45.5,
  modelPureP: 0.80, coverProb: 0.70, ratingN: 6, odds: -110,
  matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
  pinnacleSide: { american: -105, oppAmerican: -115, point: 45.5, oppPoint: 45.5 },
};
const fair = pinnacleFair(totalRow);
const [totalOut] = applyMarketAnchor([totalRow]);
assert.strictEqual(totalOut.anchorWeight, 0);
assert.strictEqual(totalOut.anchorFairSource, 'pinnacle');
assert.ok(fair > 0 && fair < 1);
assert.strictEqual(totalOut.coverProb, fair);
assert.strictEqual(totalOut.coverProb, anchorProbability(0.80, fair, 0));
assert.ok(Math.abs(totalOut.p_fair - fair) < 5e-7);
assert.ok(Math.abs(totalOut.coverProb - 0.80) > 0.05);
assert.strictEqual(totalOut.ratingSe, 0);
assert.ok(Number.isFinite(totalOut.ratingSe));

const totalSe = ratingSeOf({ sport: 'NFL', market: 'Total', modelPureP: 0.62, ratingN: 6 });
assert.strictEqual(totalSe, 0);
assert.ok(Number.isFinite(totalSe));
assert.strictEqual(edgeFloorSe(totalSe), 0.02);
assert.ok(Number.isFinite(edgeFloorSe(0)));
assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.03, ratingSe: 0 }), false);
assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.01, ratingSe: 0 }), true);
const spreadSe = ratingSeOf({ sport: 'NFL', market: 'Spread', modelPureP: 0.62, ratingN: 6 });
assert.ok(Number.isFinite(spreadSe) && spreadSe > 0);

console.log('test-omega-outcome-sd-1018b ok');
