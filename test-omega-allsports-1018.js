'use strict';
// NHL period prices include rating-error SD. MLB/NHL fixed ±1.5 handicaps
// are not a margin residual.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
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

console.log('test-omega-allsports-1018 ok');
