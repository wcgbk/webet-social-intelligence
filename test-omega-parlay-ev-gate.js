'use strict';
// Every parlay, floor day or lean day, must be +EV on the unified adjusted
// cover. A miss is rebuilt from the next-best +EV legs. No miss publishes
// a negative ticket. Straights stay on the card.
const assert = require('assert');
const {
  parlayFromStraights, isNoQualifyingParlay, unifiedCoverProb, priceParlayLeg,
} = require('./netlify/functions/lib/omega-vnext/parlay');
const {
  passesPublishFloor, qualifiesAsLean, selectStraights, applyDailyUnitCap,
} = require('./netlify/functions/lib/omega-vnext/select');

function leg(matchup, extra) {
  const parts = matchup.split(' @ ');
  return {
    sport: extra.sport || 'NHL',
    matchup,
    side: extra.side || parts[1],
    market: extra.market || 'Moneyline',
    odds: extra.odds == null ? -110 : extra.odds,
    coverProb: extra.coverProb,
    p_cal: extra.p_cal,
    edgePct: extra.edgePct,
    ev: extra.ev,
    tier: extra.tier || 'floor',
    homeTeam: parts[1],
    awayTeam: parts[0],
    line: extra.line != null ? extra.line : null,
    bookPrices: extra.bookPrices,
    hardRock: extra.hardRock,
    book: extra.book || 'draftkings',
  };
}

function names(ticket) {
  return (ticket.legs || []).map((row) => row.pick).sort();
}

function assertNoTicket(rows, pool) {
  const before = JSON.stringify(rows);
  const out = parlayFromStraights(rows, { pool });
  assert.strictEqual(out.length, 1);
  assert.ok(isNoQualifyingParlay(out[0]));
  assert.strictEqual(out[0].status, 'no qualifying parlay');
  assert.strictEqual(out[0].qualifying, false);
  assert.deepStrictEqual(out[0].legs, []);
  assert.ok(out[0].units == null);
  assert.strictEqual(JSON.stringify(rows), before);
  return out[0];
}

