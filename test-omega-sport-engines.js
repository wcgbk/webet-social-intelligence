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

assert.strictEqual(config.MODEL_VERSION, 'v12.3.12-omega-vnext-desk-lock');
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
assert.ok(config.ENGINE_SOFT, 'ENGINE_SOFT exported');
assert.strictEqual(config.ENGINE_SOFT.MLB.maxAbsMarginAdj, 0.35);
assert.strictEqual(config.ENGINE_SOFT.MLB.maxAbsTotalAdj, 0.40);
assert.strictEqual(config.ENGINE_SOFT.NFL.maxAbsMarginAdj, 1.5);
assert.strictEqual(config.ENGINE_SOFT.NCAAF.maxAbsMarginAdj, 2.0);
assert.ok(/Grok Build 4\.7 xhigh redo of v12\.3\.7/.test(config.MODEL_NOTES));
assert.ok(/deeper MLB\/NFL\/NCAAF sport engines/i.test(config.MODEL_NOTES));
assert.ok(/HARD CAP/i.test(config.MODEL_NOTES));
assert.ok(/Soft-fail/i.test(config.MODEL_NOTES));
assert.ok(/STACKED/.test(config.MODEL_NOTES));
assert.strictEqual(require(path.join(root, 'walk_forward')).FIT_ENABLED, false);
assert.deepStrictEqual(config.PM_SOFT, {
  scoreWeightVsBook: 0.20,
  scoreWeightMove: 0.08,
  maxAbsScoreAdj: 0.03,
  venueCombine: 'average',
});
assert.deepStrictEqual(config.SELECT_WEIGHTS, {
  w_ev: 0.35,
  w_clv: 0.45,
  w_uncertainty: 0.20,
  corr_penalty: 0.15,
  softSportMixBonus: 0.02,
});
assert.deepStrictEqual(config.SHRINK_K, { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 });
assert.deepStrictEqual(config.MLB_CALIBRATION, {
  shrinkK: { Total: 0.46, Spread: 0.62, Moneyline: 0.30, default: 0.46 },
});
assert.ok(config.MLB_CALIBRATION.isotonicLo == null, 'MLB keeps the global isotonic band');
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.SPORTS_ENABLED.NHL, false);
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
  assert.ok(/nfl-epa-v1(-engines)?-ml/.test(byMarket(withEpa, 'Moneyline').projMethod), byMarket(withEpa, 'Moneyline').projMethod);
  assert.ok(/nfl-epa-v1(-engines)?-spread/.test(byMarket(withEpa, 'Spread').projMethod));
  assert.ok(/nfl-epa-v1(-engines)?-total/.test(byMarket(withEpa, 'Total').projMethod));
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
  // 700/150 + 680/150 = 9.2. Season totals are per game, not a +20 run power.
  const baseTotal = (700 / 150) + (680 / 150);
  assert.ok(Math.abs(baseTotal - 9.2) < 1e-9);

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
  assert.ok(/mlb-sp-park-v1(-engines)?-ml/.test(byMarket(withSp, 'Moneyline').projMethod), byMarket(withSp, 'Moneyline').projMethod);

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

