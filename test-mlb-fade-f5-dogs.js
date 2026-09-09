#!/usr/bin/env node
// Offline unit checks for F5-off-card + MLB underdog ML/RL coverProb gates.
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
const runLineLow = { sport: 'MLB', market: 'Spread', side: 'Athletics +1.5', odds: -110, coverProb: 0.48 };
const runLineNamed = { sport: 'MLB', market: 'Run Line', side: 'Athletics +1.5', odds: -105, coverProb: 0.48 };
const runLine499 = { ...runLineNamed, coverProb: 0.499 };
const runLineFlip = { ...runLineNamed, coverProb: 0.50 };
const runLineToday = {
  sport: 'MLB', market: 'Run Line', side: 'Athletics +1.5', odds: -105,
  coverProb: 0.5415, ev: 0.0572, source: 'full-game',
  homeTeam: 'Athletics', awayTeam: 'Toronto Blue Jays',
  homeWinProb: 46, matchup: 'Toronto Blue Jays @ Athletics',
};
const runLineMarketFav = {
  ...runLineToday, coverProb: 0.5415, homeWinProb: 52,
};
const favoriteRl = { sport: 'MLB', market: 'Run Line', side: 'Yankees -1.5', odds: -150, coverProb: 0.48 };
const total = { sport: 'MLB', market: 'Total', side: 'Over 8.5', odds: -110, coverProb: 0.48 };
const nflDog = { sport: 'NFL', market: 'Moneyline', side: 'Jets ML', odds: 160, coverProb: 0.41 };
const nflSpread = { sport: 'NFL', market: 'Spread', side: 'Jets +3.5', odds: -110, coverProb: 0.48 };
const f5Dog = { sport: 'MLB', market: 'F5 Moneyline', side: 'Athletics F5 ML', odds: 120, coverProb: 0.55, source: 'F5' };
const f5Total = { sport: 'MLB', market: 'F5 Total', side: 'F5 Under 5.5', odds: -115, coverProb: 0.54, source: 'F5' };
const pubShape = { sport: 'MLB', betType: 'Moneyline', pick: 'Rockies ML', odds: '+155', coverProb: '41%' };
const pubRlShape = { sport: 'MLB', betType: 'Run Line', pick: 'Athletics +1.5', odds: '-105', coverProb: '48%' };

