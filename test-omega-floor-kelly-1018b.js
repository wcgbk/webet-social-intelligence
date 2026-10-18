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

// Item 5a: Kelly maximiser does not depend on pPush. EV stays push-aware.
const { pushAwareEv, pushAwareKelly } = require('./netlify/functions/lib/omega-vnext/push_ev');
const { kellyFraction, americanToDecimal, stakeDollars } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { quarterKellyUnits, toPickObject, applyDailyUnitCap } = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights, isNoQualifyingParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');

const pKelly = 0.54;
const oddsKelly = -110;
const pPush = 0.08;
const frac = 0.25;
assert.strictEqual(
  pushAwareKelly(pKelly, oddsKelly, frac, pPush),
  pushAwareKelly(pKelly, oddsKelly, frac, 0),
);
assert.strictEqual(
  pushAwareKelly(pKelly, oddsKelly, frac, pPush),
  kellyFraction(pKelly, oddsKelly, frac),
);
const conditionalEv = pKelly * americanToDecimal(oddsKelly) - 1;
assert.ok(Math.abs(pushAwareEv(pKelly, oddsKelly, pPush) - conditionalEv * (1 - pPush)) < 1e-12);

const decKelly = americanToDecimal(oddsKelly);
const bNet = decKelly - 1;
const fStar = (pKelly * bNet - (1 - pKelly)) / bNet;
function growth(f) {
  return (1 - pPush) * (pKelly * Math.log(1 + f * bNet) + (1 - pKelly) * Math.log(1 - f));
}
let bestF = 0;
let bestG = -Infinity;
for (let i = 1; i < 1000; i++) {
  const f = (i / 2000) * 0.5;
  const g = growth(f);
  if (g > bestG) {
    bestG = g;
    bestF = f;
  }
}
assert.ok(Math.abs(bestF - fStar) < 0.0005, `grid peak ${bestF} vs f* ${fStar}`);
assert.ok(growth(fStar) + 1e-12 >= bestG);
const full = pushAwareKelly(pKelly, oddsKelly, 1, pPush);
assert.ok(Math.abs(full - fStar) < 1e-9, `kelly ${full} vs f* ${fStar}`);
assert.ok(Math.abs(full - fStar * (1 - pPush)) > 1e-4);

// Item 5b: 0.5u is a lean floor, not a graded-stake floor. Daily-cap 0.5u stays.
function straight(extra) {
  return {
    sport: 'NFL', matchup: 'A @ B', side: 'A -3', market: 'Spread', line: -3,
    odds: -110, homeTeam: 'B', awayTeam: 'A', book: 'draftkings',
    edgePct: 0.04, ev: 0.05, uncertainty: 0.12,
    ...extra,
  };
}
const graded = toPickObject(straight({ coverProb: 0.54, edgePct: 0.04 }));
assert.strictEqual(quarterKellyUnits(0.54, -110), 0.75);
assert.strictEqual(graded.tier, 'floor');
assert.strictEqual(graded.label, 'floor');
assert.strictEqual(graded.units, '0.75u');

const smallKelly = toPickObject(straight({ coverProb: 0.53, edgePct: 0.055, ev: 0.02 }));
assert.strictEqual(quarterKellyUnits(0.53, -110), 0.25);
assert.strictEqual(smallKelly.rating, 'aplus');
assert.strictEqual(smallKelly.tier, 'lean');
assert.strictEqual(smallKelly.label, 'lean');
assert.strictEqual(smallKelly.units, '0.5u');

const namedLean = toPickObject(straight({ coverProb: 0.60, tier: 'lean', edgePct: 0.04 }));
assert.strictEqual(quarterKellyUnits(0.60, -110), 1.5);
assert.strictEqual(namedLean.tier, 'lean');
assert.strictEqual(namedLean.label, 'lean');
assert.strictEqual(namedLean.units, '0.5u');

const namedSmall = toPickObject(straight({ coverProb: 0.53, tier: 'lean', edgePct: 0.02 }));
assert.strictEqual(namedSmall.units, '0.5u');
assert.notStrictEqual(namedSmall.units, '0.25u');

assert.strictEqual(quarterKellyUnits(0.50, -110), 0);
assert.strictEqual(quarterKellyUnits(0.55, -110, 0.1), quarterKellyUnits(0.55, -110, 0));

const fatStraights = [];
for (let i = 0; i < 8; i++) {
  fatStraights.push({
    pick: `A${i}`, rating: 'aplus', qualityGrade: 'aplus', tier: 'floor',
    units: '1.5u', edgePct: '6%', qualityScore: 0.06 - i * 0.001,
  });
}
const cappedDay = applyDailyUnitCap(fatStraights, [{
  units: '0.5u', qualifying: true, type: '3-leg-parlay', legs: [], isLean: false,
}]);
assert.ok(cappedDay.picks.length > 0);
assert.ok(cappedDay.picks.every((row) => parseFloat(row.units) + 1e-9 >= 0.5));
assert.strictEqual(cappedDay.parlayLegs[0].units, '0.5u');

