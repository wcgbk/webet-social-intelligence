'use strict';
// Extreme margin bias is off the card. Win percent is one decimal from the
// same probability as edge and EV. Two positive-EV games publish a 2-leg.
const assert = require('assert');
const { extremeMarginSports, extremeMarginGames, marginGamesOffCard } = require('./netlify/functions/lib/omega-vnext/health');
const { gateReason, applyGates, projectionDisagrees } = require('./netlify/functions/lib/omega-vnext/gates');
const { toPickObject, passesPublishFloor, eligibleForLeanPool, orderedByScore } = require('./netlify/functions/lib/omega-vnext/select');
const { formatEdgePct } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { parlayFromStraights, isNoQualifyingParlay } = require('./netlify/functions/lib/omega-vnext/parlay');

function spread(sport, proj, line) {
  return {
    sport,
    matchup: 'Away @ Home',
    homeTeam: 'Home',
    awayTeam: 'Away',
    market: 'Spread',
    side: 'Home -1.5',
    modelProjection: proj,
    line,
    odds: 130,
    coverProb: 0.55,
    ev: 0.05,
    edgePct: 0.04,
    liquid: true,
    commenceTime: '2026-12-01T00:00:00Z',
  };
}

// NHL puck line is a fixed ±1.5, so the margin residual is null and the
// game stays on the card. The gate still drops a row once the flag is set.
const nhl = spread('NHL', -2.5, -1.5);
assert.deepStrictEqual(extremeMarginSports([nhl]), []);
assert.deepStrictEqual(marginGamesOffCard([nhl]), []);
assert.strictEqual(gateReason({ ...nhl, marginBiasExtreme: true }), 'bias-margin-extreme');

const gated = applyGates([
  { ...nhl, marginBiasExtreme: true },
  { ...spread('NCAAF', -1.5, -1.5), ev: 0.01 },
]);
assert.strictEqual(gated.yesPool.length, 0);
assert.strictEqual(gated.leanPool.length, 1);
assert.strictEqual(gated.leanPool[0].sport, 'NCAAF');
assert.ok(gated.rejected.some((row) => row.rejectReason === 'bias-margin-extreme' && row.sport === 'NHL'));
assert.strictEqual(passesPublishFloor({ ...nhl, marginBiasExtreme: true }), false);
assert.strictEqual(eligibleForLeanPool({ ...nhl, marginBiasExtreme: true }), false);

// NCAAF limit is 1. 3× is 3. A 2-point residual is over the alert and not extreme.
const cfb = spread('NCAAF', -0.5, -1.5);
assert.ok(Math.abs(-0.5 + -1.5) > 1);
assert.ok(Math.abs(-0.5 + -1.5) < 3);
assert.deepStrictEqual(extremeMarginSports([cfb]), []);

// One outlier does not blank a second game inside the cut.
const outlier = spread('NCAAF', 13.5, -3.5);
const calm = {
  ...spread('NCAAF', -5.5, 7),
  matchup: 'Memphis Tigers @ Tulane Green Wave',
  homeTeam: 'Tulane Green Wave',
  awayTeam: 'Memphis Tigers',
  side: 'Tulane Green Wave +7',
};
const held = extremeMarginGames([outlier, calm]);
assert.deepStrictEqual(held.map((g) => g.matchup), ['Away @ Home']);
assert.ok(Math.abs(held[0].margin - 10) < 1e-9);
assert.deepStrictEqual(extremeMarginSports([outlier, calm]), ['NCAAF']);
assert.deepStrictEqual(marginGamesOffCard([outlier, calm]).map((g) => g.matchup), ['Away @ Home']);

