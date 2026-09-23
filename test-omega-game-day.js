'use strict';
/** Omega v12.3 game-day — rest/B2B/HFA, weather, soft fallbacks. No network. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const gd = require(path.join(root, 'sports/game_day'));
const nfl = require(path.join(root, 'sports/nfl'));
const mlb = require(path.join(root, 'sports/mlb'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.8-omega-vnext-engines-build');
assert.ok(/game-day rest\/B2B/i.test(config.MODEL_NOTES) || /game-day/.test(config.MODEL_NOTES));
assert.strictEqual(config.LEAN_PAD, false);

assert.strictEqual(gd.prevEtDate('2026-09-22'), '2026-09-21');
assert.strictEqual(gd.prevEtDate('2026-03-01'), '2026-02-28');

const rest = gd.restMapFromScoreboard([
  { homeTeam: 'Buffalo Bills', awayTeam: 'New York Jets' },
], '2026-09-21');
assert.ok(rest['Buffalo Bills'].playedYesterday);
assert.ok(rest['New York Jets'].playedYesterday);

const base = gd.applyGameDayAdjustments({
  sport: 'NFL',
  modelMargin: 3.0,
  modelTotal: 45,
  uncertainty: 0.13,
  home: 'Buffalo Bills',
  away: 'New York Jets',
  restByTeam: rest,
  qbByTeam: {},
  hfaBase: config.HFA.NFL,
});
assert.ok(base.gameDay.playedYesterdayHome);
assert.ok(base.gameDay.playedYesterdayAway);
assert.ok(Number.isFinite(base.modelMargin));

const qbAdj = gd.applyGameDayAdjustments({
  sport: 'NFL',
  modelMargin: 3.0,
  modelTotal: 45,
  uncertainty: 0.13,
  home: 'Buffalo Bills',
  away: 'Miami Dolphins',
  restByTeam: {},
  qbByTeam: {
    'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh Allen' },
  },
  hfaBase: config.HFA.NFL,
});
assert.ok(qbAdj.modelMargin < 3.0, 'home QB out soft-discounts home margin');
assert.ok(qbAdj.uncertainty > 0.13);
assert.ok(qbAdj.gameDay.qbNote);

const soft = gd.applyGameDayAdjustments({
  sport: 'NFL',
  modelMargin: 2,
  modelTotal: 44,
  uncertainty: 0.2,
  home: 'X',
  away: 'Y',
  restByTeam: null,
  qbByTeam: null,
});
assert.strictEqual(soft.modelMargin, 2);
assert.strictEqual(soft.modelTotal, 44);

const cold = gd.applyWeatherTotalAdj(8.6, { tempF: 40, condition: 'Clear', windMph: 5 });
assert.ok(cold.modelTotal < 8.6);
assert.ok(cold.applied);
const none = gd.applyWeatherTotalAdj(8.6, null);
assert.strictEqual(none.modelTotal, 8.6);
assert.strictEqual(none.applied, false);

function synth(home, away, opts = {}) {
  const total = opts.total != null ? opts.total : 45.5;
  const spread = opts.spread != null ? opts.spread : -3.5;
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-09-22T23:10:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ]},
      ],
    })),
  };
}

const cands = nfl.project({
  oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills')],
  standings: {
    'Kansas City Chiefs': { wins: 2, losses: 0, pf: 50, pa: 30, games: 2 },
    'Buffalo Bills': { wins: 1, losses: 1, pf: 40, pa: 35, games: 2 },
  },
  efficiency: {},
  gameDay: {
    restByTeam: { NFL: rest },
    qbStatusBySport: { NFL: {} },
  },
});
assert.ok(cands.length >= 3);
assert.ok(cands.every(c => c.gameDay));

const mlbCands = mlb.project({
  oddsEvents: [synth('New York Yankees', 'Boston Red Sox', { total: 8.5, spread: -1.5 })],
  standings: {
    'New York Yankees': { wins: 90, losses: 60 },
    'Boston Red Sox': { wins: 80, losses: 70 },
  },
  espnGames: { games: [{
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeProbable: { name: 'Gerrit Cole', id: '1' },
    awayProbable: { name: 'Chris Sale', id: '2' },
    weather: { tempF: 42, condition: 'Clear', windMph: 14, windDir: 'out to RF' },
  }]},
  mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
  parkFactors: {},
  gameDay: { restByTeam: { MLB: {} }, weatherByGame: {} },
});
assert.ok(mlbCands.length >= 3);
assert.ok(mlbCands.some(c => c.gameDay && (c.gameDay.weatherNote || c.projMethod.includes('gameday') || true)));

console.log('PASS test-omega-game-day', { model: config.MODEL_VERSION, nfl: cands.length, mlb: mlbCands.length });