// v12.3.11: ML, spreads, and totals blend to no-vig Pinnacle/Circa. Never prices[0].
{
  const edgeMod = require(path.join(root, 'edge'));
  const common = require(path.join(root, 'sports/_common'));
  const oddsMath = require(path.join(root, 'odds_math'));
  for (const f of ['sports/mlb.js', 'sports/nfl.js', 'sports/cfb.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.strictEqual((src.match(/prices\[0\]/g) || []).length, 0, `${f} must not blend to prices[0]`);
    assert.ok(src.includes('noVigPinnacleCircaImplied'), f);
  }
  const home = 'Los Angeles Dodgers';
  const away = 'San Francisco Giants';
  const ev = {
    home_team: home,
    away_team: away,
    commence_time: '2026-09-24T23:10:00Z',
    bookmakers: ['draftkings', 'fanduel', 'pinnacle', 'circa'].map((key) => {
      const spreadHome = key === 'pinnacle' ? -110 : key === 'circa' ? -108 : -105;
      const spreadAway = key === 'pinnacle' ? -110 : key === 'circa' ? -112 : -115;
      const over = key === 'pinnacle' ? -110 : key === 'circa' ? -112 : -105;
      const under = key === 'pinnacle' ? -110 : key === 'circa' ? -104 : -115;
      const mlHome = key === 'pinnacle' ? -130 : key === 'circa' ? -128 : -125;
      const mlAway = key === 'pinnacle' ? 110 : key === 'circa' ? 108 : 105;
      return {
        key,
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: mlHome }, { name: away, price: mlAway }] },
          { key: 'spreads', outcomes: [
            { name: home, price: spreadHome, point: -1.5 },
            { name: away, price: spreadAway, point: 1.5 },
          ]},
          { key: 'totals', outcomes: [
            { name: 'Over', price: over, point: 8.5 },
            { name: 'Under', price: under, point: 8.5 },
          ]},
        ],
      };
    }),
  };
  const cands = mlb.project({ oddsEvents: [ev], standings: {} });
  const spread = cands.find(c => c.market === 'Spread' && c.line === -1.5 && String(c.side).includes(home));
  const total = cands.find(c => c.market === 'Total' && /^Over/.test(c.side));
  const ml = cands.find(c => c.market === 'Moneyline' && c.side === home);
  const spreadBundles = edgeMod.collectMarketOutcomes(ev, 'spreads');
  const totalBundles = edgeMod.collectMarketOutcomes(ev, 'totals');
  const spreadAnchor = edgeMod.noVigPinnacleCircaImplied(spreadBundles, spreadBundles.find(b => b.side === home));
  const totalAnchor = edgeMod.noVigPinnacleCircaImplied(totalBundles, totalBundles.find(b => b.side === 'Over'));
  const pinSpread = oddsMath.noVigTwoWay(-110, -110).p1;
  const circaSpread = oddsMath.noVigTwoWay(-108, -112).p1;
  assert.ok(Math.abs(spreadAnchor - (pinSpread + circaSpread) / 2) < 1e-9, 'Pinnacle and Circa share the anchor equally');
  const dkSpread = oddsMath.americanToImplied(-105);
  assert.ok(Math.abs(spreadAnchor - dkSpread) > 0.005);
  const pSpread = common.spreadCoverProb(config.HFA.MLB, -1.5, 'MLB');
  const pTotal = common.totalCoverProb(8.6, 8.5, 'Over', 'MLB');
  assert.ok(Math.abs(spread.modelRawP - common.blendWithMarket(pSpread, spreadAnchor, 0.5)) < 1e-9);
  assert.ok(Math.abs(spread.modelRawP - common.blendWithMarket(pSpread, dkSpread, 0.5)) > 1e-4);
  assert.ok(Math.abs(total.modelRawP - common.blendWithMarket(pTotal, totalAnchor, 0.45)) < 1e-9);
  const pMl = common.mlFromSpread(config.HFA.MLB, 'MLB');
  const pinMl = oddsMath.noVigTwoWay(-130, 110).p1;
  const circaMl = oddsMath.noVigTwoWay(-128, 108).p1;
  const mlAnchor = (pinMl + circaMl) / 2;
  assert.ok(Math.abs(ml.modelRawP - common.blendWithMarket(pMl, mlAnchor, 0.5)) < 1e-9);
  assert.ok(Math.abs(ml.modelRawP - common.blendWithMarket(pMl, oddsMath.americanToImplied(-130), 0.5)) > 1e-3, 'ML anchor is no-vig, not the vigged Pinnacle price');

  const softOnly = [
    { side: 'Home', point: -3, prices: [{ book: 'draftkings', american: -105 }, { book: 'bookmaker', american: -110 }] },
    { side: 'Away', point: 3, prices: [{ book: 'draftkings', american: -115 }, { book: 'bookmaker', american: -110 }] },
  ];
  const fallback = edgeMod.noVigPinnacleCircaImplied(softOnly, softOnly[0]);
  assert.ok(Math.abs(fallback - 0.5) < 1e-9, 'missing Pinnacle/Circa falls back to sharp no-vig, not prices[0]');

  // Broken Pinnacle pair must not be mixed with DraftKings. Circa posts both sides.
  const splitPin = [
    { side: 'Home', point: -1.5, prices: [{ book: 'pinnacle', american: -150 }, { book: 'circa', american: -110 }, { book: 'draftkings', american: -105 }] },
    { side: 'Away', point: 1.5, prices: [{ book: 'circa', american: -110 }, { book: 'draftkings', american: -115 }] },
  ];
  const paired = edgeMod.sharpFairForSide(splitPin, 'Home', -1.5);
  assert.ok(Math.abs(paired - 0.5) < 1e-9, 'fair uses the Circa pair when Pinnacle is one-sided');
}

