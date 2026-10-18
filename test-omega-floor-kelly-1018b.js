'use strict';
// Item 2: the k*SE hurdle is off by default. Rank is anchored stake EV.
// Item 5 tests are appended below the Kelly / stake / parlay marker.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { failsEdgeFloorSe, edgeFloorSe } = require('./netlify/functions/lib/omega-vnext/edge_floor');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { selectStraights, compareByEv } = require('./netlify/functions/lib/omega-vnext/select');

const asOf = { cardDate: '2026-10-18', asOfMs: Date.parse('2026-10-18T14:00:00Z') };

function side(extra) {
  return {
    sport: 'NFL', matchup: 'A @ B', side: 'A -3.5', market: 'Spread', line: -3.5,
    odds: -110, coverProb: 0.55, ev: 0.04, edgePct: 0.03, liquid: true,
    uncertainty: 0.15, commenceTime: '2026-10-18T20:00:00Z',
    homeTeam: 'B', awayTeam: 'A', book: 'draftkings', ratingSe: 0.04,
    ...extra,
  };
}

assert.strictEqual(config.EDGE_FLOOR_K, 0);
assert.strictEqual(config.EV_CAP_ALL, 0.10);
assert.strictEqual(config.GATES.minAmericanOdds, -250);
assert.strictEqual(config.GATES.maxAmericanOdds, 250);
assert.strictEqual(config.GATES.minEV.NFL, 0.02);

// Edge 3% with SE 4% used to miss max(2%, 1.5*4%) = 6%. It clears the flat 2%.
const clear = side({ edgePct: 0.03, ratingSe: 0.04, ev: 0.04 });
assert.strictEqual(edgeFloorSe(0.04), 0.02);
assert.strictEqual(failsEdgeFloorSe(clear), false);
assert.strictEqual(gateReason(clear, asOf), null);

// Edge 1% is still under the flat 2% minimum.
const thin = side({ edgePct: 0.01, ratingSe: 0, ev: 0.05 });
assert.strictEqual(failsEdgeFloorSe(thin), true);
assert.strictEqual(gateReason(thin, asOf), 'edge-floor-se');

// 2% stake EV, 10% cap, and the -250/+250 band stay.
assert.strictEqual(gateReason(side({ ev: 0.019, edgePct: 0.04 }), asOf), 'ev-floor');
assert.strictEqual(gateReason(side({ ev: 0.11, edgePct: 0.06 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ odds: 300, ev: 0.04, edgePct: 0.04 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ odds: -300, ev: 0.04, edgePct: 0.04 }), asOf), 'odds-out-of-band');

const gated = applyGates([clear, thin], asOf);
assert.strictEqual(gated.yesPool.length, 1);
assert.strictEqual(gated.yesPool[0].edgePct, 0.03);
assert.ok(gated.leanPool.some((row) => row.edgePct === 0.01) || gated.rejected.some((row) => row.edgePct === 0.01));

// Plumbing: the env override still scales the floor. Default stays 0.
process.env.OMEGA_EDGE_FLOOR_K = '1.5';
try {
  assert.strictEqual(edgeFloorSe(0.04), 0.06);
  assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.03, ratingSe: 0.04 }), true);
  assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.07, ratingSe: 0.04 }), false);
} finally {
  delete process.env.OMEGA_EDGE_FLOOR_K;
}
assert.strictEqual(edgeFloorSe(0.04), 0.02);
assert.strictEqual(config.EDGE_FLOOR_K, 0);

// Rank is stake EV. A higher edge and a larger SE do not outrank a higher EV.
function row(matchup, ev, edge, se) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, side: `${parts[1]} ML`, market: 'Moneyline',
    odds: -110, coverProb: 0.55, ev, edgePct: edge, ratingSe: se,
    liquid: true, homeTeam: parts[1], awayTeam: parts[0], book: 'draftkings',
    commenceTime: '2026-10-18T20:00:00Z',
  };
}
const lowEv = row('A @ B', 0.03, 0.08, 0.01);
const highEv = row('C @ D', 0.07, 0.03, 0.05);
assert.ok(compareByEv(lowEv, highEv) > 0);
const ranked = selectStraights([lowEv, highEv], 2);
assert.deepStrictEqual(ranked.map((c) => c.matchup), ['C @ D', 'A @ B']);

console.log('test-omega-floor-kelly-1018b item2 ok');
