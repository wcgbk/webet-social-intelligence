'use strict';
// NFL 1018: Elo prior is shrunk once, before the walk.
// NFL injury points are added back at full weight after the Elo blend.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const elo = require(path.join(root, 'sports/nfl_elo'));
const gd = require(path.join(root, 'sports/game_day'));
const nfl = require(path.join(root, 'sports/nfl'));

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
const K = config.NFL_PRIOR_K;
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
  injuryChecks();
  console.log('PASS test-omega-nfl-fixes-1018');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

function phiChart() {
  return {
    map: {
      '21': {
        teamId: '21',
        abbr: 'PHI',
        displayName: 'Philadelphia Eagles',
        qb1: { name: 'Tanner McKee', athleteId: '9001' },
        qb2: { name: 'Jalen Hurts', athleteId: '4040715' },
      },
    },
  };
}

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

function spreadRow(cands, re) {
  const row = cands.find((c) => c.market === 'Spread' && re.test(c.side));
  assert.ok(row, 'spread row missing');
  return row;
}

function injuryChecks() {
  const chart = phiChart();
  const hurtsQb = { qbStatus: 'injured reserve', qbName: 'Jalen Hurts' };
  assert.strictEqual(gd.isStartingQb(hurtsQb, chart.map['21'], {
    sport: 'NFL', team: 'Philadelphia Eagles',
  }), true);
  assert.strictEqual(gd.isStartingQb(hurtsQb, chart.map['21'], {
    sport: 'NFL', team: 'Dallas Cowboys',
  }), false);
  assert.strictEqual(gd.isStartingQb(
    { qbStatus: 'out', qbName: 'Jalen Hurts' },
    { qb1: { name: 'Payton Thorne', athleteId: '100' } },
    { sport: 'NCAAF', team: 'Auburn Tigers' },
  ), false);

  const hurts = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'Philadelphia Eagles',
    away: 'Dallas Cowboys',
    restByTeam: {},
    qbByTeam: { 'Philadelphia Eagles': hurtsQb },
    depthByTeam: chart,
  });
  // QB-driven injury margin is 0 with QB_MARGIN_SCALE=0 (2026-10-18).
  assert.ok(Math.abs(hurts.gameDay.injuryMarginAdj - 0) < 1e-9, hurts.gameDay.injuryMarginAdj);
  // QB margin points OFF (QB_MARGIN_SCALE=0, 2026-10-18): unfitted points do not move margins.
  assert.ok(Math.abs(hurts.gameDay.qbMarginAdj - 0) < 1e-9, hurts.gameDay.qbMarginAdj);
  assert.ok(Math.abs(hurts.modelMargin - 2) < 1e-9, hurts.modelMargin);
  assert.strictEqual(hurts.startingQbOut, false);
  assert.strictEqual(hurts.gameDay.qbContinuity, null);
  assert.strictEqual(hurts.gameDay.qbBackupDelta[0].source, 'table');
  assert.ok(Math.abs(hurts.gameDay.qbTotalAdj - (-1.5)) < 1e-9, hurts.gameDay.qbTotalAdj);
  assert.strictEqual(
    hurts.gameDay.injuryMarginAdj,
    (hurts.gameDay.qbMarginAdj || 0) + 0,
  );

  const doubtful = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'Philadelphia Eagles',
    away: 'Dallas Cowboys',
    restByTeam: {},
    qbByTeam: { 'Philadelphia Eagles': { qbStatus: 'doubtful', qbName: 'Jalen Hurts' } },
    depthByTeam: chart,
  });
  // QB margin scale 0 (2026-10-18): doubtful-QB no longer moves the margin.
  assert.ok(Math.abs(doubtful.gameDay.qbMarginAdj - 0) < 1e-9, doubtful.gameDay.qbMarginAdj);
  assert.ok(Math.abs(doubtful.gameDay.injuryMarginAdj - 0) < 1e-9);
  assert.strictEqual(doubtful.startingQbOut, false);
  assert.strictEqual(doubtful.gameDay.qbBackupDelta, null);

  const questionable = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'Philadelphia Eagles',
    away: 'Dallas Cowboys',
    restByTeam: {},
    qbByTeam: { 'Philadelphia Eagles': { qbStatus: 'questionable', qbName: 'Jalen Hurts' } },
    depthByTeam: chart,
  });
  assert.strictEqual(questionable.gameDay.qbMarginAdj, 0);
  assert.ok(questionable.uncertainty > 0.16);

  const quiet = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'New England Patriots',
    away: 'New York Jets',
    restByTeam: {},
    qbByTeam: {},
  });
  assert.strictEqual(quiet.gameDay.injuryMarginAdj, 0);
  assert.strictEqual(quiet.modelMargin, 2);

  const backup = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'Philadelphia Eagles',
    away: 'Dallas Cowboys',
    restByTeam: {},
    qbByTeam: {
      'Philadelphia Eagles': { qbStatus: 'injured reserve', qbName: 'Kenny Pickett', depthChartRank: 1 },
    },
    depthByTeam: chart,
  });
  assert.strictEqual(backup.gameDay.injuryMarginAdj, 0);
  assert.strictEqual(backup.gameDay.qbMarginAdj, 0);
  assert.strictEqual(backup.modelMargin, 2);

  const lamarIr = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 0,
    modelTotal: 45,
    uncertainty: 0.13,
    home: 'Atlanta Falcons',
    away: 'Baltimore Ravens',
    restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'ir', qbName: 'Lamar Jackson' } },
    depthByTeam: {
      map: {
        '33': {
          teamId: '33',
          abbr: 'BAL',
          displayName: 'Baltimore Ravens',
          qb1: { name: 'Cooper Rush', athleteId: '1' },
          qb2: { name: 'Lamar Jackson', athleteId: '3916387' },
        },
      },
    },
  });
  assert.strictEqual(lamarIr.startingQbOut, false);
  // Named-backup QB points also off with QB_MARGIN_SCALE=0 (2026-10-18).
  assert.ok(Math.abs(lamarIr.gameDay.qbMarginAdj - 0) < 1e-9, lamarIr.gameDay.qbMarginAdj);
  assert.ok(Math.abs(lamarIr.gameDay.injuryMarginAdj - 0) < 1e-9);
  assert.strictEqual(lamarIr.gameDay.qbContinuity, null);
  assert.strictEqual(lamarIr.gameDay.qbBackupDelta[0].source, 'named');

  const cfbChart = {
    map: {
      '2': {
        teamId: '2',
        abbr: 'AUB',
        displayName: 'Auburn Tigers',
        qb1: { name: 'Payton Thorne', athleteId: '100' },
        qb2: { name: 'Jalen Hurts', athleteId: '101' },
      },
    },
  };
  const cfbBase = {
    sport: 'NCAAF',
    modelMargin: 6,
    modelTotal: 52,
    uncertainty: 0.2,
    home: 'Auburn Tigers',
    away: 'Alabama Crimson Tide',
    restByTeam: {},
    depthByTeam: cfbChart,
  };
  const cfbDemoted = gd.applyGameDayAdjustments({
    ...cfbBase,
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'out', qbName: 'Jalen Hurts' } },
  });
  assert.strictEqual(cfbDemoted.gameDay.qbMarginAdj, 0);
  assert.strictEqual(cfbDemoted.modelMargin, 6);
  assert.strictEqual(cfbDemoted.startingQbOut, false);
  const cfbOut = gd.applyGameDayAdjustments({
    ...cfbBase,
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'out', qbName: 'Payton Thorne' } },
  });
  assert.strictEqual(cfbOut.startingQbOut, true);
  assert.ok(Math.abs(cfbOut.gameDay.qbMarginAdj - 0) < 1e-9); // QB points off; startingQbOut flag retained (2026-10-18)
  const cfbIr = gd.applyGameDayAdjustments({
    ...cfbBase,
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'injured reserve', qbName: 'Payton Thorne' } },
  });
  assert.strictEqual(cfbIr.startingQbOut, false);
  assert.ok(Math.abs(cfbIr.gameDay.qbMarginAdj - 0) < 1e-9); // QB points off (2026-10-18)
  assert.ok(Math.abs(cfbIr.modelMargin - 6) < 1e-9); // QB points off (2026-10-18)

  elo.resetNflEloState();
  const prevW = process.env.OMEGA_NFL_ELO_WEIGHT;
  const home = 'Philadelphia Eagles';
  const away = 'Dallas Cowboys';
  const ev = event(home, away);
  const gameDay = {
    qbStatusBySport: { NFL: { 'Philadelphia Eagles': hurtsQb } },
    depthCharts: { NFL: chart },
  };
  try {
    // Isolate the Elo blend formula from the interim bias correction.
    process.env.OMEGA_NFL_MARGIN_BIAS_PTS = '0';
    process.env.OMEGA_NFL_ELO_WEIGHT = '0';
    const statRow = spreadRow(nfl.project({
      oddsEvents: [ev], standings: {}, efficiency: {}, gameDay,
    }), /Eagles/);
    const quietEv = event('New England Patriots', 'New York Jets');
    const quietRow = spreadRow(nfl.project({
      oddsEvents: [quietEv], standings: {}, efficiency: {}, gameDay: {},
    }), /Patriots/);
    assert.strictEqual(quietRow.gameDay.injuryMarginAdj, 0);

    process.env.OMEGA_NFL_ELO_WEIGHT = '0.8';
    const blended = spreadRow(nfl.project({
      oddsEvents: [ev], standings: {}, efficiency: {}, gameDay,
    }), /Eagles/);
    const inj = blended.gameDay.injuryMarginAdj;
    assert.ok(Math.abs(inj - 0) < 1e-9, inj); // QB points off (2026-10-18)
    const stat = statRow.modelProjection;
    const eloPts = elo.eloMargin(home, away, false);
    const eloW = 0.8;
    const expected = (1 - eloW) * (stat - inj) + eloW * eloPts + inj;
    assert.strictEqual(blended.modelProjection, +expected.toFixed(2));
    assert.ok(Number.isFinite(blended.modelProjection)); // formula strictEqual above is the check (2026-10-18)

    process.env.OMEGA_NFL_ELO_WEIGHT = '0';
    const again = spreadRow(nfl.project({
      oddsEvents: [ev], standings: {}, efficiency: {}, gameDay,
    }), /Eagles/);
    assert.strictEqual(again.modelProjection, statRow.modelProjection);
  } finally {
    delete process.env.OMEGA_NFL_MARGIN_BIAS_PTS;
    if (prevW == null) delete process.env.OMEGA_NFL_ELO_WEIGHT;
    else process.env.OMEGA_NFL_ELO_WEIGHT = prevW;
    elo.resetNflEloState();
  }
}
