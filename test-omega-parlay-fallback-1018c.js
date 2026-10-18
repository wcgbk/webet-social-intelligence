'use strict';
// Parlay fallback. Legs are the day's top 10 by anchored stake EV, one game
// each. A real ticket needs model EV after the 0.95^(n-1) haircut > 0 and
// EV at fair > 0. A 3-leg that passes both beats every 2-leg. Otherwise the
// best 2-leg that passes both. If neither does, the best 2-leg is a 0.25u lean.
const assert = require('assert');
const { applyDailyUnitCap } = require('./netlify/functions/lib/omega-vnext/select');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { stakeDollars } = require('./netlify/functions/lib/omega-vnext/odds_math');
const {
  comboStats, parlayFromStraights, ticketFromLegs, isNoQualifyingParlay,
  FAIR_LEAN_LABEL, MODEL_LEAN_LABEL,
} = require('./netlify/functions/lib/omega-vnext/parlay');

const FAIR = FAIR_LEAN_LABEL;
const MODEL = MODEL_LEAN_LABEL;

function leg(id, extra) {
  const away = `A${id}`;
  const home = `B${id}`;
  return {
    sport: 'NFL',
    matchup: `${away} @ ${home}`,
    side: home,
    market: 'Moneyline',
    odds: -110,
    coverProb: 0.56,
    edgePct: 0.04,
    tier: 'floor',
    rating: 'a',
    book: 'draftkings',
    homeTeam: home,
    awayTeam: away,
    ...extra,
  };
}

function names(ticket) {
  return (ticket.legs || []).map((row) => row.matchup).sort();
}

function decAmerican(odds) {
  return odds < 0 ? 1 + 100 / Math.abs(odds) : 1 + odds / 100;
}

// --- ticketFromLegs: both sizes, three EV cases. The selector is not involved. ---
{
  const both = [1, 2, 3].map((id) => leg(id, { p_fair: 0.53, coverProb: 0.56 }));
  const three = ticketFromLegs(both, both, {})[0];
  const st3 = comboStats(both);
  assert.ok(st3.ev > 0 && st3.evAtFair > 0);
  assert.strictEqual(three.qualifying, true);
  assert.strictEqual(three.isLean, false);
  assert.strictEqual(three.units, '0.5u');
  assert.strictEqual(three.type, '3-leg-parlay');
  assert.ok(three.label == null);
  assert.ok(Math.abs(three.evRaw - st3.ev) < 1e-12);

  const two = ticketFromLegs(both.slice(0, 2), both.slice(0, 2), {})[0];
  const st2 = comboStats(both.slice(0, 2));
  assert.ok(st2.ev > 0 && st2.evAtFair > 0);
  assert.strictEqual(two.isLean, false);
  assert.strictEqual(two.units, '0.5u');
  assert.strictEqual(two.type, '2-leg-parlay');
  assert.strictEqual(two.legs.length, 2);
}

{
  const fairNeg = [1, 2, 3].map((id) => leg(id, { p_fair: 0.45, coverProb: 0.56 }));
  const st = comboStats(fairNeg);
  assert.ok(st.ev > 0 && st.evAtFair <= 0);
  const three = ticketFromLegs(fairNeg, fairNeg, {})[0];
  assert.strictEqual(three.isLean, true);
  assert.strictEqual(three.units, '0.25u');
  assert.strictEqual(three.label, FAIR);
  assert.strictEqual(three.type, '3-leg-parlay-labeled');
  assert.strictEqual(three.riskDollars, stakeDollars(0.25));
  const pair = ticketFromLegs(fairNeg.slice(0, 2), fairNeg.slice(0, 2), {})[0];
  assert.ok(comboStats(fairNeg.slice(0, 2)).evAtFair <= 0);
  assert.strictEqual(pair.isLean, true);
  assert.strictEqual(pair.units, '0.25u');
  assert.strictEqual(pair.label, FAIR);
  assert.strictEqual(pair.type, '2-leg-parlay-labeled');
}

{
  const modelNeg = [1, 2, 3].map((id) => leg(id, { p_fair: 0.56, coverProb: 0.52 }));
  const st3 = comboStats(modelNeg);
  const st2 = comboStats(modelNeg.slice(0, 2));
  assert.ok(!(st3.ev > 0) && st3.evAtFair > 0);
  assert.ok(!(st2.ev > 0) && st2.evAtFair > 0);
  const three = ticketFromLegs(modelNeg, modelNeg, {})[0];
  assert.strictEqual(three.isLean, true);
  assert.strictEqual(three.units, '0.25u');
  assert.strictEqual(three.label, MODEL);
  assert.strictEqual(three.type, '3-leg-parlay-labeled');
  const pair = ticketFromLegs(modelNeg.slice(0, 2), modelNeg.slice(0, 2), {})[0];
  assert.strictEqual(pair.isLean, true);
  assert.strictEqual(pair.label, MODEL);
  assert.strictEqual(pair.type, '2-leg-parlay-labeled');
  assert.strictEqual(pair.units, '0.25u');
}

