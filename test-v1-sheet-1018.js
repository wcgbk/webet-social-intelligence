'use strict';
const assert = require('assert');
const v1 = require('./v1/model');

assert.strictEqual(v1.VERSION, 'v1-sheet-1018');
assert.strictEqual(v1.GOALS.straights.accuracy, 0.55);
assert.strictEqual(v1.GOALS.straights.roi, 0.15);
assert.strictEqual(v1.GOALS.parlays.accuracy, 0.20);
assert.strictEqual(v1.GOALS.parlays.roi, 0.50);
assert.strictEqual(v1.GOALS.clv.scope, 'All Daily Data');
assert.strictEqual(v1.GOALS.clv.target, 0.02);
assert.strictEqual(v1.GOALS.card.candidates, 10);
assert.strictEqual(v1.GOALS.card.straights, 3);
assert.strictEqual(v1.SEASONS.length, 6);
assert.strictEqual(v1.THRESHOLD_NOTES.length, 10);

for (const example of v1.EXAMPLES) {
  const row = v1.checkBet(example.odds, example.p);
  assert.ok(row, example.note);
  assert.strictEqual(row.edgeDisplay, example.edge, example.note);
  assert.strictEqual(row.evDisplay, example.ev, example.note);
  assert.strictEqual(row.profitDisplay, example.profit, example.note);
  assert.strictEqual(row.band, example.band, example.note);
  assert.strictEqual(row.credibility, example.credibility, example.note);
  assert.strictEqual(row.verdict, example.verdict, example.note);
}

const unicodeMinus = v1.checkBet('−110', 0.55);
assert.strictEqual(unicodeMinus.verdict, 'GOOD BET');
assert.strictEqual(unicodeMinus.edgeDisplay, '2.62');

const below = v1.checkBet(-110, 0.52);
assert.strictEqual(below.verdict, 'NO BET');
assert.strictEqual(below.band, 'BELOW BAND');
assert.strictEqual(below.credibility, 'OK');
assert.strictEqual(below.tests.edge, false);

const exactAudit = v1.checkBet(-110, 0.624);
assert.ok(exactAudit.edgePts > 10);
assert.strictEqual(exactAudit.credibility, 'SUSPECT - AUDIT');
assert.strictEqual(exactAudit.verdict, 'DO NOT BET - AUDIT');

const card = v1.selectCard([
  { pick: 'Jets Under', matchup: 'NYJ @ NE', odds: 122, p: 0.707 },
  { pick: 'Good A', matchup: 'A @ B', odds: -110, p: 0.55 },
  { pick: 'Good A other', matchup: 'A @ B', odds: -110, p: 0.56 },
  { pick: 'Good C', matchup: 'C @ D', odds: -105, p: 0.56 },
  { pick: 'Suspect', matchup: 'E @ F', odds: -109, p: 0.623 },
]);
assert.strictEqual(card.top10.length, 5);
assert.deepStrictEqual(card.straights.map((row) => row.pick), ['Good C', 'Good A other']);
assert.ok(card.straights.every((row) => row.verdict === 'GOOD BET'));
assert.ok(!card.straights.some((row) => row.pick === 'Jets Under' || row.pick === 'Suspect'));

const html = require('fs').readFileSync(require('path').join(__dirname, 'v1/index.html'), 'utf8');
assert.ok(html.includes('noindex, nofollow'));
assert.ok(html.includes('src="model.js"'));
assert.ok(html.includes('V1Sheet'));
assert.ok(html.includes('checkBet'));
assert.ok(html.includes('selectCard'));
assert.ok(!/odds-api|api\.the-odds-api/i.test(html));
assert.ok(!html.includes('Phi('));

console.log('test-v1-sheet-1018 ok');
