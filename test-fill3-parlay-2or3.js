#!/usr/bin/env node
// Alpha fill-to-3 (EV>0 lean floor) + honest 2-vs-3 parlay optimizer on Alpha and Omega.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const omega = require('./netlify/functions/generate-picks-omega-background');
const alpha = require('./netlify/functions/generate-picks-alpha-background');

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
  assert.strictEqual(alpha.MODEL_VERSION, 'v10.8-alpha-3plus-parlay2v3');
  assert.strictEqual(omega.MODEL_VERSION, 'v11.7-omega-parlay2v3');
});

check('Alpha lean fill floor is 0 (was 1.5%)', () => {
  assert.strictEqual(alpha.LEAN_FILL_EV_FLOOR, 0);
  assert.strictEqual(alpha.LEAN_PAD_TO_THREE, true);
});

check('Alpha lean fill-to-3 takes sub-1.5% EV totals', () => {
  const picks = [
    { pick: 'Under 8.5', matchup: gameA },
    { pick: 'Over 7.5', matchup: gameB },
  ];
  const cands = [
    tot('Under 8.5', gameA, 0.55, -110, { ev: 0.04 }),
    tot('Over 7.5', gameB, 0.54, -110, { ev: 0.035 }),
    tot('Under 9.5', gameC, 0.54, -110, { ev: 0.008 }), // below old 1.5% floor
  ];
  const filled = alpha.selectLeanTopUps(picks, cands, 1, new Set());
  assert.strictEqual(filled.length, 1);
  assert.strictEqual(filled[0].side, 'Under 9.5');
});

check('Alpha lean fill prefers totals/RL over ML', () => {
  const picks = [
    { pick: 'Under 8.5', matchup: gameA },
    { pick: 'Over 7.5', matchup: gameB },
  ];
  const cands = [
    { sport: 'MLB', market: 'Moneyline', side: 'Yankees ML', odds: -130, coverProb: 0.58, ev: 0.06, matchup: gameC, awayTeam: 'Yankees', homeTeam: 'Red Sox' },
    tot('Under 9.5', gameD, 0.54, -110, { ev: 0.008 }),
  ];
  const filled = alpha.selectLeanTopUps(picks, cands, 1, new Set());
  assert.strictEqual(filled.length, 1);
  assert.strictEqual(filled[0].side, 'Under 9.5');
});

check('Alpha lean fill skips F5, Athletics plus-money, and sub-50% UD RL', () => {
  const picks = [
    { pick: 'Under 8.5', matchup: gameA },
    { pick: 'Over 7.5', matchup: gameB },
  ];
  const cands = [
    { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, ev: 0.06, matchup: gameC, source: 'F5' },
    { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 145, coverProb: 0.51, ev: 0.09, matchup: 'Athletics @ Yankees', awayTeam: 'Athletics', homeTeam: 'Yankees' },
    { sport: 'MLB', market: 'Run Line', side: 'Athletics +1.5', odds: -105, coverProb: 0.54, ev: 0.05, matchup: 'Athletics @ Yankees', awayTeam: 'Athletics', homeTeam: 'Yankees', homeWinProb: 52 },
    tot('Under 9.5', gameD, 0.54, -110, { ev: 0.006 }),
  ];
  const filled = alpha.selectLeanTopUps(picks, cands, 1, new Set());
  assert.strictEqual(filled.length, 1);
  assert.strictEqual(filled[0].side, 'Under 9.5');
  assert.ok(!filled.some(c => /Athletics|F5/.test(c.side)));
});

check('Alpha lean fill skips Claude-rejected sides and same-game dupes', () => {
  const picks = [{ pick: 'Under 8.5', matchup: gameA }];
  const rejected = new Set(['under 9.5']);
  const cands = [
    tot('Under 8.0', gameA, 0.55, -110, { ev: 0.05 }), // same game as card
    tot('Under 9.5', gameC, 0.54, -110, { ev: 0.04 }), // rejected
    tot('Over 7.5', gameB, 0.54, -110, { ev: 0.007 }),
  ];
  const filled = alpha.selectLeanTopUps(picks, cands, 2, rejected);
  assert.strictEqual(filled.length, 1);
  assert.strictEqual(filled[0].side, 'Over 7.5');
});