// Fixed ±1.5 puck lines are not margin residuals, so these NHL games
// do not form a sport-level margin bias and stay on the card.
const pit = {
  sport: 'NHL', matchup: 'Pittsburgh Penguins @ Colorado Avalanche',
  homeTeam: 'Colorado Avalanche', awayTeam: 'Pittsburgh Penguins',
  market: 'Spread', side: 'Colorado Avalanche -1.5', modelProjection: 0.38, line: -1.5,
};
const ana = {
  sport: 'NHL', matchup: 'Boston Bruins @ Anaheim Ducks',
  homeTeam: 'Anaheim Ducks', awayTeam: 'Boston Bruins',
  market: 'Spread', side: 'Anaheim Ducks +1.5', modelProjection: -0.11, line: 1.5,
};
assert.deepStrictEqual(extremeMarginSports([pit, ana]), []);
assert.deepStrictEqual(marginGamesOffCard([pit, ana]), []);
assert.deepStrictEqual(marginGamesOffCard([nhl]), []);

const zeroEvOver = {
  sport: 'NHL',
  matchup: 'Boston Bruins @ Anaheim Ducks',
  homeTeam: 'Anaheim Ducks',
  awayTeam: 'Boston Bruins',
  market: 'Total',
  side: 'Over 6.5',
  line: 6.5,
  modelProjection: 6.14,
  betProjection: 6.14,
  odds: 105,
  coverProb: 0.488,
  ev: 0.0004,
  edgePct: 0.0002,
  pureModelPriced: true,
  book: 'draftkings',
  liquid: true,
};
assert.strictEqual(projectionDisagrees(zeroEvOver), true);
assert.strictEqual(gateReason(zeroEvOver), 'projection-disagrees');
assert.strictEqual(eligibleForLeanPool(zeroEvOver), false);
const puck = {
  sport: 'NHL',
  matchup: 'Pittsburgh Penguins @ Colorado Avalanche',
  homeTeam: 'Colorado Avalanche',
  awayTeam: 'Pittsburgh Penguins',
  market: 'Spread',
  side: 'Pittsburgh Penguins +1.5',
  line: 1.5,
  modelProjection: 0.38,
  odds: -142,
  coverProb: 0.634,
  ev: 0.081,
  edgePct: 0.0476,
  pureModelPriced: true,
};
assert.strictEqual(projectionDisagrees(puck), false);
const underAgrees = {
  ...zeroEvOver,
  side: 'Under 6.5',
  modelProjection: 6.14,
  betProjection: 6.14,
};
assert.strictEqual(projectionDisagrees(underAgrees), false);

const shown = toPickObject({
  sport: 'NHL',
  matchup: 'Islanders @ Senators',
  side: 'Islanders',
  market: 'Moneyline',
  odds: 130,
  coverProb: 0.486897,
  ev: 0.11986,
  edgePct: 0.05211,
  pureModelPriced: true,
  homeTeam: 'Senators',
  awayTeam: 'Islanders',
});
assert.strictEqual(shown.winProbability, '48.7%');
assert.strictEqual(shown.coverProb, '48.7%');
assert.strictEqual(shown.edge, '5.2%');
assert.strictEqual(shown.ev, '12.0%');

const total = toPickObject({
  sport: 'NCAAF',
  matchup: 'Colorado State Rams @ Texas State Bobcats',
  side: 'Over 69.5',
  market: 'Total',
  odds: -105,
  coverProb: 0.5235,
  ev: 0.02207,
  edgePct: 0.0113,
  pureModelPriced: true,
  line: 69.5,
  homeTeam: 'Texas State Bobcats',
  awayTeam: 'Colorado State Rams',
});
assert.strictEqual(total.winProbability, '52.3%');
assert.strictEqual(total.edge, '1.1%');
assert.strictEqual(total.ev, '2.1%');

assert.strictEqual(formatEdgePct(0.015499999999999958), '1.6%');
assert.strictEqual(formatEdgePct(0.0154), '1.5%');
assert.strictEqual(formatEdgePct(0), '0.0%');
assert.strictEqual(formatEdgePct(-0.015499999999999958), '-1.6%');