// Selector: fair <= 0 on every trio falls back to a 2-leg lean, not a 3-leg ticket.
{
  const fairNeg = [1, 2, 3].map((id) => leg(id, { p_fair: 0.45, coverProb: 0.56 }));
  const ticket = parlayFromStraights(fairNeg)[0];
  assert.strictEqual(ticket.legs.length, 2);
  assert.strictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.label, FAIR);
  assert.strictEqual(ticket.units, '0.25u');
  assert.strictEqual(ticket.type, '2-leg-parlay-labeled');
}

// Selector: model haircut <= 0 falls back to a 2-leg lean with the model label.
// 0.52 at -110 is negative bet-price EV, so it never reaches the board.
// 0.53 is positive on the straight (~+1.2%) and still negative after 0.95^(n-1).
{
  const modelNeg = [1, 2, 3].map((id) => leg(id, { p_fair: 0.56, coverProb: 0.53 }));
  const st2 = comboStats(modelNeg.slice(0, 2));
  assert.ok(modelNeg[0].coverProb * decAmerican(-110) - 1 > 0);
  assert.ok(!(st2.ev > 0) && st2.evAtFair > 0);
  const ticket = parlayFromStraights(modelNeg)[0];
  assert.strictEqual(ticket.legs.length, 2);
  assert.strictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.label, MODEL);
  assert.strictEqual(ticket.units, '0.25u');
  assert.notStrictEqual(ticket.type, '3-leg-parlay');
}

// Only two qualifying straights: a 2-leg, including when that is the whole card.
{
  const pair = [1, 2].map((id) => leg(id, { p_fair: 0.54, coverProb: 0.57 }));
  const ticket = parlayFromStraights(pair)[0];
  assert.strictEqual(ticket.type, '2-leg-parlay');
  assert.strictEqual(ticket.legs.length, 2);
  assert.notStrictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.units, '0.5u');
  assert.ok(ticket.evRaw > 0);
}

// Two straights that fail fair are a lean, not a forced real 2-leg.
{
  const pair = [1, 2].map((id) => leg(id, { p_fair: 0.40, coverProb: 0.57 }));
  assert.ok(comboStats(pair).ev > 0 && comboStats(pair).evAtFair <= 0);
  const ticket = parlayFromStraights(pair)[0];
  assert.strictEqual(ticket.type, '2-leg-parlay-labeled');
  assert.strictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.label, FAIR);
  assert.strictEqual(ticket.units, '0.25u');
}

// Legs come from the top 10, past the published straights. The outsider
// with the higher stake EV replaces the weakest straight.
{
  const straights = [
    leg('A', { coverProb: 0.55, p_fair: 0.53, ev: 0.55 * decAmerican(-110) - 1 }),
    leg('B', { coverProb: 0.56, p_fair: 0.53, ev: 0.56 * decAmerican(-110) - 1 }),
    leg('C', { coverProb: 0.545, p_fair: 0.53, ev: 0.545 * decAmerican(-110) - 1 }),
  ];
  const outsider = leg('D', { coverProb: 0.575, p_fair: 0.53, ev: 0.575 * decAmerican(-110) - 1 });
  const ticket = parlayFromStraights(straights, { pool: [outsider] })[0];
  assert.strictEqual(ticket.type, '3-leg-parlay');
  assert.strictEqual(ticket.legs.length, 3);
  assert.notStrictEqual(ticket.isLean, true);
  assert.ok(names(ticket).includes('AD @ BD'));
  assert.ok(!names(ticket).includes('AC @ BC'));
  const straightOnly = comboStats(straights);
  assert.ok(ticket.evRaw > straightOnly.ev);
}

// One leg per game. The higher stake-EV side is the leg.
{
  // 0.58 at -110 is about +10.7% and is ev-stale. 0.575 stays under the 10% cap.
  const home = leg('G', { side: 'Home', coverProb: 0.575, p_fair: 0.54, ev: 0.575 * decAmerican(-110) - 1 });
  const away = leg('G', { side: 'Away', coverProb: 0.54, p_fair: 0.52, ev: 0.54 * decAmerican(-110) - 1 });
  const other = leg('H', { coverProb: 0.56, p_fair: 0.54, ev: 0.56 * decAmerican(-110) - 1 });
  const ticket = parlayFromStraights([home], { pool: [away, other] })[0];
  assert.strictEqual(ticket.legs.length, 2);
  assert.strictEqual(new Set(ticket.legs.map((row) => row.matchup)).size, 2);
  assert.ok(ticket.legs.some((row) => row.pick === 'Home ML'));
  assert.ok(!ticket.legs.some((row) => row.pick === 'Away ML'));
}

