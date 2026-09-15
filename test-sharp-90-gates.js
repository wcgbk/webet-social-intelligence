#!/usr/bin/env node
// Sharp-90 / fill gates on Omega only. Alpha is restored pre-coupling control (v10.3).
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const omega = require('./netlify/functions/generate-picks-omega-background');
const clvLib = require('./netlify/functions/lib/clv-summary');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

console.log('\nalpha control restore');
check('Alpha generator is v10.3.1-alpha-no-f5 (F5 off)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
  assert.ok(src.includes('v10.3.1-alpha-no-f5'));
  assert.ok(src.includes('modelVersion: "v10.3.1-alpha-no-f5"'));
  assert.ok(!src.includes('v10.8-alpha-3plus-parlay2v3'));
  assert.ok(src.includes('ALLOW_F5_ON_CARD = false'));
  assert.ok(src.includes('F5_MAX_SLOTS = 0'));
  assert.ok(!src.includes('v10.6-alpha-sharp-90'));
  assert.ok(!src.includes('americanfootball_nfl'));
  assert.ok(!src.includes('americanfootball_ncaaf'));
  // Claude SELECTOR (pre-coupling), not JS-lock verify-only
  assert.ok(src.includes('Claude SELECTS') || src.includes('max_uses: 20') || src.includes('SELECTOR'));
});
check('Alpha get-picks/get-results restored to pre-coupling control', () => {
  const picks = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-picks-alpha.js'), 'utf8');
  const results = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-alpha.js'), 'utf8');
  assert.ok(picks.includes('latest-date'));
  assert.ok(!picks.includes('results-alpha-cache-v7-full'));
  assert.ok(results.includes('results-alpha-cache-v5'));
  assert.ok(!results.includes('results-alpha-cache-v7-full'));
});

console.log('\nomega sharp-90 / fill gates');
check('Omega version', () => {
  assert.strictEqual(omega.MODEL_VERSION, 'v11.9-omega-always-3');
});
check('F5 stays off MAIN', () => {
  assert.strictEqual(omega.ALLOW_F5_ON_CARD, false);
});
check('always-3: lean pad ON', () => {
  assert.strictEqual(omega.LEAN_PAD_TO_THREE, true);
  assert.strictEqual(omega.shouldLeanPadToThree(0), true);
  assert.strictEqual(omega.shouldLeanPadToThree(2), true);
  assert.strictEqual(omega.shouldLeanPadToThree(3), false);
  assert.strictEqual(omega.SOFT_DIVERSIFY_MLB_TOTALS, true);
});
check('soft diversity prefers side then still fills to 3', () => {
  const pool = [
    { sport: 'MLB', market: 'Total', side: 'Over 7.5', odds: -110, coverProb: 0.55, ev: 0.05, matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B' },
    { sport: 'MLB', market: 'Total', side: 'Over 8.5', odds: -110, coverProb: 0.54, ev: 0.045, matchup: 'C @ D', awayTeam: 'C', homeTeam: 'D' },
    { sport: 'MLB', market: 'Total', side: 'Over 8', odds: -110, coverProb: 0.53, ev: 0.04, matchup: 'E @ F', awayTeam: 'E', homeTeam: 'F' },
    { sport: 'MLB', market: 'Moneyline', side: 'Yankees ML', odds: -130, coverProb: 0.58, ev: 0.035, matchup: 'Yanks @ Sox', awayTeam: 'Yankees', homeTeam: 'Red Sox' },
  ];
  const picked = omega.selectDiversifiedStraights(pool, 3, 0.03);
  assert.strictEqual(picked.length, 3, 'always fill 3');
  assert.ok(picked.some(c => c.side === 'Yankees ML'), 'side should win a slot via soft diversity');
  assert.ok(picked.some(c => c.side === 'Over 7.5'));
});
check('Overs-only pool still fills to 3 (parlay needs full card)', () => {
  const pool = [
    { sport: 'MLB', market: 'Total', side: 'Over 7.5', odds: -110, coverProb: 0.55, ev: 0.05, matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B' },
    { sport: 'MLB', market: 'Total', side: 'Over 8.5', odds: -110, coverProb: 0.54, ev: 0.045, matchup: 'C @ D', awayTeam: 'C', homeTeam: 'D' },
    { sport: 'MLB', market: 'Total', side: 'Over 8', odds: -110, coverProb: 0.53, ev: 0.04, matchup: 'E @ F', awayTeam: 'E', homeTeam: 'F' },
  ];
  const picked = omega.selectDiversifiedStraights(pool, 3, 0.03);
  assert.strictEqual(picked.length, 3);
});
check('fail-closed UD RL missing winProb (Omega)', () => {
  const missing = {
    sport: 'MLB', market: 'Run Line', side: 'Royals +1.5', odds: -105, coverProb: 0.54,
    homeTeam: 'Royals', awayTeam: 'Yankees',
  };
  assert.strictEqual(omega.passesUnderdogRlWinGate(missing), false);
  assert.strictEqual(omega.publishedCardRejectionReason(missing), 'underdog RL winProb missing');
});
check('bottom-club ban Athletics/Rockies (Omega)', () => {
  const athMl = { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 150, coverProb: 0.51 };
  const rockMl = { sport: 'MLB', market: 'Moneyline', side: 'Rockies ML', odds: 155, coverProb: 0.51 };
  const athRl = {
    sport: 'MLB', market: 'Run Line', side: 'Athletics +1.5', odds: -105, coverProb: 0.54,
    homeTeam: 'Athletics', awayTeam: 'Yankees', homeWinProb: 52,
  };
  assert.strictEqual(omega.passesBottomClubBan(athMl), false);
  assert.strictEqual(omega.passesBottomClubBan(rockMl), false);
  assert.strictEqual(omega.passesBottomClubBan(athRl), false);
  assert.strictEqual(omega.allowOnPublishedCard(athMl), false);
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

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
