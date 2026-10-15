'use strict';
// Extreme margin bias is off the card. Win percent is one decimal from the
// same probability as edge and EV. A parlay needs three covers at or above 45%.
const assert = require('assert');
const { extremeMarginSports } = require('./netlify/functions/lib/omega-vnext/health');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { toPickObject, passesPublishFloor, eligibleForLeanPool, orderedByScore } = require('./netlify/functions/lib/omega-vnext/select');
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
    commenceTime: '2026-10-16T00:00:00Z',
  };
}

// NHL limit is 0.3. 3× is 0.9. Home residual is projection + line.
const nhl = spread('NHL', -2.5, -1.5);
assert.ok(Math.abs((-2.5) + (-1.5)) > 0.9);
assert.deepStrictEqual(extremeMarginSports([nhl]), ['NHL']);
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

const hi = { sport: 'NCAAF', matchup: 'A @ B', side: 'B', ev: 0.03, edgePct: 0.05, coverProb: 0.69, odds: -180 };
const lo = { sport: 'NCAAF', matchup: 'C @ D', side: 'D', ev: 0.08, edgePct: 0.02, coverProb: 0.4, odds: 180 };
assert.strictEqual(orderedByScore([lo, hi])[0].side, 'B');

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
assert.ok(isNoQualifyingParlay(short[0]));

const banned = parlayFromStraights([
  { ...leg('A @ B', 0.56, 0.09), sport: 'NHL', marginBiasExtreme: true },
  leg('C @ D', 0.55, 0.04),
  leg('E @ F', 0.55, 0.04),
]);
assert.ok(isNoQualifyingParlay(banned[0]));
const kept = parlayFromStraights([
  { ...leg('A @ B', 0.56, 0.09), sport: 'NHL', marginBiasExtreme: true },
  leg('C @ D', 0.55, 0.04),
  leg('E @ F', 0.55, 0.04),
  leg('G @ H', 0.55, 0.03),
]);
assert.strictEqual(kept[0].qualifying, true);
assert.ok(!(kept[0].legs || []).some((row) => row.sport === 'NHL'));

console.log('PASS test-omega-card-math-1015');
