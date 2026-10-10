'use strict';
// Spec: top edges are the straights, parlay legs are distinct games, a card
// with candidates is not empty. Also runs on the 2026-10-10 yes pool when present.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { selectStraights, edgeRank, matchupKey } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { gateReason, applyGates } = require(path.join(root, 'gates'));
const calibrate = require(path.join(root, 'calibrate'));
const config = require(path.join(root, 'config'));
const verify = require(path.join(__dirname, 'netlify/functions/verify-picks-omega'));

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

// A 30% cover with a real edge is not a floor reject, and it is a straight
// when it outranks the other sides. Placeability and predicted CLV log only.
const dog = row('Army Black Knights @ Navy Midshipmen', 'Army Black Knights ML', 'Moneyline', 0.04, {
  coverProb: 0.30,
  ev: 0.01,
  odds: 220,
  line: null,
  placeable: false,
  placeableBooks: ['fanatics'],
  liquid: true,
  predictedClv: -4,
});
assert.strictEqual(gateReason(dog), null);
const dogGated = applyGates([dog]);
assert.strictEqual(dogGated.rejected.length, 0);
assert.strictEqual(dogGated.yesPool.length, 1);
const lowCover = assertSpecCard([
  row('A @ B', 'Over 41', 'Total', 0.02, { line: 41 }),
  row('C @ D', 'D +3', 'Spread', 0.015, { line: 3 }),
  dog,
], '2026-10-10', 'low-cover');
assert.ok(lowCover.straights.some(s => s.side === dog.side), '30% cover with the higher edge is a straight');
assert.strictEqual(lowCover.parlay.length, 1);
assert.strictEqual(new Set(lowCover.parlay[0].legs.map(l => l.matchup)).size, lowCover.parlay[0].legs.length);

assert.strictEqual(gateReason(row('A @ B', 'B -3', 'Spread', 0.02, { ev: -0.01, liquid: true })), 'ev-floor');
assert.strictEqual(gateReason(row('A @ B', 'B -3', 'Spread', 0.02, { coverProb: null, liquid: true })), 'coverProb-floor');
assert.strictEqual(gateReason(row('A @ B', 'B -3', 'Spread', 0, { edgePct: 0, liquid: true })), 'nonpositive-edge');

delete process.env.OMEGA_CAL_MODE;
calibrate.clearCalParamsCache();
const wide = calibrate.calibrateCandidate({
  sport: 'NFL', market: 'Spread', modelRawP: 0.90, fair_sharp_p: 0.48,
});
const shrunk = calibrate.linearShrink(0.90, 0.48, config.SHRINK_K.Spread);
const banded = calibrate.bandRetainClip(shrunk);
assert.strictEqual(wide.calMode, 'A');
assert.strictEqual(wide.calMap, null);
assert.ok(Math.abs(wide.coverProb - shrunk) < 1e-12, 'mode A coverProb is the hand-set shrink');
assert.ok(Math.abs(wide.coverProb - banded) > 1e-4, 'mode A does not apply the 0.42–0.58 band');
assert.strictEqual(calibrate.CAL_MODE_DEFAULT, 'A');
assert.strictEqual(calibrate.K_POLICY.min, 0.3);
assert.ok(calibrate.CAL_POOL.minRows >= 80);

assert.strictEqual(config.MODEL_VERSION, 'v12.3.22-omega-vnext-no-floors');
assert.strictEqual(config.GATES.minCoverProb.default, 0);
assert.strictEqual(config.GATES.minCoverProb.NCAAF, 0);
assert.strictEqual(config.GATES.minEV.NFL, 0);
assert.strictEqual(config.GATES.minEV.NCAAF, 0);
assert.strictEqual(config.GATES.minPredictedClvCents, null);
assert.strictEqual(config.PER_GAME_EXPOSURE_CAP_ENABLED, false);
assert.strictEqual(verify.sportCoverFloor('NCAAF'), 0);
assert.strictEqual(verify.sportCoverFloor('MLB'), 0);
assert.strictEqual(verify.sportEvFloor('NFL'), 0);
assert.strictEqual(verify.candidateClearsSportGates({ sport: 'NCAAF', ev: 0.01, coverProb: 0.30 }), true);
assert.strictEqual(verify.candidateClearsSportGates({ sport: 'MLB', ev: -0.01, coverProb: 0.55 }), false);

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
