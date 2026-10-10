'use strict';
// Exact identity skips and input-stat health guards. No network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nhl = require(path.join(root, 'sports/nhl'));
const cfb = require(path.join(root, 'sports/cfb'));
const id = require(path.join(root, 'sports/team_identity'));
const { gamesPlayed, gamesPlayedInfo } = require(path.join(root, 'sports/_common'));
const { applyGates, gateReason } = require(path.join(root, 'gates'));
const { buildHealthRecord, attachGenerateHealth, formatGuardLine } = require(path.join(root, 'health'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');

const nflIds = require(path.join(root, 'sports/data/nfl-team-ids.json'));
const ncaafIds = require(path.join(root, 'sports/data/ncaaf-team-ids.json'));
const nhlIds = require(path.join(root, 'sports/data/nhl-team-ids.json'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.15-omega-vnext-night');

function synth(home, away, opts = {}) {
  const total = opts.total != null ? opts.total : 6;
  const spread = opts.spread != null ? opts.spread : -1.5;
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-08T23:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ] },
      ],
    })),
  };
}

function byMarket(cands, market) {
  const row = cands.find((c) => c.market === market);
  assert.ok(row, market);
  return row;
}

function codesOf(record) {
  return record.alerts.map((a) => a.sport + ':' + a.code);
}

function snap(sport, events, standings, extra) {
  return Object.assign({
    oddsBySport: { [sport]: events },
    standingsBySport: { [sport]: standings },
  }, extra || {});
}

// ── NHL unknown name skips the game with unknown_team ──
{
  const logs = [];
  const orig = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  let cands;
  try {
    cands = nhl.project({
      oddsEvents: [synth('Not A Real Hockey Club', 'Boston Bruins')],
      standings: {
        'Boston Bruins': { pf: 3.2, pa: 2.8, games: 20, wins: 12, losses: 6, otLosses: 2 },
      },
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(cands.length >= 6);
  assert.ok(cands.every((c) => c.unknownTeam === true));
  assert.ok(cands.every((c) => c.unknownNames.indexOf('Not A Real Hockey Club') >= 0));
  assert.ok(logs.some((line) => line.includes('unknown_team') && line.includes('Not A Real Hockey Club')));
  const gated = applyGates(cands, { cardDate: '2026-10-08' });
  assert.strictEqual(gated.yesPool.length, 0);
  assert.strictEqual(gated.rejected.length, cands.length);
  assert.ok(gated.rejected.every((r) => r.rejectReason === 'unknown_team'));
  assert.strictEqual(gateReason(cands[0], { cardDate: '2026-10-08' }), 'unknown_team');
}

// ── Shared mascots never cross ──
{
  const ky = id.resolveTeamId('NCAAF', 'Kentucky Wildcats');
  const az = id.resolveTeamId('NCAAF', 'Arizona Wildcats');
  assert.ok(ky && az);
  assert.notStrictEqual(ky, az);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Wildcats'), null);

  const usf = id.resolveTeamId('NCAAF', 'South Florida Bulls');
  const buf = id.resolveTeamId('NCAAF', 'Buffalo Bulls');
  assert.ok(usf && buf);
  assert.notStrictEqual(usf, buf);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Bulls'), null);

  const table = {
    'Kentucky Wildcats': { pf: 72, pa: 56, wins: 3, losses: 1, gamesPlayed: 4, tag: 'ky' },
    'Arizona Wildcats': { pf: 48, pa: 68, wins: 1, losses: 3, gamesPlayed: 4, tag: 'az' },
    'South Florida Bulls': { pf: 80, pa: 52, wins: 3, losses: 1, gamesPlayed: 4, tag: 'usf' },
    'Buffalo Bulls': { pf: 44, pa: 70, wins: 1, losses: 3, gamesPlayed: 4, tag: 'buf' },
  };
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'Kentucky Wildcats').tag, 'ky');
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'Arizona Wildcats').tag, 'az');
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'Wildcats'), null);
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'South Florida Bulls').tag, 'usf');
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'Buffalo Bulls').tag, 'buf');
  assert.strictEqual(id.rowByIdentity('NCAAF', table, 'Bulls'), null);

  const homeKy = cfb.project({
    oddsEvents: [synth('Kentucky Wildcats', 'Arizona Wildcats', { total: 52, spread: -3 })],
    standings: table,
    efficiency: {},
  });
  const homeAz = cfb.project({
    oddsEvents: [synth('Arizona Wildcats', 'Kentucky Wildcats', { total: 52, spread: -3 })],
    standings: table,
    efficiency: {},
  });
  assert.ok(homeKy.every((c) => !c.unknownTeam));
  assert.ok(byMarket(homeKy, 'Spread').modelProjection > 5, byMarket(homeKy, 'Spread').modelProjection);
  assert.ok(byMarket(homeAz, 'Spread').modelProjection < 0, byMarket(homeAz, 'Spread').modelProjection);

  const homeUsf = cfb.project({
    oddsEvents: [synth('South Florida Bulls', 'Buffalo Bulls', { total: 52, spread: -3 })],
    standings: table,
    efficiency: {},
  });
  const homeBuf = cfb.project({
    oddsEvents: [synth('Buffalo Bulls', 'South Florida Bulls', { total: 52, spread: -3 })],
    standings: table,
    efficiency: {},
  });
  assert.ok(byMarket(homeUsf, 'Spread').modelProjection > 5, byMarket(homeUsf, 'Spread').modelProjection);
  assert.ok(byMarket(homeBuf, 'Spread').modelProjection < 0, byMarket(homeBuf, 'Spread').modelProjection);

  const mascot = cfb.project({
    oddsEvents: [synth('Wildcats', 'Bulls', { total: 52, spread: -3 })],
    standings: table,
    efficiency: {},
  });
  assert.ok(mascot.every((c) => c.unknownTeam === true));
  assert.strictEqual(gateReason(mascot[0], { cardDate: '2026-10-08' }), 'unknown_team');
}