// Fewer than 2 eligible legs: no parlay, with an explicit reason.
{
  const one = parlayFromStraights([leg(1, { p_fair: 0.54 })])[0];
  assert.ok(isNoQualifyingParlay(one));
  assert.strictEqual(one.qualifying, false);
  assert.strictEqual(one.units, null);
  assert.ok(/fewer than 2/.test(one.reason));
  const none = parlayFromStraights([
    leg(1, { coverProb: 0.40, ev: -0.2 }),
    leg(2, { coverProb: 0.40, ev: -0.2 }),
  ])[0];
  assert.ok(isNoQualifyingParlay(none));
  assert.ok(/fewer than 2/.test(none.reason));
  const pub = publicPicksPayload({ picks: [], parlayLegs: [none] });
  assert.strictEqual(pub.parlayLegs[0].reason, none.reason);
  assert.ok(/fewer than 2/.test(pub.parlayLegs[0].reason));
}

// Profit: a passing 3-leg beats a 2-leg with a higher model EV.
{
  const rows = [1, 2, 3].map((id) => leg(id, { coverProb: 0.55, p_fair: 0.53 }));
  const ticket = parlayFromStraights(rows)[0];
  const three = comboStats(rows);
  const two = comboStats(rows.slice(0, 2));
  assert.ok(two.ev > three.ev, `2-leg ${two.ev} should beat 3-leg ${three.ev} on raw EV`);
  assert.ok(three.ev > 0 && three.evAtFair > 0);
  assert.strictEqual(ticket.legs.length, 3);
  assert.strictEqual(ticket.type, '3-leg-parlay');
  assert.ok(Math.abs(ticket.evRaw - three.ev) < 1e-9);
}

// Profit under the fair constraint: the max-EV pair fails fair. The pair that
// passes both is the ticket, not the higher model-EV pair and not a 3-leg.
{
  const a = leg('A', { coverProb: 0.57, p_fair: 0.54, ev: 0.57 * decAmerican(-110) - 1 });
  const b = leg('B', { coverProb: 0.57, p_fair: 0.54, ev: 0.57 * decAmerican(-110) - 1 });
  const c = leg('C', { coverProb: 0.575, p_fair: 0.40, ev: 0.575 * decAmerican(-110) - 1 });
  assert.ok(comboStats([a, c]).ev > comboStats([a, b]).ev);
  assert.ok(!(comboStats([a, b, c]).evAtFair > 0));
  assert.ok(!(comboStats([a, c]).evAtFair > 0));
  assert.ok(comboStats([a, b]).ev > 0 && comboStats([a, b]).evAtFair > 0);
  const ticket = parlayFromStraights([a, b, c])[0];
  assert.strictEqual(ticket.type, '2-leg-parlay');
  assert.strictEqual(ticket.isLean, false);
  assert.deepStrictEqual(names(ticket), ['AA @ BA', 'AB @ BB']);
  assert.ok(!names(ticket).includes('AC @ BC'));
}

// Top 10 only. Legs 11 and 12 would be the only real ticket, and they are
// outside the ranked board, so the card is a lean from the top 10.
{
  const board = [];
  for (let i = 0; i < 10; i++) {
    const cover = 0.575;
    board.push(leg(`H${i}`, {
      coverProb: cover,
      p_fair: 0.42,
      ev: cover * decAmerican(-110) - 1,
    }));
  }
  const cover = 0.56;
  const tail = [11, 12].map((id) => leg(`T${id}`, {
    coverProb: cover,
    p_fair: 0.54,
    ev: cover * decAmerican(-110) - 1,
  }));
  assert.ok(board[0].ev > tail[0].ev);
  assert.ok(comboStats(tail).ev > 0 && comboStats(tail).evAtFair > 0);
  assert.ok(!(comboStats(board.slice(0, 2)).evAtFair > 0));
  const ticket = parlayFromStraights(board.slice(0, 3), { pool: board.concat(tail) })[0];
  assert.strictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.label, FAIR);
  assert.strictEqual(ticket.legs.length, 2);
  assert.ok(!names(ticket).some((name) => /T11|T12/.test(name)));
}

