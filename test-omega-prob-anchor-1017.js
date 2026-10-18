'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { americanToImplied, americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { powerFair } = require('./netlify/functions/lib/omega-vnext/pure_model');
const { gateReason } = require('./netlify/functions/lib/omega-vnext/gates');
const {
  anchorProbability, applyMarketAnchor, priceEdgeAtBet,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');

assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.4.0-webetai-pure:'));
assert.strictEqual(config.marketAnchorOn(), false);
// 2026-10-18: NFL ml/spread 0.40 ASSUMED INTERIM; NCAAF ml/spread, NHL spread, MLB ml 0.05 token floor. NFL total stays 0.
assert.deepStrictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT, {
  NCAAF: { spread: 0.05, ml: 0.05, total: 0.10 },
  NFL: { spread: 0.40, ml: 0.40, total: 0 },
  NHL: { spread: 0.05, ml: 0.25, total: 0.25 },
  MLB: { spread: 0.25, ml: 0.05, total: 0.25 },
});
// 2026-10-18: NFL margin rating SD is {base:4, k:NFL_PRIOR_K}, not a flat 8.
assert.deepStrictEqual(config.RATING_ERROR_SD.NFL.margin, { base: 4, k: config.NFL_PRIOR_K });
assert.strictEqual(config.RATING_ERROR_SD.NFL.total, 6);
assert.strictEqual(config.RATING_ERROR_SD.NCAAF.margin, 8);
assert.strictEqual(config.RATING_ERROR_SD.NCAAF.total, 6);
assert.strictEqual(config.RATING_ERROR_SD.NHL.margin, 0.5 * config.SPORT_SPREAD_STD.NHL);
assert.strictEqual(config.RATING_ERROR_SD.NHL.total, 0.5 * config.SPORT_TOTAL_STD.NHL);
assert.strictEqual(config.RATING_ERROR_SD.MLB.margin, 0.5 * config.SPORT_SPREAD_STD.MLB);
assert.strictEqual(config.RATING_ERROR_SD.MLB.total, 0.5 * config.SPORT_TOTAL_STD.MLB);
// 2026-10-18: NFL margin game SD is the Elo RMSE 13.2, not 13.5.
assert.deepStrictEqual(config.SPORT_SPREAD_STD, { NFL: 13.2, NCAAF: 16.0, NBA: 12.0, NHL: 2.5, MLB: 4.2 });
assert.deepStrictEqual(config.SPORT_TOTAL_STD, { NFL: 10.5, NCAAF: 13.5, NBA: 18.0, NHL: 1.8, MLB: 3.5 });

for (const sport of ['NCAAF', 'NHL', 'MLB']) {
  for (const kind of ['margin', 'total']) {
    const game = kind === 'total' ? config.SPORT_TOTAL_STD[sport] : config.SPORT_SPREAD_STD[sport];
    const base = config.RATING_ERROR_SD[sport][kind];
    const full = config.effectiveSd(sport, kind, 6);
    const late = config.effectiveSd(sport, kind, 17);
    assert.ok(full > game, `${sport} ${kind} effective SD`);
    assert.ok(late >= game && late < full, `${sport} ${kind} shrinks with n`);
    assert.ok(Math.abs(config.ratingErrorSd(sport, kind, 6) - base) < 1e-12);
    assert.ok(Math.abs(config.ratingErrorSd(sport, kind) - base) < 1e-12);
    assert.ok(Math.abs(config.ratingErrorSd(sport, kind, 2) - base) < 1e-12);
    assert.ok(Math.abs(config.ratingErrorSd(sport, kind, 17) - base * Math.sqrt(6 / 17)) < 1e-12);
    assert.ok(Math.abs(full - Math.sqrt(game * game + base * base)) < 1e-12);
  }
}
// 2026-10-18: NFL margin is sqrt(13.2^2 + (4*sqrt(K/(K+n)))^2), not 13.5 with base 8.
const nflK = config.NFL_PRIOR_K;
const nflRating = (n) => 4 * Math.sqrt(nflK / (nflK + n));
assert.ok(Math.abs(config.effectiveSd('NFL', 'margin', 6) - Math.sqrt(13.2 * 13.2 + nflRating(6) ** 2)) < 1e-12);
assert.ok(config.effectiveSd('NFL', 'total', 17) < config.effectiveSd('NFL', 'total', 6));
assert.strictEqual(config.effectiveSd('NBA', 'margin'), config.SPORT_SPREAD_STD.NBA);
assert.strictEqual(config.effectiveSd('NBA', 'total', 40), config.SPORT_TOTAL_STD.NBA);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin', 3) - nflRating(3)) < 1e-12);
assert.ok(Math.abs(config.ratingErrorSd('NFL', 'margin', 17) - nflRating(17)) < 1e-12);
assert.strictEqual(config.ratingErrorSd('NBA', 'total'), 0);

