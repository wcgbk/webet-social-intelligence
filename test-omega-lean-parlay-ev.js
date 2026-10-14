'use strict';
// A 3-leg parlay publishes at 0.25u even when combined EV is not positive.
// That ticket is labeled. Straights stay on the card. Fewer than three
// priced games is the only no-qualifying marker.
const assert = require('assert');
const { parlayFromStraights, comboStats, isNoQualifyingParlay } = require('./netlify/functions/lib/omega-vnext/parlay');

function leg(matchup, odds, coverProb, tier) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NFL',
    matchup,
    side: parts[1],
    market: 'Moneyline',
    odds,
    coverProb,
    tier,
    homeTeam: parts[1],
    awayTeam: parts[0],
    edgePct: tier === 'lean' ? 0.016 : 0.04,
  };
}

function trio(odds, coverProb, tier) {
  return [
    leg('Jets @ Bills', odds, coverProb, tier),
    leg('Dolphins @ Patriots', odds, coverProb, tier),
    leg('Giants @ Cowboys', odds, coverProb, tier),
  ];
}

const negative = trio(-200, 0.5, 'lean');
const before = JSON.parse(JSON.stringify(negative));
const stats = comboStats(negative.map((row) => ({ ...row, coverProb: 0.5 })));
assert.ok(stats.ev <= 0, 'fixture combined EV is not positive');
const labeled = parlayFromStraights(negative);
assert.strictEqual(labeled.length, 1);
assert.strictEqual(labeled[0].qualifying, true);
assert.strictEqual(labeled[0].units, '0.25u');
assert.strictEqual(labeled[0].leanDay, true);
assert.strictEqual(labeled[0].label, 'combined EV not positive');
assert.strictEqual(labeled[0].legs.length, 3);
assert.ok(!(labeled[0].evRaw > 0));
assert.deepStrictEqual(negative, before, 'straights stay on the card when the parlay is labeled');

const positive = trio(150, 0.55, 'lean');
const ticket = parlayFromStraights(positive);
assert.strictEqual(ticket.length, 1);
assert.strictEqual(ticket[0].units, '0.25u');
assert.ok(!ticket[0].leanDay);
assert.ok(parseFloat(ticket[0].ev) > 0, ticket[0].ev);
assert.strictEqual(positive.length, 3);

const floor = trio(-200, 0.5, 'floor');
const floorBefore = JSON.parse(JSON.stringify(floor));
const floorTicket = parlayFromStraights(floor);
assert.strictEqual(floorTicket.length, 1);
assert.strictEqual(floorTicket[0].qualifying, true);
assert.strictEqual(floorTicket[0].units, '0.5u');
assert.strictEqual(floorTicket[0].label, 'combined EV not positive');
assert.ok(!(floorTicket[0].evRaw > 0));
assert.deepStrictEqual(floor, floorBefore, 'a labeled floor parlay does not drop the straights');

const short = parlayFromStraights(floor.slice(0, 2));
assert.ok(isNoQualifyingParlay(short[0]));
assert.strictEqual(short[0].qualifying, false);

console.log('PASS test-omega-lean-parlay-ev');
