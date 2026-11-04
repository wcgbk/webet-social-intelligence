'use strict';

/**
 * NHL goalie and shot inputs from ESPN public payloads.
 * Fetch is mocked. This file must not open a socket.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const nhl = require(path.join(root, 'sports/nhl'));
const ingest = require(path.join(root, 'ingest'));
const v2 = require('./netlify/functions/lib/omega-v2');
const fixture = require('./test/fixtures/espn-nhl-goalies.json');

const HOME = 'New York Rangers';
const AWAY = 'Florida Panthers';
const ESPN_HOST = /^https:\/\/site\.(?:api|web\.api)\.espn\.com\//i;

function synthEvent(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-11-03T23:30:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 6.0 },
          { name: 'Under', price: -110, point: 6.0 },
        ] },
      ],
    })),
  };
}

function byMarket(cands, market, side) {
  const row = cands.find((c) => c.market === market && (side == null || c.side === side));
  assert.ok(row, `missing ${market} ${side || ''}`);
  return row;
}

function probs(cands) {
  return cands.map((c) => ({
    market: c.market,
    side: c.side,
    p: c.modelRawP,
    margin: c.modelProjection,
    method: c.projMethod,
  }));
}

const ev = synthEvent(HOME, AWAY);
const standings = {
  [HOME]: { pf: 3.4, pa: 2.8, wins: 8, losses: 4, otLosses: 2, games: 14, winPct: 0.57 },
  [AWAY]: { pf: 3.0, pa: 3.2, wins: 6, losses: 6, otLosses: 2, games: 14, winPct: 0.43 },
};

{
  const low = nhl.regressSavePct(0.94, 40);
  const high = nhl.regressSavePct(0.94, 2000);
  assert.ok(Math.abs(low - nhl.LG_SAVE) < Math.abs(high - nhl.LG_SAVE), 'short sample regresses harder');
  assert.ok(Math.abs(high - 0.94) < Math.abs(low - 0.94));
  assert.ok(low > nhl.LG_SAVE && low < 0.94);
}

{
  const base = nhl.project({ oddsEvents: [ev], standings });
  const untouched = nhl.project({
    oddsEvents: [ev],
    standings,
    espnGames: [{ homeTeam: HOME, awayTeam: AWAY }],
  });
  assert.deepStrictEqual(probs(untouched), probs(base), 'missing goalie and shots stay on the standings path');

  const oneSide = nhl.project({
    oddsEvents: [ev],
    standings,
    espnGames: [{ homeTeam: HOME, awayTeam: AWAY, homeGoalie: { name: 'Only Home', savePct: 0.93, confirmed: true } }],
  });
  assert.deepStrictEqual(probs(oneSide), probs(base), 'one goalie does not move the price');

  const unconfirmed = nhl.project({
    oddsEvents: [ev],
    standings,
    espnGames: [{
      homeTeam: HOME,
      awayTeam: AWAY,
      homeGoalie: { savePct: 0.93, confirmed: false },
      awayGoalie: { savePct: 0.89, confirmed: false },
    }],
  });
  assert.deepStrictEqual(probs(unconfirmed), probs(base), 'explicit unconfirmed goalies stay at 0');
}

{
  const shots = {
    [HOME]: { ...standings[HOME], shotsFor: 32, shotsAgainst: 26 },
    [AWAY]: { ...standings[AWAY], shotsFor: 26, shotsAgainst: 32 },
  };
  const base = nhl.project({ oddsEvents: [ev], standings });
  const withShots = nhl.project({ oddsEvents: [ev], standings: shots });
  const gap = (32 / 58) - (26 / 58);
  const soft = nhl.applyNhlEngineSoft({
    ...nhl.nhlStandingsEnv(shots[HOME], shots[AWAY]),
    homeSt: shots[HOME],
    awaySt: shots[AWAY],
  });
  assert.ok(Math.abs(soft.marginAdj - gap * nhl.SHOT_SHARE_MARGIN) < 1e-9, soft.marginAdj);
  assert.ok(Math.abs(soft.totalAdj) < 1e-9, soft.totalAdj);
  const delta = byMarket(withShots, 'Spread').modelProjection - byMarket(base, 'Spread').modelProjection;
  assert.ok(delta > 0 && delta <= 0.30, delta);
  const homeMl = byMarket(withShots, 'Moneyline', HOME).modelRawP;
  const baseMl = byMarket(base, 'Moneyline', HOME).modelRawP;
  assert.ok(homeMl > baseMl, 'shot share feeds the Poisson moneyline');

  const shareOnly = nhl.applyNhlEngineSoft({
    modelMargin: 0.15,
    modelTotal: 6.2,
    usedStandings: true,
    homeGoals: 3.1,
    awayGoals: 3.1,
    homeSt: { shotShare: 0.54 },
    awaySt: { shotShare: 0.46 },
  });
  assert.ok(Math.abs(shareOnly.marginAdj - 0.08 * nhl.SHOT_SHARE_MARGIN) < 1e-9);
  assert.strictEqual(shareOnly.totalAdj, 0);

  const viaEspn = nhl.applyNhlEngineSoft({
    modelMargin: 0.15,
    modelTotal: 6.2,
    usedStandings: true,
    homeGoals: 3.1,
    awayGoals: 3.1,
    espnGame: {
      homeStats: { shotsFor: 32, shotsAgainst: 26 },
      awayStats: { shotsFor: 26, shotsAgainst: 32 },
    },
  });
  assert.ok(Math.abs(viaEspn.marginAdj - gap * nhl.SHOT_SHARE_MARGIN) < 1e-9);
}

{
  const goalie = (extra) => nhl.applyNhlEngineSoft({
    modelMargin: 0.15,
    modelTotal: 6.2,
    usedStandings: true,
    homeGoals: 3.1,
    awayGoals: 3.1,
    espnGame: {
      homeGoalie: { savePct: 0.91, shotsAgainst: 2000, name: 'Home', ...extra },
      awayGoalie: { savePct: 0.90, shotsAgainst: 2000, name: 'Away', ...extra },
    },
  });
  const confirmed = goalie({ confirmed: true, probable: false, status: 'confirmed' });
  const probable = goalie({ confirmed: false, probable: true, status: 'probable' });
  assert.ok(confirmed.goalie.marginAdj > 0);
  assert.ok(Math.abs(probable.goalie.marginAdj - confirmed.goalie.marginAdj * nhl.PROBABLE_GOALIE_WEIGHT) < 1e-9);
  assert.ok(probable.goalie.marginAdj < confirmed.goalie.marginAdj);

  const priced = nhl.project({
    oddsEvents: [ev],
    standings,
    espnGames: [{
      homeTeam: HOME,
      awayTeam: AWAY,
      homeGoalie: { savePct: 0.91, shotsAgainst: 2000, confirmed: true, name: 'Home' },
      awayGoalie: { savePct: 0.90, shotsAgainst: 2000, confirmed: true, name: 'Away' },
    }],
  });
  const base = nhl.project({ oddsEvents: [ev], standings });
  const shortBad = nhl.applyNhlEngineSoft({
    modelMargin: 0.15,
    modelTotal: 6.2,
    usedStandings: true,
    homeGoals: 3.1,
    awayGoals: 3.1,
    espnGame: {
      homeGoalie: { savePct: 0.812, shotsAgainst: 197, confirmed: true, name: 'Home' },
      awayGoalie: { savePct: 0.87, shotsAgainst: 23, confirmed: true, name: 'Away' },
    },
  });
  assert.ok(shortBad.goalie && shortBad.goalie.marginAdj < 0, 'a short bad save still counts after regression');
  const impossible = nhl.applyNhlEngineSoft({
    modelMargin: 0.15,
    modelTotal: 6.2,
    usedStandings: true,
    homeGoals: 3.1,
    awayGoals: 3.1,
    espnGame: {
      homeGoalie: { savePct: 0.50, shotsAgainst: 2000, confirmed: true, name: 'Home' },
      awayGoalie: { savePct: 0.90, shotsAgainst: 800, confirmed: true, name: 'Away' },
    },
  });
  assert.strictEqual(impossible.goalie, null, 'a rate that stays outside the band is ignored');

  assert.ok(byMarket(priced, 'Moneyline', HOME).modelRawP > byMarket(base, 'Moneyline', HOME).modelRawP);
  assert.ok(/engines/.test(byMarket(priced, 'Spread').projMethod));
  assert.ok(priced.length >= 6);
}

{
  const summaryGoalies = nhl.goaliesFromSummary(fixture.summary);
  assert.strictEqual(summaryGoalies.home.name, 'Igor Shesterkin');
  assert.strictEqual(summaryGoalies.home.confirmed, false);
  assert.strictEqual(summaryGoalies.home.probable, true);
  assert.strictEqual(summaryGoalies.home.savePct, 0.92);
  assert.strictEqual(summaryGoalies.away.name, 'Sergei Bobrovsky');
  assert.strictEqual(summaryGoalies.away.confirmed, true);
  assert.strictEqual(summaryGoalies.away.savePct, 0.91);
  assert.strictEqual(nhl.goalieFromProbable({
    athlete: { displayName: 'Skater', position: { abbreviation: 'C' } },
    savePct: 0.2,
  }), null);

  const roster = nhl.parseRosterGoalie(fixture.topGames, '1');
  assert.strictEqual(roster.savePct, 0.918);
  assert.strictEqual(nhl.parseRosterGoalie(fixture.topGames, '9').savePct, 0.9);

  const overview = nhl.parseAthleteGoalieOverview({
    statistics: {
      names: ['savePct', 'shotsAgainst', 'games'],
      splits: [
        { displayName: 'Career', stats: ['.950', '20000', '800'] },
        { displayName: 'Regular Season', stats: ['.910', '640', '20'] },
        { displayName: 'Projected', stats: ['.930', '3000', '60'] },
      ],
    },
  });
  assert.strictEqual(overview.savePct, '.910');
  assert.strictEqual(overview.shotsAgainst, 640);

  const parsed = nhl.parseTeamShotStats({
    results: {
      stats: {
        categories: [
          { name: 'general', stats: [{ name: 'games', value: 16 }] },
          { name: 'offensive', stats: [{ name: 'shotsTotal', value: 480 }, { name: 'shootingPct', value: 10.4 }] },
          { name: 'defensive', stats: [{ name: 'shotsAgainst', value: 416 }, { name: 'savePct', value: 0.905 }] },
        ],
      },
    },
  });
  assert.strictEqual(parsed.shotsFor, 30);
  assert.strictEqual(parsed.shotsAgainst, 26);
  assert.ok(Math.abs(parsed.shotShare - 30 / 56) < 1e-12);
  assert.strictEqual(nhl.parseTeamShotStats(null), null);
  assert.strictEqual(nhl.parseTeamShotStats({ games: 3, shotsTotal: 200, shotsAgainst: 200 }), null);
}

function teamPayload(shotsFor, shotsAgainst) {
  return {
    games: 12,
    shotsTotal: shotsFor * 12,
    shotsAgainst: shotsAgainst * 12,
    savePct: 0.905,
    shootingPct: 10,
  };
}

function overviewPayload(save, shots) {
  return {
    statistics: {
      names: ['savePct', 'shotsAgainst'],
      splits: [{ displayName: 'Regular Season', stats: [save, String(shots)] }],
    },
  };
}

(async () => {
  const urls = [];
  const okFetch = async (url) => {
    urls.push(String(url));
    assert.ok(ESPN_HOST.test(String(url)), url);
    assert.ok(!/the-odds-api|odds-api\.com/i.test(String(url)), url);
    if (/\/teams\/10\/statistics/.test(url)) return teamPayload(32, 26);
    if (/\/teams\/13\/statistics/.test(url)) return teamPayload(26, 32);
    if (/\/athletes\/1\/overview/.test(url)) return overviewPayload('.920', 800);
    if (/\/athletes\/2\/overview/.test(url)) return overviewPayload('.900', 220);
    if (/\/summary\?event=401700001/.test(url)) return fixture.summary;
    return null;
  };

  const table = {
    [HOME]: { ...standings[HOME], espnId: '10' },
    [AWAY]: { ...standings[AWAY], espnId: '13' },
  };
  const games = [{
    id: '401700001',
    homeTeam: HOME,
    awayTeam: AWAY,
    homeTeamId: '10',
    awayTeamId: '13',
    homeProbablesRaw: [{
      name: 'probableStartingGoalie',
      athlete: { id: '1', displayName: 'Igor Shesterkin', position: 'G' },
      status: { type: 'confirmed', name: 'Confirmed' },
      statistics: [],
    }],
    awayProbablesRaw: [{
      name: 'probableStartingGoalie',
      athlete: { id: '2', displayName: 'Sergei Bobrovsky', position: 'G' },
      status: { type: 'probable', name: 'Probable' },
      statistics: [],
    }],
  }];
  await ingest.enrichNhlPublicInputs({ games, standings: table, fetchJson: okFetch });
  assert.strictEqual(table[HOME].shotsFor, 32);
  assert.strictEqual(table[HOME].shotsAgainst, 26);
  assert.strictEqual(table[AWAY].shotsFor, 26);
  assert.strictEqual(games[0].homeStats.shotsFor, 32);
  assert.strictEqual(games[0].homeGoalie.name, 'Igor Shesterkin');
  assert.strictEqual(games[0].homeGoalie.confirmed, true);
  assert.strictEqual(games[0].homeGoalie.savePct, 0.92);
  assert.strictEqual(games[0].homeGoalie.shotsAgainst, 800);
  assert.strictEqual(games[0].awayGoalie.confirmed, false);
  assert.strictEqual(games[0].awayGoalie.probable, true);
  assert.strictEqual(games[0].awayGoalie.savePct, 0.9);
  assert.strictEqual(games[0].awayGoalie.shotsAgainst, 220);
  assert.ok(urls.every((url) => ESPN_HOST.test(url)));
  assert.ok(!urls.some((url) => /summary/.test(url)), 'scoreboard probables skip the summary');
  assert.ok(urls.some((url) => /athletes\/1\/overview/.test(url)));

  const fromFeed = nhl.project({ oddsEvents: [ev], standings: table, espnGames: games });
  const bare = nhl.project({ oddsEvents: [ev], standings });
  assert.ok(byMarket(fromFeed, 'Spread').modelProjection > byMarket(bare, 'Spread').modelProjection);
  assert.ok(fromFeed.length >= 6);

  const summaryGames = [{
    id: '401700001',
    homeTeam: HOME,
    awayTeam: AWAY,
  }];
  const summaryUrls = [];
  await ingest.enrichNhlPublicInputs({
    games: summaryGames,
    standings: {},
    fetchJson: async (url) => {
      summaryUrls.push(String(url));
      if (/summary\?event=401700001/.test(url)) return fixture.summary;
      if (/athletes\/1\/overview/.test(url)) return fixture.topGames;
      return null;
    },
  });
  assert.strictEqual(summaryGames[0].homeGoalie.name, 'Igor Shesterkin');
  assert.strictEqual(summaryGames[0].homeGoalie.savePct, 0.92);
  assert.strictEqual(summaryGames[0].homeGoalie.shotsAgainst, null);
  assert.strictEqual(summaryGames[0].awayGoalie.name, 'Sergei Bobrovsky');
  assert.strictEqual(summaryGames[0].awayGoalie.confirmed, true);
  assert.ok(summaryUrls.some((url) => /summary/.test(url)));

  const brokenTable = {
    [HOME]: { ...standings[HOME], espnId: '10' },
    [AWAY]: { ...standings[AWAY], espnId: '13' },
  };
  const brokenGames = [{
    id: '9',
    homeTeam: HOME,
    awayTeam: AWAY,
    homeTeamId: '10',
    awayTeamId: '13',
    homeProbablesRaw: games[0].homeProbablesRaw,
    awayProbablesRaw: games[0].awayProbablesRaw,
  }];
  await ingest.enrichNhlPublicInputs({
    games: brokenGames,
    standings: brokenTable,
    fetchJson: async () => {
      throw new Error('espn down');
    },
  });
  assert.strictEqual(brokenTable[HOME].shotsFor, undefined);
  assert.strictEqual(brokenGames[0].homeGoalie, undefined);
  assert.strictEqual(brokenGames[0].homeStats, undefined);
  const afterFail = nhl.project({ oddsEvents: [ev], standings: brokenTable, espnGames: brokenGames });
  assert.deepStrictEqual(probs(afterFail), probs(bare), 'a dead feed matches the current card');

  await ingest.enrichNhlPublicInputs({
    games: [{ homeTeam: HOME }],
    standings: { [HOME]: { espnId: '10' } },
    fetchJson: async () => {
      throw new Error('still down');
    },
  });

  v2.setMathMode('logodds');
  v2.setBiasMode('center');
  const spreadRows = [];
  const totalRows = [];
  const mlRows = [];
  for (let i = 0; i < 24; i += 1) {
    const pMkt = 0.42 + (i % 5) * 0.03;
    const pModel = Math.min(0.92, pMkt + 0.05 + (i % 3) * 0.01);
    spreadRows.push({ sport: 'NHL', market: 'Spread', pick: `Club ${i} +1.5`, pModel, pMkt });
    totalRows.push({ sport: 'NHL', market: 'Total', pick: i % 2 ? `Over ${5 + (i % 3)}` : `Under ${5 + (i % 3)}`, pModel: Math.max(0.08, pMkt - 0.04), pMkt });
    mlRows.push({ sport: 'NHL', market: 'Moneyline', pick: `Club ${i}`, pModel, pMkt });
  }
  const bias = v2.fitCellBias([...spreadRows, ...totalRows, ...mlRows]);
  assert.ok(!Object.prototype.hasOwnProperty.call(bias, 'NHL|Moneyline'), 'NHL moneylines stay unshifted');
  for (const [key, rows] of [['NHL|Spread', spreadRows], ['NHL|Total', totalRows]]) {
    const shift = bias[key];
    assert.ok(Number.isFinite(shift), key);
    let sum = 0;
    for (const row of rows) {
      sum += v2.shrinkP(row.pModel, row.pMkt, v2.priorKFor('NHL'), shift) - row.pMkt;
    }
    const mean = sum / rows.length;
    assert.ok(Math.abs(mean) < 1e-3, `${key} residual ${mean}`);
  }
  for (const row of mlRows) {
    const cal = v2.applyCalibration(row, { bias, bySport: {}, sportN: { NHL: 0 } });
    assert.ok(Math.abs(cal.pCal - cal.pMkt) < 1e-12, cal.pCal);
  }

  const src = fs.readFileSync(path.join(root, 'ingest.js'), 'utf8');
  assert.ok(src.includes('enrichNhlPublicInputs'));
  assert.ok(src.includes('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/'));
  assert.ok(src.includes('https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/'));
  assert.ok(src.includes('NHL: {}'));

  console.log('PASS nhl public inputs');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