assert.strictEqual(anchorProbability(0.60, 0.40, 0), 0.40);
assert.strictEqual(anchorProbability(0.60, 0.40, 1), 0.60);
assert.ok(Math.abs(anchorProbability(0.60, 0.40, 0.25) - 0.45) < 1e-12);

function nhlRow(extra) {
  return {
    sport: 'NHL',
    market: 'Moneyline',
    side: 'Colorado Avalanche',
    matchup: 'Dallas Stars @ Colorado Avalanche',
    awayTeam: 'Dallas Stars',
    homeTeam: 'Colorado Avalanche',
    commenceTime: '2026-10-17T23:00:00Z',
    odds: -110,
    coverProb: 0.60,
    modelPureP: 0.71,
    fair_sharp_p: 0.99,
    ...extra,
  };
}

const pin = nhlRow({
  pinnacleSide: { american: -110, oppAmerican: -110, point: null, oppPoint: null },
});
const pinFair = powerFair(pin);
assert.ok(Math.abs(pinFair - 0.5) < 1e-12, pinFair);
const [anchoredNhl] = applyMarketAnchor([pin]);
assert.strictEqual(anchoredNhl.anchorFairSource, 'pinnacle');
assert.strictEqual(anchoredNhl.anchorWeight, 0.25);
assert.strictEqual(anchoredNhl.p_model, 0.71);
assert.strictEqual(anchoredNhl.p_fair, 0.5);
assert.ok(Math.abs(anchoredNhl.coverProb - (0.25 * 0.71 + 0.75 * 0.5)) < 1e-12, anchoredNhl.coverProb);
assert.strictEqual(anchoredNhl.p_calibrated, 0.6);
assert.notStrictEqual(anchoredNhl.coverProb, anchoredNhl.modelPureP);
assert.ok(Math.abs(anchoredNhl.p_fair - 0.99) > 0.2);

const lopsided = nhlRow({
  pinnacleSide: { american: -150, oppAmerican: 130, point: null, oppPoint: null },
});
const lopFair = powerFair(lopsided);
assert.ok(lopFair != null && Math.abs(lopFair - 0.99) > 0.2);
const [lop] = applyMarketAnchor([lopsided]);
assert.strictEqual(lop.anchorFairSource, 'pinnacle');
assert.strictEqual(lop.p_fair, +Number(lopFair).toFixed(6));
assert.ok(Math.abs(lop.coverProb - anchorProbability(0.71, lopFair, 0.25)) < 1e-12);

function dkSide(sport, side, line, p) {
  return {
    sport,
    market: 'Spread',
    side,
    line,
    matchup: 'Away @ Home',
    awayTeam: 'Away',
    homeTeam: 'Home',
    commenceTime: '2026-10-17T23:00:00Z',
    book: 'draftkings',
    odds: -110,
    coverProb: p,
  };
}
const [mlbHome] = applyMarketAnchor([
  dkSide('MLB', 'Home', -1.5, 0.60),
  dkSide('MLB', 'Away', 1.5, 0.40),
]);
assert.strictEqual(mlbHome.anchorFairSource, 'draftkings');
assert.strictEqual(mlbHome.anchorWeight, 0.25);
assert.strictEqual(mlbHome.p_model, 0.60);
assert.ok(Math.abs(mlbHome.p_fair - 0.5) < 1e-9);
assert.ok(Math.abs(mlbHome.coverProb - 0.525) < 1e-12, mlbHome.coverProb);

