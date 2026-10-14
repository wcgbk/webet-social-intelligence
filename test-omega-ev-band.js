'use strict';
// Inclusion EV is flat. The longshot multiplier stays exported and does not raise the floor.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { evBandMultiplier, mainMinEv } = require('./netlify/functions/lib/omega-vnext/edge_floor');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { passesPublishFloor, qualifiesAsLean } = require('./netlify/functions/lib/omega-vnext/select');
const { minEdgeClears, leanClears } = require('./netlify/functions/lib/omega-vnext/hr_autocorrect');
const { requiredFloor } = require('./netlify/functions/lib/omega-vnext/shortfall');

assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);
assert.strictEqual(config.LEAN_MIN_EV, 0.015);
assert.strictEqual(config.GATES.minEV.NFL, 0.02);
assert.strictEqual(config.GATES.minEV.default, 0.02);
assert.strictEqual(config.GATES.maxEV, 0.12);

assert.strictEqual(evBandMultiplier(-300), 1);
assert.strictEqual(evBandMultiplier(-110), 1);
assert.strictEqual(evBandMultiplier(150), 1);
assert.strictEqual(evBandMultiplier(151), 1.5);
assert.strictEqual(evBandMultiplier(180), 1.5);
assert.strictEqual(evBandMultiplier(200), 1.5);
assert.strictEqual(evBandMultiplier(201), 2);
assert.strictEqual(evBandMultiplier(250), 2);
assert.strictEqual(evBandMultiplier(300), 2);
assert.strictEqual(evBandMultiplier('+180'), 1.5);
assert.strictEqual(evBandMultiplier('EVEN'), 1);
assert.strictEqual(mainMinEv('+180', 0.02), 0.02);
assert.strictEqual(mainMinEv('EVEN', 0.02), 0.02);
assert.strictEqual(mainMinEv(220, 0.02), 0.02);
assert.strictEqual(mainMinEv(200, null), 0.02);
assert.strictEqual(evBandMultiplier(180), 1.5);

const asOf = { cardDate: '2026-10-13', asOfMs: Date.parse('2026-10-13T13:30:00Z') };
function side(extra) {
  return {
    sport: 'NFL', matchup: 'A @ B', side: 'A ML', market: 'Moneyline', line: null,
    odds: -110, coverProb: 0.55, ev: 0.04, edgePct: 0.04, liquid: true,
    uncertainty: 0.15, commenceTime: '2026-10-13T20:00:00Z',
    homeTeam: 'B', awayTeam: 'A', book: 'draftkings',
    ...extra,
  };
}

assert.strictEqual(gateReason(side({ odds: 180, ev: 0.019, edgePct: 0.04 }), asOf), 'ev-floor');
assert.strictEqual(gateReason(side({ odds: 200, ev: 0.019, edgePct: 0.01 }), asOf), 'ev-floor');
assert.strictEqual(gateReason(side({ odds: 151, ev: 0.02, edgePct: 0.01 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 150, ev: 0.02, edgePct: 0.0 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 200, ev: 0.02, edgePct: 0.0 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 250, ev: 0.02, edgePct: 0.0, coverProb: 0.35 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 251, ev: 0.08, edgePct: 0.05 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ odds: -251, ev: 0.08, edgePct: 0.05 }), asOf), 'odds-out-of-band');
assert.strictEqual(gateReason(side({ odds: -250, ev: 0.02, edgePct: 0.0 }), asOf), null);
assert.strictEqual(gateReason(side({ ev: 0.1200001, edgePct: 0.04 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ ev: 0.12, edgePct: 0.04 }), asOf), null);

const leanRow = side({ odds: 180, ev: 0.019, edgePct: 0.0, coverProb: 0.40 });
assert.strictEqual(passesPublishFloor(leanRow), false);
assert.strictEqual(qualifiesAsLean(leanRow), true);
const gated = applyGates([leanRow], asOf);
assert.strictEqual(gated.yesPool.length, 0);
assert.strictEqual(gated.leanPool.length, 1);
assert.strictEqual(gated.leanPool[0].tier, 'lean');
assert.strictEqual(gated.leanPool[0].leanReason, 'ev-floor');
assert.strictEqual(gated.rejected.length, 0);

const hr = { odds: 220, ev: 0.05, edgePct: 0.0, coverProb: 0.40, uncertainty: 0.15 };
assert.strictEqual(minEdgeClears(hr), true);
assert.strictEqual(leanClears(hr), true);
assert.strictEqual(minEdgeClears({ ...hr, odds: '+220', ev: 0.019 }), false);
assert.strictEqual(minEdgeClears({ ...hr, ev: 0.13 }), false);
assert.strictEqual(leanClears({ ...hr, ev: 0.019 }), true);
assert.strictEqual(leanClears({ ...hr, ev: 0.13 }), false);

assert.strictEqual(requiredFloor({ sport: 'NFL', odds: 220 }, 'ev-floor'), 0.02);
assert.strictEqual(requiredFloor({ sport: 'MLB', odds: -110 }, 'ev-floor'), 0.02);
assert.strictEqual(requiredFloor({ sport: 'NFL', odds: 180 }, 'ev-stale'), 0.12);

console.log('test-omega-ev-band ok');
