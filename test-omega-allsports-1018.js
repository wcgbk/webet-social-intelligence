'use strict';
// NHL period prices include rating-error SD. MLB/NHL fixed ±1.5 handicaps
// are not a margin residual.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const elo = require(path.join(root, 'sports/nfl_elo'));
const nhl = require(path.join(root, 'sports/nhl'));
const nhlPeriod = require(path.join(root, 'nhl_period'));
const {
  gameMarginResidual, marginGamesOffCard, extremeMarginSports, buildHealthRecord,
} = require(path.join(root, 'health'));

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

function quote(args) {
  return nhl.periodQuote(args);
}

const MARGIN = 1.2;
const TOTAL = 6.0;

withEnv({ OMEGA_NHL_PERIOD_RATING_SD: null }, () => {
  const old = nhlPeriod.nhlMarketQuote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true,
  });
  assert.strictEqual(old.coverProb.toFixed(4), '0.6947');

  const home = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 8,
  });
  const away = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: false, nGames: 8,
  });
  assert.ok(home.coverProb > 0.5, home.coverProb);
  assert.ok(home.coverProb < old.coverProb, `${home.coverProb} vs ${old.coverProb}`);
  assert.ok(home.coverProb < 0.6947, home.coverProb);
  assert.ok(Math.abs(home.coverProb + away.coverProb - 1) < 1e-9, home.coverProb + away.coverProb);
  assert.strictEqual(home.pPush, 0);
  assert.strictEqual(away.pPush, 0);

  const wide = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 600,
  });
  assert.ok(Math.abs(wide.coverProb - old.coverProb) < 0.002, wide.coverProb);

  const oldDog = nhlPeriod.nhlMarketQuote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'spread', sideIsHome: false, line: 1.5,
  });
  const dog = quote({
    modelMargin: MARGIN, modelTotal: TOTAL, market: 'spread', sideIsHome: false, line: 1.5, nGames: 8,
  });
  assert.ok(oldDog.coverProb > 0.5, oldDog.coverProb);
  assert.ok(Math.abs(dog.coverProb - 0.5) < Math.abs(oldDog.coverProb - 0.5), `${dog.coverProb} vs ${oldDog.coverProb}`);

  withEnv({ OMEGA_NHL_PERIOD_RATING_SD: '0' }, () => {
    const off = quote({
      modelMargin: MARGIN, modelTotal: TOTAL, market: 'ml', sideIsHome: true, nGames: 8,
    });
    assert.strictEqual(off.coverProb, old.coverProb);
    assert.strictEqual(off.pPush, old.pPush);
    assert.strictEqual(off.pWin, old.pWin);
    assert.strictEqual(off.expectedTotal, old.expectedTotal);
  });
});

const nhlSrc = fs.readFileSync(path.join(root, 'sports/nhl.js'), 'utf8');
const calls = nhlSrc.match(/periodQuote\(\{[\s\S]*?\}\)/g) || [];
assert.strictEqual(calls.length, 3, calls.join('\n'));
for (const call of calls) assert.ok(/\bnGames\b/.test(call), call);

function spreadRow(sport, extra) {
  return {
    sport,
    matchup: 'TB @ CLE',
    homeTeam: 'CLE',
    awayTeam: 'TB',
    market: 'Spread',
    side: 'CLE +1.5',
    modelProjection: -0.11,
    line: 1.5,
    ...extra,
  };
}

const mlb = [spreadRow('MLB')];
assert.strictEqual(gameMarginResidual(mlb), null);
assert.deepStrictEqual(marginGamesOffCard(mlb), []);

const nhlRows = [spreadRow('NHL', { matchup: 'BOS @ TOR', homeTeam: 'TOR', awayTeam: 'BOS', side: 'TOR +1.5' })];
assert.strictEqual(gameMarginResidual(nhlRows), null);
assert.deepStrictEqual(marginGamesOffCard(nhlRows), []);

