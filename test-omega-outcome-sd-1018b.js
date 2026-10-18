'use strict';
// NFL margin game SD and rating-error law refit to outcomes (2026-10-18).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');

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

console.log('test-omega-outcome-sd-1018b ok');
