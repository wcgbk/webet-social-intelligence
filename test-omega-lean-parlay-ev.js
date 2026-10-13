'use strict';
// Lean-day parlay publishes only when combined EV is positive.
const assert = require('assert');
const { parlayFromStraights, comboStats } = require('./netlify/functions/lib/omega-vnext/parlay');

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
const dropped = parlayFromStraights(negative);
assert.strictEqual(dropped.length, 1);
assert.strictEqual(dropped[0].status, 'no qualifying parlay');
assert.strictEqual(dropped[0].qualifying, false);
assert.deepStrictEqual(dropped[0].legs, []);
assert.deepStrictEqual(negative, before, 'straights stay on the card when the parlay is dropped');

const positive = trio(150, 0.55, 'lean');
const ticket = parlayFromStraights(positive);
assert.strictEqual(ticket.length, 1);
assert.strictEqual(ticket[0].units, '0.25u');
assert.strictEqual(ticket[0].leanDay, true);
assert.ok(parseFloat(ticket[0].ev) > 0, ticket[0].ev);
assert.strictEqual(positive.length, 3);

const floor = trio(-200, 0.5, 'floor');
const floorBefore = JSON.parse(JSON.stringify(floor));
const floorTicket = parlayFromStraights(floor);
assert.strictEqual(floorTicket.length, 1);
assert.strictEqual(floorTicket[0].status, 'no qualifying parlay');
assert.strictEqual(floorTicket[0].qualifying, false);
assert.ok(!(parseFloat(floorTicket[0].ev) > 0));
assert.deepStrictEqual(floor, floorBefore, 'a failed floor parlay does not drop the straights');

console.log('PASS test-omega-lean-parlay-ev');