// ── ESPN board match is id-exact. An unresolved nickname does not steal the game.
// Per-game GF/GA (no nhlSeasonGoals) keeps the standings spine on, so the
// engines tag comes only from a matched goalie, not the winPct residual.
{
  const standings = {
    'Boston Bruins': { pf: 3.1, pa: 3.0, games: 20, wins: 10, losses: 8, otLosses: 2 },
    'Buffalo Sabres': { pf: 3.0, pa: 3.1, games: 20, wins: 9, losses: 9, otLosses: 2 },
    'Colorado Avalanche': { pf: 3.3, pa: 2.9, games: 20, wins: 12, losses: 6, otLosses: 2 },
    'Dallas Stars': { pf: 3.0, pa: 3.0, games: 20, wins: 10, losses: 8, otLosses: 2 },
  };
  const goalie = {
    homeTeam: 'Boston Bruins',
    awayTeam: 'Buffalo Sabres',
    homeGoalie: { savePct: 0.93, name: 'Home' },
    awayGoalie: { savePct: 0.89, name: 'Away' },
  };
  const matched = nhl.project({
    oddsEvents: [synth('Boston Bruins', 'Buffalo Sabres')],
    standings,
    espnGames: [goalie],
  });
  assert.ok(/engines/.test(byMarket(matched, 'Moneyline').projMethod), byMarket(matched, 'Moneyline').projMethod);
  const bareNick = nhl.project({
    oddsEvents: [synth('Boston Bruins', 'Buffalo Sabres')],
    standings,
    espnGames: [{
      homeTeam: 'Bruins',
      awayTeam: 'Sabres',
      homeGoalie: { savePct: 0.93, name: 'Home' },
      awayGoalie: { savePct: 0.89, name: 'Away' },
    }],
  });
  assert.ok(!/engines/.test(byMarket(bareNick, 'Moneyline').projMethod), byMarket(bareNick, 'Moneyline').projMethod);
  const other = nhl.project({
    oddsEvents: [synth('Colorado Avalanche', 'Dallas Stars')],
    standings,
    espnGames: [goalie],
  });
  assert.ok(!/engines/.test(byMarket(other, 'Moneyline').projMethod));
}

// ── Resolved odds aliases stay on the same row (pick-neutral when identity hits) ──
{
  const standings = {
    'Utah Mammoth': { pf: 3.6, pa: 2.4, games: 15, wins: 10, losses: 4, otLosses: 1 },
    'Boston Bruins': { pf: 2.5, pa: 3.3, games: 15, wins: 6, losses: 8, otLosses: 1 },
  };
  const full = nhl.project({ oddsEvents: [synth('Boston Bruins', 'Utah Mammoth')] , standings });
  const alias = nhl.project({ oddsEvents: [synth('Boston Bruins', 'Utah HC')], standings });
  assert.ok(alias.every((c) => !c.unknownTeam));
  assert.strictEqual(byMarket(full, 'Spread').modelProjection, byMarket(alias, 'Spread').modelProjection);
  assert.strictEqual(byMarket(full, 'Total').modelProjection, byMarket(alias, 'Total').modelProjection);
}

