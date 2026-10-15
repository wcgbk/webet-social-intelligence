'use strict';
// A leg with negative stake EV does not make a parlay. A positive-EV
// lean card still publishes at 0.25u. Fewer than three qualifying games
// is no parlay. Straights stay on the card.
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
assert.ok(isNoQualifyingParlay(labeled[0]));
assert.strictEqual(labeled[0].qualifying, false);
assert.deepStrictEqual(labeled[0].legs, []);
assert.deepStrictEqual(negative, before, 'straights stay when the parlay does not qualify');

const positive = trio(-110, 0.55, 'lean');
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
assert.ok(isNoQualifyingParlay(floorTicket[0]));
assert.strictEqual(floorTicket[0].qualifying, false);
assert.deepStrictEqual(floor, floorBefore, 'a non-qualifying parlay does not drop the straights');

const short = parlayFromStraights(floor.slice(0, 2));
assert.ok(isNoQualifyingParlay(short[0]));
assert.strictEqual(short[0].qualifying, false);

console.log('PASS test-omega-lean-parlay-ev');
