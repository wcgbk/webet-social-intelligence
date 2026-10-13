'use strict';
/**
 * ESPN starters at the 10:30 price. Fixtures only. No network.
 * MLB playoff scoreboards omit probables; the summary supplies them.
 * A missing confirmed starter still prices the probable with spConfirmed false.
 * NHL uses the projected or confirmed goalie on the existing save% term.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.OMEGA_MLB_ROOTFIX = '0';
process.env.OMEGA_MLB_TOTAL_RECENTER = '0';

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const ingest = require(path.join(root, 'ingest'));
const starters = require(path.join(root, 'starters'));
const mlb = require(path.join(root, 'sports/mlb'));
const nhl = require(path.join(root, 'sports/nhl'));
const { HFA } = require(path.join(root, 'config'));

const fixtures = path.join(__dirname, 'test/fixtures');
const playoffBoard = JSON.parse(fs.readFileSync(path.join(fixtures, 'espn-mlb-playoff-scoreboard.json'), 'utf8'));
const playoffSummary = JSON.parse(fs.readFileSync(path.join(fixtures, 'espn-mlb-playoff-summary.json'), 'utf8'));
const nhlGoalies = JSON.parse(fs.readFileSync(path.join(fixtures, 'espn-nhl-goalies.json'), 'utf8'));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function byMarket(cands, market) {
  const row = cands.find((c) => c.market === market);
  assert.ok(row, `missing ${market}`);
  return row;
}

function oddsEvent(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-12T23:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -120 }, { name: away, price: 100 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 8.5 },
          { name: 'Under', price: -110, point: 8.5 },
        ] },
      ],
    })),
  };
}

(async () => {
  const probableOnly = JSON.parse(JSON.stringify(playoffSummary));
  delete probableOnly.boxscore;
  const fromSummary = ingest.mapEspnEvent(probableOnly, 'MLB');
  assert.strictEqual(fromSummary.homeProbable.name, 'Yoshinobu Yamamoto');
  assert.strictEqual(fromSummary.homeProbable.spConfirmed, false);
  assert.strictEqual(fromSummary.awayProbable.name, 'Freddy Peralta');
  assert.strictEqual(fromSummary.awayProbable.spConfirmed, false);
  assert.strictEqual(fromSummary.seasonType, 3);
  assert.strictEqual(fromSummary.preseason, false);

  const confirmed = ingest.mapEspnEvent(playoffSummary, 'MLB');
  assert.strictEqual(confirmed.homeProbable.name, 'Blake Snell');
  assert.strictEqual(confirmed.homeProbable.spConfirmed, true);
  assert.strictEqual(confirmed.awayProbable.name, 'Tobias Myers');
  assert.strictEqual(confirmed.awayProbable.spConfirmed, true);

  assert.strictEqual(starters.choosePitcher({ probables: [{ name: 'TBD' }] }), null);
  assert.strictEqual(starters.needsStarterSummary('MLB', {
    id: '1', seasonType: 2, preseason: false,
    homeProbable: null, awayProbable: null,
  }), false);
  assert.strictEqual(starters.needsStarterSummary('MLB', {
    id: '1', seasonType: 3, preseason: true,
  }), false);

  const prev = global.fetch;
  try {
    const seen = [];
    global.fetch = async (url) => {
      const text = String(url);
      seen.push(text);
      if (text.includes('/summary?')) return jsonResponse(probableOnly);
      if (text.includes('/baseball/mlb/scoreboard')) return jsonResponse(playoffBoard);
      throw new Error('unexpected url ' + text);
    };
    const board = await ingest.fetchEspnScoreboard('MLB', '2026-10-12');
    assert.strictEqual(board.games.length, 1);
    assert.strictEqual(board.games[0].homeProbable.name, 'Yoshinobu Yamamoto');
    assert.strictEqual(board.games[0].homeProbable.spConfirmed, false);
    assert.strictEqual(board.games[0].awayProbable.spConfirmed, false);
    assert.strictEqual(seen.length, 2);
    assert.ok(seen.some((u) => u.includes('/summary?event=401800001')));

    seen.length = 0;
    global.fetch = async (url) => {
      const text = String(url);
      seen.push(text);
      if (text.includes('/summary?')) return jsonResponse(playoffSummary);
      return jsonResponse(playoffBoard);
    };
    const named = await ingest.fetchEspnScoreboard('MLB', '2026-10-12');
    assert.strictEqual(named.games[0].homeProbable.name, 'Blake Snell');
    assert.strictEqual(named.games[0].homeProbable.spConfirmed, true);
    assert.strictEqual(named.games[0].awayProbable.spConfirmed, true);

    seen.length = 0;
    const regular = JSON.parse(JSON.stringify(playoffBoard));
    regular.events[0].season = { type: 2, slug: 'regular-season' };
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/summary?')) throw new Error('regular season must not fetch summary');
      return jsonResponse(regular);
    };
    const reg = await ingest.fetchEspnScoreboard('MLB', '2026-10-12');
    assert.strictEqual(reg.games.length, 1);
    assert.strictEqual(reg.games[0].homeProbable, null);
    assert.strictEqual(seen.length, 1);

    seen.length = 0;
    const already = JSON.parse(JSON.stringify(playoffBoard));
    const comp = already.events[0].competitions[0];
    comp.competitors[0].probables = [{
      athlete: { id: '99', displayName: 'Blake Snell' }, starter: true,
    }];
    comp.competitors[1].probables = [{
      athlete: { id: '88', displayName: 'Tobias Myers' }, starter: true,
    }];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('/summary?')) throw new Error('confirmed scoreboard must not fetch summary');
      return jsonResponse(already);
    };
    const posted = await ingest.fetchEspnScoreboard('MLB', '2026-10-12');
    assert.strictEqual(posted.games[0].homeProbable.spConfirmed, true);
    assert.strictEqual(seen.length, 1);
  } finally {
    global.fetch = prev;
  }

  const dodgers = 'Los Angeles Dodgers';
  const brewers = 'Milwaukee Brewers';
  const standings = {
    [dodgers]: { pf: 700, pa: 680, wins: 80, losses: 70 },
    [brewers]: { pf: 700, pa: 680, wins: 80, losses: 70 },
  };
  const spStats = {
    byId: {
      11: { id: 11, name: 'Yoshinobu Yamamoto', quality: 1.2 },
      22: { id: 22, name: 'Freddy Peralta', quality: -0.4 },
    },
    byName: {},
    byTeam: {},
  };
  const ev = oddsEvent(dodgers, brewers);
  const bare = mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: spStats, espnGames: [],
  });
  const probable = mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: spStats,
    espnGames: [{
      homeTeam: dodgers,
      awayTeam: brewers,
      homeProbable: { name: 'Yoshinobu Yamamoto', id: '11', spConfirmed: false, confirmed: false },
      awayProbable: { name: 'Freddy Peralta', id: '22', spConfirmed: false, confirmed: false },
    }],
  });
  const bareMargin = byMarket(bare, 'Spread').modelProjection;
  const probableMargin = byMarket(probable, 'Spread').modelProjection;
  assert.ok(Math.abs(bareMargin - HFA.MLB) < 1e-9, bareMargin);
  assert.ok(probableMargin > bareMargin, `${probableMargin} should exceed ${bareMargin}`);
  assert.strictEqual(byMarket(probable, 'Moneyline').spConfirmed, false);
  assert.strictEqual(byMarket(probable, 'Spread').spConfirmed, false);
  assert.strictEqual(byMarket(probable, 'Total').spConfirmed, false);
  assert.strictEqual(byMarket(probable, 'Moneyline').assumedStarter.spConfirmed, false);
  assert.strictEqual(byMarket(probable, 'Moneyline').assumedStarter.name, 'Yoshinobu Yamamoto');
  assert.ok(byMarket(probable, 'Total').assumedStarter == null);
  assert.strictEqual(byMarket(bare, 'Moneyline').spConfirmed, undefined);

  const bothConfirmed = mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: spStats,
    espnGames: [{
      homeTeam: dodgers,
      awayTeam: brewers,
      homeProbable: { name: 'Yoshinobu Yamamoto', id: '11', spConfirmed: true, confirmed: true },
      awayProbable: { name: 'Freddy Peralta', id: '22', spConfirmed: true, confirmed: true },
    }],
  });
  assert.strictEqual(byMarket(bothConfirmed, 'Spread').modelProjection, probableMargin);
  assert.strictEqual(byMarket(bothConfirmed, 'Moneyline').spConfirmed, true);
  assert.strictEqual(byMarket(bothConfirmed, 'Total').spConfirmed, true);

  const home = 'New York Rangers';
  const away = 'Florida Panthers';
  const mapped = ingest.mapEspnEvent(nhlGoalies.summary, 'NHL');
  assert.strictEqual(mapped.homeGoalie.name, 'Igor Shesterkin');
  assert.strictEqual(mapped.homeGoalie.goalieConfirmed, false);
  assert.strictEqual(mapped.homeGoalie.confirmed, false);
  assert.strictEqual(mapped.homeGoalie.savePct, 0.92);
  assert.strictEqual(mapped.homeGoalie.gsax, 12.4);
  assert.strictEqual(mapped.awayGoalie.name, 'Sergei Bobrovsky');
  assert.strictEqual(mapped.awayGoalie.goalieConfirmed, true);
  assert.strictEqual(mapped.awayGoalie.savePct, 0.91);

  const fallback = starters.chooseGoalie(nhlGoalies.topGames);
  assert.strictEqual(fallback.name, 'Igor Shesterkin');
  assert.strictEqual(fallback.goalieConfirmed, false);
  assert.strictEqual(fallback.confirmed, false);
  assert.strictEqual(fallback.games, 48);
  assert.strictEqual(fallback.savePct, 0.918);
  assert.strictEqual(fallback.gsax, 9.5);
  assert.strictEqual(starters.chooseGoalie({}), null);

  const nhlStandings = {
    [home]: { pf: 240, pa: 210, wins: 40, losses: 20, otLosses: 5, games: 65 },
    [away]: { pf: 240, pa: 210, wins: 40, losses: 20, otLosses: 5, games: 65 },
  };
  const nhlEv = {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-12T23:30:00Z',
    bookmakers: ['draftkings', 'pinnacle'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 6 },
          { name: 'Under', price: -110, point: 6 },
        ] },
      ],
    })),
  };
  const noGoalie = nhl.project({ oddsEvents: [nhlEv], standings: nhlStandings, espnGames: [] });
  const withGoalie = nhl.project({
    oddsEvents: [nhlEv],
    standings: nhlStandings,
    espnGames: [{
      homeTeam: home,
      awayTeam: away,
      homeGoalie: {
        ...mapped.homeGoalie,
        savePct: 0.94,
        confirmed: false,
        goalieConfirmed: false,
      },
      awayGoalie: {
        ...mapped.awayGoalie,
        savePct: 0.88,
        confirmed: false,
        goalieConfirmed: false,
        gsax: mapped.awayGoalie.gsax,
      },
    }],
  });
  const baseNhl = byMarket(noGoalie, 'Spread').modelProjection;
  const moved = byMarket(withGoalie, 'Spread').modelProjection;
  assert.ok(moved !== baseNhl, 'projected goalie save% should move the goalie term');
  assert.ok(byMarket(withGoalie, 'Spread').engineSoft.goalie);

  const missingRate = nhl.goalieResidual({
    homeGoalie: { name: 'Igor Shesterkin', confirmed: false, goalieConfirmed: false, gsax: 12.4 },
    awayGoalie: { name: 'Sergei Bobrovsky', confirmed: true, goalieConfirmed: true, gsax: 4 },
  });
  // Both clubs carry a season GSAx and no save rate. The term is inside the goalie cap.
  assert.strictEqual(missingRate.used, true);
  assert.ok(missingRate.marginAdj > 0);
  assert.ok(Math.abs(missingRate.marginAdj) <= 0.12 + 1e-9);
  assert.ok(Math.abs(missingRate.totalAdj) <= 0.10 + 1e-9);

  const seenNhl = [];
  const prevNhl = global.fetch;
  try {
    global.fetch = async (url) => {
      const text = String(url);
      seenNhl.push(text);
      if (text.includes('/summary?')) return jsonResponse(nhlGoalies.summary);
      if (text.includes('/hockey/nhl/scoreboard')) return jsonResponse(nhlGoalies.scoreboard);
      throw new Error('unexpected url ' + text);
    };
    const nhlBoard = await ingest.fetchEspnScoreboard('NHL', '2026-10-12');
    assert.strictEqual(nhlBoard.games.length, 1);
    assert.strictEqual(nhlBoard.games[0].homeGoalie.name, 'Igor Shesterkin');
    assert.strictEqual(nhlBoard.games[0].homeGoalie.gsax, 12.4);
    assert.strictEqual(nhlBoard.games[0].homeGoalie.goalieConfirmed, false);
    assert.strictEqual(nhlBoard.games[0].awayGoalie.goalieConfirmed, true);
    assert.ok(seenNhl.some((u) => u.includes('/summary?event=401700001')));
  } finally {
    global.fetch = prevNhl;
  }

  console.log('test-omega-starters ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
