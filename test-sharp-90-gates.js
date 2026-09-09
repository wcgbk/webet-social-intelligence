#!/usr/bin/env node
// Sharp-90 P0/P1 gates: no-mutation, fill-to-3 lean pad restored, fail-closed UD RL,
// bottom-club ban, MARKET_UNIT_CAPS on Alpha, predCLV ≥ 0 football.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const omega = require('./netlify/functions/generate-picks-omega-background');
const alpha = require('./netlify/functions/generate-picks-alpha-background');
const clvLib = require('./netlify/functions/lib/clv-summary');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

console.log('\nsharp-90 gates');

check('versions', () => {
  assert.strictEqual(alpha.MODEL_VERSION, 'v10.8-alpha-3plus-parlay2v3');
  assert.strictEqual(omega.MODEL_VERSION, 'v11.7-omega-parlay2v3');
});

check('F5 stays off MAIN', () => {
  assert.strictEqual(alpha.ALLOW_F5_ON_CARD, false);
  assert.strictEqual(omega.ALLOW_F5_ON_CARD, false);
});

check('Alpha still has no NFL/CFB sport keys', () => {
  assert.ok(!alpha.ODDS_SPORTS || !alpha.ODDS_SPORTS.includes('americanfootball_nfl'));
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(!src.includes('americanfootball_nfl'));
  assert.ok(!src.includes('americanfootball_ncaaf'));
});

check('Alpha CLV/self-opt observer does not mutate coverProb/kellyUnits', () => {
  const cands = [
    { sport: 'MLB', market: 'Total', coverProb: 0.55, kellyUnits: 1.5, ev: 0.048, kellyCalcStr: '' },
    { sport: 'MLB', market: 'Moneyline', coverProb: 0.52, kellyUnits: 2.0, ev: 0.06, kellyCalcStr: '' },
  ];
  const before = JSON.parse(JSON.stringify(cands));
  alpha.applyObservationalClvSelfOpt(
    cands,
    { MLB: 1.15, market_Total: 1.15, market_Moneyline: 0.85 },
    { sportKellyMult: { MLB: 1.25 }, marketKellyMult: { Total: 1.2, Moneyline: 0.8 }, coverProbAdjust: { MLB_Total: 0.08, MLB_Moneyline: -0.1 }, sampleSize: 40 },
  );
  assert.deepStrictEqual(cands, before);
});

check('Alpha generator source no longer writes coverProb from selfOpt', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(!/c\.coverProb = \+Math\.min\(0\.70, c\.coverProb \* probShift\)/.test(src));
  assert.ok(src.includes('observational only'));
  assert.ok(src.includes('REMOVED (v10.6'));
});

check('fill-to-3 lean pad restored', () => {
  assert.strictEqual(omega.LEAN_PAD_TO_THREE, true);
  assert.strictEqual(alpha.LEAN_PAD_TO_THREE, true);
  assert.strictEqual(omega.shouldLeanPadToThree(0), true);
  assert.strictEqual(omega.shouldLeanPadToThree(1), true);
  assert.strictEqual(omega.shouldLeanPadToThree(2), true);
  assert.strictEqual(omega.shouldLeanPadToThree(3), false);
  assert.strictEqual(alpha.shouldLeanPadToThree(0), true);
  assert.strictEqual(alpha.shouldLeanPadToThree(2), true);
  assert.strictEqual(alpha.shouldLeanPadToThree(3), false);
});

check('lean top-up path present (fill when conviction < 3)', () => {
  const oSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
  const aSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(oSrc.includes('v11.6-lean-topup') || oSrc.includes('LEAN TIER TOP-UP (restored'));
  assert.ok(aSrc.includes('v10.8-lean-topup') || aSrc.includes('v10.7-lean-topup') || aSrc.includes('LEAN TIER TOP-UP'));
  assert.ok(!oSrc.includes('No lean pad-to-3 — publishing'));
  assert.ok(!aSrc.includes('not padding weak legs'));
  // Alpha parlay builder must remain first-class
  assert.ok(aSrc.includes('buildCorrelatedParlay(picks, allCandidates, rejections)'));
});

check('fail-closed UD RL missing winProb', () => {
  const missing = {
    sport: 'MLB', market: 'Run Line', side: 'Royals +1.5', odds: -105, coverProb: 0.54,
    homeTeam: 'Royals', awayTeam: 'Yankees',
  };
  assert.strictEqual(alpha.passesUnderdogRlWinGate(missing), false);
  assert.strictEqual(omega.passesUnderdogRlWinGate(missing), false);
  assert.strictEqual(alpha.publishedCardRejectionReason(missing), 'underdog RL winProb missing');
  assert.strictEqual(omega.publishedCardRejectionReason(missing), 'underdog RL winProb missing');
});