// Floor day, negative combined EV: no ticket, straights untouched.
const floorNeg = [
  leg('Jets @ Bills', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
  leg('Giants @ Cowboys', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
];
assertNoTicket(floorNeg);

// Floor day, positive combined EV: 0.5u ticket.
const floorPos = [
  leg('Jets @ Bills', { odds: 120, coverProb: 0.55, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: 120, coverProb: 0.55, edgePct: 0.04 }),
  leg('Giants @ Cowboys', { odds: 120, coverProb: 0.55, edgePct: 0.04 }),
];
const floorTicket = parlayFromStraights(floorPos);
assert.strictEqual(floorTicket.length, 1);
assert.strictEqual(floorTicket[0].qualifying, true);
assert.strictEqual(floorTicket[0].units, '0.5u');
assert.ok(!floorTicket[0].leanDay);
assert.ok(floorTicket[0].evRaw > 0, floorTicket[0].ev);
assert.strictEqual(floorTicket[0].autoCorrected, false);
assert.strictEqual(floorTicket[0].probBasis, 'unified-adjusted-cover');

// Display cover "50%" must not beat p_cal 0.58. 50% at -110 is -EV.
// 0.58 at -110 is +EV, and three of those clear the ticket.
const rounded = [
  leg('Jets @ Bills', { odds: -110, coverProb: '50%', p_cal: 0.58, edgePct: '4.0%' }),
  leg('Dolphins @ Patriots', { odds: -110, coverProb: '50%', p_cal: 0.58, edgePct: '4.0%' }),
  leg('Giants @ Cowboys', { odds: -110, coverProb: '50%', p_cal: 0.58, edgePct: '4.0%' }),
];
assert.strictEqual(unifiedCoverProb(rounded[0]), 0.58);
const fromCal = parlayFromStraights(rounded);
assert.strictEqual(fromCal[0].qualifying, true, fromCal[0].status);
assert.ok(fromCal[0].evRaw > 0);
assert.strictEqual(fromCal[0].legs[0].p_cal, 0.58);
assert.ok(parseFloat(fromCal[0].legs[0].ev) > 0);

// Same-direction totals can each be +EV and still miss after the 0.92 haircut.
const overs = [
  leg('Jets @ Bills', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
  leg('Dolphins @ Patriots', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
  leg('Giants @ Cowboys', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
];
assert.ok(priceParlayLeg(overs[0]).ev > 0);
assertNoTicket(overs);
const replacement = leg('Kings @ Oilers', {
  market: 'Moneyline', side: 'Oilers', odds: 100, coverProb: 0.6, edgePct: 0.05,
});
const corrected = parlayFromStraights(overs, { pool: [replacement] });
assert.strictEqual(corrected[0].qualifying, true);
assert.strictEqual(corrected[0].autoCorrected, true);
assert.strictEqual(corrected[0].units, '0.5u');
assert.ok(corrected[0].evRaw > 0);
assert.ok(names(corrected[0]).includes('Oilers ML'));
assert.strictEqual(corrected[0].legs.length, 3);
assert.strictEqual(new Set(corrected[0].legs.map((row) => row.matchup)).size, 3);

// Hard Rock: a higher-edge leg with no Hard Rock offer is skipped.
// The next leg that Hard Rock posts is the swap.
const hrCard = [
  leg('Jets @ Bills', { odds: 120, coverProb: 0.55, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: 120, coverProb: 0.55, edgePct: 0.04 }),
  leg('Giants @ Cowboys', {
    odds: 120, coverProb: 0.55, edgePct: 0.04,
    bookPrices: [{ book: 'draftkings', american: 120 }],
  }),
];
const noHr = leg('Rangers @ Lightning', {
  odds: 150, coverProb: 0.6, edgePct: 0.08,
  bookPrices: [{ book: 'draftkings', american: 150 }],
});
const withHr = leg('Kings @ Oilers', {
  odds: 110, coverProb: 0.58, edgePct: 0.03,
  hardRock: { american: 110, point: null },
  bookPrices: [
    { book: 'draftkings', american: 110 },
    { book: 'hardrockbet', american: 110 },
  ],
});
assert.strictEqual(priceParlayLeg(noHr), null);
assert.ok(priceParlayLeg(withHr));
const hrTicket = parlayFromStraights(hrCard, { pool: [noHr, withHr] });
assert.strictEqual(hrTicket[0].qualifying, true);
assert.strictEqual(hrTicket[0].autoCorrected, true);
assert.ok(names(hrTicket[0]).includes('Oilers ML'));
assert.ok(!names(hrTicket[0]).some((name) => /Lightning|Rangers/.test(name)));
assert.ok(!names(hrTicket[0]).some((name) => /Cowboys|Giants/.test(name)));

// Hard Rock price replaces the displayed price when the ticket stays +EV.
const repricedLegs = [
  leg('Jets @ Bills', {
    odds: -110, coverProb: 0.62, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
  leg('Dolphins @ Patriots', {
    odds: -110, coverProb: 0.62, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
  leg('Giants @ Cowboys', {
    odds: -110, coverProb: 0.62, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
];
const repriced = parlayFromStraights(repricedLegs);
assert.strictEqual(repriced[0].qualifying, true);
assert.strictEqual(repriced[0].autoCorrected, true);
assert.ok(repriced[0].legs.every((row) => row.odds === '-130'));
assert.ok(repriced[0].evRaw > 0);

// A Hard Rock price that loses the EV is not the ticket, and nothing else qualifies.
const deadHr = repricedLegs.map((row) => ({
  ...row,
  hardRock: { american: -250 },
  bookPrices: [{ book: 'hardrockbet', american: -250 }, { book: 'draftkings', american: -110 }],
}));
assertNoTicket(deadHr);

// The marker is not resized to 0.5u.
const capped = applyDailyUnitCap(
  [{ pick: 'Bills', units: '1u', rating: 'aminus', tier: 'floor', matchup: 'Jets @ Bills' }],
  parlayFromStraights(floorNeg),
);
assert.ok(isNoQualifyingParlay(capped.parlayLegs[0]));
assert.ok(capped.parlayLegs[0].units == null);

// Straights already use stake EV from the same adjusted cover.
// Main: 3% edge and stake EV at the 3% floor. Lean: edge >= 1.5% and EV > 0.
const mainOk = { sport: 'NHL', odds: -110, ev: 0.04, edgePct: 0.04, uncertainty: 0.1, coverProb: 0.56 };
const mainEvZero = { ...mainOk, ev: 0 };
const mainEdgeThin = { ...mainOk, edgePct: 0.02, ev: 0.04 };
assert.strictEqual(passesPublishFloor(mainOk), true);
assert.strictEqual(passesPublishFloor(mainEvZero), false);
assert.strictEqual(passesPublishFloor(mainEdgeThin), false);
const leanOk = {
  sport: 'NHL', odds: -110, ev: 0.004, edgePct: 0.016, book: 'draftkings', coverProb: 0.54,
};
const leanEvZero = { ...leanOk, ev: 0 };
const leanEdgeThin = { ...leanOk, edgePct: 0.014 };
assert.strictEqual(qualifiesAsLean(leanOk), true);
assert.strictEqual(qualifiesAsLean(leanEvZero), false);
assert.strictEqual(qualifiesAsLean(leanEdgeThin), false);
const picked = selectStraights([mainOk], 3, [leanEvZero, leanEdgeThin]);
assert.strictEqual(picked.length, 1);
assert.strictEqual(picked[0].tier, 'floor');
const withLean = selectStraights([], 3, [leanOk, leanEvZero]);
assert.strictEqual(withLean.length, 1);
assert.strictEqual(withLean[0].tier, 'lean');

console.log('PASS test-omega-parlay-ev-gate');