// Soft fair is not available. A positive p_fair does not make a real ticket.
{
  const rows = [1, 2, 3].map((id) => leg(id, { coverProb: 0.57, p_fair: 0.55, fairSoft: true }));
  assert.strictEqual(comboStats(rows).evAtFair, null);
  assert.ok(comboStats(rows).ev > 0);
  const ticket = parlayFromStraights(rows)[0];
  assert.strictEqual(ticket.isLean, true);
  assert.strictEqual(ticket.label, FAIR);
  assert.strictEqual(ticket.units, '0.25u');
  assert.strictEqual(ticket.evAtFair, null);
  assert.strictEqual(ticket.type, '2-leg-parlay-labeled');
  const pub = publicPicksPayload({ picks: [], parlayLegs: [ticket] });
  assert.strictEqual(pub.parlayLegs[0].isLean, true);
  assert.strictEqual(pub.parlayLegs[0].label, FAIR);
  assert.strictEqual(pub.parlayLegs[0].units, '0.25u');
}

// evAtFairValid false on one leg drops that leg. The other two can still be real.
{
  const a = leg('A', { coverProb: 0.57, p_fair: 0.54 });
  const b = leg('B', { coverProb: 0.57, p_fair: 0.54 });
  const c = leg('C', { coverProb: 0.57, p_fair: 0.54, evAtFairValid: false });
  const ticket = parlayFromStraights([a, b, c])[0];
  assert.strictEqual(ticket.type, '2-leg-parlay');
  assert.notStrictEqual(ticket.isLean, true);
  assert.deepStrictEqual(names(ticket), ['AA @ BA', 'AB @ BB']);
}

// Missing fairSoft / evAtFairValid means the fair is valid. A missing p_fair
// is not treated as a negative fair EV.
{
  const rows = [1, 2, 3].map((id) => leg(id, { coverProb: 0.56 }));
  const ticket = parlayFromStraights(rows)[0];
  assert.strictEqual(ticket.type, '3-leg-parlay');
  assert.strictEqual(ticket.isLean, undefined);
  assert.strictEqual(ticket.units, '0.5u');
  assert.ok(ticket.evRaw > 0);
}

// +300 / -300 and EV above 10% are not legs. +250 with a normal price is.
{
  const long = [
    leg(1, { odds: 300, coverProb: 0.40 }),
    leg(2, { odds: -300, coverProb: 0.80 }),
  ];
  assert.ok(isNoQualifyingParlay(parlayFromStraights(long)[0]));
  const stale = [1, 2].map((id) => leg(id, { coverProb: 0.60 }));
  assert.ok(stale[0].coverProb * decAmerican(-110) - 1 > 0.10);
  assert.ok(isNoQualifyingParlay(parlayFromStraights(stale)[0]));
  const live = [
    leg(1, { live: true, coverProb: 0.57, p_fair: 0.54 }),
    leg(2, { inPlay: true, coverProb: 0.57, p_fair: 0.54 }),
    leg(3, { coverProb: 0.57, p_fair: 0.54 }),
  ];
  assert.ok(isNoQualifyingParlay(parlayFromStraights(live)[0]));
  const edge = [
    leg('P', { odds: 250, coverProb: 0.30, p_fair: 0.29, ev: 0.30 * decAmerican(250) - 1 }),
    leg('Q', { odds: -110, coverProb: 0.56, p_fair: 0.53, ev: 0.56 * decAmerican(-110) - 1 }),
  ];
  const kept = parlayFromStraights(edge)[0];
  assert.strictEqual(kept.type, '2-leg-parlay');
  assert.strictEqual(kept.legs.length, 2);
  assert.notStrictEqual(kept.isLean, true);
}

// Card stake: a lean stays 0.25u. The label alone is enough if isLean was dropped.
{
  const fairNeg = [1, 2, 3].map((id) => leg(id, { p_fair: 0.45, coverProb: 0.56 }));
  const ticket = parlayFromStraights(fairNeg)[0];
  const held = applyDailyUnitCap(
    [{ pick: 'A-', rating: 'aminus', qualityGrade: 'aminus', tier: 'floor', units: '1.5u', edgePct: '3%' }],
    [ticket],
  );
  assert.strictEqual(held.parlayLegs[0].units, '0.25u');
  assert.strictEqual(held.parlayLegs[0].isLean, true);
  const labelOnly = applyDailyUnitCap(
    [{ pick: 'A-', rating: 'aminus', qualityGrade: 'aminus', tier: 'floor', units: '1.5u', edgePct: '3%' }],
    [{ units: '0.5u', qualifying: true, type: '2-leg-parlay', label: MODEL, legs: [], combinedOdds: '+150' }],
  );
  assert.strictEqual(labelOnly.parlayLegs[0].units, '0.25u');
}

console.log('test-omega-parlay-fallback-1018c ok');