check('bottom-club ban Athletics/Rockies plus-money ML and UD RL', () => {
  const athMl = { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 150, coverProb: 0.51 };
  const rockMl = { sport: 'MLB', market: 'Moneyline', side: 'Rockies ML', odds: 155, coverProb: 0.51 };
  const athRl = {
    sport: 'MLB', market: 'Run Line', side: 'Athletics +1.5', odds: -105, coverProb: 0.54,
    homeTeam: 'Athletics', awayTeam: 'Yankees', homeWinProb: 52,
  };
  for (const mod of [alpha, omega]) {
    assert.strictEqual(mod.passesBottomClubBan(athMl), false);
    assert.strictEqual(mod.passesBottomClubBan(rockMl), false);
    assert.strictEqual(mod.passesBottomClubBan(athRl), false);
    assert.strictEqual(mod.allowOnPublishedCard(athMl), false);
    assert.strictEqual(mod.allowOnPublishedCard(rockMl), false);
    assert.strictEqual(mod.allowOnPublishedCard(athRl), false);
  }
  const fav = { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: -130, coverProb: 0.58 };
  assert.strictEqual(alpha.passesBottomClubBan(fav), true);
  assert.strictEqual(alpha.allowOnPublishedCard(fav), true);
});

check('MARKET_UNIT_CAPS on Alpha', () => {
  assert.strictEqual(alpha.MARKET_UNIT_CAPS.Moneyline, 0.5);
  assert.strictEqual(alpha.MARKET_UNIT_CAPS.Total, 1.5);
  assert.strictEqual(alpha.MARKET_UNIT_CAPS['Run Line'], 1.0);
  assert.strictEqual(alpha.MARKET_UNIT_CAPS['F5 Moneyline'], 0.5);
  const picks = [
    { pick: 'Over 8.5', betType: 'Total', units: '3.0u', rating: 'A' },
    { pick: 'Yankees ML', betType: 'Moneyline', units: '2.0u', rating: 'A' },
    { pick: 'Padres +1.5', betType: 'Run Line', units: '1.5u', rating: 'B+' },
  ];
  alpha.applyMarketUnitCaps(picks);
  assert.strictEqual(picks[0].units, '1.5u');
  assert.strictEqual(picks[1].units, '0.5u');
  assert.ok(picks[2].units === '1u' || picks[2].units === '1.0u');
});

check('Omega predCLV gate is ≥ 0 when present', () => {
  const nflNeg = { sport: 'NFL', predCLV: -0.01, ev: 0.04, coverProb: 0.56, odds: -110, market: 'Total', side: 'Over 44.5', matchup: 'A @ B' };
  const nflZero = { ...nflNeg, predCLV: 0 };
  const nflPos = { ...nflNeg, predCLV: 0.01 };
  const nflMissing = { sport: 'NFL', ev: 0.04, coverProb: 0.56, odds: -110, market: 'Total', side: 'Over 44.5', matchup: 'A @ B' };
  assert.strictEqual(omega.passesPredClvGate(nflNeg), false);
  assert.strictEqual(omega.passesPredClvGate(nflZero), true);
  assert.strictEqual(omega.passesPredClvGate(nflPos), true);
  assert.strictEqual(omega.passesPredClvGate(nflMissing), true);
});

check('Omega football MAIN max 1 slot', () => {
  assert.strictEqual(omega.FOOTBALL_MAIN_MAX_SLOTS, 1);
  const pool = [
    { sport: 'NFL', market: 'Total', side: 'Over 44.5', odds: -110, coverProb: 0.56, ev: 0.05, matchup: 'Chiefs @ Bills', awayTeam: 'Chiefs', homeTeam: 'Bills', predCLV: 0.01 },
    { sport: 'NCAAF', market: 'Total', side: 'Under 55.5', odds: -110, coverProb: 0.55, ev: 0.045, matchup: 'Alabama @ Georgia', awayTeam: 'Alabama', homeTeam: 'Georgia', predCLV: 0.02 },
    { sport: 'MLB', market: 'Total', side: 'Under 8.5', odds: -110, coverProb: 0.55, ev: 0.04, matchup: 'Cubs @ Mets', awayTeam: 'Cubs', homeTeam: 'Mets' },
    { sport: 'MLB', market: 'Total', side: 'Over 7.5', odds: -105, coverProb: 0.54, ev: 0.038, matchup: 'Padres @ Giants', awayTeam: 'Padres', homeTeam: 'Giants' },
  ];
  const picked = omega.selectDiversifiedStraights(pool, 3, 0.03);
  const football = picked.filter(c => c.sport === 'NFL' || c.sport === 'NCAAF');
  assert.ok(football.length <= 1, 'expected at most 1 football slot, got ' + football.length);
  assert.ok(picked.some(c => c.sport === 'MLB'));
});

