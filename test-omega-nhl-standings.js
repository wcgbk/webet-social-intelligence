'use strict';
/** NHL Goals For parse, early-season gpg, and Draw filter. No network. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const ingest = require(path.join(root, 'ingest'));
const nhl = require(path.join(root, 'sports/nhl'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.17-omega-vnext-cal-a');
assert.strictEqual(config.GATES.minEV.NHL, 0.03);
assert.strictEqual(config.GATES.minCoverProb.default, 0.48);
assert.strictEqual(nhl.NHL_MIN_GAMES, 2);
assert.strictEqual(nhl.NHL_GPG_PRIOR_GAMES, 34);
const K = nhl.NHL_GPG_PRIOR_GAMES;
function shrunkSum(sum, gp) {
  return (sum + K * 3.1) / (gp + K);
}

function stat(name, value, extra) {
  return Object.assign({ name, value }, extra || {});
}

function espnGoals(row, gf, ga, pts, gp, wins, losses, otl) {
  return ingest.applyNhlStandingStats({ wins, losses }, [
    stat('gamesPlayed', gp, { displayName: 'Games Played' }),
    stat('wins', wins, { displayName: 'Wins' }),
    stat('losses', losses, { displayName: 'Losses' }),
    stat('otLosses', otl, { displayName: 'Overtime Losses' }),
    stat('points', pts, { displayName: 'Points', abbreviation: 'PTS' }),
    stat('pointsFor', gf, { displayName: 'Goals For', abbreviation: 'GF' }),
    stat('pointsAgainst', ga, { displayName: 'Goals Against', abbreviation: 'GA' }),
  ]);
}

// Rangers: ESPN pointsFor is Goals For. GF 11 must survive Pts 6.
const rangers = espnGoals({}, 11, 6, 6, 4, 3, 1, 0);
assert.strictEqual(rangers.pf, 11);
assert.strictEqual(rangers.pa, 6);
assert.strictEqual(rangers.games, 4);
const rangersGpg = nhl.teamGpg(rangers);
assert.ok(rangersGpg, 'Rangers GF/GA is usable at gp 4');
// 11/4 and 6/4 sit inside [1.5, 5.2]. Default 'all' still shrinks them.
assert.ok(Math.abs(rangersGpg.gf - shrunkSum(11, 4)) < 1e-9, rangersGpg.gf);
assert.ok(Math.abs(rangersGpg.ga - shrunkSum(6, 4)) < 1e-9, rangersGpg.ga);
assert.ok(Math.abs(rangersGpg.shrinkWeight - K / (4 + K)) < 1e-9);

// Florida GF 6 / Pts 4 / GP 3. dupPoints used to clear this.
const florida = espnGoals({}, 6, 7, 4, 3, 1, 0, 2);
assert.strictEqual(florida.pf, 6, 'Florida GF kept');
assert.strictEqual(florida.pa, 7);
const floridaBare = ingest.applyNhlStandingStats({ wins: 1, losses: 0 }, [
  stat('gamesPlayed', 3),
  stat('wins', 1),
  stat('losses', 0),
  stat('otLosses', 2),
  stat('points', 4),
  stat('pointsFor', 6),
  stat('pointsAgainst', 7),
]);
assert.strictEqual(floridaBare.pf, 6, 'goal-band pointsFor is not dupPoints');
assert.strictEqual(floridaBare.pa, 7);

// The other early GF≈Pts clubs. Label is Goals For, so the rate floor does not clear them.
const carolina = espnGoals({}, 5, 8, 3, 3, 1, 1, 1);
assert.strictEqual(carolina.pf, 5);
assert.strictEqual(carolina.pa, 8);
const devils = espnGoals({}, 3, 8, 2, 2, 1, 1, 0);
assert.strictEqual(devils.pf, 3);
assert.strictEqual(devils.pa, 8);
const detroit = espnGoals({}, 2, 5, 0, 2, 0, 2, 0);
assert.strictEqual(detroit.pf, 2, 'Detroit GF kept');
assert.strictEqual(detroit.pa, 5);
const nashville = espnGoals({}, 3, 4, 2, 2, 1, 1, 0);
assert.strictEqual(nashville.pf, 3);
assert.strictEqual(nashville.pa, 4);
assert.strictEqual(nashville.nhlSeasonGoals, true);
const nashvilleGpg = nhl.teamGpg(nashville);
assert.ok(nashvilleGpg, 'Nashville 1.5 / 2.0 shrinks toward the league mean');
assert.ok(Math.abs(nashvilleGpg.gf - shrunkSum(3, 2)) < 1e-9, nashvilleGpg && nashvilleGpg.gf);
assert.ok(Math.abs(nashvilleGpg.ga - shrunkSum(4, 2)) < 1e-9, nashvilleGpg && nashvilleGpg.ga);
assert.ok(Math.abs(nashvilleGpg.shrinkWeight - K / (2 + K)) < 1e-9);
// Detroit GF 2 / GA 5 / GP 2 is 1.0 and 2.5 raw. 1.0 is out of band, so oob shrinks it.
assert.strictEqual(detroit.nhlSeasonGoals, true);
const detroitGpg = nhl.teamGpg(detroit);
assert.ok(detroitGpg, 'Detroit 1.0 GF/GP shrinks instead of the 6.2 baseline');
assert.ok(Math.abs(detroitGpg.gf - shrunkSum(2, 2)) < 1e-9, detroitGpg && detroitGpg.gf);
assert.ok(Math.abs(detroitGpg.ga - shrunkSum(5, 2)) < 1e-9, detroitGpg && detroitGpg.ga);
assert.ok(detroitGpg.gf > 1 && detroitGpg.gf < 3.1 && detroitGpg.ga > 2.5 && detroitGpg.ga < 3.1);

// Abbreviation GF/GA on pointsFor, no displayName, still goals.
const abbrOnly = ingest.applyNhlStandingStats({ wins: 3, losses: 1 }, [
  stat('gamesPlayed', 4),
  stat('points', 6, { abbreviation: 'PTS' }),
  stat('pointsFor', 11, { abbreviation: 'GF' }),
  stat('pointsAgainst', 6, { abbreviation: 'GA' }),
]);
assert.strictEqual(abbrOnly.pf, 11);
assert.strictEqual(abbrOnly.pa, 6);

// True standings-points row: pf === pts === 2*W+OTL, no goals label. Rate is ~1.2, not goals.
const ptsOnly = ingest.applyNhlStandingStats({ wins: 40, losses: 25 }, [
  stat('wins', 40),
  stat('losses', 25),
  stat('otLosses', 10),
  stat('gamesPlayed', 75),
  stat('points', 90),
  stat('pointsFor', 90),
  stat('pointsAgainst', 95),
]);
assert.strictEqual(ptsOnly.pf, null, 'standings points clear to baseline');
assert.strictEqual(ptsOnly.pa, null);
assert.strictEqual(ptsOnly.games, 75);
const ptsEnv = nhl.nhlStandingsEnv(ptsOnly, { pf: 80, pa: 88, wins: 30, losses: 40, otLosses: 10, games: 80 });
assert.strictEqual(ptsEnv.usedStandings, false);
assert.strictEqual(ptsEnv.modelTotal, 6.2);

// Explicit goalsFor still beats a pointsFor that is the point total.
const named = ingest.applyNhlStandingStats({ wins: 45, losses: 25 }, [
  stat('goalsFor', 250),
  stat('goalsAgainst', 210),
  stat('gamesPlayed', 80),
  stat('points', 100),
  stat('pointsFor', 100),
  stat('pointsAgainst', 110),
]);
assert.strictEqual(named.pf, 250);
assert.strictEqual(named.pa, 210);

// Season sum: gp 1 stays on the seed. An in-band gp 2+ rate shrinks under all.
assert.strictEqual(nhl.teamGpg({ pf: 8, pa: 6, games: 1 }), null);
const oneGame = nhl.nhlStandingsEnv(
  { pf: 8, pa: 6, games: 1, wins: 1, losses: 0 },
  { pf: 9, pa: 7, games: 1, wins: 0, losses: 1 }
);
assert.strictEqual(oneGame.usedStandings, false, 'gp 1 does not adjust gpg');
assert.strictEqual(oneGame.modelTotal, 6.2);
assert.ok(Math.abs(oneGame.modelMargin - config.HFA.NHL) < 1e-9);

const two = nhl.teamGpg({ pf: 8, pa: 6, games: 2 });
assert.ok(two, 'gp 2 in band is usable');
assert.ok(Math.abs(two.gf - shrunkSum(8, 2)) < 1e-9, two && two.gf);
assert.ok(Math.abs(two.ga - shrunkSum(6, 2)) < 1e-9, two && two.ga);
assert.ok(Math.abs(two.shrinkWeight - K / (2 + K)) < 1e-9);
const twoEnv = nhl.nhlStandingsEnv(
  { pf: 8, pa: 6, games: 2 },
  { pf: 7, pa: 6, games: 2 }
);
assert.strictEqual(twoEnv.usedStandings, true);
const twoHomeGf = shrunkSum(8, 2);
const twoHomeGa = shrunkSum(6, 2);
const twoAwayGf = shrunkSum(7, 2);
const twoAwayGa = shrunkSum(6, 2);
const twoTotal = (twoHomeGf + twoAwayGa) / 2 + (twoAwayGf + twoHomeGa) / 2;
assert.ok(Math.abs(twoEnv.modelTotal - twoTotal) < 1e-9, twoEnv.modelTotal);
assert.notStrictEqual(twoEnv.modelTotal, 6.2);

// gp 4 still usable. 3.0 and 2.0 are in band, and the all default shrinks them.
const four = nhl.teamGpg({ pf: 12, pa: 8, games: 4 });
assert.ok(four);
assert.ok(Math.abs(four.gf - shrunkSum(12, 4)) < 1e-9);
assert.ok(Math.abs(four.ga - shrunkSum(8, 4)) < 1e-9);
assert.ok(Math.abs(four.shrinkWeight - K / (4 + K)) < 1e-9);

// An in-band per-game rate with known games shrinks under the all default.
const rate = nhl.teamGpg({ pf: 3.2, pa: 2.8, games: 40 });
assert.ok(rate);
assert.ok(Math.abs(rate.gf - shrunkSum(3.2 * 40, 40)) < 1e-9);
assert.ok(Math.abs(rate.ga - shrunkSum(2.8 * 40, 40)) < 1e-9);
assert.ok(rate.shrinkWeight > 0);
// One game of a marked season sum stays on the seed.
assert.strictEqual(nhl.teamGpg({ pf: 4, pa: 3, games: 1, nhlSeasonGoals: true }), null);

// Rangers 4-1-0, GF 16 / GA 8. GA equals 2*W+OTL, but ESPN labeled Goals For/Against.
const rangersEspn = espnGoals({}, 16, 8, 8, 5, 4, 1, 0);
assert.strictEqual(rangersEspn.nhlSeasonGoals, true);
assert.strictEqual(rangersEspn.pf, 16);
assert.strictEqual(rangersEspn.pa, 8);
assert.strictEqual(rangersEspn.games, 5);
const rangersEspnGpg = nhl.teamGpg(rangersEspn);
assert.ok(rangersEspnGpg, 'Rangers ESPN GF/GA survives the standings-points guard');
assert.ok(Math.abs(rangersEspnGpg.gf - shrunkSum(16, 5)) < 1e-9, rangersEspnGpg && rangersEspnGpg.gf);
assert.ok(Math.abs(rangersEspnGpg.ga - shrunkSum(8, 5)) < 1e-9, rangersEspnGpg && rangersEspnGpg.ga);
assert.ok(Math.abs(rangersEspnGpg.shrinkWeight - K / (5 + K)) < 1e-9);

const rangersFlagged = { wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8, nhlSeasonGoals: true };
const rangersFlaggedGpg = nhl.teamGpg(rangersFlagged);
assert.ok(rangersFlaggedGpg, 'nhlSeasonGoals skips the standings-points heuristic');
assert.ok(Math.abs(rangersFlaggedGpg.gf - shrunkSum(16, 5)) < 1e-9, rangersFlaggedGpg && rangersFlaggedGpg.gf);
assert.ok(Math.abs(rangersFlaggedGpg.ga - shrunkSum(8, 5)) < 1e-9, rangersFlaggedGpg && rangersFlaggedGpg.ga);
assert.ok(Math.abs(rangersFlaggedGpg.shrinkWeight - K / (5 + K)) < 1e-9);

// Same numbers without the flag: GA 8 is 2*W+OTL, so the heuristic still clears it.
assert.strictEqual(
  nhl.teamGpg({ wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8 }),
  null
);

// Genuine standings points (pf 11 = 2*5+1) stay null without nhlSeasonGoals.
assert.strictEqual(
  nhl.teamGpg({ wins: 5, otLosses: 1, games: 7, pf: 11, pa: 18 }),
  null
);

function nhlEvent(drawName) {
  const home = 'Colorado Avalanche';
  const away = 'Dallas Stars';
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-05T23:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: home, price: -130 },
            { name: away, price: 110 },
            { name: drawName, price: 20000 },
          ],
        },
        {
          key: 'spreads',
          outcomes: [
            { name: home, price: -110, point: -1.5 },
            { name: away, price: -110, point: 1.5 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: -110, point: 6.5 },
            { name: 'Under', price: -110, point: 6.5 },
          ],
        },
      ],
    })),
  };
}

for (const drawName of ['Draw', 'draw', 'DRAW']) {
  const cands = nhl.project({
    oddsEvents: [nhlEvent(drawName)],
    standings: {
      'Colorado Avalanche': { pf: 280, pa: 220, games: 82, wins: 48, losses: 22, otLosses: 12 },
      'Dallas Stars': { pf: 250, pa: 240, games: 82, wins: 42, losses: 28, otLosses: 12 },
    },
  });
  const sides = cands.map((c) => String(c.side || ''));
  assert.ok(sides.length >= 6, sides.length);
  assert.ok(!sides.some((s) => s.trim().toLowerCase() === 'draw' || /\bdraw\b/i.test(s)), sides.join(' | '));
  const ml = cands.filter((c) => c.market === 'Moneyline');
  assert.strictEqual(ml.length, 2, drawName);
  assert.deepStrictEqual(ml.map((c) => c.side).sort(), ['Colorado Avalanche', 'Dallas Stars']);
}

console.log('test-omega-nhl-standings: ok');
