'use strict';
// NFL 1018: Elo prior is shrunk once, before the walk.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const elo = require(path.join(root, 'sports/nfl_elo'));

function close(actual, expected, eps = 1e-9) {
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

// Real ESPN ids so the walk applies. A and B are the synthetic labels.
const A = '1';
const B = '2';
const MEAN = elo.MEAN_ELO;
const K = 1;
const prior = { [A]: MEAN + 120, [B]: MEAN - 120 };

function game(i, homeId, awayId, homeScore, awayScore) {
  return {
    id: `elo-1018-${i}`,
    season: 2026,
    seasonType: 2,
    week: i,
    date: `2026-09-${String(10 + i).padStart(2, '0')}T17:00:00Z`,
    homeId,
    awayId,
    homeScore,
    awayScore,
    neutral: true,
  };
}

// A is 2-3. Points for equal points against (111-111).
const games = [
  game(1, A, B, 24, 21),
  game(2, A, B, 24, 21),
  game(3, B, A, 23, 21),
  game(4, B, A, 23, 21),
  game(5, B, A, 23, 21),
];

{
  let wins = 0;
  let pf = 0;
  let pa = 0;
  for (const g of games) {
    const aHome = g.homeId === A;
    const aScore = aHome ? g.homeScore : g.awayScore;
    const opp = aHome ? g.awayScore : g.homeScore;
    pf += aScore;
    pa += opp;
    if (aScore > opp) wins += 1;
  }
  assert.strictEqual(wins, 2);
  assert.strictEqual(games.length - wins, 3);
  assert.strictEqual(pf, pa);

  const wA = config.priorW(5, K);
  const wB = config.priorW(5, K);
  assert.strictEqual(wA, K / (K + 5));
  const shrunkStart = {
    [A]: MEAN + wA * (prior[A] - MEAN),
    [B]: MEAN + wB * (prior[B] - MEAN),
  };
  const got = elo.ratingsFromPrior(prior, games, K);
  const fromShrunk = elo.ratingsAfterGames(games, shrunkStart);
  assert.strictEqual(got[A], fromShrunk[A]);
  assert.strictEqual(got[B], fromShrunk[B]);

  const walkedFull = elo.ratingsAfterGames(games, prior);
  const legacy = elo.applyNflPriorDecay(prior, walkedFull, games, K);
  assert.ok(got[A] > legacy[A], `new ${got[A]} should beat legacy ${legacy[A]}`);

  const atNull = elo.ratingsFromPrior(prior, games, null);
  const legacyNull = elo.applyNflPriorDecay(prior, elo.ratingsAfterGames(games, prior), games, null);
  assert.strictEqual(atNull[A], legacyNull[A]);
  assert.strictEqual(atNull[A], walkedFull[A]);
  const atNan = elo.ratingsFromPrior(prior, games, Number.NaN);
  assert.strictEqual(atNan[A], walkedFull[A]);

  const none = elo.ratingsFromPrior(prior, [], K);
  assert.strictEqual(config.priorW(0, K), 1);
  assert.strictEqual(none[A], prior[A]);
  assert.strictEqual(none[B], prior[B]);

  const forcedLegacy = elo.ratingsFromPrior(prior, games, K, { legacy: true });
  close(forcedLegacy[A], legacy[A]);
}

withEnv({ OMEGA_NFL_ELO_LEGACY_DECAY: null }, () => {
  elo.resetNflEloState();
  const card = '2026-10-01';
  const applied = elo.gamesBeforeCard(games, card);
  assert.strictEqual(applied.length, games.length);
  const filePrior = elo.priorRatings();
  const k = config.sportPriorK('NFL');
  return elo.prepareNflElo(card, { games }).then((fresh) => {
    assert.strictEqual(fresh.ratings[A], elo.ratingsFromPrior(filePrior, applied, k)[A]);
    const start = {};
    const counts = { [A]: 5, [B]: 5 };
    for (const id of Object.keys(filePrior)) {
      const g = counts[id] || 0;
      start[id] = MEAN + config.priorW(g, k) * (filePrior[id] - MEAN);
    }
    assert.strictEqual(fresh.ratings[A], elo.ratingsAfterGames(applied, start)[A]);
    return withEnv({ OMEGA_NFL_ELO_LEGACY_DECAY: '1' }, () => (
      elo.prepareNflElo(card, { games }).then((old) => {
        const walked = elo.ratingsAfterGames(applied, filePrior);
        const legacy = elo.applyNflPriorDecay(filePrior, walked, applied, k);
        assert.strictEqual(old.ratings[A], legacy[A]);
        assert.strictEqual(old.ratings[B], legacy[B]);
        if (Number.isFinite(k) && Math.abs(filePrior[A] - MEAN) > 1) {
          assert.notStrictEqual(fresh.ratings[A], old.ratings[A]);
        }
        elo.resetNflEloState();
      })
    ));
  });
}).then(() => {
  console.log('PASS test-omega-nfl-fixes-1018');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
