'use strict';
// A parlay leg needs cover >= 45% and positive stake EV at or under 12%.
// Three qualifying games publish. Combined EV that is not positive is labeled.
// Hard Rock and the edge floor are not required on this path. priceParlayLeg
// still prices the older optimizer and still requires a positive EV.
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

// A leg with negative stake EV is not a parlay leg. Straights stay.
const floorNeg = [
  leg('Jets @ Bills', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
  leg('Giants @ Cowboys', { odds: -200, coverProb: 0.5, edgePct: 0.04 }),
];
assertNoTicket(floorNeg);

// Two negative-EV games still cannot make a ticket.
assertNoTicket(floorNeg.slice(0, 2));

// Two published straights are a 2-team parlay, including a cover under 45%.
const twoTeam = parlayFromStraights([
  leg('Penguins @ Avalanche', { odds: -142, coverProb: 0.634, edgePct: 0.047, rating: 'a' }),
  leg('Memphis @ Tulane', { odds: 220, coverProb: 0.328, edgePct: 0.016, rating: 'b' }),
]);
assert.strictEqual(twoTeam[0].type, '2-leg-parlay');
assert.strictEqual(twoTeam[0].qualifying, true);
assert.strictEqual(twoTeam[0].units, '0.5u');
assert.strictEqual(twoTeam[0].legs.length, 2);
assert.ok(twoTeam[0].evRaw > 0, twoTeam[0].ev);
assert.ok(twoTeam[0].legs.some((row) => Number(row.coverProb) < 0.45 || /32\.8%/.test(String(row.coverProb))));
const third = leg('Ducks @ Bruins', { odds: -110, coverProb: 0.58, edgePct: 0.06 });
const ignoredPool = parlayFromStraights([
  leg('Penguins @ Avalanche', { odds: -142, coverProb: 0.634, edgePct: 0.047, rating: 'a' }),
  leg('Memphis @ Tulane', { odds: 220, coverProb: 0.328, edgePct: 0.016, rating: 'b' }),
], { pool: [third] });
assert.strictEqual(ignoredPool[0].type, '2-leg-parlay');
assert.strictEqual(ignoredPool[0].legs.length, 2);
assert.ok(!names(ignoredPool[0]).some((name) => /Ducks|Bruins/.test(name)));
assertNoTicket(floorNeg.slice(0, 2), [third]);

// Positive combined EV: 0.25u, not a lean-day label.
const floorPos = [
  leg('Jets @ Bills', { odds: 120, coverProb: 0.50, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: 120, coverProb: 0.50, edgePct: 0.04 }),
  leg('Giants @ Cowboys', { odds: 120, coverProb: 0.50, edgePct: 0.04 }),
];
const floorTicket = parlayFromStraights(floorPos);
assert.strictEqual(floorTicket.length, 1);
assert.strictEqual(floorTicket[0].qualifying, true);
assert.strictEqual(floorTicket[0].units, '0.5u');
assert.ok(!floorTicket[0].leanDay);
assert.ok(floorTicket[0].label == null);
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
assert.strictEqual(fromCal[0].units, '0.5u');
assert.ok(fromCal[0].evRaw > 0);
assert.strictEqual(fromCal[0].legs[0].p_cal, 0.58);
assert.ok(parseFloat(fromCal[0].legs[0].ev) > 0);

// Same-direction totals can each be +EV and still miss after the 0.92 haircut.
// The ticket still publishes and is labeled. A better leg from another game
// replaces the weakest total.
const overs = [
  leg('Jets @ Bills', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
  leg('Dolphins @ Patriots', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
  leg('Giants @ Cowboys', { market: 'Total', side: 'Over 6.5', odds: -110, coverProb: 0.53, edgePct: 0.02, line: 6.5 }),
];
assert.ok(priceParlayLeg(overs[0]).ev > 0);
const haircut = parlayFromStraights(overs);
assert.strictEqual(haircut[0].qualifying, true);
assert.strictEqual(haircut[0].units, '0.5u');
assert.strictEqual(haircut[0].label, 'combined EV not positive');
assert.ok(!(haircut[0].evRaw > 0));
const replacement = leg('Kings @ Oilers', {
  market: 'Moneyline', side: 'Oilers', odds: -110, coverProb: 0.56, edgePct: 0.05,
});
const corrected = parlayFromStraights(overs, { pool: [replacement] });
assert.strictEqual(corrected[0].qualifying, true);
assert.strictEqual(corrected[0].autoCorrected, true);
assert.strictEqual(corrected[0].units, '0.5u');
assert.ok(!corrected[0].leanDay);
assert.ok(corrected[0].evRaw > 0);
assert.ok(names(corrected[0]).includes('Oilers ML'));
assert.strictEqual(corrected[0].legs.length, 3);
assert.strictEqual(new Set(corrected[0].legs.map((row) => row.matchup)).size, 3);

// Edge rank. The 8% dog leads. The 3% Oilers price does not outrank a 4% card leg.
const hrCard = [
  leg('Jets @ Bills', { odds: -110, coverProb: 0.55, edgePct: 0.04 }),
  leg('Dolphins @ Patriots', { odds: -110, coverProb: 0.55, edgePct: 0.04 }),
  leg('Giants @ Cowboys', {
    odds: -110, coverProb: 0.55, edgePct: 0.04,
    bookPrices: [{ book: 'draftkings', american: -110 }],
  }),
];
const noHr = leg('Rangers @ Lightning', {
  odds: -110, coverProb: 0.56, edgePct: 0.08,
  bookPrices: [{ book: 'draftkings', american: -110 }],
});
const withHr = leg('Kings @ Oilers', {
  odds: -110, coverProb: 0.54, edgePct: 0.03,
  hardRock: { american: -110, point: null },
  bookPrices: [
    { book: 'draftkings', american: -110 },
    { book: 'hardrockbet', american: -110 },
  ],
});
assert.strictEqual(priceParlayLeg(noHr), null);
assert.ok(priceParlayLeg(withHr));
const hrTicket = parlayFromStraights(hrCard, { pool: [noHr, withHr] });
assert.strictEqual(hrTicket[0].qualifying, true);
assert.strictEqual(hrTicket[0].units, '0.5u');
assert.strictEqual(hrTicket[0].autoCorrected, true);
assert.ok(!names(hrTicket[0]).includes('Oilers ML'));
assert.ok(names(hrTicket[0]).some((name) => /Lightning|Rangers/.test(name)));
assert.ok(names(hrTicket[0]).some((name) => /Cowboys|Giants|Bills|Dolphins|Patriots|Jets/.test(name)));

// The card prices the displayed odds. Hard Rock does not replace them here.
const repricedLegs = [
  leg('Jets @ Bills', {
    odds: -110, coverProb: 0.56, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
  leg('Dolphins @ Patriots', {
    odds: -110, coverProb: 0.56, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
  leg('Giants @ Cowboys', {
    odds: -110, coverProb: 0.56, edgePct: 0.04,
    hardRock: { american: -130 },
    bookPrices: [{ book: 'hardrockbet', american: -130 }, { book: 'draftkings', american: -110 }],
  }),
];
const repriced = parlayFromStraights(repricedLegs);
assert.strictEqual(repriced[0].qualifying, true);
assert.strictEqual(repriced[0].autoCorrected, false);
assert.strictEqual(repriced[0].units, '0.5u');
assert.ok(repriced[0].legs.every((row) => row.odds === '-110'));
assert.ok(repriced[0].evRaw > 0);

// A Hard Rock price that loses the EV is not a priceParlayLeg quote.
// The card still uses the displayed -110 and publishes.
const deadHr = repricedLegs.map((row) => ({
  ...row,
  hardRock: { american: -250 },
  bookPrices: [{ book: 'hardrockbet', american: -250 }, { book: 'draftkings', american: -110 }],
}));
assert.strictEqual(priceParlayLeg(deadHr[0]), null);
const deadTicket = parlayFromStraights(deadHr);
assert.strictEqual(deadTicket[0].qualifying, true);
assert.strictEqual(deadTicket[0].units, '0.5u');
assert.ok(deadTicket[0].legs.every((row) => row.odds === '-110'));
assert.ok(deadTicket[0].evRaw > 0);

// The unit cap keeps a full-card labeled ticket at 0.5u.
const capped = applyDailyUnitCap(
  [{ pick: 'Bills', units: '1u', rating: 'aminus', tier: 'floor', matchup: 'Jets @ Bills' }],
  parlayFromStraights(overs),
);
assert.strictEqual(capped.parlayLegs[0].qualifying, true);
assert.strictEqual(capped.parlayLegs[0].units, '0.5u');
assert.strictEqual(capped.parlayLegs[0].label, 'combined EV not positive');
assert.ok(!isNoQualifyingParlay(capped.parlayLegs[0]));

// Edge is not an inclusion test. A short card fills positive EV only.
const mainOk = { sport: 'NHL', odds: -110, ev: 0.04, edgePct: 0.04, uncertainty: 0.1, coverProb: 0.56, matchup: 'A @ B', side: 'B', book: 'draftkings' };
const mainEvZero = { ...mainOk, ev: 0, matchup: 'C @ D', side: 'D' };
const mainEdgeThin = { ...mainOk, edgePct: 0.02, ev: 0.04, matchup: 'E @ F', side: 'F' };
assert.strictEqual(passesPublishFloor(mainOk), true);
assert.strictEqual(passesPublishFloor(mainEvZero), false);
assert.strictEqual(passesPublishFloor(mainEdgeThin), true);
const leanOk = {
  sport: 'NHL', odds: -110, ev: 0.004, edgePct: 0.016, book: 'draftkings', coverProb: 0.54,
  matchup: 'G @ H', side: 'H',
};
const leanEvZero = { ...leanOk, ev: 0, matchup: 'I @ J', side: 'J' };
const leanEdgeThin = { ...leanOk, edgePct: 0.014, matchup: 'K @ L', side: 'L' };
assert.strictEqual(qualifiesAsLean(leanOk), true);
assert.strictEqual(qualifiesAsLean(leanEvZero), false);
assert.strictEqual(qualifiesAsLean(leanEdgeThin), true);
const leanPrintsZero = { ...leanOk, edgePct: 0.0002, ev: 0.0004, matchup: 'M @ N', side: 'N' };
assert.strictEqual(qualifiesAsLean(leanPrintsZero), false);
const picked = selectStraights([mainOk], 3, [leanEvZero, leanEdgeThin]);
assert.strictEqual(picked.length, 2);
assert.deepStrictEqual(picked.map((row) => row.tier), ['floor', 'lean']);
assert.deepStrictEqual(picked.map((row) => row.side), ['B', 'L']);
const withLean = selectStraights([], 3, [leanOk, leanEvZero]);
assert.strictEqual(withLean.length, 1);
assert.ok(withLean.every((row) => row.tier === 'lean'));

console.log('PASS test-omega-parlay-ev-gate');
