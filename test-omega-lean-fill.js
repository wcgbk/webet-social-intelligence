'use strict';
// Lean fill and the lean-day parlay. Synthetic rows only. No network.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  selectStraights, toPickObject, applyDailyUnitCap, qualifiesAsLean, shouldPublishNoPlays,
} = require('./netlify/functions/lib/omega-vnext/select');
const { applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');
const { applyPlaceabilityDrops } = require('./netlify/functions/lib/omega-vnext/edge');
const { NO_PLAYS_TITLE } = require('./netlify/functions/lib/no-plays');

const CARD = '2026-10-11';
const KICK = '2026-10-11T20:00:00Z';
const asOf = { cardDate: CARD, asOfMs: Date.parse('2026-10-11T13:30:00Z') };

function row(matchup, side, extra = {}) {
  const parts = String(matchup).split(' @ ');
  return {
    sport: 'NFL',
    matchup,
    side,
    market: 'Spread',
    line: 3,
    odds: -110,
    coverProb: 0.55,
    uncertainty: 0.12,
    liquid: true,
    commenceTime: KICK,
    homeTeam: parts[1] || 'Home',
    awayTeam: parts[0] || 'Away',
    book: 'draftkings',
    ...extra,
  };
}

function names(list) {
  return new Set((list || []).map((item) => item.matchup || item.side));
}

assert.strictEqual(config.MODEL_VERSION, 'v12.3.32-omega-vnext-price-lock');
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);
assert.strictEqual(config.LEAN_MAX_UNITS, 0.5);
assert.strictEqual(config.LEAN_PARLAY_UNITS, 0.25);

const floor = row('A @ B', 'B +3', { ev: 0.06, edgePct: 0.05 });
const highEv = row('C @ D', 'D +3', { ev: 0.012, edgePct: 0.016 });
const dkLadder = row('E @ F', 'F +3', {
  ev: 0.009, edgePct: 0.02, book: 'fanduel',
  bookPrices: [{ book: 'draftkings', price: -110 }],
});
const midEv = row('G @ H', 'H +3', { ev: 0.008, edgePct: 0.04 });
const thinEdge = row('I @ J', 'J +3', { ev: 0.04, edgePct: 0.01 });
const noBook = row('K @ L', 'L +3', { ev: 0.02, edgePct: 0.03, book: 'fanduel' });
const noLadder = row('M @ N', 'N +3', {
  ev: 0.02, edgePct: 0.03, book: 'bovada',
  bookPrices: [{ book: 'bovada', price: -110 }],
});
const flatEv = row('O @ P', 'P +3', { ev: 0, edgePct: 0.04 });
const negEv = row('Q @ R', 'R +3', { ev: -0.01, edgePct: 0.04 });
const live = row('S @ T', 'T +3', { ev: 0.02, edgePct: 0.03, inPlay: true });
const sameGame = row('A @ B', 'A +3', { ev: 0.03, edgePct: 0.03, line: -3 });

assert.strictEqual(qualifiesAsLean(highEv), true);
assert.strictEqual(qualifiesAsLean(dkLadder), true);
assert.strictEqual(qualifiesAsLean(thinEdge), false);
assert.strictEqual(qualifiesAsLean(noBook), false);
assert.strictEqual(qualifiesAsLean(noLadder), false);
assert.strictEqual(qualifiesAsLean(flatEv), false);
assert.strictEqual(qualifiesAsLean(negEv), false);
assert.strictEqual(qualifiesAsLean(live), false);

const gated = applyGates([floor, highEv, thinEdge], asOf);
assert.strictEqual(gated.yesPool.length, 1);
assert.strictEqual(gated.yesPool[0].side, 'B +3');
assert.ok(gated.leanPool.some((c) => c.side === 'D +3' && c.leanReason === 'ev-floor'));
assert.ok(gated.leanPool.some((c) => c.side === 'J +3' && c.leanReason === 'edge-floor'));