const reserve = toPickObject({
  sport: 'NCAAF',
  matchup: 'Memphis Tigers @ Tulane Green Wave',
  side: 'Tulane Green Wave ML',
  market: 'Moneyline',
  odds: 220,
  coverProb: 0.328,
  edgePct: '1.5%',
  ev: 0.048609,
  pureModelPriced: true,
  homeTeam: 'Tulane Green Wave',
  awayTeam: 'Memphis Tigers',
});
assert.strictEqual(reserve.winProbability, '32.8%');
assert.strictEqual(reserve.edge, '1.6%');
assert.strictEqual(reserve.ev, '5.0%');
assert.notStrictEqual(reserve.evRaw, 0);

const penguinsCard = toPickObject({
  ...puck,
  coverProb: 0.6343912972348869,
  edgePct: 0.047614,
  ev: 0.081146,
});
assert.strictEqual(penguinsCard.winProbability, '63.4%');
assert.strictEqual(penguinsCard.edge, '4.7%');
assert.strictEqual(penguinsCard.ev, '8.0%');

// Shrunk EV ranks first. The higher edge does not outrank the higher EV.
const hi = { sport: 'NCAAF', matchup: 'A @ B', side: 'B', ev: 0.03, edgePct: 0.05, coverProb: 0.69, odds: -180 };
const lo = { sport: 'NCAAF', matchup: 'C @ D', side: 'D', ev: 0.08, edgePct: 0.02, coverProb: 0.4, odds: 180 };
assert.strictEqual(orderedByScore([lo, hi])[0].side, 'D');

function leg(matchup, cover, edge) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NCAAF', matchup, side: parts[0], market: 'Moneyline', odds: -110,
    coverProb: cover, edgePct: edge, homeTeam: parts[1], awayTeam: parts[0], tier: 'floor',
  };
}
const short = parlayFromStraights([
  leg('Georgia Southern @ App State', 0.56, 0.05),
  leg('UAB @ Rice', 0.38, 0.024),
  leg('Army @ Navy', 0.55, 0.03),
]);
// 2026-10-18: UAB at 0.38 is negative EV at -110, so it is not a leg. The other two publish as a 2-leg.
assert.strictEqual(short[0].qualifying, true);
assert.strictEqual(short[0].type, '2-leg-parlay');
assert.strictEqual(short[0].legs.length, 2);
assert.ok(!short[0].legs.some((row) => /UAB|Rice/.test(String(row.matchup))));

const twoCard = parlayFromStraights([
  { ...leg('Pittsburgh Penguins @ Colorado Avalanche', 0.634, 0.047), odds: -142, rating: 'a' },
  { ...leg('Memphis Tigers @ Tulane Green Wave', 0.328, 0.016), odds: 220, rating: 'b' },
]);
assert.strictEqual(twoCard[0].type, '2-leg-parlay');
assert.strictEqual(twoCard[0].qualifying, true);
assert.strictEqual(twoCard[0].legs.length, 2);
assert.ok(!isNoQualifyingParlay(twoCard[0]));

const banned = parlayFromStraights([
  { ...leg('A @ B', 0.56, 0.09), sport: 'NHL', marginBiasExtreme: true },
  leg('C @ D', 0.55, 0.04),
  leg('E @ F', 0.55, 0.04),
]);
// 2026-10-18: the margin-bias ban leaves two eligible games, which publish as a 2-leg.
assert.strictEqual(banned[0].qualifying, true);
assert.strictEqual(banned[0].type, '2-leg-parlay');
assert.strictEqual(banned[0].legs.length, 2);
assert.ok(!(banned[0].legs || []).some((row) => row.sport === 'NHL'));
const kept = parlayFromStraights([
  { ...leg('A @ B', 0.56, 0.09), sport: 'NHL', marginBiasExtreme: true },
  leg('C @ D', 0.55, 0.04),
  leg('E @ F', 0.55, 0.04),
  leg('G @ H', 0.55, 0.03),
]);
assert.strictEqual(kept[0].qualifying, true);
assert.ok(!(kept[0].legs || []).some((row) => row.sport === 'NHL'));

console.log('PASS test-omega-card-math-1015');
