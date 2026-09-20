#!/usr/bin/env node
// Omega fill-to-3 + honest 2-vs-3 parlay optimizer. Alpha restored to v10.3 control (not tested here).
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const omega = require('./netlify/functions/generate-picks-omega-background');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

function tot(side, matchup, cover, odds, extra) {
  return {
    sport: 'MLB', market: 'Total', side, odds, coverProb: cover, ev: 0.04,
    matchup, awayTeam: matchup.split(' @ ')[0], homeTeam: matchup.split(' @ ')[1],
    ...extra,
  };
}
function totLeg(side, matchup, cover, odds) {
  return {
    side, market: 'Total', oddsNum: odds, coverProbNum: cover, evNum: 0.04,
    matchup, sport: 'MLB', commenceTime: '2026-09-09T23:00:00Z',
  };
}

const gameA = 'Cubs @ Mets';
const gameB = 'Padres @ Giants';
const gameC = 'Yankees @ Red Sox';
const gameD = 'Dodgers @ Phillies';

console.log('\nfill-to-3 + parlay 2-vs-3');

check('versions', () => {
  const aSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(aSrc.includes('v10.3.4-alpha-no-rockies'));
  assert.strictEqual(omega.MODEL_VERSION, 'v11.9.3-omega-no-nba-nhl');
});

check('chooseParlay2or3: 3-leg when adjusted EV is clearly better', () => {
  const a = totLeg('Under 8.5', gameA, 0.56, -110);
  const b = totLeg('Under 7.5', gameB, 0.56, -110);
  const c = totLeg('Over 9.5', gameC, 0.56, -110);
  for (const mod of [omega]) {
    const chosen = mod.chooseParlay2or3([a, b], [a, b, c]);
    assert.strictEqual(chosen.length, 3, mod.MODEL_VERSION + ' should pick 3-leg');
  }
});

check('chooseParlay2or3: 2-leg when its adjusted EV is higher', () => {
  // Heavy-favorite 3rd leg with thin edge tanks combo EV vs two strong totals.
  const a = totLeg('Under 8.5', gameA, 0.62, -150);
  const b = totLeg('Under 7.5', gameB, 0.60, -140);
  const c = totLeg('Over 9.5', gameC, 0.53, -200);
  for (const mod of [omega]) {
    const s2 = mod._testV104.parlayComboStats([a, b]);
    const s3 = mod._testV104.parlayComboStats([a, b, c]);
    assert.ok(s2.adjustedEV > s3.adjustedEV, 'precondition: 2-leg EV should exceed 3-leg');
    const chosen = mod.chooseParlay2or3([a, b], [a, b, c]);
    assert.strictEqual(chosen.length, 2, mod.MODEL_VERSION + ' should pick 2-leg on EV');
  }
});

check('chooseParlay2or3: 2-leg when EV is close and hit-rate is meaningfully higher', () => {
  const a = totLeg('Under 8.5', gameA, 0.58, -110);
  const b = totLeg('Under 7.5', gameB, 0.57, -110);
  const c = totLeg('Over 9.5', gameC, 0.52, -105);
  for (const mod of [omega]) {
    const s2 = mod._testV104.parlayComboStats([a, b]);
    const s3 = mod._testV104.parlayComboStats([a, b, c]);
    assert.ok(s3.adjustedEV >= s2.adjustedEV, 'precondition: 3-leg EV not worse');
    assert.ok((s3.adjustedEV - s2.adjustedEV) <= mod.PARLAY_EV_TIE_BAND, 'precondition: EV close');
    assert.ok(s2.combinedProb >= s3.combinedProb + mod.PARLAY_HIT_RATE_EDGE, 'precondition: hit-rate edge');
    const chosen = mod.chooseParlay2or3([a, b], [a, b, c]);
    assert.strictEqual(chosen.length, 2, mod.MODEL_VERSION + ' should pick 2-leg on hit-rate');
  }
});

check('Omega selectParlayLegs picks 2 when 2-leg EV/hit-rate wins', () => {
  const cands = [
    totLeg('Under 8.5', gameA, 0.58, -110),
    totLeg('Under 7.5', gameB, 0.57, -110),
    totLeg('Over 9.5', gameC, 0.52, -105),
  ];
  const legs = omega.selectParlayLegs(cands, 3);
  assert.strictEqual(legs.length, 2);
  assert.ok(!legs.some(l => l.side === 'Over 9.5'));
});

check('Omega selectParlayLegs picks 3 when 3-leg EV is clearly better', () => {
  const cands = [
    totLeg('Under 8.5', gameA, 0.56, -110),
    totLeg('Under 7.5', gameB, 0.56, -110),
    totLeg('Over 9.5', gameC, 0.56, -110),
  ];
  const legs = omega.selectParlayLegs(cands, 3);
  assert.strictEqual(legs.length, 3);
});

check('Omega buildCorrelatedParlay honest 2-leg label when 2 wins', () => {
  const picks = [{ pick: 'Yankees ML', matchup: gameC }];
  const cands = [
    tot('Under 8.5', gameA, 0.58, -110),
    tot('Under 7.5', gameB, 0.57, -110),
    tot('Over 9.5', gameC, 0.52, -105),
  ];
  const parlays = omega._testV104.buildCorrelatedParlay(picks, cands, []);
  assert.ok(parlays[0]);
  assert.strictEqual(parlays[0].type, '2-leg-parlay-optimized');
  assert.strictEqual(parlays[0].legs.length, 2);
});

check('source: Alpha restored to v10.3 control', () => {
  const aSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(aSrc.includes('v10.3.4-alpha-no-rockies'));
});

check('verify-picks-omega preserves generator parlay', () => {
  const oSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  assert.ok(oSrc.includes('Parlay preserved') || oSrc.includes('parlayLegs') || oSrc.includes('parlay'));
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