const filled = selectStraights([floor], 3, [
  midEv, thinEdge, noBook, noLadder, flatEv, negEv, live, sameGame, dkLadder, highEv,
]);
assert.deepStrictEqual(filled.map((c) => c.side), ['B +3', 'D +3', 'F +3']);
assert.deepStrictEqual(filled.map((c) => c.tier), ['floor', 'lean', 'lean']);
assert.ok(filled.every((c) => c.matchup !== 'A @ B' || c.side === 'B +3'));

const picks = filled.map((c) => toPickObject(c));
for (const pick of picks.filter((p) => p.tier === 'lean')) {
  assert.strictEqual(pick.units, '0.5u', pick.pick);
}
const juicyLean = toPickObject(row('U @ V', 'V +3', {
  tier: 'lean', ev: 0.02, edgePct: 0.04, coverProb: 0.7,
}));
assert.strictEqual(juicyLean.units, '0.5u');

const capped = applyDailyUnitCap([
  {
    pick: 'Lean A', matchup: 'C @ D', rating: 'a', qualityGrade: 'a', tier: 'lean',
    units: '0.25u', edgePct: '3.0%', qualityScore: 0.03,
  },
  {
    pick: 'Floor B', matchup: 'E @ F', rating: 'aminus', qualityGrade: 'aminus', tier: 'floor',
    units: '1u', edgePct: '2.2%', qualityScore: 0.022,
  },
], [{ units: '0.25u', leanDay: true, legs: [] }]);
assert.strictEqual(capped.picks.find((p) => p.tier === 'lean').units, '0.25u');
assert.strictEqual(capped.parlayLegs[0].units, '0.25u');
const arrivedHigh = applyDailyUnitCap([
  {
    pick: 'Lean high', matchup: 'C @ D', rating: 'a', qualityGrade: 'a', tier: 'lean',
    units: '1.25u', edgePct: '3.0%', qualityScore: 0.03,
  },
], null);
assert.strictEqual(arrivedHigh.picks[0].units, '0.5u');

const cardLegs = [
  row('A1 @ H1', 'H1 +3', { tier: 'lean', ev: 0.01, edgePct: 0.02, coverProb: 0.56 }),
  row('A2 @ H2', 'H2 +3', { tier: 'lean', ev: 0.009, edgePct: 0.018, coverProb: 0.55 }),
  row('A3 @ H3', 'H3 +3', { tier: 'lean', ev: 0.008, edgePct: 0.016, coverProb: 0.54 }),
];
const juicer = [
  row('J1 @ K1', 'K1 ML', { market: 'Moneyline', line: null, odds: 200, tier: 'lean', ev: 0.08, edgePct: 0.04, coverProb: 0.55 }),
  row('J2 @ K2', 'K2 ML', { market: 'Moneyline', line: null, odds: 180, tier: 'lean', ev: 0.07, edgePct: 0.035, coverProb: 0.55 }),
  row('J3 @ K3', 'K3 ML', { market: 'Moneyline', line: null, odds: 170, tier: 'lean', ev: 0.06, edgePct: 0.03, coverProb: 0.55 }),
];
const cardTicket = optimizeParlay(cardLegs.concat(juicer), cardLegs, { cardDate: CARD });
assert.strictEqual(cardTicket.length, 1);
assert.strictEqual(cardTicket[0].units, '0.25u');
assert.strictEqual(cardTicket[0].leanDay, true);
assert.ok(parseFloat(cardTicket[0].ev) > 0);
assert.deepStrictEqual(names(cardTicket[0].legs), new Set(['A1 @ H1', 'A2 @ H2', 'A3 @ H3']));
const cardCapped = applyDailyUnitCap([], cardTicket);
assert.strictEqual(cardCapped.parlayLegs[0].units, '0.25u');