check('Alpha lean fill does not invent sides when <3 eligible games', () => {
  const picks = [
    { pick: 'Under 8.5', matchup: gameA },
    { pick: 'Over 7.5', matchup: gameB },
  ];
  const cands = [
    tot('Under 8.5', gameA, 0.55, -110, { ev: 0.04 }),
    tot('Over 7.5', gameB, 0.54, -110, { ev: 0.035 }),
    { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, ev: 0.06, matchup: gameC, source: 'F5' },
  ];
  const filled = alpha.selectLeanTopUps(picks, cands, 1, new Set());
  assert.strictEqual(filled.length, 0);
});

check('chooseParlay2or3: 3-leg when adjusted EV is clearly better', () => {
  const a = totLeg('Under 8.5', gameA, 0.56, -110);
  const b = totLeg('Under 7.5', gameB, 0.56, -110);
  const c = totLeg('Over 9.5', gameC, 0.56, -110);
  for (const mod of [alpha, omega]) {
    const chosen = mod.chooseParlay2or3([a, b], [a, b, c]);
    assert.strictEqual(chosen.length, 3, mod.MODEL_VERSION + ' should pick 3-leg');
  }
});

check('chooseParlay2or3: 2-leg when its adjusted EV is higher', () => {
  // Heavy-favorite 3rd leg with thin edge tanks combo EV vs two strong totals.
  const a = totLeg('Under 8.5', gameA, 0.62, -150);
  const b = totLeg('Under 7.5', gameB, 0.60, -140);
  const c = totLeg('Over 9.5', gameC, 0.53, -200);
  for (const mod of [alpha, omega]) {
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
  for (const mod of [alpha, omega]) {
    const s2 = mod._testV104.parlayComboStats([a, b]);
    const s3 = mod._testV104.parlayComboStats([a, b, c]);
    assert.ok(s3.adjustedEV >= s2.adjustedEV, 'precondition: 3-leg EV not worse');
    assert.ok((s3.adjustedEV - s2.adjustedEV) <= mod.PARLAY_EV_TIE_BAND, 'precondition: EV close');
    assert.ok(s2.combinedProb >= s3.combinedProb + mod.PARLAY_HIT_RATE_EDGE, 'precondition: hit-rate edge');
    const chosen = mod.chooseParlay2or3([a, b], [a, b, c]);
    assert.strictEqual(chosen.length, 2, mod.MODEL_VERSION + ' should pick 2-leg on hit-rate');
  }
});

check('Alpha selectParlayLegs honest 2-vs-3 (same-dir 3-leg skipped → 2-leg)', () => {
  const cands = [
    totLeg('Under 8.5', gameA, 0.56, -110),
    totLeg('Under 7.5', gameB, 0.56, -110),
    totLeg('Under 9.5', gameC, 0.56, -110),
  ];
  const legs = alpha.selectParlayLegs(cands, 3);
  assert.strictEqual(legs.length, 2);
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

check('Alpha buildCorrelatedParlay labels 3-leg-parlay-optimized when 3 wins', () => {
  const picks = [{ pick: 'Yankees ML', matchup: gameC }];
  const cands = [
    tot('Under 8.5', gameA, 0.56, -110),
    tot('Under 7.5', gameB, 0.56, -110),
    tot('Over 9.5', gameC, 0.56, -110),
  ];
  const parlays = alpha.buildCorrelatedParlay(picks, cands, []);
  assert.ok(parlays[0], 'expected a parlay');
  assert.strictEqual(parlays[0].type, '3-leg-parlay-optimized');
  assert.strictEqual(parlays[0].legs.length, 3);
});

check('Alpha buildCorrelatedParlay labels 2-leg-parlay-optimized when 2 wins', () => {
  const picks = [{ pick: 'Yankees ML', matchup: gameC }];
  const cands = [
    tot('Under 8.5', gameA, 0.58, -110),
    tot('Under 7.5', gameB, 0.57, -110),
    tot('Over 9.5', gameC, 0.52, -105),
  ];
  const parlays = alpha.buildCorrelatedParlay(picks, cands, []);
  assert.ok(parlays[0], 'expected a parlay');
  assert.strictEqual(parlays[0].type, '2-leg-parlay-optimized');
  assert.strictEqual(parlays[0].legs.length, 2);
  assert.ok(!/fallback/.test(parlays[0].type));
});

check('Alpha parlay ignores bookkeeping "Not selected" rejections (independent pool)', () => {
  const picks = [{ pick: 'Yankees ML', matchup: gameC, betType: 'Moneyline', odds: '-130', coverProb: '58%' }];
  const cands = [
    tot('Under 8.5', gameA, 0.56, -110),
    tot('Under 7.5', gameB, 0.56, -110),
    tot('Over 9.5', gameD, 0.56, -110),
    { sport: 'MLB', market: 'Moneyline', side: 'Yankees ML', odds: -130, coverProb: 0.58, ev: 0.04, matchup: gameC },
  ];
  const rejections = cands.map(c => ({ side: c.side, reason: 'Not selected — lower edge priority / diversification.' }));
  const parlays = alpha.buildCorrelatedParlay(picks, cands, rejections);
  assert.ok(parlays[0]);
  assert.ok(/optimized/.test(parlays[0].type));
  assert.ok(parlays[0].independent === true);
  assert.ok(!parlays[0].legs.every(l => l.pick === 'Yankees ML'));
});

check('Alpha parlay still drops F5 / Athletics plus-money', () => {
  const picks = [{ pick: 'Under 8.5', matchup: gameA }];
  const cands = [
    tot('Under 8.5', gameA, 0.56, -110),
    tot('Under 7.5', gameB, 0.56, -110),
    tot('Over 9.5', gameD, 0.56, -110),
    { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, ev: 0.06, matchup: gameC, source: 'F5' },
    { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 145, coverProb: 0.51, ev: 0.09, matchup: 'Athletics @ Yankees' },
  ];
  const parlays = alpha.buildCorrelatedParlay(picks, cands, []);
  const legs = (parlays[0] && parlays[0].legs) || [];
  assert.ok(legs.length >= 2);
  assert.ok(!legs.some(l => /Athletics|F5/.test(l.pick) || /F5/.test(l.betType || '')));
});

check('Alpha parlay stake stays 0.5u even with lean picks on the card', () => {
  const picks = [
    { pick: 'Under 8.5', matchup: gameA, thinSlate: true, rating: 'Lean', dataVerified: 'lean-tier' },
  ];
  const cands = [
    tot('Under 8.5', gameA, 0.56, -110),
    tot('Under 7.5', gameB, 0.56, -110),
    tot('Over 9.5', gameC, 0.56, -110),
  ];
  const parlays = alpha.buildCorrelatedParlay(picks, cands, []);
  assert.ok(parlays[0]);
  assert.strictEqual(parlays[0].units, '0.5u');
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

check('source: no mislabeled 3-leg-parlay-fallback on Alpha', () => {
  const aSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(!aSrc.includes('type: "3-leg-parlay-fallback"'));
  assert.ok(aSrc.includes('2-leg-parlay-') || aSrc.includes('leg-parlay-${'));
  assert.ok(aSrc.includes('chooseParlay2or3'));
  assert.ok(aSrc.includes('v10.8-lean-topup'));
});

check('verify-picks preserves generator parlay (Alpha + Omega)', () => {
  const aSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks.js'), 'utf8');
  const oSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  assert.ok(aSrc.includes('Parlay preserved'));
  assert.ok(aSrc.includes('${legs.length}-leg-parlay-verified'));
  assert.ok(oSrc.includes('${legs.length}-leg-parlay-verified'));
  assert.ok(oSrc.includes('picksData.picks.length >= 2'));
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
