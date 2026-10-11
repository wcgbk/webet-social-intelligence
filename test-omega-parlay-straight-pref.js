'use strict';
// The parlay builder does not prefer the published straights.
// It keeps the best edge on each game, then the positive-EV combo with the
// best edge tuple. The straights argument only labels a mirror ticket.
//
// When the top straights are on distinct games and each cover is >= 45%,
// the ticket matches them only if no other parlay-eligible side outranks
// the third straight. A higher edge on another game replaces that straight.
//
// Not implemented, on purpose: if three published straights are on distinct
// games, each coverProb >= 0.45, and their combined EV is > 0, return those
// three legs before bestPositiveCombo. That would be the straight preference.
const assert = require('assert');
const path = require('path');
const { optimizeParlay } = require(path.join(__dirname, 'netlify/functions/lib/omega-vnext/parlay'));

const DAY = '2026-10-11';
const WHEN = '2026-10-11T20:00:00Z';

function row(matchup, side, edge, cover = 0.55, ev = 0.05) {
  const [away, home] = matchup.split(' @ ');
  return {
    sport: 'NFL', matchup, side, market: 'Total', line: 45,
    odds: -110, coverProb: cover, ev, edgePct: edge, liquid: true,
    commenceTime: WHEN, homeTeam: home, awayTeam: away,
  };
}

function straightPick(c) {
  return { pick: c.side, matchup: c.matchup, sport: c.sport, coverProb: '55%', edgePct: '4.0%' };
}

function names(card) {
  return card[0].legs.map(l => `${l.pick} @ ${l.matchup}`).sort();
}

// Three distinct-game straights clear 45% cover. A fourth game has an edge
// between the second and third straight, so the edge tuple drops the third.
{
  const s1 = row('A @ B', 'Under 41.5', 0.06);
  const s2 = row('C @ D', 'Over 48.5', 0.05);
  const s3 = row('E @ F', 'Under 44', 0.03);
  const outsider = row('G @ H', 'Under 45', 0.04);
  const straights = [s1, s2, s3].map(straightPick);
  const card = optimizeParlay([s1, s2, s3, outsider], straights, { cardDate: DAY });
  assert.strictEqual(card.length, 1);
  assert.strictEqual(card[0].legs.length, 3);
  assert.ok(parseFloat(card[0].ev) > 0, card[0].ev);
  assert.deepStrictEqual(names(card), [
    'Over 48.5 @ C @ D',
    'Under 41.5 @ A @ B',
    'Under 45 @ G @ H',
  ].sort());
  assert.ok(!card[0].legs.some(l => l.pick === 'Under 44'));
  assert.strictEqual(card[0].independent, true);
  assert.ok(card[0].type.includes('optimized'));
}

// Same pool with no outsider: the three straights are the top edges, so the
// ticket matches them. That match is a consequence of the edge sort.
{
  const s1 = row('A @ B', 'Under 41.5', 0.06);
  const s2 = row('C @ D', 'Over 48.5', 0.05);
  const s3 = row('E @ F', 'Under 44', 0.03);
  const straights = [s1, s2, s3].map(straightPick);
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

// Two top edges from one game cannot both be legs. The parlay keeps the
// higher edge and fills from other games. It does not reserve a slot for
// each straight.
{
  const same1 = row('A @ B', 'Under 41.5', 0.058);
  const same2 = row('A @ B', 'Under 42', 0.057);
  const s3 = row('C @ D', 'Over 54.5', 0.052);
  const next = row('E @ F', 'Under 45', 0.049);
  const straights = [same1, same2, s3].map(straightPick);
  const card = optimizeParlay([same1, same2, s3, next], straights, { cardDate: DAY });
  assert.strictEqual(card[0].legs.length, 3);
  assert.ok(card[0].legs.some(l => l.pick === 'Under 41.5'));
  assert.ok(!card[0].legs.some(l => l.pick === 'Under 42'));
  assert.ok(card[0].legs.some(l => l.pick === 'Under 45'));
  assert.strictEqual(new Set(card[0].legs.map(l => l.matchup)).size, 3);
}

console.log('PASS test-omega-parlay-straight-pref');