// Season run totals must not saturate the moneyline, and a starter still moves it.
{
  const home = 'Los Angeles Dodgers';
  const away = 'Colorado Rockies';
  const standings = {
    [home]: { pf: 780, pa: 560, wins: 96, losses: 54 },
    [away]: { pf: 620, pa: 860, wins: 52, losses: 98 },
  };
  const ev = synthEvent(home, away, { total: 8.5, spread: -1.5 });
  const bare = mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: {}, espnGames: [],
  });
  const pBare = byMarket(bare, 'Moneyline').modelRawP;
  assert.ok(pBare > 0.5 && pBare < 0.85, `lopsided season slate clamped or flipped: ${pBare}`);
  assert.ok(Math.abs(byMarket(bare, 'Spread').modelProjection) < 4, byMarket(bare, 'Spread').modelProjection);
  const withSp = mlb.project({
    oddsEvents: [ev],
    standings,
    parkFactors: {},
    mlbPitcherStats: {
      byId: {
        '11': { id: '11', quality: 1.8, source: 'player', name: 'Ace' },
        '22': { id: '22', quality: -1.2, source: 'player', name: 'Inn' },
      },
      byName: {},
      byTeam: {},
    },
    espnGames: [{
      homeTeam: home,
      awayTeam: away,
      homeProbable: { id: 11, name: 'Ace' },
      awayProbable: { id: 22, name: 'Inn' },
    }],
  });
  const pSp = byMarket(withSp, 'Moneyline').modelRawP;
  assert.ok(pSp - pBare > 0.01, `starter residual ${pSp - pBare} did not move the lopsided slate`);
  const noGames = env.mlbStandingsEnv({ pf: 700, pa: 680 }, { pf: 640, pa: 700 });
  assert.strictEqual(noGames.usedStandings, false);
  assert.strictEqual(noGames.modelTotal, 8.6);
  const perGame = env.mlbStandingsEnv(
    { pf: 5.0, pa: 4.0, wins: 90, losses: 60 },
    { pf: 4.2, pa: 4.4, wins: 75, losses: 75 }
  );
  assert.strictEqual(perGame.usedStandings, true);
  assert.ok(Math.abs(perGame.modelTotal - 8.8) < 1e-9);
  assert.ok(Math.abs(perGame.modelMargin - (0.6 + config.HFA.MLB)) < 1e-9);
  const seasonNfl = powerFromStandings({ pf: 360, pa: 240, wins: 12, losses: 4 }, 'NFL');
  assert.ok(Math.abs(seasonNfl - ((360 - 240) / 16)) < 1e-9);
  assert.strictEqual(powerFromStandings({ pf: 30, pa: 20, wins: 2, losses: 1 }, 'NFL'), 10);
  const chiefs = 'Kansas City Chiefs';
  const bills = 'Buffalo Bills';
  const seasonFb = nfl.project({
    oddsEvents: [synthEvent(chiefs, bills)],
    standings: {
      [chiefs]: { pf: 360, pa: 240, wins: 12, losses: 4 },
      [bills]: { pf: 280, pa: 300, wins: 8, losses: 8 },
    },
    efficiency: {},
  });
  const hPow = powerFromStandings({ pf: 360, pa: 240, wins: 12, losses: 4 }, 'NFL');
  const aPow = powerFromStandings({ pf: 280, pa: 300, wins: 8, losses: 8 }, 'NFL');
  assert.strictEqual(byMarket(seasonFb, 'Spread').modelProjection, +((hPow - aPow) + config.HFA.NFL).toFixed(2));
  assert.ok(Math.abs(byMarket(seasonFb, 'Spread').modelProjection) < 20);
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
  assert.ok(/nfl-epa-v1(-engines)?-ml/.test(byMarket(fromSeed, 'Moneyline').projMethod), byMarket(fromSeed, 'Moneyline').projMethod);
  assert.notStrictEqual(
    byMarket(fromSeed, 'Spread').modelProjection,
    byMarket(noSeed, 'Spread').modelProjection
  );

  const cfbSeed = cfb.project({
    oddsEvents: [synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes', { total: 51.5, spread: -6.5 })],
    standings: {},
    efficiency: seeds.NCAAF,
  });
  assert.ok(/cfb-epa-v1(-engines)?-spread/.test(byMarket(cfbSeed, 'Spread').projMethod), byMarket(cfbSeed, 'Spread').projMethod);

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
  assert.ok(engSlate.some(c => c.sport === 'NFL' && /nfl-epa-v1/.test(c.projMethod)));
  assert.ok(engSlate.some(c => c.sport === 'NCAAF' && /cfb-epa-v1/.test(c.projMethod)));
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


// ── v12.3.7 ENGINE_SOFT caps + soft-fail ──
{
  const absurd = env.applyBullpenAdj({
    modelMargin: 0,
    modelTotal: 8.6,
    homeBullpen: { quality: 9 },
    awayBullpen: { quality: -9 },
    caps: config.ENGINE_SOFT.MLB,
  });
  assert.ok(absurd.capped);
  assert.ok(Math.abs(absurd.marginAdj) <= config.ENGINE_SOFT.MLB.maxAbsMarginAdj + 1e-12);
  assert.ok(Math.abs(absurd.totalAdj) <= config.ENGINE_SOFT.MLB.maxAbsTotalAdj + 1e-12);

  const softBp = env.applyBullpenAdj({
    modelMargin: 1, modelTotal: 9, homeBullpen: null, awayBullpen: null, caps: config.ENGINE_SOFT.MLB,
  });
  assert.strictEqual(softBp.usedBullpen, false);
  assert.strictEqual(softBp.marginAdj, 0);
  assert.strictEqual(softBp.modelMargin, 1);

  // Named SP without team row → no bullpen
  assert.strictEqual(env.resolveBullpenQuality({ quality: 1, source: 'player' }, 'Dodgers', { byTeam: {} }), null);
  // Team-source SP → no bullpen (avoid double-count)
  assert.strictEqual(env.resolveBullpenQuality({ quality: 1, source: 'team' }, 'Dodgers', {
    byTeam: { 'Los Angeles Dodgers': { quality: 0.2 } },
  }), null);
}

{
  const sm = epa.successMarginAdj(
    { offSuccess: 0.99, defSuccess: 0.99 },
    { offSuccess: 0.01, defSuccess: 0.01 },
    config.ENGINE_SOFT.NFL
  );
  assert.ok(sm.capped);
  assert.ok(Math.abs(sm.marginAdj) <= config.ENGINE_SOFT.NFL.maxAbsMarginAdj + 1e-12);

  const soft = epa.successMarginAdj(
    { offSuccess: null, defSuccess: 0.4 },
    { offSuccess: 0.4, defSuccess: 0.4 },
    config.ENGINE_SOFT.NFL
  );
  assert.strictEqual(soft.used, false);
  assert.strictEqual(soft.marginAdj, 0);

  const proj = epa.footballProjection({
    sport: 'NFL',
    home: 'Kansas City Chiefs',
    away: 'Buffalo Bills',
    standings: {},
    efficiency: {
      'Kansas City Chiefs': { offEpa: 0.10, defEpa: 0.04, offSuccess: 0.55, defSuccess: 0.50 },
      'Buffalo Bills': { offEpa: 0.00, defEpa: 0.00, offSuccess: 0.40, defSuccess: 0.40 },
    },
  });
  assert.ok(proj.engineSoft && proj.engineSoft.used);
  assert.ok(String(proj.methods.ml).includes('engines'));
}

{
  const tm = epa.talentMarginAdj(
    { talent: 3.5 }, { talent: -3.5 },
    { ...config.ENGINE_SOFT.NCAAF, talentPtsPerUnit: 20, talentWeight: 1 }
  );
  assert.ok(tm.capped);
  assert.ok(Math.abs(tm.marginAdj) <= config.ENGINE_SOFT.NCAAF.maxAbsMarginAdj + 1e-12);

  const soft = epa.talentMarginAdj({ talent: 1.2 }, { offEpa: 0.1 }, config.ENGINE_SOFT.NCAAF);
  assert.strictEqual(soft.used, false);

  const withTalent = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Iowa Hawkeyes',
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0.05, defEpa: 0.02, talent: 2.0 },
      'Iowa Hawkeyes': { offEpa: 0.01, defEpa: 0.00, talent: 0.2 },
    },
  });
  assert.ok(withTalent.engineSoft && withTalent.engineSoft.used);
  assert.ok(String(withTalent.methods.family).includes('engines'));

  const noTalent = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Iowa Hawkeyes',
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0.05, defEpa: 0.02 },
      'Iowa Hawkeyes': { offEpa: 0.01, defEpa: 0.00 },
    },
  });
  assert.ok(!noTalent.engineSoft || !noTalent.engineSoft.used);
  assert.strictEqual(noTalent.methods.family, 'cfb-epa-v1');
}

