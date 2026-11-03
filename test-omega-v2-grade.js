'use strict';

/**
 * The letter is the printed no-vig tenth (pCal - pMkt), not the price edge.
 * Exact 5.0 / 3.5 / 2.0 take the higher grade. A true B above 0.5u still
 * caps; an A- at 0.75u does not.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const PREGAME = Date.parse('2026-10-30T16:00:00Z');
const COMMENCE = '2026-10-30T23:00:00Z';

function sample(edgeNovig, extra) {
  return v2.toPick({
    sport: 'NHL',
    matchup: 'Away @ Home',
    pick: 'Home',
    market: 'Moneyline',
    odds: -110,
    units: 0.5,
    edgeNovig,
    edge: 0.012,
    ev: 0.02,
    calibration: { pCal: 0.5 + edgeNovig, pMkt: 0.5, method: 'test' },
    commenceTime: COMMENCE,
    ...extra,
  });
}

const cases = [
  [0.0500, '5.0%', 'aplus'],
  [0.04949, '4.9%', 'a'],
  [0.0350, '3.5%', 'a'],
  [0.03449, '3.4%', 'aminus'],
  [0.0200, '2.0%', 'aminus'],
  [0.01949, '1.9%', 'b'],
  [0.01961, '2.0%', 'aminus'],
];

for (const [edgeNovig, edgePct, letter] of cases) {
  const pick = sample(edgeNovig);
  assert.strictEqual(pick.edgePct, edgePct, `edgePct for ${edgeNovig}`);
  assert.strictEqual(pick.rating, letter, `rating for ${edgeNovig}`);
  assert.strictEqual(pick.grade, letter, `grade for ${edgeNovig}`);
  assert.strictEqual(pick.qualityGrade, letter, `qualityGrade for ${edgeNovig}`);
  assert.strictEqual(pick.priceEdgePct, '1.2%', 'price edge stays on priceEdgePct');
  assert.strictEqual(pick.edgeNovig, edgeNovig);
}

function straight(name, matchup, edgeNovig) {
  const stake = Math.ceil(0.75 * 150 - 1e-9);
  const pick = sample(edgeNovig, {
    pick: name,
    matchup,
    units: 0.75,
    stakeUsd: stake,
  });
  // toPick does not carry stakeDollars. The cap writes it when the field is already there.
  pick.stakeDollars = stake;
  return pick;
}

const aminus = straight('Aminus Club', 'Aminus Club @ Rival', 0.02);
const bee = straight('True B', 'True B @ Rival', 0.01949);
assert.strictEqual(aminus.rating, 'aminus');
assert.strictEqual(aminus.grade, 'aminus');
assert.strictEqual(aminus.qualityGrade, 'aminus');
assert.strictEqual(aminus.units, '0.75u');
assert.strictEqual(bee.rating, 'b');
assert.strictEqual(bee.grade, 'b');
assert.strictEqual(bee.qualityGrade, 'b');
assert.strictEqual(bee.units, '0.75u');
assert.strictEqual(bee.priceEdgePct, '1.2%');

const out = v2.autoCorrectCard({
  modelVersion: v2.MODEL_VERSION,
  leakageChecked: true,
  picks: [bee, aminus],
  parlayLegs: [],
}, { pregameAsOfMs: PREGAME });

const a = out.picks.find((p) => p.pick === 'Aminus Club');
const b = out.picks.find((p) => p.pick === 'True B');
assert.ok(a && b, 'both straights stay on the card');
assert.strictEqual(a.units, '0.75u');
assert.strictEqual(a.unitsNum, 0.75);
assert.strictEqual(a.stakeUsd, 113);
assert.strictEqual(a.stakeDollars, 113);
assert.strictEqual(a.rating, 'aminus');
assert.strictEqual(a.grade, 'aminus');
assert.strictEqual(a.qualityGrade, 'aminus');
assert.strictEqual(a.odds, '-110');
assert.deepStrictEqual(a, aminus);
assert.ok(!out.qaNotes.some((note) => /b-grade cap/.test(note) && /Aminus/.test(note)));

assert.strictEqual(b.units, '0.5u');
assert.strictEqual(b.unitsNum, 0.5);
assert.strictEqual(b.stakeUsd, 75);
assert.strictEqual(b.stakeDollars, 75);
assert.strictEqual(b.rating, 'b');
assert.strictEqual(b.grade, 'b');
assert.strictEqual(b.qualityGrade, 'b');
assert.strictEqual(b.odds, '-110');
assert.ok(out.qaNotes.includes('b-grade cap True B'));

console.log('PASS test-omega-v2-grade');