// Display names and odds names resolve, so a standings table keyed by them
// has no fuzzy key. Exact lookup returns the same row the old fuzzy path
// returned on that table.
{
  function assertResolves(sport, table) {
    const keyed = {};
    for (const team of Object.values(table.teams)) {
      assert.strictEqual(id.resolveTeamId(sport, team.displayName), String(team.espnId), team.displayName);
      keyed[team.displayName] = { id: String(team.espnId) };
      for (const name of team.oddsNames || []) {
        assert.strictEqual(id.resolveTeamId(sport, name), String(team.espnId), name);
        assert.strictEqual(id.rowByIdentity(sport, keyed, name).id, String(team.espnId), name);
      }
    }
    assert.deepStrictEqual(id.unresolvedKeys(sport, keyed), []);
  }
  assertResolves('NFL', nflIds);
  assertResolves('NCAAF', ncaafIds);
  assertResolves('NHL', nhlIds);
  assert.strictEqual(id.resolveTeamId('NHL', 'Avalanche'), null);
  assert.strictEqual(id.resolveTeamId('NHL', 'Stars'), null);
}

// ── games played: same helper as the model. A W-L record is gp. ──
{
  const recordRow = { record: '4-1', pf: 31, pa: 24 };
  assert.strictEqual(gamesPlayed(recordRow), 5);
  assert.strictEqual(gamesPlayedInfo(recordRow).source, 'record');
  assert.strictEqual(gamesPlayedInfo(recordRow).known, true);
  assert.strictEqual(gamesPlayed({ wins: 4, pf: 30, pa: 20 }), 0);
  assert.strictEqual(gamesPlayedInfo({ wins: 4, pf: 30, pa: 20 }).source, 'winsOnly');
  assert.strictEqual(gamesPlayed({ wins: 4, losses: 2, games: 4, pf: 100, pa: 80 }), 4);
  assert.strictEqual(gamesPlayedInfo({ wins: 4, losses: 2, games: 4 }).known, false);
  assert.strictEqual(gamesPlayed({ gamesPlayed: 4, wins: 3, losses: 1 }), 4);
  assert.strictEqual(gamesPlayed({ wins: 2, losses: 1, ties: 1 }), 4);
  assert.strictEqual(nhl.nhlGamesInfo({ gamesPlayed: 10 }).known, false);
  assert.strictEqual(nhl.nhlGamesInfo({ wins: 6, losses: 4, otLosses: 2 }).gp, 12);

  const recordHealth = buildHealthRecord({
    snap: snap('NCAAF', [synth('Kentucky Wildcats', 'Arizona Wildcats', { total: 52, spread: -3 })], {
      'Kentucky Wildcats': recordRow,
      'Arizona Wildcats': { record: '3-2', pf: 28, pa: 27 },
    }),
  });
  assert.strictEqual(recordHealth.bySport.NCAAF.stats.gpUnknown, 0);
  assert.ok(!codesOf(recordHealth).includes('NCAAF:gp_unknown'));
  assert.ok(!codesOf(recordHealth).includes('NCAAF:schema_missing:overall'), codesOf(recordHealth).join(','));

  const winsOnly = buildHealthRecord({
    snap: snap('NFL', [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })], {
      'Kansas City Chiefs': { wins: 4, losses: 2, games: 4, pf: 100, pa: 80 },
      'Buffalo Bills': { wins: 3, losses: 1, gamesPlayed: 4, pf: 96, pa: 84 },
    }),
  });
  assert.strictEqual(winsOnly.bySport.NFL.stats.gpUnknown, 1);
  assert.ok(codesOf(winsOnly).includes('NFL:gp_unknown'));
}

