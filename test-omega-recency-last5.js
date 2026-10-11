'use strict';
// NFL last-5 recency is a shrunk residual inside the team rating.
// Missing data contributes 0. The margin move is capped at 1 point.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nfl = require(path.join(root, 'sports/nfl'));
const { eloMargin } = require(path.join(root, 'sports/nfl_elo'));
const {
  RECENCY_GAMES,
  RECENCY_FULL_WEIGHT,
  RECENCY_CAP,
  teamRecencyPoints,
  blendRecencyIntoMargin,
  blendNflRecency,
} = require(path.join(root, 'sports/nfl_recency'));
const { resolveTeamId } = require(path.join(root, 'sports/team_identity'));

assert.strictEqual(RECENCY_GAMES, 5);
assert.strictEqual(RECENCY_CAP, 1);
assert.ok(RECENCY_FULL_WEIGHT > 0 && RECENCY_FULL_WEIGHT <= 0.1);

const KICK = Date.parse('2026-10-11T17:00:00Z');

function rows(margins, startDay) {
  return margins.map((margin, i) => ({
    margin,
    commence: `2026-09-${String(startDay + i).padStart(2, '0')}T17:00:00Z`,
  }));
}

assert.strictEqual(teamRecencyPoints(null, 3, null, KICK).points, 0);
assert.strictEqual(teamRecencyPoints([], 3, null, KICK).points, 0);
assert.strictEqual(teamRecencyPoints(rows([10, 10, 10, 10, 10], 1), null, null, KICK).points, 0);
assert.strictEqual(teamRecencyPoints([{ margin: 10 }, { margin: 'x', commence: '2026-09-01T17:00:00Z' }], 0, null, KICK).points, 0);

// Residual vs the rating. Five games of +20 shrink by the full small weight.
const full = teamRecencyPoints(rows([20, 20, 20, 20, 20], 1), 0, null, KICK);
assert.strictEqual(full.n, 5);
assert.ok(Math.abs(full.w - RECENCY_FULL_WEIGHT) < 1e-12);
assert.ok(Math.abs(full.points - RECENCY_FULL_WEIGHT * 20) < 1e-12);

// Fewer than five games shrinks toward 0. Same residual, smaller weight.
const short = teamRecencyPoints(rows([20, 20], 1), 0, null, KICK);
assert.strictEqual(short.n, 2);
assert.ok(Math.abs(short.w - (2 / 5) * RECENCY_FULL_WEIGHT) < 1e-12);
assert.ok(short.points > 0 && short.points < full.points);
assert.ok(Math.abs(short.points - (2 / 5) * full.points) < 1e-12);

// A one-game sample is closer to 0 than the two-game sample.
const one = teamRecencyPoints(rows([20], 1), 0, null, KICK);
assert.strictEqual(one.n, 1);
assert.ok(one.points > 0 && one.points < short.points);

// Huge residual stays inside the 1-point cap.
const capped = teamRecencyPoints(rows([80, 80, 80, 80, 80], 1), 0, null, KICK);
assert.strictEqual(capped.points, RECENCY_CAP);

// Expectation is the team rating minus the opponent rating.
const vsOpp = teamRecencyPoints(
  [{ margin: 10, commence: '2026-10-04T17:00:00Z', opponentId: 'opp' }],
  5,
  { opp: 2 },
  KICK,
);
assert.strictEqual(vsOpp.n, 1);
assert.ok(Math.abs(vsOpp.mean - (10 - (5 - 2))) < 1e-12);
assert.ok(Math.abs(vsOpp.points - (1 / 5) * RECENCY_FULL_WEIGHT * 7) < 1e-12);

// A stored expected margin beats the rating difference.
const stored = teamRecencyPoints(
  [{ margin: 10, expectedMargin: 4, commence: '2026-10-04T17:00:00Z', opponentId: 'opp' }],
  5,
  { opp: 2 },
  KICK,
);
assert.ok(Math.abs(stored.mean - 6) < 1e-12);

// Kickoff and later games are not in the sample. An unknown opponent id is skipped.
const skipped = teamRecencyPoints([
  { margin: 30, commence: '2026-10-11T17:00:00Z' },
  { margin: 30, commence: '2026-10-12T17:00:00Z' },
  { margin: 9, commence: '2026-10-04T17:00:00Z', opponentId: 'missing' },
], 0, {}, KICK);
assert.strictEqual(skipped.n, 0);
assert.strictEqual(skipped.points, 0);

