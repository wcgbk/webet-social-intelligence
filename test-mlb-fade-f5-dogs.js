#!/usr/bin/env node
// Offline unit checks for F5-off-card + MLB underdog ML coverProb gates.
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

const athleticsDog = {
  sport: 'MLB', market: 'Moneyline', side: 'Athletics ML',
  odds: 145, coverProb: 0.42, ev: 0.08, source: 'full-game',
};
const athleticsDog499 = { ...athleticsDog, coverProb: 0.499 };
const athleticsFlip = { ...athleticsDog, coverProb: 0.50 };
const favoriteMl = { ...athleticsDog, odds: -130, coverProb: 0.58 };
const runLine = { sport: 'MLB', market: 'Spread', side: 'Athletics +1.5', odds: -110, coverProb: 0.48 };
const total = { sport: 'MLB', market: 'Total', side: 'Over 8.5', odds: -110, coverProb: 0.48 };
const nflDog = { sport: 'NFL', market: 'Moneyline', side: 'Jets ML', odds: 160, coverProb: 0.41 };
const f5Dog = { sport: 'MLB', market: 'F5 Moneyline', side: 'Athletics F5 ML', odds: 120, coverProb: 0.55, source: 'F5' };
const f5Total = { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, source: 'F5' };
const pubShape = { sport: 'MLB', betType: 'Moneyline', pick: 'Rockies ML', odds: '+155', coverProb: '41%' };

for (const [label, mod] of [['omega', omega], ['alpha', alpha]]) {
  console.log('\n' + label);
  check('model version bumped', () => {
    if (label === 'omega') assert.strictEqual(mod.MODEL_VERSION, 'v11.3-omega-fade-ud-ml');
    else assert.strictEqual(mod.MODEL_VERSION, 'v10.4-alpha-fade-f5-ud');
  });
  check('F5 constants', () => {
    assert.strictEqual(mod.ALLOW_F5_ON_CARD, false);
    assert.strictEqual(mod.F5_SKIP_ML_UNDERDOG, true);
  });
  check('F5 candidates off published card', () => {
    assert.strictEqual(mod.isF5Candidate(f5Dog), true);
    assert.strictEqual(mod.isF5Candidate(f5Total), true);
    assert.strictEqual(mod.allowOnPublishedCard(f5Dog), false);
    assert.strictEqual(mod.allowOnPublishedCard(f5Total), false);
    assert.ok(/F5 disabled/.test(mod.publishedCardRejectionReason(f5Dog)));
  });
  check('underdog ML coverProb < 0.50 rejected', () => {
    assert.strictEqual(mod.isFullGameUnderdogML(athleticsDog), true);
    assert.strictEqual(mod.passesUnderdogMlCoverGate(athleticsDog), false);
    assert.strictEqual(mod.allowOnPublishedCard(athleticsDog), false);
    assert.strictEqual(mod.publishedCardRejectionReason(athleticsDog), 'underdog ML coverProb < 0.50');
  });
  check('coverProb 0.499 treated as < 0.50', () => {
    assert.strictEqual(mod.passesUnderdogMlCoverGate(athleticsDog499), false);
  });
  check('coverProb 0.50 underdog ML allowed', () => {
    assert.strictEqual(mod.passesUnderdogMlCoverGate(athleticsFlip), true);
    assert.strictEqual(mod.allowOnPublishedCard(athleticsFlip), true);
    assert.strictEqual(mod.publishedCardRejectionReason(athleticsFlip), null);
  });
  check('favorites / run lines / totals / non-MLB not gated', () => {
    assert.strictEqual(mod.isFullGameUnderdogML(favoriteMl), false);
    assert.strictEqual(mod.allowOnPublishedCard(favoriteMl), true);
    assert.strictEqual(mod.allowOnPublishedCard(runLine), true);
    assert.strictEqual(mod.allowOnPublishedCard(total), true);
    assert.strictEqual(mod.allowOnPublishedCard(nflDog), true);
  });
  check('published-pick shape (+odds string, coverProb percent)', () => {
    assert.strictEqual(mod.isFullGameUnderdogML(pubShape), true);
    assert.strictEqual(mod.passesUnderdogMlCoverGate(pubShape), false);
  });
}

check('omega selectDiversifiedStraights drops F5 and sub-50% UD ML', () => {
  const pool = [
    { ...athleticsDog, ev: 0.09, matchup: 'Athletics @ Yankees', awayTeam: 'Athletics', homeTeam: 'Yankees', side: 'Athletics ML' },
    { ...f5Total, ev: 0.10, matchup: 'Rockies @ Dodgers', awayTeam: 'Rockies', homeTeam: 'Dodgers' },
    { sport: 'MLB', market: 'Total', side: 'Under 8.5', odds: -110, coverProb: 0.55, ev: 0.04, matchup: 'Cubs @ Mets', awayTeam: 'Cubs', homeTeam: 'Mets' },
  ];
  const picked = omega.selectDiversifiedStraights(pool, 3, 0.03);
  assert.ok(!picked.some(c => c.side === 'Athletics ML'));
  assert.ok(!picked.some(c => omega.isF5Candidate(c)));
  assert.ok(picked.some(c => c.side === 'Under 8.5'));
});

check('omega parlay pool drops gated sides', () => {
  const picks = [{ pick: 'Under 8.5', sport: 'MLB', matchup: 'Cubs @ Mets', betType: 'Total', odds: '-110', coverProb: '55%' }];
  const cands = [
    { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 145, coverProb: 0.42, ev: 0.09, matchup: 'Athletics @ Yankees' },
    { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, ev: 0.06, matchup: 'Rockies @ Dodgers', source: 'F5' },
    { sport: 'MLB', market: 'Total', side: 'Under 8.5', odds: -110, coverProb: 0.55, ev: 0.04, matchup: 'Cubs @ Mets' },
    { sport: 'MLB', market: 'Total', side: 'Over 7.5', odds: -105, coverProb: 0.53, ev: 0.035, matchup: 'Padres @ Giants' },
    { sport: 'MLB', market: 'Total', side: 'Under 9', odds: -108, coverProb: 0.52, ev: 0.033, matchup: 'Red Sox @ Rays' },
  ];
  const parlays = omega._testV104.buildCorrelatedParlay(picks, cands, []);
  const legs = (parlays[0] && parlays[0].legs) || [];
  assert.ok(!legs.some(l => /Athletics/.test(l.pick)));
  assert.ok(!legs.some(l => /F5/.test(l.pick) || /F5/.test(l.betType || '')));
});

const omegaSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
const alphaSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-alpha-background.js'), 'utf8');
check('both files skip plus-money F5 ML at candidate build', () => {
  const needle = 'if (F5_SKIP_ML_UNDERDOG && (data.price || 0) > 0) continue';
  assert.ok(omegaSrc.includes(needle));
  assert.ok(alphaSrc.includes(needle));
});
check('Claude verify-only path still present on Omega', () => {
  assert.ok(omegaSrc.includes('JS-locked'));
  assert.ok(omegaSrc.includes('max_uses: 5') || omegaSrc.includes('max_uses 5'));
  assert.ok(omegaSrc.includes('claudeVerified'));
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