const weakCard = [
  row('W1 @ X1', 'X1 +3', { tier: 'lean', ev: 0.01, edgePct: 0.02, coverProb: 0.40 }),
  row('W2 @ X2', 'X2 +3', { tier: 'lean', ev: 0.009, edgePct: 0.018, coverProb: 0.40 }),
  row('W3 @ X3', 'X3 +3', { tier: 'lean', ev: 0.008, edgePct: 0.016, coverProb: 0.40 }),
];
const bestPool = [
  row('B1 @ C1', 'Over 44', { market: 'Total', line: 44, odds: 180, tier: 'lean', ev: 0.02, edgePct: 0.02, coverProb: 0.60 }),
  row('B2 @ C2', 'Over 45', { market: 'Total', line: 45, odds: 180, tier: 'lean', ev: 0.02, edgePct: 0.02, coverProb: 0.58 }),
  row('B3 @ C3', 'Over 46', { market: 'Total', line: 46, odds: 180, tier: 'lean', ev: 0.02, edgePct: 0.02, coverProb: 0.56 }),
];
const edgeDecoy = [
  row('D1 @ E1', 'E1 +3', { tier: 'lean', ev: 0.01, edgePct: 0.08, coverProb: 0.52, odds: 100 }),
  row('D2 @ E2', 'E2 +3', { tier: 'lean', ev: 0.01, edgePct: 0.07, coverProb: 0.52, odds: 100 }),
  row('D3 @ E3', 'E3 +3', { tier: 'lean', ev: 0.01, edgePct: 0.06, coverProb: 0.52, odds: 100 }),
];
const bestTicket = optimizeParlay(weakCard.concat(bestPool, edgeDecoy), weakCard, { cardDate: CARD });
assert.strictEqual(bestTicket.length, 1);
assert.strictEqual(bestTicket[0].units, '0.25u');
assert.strictEqual(bestTicket[0].leanDay, true);
assert.strictEqual(bestTicket[0].legs.length, 3);
assert.deepStrictEqual(names(bestTicket[0].legs), new Set(['B1 @ C1', 'B2 @ C2', 'B3 @ C3']));
assert.ok(parseFloat(bestTicket[0].ev) > 0);

const floors = [
  row('F1 @ G1', 'G1 +3', { tier: 'floor', ev: 0.06, edgePct: 0.05, coverProb: 0.56 }),
  row('F2 @ G2', 'G2 +3', { tier: 'floor', ev: 0.05, edgePct: 0.04, coverProb: 0.55 }),
  row('F3 @ G3', 'G3 +3', { tier: 'floor', ev: 0.045, edgePct: 0.03, coverProb: 0.54 }),
];
const floorTicket = optimizeParlay(floors, floors, { cardDate: CARD });
assert.strictEqual(floorTicket.length, 1);
assert.strictEqual(floorTicket[0].units, '0.5u');
assert.ok(floorTicket[0].leanDay !== true);
assert.strictEqual(applyDailyUnitCap([], floorTicket).parlayLegs[0].units, '0.5u');

assert.strictEqual(shouldPublishNoPlays([], [highEv]), false);
assert.strictEqual(shouldPublishNoPlays([], [thinEdge]), true);
assert.strictEqual(shouldPublishNoPlays([], [negEv]), true);
assert.strictEqual(shouldPublishNoPlays([{ tier: 'lean', pick: 'D +3' }], []), false);

const dropped = {
  picks: [{ pick: 'Gone', matchup: 'A @ B', units: '1u' }],
  parlayLegs: [],
  rejections: [],
  leanPool: [highEv],
};
applyPlaceabilityDrops(dropped, [{ drop: true, reason: 'placeability' }], []);
assert.strictEqual(dropped.picks.length, 0);
assert.ok(!dropped.noPlaysTitle, 'a positive-EV lean is not a no-plays card');
assert.notStrictEqual(dropped.noPlays, NO_PLAYS_TITLE);

const trulyEmpty = {
  picks: [{ pick: 'Gone', matchup: 'A @ B', units: '1u' }],
  parlayLegs: [],
  rejections: [],
};
applyPlaceabilityDrops(trulyEmpty, [{ drop: true, reason: 'placeability' }], []);
assert.strictEqual(trulyEmpty.picks.length, 0);
assert.strictEqual(trulyEmpty.noPlaysTitle, NO_PLAYS_TITLE);

console.log('PASS test-omega-lean-fill');
