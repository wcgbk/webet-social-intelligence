'use strict';

/**
 * QA caps a grade-B straight above 0.5u at 0.5u ($75) and notes it.
 * An A- stake stays. Parlay legs and the ticket stake are not this cap.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const PREGAME = Date.parse('2026-10-30T16:00:00Z');
const COMMENCE = '2026-10-30T23:00:00Z';

function stakeOf(units) {
  return Math.ceil(units * 150 - 1e-9);
}

(async () => {
  const aminus = {
    sport: 'NHL',
    matchup: 'Edmonton Oilers @ New Jersey Devils',
    pick: 'Edmonton Oilers',
    market: 'Moneyline',
    odds: '-120',
    units: '1.25u',
    unitsNum: 1.25,
    stakeUsd: stakeOf(1.25),
    stakeDollars: stakeOf(1.25),
    rating: 'aminus',
    grade: 'aminus',
    qualityGrade: 'aminus',
    evRaw: 0.04,
    commenceTime: COMMENCE,
    modelVersion: v2.MODEL_VERSION,
  };
  const flames = {
    sport: 'NHL',
    matchup: 'Calgary Flames @ Colorado Avalanche',
    pick: 'Calgary Flames +2.5',
    market: 'Spread',
    odds: '+150',
    units: '0.75u',
    unitsNum: 0.75,
    stakeUsd: stakeOf(0.75),
    stakeDollars: stakeOf(0.75),
    rating: 'b',
    grade: 'b',
    qualityGrade: 'b',
    evRaw: 0.03,
    commenceTime: COMMENCE,
    modelVersion: v2.MODEL_VERSION,
  };
  const parlay = {
    type: '2-leg',
    units: '0.75u',
    unitsNum: 0.75,
    stakeUsd: stakeOf(0.75),
    modelVersion: v2.MODEL_VERSION,
    combinedOdds: '+264',
    legs: [
      {
        pick: 'Calgary Flames +2.5',
        matchup: 'Calgary Flames @ Colorado Avalanche',
        market: 'Spread',
        odds: '+150',
        units: '0.75u',
        unitsNum: 0.75,
        stakeUsd: stakeOf(0.75),
        stakeDollars: stakeOf(0.75),
        rating: 'b',
        grade: 'b',
        qualityGrade: 'b',
        edgeNovig: 0.02,
        commenceTime: COMMENCE,
        modelVersion: v2.MODEL_VERSION,
      },
      {
        pick: 'Edmonton Oilers',
        matchup: 'Edmonton Oilers @ New Jersey Devils',
        market: 'Moneyline',
        odds: '-120',
        units: '1.25u',
        unitsNum: 1.25,
        stakeUsd: stakeOf(1.25),
        stakeDollars: stakeOf(1.25),
        rating: 'aminus',
        grade: 'aminus',
        qualityGrade: 'aminus',
        edgeNovig: 0.03,
        commenceTime: COMMENCE,
        modelVersion: v2.MODEL_VERSION,
      },
    ],
  };
  const beforeParlay = JSON.parse(JSON.stringify(parlay));
  const beforeA = JSON.parse(JSON.stringify(aminus));
  const out = v2.autoCorrectCard({
    modelVersion: v2.MODEL_VERSION,
    leakageChecked: true,
    picks: [flames, aminus],
    parlayLegs: [parlay],
  }, { pregameAsOfMs: PREGAME });

  const b = out.picks.find((p) => p.pick === 'Calgary Flames +2.5');
  const a = out.picks.find((p) => p.pick === 'Edmonton Oilers');
  assert.ok(b && a, 'both straights stay on the card');
  assert.strictEqual(b.units, '0.5u');
  assert.strictEqual(b.unitsNum, 0.5);
  assert.strictEqual(b.stakeUsd, 75);
  assert.strictEqual(b.stakeDollars, 75);
  assert.strictEqual(b.rating, 'b');
  assert.strictEqual(b.grade, 'b');
  assert.strictEqual(b.qualityGrade, 'b');
  assert.strictEqual(b.odds, '+150');
  assert.strictEqual(b.pick, 'Calgary Flames +2.5');
  assert.ok(out.qaNotes.includes('b-grade cap Calgary Flames +2.5'));

  assert.strictEqual(a.units, '1.25u');
  assert.strictEqual(a.unitsNum, 1.25);
  assert.deepStrictEqual(a, beforeA);
  assert.deepStrictEqual(out.parlayLegs, [beforeParlay]);
  assert.ok(!out.qaNotes.some((note) => /b-grade cap/.test(note) && !/Calgary/.test(note)));

  console.log('PASS test-omega-v2-bcap');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
