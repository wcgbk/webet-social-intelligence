'use strict';
// One publish gate: push-aware stake EV at the bet price >= 2%.
// Edge versus the vigged price is display and tiebreak only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { compareByEv, passesPublishFloor, eligibleForLeanPool } = require('./netlify/functions/lib/omega-vnext/select');
const { pushAwareEv, anchoredStakeEv } = require('./netlify/functions/lib/omega-vnext/push_ev');
const { requiredFloor } = require('./netlify/functions/lib/omega-vnext/shortfall');
const edgeFloor = require('./netlify/functions/lib/omega-vnext/edge_floor');

const asOf = { cardDate: '2026-10-18', asOfMs: Date.parse('2026-10-18T14:00:00Z') };

function side(extra) {
  return {
    sport: 'NFL', matchup: 'A @ B', side: 'A +3.5', market: 'Spread', line: 3.5,
    odds: -110, coverProb: 0.55, ev: 0.04, edgePct: 0.03, liquid: true,
    uncertainty: 0.15, commenceTime: '2026-10-18T20:00:00Z',
    homeTeam: 'B', awayTeam: 'A', book: 'draftkings', ratingSe: 0.04,
    ...extra,
  };
}

assert.strictEqual(config.GATES.minEV.NFL, 0.02);
assert.strictEqual(config.EV_CAP_ALL, 0.10);
assert.strictEqual(config.GATES.minAmericanOdds, -250);
assert.strictEqual(config.GATES.maxAmericanOdds, 250);
assert.strictEqual(config.EDGE_FLOOR_K, undefined);
assert.strictEqual(edgeFloor.edgeFloorSe, undefined);
assert.strictEqual(edgeFloor.failsEdgeFloorSe, undefined);

// Long-odds dog: 1.5% edge, 2.4% stake EV. The edge floor used to reject it.
const dog = side({
  odds: 200, market: 'Moneyline', side: 'A ML', line: null,
  edgePct: 0.015, ev: 0.024, coverProb: 0.40, ratingSe: 0.08,
});
assert.strictEqual(gateReason(dog, asOf), null);
assert.strictEqual(passesPublishFloor(dog), true);
const dogGated = applyGates([dog], asOf);
assert.strictEqual(dogGated.yesPool.length, 1);
assert.strictEqual(dogGated.yesPool[0].tier, 'floor');
assert.strictEqual(dogGated.yesPool[0].edgePct, 0.015);
assert.strictEqual(dogGated.leanPool.length, 0);

// 2.2% edge and 1.5% stake EV misses only the EV floor and stays a lean.
const shortEv = side({
  matchup: 'C @ D', side: 'D -6.5', homeTeam: 'D', awayTeam: 'C',
  odds: -200, edgePct: 0.022, ev: 0.015, coverProb: 0.70,
});
assert.strictEqual(gateReason(shortEv, asOf), 'ev-floor');
assert.strictEqual(passesPublishFloor(shortEv), false);
const shortGated = applyGates([shortEv], asOf);
assert.strictEqual(shortGated.yesPool.length, 0);
assert.strictEqual(shortGated.leanPool.length, 1);
assert.strictEqual(shortGated.leanPool[0].leanReason, 'ev-floor');
assert.strictEqual(shortGated.rejected.length, 0);
assert.strictEqual(requiredFloor(shortEv, 'ev-floor'), 0.02);
assert.strictEqual(requiredFloor(shortEv, 'edge-floor-se'), null);

// pPush > 0 lowers EV. Naive 3.1% at -110 falls under 2% at pPush 0.40.
const p = 0.54;
const odds = -110;
const pPush = 0.40;
const naive = pushAwareEv(p, odds, 0);
const pushed = pushAwareEv(p, odds, pPush);
assert.ok(naive + 1e-12 >= 0.02, naive);
assert.ok(pushed < naive, `${pushed} vs ${naive}`);
assert.ok(pushed + 1e-12 < 0.02, pushed);
const pushedRow = side({
  coverProb: p, odds, pPush, ev: naive, edgePct: p - (110 / 210),
});
assert.ok(Math.abs(anchoredStakeEv(pushedRow) - pushed) < 1e-12);
assert.strictEqual(gateReason(pushedRow, asOf), 'ev-floor');
assert.strictEqual(passesPublishFloor(pushedRow), false);
const openRow = side({
  coverProb: p, odds, pPush: 0, ev: naive, edgePct: p - (110 / 210),
});
assert.strictEqual(gateReason(openRow, asOf), null);

// A naive EV above the 10% cap that push scales under the cap is not ev-stale.
const hotP = 1.12 * 110 / 210;
const hotNaive = pushAwareEv(hotP, -110, 0);
const hotPush = pushAwareEv(hotP, -110, 0.4);
assert.ok(hotNaive > config.EV_CAP_ALL, hotNaive);
assert.ok(hotPush > 0.02 && hotPush < config.EV_CAP_ALL, hotPush);
assert.strictEqual(gateReason(side({
  coverProb: hotP, odds: -110, pPush: 0.4, ev: hotNaive, edgePct: 0.06,
}), asOf), null);

// The noise rule is unchanged: edge under 1% and EV under 1% is not a lean.
const noise = side({
  matchup: 'E @ F', side: 'F +3', homeTeam: 'F', awayTeam: 'E',
  edgePct: 0.005, ev: 0.005, coverProb: 0.51,
});
assert.strictEqual(eligibleForLeanPool(noise), false);
const noiseGated = applyGates([noise], asOf);
assert.strictEqual(noiseGated.leanPool.length, 0);
assert.strictEqual(noiseGated.rejected[0].rejectReason, 'ev-floor');
const oneSided = side({
  matchup: 'G @ H', side: 'H +3', homeTeam: 'H', awayTeam: 'G',
  edgePct: 0.005, ev: 0.015, coverProb: 0.52,
});
assert.strictEqual(eligibleForLeanPool(oneSided), true);
assert.strictEqual(applyGates([oneSided], asOf).leanPool[0].leanReason, 'ev-floor');
assert.strictEqual(eligibleForLeanPool(side({ edgePct: 0, ev: 0.024 })), true);

// ratingSe and OMEGA_EDGE_FLOOR_K do not move the floor. The 10% cap and the band stay.
process.env.OMEGA_EDGE_FLOOR_K = '1.5';
try {
  assert.strictEqual(gateReason(side({
    edgePct: 0.015, ev: 0.024, ratingSe: 0.2, odds: 180, coverProb: 0.40,
  }), asOf), null);
} finally {
  delete process.env.OMEGA_EDGE_FLOOR_K;
}
assert.strictEqual(gateReason(side({ ev: 0.11, edgePct: 0.08 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ odds: 251, ev: 0.04, edgePct: 0.04 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ odds: -251, ev: 0.04, edgePct: 0.04 }), asOf), 'odds-out-of-band');

// Same stake EV: the higher edge still wins the tiebreak.
assert.ok(compareByEv(
  side({ ev: 0.03, edgePct: 0.01, matchup: 'I @ J' }),
  side({ ev: 0.03, edgePct: 0.04, matchup: 'K @ L' }),
) > 0);

const lib = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
for (const name of ['gates.js', 'edge_floor.js', 'shortfall.js', 'card_topup.js', 'select.js', 'health.js']) {
  const text = fs.readFileSync(path.join(lib, name), 'utf8');
  assert.ok(!text.includes('edge-floor-se'), `${name} still says edge-floor-se`);
}

console.log('test-omega-ev-gate-1018c ok');