const ncaaf = { sport: 'NCAAF', market: 'Spread', coverProb: 0.62, modelPureP: 0.70, odds: -110, pinnacleSide: { american: -110, oppAmerican: -110 } };
const nfl = { sport: 'NFL', market: 'Total', coverProb: 0.62, modelPureP: 0.70, odds: -110, pinnacleSide: { american: -110, oppAmerican: -110 } };
const nba = { sport: 'NBA', market: 'Spread', coverProb: 0.62, modelPureP: 0.70, odds: -110, pinnacleSide: { american: -110, oppAmerican: -110 } };
const [ncaafOut, nflOut, nbaOut] = applyMarketAnchor([ncaaf, nfl, nba]);
assert.strictEqual(ncaafOut.anchorFairSource, 'pinnacle');
assert.strictEqual(ncaafOut.anchorWeight, 0.05); // 2026-10-18: NCAAF spread token floor, was 0.25.
assert.strictEqual(nflOut.anchorFairSource, 'pinnacle');
assert.strictEqual(nflOut.anchorWeight, 0); // 2026-10-18: NFL totals w=0, so p_final is the fair.
assert.ok(Math.abs(ncaafOut.coverProb - (0.05 * 0.70 + 0.95 * 0.5)) < 1e-12);
assert.ok(Math.abs(nflOut.coverProb - 0.5) < 1e-12);
assert.strictEqual(nbaOut, nba);
assert.strictEqual(nbaOut.anchorFairSource, undefined);

const [none] = applyMarketAnchor([nhlRow()]);
assert.strictEqual(none.anchorFairSource, 'none');
assert.strictEqual(none.coverProb, 0.60);
assert.strictEqual(none.p_fair, null);
assert.strictEqual(none.p_model, 0.71);
assert.strictEqual(none.anchorWeight, 0.25);

const p = 0.55;
const implied = americanToImplied(-110);
const dec = americanToDecimal(-110);
const edge = p - implied;
const ev = p * dec - 1;
assert.ok(edge > 0 && ev > 0);
assert.ok(Math.abs(ev / edge - dec) < 1e-9);
const priced = priceEdgeAtBet({
  sport: 'NHL', book: 'draftkings', odds: -110, coverProb: p, modelPureP: 0.9,
  sharpFairPriced: true, movementDrop: true, liquid: false,
});
assert.strictEqual(priced.edgePct, +edge.toFixed(6));
assert.strictEqual(priced.ev, +ev.toFixed(6));
assert.strictEqual(priced.coverProb, p);
assert.strictEqual(priced.modelPureP, 0.9);
assert.notStrictEqual(priced.pureModelPriced, true);
assert.strictEqual(priced.liquid, true);
assert.strictEqual(priced.sharpFairPriced, false);
assert.strictEqual(priced.movementDrop, false);
assert.strictEqual(priced.edgeBasis, 'model-edge-vs-bet-price');
assert.strictEqual(priceEdgeAtBet({ book: 'hardrockbet', odds: -110, coverProb: p }).liquid, true);
assert.strictEqual(priceEdgeAtBet({ book: 'fanduel', odds: -110, coverProb: p, liquid: false }).liquid, false);

const future = new Date(Date.now() + 864e5).toISOString();
assert.strictEqual(gateReason({
  ...priced,
  commenceTime: future,
  movementDrop: true,
  movementDropReason: 'sharp_prob_against: -0.0300',
  lineMove: { steamAgainst: true, cents: 40 },
}), null);
assert.strictEqual(gateReason({
  sport: 'NFL', market: 'Spread', odds: -110, coverProb: 0.55, ev: 0.04, edgePct: 0.03,
  liquid: true, commenceTime: future,
  movementDrop: true, movementDropReason: 'sharp_prob_against: -0.0300',
}), 'sharp_prob_against: -0.0300');

const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
assert.ok(!indexSrc.includes('applyPureModel('));
assert.ok(indexSrc.includes('candidates = calibrateAll(candidates, { cardDate: dateISO })'));
assert.ok(indexSrc.includes('applyMarketAnchor(candidates)'));

console.log('test-omega-prob-anchor-1017 ok');
