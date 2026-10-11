'use strict';
// When the three published straights are on distinct games, each cover is
// >= 45%, and their combined EV is positive, the parlay is those straights.
// A higher edge on another game does not replace the third straight.
// Otherwise the builder keeps the current search: best edge per game, then
// the positive-EV 3-leg, then the best positive-EV 2-leg.
const assert = require('assert');
const path = require('path');
const { optimizeParlay } = require(path.join(__dirname, 'netlify/functions/lib/omega-vnext/parlay'));

const DAY = '2026-10-11';
const WHEN = '2026-10-11T20:00:00Z';

function row(matchup, side, edge, cover = 0.55, ev = 0.05, extra = {}) {
  const [away, home] = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, side, market: extra.market || 'Total', line: extra.line != null ? extra.line : 45,
    odds: extra.odds != null ? extra.odds : -110, coverProb: cover, ev, edgePct: edge, liquid: true,
    commenceTime: WHEN, homeTeam: home, awayTeam: away, book: extra.book || 'draftkings',
  };
}

function straightPick(c, extra = {}) {
  return {
    pick: c.side,
    matchup: c.matchup,
    sport: c.sport,
    coverProb: '55%',
    edgePct: '4.0%',
    book: extra.book != null ? extra.book : c.book,
    line: extra.line != null ? extra.line : c.line,
  };
}

function names(card) {
  return card[0].legs.map(l => `${l.pick} @ ${l.matchup}`).sort();
}

// Prefer branch: three distinct-game straights clear 45% cover and the
// combo is +EV. A fourth game sits between the second and third edge.
{
  const s1 = row('A @ B', 'Under 41.5', 0.06);
  const s2 = row('C @ D', 'Over 48.5', 0.05);
  const s3 = row('E @ F', 'Under 44', 0.03);
  const outsider = row('G @ H', 'Under 45', 0.04);
  const straights = [s1, s2, s3].map(c => straightPick(c));
  const card = optimizeParlay([s1, s2, s3, outsider], straights, { cardDate: DAY });
  assert.strictEqual(card.length, 1);
  assert.strictEqual(card[0].legs.length, 3);
  assert.ok(parseFloat(card[0].ev) > 0, card[0].ev);
  assert.deepStrictEqual(names(card), [
    'Over 48.5 @ C @ D',
    'Under 41.5 @ A @ B',
    'Under 44 @ E @ F',
  ].sort());
  assert.ok(!card[0].legs.some(l => l.pick === 'Under 45'));
  assert.strictEqual(card[0].independent, false);
  assert.ok(card[0].type.includes('straight'));
}

// The same three straights with no outsider are still the ticket.
{
  const s1 = row('A @ B', 'Under 41.5', 0.06);
  const s2 = row('C @ D', 'Over 48.5', 0.05);
  const s3 = row('E @ F', 'Under 44', 0.03);
  const straights = [s1, s2, s3].map(c => straightPick(c));
  const card = optimizeParlay([s1, s2, s3], straights, { cardDate: DAY });
  assert.strictEqual(card[0].legs.length, 3);
  assert.deepStrictEqual(names(card), [
    'Over 48.5 @ C @ D',
    'Under 41.5 @ A @ B',
    'Under 44 @ E @ F',
  ].sort());
  assert.strictEqual(card[0].independent, false);
  assert.ok(card[0].type.includes('straight'));
}

// The published straight's own book wins when two pool rows share the side.
{
  const dk = row('A @ B', 'Under 41.5', 0.04, 0.55, 0.05, { book: 'draftkings', odds: -105, line: 41.5 });
  const mgm = row('A @ B', 'Under 41.5', 0.09, 0.55, 0.05, { book: 'betmgm', odds: -110, line: 41.5 });
  const s2 = row('C @ D', 'Over 48.5', 0.05);
  const s3 = row('E @ F', 'Under 44', 0.03);
  const straights = [straightPick(dk), straightPick(s2), straightPick(s3)];
  const card = optimizeParlay([mgm, dk, s2, s3], straights, { cardDate: DAY });
  const leg = card[0].legs.find(l => l.pick === 'Under 41.5');
  assert.ok(leg, 'straight leg present');
  assert.strictEqual(leg.odds, '-105');
  assert.strictEqual(card[0].independent, false);
}

// Fallback: two straights share a game, so the preference does not fire.
// The search keeps the higher edge and fills from other games.
{
  const same1 = row('A @ B', 'Under 41.5', 0.058);
  const same2 = row('A @ B', 'Under 42', 0.057);
  const s3 = row('C @ D', 'Over 54.5', 0.052);
  const next = row('E @ F', 'Under 45', 0.049);
  const straights = [same1, same2, s3].map(c => straightPick(c));
  const card = optimizeParlay([same1, same2, s3, next], straights, { cardDate: DAY });
  assert.strictEqual(card[0].legs.length, 3);
  assert.ok(card[0].legs.some(l => l.pick === 'Under 41.5'));
  assert.ok(!card[0].legs.some(l => l.pick === 'Under 42'));
  assert.ok(card[0].legs.some(l => l.pick === 'Under 45'));
  assert.strictEqual(new Set(card[0].legs.map(l => l.matchup)).size, 3);
  assert.strictEqual(card[0].independent, true);
  assert.ok(card[0].type.includes('optimized'));
}

// Fallback: three distinct straights whose combined EV is not positive
// (same-direction total haircut). The search publishes the +EV 2-leg.
{
  // Stake EV clears the 3% floor. The same-direction haircut is what makes the 3-leg combo non-positive.
  const cover = 0.538;
  const s1 = row('A @ B', 'Under 41.5', 0.06, cover, 0.04);
  const s2 = row('C @ D', 'Under 48.5', 0.05, cover, 0.04);
  const s3 = row('E @ F', 'Under 44', 0.04, cover, 0.04);
  const straights = [s1, s2, s3].map(c => straightPick(c));
  const card = optimizeParlay([s1, s2, s3], straights, { cardDate: DAY });
  assert.strictEqual(card.length, 1);
  assert.strictEqual(card[0].legs.length, 2);
  assert.ok(parseFloat(card[0].ev) > 0, card[0].ev);
  assert.ok(card[0].legs.some(l => l.pick === 'Under 41.5'));
  assert.ok(card[0].legs.some(l => l.pick === 'Under 48.5'));
  assert.ok(!card[0].legs.some(l => l.pick === 'Under 44'));
}

console.log('PASS test-omega-parlay-straight-pref');
