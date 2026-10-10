'use strict';
// Spec: top edges are the straights, parlay legs are distinct games, a card
// with candidates is not empty. Also runs on the 2026-10-10 yes pool when present.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { selectStraights, edgeRank, matchupKey } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));

function idOf(c) {
  return [c.matchup, c.market, c.side, c.line, c.book, c.odds].join('|');
}

function assertSpecCard(pool, cardDate, label) {
  const straights = selectStraights(pool, 3);
  if (pool.length) {
    assert.ok(straights.length > 0, `${label}: card empty with ${pool.length} candidates`);
  }
  if (!straights.length) return { straights, parlay: [] };
  const minEdge = Math.min(...straights.map(edgeRank));
  const straightIds = new Set(straights.map(idOf));
  for (const c of pool) {
    if (edgeRank(c) > minEdge + 1e-9) {
      assert.ok(straightIds.has(idOf(c)), `${label}: higher edge is not a straight ${c.side} ${c.matchup} ${c.edgePct}`);
    }
  }
  const parlay = optimizeParlay(pool, straights, { cardDate });
  if (parlay.length) {
    const keys = parlay[0].legs.map(matchupKey);
    assert.strictEqual(new Set(keys).size, keys.length, `${label}: parlay legs share a game`);
    assert.ok(parlay[0].legs.length >= 2 && parlay[0].legs.length <= 3);
  }
  return { straights, parlay };
}

const future = '2026-10-10T20:00:00Z';
function row(matchup, side, market, edge, extra) {
  const [away, home] = matchup.split(' @ ');
  return {
    sport: 'NCAAF', matchup, side, market, line: extra && extra.line != null ? extra.line : 3.5,
    odds: -110, coverProb: 0.55, ev: 0.04, edgePct: edge,
    commenceTime: future, homeTeam: home, awayTeam: away, book: 'draftkings',
    ...extra,
  };
}

const sameGame = [
  row('Texas Longhorns @ Oklahoma Sooners', 'Over 38.5', 'Total', 0.054, { line: 38.5, book: 'espnbet' }),
  row('Texas Longhorns @ Oklahoma Sooners', 'Over 39.5', 'Total', 0.0534, { line: 39.5, book: 'draftkings' }),
  row('Sacramento State Hornets @ Bowling Green Falcons', 'Sacramento State Hornets +8.5', 'Spread', 0.041, { line: 8.5 }),
  row('Miami (OH) RedHawks @ UMass Minutemen', 'UMass Minutemen +5.5', 'Spread', 0.0387, { line: 5.5 }),
];
const synthetic = assertSpecCard(sameGame, '2026-10-10', 'synthetic');
assert.strictEqual(synthetic.straights.length, 3);
assert.ok(synthetic.straights.some(s => s.line === 39.5), '5.34% same-game total must be a straight');
assert.ok(!synthetic.straights.some(s => /UMass/.test(s.side)), '3.87% stays behind the top three edges');
assert.strictEqual(synthetic.parlay.length, 1);
assert.strictEqual(synthetic.parlay[0].legs.length, 3);
const parlayGames = synthetic.parlay[0].legs.map(l => l.matchup);
assert.strictEqual(new Set(parlayGames).size, 3);

const one = [row('A @ B', 'B -3', 'Spread', 0.02)];
const tiny = selectStraights(one, 3);
assert.strictEqual(tiny.length, 1, 'one candidate still publishes a straight');

const snapPaths = [
  '/workspace/omega-replay-2w/out/live-1010/2026-10-10.json',
  path.join(__dirname, 'review-1010/candidates-1010.json'),
];
const snapPath = snapPaths.find(p => fs.existsSync(p));
assert.ok(snapPath, `missing 2026-10-10 candidate snapshot; tried ${snapPaths.join(', ')}`);
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const rawYes = Array.isArray(snap.yes) ? snap.yes : (snap.candidates || []);
const yes = rawYes.map(c => {
  const odds = typeof c.odds === 'number' ? c.odds : parseFloat(String(c.odds).replace(/[^0-9.+-]/g, ''));
  return { ...c, odds };
});
assert.ok(yes.length >= 3, `today yes pool too small: ${yes.length}`);
const live = assertSpecCard(yes, '2026-10-10', '2026-10-10');
assert.strictEqual(live.straights.length, 3);
assert.strictEqual(live.parlay.length, 1);
assert.strictEqual(live.parlay[0].legs.length, 3);
console.log('PASS test-omega-edge-card-1010');
console.log(JSON.stringify({
  snapshot: snapPath,
  yes: yes.length,
  straights: live.straights.map(s => ({
    side: s.side, market: s.market, line: s.line, edge: s.edgePct, odds: s.odds, book: s.book, matchup: s.matchup,
  })),
  parlay: live.parlay[0].legs.map(l => ({ pick: l.pick, matchup: l.matchup, edgePct: l.edgePct, odds: l.odds })),
}, null, 2));