const nfl = [{
  sport: 'NFL',
  matchup: 'Away @ Home',
  homeTeam: 'Home',
  awayTeam: 'Away',
  market: 'Spread',
  side: 'Home -3.5',
  modelProjection: 10,
  line: -3.5,
}];
assert.strictEqual(gameMarginResidual(nfl), 6.5);

const cfb = [{
  sport: 'NCAAF',
  matchup: 'Away @ Home',
  homeTeam: 'Home',
  awayTeam: 'Away',
  market: 'Spread',
  side: 'Home -3.5',
  modelProjection: 10,
  line: -3.5,
}];
assert.deepStrictEqual(extremeMarginSports(cfb), ['NCAAF']);
assert.deepStrictEqual(marginGamesOffCard(cfb).map((g) => g.sport), ['NCAAF']);

const health = buildHealthRecord({
  dateISO: '2026-10-18',
  snap: {
    espnBySport: {},
    oddsBySport: {},
    standingsBySport: {},
    mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
  },
  candidates: [
    spreadRow('MLB'),
    {
      sport: 'MLB',
      matchup: 'TB @ CLE',
      homeTeam: 'CLE',
      awayTeam: 'TB',
      market: 'Total',
      side: 'Over 8.5',
      modelProjection: 9.2,
      line: 8.5,
      consensusLine: 8.5,
    },
  ],
  yesPool: [],
  oddsErrors: [],
});
assert.strictEqual(health.bySport.MLB.bias.marginN, 0);
assert.strictEqual(health.bySport.MLB.bias.marginMean, null);
assert.strictEqual(health.bySport.MLB.bias.totalN, 1);
assert.strictEqual(health.bySport.MLB.bias.totalMean, 0.7);

assert.strictEqual(config.NFL_PRIOR_K, 16);
assert.strictEqual(config.priorW(5, 16), 16 / 21);

function eloGame(i, homeId, awayId) {
  return {
    id: `allsports-k16-${i}`,
    season: 2026,
    seasonType: 2,
    week: i,
    date: `2026-09-${String(10 + i).padStart(2, '0')}T17:00:00Z`,
    homeId,
    awayId,
    homeScore: 24,
    awayScore: 17,
    neutral: true,
  };
}

const teamA = '1';
const teamB = '2';
const fiveGames = [1, 2, 3, 4, 5].map((i) => (
  i % 2 === 1 ? eloGame(i, teamA, teamB) : eloGame(i, teamB, teamA)
));

withEnv({ OMEGA_NFL_PRIOR_K: null, OMEGA_NFL_ELO_LEGACY_DECAY: null }, () => {
  elo.resetNflEloState();
  const card = '2026-10-18';
  return elo.prepareNflElo(card, { games: fiveGames }).then((pack) => {
    const applied = elo.gamesBeforeCard(fiveGames, card);
    assert.strictEqual(applied.length, 5);
    const prior = elo.priorRatings();
    const counts = {};
    for (const g of applied) {
      counts[String(g.homeId)] = (counts[String(g.homeId)] || 0) + 1;
      counts[String(g.awayId)] = (counts[String(g.awayId)] || 0) + 1;
    }
    assert.strictEqual(counts[teamA], 5);
    assert.strictEqual(config.sportPriorK('NFL'), 16);
    const start = {};
    for (const id of Object.keys(prior)) {
      const g = counts[id] || 0;
      start[id] = elo.MEAN_ELO + config.priorW(g, 16) * (prior[id] - elo.MEAN_ELO);
    }
    const walked = elo.ratingsAfterGames(applied, start);
    assert.strictEqual(pack.ratings[teamA], walked[teamA]);
    const fromFull = elo.ratingsAfterGames(applied, prior);
    assert.notStrictEqual(pack.ratings[teamA], fromFull[teamA]);
    elo.resetNflEloState();
  });
}).then(() => {
  console.log('test-omega-allsports-1018 ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
