'use strict';
// ONE_STRAIGHT_PER_GAME defaults true. Flag off still publishes two sides
// of one game when both edges are in the top N.
const assert = require('assert');
const path = require('path');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { selectStraights } = require('./netlify/functions/lib/omega-vnext/select');
const { applyHardFails } = require('./netlify/functions/lib/omega-vnext/qa_hardfail');

assert.strictEqual(config.ONE_STRAIGHT_PER_GAME, true);

const WHEN = '2026-10-11T20:00:00Z';
const game = 'Denver Broncos @ Los Angeles Chargers';
const lions = 'Detroit Lions @ Arizona Cardinals';
const pats = 'Las Vegas Raiders @ New England Patriots';

function row(matchup, side, edge, extra = {}) {
  const [away, home] = matchup.split(' @ ');
  return {
    sport: 'NFL',
    matchup,
    side,
    market: extra.market || 'Total',
    line: extra.line != null ? extra.line : 45,
    odds: -110,
    coverProb: 0.55,
    ev: extra.ev != null ? extra.ev : 0.05,
    edgePct: edge,
    book: extra.book || 'draftkings',
    commenceTime: WHEN,
    homeTeam: home,
    awayTeam: away,
    tier: extra.tier,
  };
}

const floor = [
  row(game, 'Under 41.5', 0.058, { line: 41.5, book: 'draftkings' }),
  row(game, 'Under 42', 0.057, { line: 42, book: 'betmgm' }),
  row(lions, 'Over 54.5', 0.052, { line: 54.5, book: 'fanduel' }),
  row(pats, 'Under 45', 0.049, { line: 45, book: 'betmgm' }),
];

const leans = [
  row(game, 'Broncos +3', 0.03, { market: 'Spread', line: 3, tier: 'lean', ev: 0.02 }),
  row(pats, 'Under 45', 0.025, { line: 45, tier: 'lean', ev: 0.02 }),
];

try {
  config.ONE_STRAIGHT_PER_GAME = true;
  const on = selectStraights(floor, 3);
  assert.deepStrictEqual(on.map(c => c.side), ['Under 41.5', 'Over 54.5', 'Under 45']);
  assert.strictEqual(new Set(on.map(c => c.matchup)).size, 3);
  assert.ok(on.every(c => c.tier === 'floor'));

  const short = [floor[0], floor[1]];
  const filled = selectStraights(short, 3, leans);
  assert.deepStrictEqual(filled.map(c => c.side), ['Under 41.5']);
  assert.ok(filled.every(c => c.tier === 'floor'));

  const qaOn = applyHardFails([floor[0]], floor, {}, { maxN: 3 });
  assert.strictEqual(qaOn.picks.length, 3);
  assert.ok(qaOn.picks.some(p => p.pick === 'Under 41.5'));
  assert.ok(qaOn.picks.some(p => p.pick === 'Over 54.5'));
  assert.ok(qaOn.picks.some(p => p.pick === 'Under 45'));
  assert.ok(!qaOn.picks.some(p => p.pick === 'Under 42'));

  config.ONE_STRAIGHT_PER_GAME = false;
  const off = selectStraights(floor, 3);
  assert.deepStrictEqual(off.map(c => c.side), ['Under 41.5', 'Under 42', 'Over 54.5']);

  const offFill = selectStraights(short, 3, leans);
  assert.deepStrictEqual(offFill.map(c => c.side), ['Under 41.5', 'Under 42']);
  assert.ok(offFill.every(c => c.tier === 'floor'));

  const qaOff = applyHardFails([floor[0]], floor, {}, { maxN: 3 });
  assert.strictEqual(qaOff.picks.length, 3);
  assert.ok(qaOff.picks.some(p => p.pick === 'Under 42'));
  assert.ok(qaOff.picks.some(p => p.pick === 'Over 54.5'));
} finally {
  config.ONE_STRAIGHT_PER_GAME = true;
}

console.log('PASS test-omega-one-straight-per-game');