// ── each guard alerts on a bad table and stays 0 on a clean one ──
{
  const rate = buildHealthRecord({
    snap: snap('NFL', [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })], {
      'Kansas City Chiefs': { pf: 22, pa: 18, gamesPlayed: 8, wins: 4, losses: 4 },
      'Buffalo Bills': { pf: 24, pa: 20, gamesPlayed: 8, wins: 5, losses: 3 },
    }),
  });
  assert.ok(rate.bySport.NFL.stats.rateScale >= 1);
  assert.ok(codesOf(rate).includes('NFL:rate_scale'));

  const rawSum = buildHealthRecord({
    snap: snap('NFL', [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })], {
      'Kansas City Chiefs': { pf: 180, pa: 140, wins: 0, losses: 0 },
      'Buffalo Bills': { pf: 160, pa: 150, wins: 0, losses: 0 },
    }),
  });
  assert.ok(codesOf(rawSum).includes('NFL:rate_scale'));

  const points = buildHealthRecord({
    snap: snap('NHL', [synth('Boston Bruins', 'Buffalo Sabres')], {
      'Boston Bruins': { pf: 90, pa: 88, wins: 40, losses: 30, otLosses: 10, games: 80 },
      'Buffalo Sabres': { pf: 70, pa: 95, wins: 30, losses: 40, otLosses: 10, games: 80 },
    }),
  });
  assert.ok(points.bySport.NHL.stats.nhlPointsAsGoals >= 1);
  assert.ok(codesOf(points).includes('NHL:nhl_points_as_goals'));

  const schemaNfl = buildHealthRecord({
    snap: snap('NFL', [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })], {
      'Kansas City Chiefs': { wins: 3, gamesPlayed: 5, pf: 110, pa: 90 },
      'Buffalo Bills': { wins: 2, gamesPlayed: 5, pf: 100, pa: 95 },
    }),
  });
  assert.ok(schemaNfl.bySport.NFL.stats.schemaMissing >= 1);
  assert.ok(codesOf(schemaNfl).includes('NFL:schema_missing:losses'));

  const schemaCfb = buildHealthRecord({
    snap: snap('NCAAF', [synth('Kentucky Wildcats', 'Arizona Wildcats', { total: 52, spread: -3 })], {
      'Kentucky Wildcats': { pf: 120, pa: 90, gamesPlayed: 4 },
      'Arizona Wildcats': { pf: 100, pa: 96, gamesPlayed: 4 },
    }),
  });
  assert.ok(codesOf(schemaCfb).includes('NCAAF:schema_missing:overall'));

  const schemaNhl = buildHealthRecord({
    snap: snap('NHL', [synth('Boston Bruins', 'Buffalo Sabres')], {
      'Boston Bruins': { pf: 3.2, pa: 2.9, games: 20, wins: 10, losses: 8, otLosses: 2 },
      'Buffalo Sabres': { pf: 2.8, pa: 3.1, games: 20, wins: 9, losses: 9, otLosses: 2 },
    }),
  });
  assert.ok(codesOf(schemaNhl).includes('NHL:schema_missing:goalsFor'), codesOf(schemaNhl).join(','));
  assert.ok(codesOf(schemaNhl).includes('NHL:schema_missing:goalsAgainst'));

  const forcedAvg = buildHealthRecord({
    snap: snap('NHL', [synth('Boston Bruins', 'Buffalo Sabres')], {
      'Boston Bruins': { pf: 3.2, pa: 2.8, games: 30, wins: 16, losses: 10, otLosses: 4, nhlSeasonGoals: true, goalsFor: 3.2, goalsAgainst: 2.8 },
      'Buffalo Sabres': { pf: 2.9, pa: 3.1, games: 30, wins: 14, losses: 12, otLosses: 4, nhlSeasonGoals: true, goalsFor: 2.9, goalsAgainst: 3.1 },
    }),
  });
  assert.ok(forcedAvg.bySport.NHL.stats.rateScale >= 1);
  assert.ok(codesOf(forcedAvg).includes('NHL:rate_scale'));

  const base = buildHealthRecord({
    snap: snap('NCAAF', [synth('Kentucky Wildcats', 'Arizona Wildcats', { total: 52, spread: -3 })], {}),
  });
  assert.strictEqual(base.bySport.NCAAF.stats.baselineTeams, 2);
  assert.ok(codesOf(base).includes('NCAAF:baseline_teams'));
  assert.strictEqual(base.bySport.NCAAF.stats.schemaMissing, 0);

  const seeded = buildHealthRecord({
    snap: snap('NFL', [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })], {}, {
      efficiencyBySport: {
        NFL: { 'Kansas City Chiefs': { offEpa: 0.1, defEpa: 0.02 } },
      },
    }),
  });
  assert.strictEqual(seeded.bySport.NFL.stats.baselineTeams, 1);

  const nhlBase = buildHealthRecord({
    snap: snap('NHL', [synth('Boston Bruins', 'Buffalo Sabres')], {}),
  });
  assert.strictEqual(nhlBase.bySport.NHL.stats.baselineTeams, 2);
  assert.ok(codesOf(nhlBase).includes('NHL:baseline_teams'));

  const cleanStandings = {
    NFL: {
      'Kansas City Chiefs': { wins: 3, losses: 2, gamesPlayed: 5, pf: 115, pa: 98 },
      'Buffalo Bills': { wins: 2, losses: 3, gamesPlayed: 5, pf: 102, pa: 110 },
    },
    NCAAF: {
      'Kentucky Wildcats': { wins: 4, losses: 1, gamesPlayed: 5, pf: 145, pa: 110 },
      'Arizona Wildcats': { wins: 2, losses: 3, gamesPlayed: 5, pf: 120, pa: 130 },
    },
    NHL: {
      'Boston Bruins': {
        pf: 248, pa: 210, goalsFor: 248, goalsAgainst: 210, nhlSeasonGoals: true,
        games: 80, wins: 45, losses: 25, otLosses: 10,
      },
      'Buffalo Sabres': {
        pf: 220, pa: 230, goalsFor: 220, goalsAgainst: 230, nhlSeasonGoals: true,
        games: 80, wins: 36, losses: 32, otLosses: 12,
      },
    },
  };
  const clean = buildHealthRecord({
    snap: {
      oddsBySport: {
        NFL: [synth('Kansas City Chiefs', 'Buffalo Bills', { total: 45, spread: -3 })],
        NCAAF: [synth('Kentucky Wildcats', 'Arizona Wildcats', { total: 52, spread: -3 })],
        NHL: [synth('Boston Bruins', 'Buffalo Sabres')],
      },
      standingsBySport: cleanStandings,
    },
  });
  for (const sport of ['NFL', 'NCAAF', 'NHL']) {
    const stats = clean.bySport[sport].stats;
    assert.strictEqual(stats.gpUnknown, 0, sport);
    assert.strictEqual(stats.rateScale, 0, sport);
    assert.strictEqual(stats.nhlPointsAsGoals, 0, sport);
    assert.strictEqual(stats.baselineTeams, 0, sport);
    assert.strictEqual(stats.schemaMissing, 0, sport);
  }
  const guardCodes = ['gp_unknown', 'rate_scale', 'nhl_points_as_goals', 'baseline_teams'];
  assert.ok(clean.alerts.every((a) => guardCodes.indexOf(a.code) < 0 && !String(a.code).startsWith('schema_missing:')));

  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let attached;
  try {
    attached = attachGenerateHealth({ picks: [] }, {
      snap: {
        oddsBySport: {
          NHL: [synth('Not A Real Hockey Club', 'Boston Bruins')],
        },
        standingsBySport: { NHL: {} },
      },
    });
  } finally {
    console.log = orig;
  }
  assert.ok(attached);
  const line = logs.find((entry) => entry.startsWith('[omega-guard]'));
  assert.ok(line, logs.join('\n'));
  assert.strictEqual(line, formatGuardLine(attached));
  assert.ok(line.includes('NHL unresolved=1'));
  assert.ok(line.includes('Not A Real Hockey Club'));
  assert.ok(line.includes('gp_unknown='));
  assert.ok(line.includes('NFL ') && line.includes('NCAAF '));
}

// Public card drops health. The ops endpoint returns the stored report as-is.
{
  const pub = publicPicksPayload({
    model: config.MODEL_VERSION,
    health: {
      status: 'warn',
      alerts: [{ sport: 'NHL', code: 'gp_unknown', detail: 'teams=1' }],
      bySport: { NHL: { stats: { gpUnknown: 1 } } },
    },
    picks: [{ pick: 'Boston Bruins -1.5', sport: 'NHL', odds: '-110', units: '1u' }],
    parlayLegs: [],
  });
  assert.strictEqual(pub.health, undefined);
  assert.strictEqual(pub.picks[0].pick, 'Boston Bruins -1.5');
  const endpoint = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-omega-health.js'), 'utf8');
  assert.ok(endpoint.includes('report'));
  assert.ok(!/compactHealth|delete report|report\.bySport/.test(endpoint));
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('attachGenerateHealth'));
}

console.log('PASS test-omega-identity-stat-guards');
