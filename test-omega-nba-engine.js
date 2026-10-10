'use strict';
/**
 * NBA vnext engine, shadow only. SPORTS_ENABLED.NBA stays false.
 * No network. No blob writes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const id = require(path.join(root, 'sports/team_identity'));
const nba = require(path.join(root, 'sports/nba'));
const gd = require(path.join(root, 'sports/game_day'));
const ingest = require(path.join(root, 'ingest'));
const { projectAll } = require(path.join(root, 'index'));
const { calibrateAll, clearCalParamsCache } = require(path.join(root, 'calibrate'));
const { attachEv } = require(path.join(root, 'edge'));
const { applyGates } = require(path.join(root, 'gates'));
const { selectStraights } = require(path.join(root, 'select'));
const shadow = require(path.join(root, 'nba_shadow'));

const ids = require(path.join(root, 'sports/data/nba-team-ids.json'));
const seed = require(path.join(root, 'sports/data/nba-net-rating-seed.json'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.19-omega-vnext-parlay-decorr');
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.NBA_SHADOW.enabled, true);
assert.strictEqual(config.SPORTS_ENABLED.NHL, true);
assert.strictEqual(config.GATES.minEV.NBA, 0.03);
assert.strictEqual(config.GATES.minCoverProb.NBA, undefined);
assert.strictEqual(config.GATES.minCoverProb.default, 0.48);
assert.strictEqual(config.SPORT_SPREAD_STD.NBA, 12);
assert.strictEqual(config.SPORT_TOTAL_STD.NBA, 18);
assert.ok(config.HFA.NBA >= 2.0 && config.HFA.NBA <= 2.5);
assert.strictEqual(config.HFA.NBA, 2.5);
assert.strictEqual(shadow.ODDS_CREDITS_PER_RUN, 9);
assert.strictEqual(shadow.ODDS_REGIONS, 'us,us2,eu');
assert.strictEqual(shadow.ODDS_MARKETS, 'h2h,spreads,totals');

// ── identity: all 30 teams, no mascot / last-word match ──
{
  const teams = Object.values(ids.teams);
  assert.strictEqual(teams.length, 30);
  assert.strictEqual(ids._meta.teamCount, 30);
  const seen = new Set();
  for (const team of teams) {
    assert.ok(team.espnId, team.displayName);
    assert.strictEqual(id.resolveTeamId('NBA', team.displayName), String(team.espnId), team.displayName);
    seen.add(String(team.espnId));
    for (const name of team.oddsNames || []) {
      assert.strictEqual(id.resolveTeamId('NBA', name), String(team.espnId), name);
    }
  }
  assert.strictEqual(seen.size, 30);
  assert.strictEqual(id.resolveTeamId('NBA', 'LA Clippers'), '12');
  assert.strictEqual(id.resolveTeamId('NBA', 'Los Angeles Clippers'), '12');
  assert.strictEqual(id.resolveTeamId('NBA', 'L.A. Clippers'), '12');
  assert.strictEqual(id.resolveTeamId('NBA', 'Los Angeles Lakers'), '13');
  assert.strictEqual(id.resolveTeamId('NBA', 'LA Lakers'), '13');
  assert.notStrictEqual(id.resolveTeamId('NBA', 'Los Angeles Lakers'), id.resolveTeamId('NBA', 'Los Angeles Clippers'));
  for (const banned of ['Celtics', 'Lakers', 'Clippers', 'Blazers', 'Trail Blazers', 'Heat', 'Jazz', 'Los Angeles', 'LA']) {
    assert.strictEqual(id.resolveTeamId('NBA', banned), null, banned);
  }
  const report = id.buildUnmatchedReport('2026-10-06', {
    NFL: [],
    NCAAF: [],
    NBA: [{ home_team: 'Boston Celtics', away_team: 'Lakers' }],
  });
  assert.deepStrictEqual(Object.keys(report.bySport).sort(), ['MLB', 'NBA', 'NCAAF', 'NFL', 'NHL']);
  assert.deepStrictEqual(report.bySport.NBA, ['Lakers']);
  assert.deepStrictEqual(report.bySport.NFL, []);
}

// ── prior seed: labeled season, zero-sum net rating ──
{
  assert.strictEqual(seed._meta.season, '2025-26');
  assert.strictEqual(seed._meta.method, 'prior-season net rating, zero-sum');
  assert.ok(Math.abs(seed._meta.leaguePpg - 115.6069) < 1e-4);
  const names = Object.keys(seed).filter(k => !k.startsWith('_'));
  assert.strictEqual(names.length, 30);
  const sum = names.reduce((s, n) => s + seed[n].netRtg, 0);
  assert.ok(Math.abs(sum) < 1e-6, `netRtg sum ${sum}`);
  assert.ok(Math.abs(seed['Oklahoma City Thunder'].netRtg - 10.9156) < 1e-4);
  assert.ok(seed['Washington Wizards'].netRtg < -11);
  const centered = nba.centerNbaSeed(seed);
  const sum2 = names.reduce((s, n) => s + centered[n].netRtg, 0);
  assert.ok(Math.abs(sum2) < 1e-6);
  const again = nba.centerNbaSeed(centered);
  assert.ok(Math.abs(again['Oklahoma City Thunder'].netRtg - centered['Oklahoma City Thunder'].netRtg) < 1e-9);
  const loaded = nba.loadPrior();
  assert.strictEqual(loaded._meta.season, '2025-26');
}

// ── season sums vs explicit per-game, and the games-played ramp ──
{
  const league = seed._meta.leaguePpg;
  const explicit = ingest.applyNbaStandingExtras({ pf: 117.8, pa: 110.2 }, [
    { name: 'avgPointsFor', value: 117.8 },
    { name: 'avgPointsAgainst', value: 110.2 },
    { name: 'pointsFor', value: 9657 },
    { name: 'pointsAgainst', value: 9020 },
    { name: 'gamesPlayed', value: 82 },
  ]);
  assert.strictEqual(explicit.avgPointsFor, 117.8);
  const fromAvg = nba.resolveTeamRates(explicit, league);
  assert.strictEqual(fromAvg.source, 'per-game');
  assert.ok(Math.abs(fromAvg.offPpg - 117.8) < 1e-9, 'explicit avg is not divided by games');

  const fromSum = nba.resolveTeamRates({
    pointsFor: 9657,
    pointsAgainst: 9020,
    gamesPlayed: 82,
  }, league);
  assert.strictEqual(fromSum.source, 'season-sum');
  assert.ok(Math.abs(fromSum.offPpg - 9657 / 82) < 1e-9);

  assert.strictEqual(nba.resolveTeamRates({
    pointsFor: 9657,
    pointsAgainst: 9020,
    gamesPlayed: 1,
  }, league), null);

  const ratings = nba.resolveTeamRates({
    offRtg: 118,
    defRtg: 110,
    pace: 100,
    gamesPlayed: 10,
  }, league);
  assert.strictEqual(ratings.source, 'ratings');
  assert.ok(Math.abs(ratings.offPpg - 118) < 1e-9);

  assert.strictEqual(nba.seasonWeight(0, false), 0);
  assert.strictEqual(nba.seasonWeight(1, false), 0);
  assert.strictEqual(nba.seasonWeight(10, false), 0.5);
  assert.strictEqual(nba.seasonWeight(20, false), 1);
  assert.strictEqual(nba.seasonWeight(40, false), 1);
  assert.strictEqual(nba.seasonWeight(40, true), 0);
  assert.strictEqual(nba.NBA_RAMP_GAMES, 20);
}

const LEAGUE = seed._meta.leaguePpg;
const PACE = seed._meta.leaguePace;

function equalPrior() {
  const row = { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE, netRtg: 0 };
  return {
    _meta: { season: '2025-26', leaguePpg: LEAGUE, leaguePace: PACE },
    'Boston Celtics': { ...row },
    'New York Knicks': { ...row },
  };
}

function event(home, away, opts = {}) {
  const spread = opts.spread != null ? opts.spread : -2.5;
  const total = opts.total != null ? opts.total : 231.5;
  const homeMl = opts.homeMl != null ? opts.homeMl : -130;
  const awayMl = opts.awayMl != null ? opts.awayMl : 110;
  const price = opts.price != null ? opts.price : -110;
  const books = opts.books || ['pinnacle', 'draftkings', 'fanduel'];
  return {
    home_team: home,
    away_team: away,
    commence_time: opts.commence || '2026-10-20T23:00:00Z',
    seasonType: opts.seasonType,
    preseason: opts.preseason,
    bookmakers: books.map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
        { key: 'spreads', outcomes: [
          { name: home, price, point: spread },
          { name: away, price, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price, point: total },
          { name: 'Under', price, point: total },
        ] },
      ],
    })),
  };
}

function byMarket(rows, market, sideIncludes) {
  return rows.find(c => c.market === market && (!sideIncludes || String(c.side).includes(sideIncludes)));
}

// ── projection sanity: equal clubs → HFA and 2× league ppg ──
{
  const env = nba.projectEnvironment({
    homeProfile: { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE },
    awayProfile: { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE },
    league: { ppg: LEAGUE, pace: PACE },
    hfa: config.HFA.NBA,
  });
  assert.ok(Math.abs(env.modelMargin - config.HFA.NBA) < 1e-9);
  assert.ok(Math.abs(env.modelTotal - 2 * LEAGUE) < 1e-6);
  assert.ok(Math.abs(env.modelTotal - 231.2) < 0.5);

  const rows = nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: {},
    prior: equalPrior(),
    espnGames: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 2, preseason: false }] },
  });
  assert.ok(rows.length >= 6);
  const spread = byMarket(rows, 'Spread', 'Boston Celtics');
  const total = byMarket(rows, 'Total', 'Over');
  assert.ok(Math.abs(spread.modelProjection - config.HFA.NBA) < 0.02, String(spread.modelProjection));
  assert.ok(Math.abs(total.modelProjection - 2 * LEAGUE) < 0.05, String(total.modelProjection));
  assert.ok(/nba-net-prior/.test(spread.projMethod), spread.projMethod);
  assert.strictEqual(spread.preseason, false);
  assert.strictEqual(spread.shadowOnly, false);

  const calibrated = calibrateAll(rows);
  const tot = calibrated.find(c => c.market === 'Total');
  // Default mode A. NBA totals keep the hand-set K. The ship file is unread.
  assert.strictEqual(tot.calMode, 'A');
  assert.strictEqual(tot.calibK, config.SHRINK_K.Total);
  assert.strictEqual(tot.calLevel, 'handset');
  assert.strictEqual(tot.calParamsSource, 'none');
  assert.strictEqual(tot.calMap, null);
  assert.strictEqual(tot.sport, 'NBA');
  const prevNba = process.env.OMEGA_CAL_MODE;
  process.env.OMEGA_CAL_MODE = 'B';
  clearCalParamsCache();
  try {
    // Mode B stays selectable. NBA has no graded rows, so the cell takes
    // the global fit. That fit is K=1 (the sharp), not the hand-set 0.58.
    const bTot = calibrateAll(rows, { cardDate: '2026-10-20' }).find(c => c.market === 'Total');
    assert.strictEqual(bTot.calMode, 'B');
    assert.strictEqual(bTot.calibK, 1);
    assert.strictEqual(bTot.calLevel, 'global');
    assert.strictEqual(bTot.calParamsSource, 'ship');
  } finally {
    if (prevNba == null) delete process.env.OMEGA_CAL_MODE;
    else process.env.OMEGA_CAL_MODE = prevNba;
    clearCalParamsCache();
  }

  const b2b = nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: {},
    prior: equalPrior(),
    gameDay: { restByTeam: { NBA: { Boston: { playedYesterday: true } } } },
  });
  const b2bSpread = byMarket(b2b, 'Spread', 'Boston Celtics');
  assert.ok(b2bSpread.modelProjection < config.HFA.NBA, `home B2B ${b2bSpread.modelProjection}`);
  assert.ok(Math.abs(b2bSpread.modelProjection - (config.HFA.NBA - 1.5)) < 0.05);
  assert.ok(/-gameday/.test(b2bSpread.projMethod));

  const awayB2b = gd.applyGameDayAdjustments({
    sport: 'NBA',
    modelMargin: config.HFA.NBA,
    modelTotal: 2 * LEAGUE,
    uncertainty: 0.3,
    home: 'Boston Celtics',
    away: 'New York Knicks',
    restByTeam: { 'New York Knicks': { playedYesterday: true } },
    qbByTeam: {},
  });
  assert.ok(awayB2b.modelMargin > config.HFA.NBA);
  assert.ok(Math.abs(awayB2b.gameDay.hfaAdj) <= gd.HFA_ADJ.NBA.max + 1e-9);

  const nanTotal = gd.applyGameDayAdjustments({
    sport: 'NBA',
    modelMargin: 2.5,
    modelTotal: NaN,
    uncertainty: 0.2,
    home: 'Boston Celtics',
    away: 'New York Knicks',
    restByTeam: {},
    qbByTeam: {},
  });
  assert.strictEqual(nanTotal.modelTotal, 228);
  assert.strictEqual(gd.SHORT_REST_DAYS.NBA, 1);
  assert.strictEqual(gd.EXTRA_REST_DAYS.NBA, 3);

  const current = {
    'Boston Celtics': { avgPointsFor: 125, avgPointsAgainst: 105, gamesPlayed: 20, pace: PACE },
    'New York Knicks': { avgPointsFor: LEAGUE, avgPointsAgainst: LEAGUE, gamesPlayed: 20, pace: PACE },
  };
  const full = byMarket(nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: current,
    prior: equalPrior(),
  }), 'Spread', 'Boston Celtics');
  assert.ok(/nba-ppg-pace/.test(full.projMethod), full.projMethod);
  assert.ok(full.modelProjection > config.HFA.NBA + 5, String(full.modelProjection));

  const early = byMarket(nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: {
      'Boston Celtics': { avgPointsFor: 125, avgPointsAgainst: 105, gamesPlayed: 1, pace: PACE },
      'New York Knicks': { avgPointsFor: LEAGUE, avgPointsAgainst: LEAGUE, gamesPlayed: 1, pace: PACE },
    },
    prior: equalPrior(),
  }), 'Spread', 'Boston Celtics');
  assert.ok(Math.abs(early.modelProjection - config.HFA.NBA) < 0.05, `gp<2 stays on prior ${early.modelProjection}`);

  const pre = byMarket(nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { preseason: true, seasonType: 1 })],
    standings: current,
    prior: equalPrior(),
    allowPreseason: true,
  }), 'Spread', 'Boston Celtics');
  assert.strictEqual(pre.preseason, true);
  assert.ok(Math.abs(pre.modelProjection - config.HFA.NBA) < 0.05, 'preseason stays on the prior');

  assert.deepStrictEqual(nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { preseason: true, seasonType: 1 })],
    prior: equalPrior(),
  }), []);
  assert.deepStrictEqual(nba.project({}), []);

  const unknown = nba.project({
    oddsEvents: [event('Boston Celtics', 'Lakers')],
    prior: equalPrior(),
  });
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every(c => c.unknownTeam === true));
  assert.ok(unknown.every(c => /nba-unknown-team/.test(c.projMethod)));
  const gated = applyGates(calibrateAll(unknown).map(attachEv), {
    cardDate: '2026-10-20',
    asOf: '2026-10-20T15:00:00Z',
  });
  assert.ok(gated.rejected.length > 0);
  assert.ok(gated.rejected.every(c => c.rejectReason === 'unknown_team'));
  assert.strictEqual(gated.yesPool.length, 0);
}

// ── flag off: NBA never enters the daily selection pool ──
{
  const snap = {
    oddsBySport: {
      MLB: [],
      NFL: [],
      NCAAF: [],
      NHL: [],
      NBA: [event('Boston Celtics', 'New York Knicks')],
    },
    standingsBySport: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} },
    espnBySport: {
      NBA: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 2, preseason: false }] },
    },
    efficiencyBySport: { NFL: {}, NCAAF: {} },
    parkFactors: {},
    mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
    gameDay: { restByTeam: { NBA: {} } },
  };
  const slate = projectAll(snap);
  assert.ok(!slate.some(c => c.sport === 'NBA'));
  const { yesPool } = applyGates(calibrateAll(slate).map(attachEv), { cardDate: '2026-10-20' });
  assert.ok(!yesPool.some(c => c.sport === 'NBA'));
  assert.ok(!selectStraights(yesPool, config.MAX_STRAIGHTS).some(c => c.sport === 'NBA'));

  assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
  config.SPORTS_ENABLED.NBA = true;
  try {
    const live = projectAll(snap);
    assert.ok(live.some(c => c.sport === 'NBA'), 'flag-on branch passes the real board');
    const preSnap = {
      ...snap,
      oddsBySport: {
        ...snap.oddsBySport,
        NBA: [event('Boston Celtics', 'New York Knicks', { preseason: true, seasonType: 1 })],
      },
      espnBySport: {
        NBA: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 1, preseason: true }] },
      },
    };
    assert.ok(!projectAll(preSnap).some(c => c.sport === 'NBA'), 'preseason stays off the daily path');
  } finally {
    config.SPORTS_ENABLED.NBA = false;
  }
  assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
  assert.ok(!projectAll(snap).some(c => c.sport === 'NBA'));
}

// ── source: daily path cannot opt into preseason; NBA shadow is its own cron ──
{
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(/if \(SPORTS_ENABLED\.NBA\)/.test(indexSrc));
  assert.ok(indexSrc.includes('oddsEvents: snap.oddsBySport.NBA'));
  assert.ok(!/nba\.project\(\{\}\)/.test(indexSrc));
  assert.ok(!/allowPreseason\s*:\s*true/.test(indexSrc));
  const shadowSrc = fs.readFileSync(path.join(root, 'nba_shadow.js'), 'utf8');
  assert.ok(!/selectStraights\s*\(/.test(shadowSrc));
  assert.ok(/allowPreseason:\s*true/.test(shadowSrc));
  assert.ok(/OMEGA_NBA_SHADOW === '0'/.test(shadowSrc));
  assert.ok(/slateOddsGate/.test(shadowSrc));
  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  function fnBlock(name) {
    const parts = toml.split(`[functions."${name}"]`);
    assert.strictEqual(parts.length, 2, name);
    return parts[1].split('[functions.')[0];
  }
  const projectBlock = fnBlock('trigger-omega-nba-shadow');
  const gradeBlock = fnBlock('trigger-omega-nba-shadow-grade');
  const publicBlock = fnBlock('omega-nba-shadow');
  assert.ok(/schedule = "30 21,22 \* \* \*"/.test(projectBlock));
  assert.ok(/schedule = "0 12,13 \* \* \*"/.test(gradeBlock));
  assert.ok(!/schedule\s*=/.test(publicBlock));
  assert.ok(!/schedule = "30 13 \* \* \*"/.test(projectBlock));
  const trig = fs.readFileSync(path.join(__dirname, 'netlify/functions/trigger-omega-shadow.js'), 'utf8');
  assert.ok(!/OMEGA_NBA_SHADOW/.test(trig));
  assert.ok(!/basketball_nba/.test(trig));
  assert.ok(!/omega-nba-shadow/.test(trig));
  const projSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/trigger-omega-nba-shadow.js'), 'utf8');
  const gradeSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/trigger-omega-nba-shadow-grade.js'), 'utf8');
  assert.ok(/mode:\s*'project'/.test(projSrc));
  assert.ok(!/grade-prev/.test(projSrc));
  assert.ok(/mode:\s*'grade-prev'/.test(gradeSrc));
  const httpSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/omega-nba-shadow.js'), 'utf8');
  assert.ok(!/body\.OMEGA_NBA_SHADOW/.test(httpSrc));
  assert.ok(!/params\.OMEGA_NBA_SHADOW/.test(httpSrc));
  assert.ok(!/body\.shadow\s*===\s*true/.test(httpSrc));
  assert.strictEqual(ingest.scoreboardSeasonFields({ season: { type: 1 } }).preseason, true);
  assert.strictEqual(ingest.scoreboardSeasonFields({ season: { type: { type: 2, name: 'Regular Season' } } }).preseason, false);
  assert.strictEqual(ingest.scoreboardSeasonFields({ season: { slug: 'preseason', type: 3 } }).preseason, true);
}

// ── rejection log: per-sport sample, full counts, public payload drops them ──
{
  const { sampleRejectionsBySport, buildRejectionLog, REJECTION_PER_SPORT_CAP } = require(path.join(root, 'index'));
  assert.strictEqual(REJECTION_PER_SPORT_CAP, 25);
  function gateRows(sport, n, reason) {
    return Array.from({ length: n }, (_, i) => ({
      sport,
      matchup: `${sport} game ${i}`,
      side: `${sport} side ${i}`,
      rejectReason: reason,
    }));
  }
  const mixed = [
    ...gateRows('MLB', 40, 'ev-floor'),
    ...gateRows('NFL', 20, 'coverProb-floor'),
    ...gateRows('NFL', 10, 'odds-out-of-band'),
    ...gateRows('NHL', 10, 'ev-floor'),
  ];
  const sampled = sampleRejectionsBySport(mixed, 25);
  assert.strictEqual(sampled.rejectionCounts.total, 80);
  assert.strictEqual(sampled.rejectionCounts.stored, 60);
  assert.strictEqual(sampled.rejectionCounts.perSportCap, 25);
  assert.strictEqual(sampled.rows.filter(r => r.sport === 'MLB').length, 25);
  assert.strictEqual(sampled.rows.filter(r => r.sport === 'NFL').length, 25);
  assert.strictEqual(sampled.rows.filter(r => r.sport === 'NHL').length, 10);
  assert.strictEqual(sampled.rejectionCounts.bySportReason.MLB['ev-floor'], 40);
  assert.strictEqual(sampled.rejectionCounts.bySportReason.NFL['coverProb-floor'], 20);
  assert.strictEqual(sampled.rejectionCounts.bySportReason.NFL['odds-out-of-band'], 10);
  assert.strictEqual(sampled.rejectionCounts.bySportReason.NHL['ev-floor'], 10);
  assert.strictEqual(sampled.rows.findIndex(r => r.sport === 'NHL'), 50);
  assert.ok(sampled.rows.every(r => r.sport && r.reason));

  const log = buildRejectionLog(
    [{ sport: 'NHL', matchup: 'A @ B', side: 'A', reason: 'stale' }],
    [{ matchup: 'C @ D', side: 'veto', reason: 'news' }],
    gateRows('NHL', 3, 'coverProb-floor')
  );
  assert.strictEqual(log.rows[0].reason, 'QA_HARDFAIL: stale');
  assert.strictEqual(log.rows[0].hardFail, true);
  assert.strictEqual(log.rows[0].sport, 'NHL');
  assert.strictEqual(log.rows[1].sport, 'unknown');
  assert.strictEqual(log.rows[1].reason, 'news');
  assert.strictEqual(log.rejectionCounts.bySportReason.NHL['QA_HARDFAIL: stale'], 1);
  assert.strictEqual(log.rejectionCounts.bySportReason.NHL['coverProb-floor'], 3);
  assert.strictEqual(log.rejectionCounts.total, 5);

  const indexSrc2 = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(!/rejected\.slice\(\s*0\s*,\s*40\s*\)/.test(indexSrc2));
  assert.ok(/orderedByScore\(yesPool\)\.slice\(0,\s*15\)/.test(indexSrc2));
  assert.ok(indexSrc2.includes('sampleRejectionsBySport'));
  const pubSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/public-picks.js'), 'utf8');
  assert.ok(pubSrc.includes("'rejectionCounts'"));
  const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
  const pub = publicPicksPayload({
    picks: [],
    rejections: sampled.rows,
    rejectionCounts: sampled.rejectionCounts,
    teamIdentity: { leaked: true },
  });
  assert.deepStrictEqual(pub.rejections, []);
  assert.strictEqual(pub.rejectionCounts, undefined);
  assert.strictEqual(pub.teamIdentity, undefined);
}

// ── shadow fixture, grader, and the unscheduled handler ──
(async () => {
  const writes = [];
  const refuse = async () => { throw new Error('dryRun must not write'); };
  const board = {
    dateISO: '2026-10-20',
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { spread: 8.5, total: 220.5, price: 100, homeMl: 150, awayMl: -170 })],
    standings: {},
    prior: equalPrior(),
    espnGames: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 1, preseason: true }] },
    preseason: true,
    asOf: '2026-10-20T15:00:00Z',
    store: refuse,
  };
  const prevMode = process.env.OMEGA_CAL_MODE;
  delete process.env.OMEGA_CAL_MODE;
  clearCalParamsCache();
  const dry = await shadow.runNbaShadow({ ...board, dryRun: true });
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(dry.oddsCalls, 0);
  assert.strictEqual(dry.creditsEstimate, 0);
  assert.strictEqual(dry.key, 'omega-nba-shadow-2026-10-20');
  assert.ok(dry.candidateCount >= 6, `candidates ${dry.candidateCount}`);
  // Default mode A keeps the hand-set shrink. This board's model and line
  // disagree, so the shadow card is not empty. The daily NBA flag stays off.
  assert.ok(dry.yesCount >= 1, `yes ${dry.yesCount} rejected ${dry.rejectedCount}`);
  assert.ok(dry.payload.picks.length >= 1);
  assert.ok(dry.payload.picks.every(p => p.shadowOnly === true));
  assert.strictEqual(dry.payload.shadowOnly, true);
  assert.strictEqual(dry.payload.sportsEnabledNba, false);
  assert.ok(dry.payload.selection.includes('not daily'));
  assert.strictEqual(writes.length, 0);

  process.env.OMEGA_CAL_MODE = 'B';
  clearCalParamsCache();
  const dryB = await shadow.runNbaShadow({ ...board, dryRun: true });
  // Fitted K. NBA has no graded rows, so the ship fit is the global K=1.
  // Books agree, coverProb is the sharp, and minEV keeps the card empty.
  assert.strictEqual(dryB.yesCount, 0, `mode B yes ${dryB.yesCount}`);
  assert.strictEqual(dryB.payload.picks.length, 0);
  assert.strictEqual(dryB.wrote, false);
  assert.strictEqual(writes.length, 0);

  process.env.OMEGA_CAL_MODE = 'legacy';
  clearCalParamsCache();
  try {
    const dryLegacy = await shadow.runNbaShadow({ ...board, dryRun: true });
    assert.ok(dryLegacy.yesCount >= 1, `legacy yes ${dryLegacy.yesCount} rejected ${dryLegacy.rejectedCount}`);
    assert.ok(dryLegacy.payload.picks.every(p => p.shadowOnly === true));
    assert.ok(dryLegacy.payload.picks.every(p => p.preseason === true));
    assert.strictEqual(writes.length, 0);

    const live = await shadow.runNbaShadow({
      ...board,
      dryRun: false,
      store: async (key, data) => { writes.push({ key, data }); },
    });
    assert.strictEqual(live.wrote, true);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, 'omega-nba-shadow-2026-10-20');
    assert.strictEqual(writes[0].data.shadowOnly, true);
    assert.ok(writes[0].data.picks.length >= 1);
  } finally {
    if (prevMode == null) delete process.env.OMEGA_CAL_MODE;
    else process.env.OMEGA_CAL_MODE = prevMode;
    clearCalParamsCache();
  }

// ── grader fixture: win / loss / push / pending / unmatched; dryRun writes nothing ──
{
  const finals = [
    { homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', homeScore: 110, awayScore: 100, status: 'final' },
    { homeTeam: 'Los Angeles Lakers', awayTeam: 'LA Clippers', homeScore: null, awayScore: null, status: 'pre' },
  ];
  const slate = {
    picks: [
      { market: 'Spread', side: 'Boston Celtics -2.5', line: -2.5, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Spread', side: 'Boston Celtics -10', line: -10, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Spread', side: 'Boston Celtics -20.5', line: -20.5, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Total', side: 'Over 220.5', line: 220.5, pickSide: 'over', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Moneyline', side: 'Boston Celtics', pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Spread', side: 'Los Angeles Lakers -1.5', line: -1.5, pickSide: 'home', homeTeam: 'Los Angeles Lakers', awayTeam: 'LA Clippers', matchup: 'LA Clippers @ Los Angeles Lakers' },
      { market: 'Moneyline', side: 'Lakers', pickSide: 'home', homeTeam: 'Lakers', awayTeam: 'Boston Celtics', matchup: 'Boston Celtics @ Lakers' },
    ],
  };
  const graded = slate.picks.map((p, i) => shadow.gradeOne(p, i === 6 ? null : finals.find(g => g.homeTeam === p.homeTeam)));
  assert.deepStrictEqual(graded.map(g => g.result), ['win', 'push', 'loss', 'loss', 'win', 'pending', 'unmatched']);

  const writes = [];
  const dry = await shadow.gradeNbaShadow({
    dateISO: '2026-10-20',
    dryRun: true,
    slate,
    finals,
    store: async () => { throw new Error('dryRun must not write'); },
  });
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(dry.oddsCalls, 0);
  assert.strictEqual(dry.key, 'omega-nba-shadow-results-2026-10-20');
  assert.strictEqual(dry.record.win, 2);
  assert.strictEqual(dry.record.push, 1);
  assert.strictEqual(dry.record.loss, 2);
  assert.strictEqual(dry.record.pending, 1);
  assert.strictEqual(dry.record.unmatched, 1);

  const saved = await shadow.gradeNbaShadow({
    dateISO: '2026-10-20',
    dryRun: false,
    slate,
    finals,
    store: async (key, data) => { writes.push({ key, data }); },
  });
  assert.strictEqual(saved.wrote, true);
  assert.strictEqual(writes[0].key, 'omega-nba-shadow-results-2026-10-20');
  assert.strictEqual(writes[0].data.shadowOnly, true);
  assert.strictEqual(writes[0].data.oddsCalls, 0);
}

// ── preflight skips the paid odds call; one call when the ET slate has a game ──
{
  const prevKey = process.env.ODDS_API_KEY;
  const prevFetch = global.fetch;
  process.env.ODDS_API_KEY = 'test-key';
  function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
  }
  try {
    const skippedCalls = [];
    const skipFetch = async (url) => {
      skippedCalls.push(String(url));
      if (String(url).includes('/events')) return jsonResponse([]);
      throw new Error('odds or ESPN must not run on an empty preflight');
    };
    const skipped = await shadow.fetchNbaBoard('2026-10-20', { fetchImpl: skipFetch });
    assert.strictEqual(skipped.oddsCalls, 0);
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(skipped.skipReason, 'no-same-et-day');
    assert.strictEqual(skippedCalls.length, 1);
    assert.ok(skippedCalls[0].includes('/events'));

    const liveCalls = [];
    const liveFetch = async (url) => {
      const u = String(url);
      liveCalls.push(u);
      if (u.includes('/events')) {
        return jsonResponse([{ commence_time: '2026-10-20T23:00:00Z', home_team: 'Boston Celtics', away_team: 'New York Knicks' }]);
      }
      if (u.includes('/odds')) return jsonResponse([]);
      return jsonResponse({ events: [], children: [] });
    };
    global.fetch = liveFetch;
    const live = await shadow.fetchNbaBoard('2026-10-20', { fetchImpl: liveFetch });
    assert.strictEqual(live.oddsCalls, 1);
    assert.strictEqual(liveCalls.filter((u) => u.includes('/odds')).length, 1);
    assert.strictEqual(liveCalls.filter((u) => u.includes('/events')).length, 1);
  } finally {
    if (prevKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = prevKey;
    global.fetch = prevFetch;
  }
}

// ── a logged ET date does not spend a second odds call ──
{
  const bag = new Map();
  const board = {
    dateISO: '2026-10-20',
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { spread: 8.5, total: 220.5, price: 100, homeMl: 150, awayMl: -170 })],
    standings: {},
    prior: equalPrior(),
    espnGames: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 1, preseason: true }] },
    preseason: true,
    asOf: '2026-10-20T15:00:00Z',
    store: async (key, data) => { bag.set(key, data); },
    read: async (key) => bag.get(key) || null,
  };
  const first = await shadow.runNbaShadow({ ...board, dryRun: false });
  assert.strictEqual(first.wrote, true);
  assert.strictEqual(first.oddsCalls, 0);
  let oddsHits = 0;
  const second = await shadow.runNbaShadow({
    dateISO: '2026-10-20',
    dryRun: false,
    read: async (key) => bag.get(key) || null,
    store: async () => { throw new Error('already-logged must not write'); },
    fetchImpl: async () => { oddsHits += 1; throw new Error('already-logged must not fetch'); },
  });
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.reason, 'already-logged');
  assert.strictEqual(second.oddsCalls, 0);
  assert.strictEqual(second.wrote, false);
  assert.strictEqual(oddsHits, 0);
}

// ── grader summary: W-L, flat 1u, by market, cumulative from the prior blob ──
{
  const finals = [
    { homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', homeScore: 110, awayScore: 100, status: 'final' },
  ];
  const slate = {
    picks: [
      { market: 'Spread', side: 'Boston Celtics -2.5', line: -2.5, odds: -110, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Spread', side: 'Boston Celtics -20.5', line: -20.5, odds: -110, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Total', side: 'Over 205', line: 205, odds: 100, pickSide: 'over', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
      { market: 'Moneyline', side: 'Boston Celtics', odds: -150, pickSide: 'home', homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', matchup: 'New York Knicks @ Boston Celtics' },
    ],
  };
  const prior = {
    date: '2026-10-19',
    cumulative: {
      from: '2026-10-01',
      through: '2026-10-19',
      wl: '1-0',
      units: 1,
      priced: 1,
      unpriced: 0,
      unitStake: 1,
      record: { win: 1, loss: 0, push: 0, pending: 0, unmatched: 0 },
      byMarket: {
        Moneyline: { win: 1, loss: 0, push: 0, pending: 0, unmatched: 0, units: 1 },
      },
    },
  };
  const saved = await shadow.gradeNbaShadow({
    dateISO: '2026-10-20',
    dryRun: true,
    slate,
    finals,
    priorResults: prior,
    store: async () => { throw new Error('dryRun must not write'); },
  });
  assert.strictEqual(saved.wrote, false);
  assert.strictEqual(saved.oddsCalls, 0);
  assert.strictEqual(saved.payload.summary.wl, '3-1');
  assert.strictEqual(saved.payload.summary.byMarket.Spread.win, 1);
  assert.strictEqual(saved.payload.summary.byMarket.Spread.loss, 1);
  assert.strictEqual(saved.payload.summary.byMarket.Total.win, 1);
  assert.strictEqual(saved.payload.summary.byMarket.Moneyline.win, 1);
  assert.strictEqual(saved.payload.summary.unitStake, 1);
  const rowSum = saved.payload.rows.reduce((s, r) => s + (r.profitUnits || 0), 0);
  assert.ok(Math.abs(saved.payload.summary.units - rowSum) < 1e-9);
  assert.ok(saved.payload.summary.units > 0);
  assert.strictEqual(saved.payload.cumulative.wl, '4-1');
  assert.strictEqual(saved.payload.cumulative.from, '2026-10-01');
  assert.strictEqual(saved.payload.cumulative.through, '2026-10-20');
  assert.strictEqual(saved.payload.cumulative.byMarket.Moneyline.win, 2);
  assert.ok(Math.abs(saved.payload.cumulative.units - (1 + saved.payload.summary.units)) < 1e-9);
}

function scheduleEvent() {
  return {
    httpMethod: 'POST',
    headers: {
      'x-nf-event': 'schedule',
      'user-agent': 'Netlify Clockwork',
    },
    body: JSON.stringify({ next_run: '2026-10-21T21:30:00.000Z' }),
  };
}

// ET guard uses wall clock. Pin the scheduler tests to the intended ET slot.
const PROJECT_AT = new Date('2026-10-21T21:30:00.000Z');
const GRADE_AT = new Date('2026-10-21T12:00:00.000Z');

function fixtureBoard() {
  return {
    dateISO: '2026-10-20',
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { spread: 8.5, total: 220.5, price: 100, homeMl: 150, awayMl: -170 })],
    standings: {},
    prior: equalPrior(),
    espnGames: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 1, preseason: true }] },
    preseason: true,
    asOf: '2026-10-20T15:00:00Z',
  };
}

// ── unauthenticated POST: 0 odds calls, no writes. Schedule header is not enough on the public URL. ──
{
  const prevShadow = process.env.OMEGA_NBA_SHADOW;
  const prevFetch = global.fetch;
  delete process.env.OMEGA_NBA_SHADOW;
  let fetches = 0;
  let writes = 0;
  global.fetch = async () => { fetches += 1; throw new Error('unauthenticated must not fetch'); };
  try {
    const publicHandler = require('./netlify/functions/omega-nba-shadow').handler;
    const projectHandler = require('./netlify/functions/trigger-omega-nba-shadow').handler;
    const res = await publicHandler({
      httpMethod: 'POST',
      headers: { 'user-agent': 'curl/8.0', 'x-nf-event': 'schedule' },
      queryStringParameters: { shadow: '1', OMEGA_NBA_SHADOW: '1' },
      body: JSON.stringify({ dryRun: false, shadow: true, OMEGA_NBA_SHADOW: '1' }),
    });
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(body.oddsCalls, 0);
    assert.strictEqual(body.wrote, false);
    assert.strictEqual(body.creditsEstimate, 0);
    assert.strictEqual(body.sportsEnabledNba, false);

    const naked = await projectHandler({
      httpMethod: 'POST',
      headers: { 'user-agent': 'curl/8.0' },
      body: JSON.stringify({ dryRun: false }),
    });
    const nakedBody = JSON.parse(naked.body);
    assert.strictEqual(naked.statusCode, 403);
    assert.strictEqual(nakedBody.oddsCalls, 0);
    assert.strictEqual(nakedBody.wrote, false);

    const reading = await publicHandler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ read: true, grade: true }),
    });
    const readBody = JSON.parse(reading.body);
    assert.strictEqual(reading.statusCode, 200);
    assert.strictEqual(readBody.readOnly, true);
    assert.strictEqual(readBody.oddsCalls, 0);
    assert.strictEqual(readBody.wrote, false);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(writes, 0);
  } finally {
    if (prevShadow == null) delete process.env.OMEGA_NBA_SHADOW;
    else process.env.OMEGA_NBA_SHADOW = prevShadow;
    global.fetch = prevFetch;
  }
}

// ── scheduled project runs the fixture; grade wrapper writes the results blob ──
{
  const prevShadow = process.env.OMEGA_NBA_SHADOW;
  const prevFetch = global.fetch;
  delete process.env.OMEGA_NBA_SHADOW;
  const prevCal = process.env.OMEGA_CAL_MODE;
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('fixture path must not fetch'); };
  try {
    const projectHandler = require('./netlify/functions/trigger-omega-nba-shadow').handler;
    const gradeHandler = require('./netlify/functions/trigger-omega-nba-shadow-grade').handler;
    // Default mode A: hand-set shrink, so this fixture still publishes
    // shadow picks. The cron writes the doc. The daily NBA flag stays off.
    delete process.env.OMEGA_CAL_MODE;
    clearCalParamsCache();
    const shipWrites = [];
    const shipRes = await projectHandler(scheduleEvent(), {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        store: async (key, data) => { shipWrites.push({ key, data }); },
        read: async () => null,
      },
    });
    const shipBody = JSON.parse(shipRes.body);
    assert.strictEqual(shipBody.wrote, true);
    assert.strictEqual(shipBody.oddsCalls, 0);
    assert.strictEqual(shipWrites.length, 1);
    assert.ok(shipWrites[0].data.yesCount >= 1);
    assert.ok(shipWrites[0].data.picks.length >= 1);
    assert.strictEqual(shipWrites[0].data.shadowOnly, true);
    assert.ok(shipWrites[0].data.picks.every((p) => p.shadowOnly === true));

    // Mode B stays selectable and empties this card: NBA takes the global K=1.
    process.env.OMEGA_CAL_MODE = 'B';
    clearCalParamsCache();
    const bWrites = [];
    const bRes = await projectHandler(scheduleEvent(), {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        store: async (key, data) => { bWrites.push({ key, data }); },
        read: async () => null,
      },
    });
    const bBody = JSON.parse(bRes.body);
    assert.strictEqual(bBody.wrote, true);
    assert.strictEqual(bBody.oddsCalls, 0);
    assert.strictEqual(bWrites.length, 1);
    assert.strictEqual(bWrites[0].data.yesCount, 0);
    assert.strictEqual(bWrites[0].data.picks.length, 0);
    assert.strictEqual(bWrites[0].data.shadowOnly, true);

    // Legacy still publishes the model-vs-line disagreement, so the tag
    // and grader checks below have a non-empty shadow card.
    process.env.OMEGA_CAL_MODE = 'legacy';
    clearCalParamsCache();
    const writes = [];
    const res = await projectHandler(scheduleEvent(), {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        store: async (key, data) => { writes.push({ key, data }); },
        read: async () => null,
      },
    });
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.wrote, true);
    assert.strictEqual(body.oddsCalls, 0);
    assert.strictEqual(body.creditsEstimate, 0);
    assert.strictEqual(body.sportsEnabledNba, false);
    assert.strictEqual(body.mode, 'project');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, 'omega-nba-shadow-2026-10-20');
    assert.strictEqual(writes[0].data.shadowOnly, true);
    assert.strictEqual(writes[0].data.sportsEnabledNba, false);
    assert.ok(writes[0].data.picks.length >= 1);
    assert.ok(writes[0].data.picks.every((p) => p.shadowOnly === true));

    // A grade flag on the project cron stays a project. The grade cron is the other wrapper.
    const stillProject = await projectHandler({
      ...scheduleEvent(),
      body: JSON.stringify({ grade: true, next_run: '2026-10-21T21:30:00.000Z' }),
    }, {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        store: async (key, data) => { writes.push({ key, data }); },
      },
    });
    assert.strictEqual(JSON.parse(stillProject.body).mode, 'project');
    assert.ok(writes.every((w) => w.key.startsWith('omega-nba-shadow-2026-10-20') && !w.key.includes('results')));

    // Client date and dryRun on the cron cannot open another slate or skip the log.
    const pinned = [];
    const today = shadow.todayET();
    const ignored = await projectHandler({
      ...scheduleEvent(),
      body: JSON.stringify({ dryRun: true, date: '2020-01-01', grade: true }),
    }, {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        dateISO: undefined,
        store: async (key, data) => { pinned.push({ key, data }); },
      },
    });
    const ignoredBody = JSON.parse(ignored.body);
    assert.strictEqual(ignoredBody.mode, 'project');
    assert.strictEqual(ignoredBody.wrote, true);
    assert.strictEqual(ignoredBody.oddsCalls, 0);
    assert.strictEqual(pinned.length, 1);
    assert.strictEqual(pinned[0].key, `omega-nba-shadow-${today}`);
    assert.notStrictEqual(pinned[0].key, 'omega-nba-shadow-2020-01-01');

    const gradeWrites = [];
    const finals = [
      { homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', homeScore: 110, awayScore: 100, status: 'final' },
    ];
    const graded = await gradeHandler(scheduleEvent(), {
      now: GRADE_AT,
      nbaShadowTest: {
        dateISO: '2026-10-20',
        slate: { picks: writes[0].data.picks },
        finals,
        priorResults: null,
        store: async (key, data) => { gradeWrites.push({ key, data }); },
      },
    });
    const gradeBody = JSON.parse(graded.body);
    assert.strictEqual(graded.statusCode, 200);
    assert.strictEqual(gradeBody.oddsCalls, 0);
    assert.strictEqual(gradeBody.wrote, true);
    assert.strictEqual(gradeBody.mode, 'grade-prev');
    assert.strictEqual(gradeWrites.length, 1);
    assert.strictEqual(gradeWrites[0].key, 'omega-nba-shadow-results-2026-10-20');
    assert.strictEqual(gradeWrites[0].data.shadowOnly, true);
    assert.ok(gradeWrites[0].data.summary);
    assert.ok(gradeWrites[0].data.summary.wl);
    assert.ok(gradeWrites[0].data.summary.byMarket);
    assert.strictEqual(typeof gradeWrites[0].data.summary.units, 'number');
    assert.ok(gradeWrites[0].data.cumulative);
    assert.strictEqual(gradeWrites[0].data.cumulative.through, '2026-10-20');
    assert.strictEqual(fetches, 0);
  } finally {
    if (prevShadow == null) delete process.env.OMEGA_NBA_SHADOW;
    else process.env.OMEGA_NBA_SHADOW = prevShadow;
    if (prevCal == null) delete process.env.OMEGA_CAL_MODE;
    else process.env.OMEGA_CAL_MODE = prevCal;
    clearCalParamsCache();
    global.fetch = prevFetch;
  }
}

// ── kill-switch: scheduled fixture still fetches nothing and writes nothing ──
{
  const prevShadow = process.env.OMEGA_NBA_SHADOW;
  const prevFetch = global.fetch;
  process.env.OMEGA_NBA_SHADOW = '0';
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('kill-switch must not fetch'); };
  try {
    assert.strictEqual(shadow.shadowLiveEnabled(), false);
    const projectHandler = require('./netlify/functions/trigger-omega-nba-shadow').handler;
    const writes = [];
    const res = await projectHandler(scheduleEvent(), {
      now: PROJECT_AT,
      nbaShadowTest: {
        ...fixtureBoard(),
        store: async () => { writes.push('nope'); throw new Error('kill-switch must not write'); },
      },
    });
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.skipped, true);
    assert.strictEqual(body.reason, 'OMEGA_NBA_SHADOW=0');
    assert.strictEqual(body.oddsCalls, 0);
    assert.strictEqual(body.wrote, false);
    assert.strictEqual(body.creditsEstimate, 0);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(fetches, 0);
    const blocked = await shadow.fetchNbaBoard('2026-10-20', {
      fetchImpl: async () => { fetches += 1; throw new Error('kill-switch must not fetch'); },
    });
    assert.strictEqual(blocked.oddsCalls, 0);
    assert.strictEqual(blocked.skipReason, 'OMEGA_NBA_SHADOW=0');
    assert.strictEqual(fetches, 0);
  } finally {
    if (prevShadow == null) delete process.env.OMEGA_NBA_SHADOW;
    else process.env.OMEGA_NBA_SHADOW = prevShadow;
    global.fetch = prevFetch;
    assert.strictEqual(shadow.shadowLiveEnabled(), config.NBA_SHADOW.enabled === true);
  }
}

console.log('PASS test-omega-nba-engine', {
  model: config.MODEL_VERSION,
  nbaEnabled: config.SPORTS_ENABLED.NBA,
  totalSd: config.SPORT_TOTAL_STD.NBA,
  credits: shadow.ODDS_CREDITS_PER_RUN,
});
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