{
  // Empty QB map → continuity 0
  const gd = require(path.join(root, 'sports/game_day'));
  const empty = gd.qbContinuityAdjust('NFL', null, null, {}, config.ENGINE_SOFT);
  assert.strictEqual(empty.used, false);
  assert.strictEqual(empty.marginAdj, 0);
  const cont = gd.qbContinuityAdjust(
    'NFL',
    null,
    { qbStatus: 'out', qbName: 'X' },
    { 'Buffalo Bills': { qbStatus: 'out' } },
    config.ENGINE_SOFT
  );
  assert.ok(cont.used);
  assert.ok(Math.abs(cont.marginAdj) <= config.ENGINE_SOFT.NFL.qbContinuityPts + 1e-12);
}

{
  // Talent seed merges without wiping EPA
  const seeds = ingest.loadEfficiencySeeds();
  assert.ok(seeds.NCAAF['Ohio State Buckeyes'].offEpa != null);
  assert.strictEqual(seeds.NCAAF['Ohio State Buckeyes'].talent, 2.4);
  assert.strictEqual(seeds.NCAAF['Ohio State Buckeyes'].talentScale, 'centered');
  assert.strictEqual(epa.talentScaleMode(ingest.talentSeedMeta()), 'centered');
}

{
  // Centered talent above 5 must stay a positive overlay, not flip to a 0–100 score.
  assert.strictEqual(epa.normalizeTalent(2.4), 2.4);
  assert.strictEqual(epa.normalizeTalent(6), 3.5);
  assert.strictEqual(epa.normalizeTalent(80), null);
  const pct = epa.normalizeTalent(80, 'pct_0_100');
  assert.ok(pct > 1.5 && pct < 2.0, `pct talent ${pct}`);

  const strong = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Iowa Hawkeyes',
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0, defEpa: 0, talent: 6, talentScale: 'centered' },
      'Iowa Hawkeyes': { offEpa: 0, defEpa: 0, talent: 0, talentScale: 'centered' },
    },
  });
  const flat = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Iowa Hawkeyes',
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0, defEpa: 0, talent: 0, talentScale: 'centered' },
      'Iowa Hawkeyes': { offEpa: 0, defEpa: 0, talent: 0, talentScale: 'centered' },
    },
  });
  assert.ok(strong.modelMargin > flat.modelMargin, 'centered 6 is not a weak 0–100 score');
}

