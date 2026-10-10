'use strict';
// Doubleheader halves are distinct games. One game still contributes one straight.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { matchupKey, selectStraights, scoreCandidate, MAX_STRAIGHTS } = (() => {
  const select = require(path.join(root, 'select'));
  const config = require(path.join(root, 'config'));
  return { ...select, MAX_STRAIGHTS: config.MAX_STRAIGHTS };
})();
const { comboStats } = require(path.join(root, 'parlay'));

assert.strictEqual(MAX_STRAIGHTS, 3);

const day = '2026-09-25T20:05:00Z';
const night = '2026-09-25T23:06:00Z';
const name = 'Baltimore Orioles @ New York Yankees';

assert.notStrictEqual(
  matchupKey({ matchup: name, commenceTime: day }),
  matchupKey({ matchup: name, commenceTime: night })
);
assert.strictEqual(
  matchupKey({ matchup: name, commenceTime: day, market: 'Total' }),
  matchupKey({ matchup: name, commenceTime: day, market: 'Moneyline' })
);
assert.strictEqual(
  matchupKey({ matchup: name }),
  matchupKey({ matchup: name, market: 'Spread' })
);
assert.ok(!matchupKey({ matchup: name }).includes('|'));

function leg(commence, edge, market, sport) {
  return {
    sport: sport || 'MLB',
    matchup: name,
    market: market || 'Total',
    side: market === 'Moneyline' ? 'New York Yankees' : 'Over 8.5',
    line: market === 'Moneyline' ? null : 8.5,
    commenceTime: commence,
    edgePct: edge,
    ev: edge,
    uncertainty: 0.18,
    coverProb: 0.55,
    odds: -110,
    homeTeam: 'New York Yankees',
    awayTeam: 'Baltimore Orioles',
  };
}

const picked = selectStraights([
  leg(day, 0.09, 'Total'),
  leg(day, 0.08, 'Moneyline'),
  leg(night, 0.07, 'Total'),
  leg('2026-09-25T23:40:00Z', 0.06, 'Total', 'MLB'),
  { ...leg('2026-09-26T23:00:00Z', 0.05, 'Total'), matchup: 'Boston Red Sox @ Tampa Bay Rays', homeTeam: 'Tampa Bay Rays', awayTeam: 'Boston Red Sox' },
]);
assert.strictEqual(picked.length, 3, 'max 3 straights');
const keys = picked.map(matchupKey);
assert.strictEqual(new Set(keys).size, 3);
assert.ok(keys.some((k) => k.endsWith(day)));
assert.ok(keys.some((k) => k.endsWith(night)));
assert.ok(!picked.some((p) => p.market === 'Moneyline'), 'second market of the day game stays off');

const onlyHalves = selectStraights([
  leg(day, 0.04, 'Total'),
  leg(day, 0.03, 'Spread'),
  leg(night, 0.02, 'Total'),
]);
assert.strictEqual(onlyHalves.length, 2);

const undated = selectStraights([
  { ...leg('', 0.05, 'Total'), commenceTime: '' },
  { ...leg('', 0.04, 'Moneyline'), commenceTime: '' },
]);
assert.strictEqual(undated.length, 1);

assert.strictEqual(comboStats([
  { ...leg(day, 0.04), odds: -110, coverProb: 0.55 },
  { ...leg(night, 0.04), odds: -110, coverProb: 0.55 },
]).uniqueGames, 2);
assert.strictEqual(comboStats([
  { ...leg(day, 0.04, 'Total'), odds: -110, coverProb: 0.55 },
  { ...leg(day, 0.04, 'Moneyline'), odds: -110, coverProb: 0.55 },
]).uniqueGames, 1);

// Steam nudge stays in the initial sort. The removed post-hoc sport bonus
// must not lift the second sport above a higher initial score.
const nfl = { ...leg(day, 0.05, 'Total', 'NFL'), matchup: 'Buffalo Bills @ Kansas City Chiefs', steamToward: true, ev: 0.05 };
const mlbLeg = { ...leg(night, 0.06, 'Total', 'MLB'), steamToward: false };
const ordered = selectStraights([mlbLeg, nfl]);
assert.strictEqual(ordered[0].sport, 'NFL');
assert.ok(scoreCandidate(nfl) > scoreCandidate(mlbLeg));
assert.deepStrictEqual(ordered.map((p) => p.sport), ['NFL', 'MLB']);

console.log('PASS test-omega-matchup-key');