check('Alpha park rename aliases + Athletics city', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(src.includes('"Daikin Park"'));
  assert.ok(src.includes('"Rate Field"'));
  assert.ok(src.includes('"Oriole Park at Camden Yards"'));
  assert.ok(src.includes('George M. Steinbrenner Field'));
  assert.strictEqual(alpha.MLB_CITY_OVERRIDES.Athletics, 'Sacramento');
  assert.strictEqual(alpha.mlbCityFromTeam('Athletics'), 'Sacramento');
  assert.strictEqual(alpha.mlbCityFromTeam('Chicago Cubs'), 'Chicago');
  assert.strictEqual(alpha.mlbCityFromTeam('Boston Red Sox'), 'Boston');
});

check('Alpha DH FIP Team|eventISO merge present', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(src.includes('Team|<eventISO>') || src.includes('Team|'));
  assert.ok(src.includes('pitcherForGame'));
  assert.ok(typeof alpha.pitcherForGame === 'function');
  const data = {
    Yankees: { pitcher: 'G1', gameDate: '2026-09-09T17:00:00Z' },
    'Yankees|2026-09-09T23:00:00Z': { pitcher: 'G2', gameDate: '2026-09-09T23:00:00Z' },
  };
  assert.strictEqual(alpha.pitcherForGame(data, 'Yankees', '2026-09-09T23:05:00Z').pitcher, 'G2');
});

check('CLV summary helper returns honest nulls when empty', () => {
  const empty = clvLib.summarizeClvBlobs([]);
  assert.strictEqual(empty.available, false);
  assert.strictEqual(empty.meanCents, null);
  assert.strictEqual(empty.beatClosePct, null);
  assert.strictEqual(empty.n, 0);
});

check('CLV summary helper aggregates existing blobs', () => {
  const blob = {
    picks: [
      { market: 'Total', clvCents: 0.5, beatClosing: true },
      { market: 'Moneyline', clvCents: -0.4, beatClosing: false },
      { market: 'Total', clv: 0.01, beatClosing: true },
    ],
  };
  const s = clvLib.summarizeClvBlobs([blob]);
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.n, 3);
  assert.ok(typeof s.meanCents === 'number');
  assert.ok(s.byFamily.Total.n === 2);
  assert.ok(s.byFamily.ML.n === 1);
});

check('Alpha get-picks uses todayET not latest-date as today', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-picks-alpha.js'), 'utf8');
  assert.ok(src.includes('function todayET'));
  assert.ok(src.includes('todayET()'));
  assert.ok(!/store\.get\("latest-date"\)/.test(src));
});

check('Alpha results full-history default + optional ?from= + honest parlays', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-alpha.js'), 'utf8');
  // Default must be FULL history (architecture dashboard); only filter when ?from= set.
  assert.ok(!src.includes("KPI_START_DEFAULT = '2026-09-05'"));
  assert.ok(src.includes('results-alpha-cache-v7-full'));
  assert.ok(src.includes('results-alpha-cache-v7-from-'));
  assert.ok(src.includes('params.from'));
  assert.ok(src.includes('KPI_START ? alphaDatesRaw.filter'));
  assert.ok(src.includes(': null;'));
  assert.ok(src.includes('pickResults.length < 2'));
  assert.ok(src.includes('publishedParlayUnits'));
  assert.ok(src.includes('-leg parlay'));
  assert.ok(!src.includes("'3-Team Parlay'"));
});

check('confirm-starters covers Alpha+Omega stores', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/confirm-starters-mlb.js'), 'utf8');
  assert.ok(src.includes('edge-picks-alpha'));
  assert.ok(src.includes('edge-picks-omega'));
  assert.ok(src.includes('todayET'));
  assert.ok(src.includes('killed'));
});

check('Alpha JS-lock uses selectDiversifiedStraights', () => {
  const total = { sport: 'MLB', market: 'Total', side: 'Under 8.5', odds: -110, coverProb: 0.55, ev: 0.04, matchup: 'Cubs @ Mets', awayTeam: 'Cubs', homeTeam: 'Mets' };
  const ath = { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 145, coverProb: 0.51, ev: 0.09, matchup: 'Athletics @ Yankees', awayTeam: 'Athletics', homeTeam: 'Yankees' };
  const picked = alpha.selectDiversifiedStraights([ath, total], 3, 0.03);
  assert.ok(!picked.some(c => c.side === 'Athletics ML'));
  assert.ok(picked.some(c => c.side === 'Under 8.5'));
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