// Home hot, away cold. Each side is capped, and the margin move is capped at 1.
const both = blendRecencyIntoMargin({
  modelMargin: 2,
  homeGames: rows([80, 80, 80, 80, 80], 1),
  awayGames: rows([-80, -80, -80, -80, -80], 6),
  homeRating: 0,
  awayRating: 0,
  kickoffMs: KICK,
});
assert.strictEqual(both.home.points, 1);
assert.strictEqual(both.away.points, -1);
assert.strictEqual(both.delta, 1);
assert.strictEqual(both.modelMargin, 3);
assert.ok(Math.abs(both.delta) <= RECENCY_CAP);

const missing = blendRecencyIntoMargin({
  modelMargin: 4.5,
  homeGames: null,
  awayGames: rows([15], 1),
  homeRating: null,
  awayRating: null,
  kickoffMs: KICK,
});
assert.strictEqual(missing.applied, false);
assert.strictEqual(missing.delta, 0);
assert.strictEqual(missing.modelMargin, 4.5);

// Inside the NFL projection. No rating → 0, even when both clubs have margins
// the older raw-margin blend would have moved.
function event(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-11T17:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -3 },
          { name: away, price: -110, point: 3 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 45.5 },
          { name: 'Under', price: -110, point: 45.5 },
        ] },
      ],
    })),
  };
}

function spreadOf(cands) {
  const row = cands.find((c) => c.market === 'Spread' && /Chiefs/.test(c.side));
  assert.ok(row, 'home spread missing');
  return row;
}

const homeName = 'Kansas City Chiefs';
const awayName = 'Buffalo Bills';
const homeId = String(resolveTeamId('NFL', homeName));
const awayId = String(resolveTeamId('NFL', awayName));
assert.ok(homeId && homeId !== 'null');
assert.ok(awayId && awayId !== homeId);

const ev = event(homeName, awayName);
const bare = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
const rawOnly = spreadOf(nfl.project({
  oddsEvents: [ev],
  standings: {},
  efficiency: {},
  gameDay: {
    last5ByTeam: {
      NFL: {
        [homeId]: rows([20, 20, 20, 20, 20], 1).map((g) => ({ ...g, teamId: homeId })),
        [awayId]: rows([-20, -20, -20, -20, -20], 6).map((g) => ({ ...g, teamId: awayId })),
      },
    },
  },
}));
assert.strictEqual(rawOnly.modelProjection, bare.modelProjection);
assert.ok(rawOnly.recencyLast5 == null);
function shownMargin(base) {
  const w = config.nflEloWeight();
  const blended = w > 0
    ? (1 - w) * base + w * eloMargin(homeName, awayName, false)
    : base;
  return +blended.toFixed(2);
}
assert.strictEqual(bare.modelProjection, shownMargin(2));

const efficiency = {
  [homeName]: { offEpa: 0.10, defEpa: 0.04 },
  [awayName]: { offEpa: 0.00, defEpa: 0.00 },
};
const plays = 62;
const homeRating = (0.10 + 0.04) * plays;
const baseMargin = ((0.10 - 0.00) - (0.00 - 0.04)) * plays + 2.0;
const ratedBare = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency }));
assert.strictEqual(ratedBare.modelProjection, shownMargin(baseMargin));
assert.ok(ratedBare.recencyLast5 == null);

const hotGames = [0, 1, 2, 3, 4].map((i) => ({
  teamId: homeId,
  margin: homeRating + 20,
  commence: `2026-09-${String(10 + i).padStart(2, '0')}T17:00:00Z`,
}));
const rated = blendNflRecency({
  modelMargin: baseMargin,
  home: homeName,
  away: awayName,
  standings: {},
  efficiency,
  last5ByTeam: { NFL: { [homeId]: hotGames } },
  commenceTime: '2026-10-11T17:00:00Z',
});
assert.ok(Math.abs(rated.homeRating - homeRating) < 1e-9);
assert.strictEqual(rated.awayRating, 0);
assert.ok(Math.abs(rated.delta - 1) < 1e-9);
assert.ok(Math.abs(rated.delta) <= 1);

const ratedCard = spreadOf(nfl.project({
  oddsEvents: [ev],
  standings: {},
  efficiency,
  gameDay: { last5ByTeam: { NFL: { [homeId]: hotGames } } },
}));
assert.strictEqual(ratedCard.modelProjection, shownMargin(baseMargin + 1));
assert.ok(Math.abs(ratedCard.modelProjection - ratedBare.modelProjection) <= 1);
assert.ok(ratedCard.recencyLast5);
assert.strictEqual(ratedCard.recencyLast5.homeN, 5);
assert.strictEqual(ratedCard.recencyLast5.delta, 1);
assert.ok(Math.abs(ratedCard.recencyLast5.homePoints) <= 1);
assert.ok(Math.abs(ratedCard.recencyLast5.awayPoints) <= 1);