for (const [label, mod] of [['omega', omega], ['alpha', alpha]]) {
  console.log('\n' + label);
  check('model version bumped', () => {
    if (label === 'omega') assert.strictEqual(mod.MODEL_VERSION, 'v11.4-omega-fade-ud-rl');
    else assert.strictEqual(mod.MODEL_VERSION, 'v10.5-alpha-fade-ud-rl');
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
  check('underdog RL coverProb < 0.50 rejected (Spread + Run Line labels)', () => {
    assert.strictEqual(mod.isFullGameUnderdogRL(runLineLow), true);
    assert.strictEqual(mod.isFullGameUnderdogRL(runLineNamed), true);
    assert.strictEqual(mod.passesUnderdogRlCoverGate(runLineLow), false);
    assert.strictEqual(mod.allowOnPublishedCard(runLineLow), false);
    assert.strictEqual(mod.publishedCardRejectionReason(runLineLow), 'underdog RL coverProb < 0.50');
    assert.strictEqual(mod.publishedCardRejectionReason(runLineNamed), 'underdog RL coverProb < 0.50');
  });
  check('underdog RL coverProb 0.499 treated as < 0.50', () => {
    assert.strictEqual(mod.passesUnderdogRlCoverGate(runLine499), false);
  });
  check('underdog RL coverProb 0.50 allowed when winProb absent', () => {
    assert.strictEqual(mod.passesUnderdogRlCoverGate(runLineFlip), true);
    assert.strictEqual(mod.passesUnderdogRlWinGate(runLineFlip), true);
    assert.strictEqual(mod.allowOnPublishedCard(runLineFlip), true);
    assert.strictEqual(mod.publishedCardRejectionReason(runLineFlip), null);
  });
  check('today Athletics +1.5 (54% cover, 46% winProb) rejected', () => {
    assert.strictEqual(mod.isFullGameUnderdogRL(runLineToday), true);
    assert.strictEqual(mod.passesUnderdogRlCoverGate(runLineToday), true);
    assert.strictEqual(mod.passesUnderdogRlWinGate(runLineToday), false);
    assert.strictEqual(mod.allowOnPublishedCard(runLineToday), false);
    assert.strictEqual(mod.publishedCardRejectionReason(runLineToday), 'underdog RL winProb < 0.50');
  });
  check('underdog RL with model winProb >= 0.50 allowed', () => {
    assert.strictEqual(mod.passesUnderdogRlWinGate(runLineMarketFav), true);
    assert.strictEqual(mod.allowOnPublishedCard(runLineMarketFav), true);
    assert.strictEqual(mod.publishedCardRejectionReason(runLineMarketFav), null);
  });
  check('favorites / totals / non-MLB not gated', () => {
    assert.strictEqual(mod.isFullGameUnderdogML(favoriteMl), false);
    assert.strictEqual(mod.allowOnPublishedCard(favoriteMl), true);
    assert.strictEqual(mod.isFullGameUnderdogRL(favoriteRl), false);
    assert.strictEqual(mod.allowOnPublishedCard(favoriteRl), true);
    assert.strictEqual(mod.allowOnPublishedCard(total), true);
    assert.strictEqual(mod.allowOnPublishedCard(nflDog), true);
    assert.strictEqual(mod.isFullGameUnderdogRL(nflSpread), false);
    assert.strictEqual(mod.allowOnPublishedCard(nflSpread), true);
  });
  check('published-pick shape (+odds string, coverProb percent)', () => {
    assert.strictEqual(mod.isFullGameUnderdogML(pubShape), true);
    assert.strictEqual(mod.passesUnderdogMlCoverGate(pubShape), false);
    assert.strictEqual(mod.isFullGameUnderdogRL(pubRlShape), true);
    assert.strictEqual(mod.passesUnderdogRlCoverGate(pubRlShape), false);
    assert.strictEqual(mod.publishedCardRejectionReason(pubRlShape), 'underdog RL coverProb < 0.50');
  });
}

check('omega selectDiversifiedStraights drops F5, sub-50% UD ML, and UD RL', () => {
  const pool = [
    { ...athleticsDog, ev: 0.09, matchup: 'Athletics @ Yankees', awayTeam: 'Athletics', homeTeam: 'Yankees', side: 'Athletics ML' },
    { ...runLineToday, ev: 0.0572 },
    { ...f5Total, ev: 0.10, matchup: 'Rockies @ Dodgers', awayTeam: 'Rockies', homeTeam: 'Dodgers' },
    { sport: 'MLB', market: 'Total', side: 'Under 8.5', odds: -110, coverProb: 0.55, ev: 0.04, matchup: 'Cubs @ Mets', awayTeam: 'Cubs', homeTeam: 'Mets' },
  ];
  const picked = omega.selectDiversifiedStraights(pool, 3, 0.03);
  assert.ok(!picked.some(c => c.side === 'Athletics ML'));
  assert.ok(!picked.some(c => c.side === 'Athletics +1.5'));
  assert.ok(!picked.some(c => omega.isF5Candidate(c)));
  assert.ok(picked.some(c => c.side === 'Under 8.5'));
});

check('omega parlay pool drops gated sides including underdog RL', () => {
  const picks = [{ pick: 'Under 8.5', sport: 'MLB', matchup: 'Cubs @ Mets', betType: 'Total', odds: '-110', coverProb: '55%' }];
  const cands = [
    { sport: 'MLB', market: 'Moneyline', side: 'Athletics ML', odds: 145, coverProb: 0.42, ev: 0.09, matchup: 'Athletics @ Yankees' },
    { ...runLineToday },
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
check('both files share RL rejection reason string', () => {
  assert.ok(omegaSrc.includes('underdog RL coverProb < 0.50'));
  assert.ok(alphaSrc.includes('underdog RL coverProb < 0.50'));
  assert.ok(omegaSrc.includes('underdog RL winProb < 0.50'));
  assert.ok(alphaSrc.includes('underdog RL winProb < 0.50'));
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
