'use strict';
/**
 * Games-played prior weight. priorW(gp) = K/(K+gp).
 * OMEGA_<SPORT>_PRIOR_K is read at call time. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nhl = require(path.join(root, 'sports/nhl'));
const epa = require(path.join(root, 'sports/epa'));
const elo = require(path.join(root, 'sports/nfl_elo'));

function close(actual, expected, eps = 1e-12) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

function withEnv(extra, fn) {
  const prev = {};
  for (const key of Object.keys(extra)) {
    prev[key] = process.env[key];
    if (extra[key] == null) delete process.env[key];
    else process.env[key] = extra[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(extra)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

{
  assert.strictEqual(config.priorW(0, 4), 1);
  assert.strictEqual(config.priorW(-3, 4), 1);
  assert.strictEqual(config.priorW(Number.NaN, 4), 1);
  assert.strictEqual(config.priorW('nope', 4), 1);
  assert.strictEqual(config.priorW(4, 0), 0);
  assert.strictEqual(config.priorW(4, -1), 0);
  assert.strictEqual(config.priorW(6, Number.NaN), 0);
  close(config.priorW(4, 2), 2 / 6);
  close(config.priorW(6, 34), 34 / 40);
  close(config.priorW(6, 0.5), 0.5 / 6.5);
  const g = 5;
  const k = 8;
  close(1 - config.priorW(g, k), g / (k + g));
}

withEnv({
  OMEGA_NFL_PRIOR_K: null,
  OMEGA_NCAAF_PRIOR_K: null,
  OMEGA_NHL_PRIOR_K: null,
  OMEGA_NHL_SHRINK_K: null,
}, () => {
  assert.strictEqual(config.readPriorEnv('OMEGA_NFL_PRIOR_K'), null);
  assert.strictEqual(config.sportPriorK('NFL'), config.NFL_PRIOR_K);
  assert.strictEqual(config.sportPriorK('NCAAF'), config.NCAAF_PRIOR_K);
  assert.strictEqual(config.sportPriorK('NHL'), config.NHL_PRIOR_K);
  assert.strictEqual(config.ncaafPaceFollowsPrior(), config.NCAAF_PACE_FOLLOWS_PRIOR);
});

withEnv({ OMEGA_NFL_PRIOR_K: '   ' }, () => {
  assert.strictEqual(config.readPriorEnv('OMEGA_NFL_PRIOR_K'), null);
  assert.strictEqual(config.sportPriorK('NFL'), config.NFL_PRIOR_K);
});

withEnv({ OMEGA_NFL_PRIOR_K: '4', OMEGA_NCAAF_PRIOR_K: '6', OMEGA_NHL_PRIOR_K: '0.5' }, () => {
  assert.strictEqual(config.sportPriorK('NFL'), 4);
  assert.strictEqual(config.sportPriorK('nfl'), 4);
  assert.strictEqual(config.ncaafPriorK(), 6);
  assert.strictEqual(config.nhlPriorK(), 0.5);
  assert.strictEqual(config.ncaafPaceFollowsPrior(), true);
});

withEnv({ OMEGA_NFL_PRIOR_K: 'off', OMEGA_NHL_PRIOR_K: '0', OMEGA_NCAAF_PRIOR_K: 'nope' }, () => {
  assert.strictEqual(config.sportPriorK('NFL'), 0);
  assert.strictEqual(config.sportPriorK('NHL'), 0);
  assert.strictEqual(config.nhlPriorK(), 0);
  assert.strictEqual(config.sportPriorK('NCAAF'), config.NCAAF_PRIOR_K);
  assert.strictEqual(config.ncaafPriorK(), config.NCAAF_PRIOR_K > 0 ? config.NCAAF_PRIOR_K : 0);
});

withEnv({ OMEGA_NHL_PRIOR_K: null, OMEGA_NHL_SHRINK_K: '10' }, () => {
  assert.strictEqual(config.sportPriorK('NHL'), 10);
  assert.strictEqual(config.nhlPriorK(), 10);
});

withEnv({ OMEGA_NHL_PRIOR_K: '4', OMEGA_NHL_SHRINK_K: '10' }, () => {
  assert.strictEqual(config.sportPriorK('NHL'), 4);
});

withEnv({ OMEGA_NHL_PRIOR_K: '4', OMEGA_NHL_SHRINK_MODE: null }, () => {
  const got = nhl.teamGpg({
    wins: 4, losses: 1, otLosses: 0, games: 5, pf: 16, pa: 8, nhlSeasonGoals: true,
  });
  close(got.shrinkWeight, config.priorW(5, 4));
  close(got.shrinkWeight, 4 / 9);
});

{
  const board = [{
    events: [{
      id: 'prior-k',
      date: '2026-09-12T20:00:00Z',
      status: { type: { state: 'post' } },
      competitions: [{
        neutralSite: false,
        status: { type: { state: 'post' } },
        competitors: [
          { homeAway: 'home', score: '24', team: { id: '2' } },
          { homeAway: 'away', score: '21', team: { id: '12' } },
        ],
      }],
    }],
  }];
  const opts = { asOf: '2026-10-10', efficiency: {}, minGames: 1 };
  withEnv({ OMEGA_NCAAF_PRIOR_K: '6' }, () => {
    const pack = epa.solveNcaafOpponentRatings(board, opts);
    assert.ok(pack, 'pack');
    assert.strictEqual(pack.priorGames, 6);
    assert.strictEqual(pack.pacePriorGames, 6);
  });
  withEnv({ OMEGA_NCAAF_PRIOR_K: null }, () => {
    const pack = epa.solveNcaafOpponentRatings(board, opts);
    assert.strictEqual(pack.priorGames, config.NCAAF_PRIOR_K);
    assert.strictEqual(pack.pacePriorGames, config.NCAAF_PRIOR_K);
    const explicit = epa.solveNcaafOpponentRatings(board, {
      ...opts, priorGames: 2, pacePriorGames: 9,
    });
    assert.strictEqual(explicit.priorGames, 2);
    assert.strictEqual(explicit.pacePriorGames, 9);
  });
}

{
  const games = [{ homeId: '12', awayId: '2' }];
  const decayed = elo.applyNflPriorDecay({ 12: 1600 }, { 12: 1620 }, games, 4);
  close(decayed['12'], 1505 + (4 / 5) * (1600 - 1505) + 20);
  close(decayed['12'], 1601);
  const legacy = elo.applyNflPriorDecay({ 12: 1600 }, { 12: 1620 }, games, null);
  assert.strictEqual(legacy['12'], 1620);
  const none = elo.applyNflPriorDecay({ 12: 1600 }, { 12: 1620 }, games, Number.NaN);
  assert.strictEqual(none['12'], 1620);
  const fresh = elo.applyNflPriorDecay({ 12: 1600 }, { 12: 1600 }, [], 4);
  close(fresh['12'], 1600);
}

console.log('PASS test-omega-prior-decay');