// Item 5c: fair EV decides a real 3-leg ticket versus a 0.25u lean. A short slate is unchanged.
const FAIR_LEAN = 'lean - negative EV at fair price';
function cardLeg(matchup, extra) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, side: `${parts[1]} -3`, market: 'Spread', line: -3,
    odds: -110, coverProb: 0.56, edgePct: 0.04, rating: 'a', tier: 'floor',
    book: 'draftkings', homeTeam: parts[1], awayTeam: parts[0],
    ...extra,
  };
}
const realLegs = [
  cardLeg('A @ B', { p_fair: 0.53 }),
  cardLeg('C @ D', { p_fair: 0.53 }),
  cardLeg('E @ F', { p_fair: 0.53 }),
];
const realTicket = parlayFromStraights(realLegs)[0];
assert.strictEqual(realTicket.qualifying, true);
assert.strictEqual(realTicket.isLean, false);
assert.strictEqual(realTicket.units, '0.5u');
assert.notStrictEqual(realTicket.label, FAIR_LEAN);
assert.strictEqual(realTicket.type, '3-leg-parlay');
assert.ok(realTicket.evRaw > 0);
const realPublic = publicPicksPayload({ picks: [], parlayLegs: [realTicket] });
assert.strictEqual(realPublic.parlayLegs[0].isLean, false);
assert.strictEqual(realPublic.parlayLegs[0].evAtFair, realTicket.evAtFair);
assert.ok(!String(realPublic.parlayLegs[0].evAtFair).startsWith('-'));

const leanLegs = [
  cardLeg('A @ B', { p_fair: 0.45 }),
  cardLeg('C @ D', { p_fair: 0.45 }),
  cardLeg('E @ F', { p_fair: 0.45 }),
];
const leanTicket = parlayFromStraights(leanLegs)[0];
assert.strictEqual(leanTicket.qualifying, true);
assert.strictEqual(leanTicket.isLean, true);
assert.strictEqual(leanTicket.units, '0.25u');
assert.strictEqual(leanTicket.label, FAIR_LEAN);
assert.strictEqual(leanTicket.leanDay, true);
// 2026-10-18: no 3-leg passes both EV tests, so the lean is the best 2-leg.
assert.strictEqual(leanTicket.type, '2-leg-parlay-labeled');
assert.strictEqual(leanTicket.legs.length, 2);
assert.notStrictEqual(leanTicket.type, 'no-qualifying-parlay');
assert.strictEqual(leanTicket.riskDollars, stakeDollars(0.25));
const held = applyDailyUnitCap(
  [{ pick: 'A-', rating: 'aminus', qualityGrade: 'aminus', tier: 'floor', units: '1.5u', edgePct: '3%' }],
  [leanTicket],
);
assert.strictEqual(held.parlayLegs[0].units, '0.25u');
assert.strictEqual(held.parlayLegs[0].isLean, true);
assert.strictEqual(held.parlayLegs[0].label, FAIR_LEAN);

const noFair = parlayFromStraights([
  cardLeg('A @ B'), cardLeg('C @ D'), cardLeg('E @ F'),
])[0];
assert.strictEqual(noFair.qualifying, true);
assert.strictEqual(noFair.isLean, undefined);
assert.strictEqual(noFair.units, '0.5u');
assert.notStrictEqual(noFair.label, FAIR_LEAN);

const unsupported = parlayFromStraights([cardLeg('A @ B', { p_fair: 0.53 })])[0];
assert.ok(isNoQualifyingParlay(unsupported));
assert.strictEqual(unsupported.qualifying, false);
assert.strictEqual(unsupported.units, null);
assert.strictEqual(unsupported.isLean, undefined);

const twoCard = parlayFromStraights([
  cardLeg('A @ B', { p_fair: 0.40 }),
  cardLeg('C @ D', { p_fair: 0.40 }),
])[0];
assert.strictEqual(twoCard.qualifying, true);
assert.strictEqual(twoCard.legs.length, 2);
// 2026-10-18: a 2-leg also needs EV at fair > 0. Fair 0.40 is a 0.25u lean, not a 0.5u ticket.
assert.strictEqual(twoCard.units, '0.25u');
assert.strictEqual(twoCard.isLean, true);
assert.strictEqual(twoCard.label, FAIR_LEAN);

const fairPositiveModelNegative = parlayFromStraights([
  cardLeg('A @ B', { market: 'Total', side: 'Over 44.5', coverProb: 0.53, edgePct: 0.02, p_fair: 0.56, rating: 'aminus' }),
  cardLeg('C @ D', { market: 'Total', side: 'Over 45.5', coverProb: 0.53, edgePct: 0.02, p_fair: 0.56, rating: 'aminus' }),
  cardLeg('E @ F', { market: 'Total', side: 'Over 46.5', coverProb: 0.53, edgePct: 0.02, p_fair: 0.56, rating: 'aminus' }),
])[0];
// 2026-10-18: fair EV > 0 is not a real ticket when model EV after the haircut is not positive. Fallback is a 2-leg lean.
assert.ok(!(fairPositiveModelNegative.evRaw > 0));
assert.strictEqual(fairPositiveModelNegative.isLean, true);
assert.strictEqual(fairPositiveModelNegative.units, '0.25u');
assert.strictEqual(fairPositiveModelNegative.type, '2-leg-parlay-labeled');
assert.strictEqual(fairPositiveModelNegative.label, 'lean - model EV not positive after haircut');
assert.strictEqual(fairPositiveModelNegative.leanDay, true);
assert.strictEqual(fairPositiveModelNegative.legs.length, 2);

console.log('test-omega-floor-kelly-1018b item5 ok');
