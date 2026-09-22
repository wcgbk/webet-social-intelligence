'use strict';
/** Omega v12.2 sport engines — synthetic events only, no network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const mlb = require(path.join(root, 'sports/mlb'));
const nba = require(path.join(root, 'sports/nba'));
const nhl = require(path.join(root, 'sports/nhl'));
const epa = require(path.join(root, 'sports/epa'));
const env = require(path.join(root, 'sports/mlb_env'));
const { powerFromStandings } = require(path.join(root, 'sports/_common'));
const calibrate = require(path.join(root, 'calibrate'));
const { projectAll } = require(path.join(root, 'index'));
const ingest = require(path.join(root, 'ingest'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.2-omega-vnext-verify-steam');
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.SPORTS_ENABLED.NHL, false);
assert.strictEqual(config.SPORTS_ENABLED.NFL, true);
assert.strictEqual(config.SPORTS_ENABLED.NCAAF, true);
assert.strictEqual(config.SPORTS_ENABLED.MLB, true);
assert.strictEqual(config.MAX_STRAIGHTS, 3);
assert.strictEqual(config.DAILY_UNIT_CAP, 4.0);
assert.strictEqual(config.STRAIGHT_UNIT_BUDGET, 3.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.LEAN_PAD, false);
assert.strictEqual(config.DAY_SCOPE_STRICT, true);
assert.strictEqual(config.QUALITY_GRADE.aplus, 0.05);
assert.strictEqual(config.QUALITY_GRADE.a, 0.035);
assert.strictEqual(config.QUALITY_GRADE.aminus, 0.02);
assert.strictEqual(config.HFA.NFL, 2.1);
assert.strictEqual(config.HFA.NCAAF, 2.6);
assert.strictEqual(config.HFA.MLB, 0.12);
assert.ok(/EPA-style/.test(config.MODEL_NOTES));
assert.ok(/Soft fallback/.test(config.MODEL_NOTES));
assert.ok(/never blanks the slate/.test(config.MODEL_NOTES));
assert.strictEqual(epa.SPORT_CFG.NFL.family, 'nfl-epa-v1');
assert.strictEqual(epa.SPORT_CFG.NCAAF.family, 'cfb-epa-v1');
assert.ok(epa.SPORT_CFG.NFL.epaUncertainty >= 0.12 && epa.SPORT_CFG.NFL.epaUncertainty <= 0.14);
assert.ok(epa.SPORT_CFG.NCAAF.epaUncertainty >= 0.16 && epa.SPORT_CFG.NCAAF.epaUncertainty <= 0.18);

const touched = [
  'sports/nfl.js', 'sports/cfb.js', 'sports/mlb.js', 'sports/epa.js', 'sports/mlb_env.js',
  'ingest.js', 'index.js', 'config.js',
].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
assert.ok(!/tsp\.live/i.test(touched), 'sport engines must not call tsp.live');
assert.ok(!/generate-picks-alpha/.test(touched));
assert.ok(touched.includes('blendWithMarket'));
assert.ok(touched.includes('calibrateAll(candidates)'));
{
  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(idx.indexOf('calibrateAll(candidates)') > idx.indexOf('projectAll(snap)'));
}

function synthEvent(home, away, opts = {}) {
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

function byMarket(cands, market) {
  const row = cands.find(c => c.market === market);
  assert.ok(row, `missing ${market}`);
  return row;
}

// ── NFL / CFB formula ──
{
  const proj = epa.footballProjection({
    sport: 'NFL',
    home: 'Kansas City Chiefs',
    away: 'Buffalo Bills',
    standings: {},
    efficiency: {
      'Kansas City Chiefs': { offEpa: 0.10, defEpa: 0.04 },
      'Buffalo Bills': { offEpa: 0.00, defEpa: 0.00 },
    },
  });
  const plays = epa.SPORT_CFG.NFL.plays;
  const expectedMargin = ((0.10 - 0.00) - (0.00 - 0.04)) * plays + config.HFA.NFL;
  const expectedTotal = 45 + ((0.10 - 0.00) + (0.00 - 0.04)) * plays;
  assert.ok(Math.abs(proj.modelMargin - expectedMargin) < 1e-9);
  assert.ok(Math.abs(proj.modelTotal - expectedTotal) < 1e-9);
  assert.strictEqual(proj.methods.ml, 'nfl-epa-v1-ml');
  assert.strictEqual(proj.methods.spread, 'nfl-epa-v1-spread');
  assert.strictEqual(proj.methods.total, 'nfl-epa-v1-total');
  assert.strictEqual(proj.methods.family, 'nfl-epa-v1');
  assert.strictEqual(proj.uncertainty, epa.SPORT_CFG.NFL.epaUncertainty);
}

{
  const proj = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Iowa Hawkeyes',
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0.05, defEpa: 0.02 },
      'Iowa Hawkeyes': { offEpa: 0.01, defEpa: 0.00 },
    },
  });
  const plays = epa.SPORT_CFG.NCAAF.plays;
  const expectedMargin = ((0.05 - 0.00) - (0.01 - 0.02)) * plays + config.HFA.NCAAF;
  assert.ok(Math.abs(proj.modelMargin - expectedMargin) < 1e-9);
  assert.strictEqual(proj.methods.family, 'cfb-epa-v1');
  assert.strictEqual(proj.uncertainty, epa.SPORT_CFG.NCAAF.epaUncertainty);
}

// Sierra blend only when standings are clean; unclean keeps the seed.
{
  const clean = epa.sierraAdjust(
    { offEpa: 0, defEpa: 0 },
    { pf: 34, pa: 16, wins: 3, losses: 1 },
    epa.SPORT_CFG.NFL
  );
  assert.strictEqual(clean.adjusted, true);
  assert.ok(clean.offEpa > 0, 'high scoring offense should lift offEpa');
  assert.ok(clean.defEpa > 0, 'low points allowed should lift defEpa');
  const dirty = epa.sierraAdjust(
    { offEpa: 0.1, defEpa: 0.02 },
    { pf: 34, pa: 16 },
    epa.SPORT_CFG.NFL
  );
  assert.strictEqual(dirty.adjusted, false);
  assert.strictEqual(dirty.offEpa, 0.1);
  assert.strictEqual(epa.isCleanEpa({ offEpa: 5, defEpa: 0.1 }), false);
}

// ── NFL candidates: EPA vs fallback ──
{
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const standings = {
    [home]: { pf: 30, pa: 20, wins: 2, losses: 1 },
    [away]: { pf: 18, pa: 24, wins: 1, losses: 2 },
  };
  const ev = synthEvent(home, away);
  const missing = nfl.project({ oddsEvents: [ev], standings, efficiency: {} });
  const absent = nfl.project({ oddsEvents: [ev], standings });
  assert.ok(missing.length >= 6, 'fallback must still emit a slate');
  assert.ok(absent.length === missing.length);
  for (const c of missing) assert.ok(/nfl-normal-|nfl-total-baseline/.test(c.projMethod), c.projMethod);
  const hPow = powerFromStandings(standings[home]);
  const aPow = powerFromStandings(standings[away]);
  assert.strictEqual(byMarket(missing, 'Spread').modelProjection, +((hPow - aPow) + config.HFA.NFL).toFixed(2));
  assert.strictEqual(byMarket(missing, 'Total').modelProjection, +(45 + Math.abs(hPow + aPow) * 0.05).toFixed(2));
  assert.strictEqual(byMarket(missing, 'Moneyline').uncertainty, 0.16);
  assert.strictEqual(byMarket(missing, 'Moneyline').projMethod, 'nfl-normal-ml');
  assert.strictEqual(byMarket(missing, 'Spread').projMethod, 'nfl-normal-spread');
  assert.strictEqual(byMarket(missing, 'Total').projMethod, 'nfl-total-baseline');

  const blind = nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} });
  assert.ok(blind.length >= 6);
  assert.strictEqual(byMarket(blind, 'Moneyline').uncertainty, 0.26);

  const partial = nfl.project({
    oddsEvents: [ev],
    standings,
    efficiency: { [home]: { offEpa: 0.12, defEpa: 0.04, offSuccess: 0.48, defSuccess: 0.42 } },
  });
  assert.strictEqual(byMarket(partial, 'Moneyline').projMethod, 'nfl-normal-ml');

  const bogus = nfl.project({
    oddsEvents: [ev],
    standings,
    efficiency: {
      [home]: { offEpa: 5, defEpa: 0.1 },
      [away]: { offEpa: 0.1, defEpa: 0.1 },
    },
  });
  assert.strictEqual(byMarket(bogus, 'Moneyline').projMethod, 'nfl-normal-ml');

  const withEpa = nfl.project({
    oddsEvents: [ev],
    standings,
    efficiency: {
      [home]: { offEpa: 0.12, defEpa: 0.06, offSuccess: 0.48, defSuccess: 0.45 },
      [away]: { offEpa: 0.01, defEpa: -0.04, offSuccess: 0.43, defSuccess: 0.40 },
    },
  });
  assert.strictEqual(byMarket(withEpa, 'Moneyline').projMethod, 'nfl-epa-v1-ml');
  assert.strictEqual(byMarket(withEpa, 'Spread').projMethod, 'nfl-epa-v1-spread');
  assert.strictEqual(byMarket(withEpa, 'Total').projMethod, 'nfl-epa-v1-total');
  assert.ok(byMarket(withEpa, 'Moneyline').uncertainty >= 0.12);
  assert.ok(byMarket(withEpa, 'Moneyline').uncertainty <= 0.14);
  assert.notStrictEqual(
    byMarket(withEpa, 'Spread').modelProjection,
    byMarket(missing, 'Spread').modelProjection
  );
  assert.ok(withEpa.every(c => c.coverProb == null));
  assert.ok(withEpa.every(c => Number.isFinite(c.modelRawP)));
  const calibrated = calibrate.calibrateAll(withEpa);
  assert.ok(calibrated.every(c => Number.isFinite(c.coverProb)));
  assert.ok(calibrated.some(c => Math.abs(c.coverProb - c.modelRawP) > 1e-6));

  // Fuzzy mascot match still finds the prior.
  const fuzzy = nfl.project({
    oddsEvents: [synthEvent('Chiefs', 'Bills')],
    standings: {},
    efficiency: {
      'Kansas City Chiefs': { offEpa: 0.10, defEpa: 0.05 },
      'Buffalo Bills': { offEpa: 0.00, defEpa: 0.00 },
    },
  });
  assert.strictEqual(byMarket(fuzzy, 'Moneyline').projMethod, 'nfl-epa-v1-ml');
}

// ── CFB ──
{
  const home = 'Ohio State Buckeyes';
  const away = 'Iowa Hawkeyes';
  const standings = {
    [home]: { pf: 42, pa: 17, wins: 3, losses: 0 },
    [away]: { pf: 21, pa: 18, wins: 2, losses: 1 },
  };
  const ev = synthEvent(home, away, { total: 52.5, spread: -7.5 });
  const missing = cfb.project({ oddsEvents: [ev], standings, efficiency: {} });
  assert.ok(missing.length >= 6);
  assert.strictEqual(byMarket(missing, 'Moneyline').projMethod, 'cfb-normal-ml');
  assert.strictEqual(byMarket(missing, 'Spread').projMethod, 'cfb-normal-spread');
  assert.strictEqual(byMarket(missing, 'Total').projMethod, 'cfb-total-baseline');
  assert.strictEqual(byMarket(missing, 'Moneyline').uncertainty, 0.22);
  const hPow = powerFromStandings(standings[home]);
  const aPow = powerFromStandings(standings[away]);
  assert.strictEqual(byMarket(missing, 'Spread').modelProjection, +((hPow - aPow) + config.HFA.NCAAF).toFixed(2));

  const withEpa = cfb.project({
    oddsEvents: [ev],
    standings,
    efficiency: {
      [home]: { offEpa: 0.18, defEpa: 0.10, offSuccess: 0.50, defSuccess: 0.47 },
      [away]: { offEpa: -0.02, defEpa: 0.04, offSuccess: 0.42, defSuccess: 0.44 },
    },
  });
  assert.strictEqual(byMarket(withEpa, 'Moneyline').projMethod, 'cfb-epa-v1-ml');
  assert.strictEqual(byMarket(withEpa, 'Spread').projMethod, 'cfb-epa-v1-spread');
  assert.strictEqual(byMarket(withEpa, 'Total').projMethod, 'cfb-epa-v1-total');
  assert.ok(byMarket(withEpa, 'Moneyline').uncertainty >= 0.16);
  assert.ok(byMarket(withEpa, 'Moneyline').uncertainty <= 0.18);
  assert.notStrictEqual(
    byMarket(withEpa, 'Spread').modelProjection,
    byMarket(missing, 'Spread').modelProjection
  );
}

// ── MLB SP + park ──
{
  const rocks = 'Colorado Rockies';
  const dodgers = 'Los Angeles Dodgers';
  const standings = {
    [rocks]: { pf: 700, pa: 680, wins: 80, losses: 70 },
    [dodgers]: { pf: 700, pa: 680, wins: 80, losses: 70 },
  };
  const baseTotal = 8.6 + Math.abs(20 + 20) * 0.02;
  assert.strictEqual(baseTotal, 9.4);

  const empty = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  });
  assert.ok(empty.length >= 6, 'empty SP/park must still emit candidates');
  assert.strictEqual(byMarket(empty, 'Moneyline').projMethod, 'mlb-pythag-lite+hfa');
  assert.strictEqual(byMarket(empty, 'Spread').projMethod, 'mlb-normal-rl');
  assert.strictEqual(byMarket(empty, 'Total').projMethod, 'mlb-total-baseline');
  assert.strictEqual(byMarket(empty, 'Spread').modelProjection, +config.HFA.MLB.toFixed(2));
  assert.strictEqual(byMarket(empty, 'Total').modelProjection, +baseTotal.toFixed(2));

  const namedOnly = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [{
      homeTeam: dodgers,
      awayTeam: rocks,
      homeProbable: { name: 'Yoshinobu Yamamoto', id: 11 },
      awayProbable: { name: 'Austin Gomber', id: 22 },
    }],
  });
  assert.strictEqual(byMarket(namedOnly, 'Moneyline').projMethod, 'mlb-pythag-lite+hfa');
  assert.strictEqual(byMarket(namedOnly, 'Moneyline').assumedStarter.name, 'Yoshinobu Yamamoto');
  assert.strictEqual(byMarket(namedOnly, 'Moneyline').assumedStarter.teamSide, 'home');
  assert.ok(byMarket(namedOnly, 'Total').assumedStarter == null);

  const neutral = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: { [dodgers]: { park: 1.0, abbr: 'LAD', venue: 'Dodger Stadium' } },
    mlbPitcherStats: {},
  });
  const coors = mlb.project({
    oddsEvents: [synthEvent(rocks, dodgers, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: { [rocks]: { park: 1.21, abbr: 'COL', venue: 'Coors Field' } },
    mlbPitcherStats: {},
  });
  const neutralTotal = byMarket(neutral, 'Total').modelProjection;
  const coorsTotal = byMarket(coors, 'Total').modelProjection;
  assert.ok(coorsTotal > neutralTotal, `Coors ${coorsTotal} should exceed neutral ${neutralTotal}`);
  assert.ok(coorsTotal > baseTotal);
  assert.strictEqual(byMarket(coors, 'Total').projMethod, 'mlb-sp-park-v1-total');
  assert.strictEqual(byMarket(coors, 'Moneyline').projMethod, 'mlb-sp-park-v1-ml');
  assert.strictEqual(byMarket(coors, 'Spread').projMethod, 'mlb-sp-park-v1-spread');
  // Park does not invent a side's margin by itself when powers match.
  assert.strictEqual(byMarket(coors, 'Spread').modelProjection, byMarket(neutral, 'Spread').modelProjection);

  const spStats = {
    byId: {
      '11': { id: 11, name: 'Yoshinobu Yamamoto', quality: 1.4, ip: 160 },
      '22': { id: 22, name: 'Austin Gomber', quality: -0.8, ip: 140 },
    },
    byName: {},
    byTeam: {},
  };
  const withSp = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: { [dodgers]: { park: 1.0, abbr: 'LAD' } },
    mlbPitcherStats: spStats,
    espnGames: [{
      homeTeam: dodgers,
      awayTeam: rocks,
      homeProbable: { name: 'Yoshinobu Yamamoto', id: 11 },
      awayProbable: { name: 'Austin Gomber', id: 22 },
    }],
  });
  assert.ok(
    byMarket(withSp, 'Spread').modelProjection > byMarket(neutral, 'Spread').modelProjection,
    'better home SP should raise home margin'
  );
  assert.strictEqual(byMarket(withSp, 'Moneyline').assumedStarter.name, 'Yoshinobu Yamamoto');
  assert.strictEqual(byMarket(withSp, 'Moneyline').projMethod, 'mlb-sp-park-v1-ml');

  const badStaff = {
    byId: {
      '11': { id: 11, name: 'A', quality: -1.5 },
      '22': { id: 22, name: 'B', quality: -1.5 },
    },
  };
  const goodStaff = {
    byId: {
      '11': { id: 11, name: 'A', quality: 1.2 },
      '22': { id: 22, name: 'B', quality: 1.2 },
    },
  };
  const espnPair = [{
    homeTeam: dodgers,
    awayTeam: rocks,
    homeProbable: { name: 'A', id: 11 },
    awayProbable: { name: 'B', id: 22 },
  }];
  const badTot = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: { [dodgers]: { park: 1.0 } },
    mlbPitcherStats: badStaff,
    espnGames: espnPair,
  });
  const goodTot = mlb.project({
    oddsEvents: [synthEvent(dodgers, rocks, { total: 8.5, spread: -1.5 })],
    standings,
    parkFactors: { [dodgers]: { park: 1.0 } },
    mlbPitcherStats: goodStaff,
    espnGames: espnPair,
  });
  assert.ok(byMarket(badTot, 'Total').modelProjection > byMarket(goodTot, 'Total').modelProjection);
}

// SP helpers
{
  assert.strictEqual(env.mlbSeasonFromDate('2026-09-22'), 2026);
  assert.strictEqual(env.mlbSeasonFromDate('2026-02-01'), 2025);
  assert.ok(Math.abs(env.parseIp('142.1') - (142 + 1 / 3)) < 1e-9);
  assert.strictEqual(env.parseIp('1443.0'), 1443);
  const fip = env.fipFromCounting({
    homeRuns: 20, baseOnBalls: 40, hitByPitch: 5, strikeOuts: 180, inningsPitched: '180.0',
  });
  const expectedFip = (13 * 20 + 3 * (40 + 5) - 2 * 180) / 180 + env.FIP_C;
  assert.ok(Math.abs(fip - expectedFip) < 1e-9);

  const idx = env.buildPitcherIndex({
    stats: [{ splits: [
      {
        stat: {
          homeRuns: 20, baseOnBalls: 40, hitByPitch: 5, strikeOuts: 180,
          inningsPitched: '180.0', era: '3.20', airOuts: 200,
        },
        player: { id: 99, fullName: 'Test Ace' },
      },
      {
        stat: {
          homeRuns: 0, baseOnBalls: 2, hitByPitch: 0, strikeOuts: 1,
          inningsPitched: '3.0', era: '1.00', airOuts: 5,
        },
        player: { id: 100, fullName: 'Cup Of Coffee' },
      },
    ]}],
  }, {
    stats: [{ splits: [{
      stat: {
        homeRuns: 170, baseOnBalls: 480, hitByPitch: 50, strikeOuts: 1400,
        inningsPitched: '1450.0', era: '4.80', airOuts: 1500,
      },
      team: { id: 115, name: 'Colorado Rockies' },
    }]}],
  });
  assert.ok(idx.byId['99']);
  assert.ok(!idx.byId['100']);
  assert.ok(idx.byName['test ace']);
  assert.ok(idx.byId['99'].quality > 0);
  assert.ok(idx.byTeam['Colorado Rockies']);

  const teamOnly = env.resolveSpQuality(
    { name: 'Open Spot', id: 999 },
    { byId: {}, byName: {}, byTeam: { 'Colorado Rockies': { quality: 1 } } },
    'Colorado Rockies'
  );
  assert.ok(Math.abs(teamOnly.quality - env.TEAM_PRIOR_WEIGHT) < 1e-9);
  assert.strictEqual(teamOnly.source, 'team');
  const player = env.resolveSpQuality(
    { name: 'Test Ace', id: 99 },
    idx,
    'Colorado Rockies'
  );
  assert.strictEqual(player.source, 'player');
  assert.ok(player.quality > 0);
  assert.strictEqual(env.resolveSpQuality(null, idx, 'Colorado Rockies'), null);

  const coorsPark = env.resolvePark('Colorado Rockies', {
    'Colorado Rockies': { park: 1.21, abbr: 'COL', venue: 'Coors Field' },
  }, null);
  assert.strictEqual(coorsPark.factor, 1.21);
  const byAbbr = env.resolvePark('Some Club', {
    'Colorado Rockies': { park: 1.21, abbr: 'COL' },
  }, { homeAbbr: 'COL' });
  assert.strictEqual(byAbbr.factor, 1.21);
  assert.strictEqual(env.resolvePark('Colorado Rockies', { 'Colorado Rockies': { park: 1.8 } }, null), null);
}

// Seeds + fail-soft ingest wiring. No StatsAPI call.
(async () => {
  const seeds = ingest.loadEfficiencySeeds();
  const parks = ingest.loadParkFactors();
  assert.strictEqual(Object.keys(seeds.NFL).length, 32);
  assert.ok(Object.keys(seeds.NCAAF).length >= 40);
  assert.ok(seeds.NFL['Kansas City Chiefs']);
  assert.ok(seeds.NFL['San Francisco 49ers']);
  assert.ok(seeds.NFL['Washington Commanders']);
  assert.ok(seeds.NCAAF['Ohio State Buckeyes']);
  assert.ok(seeds.NCAAF['Georgia Bulldogs']);
  assert.ok(!seeds.NFL._meta && !seeds.NCAAF._meta);
  assert.ok(parks['Colorado Rockies'].park >= 1.15 && parks['Colorado Rockies'].park <= 1.25);
  assert.ok(Object.keys(parks).length >= 30);
  assert.ok(parks['San Francisco Giants']);
  assert.ok(parks.Athletics || parks['Oakland Athletics']);

  const home = 'Detroit Lions';
  const away = 'Carolina Panthers';
  const standings = {
    [home]: { pf: 24, pa: 24 },
    [away]: { pf: 24, pa: 24 },
  };
  const fromSeed = nfl.project({
    oddsEvents: [synthEvent(home, away)],
    standings,
    efficiency: seeds.NFL,
  });
  const noSeed = nfl.project({
    oddsEvents: [synthEvent(home, away)],
    standings,
    efficiency: {},
  });
  assert.strictEqual(byMarket(fromSeed, 'Moneyline').projMethod, 'nfl-epa-v1-ml');
  assert.notStrictEqual(
    byMarket(fromSeed, 'Spread').modelProjection,
    byMarket(noSeed, 'Spread').modelProjection
  );

  const cfbSeed = cfb.project({
    oddsEvents: [synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes', { total: 51.5, spread: -6.5 })],
    standings: {},
    efficiency: seeds.NCAAF,
  });
  assert.strictEqual(byMarket(cfbSeed, 'Spread').projMethod, 'cfb-epa-v1-spread');

  const loaded = await ingest.loadSportEngines('2026-09-22', {
    fetchPitchers: async () => ({ byId: { '1': { quality: 0.4, name: 'Stub' } }, byName: {}, byTeam: {} }),
  });
  assert.strictEqual(Object.keys(loaded.efficiencyBySport.NFL).length, 32);
  assert.ok(Object.keys(loaded.efficiencyBySport.NCAAF).length >= 40);
  assert.ok(loaded.parkFactors['Colorado Rockies'].park >= 1.15);
  assert.ok(loaded.mlbPitcherStats.byId['1']);

  const failed = await ingest.loadSportEngines('2026-09-22', {
    loadSeeds: () => { throw new Error('seed down'); },
    loadParks: () => { throw new Error('park down'); },
    fetchPitchers: async () => { throw new Error('stats down'); },
  });
  assert.deepStrictEqual(failed.efficiencyBySport, { NFL: {}, NCAAF: {} });
  assert.deepStrictEqual(failed.parkFactors, {});
  assert.deepStrictEqual(failed.mlbPitcherStats, { byId: {}, byName: {}, byTeam: {} });

  const snap = {
    oddsBySport: {
      NFL: [synthEvent('Detroit Lions', 'Carolina Panthers')],
      NCAAF: [synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes', { total: 51.5, spread: -6.5 })],
      MLB: [synthEvent('Colorado Rockies', 'Los Angeles Dodgers', { total: 8.5, spread: -1.5 })],
      NBA: [synthEvent('Boston Celtics', 'New York Knicks')],
      NHL: [synthEvent('Colorado Avalanche', 'Dallas Stars')],
    },
    standingsBySport: {
      NFL: { 'Detroit Lions': { pf: 28, pa: 20 }, 'Carolina Panthers': { pf: 17, pa: 26 } },
      NCAAF: { 'Ohio State Buckeyes': { pf: 40, pa: 18 }, 'Iowa Hawkeyes': { pf: 22, pa: 20 } },
      MLB: { 'Colorado Rockies': { pf: 5, pa: 5 }, 'Los Angeles Dodgers': { pf: 4, pa: 4 } },
    },
    espnBySport: {},
    efficiencyBySport: failed.efficiencyBySport,
    parkFactors: failed.parkFactors,
    mlbPitcherStats: failed.mlbPitcherStats,
  };
  const slate = projectAll(snap);
  assert.ok(slate.some(c => c.sport === 'NFL' && c.projMethod === 'nfl-normal-ml'));
  assert.ok(slate.some(c => c.sport === 'NCAAF' && c.projMethod === 'cfb-normal-ml'));
  assert.ok(slate.some(c => c.sport === 'MLB' && c.projMethod === 'mlb-pythag-lite+hfa'));
  assert.ok(!slate.some(c => c.sport === 'NBA' || c.sport === 'NHL'));
  assert.deepStrictEqual(nba.project({}), []);
  assert.deepStrictEqual(nhl.project({}), []);

  const liveEngines = {
    oddsBySport: snap.oddsBySport,
    standingsBySport: snap.standingsBySport,
    espnBySport: {},
    efficiencyBySport: loaded.efficiencyBySport,
    parkFactors: loaded.parkFactors,
    mlbPitcherStats: {},
  };
  const engSlate = projectAll(liveEngines);
  assert.ok(engSlate.some(c => c.sport === 'NFL' && c.projMethod === 'nfl-epa-v1-ml'));
  assert.ok(engSlate.some(c => c.sport === 'NCAAF' && c.projMethod === 'cfb-epa-v1-ml'));
  assert.ok(engSlate.some(c => c.sport === 'MLB' && String(c.projMethod).startsWith('mlb-sp-park-v1')));
  const coorsRow = engSlate.find(c => c.sport === 'MLB' && c.market === 'Total' && c.homeTeam === 'Colorado Rockies');
  assert.ok(coorsRow, 'Rockies home total should still project when the park table is loaded');
  const paired = projectAll({
    oddsBySport: {
      MLB: [
        synthEvent('Los Angeles Dodgers', 'Colorado Rockies', { total: 8.5, spread: -1.5 }),
        synthEvent('Colorado Rockies', 'Los Angeles Dodgers', { total: 8.5, spread: -1.5 }),
      ],
    },
    standingsBySport: {
      MLB: {
        'Colorado Rockies': { pf: 700, pa: 680 },
        'Los Angeles Dodgers': { pf: 700, pa: 680 },
      },
    },
    espnBySport: {},
    efficiencyBySport: { NFL: {}, NCAAF: {} },
    parkFactors: loaded.parkFactors,
    mlbPitcherStats: {},
  });
  const coorsP = paired.find(c => c.homeTeam === 'Colorado Rockies' && c.market === 'Total').modelProjection;
  const ladP = paired.find(c => c.homeTeam === 'Los Angeles Dodgers' && c.market === 'Total').modelProjection;
  assert.ok(coorsP > ladP, `seed Coors ${coorsP} vs Dodgers ${ladP}`);

  console.log('PASS test-omega-sport-engines', {
    MODEL_VERSION: config.MODEL_VERSION,
    nflTeams: Object.keys(seeds.NFL).length,
    cfbTeams: Object.keys(seeds.NCAAF).length,
    coorsTotal: coorsP,
    dodgerTotal: ladP,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
