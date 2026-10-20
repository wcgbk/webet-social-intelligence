'use strict';
/**
 * V1 grades the edge versus de-vigged Pinnacle fair, not raw win probability.
 * Fill prefers EV>0 and labels a negative-EV pad no-edge. No network, no blobs.
 */
const assert = require('assert');
const path = require('path');
const { gradeForV1, gradeEdgeForV1, unitsForGradeV1 } = require('./netlify/functions/lib/v1-lock/config-v1');
const { selectV1, evFor } = require('./netlify/functions/lib/v1-lock/select-v1');

assert.strictEqual(gradeEdgeForV1(0.05), 'A+');
assert.strictEqual(gradeEdgeForV1(0.049), 'A');
assert.strictEqual(gradeEdgeForV1(0.035), 'A');
assert.strictEqual(gradeEdgeForV1(0.02), 'A-');
assert.strictEqual(gradeEdgeForV1(0.019), 'B');
assert.strictEqual(gradeEdgeForV1(0.01), 'B');
assert.strictEqual(gradeEdgeForV1(0.009), null);
assert.strictEqual(gradeEdgeForV1(-0.01), null);
assert.strictEqual(gradeForV1('NFL', 0.05, 'edge'), 'A+');
assert.strictEqual(gradeForV1('NHL', 0.012, 'edge'), 'B');
assert.strictEqual(unitsForGradeV1('B'), 0.5);
assert.strictEqual(unitsForGradeV1('A+'), 1.5);
// Spec §6 win-probability bands stay available for the two-argument form.
assert.strictEqual(gradeForV1('NFL', 0.80), 'A+');
assert.strictEqual(gradeForV1('NFL', 0.59), null);

const full = {
  last5: { home: [1, 2, 3, 4, 5], away: [1, 2, 3, 4, 5] },
  injuries: { home: [], away: [] },
  keyStarter: { homeConfirmed: true, awayConfirmed: true, unknownReplacement: false },
  formulaSpreadHome: 3, formulaTotal: 44, formulaInputs: { method: 'test' },
  confirmedBook: 'Hard Rock Bet', book: 'hardrockbet', commenceTime: '2026-10-20T17:00:00Z',
};

function row(matchup, side, p, odds, extra = {}) {
  const [awayTeam, homeTeam] = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, awayTeam, homeTeam, side,
    trueProbability: p, odds, oddsStr: String(odds),
    market: 'Moneyline', line: null, ...full, ...extra,
  };
}

// Edge vs pinnacle fair, not the 80% win probability. 6pp is A+.
{
  const sel = selectV1([
    row('Away @ Home', 'Home', 0.56, -110, { pPinnacle: 0.50, fairProb: 0.50 }),
  ], []);
  assert.strictEqual(sel.picks.length, 1);
  assert.strictEqual(sel.picks[0].grade, 'A+');
  assert.strictEqual(sel.picks[0].units, '1.5u');
  assert.ok(evFor(0.56, -110) > 0);
  assert.strictEqual(sel.funnel.fallbackFill, 0);
}

// 1.5pp is B at 0.5u. Below 1pp does not qualify.
{
  const b = selectV1([
    row('Away @ Home', 'Home', 0.525, -110, { pPinnacle: 0.51 }),
  ], []);
  assert.ok(Math.abs((0.525 - 0.51) - 0.015) < 1e-12);
  assert.strictEqual(b.picks[0].grade, 'B');
  assert.strictEqual(b.picks[0].rating, 'b');
  assert.strictEqual(b.picks[0].units, '0.5u');
  assert.strictEqual(b.funnel.fallbackFill, 0);

  const thin = selectV1([
    row('Away @ Home', 'Home', 0.515, -110, { pPinnacle: 0.51 }),
  ], []);
  assert.ok((0.515 - 0.51) < 0.01);
  assert.notStrictEqual(thin.picks[0].grade, 'A+');
  assert.strictEqual(thin.picks[0].units, '0.5u');
  assert.strictEqual(thin.picks[0].rating, 'no-edge');
  assert.strictEqual(thin.picks[0].flag, 'no-edge-lean');
}

// 6pp versus fair but EV <= 0 at a short price does not keep an A-family grade.
{
  const chalk = selectV1([
    row('Away @ Home', 'Home', 0.70, -300, { pPinnacle: 0.64 }),
  ], []);
  assert.ok((0.70 - 0.64) >= 0.05);
  assert.ok(evFor(0.70, -300) <= 0);
  assert.strictEqual(chalk.picks.length, 1);
  assert.strictEqual(chalk.picks[0].rating, 'no-edge');
  assert.strictEqual(chalk.picks[0].flag, 'no-edge-lean');
  assert.ok(chalk.picks[0].filterFlags.includes('no-edge-lean'));
  assert.strictEqual(chalk.picks[0].units, '0.5u');
  assert.ok(/no-edge/i.test(chalk.picks[0].coreReasoning));
  assert.notStrictEqual(chalk.picks[0].grade, 'A+');
  assert.notStrictEqual(chalk.picks[0].grade, 'A');
}

// Fallback where p == fair grades the price edge, not a zero model-vs-fair gap.
{
  const fair = 0.55;
  const plus = row('Away Ice @ Home Ice', 'Home Ice', fair, 110, {
    sport: 'NHL', fallback: true, fairProb: fair, edge: fair - (100 / 210),
    formulaInputs: { method: 'pinnacle-fair-devig' },
    last5: null, injuries: null, keyStarter: null,
  });
  assert.ok(plus.edge > 0.05);
  assert.ok(evFor(fair, 110) > 0);
  const kept = selectV1([plus], []);
  assert.strictEqual(kept.picks[0].grade, 'A+');
  assert.strictEqual(kept.picks[0].units, '1.5u');
  assert.strictEqual(kept.funnel.fallbackFill, 0);
}

// Fewer than 3 EV-positive games: pad with the least-negative EV as no-edge.
// Parlay legs follow the same rows.
{
  const games = [
    row('A @ B', 'B', 0.56, -110, { pPinnacle: 0.51 }),
    row('C @ D', 'D', 0.54, -110, { pPinnacle: 0.51 }),
    row('E @ F', 'F', 0.48, -110, { pPinnacle: 0.52 }),
    row('G @ H', 'H', 0.40, -110, { pPinnacle: 0.55 }),
  ];
  const sel = selectV1(games, []);
  assert.strictEqual(sel.picks.length, 3);
  assert.strictEqual(sel.parlayLegs.length, 1);
  assert.strictEqual(sel.parlayLegs[0].legs.length, 3);
  const noEdge = sel.picks.filter(p => p.rating === 'no-edge');
  assert.strictEqual(noEdge.length, 1);
  assert.strictEqual(noEdge[0].matchup, 'E @ F', 'least-negative EV, not the worse dog');
  assert.strictEqual(noEdge[0].flag, 'no-edge-lean');
  assert.strictEqual(noEdge[0].units, '0.5u');
  assert.ok(/no-edge/i.test(noEdge[0].coreReasoning));
  assert.ok(noEdge[0].filterFlags.includes('no-edge-lean'));
  const leg = sel.parlayLegs[0].legs.find(l => l.matchup === 'E @ F');
  assert.strictEqual(leg.rating, 'no-edge');
  assert.strictEqual(leg.flag, 'no-edge-lean');
  assert.strictEqual(leg.units, '0.5u');
  assert.ok(sel.picks.filter(p => p.rating !== 'no-edge').every(p => parseFloat(p.ev) > 0));
  assert.ok(!sel.picks.some(p => p.matchup === 'G @ H'));
}

console.log('PASS test-v1-edge-1020');