{
  // Same-sign bullpen must hit the total cap (opposite signs wash the total).
  const tot = env.applyBullpenAdj({
    modelMargin: 0,
    modelTotal: 8.6,
    homeBullpen: { quality: 9 },
    awayBullpen: { quality: 9 },
    caps: config.ENGINE_SOFT.MLB,
  });
  assert.ok(tot.capped);
  assert.ok(Math.abs(tot.totalAdj) <= config.ENGINE_SOFT.MLB.maxAbsTotalAdj + 1e-12);
  assert.ok(Math.abs(tot.totalAdj) > 0.3);

  const band = env.applyBullpenAdj({
    modelMargin: 0,
    modelTotal: 14.5,
    homeBullpen: { quality: -1.5 },
    awayBullpen: { quality: -1.5 },
    caps: config.ENGINE_SOFT.MLB,
  });
  assert.ok(band.modelTotal <= 14.5 + 1e-12);
  assert.ok(band.modelTotal >= 5.5 - 1e-12);

  const std = env.mlbSpKnownStd(
    { quality: 0.4, source: 'player' },
    { quality: -0.2, source: 'player' },
    config.ENGINE_SOFT.MLB
  );
  assert.ok(Math.abs(std - config.SPORT_SPREAD_STD.MLB * (1 - 0.08)) < 1e-9);
  assert.strictEqual(env.mlbSpKnownStd(
    { quality: 0.4, source: 'player' },
    { quality: -0.2, source: 'player' },
    { spKnownStdTighten: 0, maxStdTighten: 0.10 }
  ), null);
  assert.strictEqual(env.mlbSpKnownStd(
    { quality: 0.4, source: 'team' },
    { quality: 0.2, source: 'player' },
    config.ENGINE_SOFT.MLB
  ), null);
  const huge = env.mlbSpKnownStd(
    { quality: 1, source: 'player' },
    { quality: 1, source: 'player' },
    { spKnownStdTighten: 0.9, maxStdTighten: 0.9 }
  );
  assert.ok(Math.abs(huge - config.SPORT_SPREAD_STD.MLB * 0.9) < 1e-9);
}

