'use strict';
// Flat stake by grade. Kelly does not set the published units.
// A full card (any straight A- or better) parlays 0.5u. A lean-only card parlays 0.25u.
// Risk and to-win are whole dollars, rounded up per stake.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const math = require('./netlify/functions/lib/omega-vnext/odds_math');
const select = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights } = require('./netlify/functions/lib/omega-vnext/parlay');

assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');
assert.strictEqual(config.UNIT_DOLLARS, 150);
assert.ok(config.DAILY_UNIT_CAP >= 5);
assert.strictEqual(config.GRADE_STAKE_UNITS.aplus, 1.5);
assert.strictEqual(config.GRADE_STAKE_UNITS.a, 1);
assert.strictEqual(config.GRADE_STAKE_UNITS.aminus, 0.75);
assert.strictEqual(config.GRADE_STAKE_UNITS.b, 0.5);
assert.strictEqual(config.GRADE_STAKE_UNITS.lean, 0.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.LEAN_PARLAY_UNITS, 0.25);

assert.strictEqual(math.stakeDollars(1.5), 225);
assert.strictEqual(math.stakeDollars(1), 150);
assert.strictEqual(math.stakeDollars(0.75), 113);
assert.strictEqual(math.stakeDollars(0.5), 75);
assert.strictEqual(math.stakeDollars(0.25), 38);
assert.strictEqual(math.toWinDollars(1, -115), 131);
assert.strictEqual(math.toWinDollars(0.75, -135), 84);
assert.strictEqual(math.toWinDollars(0.75, -110), 103);
assert.strictEqual(math.toWinDollars(0.5, 521), 391);

const twoAmin = math.summaryStakeDisplay(
  [{ units: '0.75u' }, { units: '0.75u' }],
  [],
);
assert.strictEqual(twoAmin.totalDollars, 226);

function row(matchup, side, odds, edge, tier) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'MLB',
    matchup,
    side,
    market: 'Total',
    odds,
    coverProb: 0.55,
    ev: 0.05,
    edgePct: edge,
    tier: tier || 'floor',
    homeTeam: parts[1],
    awayTeam: parts[0],
    book: 'hardrockbet',
    commenceTime: '2026-10-15T00:00:00Z',
  };
}

function pickOf(edge, tier, odds) {
  return select.toPickObject(row('Away @ Home', 'Over 7.5', odds, edge, tier), {
    modelVersion: config.MODEL_VERSION,
  });
}

const aPlus = pickOf(0.053, 'floor', -110);
const a = pickOf(0.036, 'floor', -115);
const aMinus = pickOf(0.024, 'floor', -110);
const b = pickOf(0.008, 'floor', -110);
const leanA = pickOf(0.04, 'lean', -110);
assert.strictEqual(aPlus.units, '1.5u');
assert.strictEqual(aPlus.grade, 'A+');
assert.strictEqual(aPlus.riskDollars, 225);
assert.strictEqual(a.units, '1u');
assert.strictEqual(a.grade, 'A');
assert.strictEqual(a.riskDollars, 150);
assert.strictEqual(a.toWinDollars, 131);
assert.strictEqual(aMinus.units, '0.75u');
assert.strictEqual(aMinus.grade, 'A-');
assert.strictEqual(aMinus.riskDollars, 113);
assert.strictEqual(b.units, '0.5u');
assert.strictEqual(b.grade, 'B');
assert.strictEqual(b.riskDollars, 75);
assert.strictEqual(leanA.units, '0.5u');
assert.strictEqual(leanA.tier, 'lean');
assert.strictEqual(a.gameTime, '8:00 PM ET');

const full = [
  row('Milwaukee Brewers @ Los Angeles Dodgers', 'Under 7.5', -115, 0.036),
  row('Dallas Stars @ Colorado Avalanche', 'Over 5.5', -135, 0.033),
  row('Western Kentucky Hilltoppers @ Sam Houston State Bearkats', 'Over 52.5', -110, 0.024),
];
const ticket = parlayFromStraights(full)[0];
assert.strictEqual(ticket.units, '0.5u');
assert.strictEqual(ticket.evLabel, 'assumes independent legs');
assert.strictEqual(ticket.combinedOdds, '+521');
assert.strictEqual(ticket.combinedDecimal, 6.21);
assert.strictEqual(ticket.riskDollars, 75);
assert.strictEqual(ticket.toWinDollars, 391);
assert.ok(!ticket.leanDay);
for (const leg of ticket.legs) {
  assert.ok(leg.pick, 'leg pick');
  assert.ok(leg.odds, 'leg odds');
  assert.ok(leg.matchup, 'leg matchup');
  assert.ok(leg.sport, 'leg sport');
  assert.ok(leg.book, 'leg book');
  assert.ok(leg.edge, 'leg edge');
  assert.ok(leg.grade, 'leg grade');
}

const leanOnly = [
  row('A @ B', 'Over 1', -110, 0.01),
  row('C @ D', 'Over 2', -110, 0.012),
  row('E @ F', 'Over 3', -110, 0.015),
];
const leanTicket = parlayFromStraights(leanOnly)[0];
assert.strictEqual(leanTicket.units, '0.25u');
assert.strictEqual(leanTicket.riskDollars, 38);
assert.strictEqual(math.cardHasFullGrade(leanOnly), false);
assert.strictEqual(math.cardHasFullGrade(full), true);
assert.strictEqual(math.cardHasFullGrade([leanA]), true);

const shown = math.summaryStakeDisplay(
  [
    { units: '1u' },
    { units: '0.75u' },
    { units: '0.75u' },
  ],
  [{ units: '0.5u', qualifying: true, type: '3-leg-parlay' }],
);
assert.strictEqual(shown.totalUnits, '3u');
assert.strictEqual(shown.totalDollars, 451);

console.log('PASS test-omega-grade-stake-1014');
