'use strict';
// A parlay leg prints the same edge and EV strings as the straight on that bet.
// The straight uses the one-decimal win rate (shownCover − implied). The
// unrounded edge still grades the leg. Cover 0.64749 at -145 is the tenth
// that used to print 5.5% on the straight and 5.6% on the leg.
const assert = require('assert');
const { americanToImplied, americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights } = require('./netlify/functions/lib/omega-vnext/parlay');
const { checkCardIdentity } = require('./netlify/functions/lib/omega-vnext/card_identity');

function candidate(matchup, side, odds, cover) {
  const implied = americanToImplied(odds);
  const dec = americanToDecimal(odds);
  const parts = matchup.split(' @ ');
  return {
    sport: 'NHL',
    matchup,
    side,
    homeTeam: parts[1],
    awayTeam: parts[0],
    market: 'Moneyline',
    odds,
    coverProb: cover,
    edgePct: +((cover - implied).toFixed(6)),
    ev: +((cover * dec - 1).toFixed(6)),
    book: 'draftkings',
    line: null,
  };
}

function assertSamePrintedEdge(raw, picks, ticket) {
  assert.strictEqual(ticket.qualifying, true, ticket.status || ticket.reason);
  assert.strictEqual(ticket.legs.length, raw.length);
  for (const leg of ticket.legs) {
    const pick = picks.find((row) => row.matchup === leg.matchup);
    assert.ok(pick, leg.matchup);
    assert.strictEqual(leg.edge, pick.edge, `${leg.matchup} edge ${leg.edge} vs ${pick.edge}`);
    assert.strictEqual(leg.edgePct, pick.edgePct, `${leg.matchup} edgePct`);
    assert.strictEqual(leg.ev, pick.ev, `${leg.matchup} ev ${leg.ev} vs ${pick.ev}`);
    assert.strictEqual(leg.coverProb, pick.coverProb, `${leg.matchup} cover`);
    const src = raw.find((row) => row.matchup === leg.matchup);
    const unroundedEv = src.coverProb * americanToDecimal(src.odds) - 1;
    // p_cal keeps four decimals, so the priced EV can move by about 0.00002.
    // It must not snap to the printed tenth (9.3% vs 0.094).
    assert.ok(Math.abs(leg.evRaw - unroundedEv) < 2e-4, `${leg.matchup} evRaw ${leg.evRaw} vs ${unroundedEv}`);
    assert.ok(Math.abs(leg.evRaw - parseFloat(leg.ev) / 100) > 2e-4, `${leg.matchup} evRaw snapped to ${leg.ev}`);
  }
}

// Pool candidate keeps the unrounded edge. The published pick is the straight.
// Side ids differ ("Oilers" vs "Oilers ML"), which is how the card merges them.
const specs = [
  ['Penguins @ Avalanche', 'Avalanche', -145, 0.6475],
  ['Ducks @ Bruins', 'Bruins', -125, 0.6208],
  ['Jets @ Oilers', 'Oilers', -145, 0.64749],
];
const raw = specs.map((row) => candidate(...row));
const picks = raw.map((row) => toPickObject(row));

assert.strictEqual(picks[0].edge, '5.6%');
assert.strictEqual(picks[0].coverProb, '64.8%');
assert.strictEqual(picks[1].edge, '6.5%');
assert.strictEqual(picks[1].coverProb, '62.1%');
assert.strictEqual(picks[2].edge, '5.5%');
assert.strictEqual(picks[2].coverProb, '64.7%');

const fromPool = parlayFromStraights(picks, { pool: raw });
assertSamePrintedEdge(raw, picks, fromPool[0]);

const identity = checkCardIdentity({ picks, parlayLegs: fromPool });
const edgeAlerts = (identity.issues || identity || []).filter((row) => /edge|EV/i.test(String(row)));
assert.deepStrictEqual(edgeAlerts, [], JSON.stringify(identity.issues || identity));

// No percent strings on the straights. The leg computes the same one-decimal rule.
const computed = parlayFromStraights(raw);
assertSamePrintedEdge(raw, picks, computed[0]);
assert.strictEqual(computed[0].legs.find((leg) => /Oilers/.test(leg.pick)).edge, '5.5%');
assert.notStrictEqual(
  computed[0].legs.find((leg) => /Oilers/.test(leg.pick)).edge,
  '5.6%',
);