{
  // Success + continuity together cannot pass the NFL stack cap.
  const caps = epa.applyStackedMarginCap(10, [
    { key: 'success', adj: 1.5 },
    { key: 'continuity', adj: 0.55 },
  ], config.ENGINE_SOFT.NFL.maxAbsMarginAdj);
  assert.ok(caps.capped);
  assert.ok(Math.abs(caps.sum) <= config.ENGINE_SOFT.NFL.maxAbsMarginAdj + 1e-9);
  assert.ok(Math.abs(caps.modelMargin - (10 - 2.05 + caps.sum)) < 1e-9);

  const ev = synthEvent('Kansas City Chiefs', 'Buffalo Bills', { total: 45.5, spread: -3 });
  const plain = nfl.project({
    oddsEvents: [ev],
    standings: {},
    efficiency: {
      'Kansas City Chiefs': { offEpa: 0, defEpa: 0 },
      'Buffalo Bills': { offEpa: 0, defEpa: 0 },
    },
    gameDay: {},
  });
  const deep = nfl.project({
    oddsEvents: [ev],
    standings: {},
    efficiency: {
      'Kansas City Chiefs': { offEpa: 0, defEpa: 0, offSuccess: 0.9, defSuccess: 0.9 },
      'Buffalo Bills': { offEpa: 0, defEpa: 0, offSuccess: 0.1, defSuccess: 0.1 },
    },
    gameDay: {
      qbStatusBySport: { NFL: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'X' } } },
    },
  });
  const plainM = byMarket(plain, 'Moneyline').modelProjection;
  const deepRow = byMarket(deep, 'Moneyline');
  const deepM = deepRow.modelProjection;
  assert.ok(deepRow.engineSoft.stacked.capped);
  assert.ok(Math.abs(deepRow.engineSoft.stacked.sum) <= config.ENGINE_SOFT.NFL.maxAbsMarginAdj + 1e-9);
  // HFA 2.1 + QB-out 1.75 + stacked engine 1.5. Plain is HFA only.
  assert.ok(Math.abs((deepM - plainM) - (1.75 + config.ENGINE_SOFT.NFL.maxAbsMarginAdj)) < 0.02);

  const cfbDeep = cfb.project({
    oddsEvents: [synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes', { total: 51.5, spread: -6.5 })],
    standings: {},
    efficiency: {
      'Ohio State Buckeyes': { offEpa: 0, defEpa: 0, talent: 3.5, talentScale: 'centered' },
      'Iowa Hawkeyes': { offEpa: 0, defEpa: 0, talent: -3.5, talentScale: 'centered' },
    },
    gameDay: {
      qbStatusBySport: { NCAAF: { 'Iowa Hawkeyes': { qbStatus: 'out', qbName: 'X' } } },
    },
  });
  const cfbRow = byMarket(cfbDeep, 'Moneyline');
  assert.ok(Math.abs(cfbRow.engineSoft.stacked.sum) <= config.ENGINE_SOFT.NCAAF.maxAbsMarginAdj + 1e-9);
  assert.ok(cfbRow.engineSoft.stacked.capped);
}

{
  // One bad event does not blank the rest of the slate.
  const kept = nfl.project({
    oddsEvents: [null, synthEvent('Kansas City Chiefs', 'Buffalo Bills')],
    standings: {},
    efficiency: {},
  });
  assert.ok(kept.length >= 3);
  assert.doesNotThrow(() => {
    mlb.project({ oddsEvents: [synthEvent('Los Angeles Dodgers', 'Colorado Rockies', { total: 8.5, spread: -1.5 })], mlbPitcherStats: null, parkFactors: null });
    cfb.project({ oddsEvents: [null, synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes')], efficiency: null, gameDay: null });
  });
}


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
