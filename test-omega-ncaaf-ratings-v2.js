'use strict';
/**
 * NCAAF ratings v2. ESPN overall record supplies games played. Model
 * lookups stay on exact team identity. A side with no row is the centered
 * prior. Football candidates past the market-gap caps are rejected.
 * No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const ingest = require(path.join(root, 'ingest'));
const epa = require(path.join(root, 'sports/epa'));
const id = require(path.join(root, 'sports/team_identity'));
const { gamesPlayed, powerFromStandings, parseWinLossRecord } = require(path.join(root, 'sports/_common'));
const { gateReason, applyGates } = require(path.join(root, 'gates'));
const { buildHealthRecord, rateOf } = require(path.join(root, 'health'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.18-omega-vnext-keys');
assert.deepStrictEqual(config.FB_MARKET_GAP, {
  NCAAF: { margin: 14, total: 17 },
  NFL: { margin: 10, total: 13 },
});

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] == null) delete process.env[k];
    else process.env[k] = String(vars[k]);
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function overallStat(displayValue) {
  return { name: 'overall', type: 'total', value: null, displayValue };
}

// overall "3-2" fills losses and games. The display string is kept.
{
  const row = ingest.applyFootballStandingExtras(
    { pf: 140, pa: 120, wins: 3, losses: null },
    [
      { name: 'pointsFor', value: 140 },
      { name: 'pointsAgainst', value: 120 },
      { name: 'wins', value: 3 },
      overallStat('3-2'),
    ],
  );
  assert.strictEqual(row.record, '3-2');
  assert.strictEqual(row.losses, 2);
  assert.strictEqual(row.ties, 0);
  assert.strictEqual(row.gamesPlayed, 5);
  assert.strictEqual(row.games, 5);
  assert.strictEqual(row.pf, 140);
  assert.strictEqual(row.pa, 120);
}

// Undefeated "6-0" is losses 0 from the record, not from a missing field.
{
  const row = ingest.applyFootballStandingExtras(
    { pf: 180, pa: 40, wins: 6, losses: null },
    [overallStat('6-0')],
  );
  assert.strictEqual(row.record, '6-0');
  assert.strictEqual(row.losses, 0);
  assert.strictEqual(row.gamesPlayed, 6);
  assert.strictEqual(gamesPlayed(row), 6);
}

// W-L-T. Ties count.
{
  const parsed = parseWinLossRecord('4-3-1');
  assert.strictEqual(parsed.losses, 3);
  assert.strictEqual(parsed.ties, 1);
  assert.strictEqual(parsed.games, 8);
  const row = ingest.applyFootballStandingExtras(
    { pf: 200, pa: 180, wins: null, losses: null },
    [overallStat('4-3-1')],
  );
  assert.strictEqual(row.record, '4-3-1');
  assert.strictEqual(row.wins, 4);
  assert.strictEqual(row.losses, 3);
  assert.strictEqual(row.ties, 1);
  assert.strictEqual(row.gamesPlayed, 8);
  assert.strictEqual(gamesPlayed(row), 8);
}

// Wins with losses null and no record: games are unknown. Power is the prior.
{
  const row = { pf: 140, pa: 120, wins: 3, losses: null, ties: null, games: null };
  assert.strictEqual(gamesPlayed(row), 0);
  assert.strictEqual(powerFromStandings(row, 'NCAAF'), 0);
  const ingested = ingest.applyFootballStandingExtras(
    { pf: 140, pa: 120, wins: 3, losses: null },
    [{ name: 'wins', value: 3 }, { name: 'pointsFor', value: 140 }],
  );
  assert.strictEqual(ingested.losses, null);
  assert.strictEqual(ingested.record, undefined);
  assert.strictEqual(gamesPlayed(ingested), 0);
  assert.strictEqual(powerFromStandings(ingested, 'NCAAF'), 0);
}

// Replay shape: record supplies gp. Troy 3-2 is +4 per game, not +20 and not /wins.
{
  const troy = { pf: 140, pa: 120, wins: 3, losses: null, ties: null, games: null, record: '3-2' };
  assert.strictEqual(gamesPlayed(troy), 5);
  assert.strictEqual(powerFromStandings(troy, 'NCAAF'), 4);
  const msu = { pf: 96, pa: 128, wins: 1, losses: null, ties: null, games: null, record: '1-3' };
  assert.strictEqual(gamesPlayed(msu), 4);
  assert.strictEqual(powerFromStandings(msu, 'NCAAF'), -8);
}

// Health uses that same count, so a sane replay-shape table is in band.
{
  const troy = { pf: 140, pa: 120, wins: 3, losses: null, ties: null, games: null, record: '3-2' };
  assert.strictEqual(rateOf(troy, 'NCAAF'), 28);
  const table = {
    'Troy Trojans': troy,
    'Missouri State Bears': { pf: 96, pa: 128, wins: 1, losses: null, games: null, record: '1-3' },
    'South Florida Bulls': { pf: 133, pa: 73, wins: 4, losses: null, games: null, record: '4-1' },
    'UTSA Roadrunners': { pf: 157, pa: 131, wins: 4, losses: null, games: null, record: '4-1' },
    'Liberty Flames': { pf: 152, pa: 89, wins: 4, losses: null, games: null, record: '4-1' },
  };
  const rec = buildHealthRecord({
    dateISO: '2026-10-08',
    snap: {
      standingsBySport: { NCAAF: table },
      espnBySport: {},
      oddsBySport: {},
      mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
    },
    candidates: [],
    yesPool: [],
    oddsErrors: [],
  });
  assert.strictEqual(rec.bySport.NCAAF.stats.outOfBand, 0);
  assert.strictEqual(rec.bySport.NCAAF.stats.teams, 5);
}

// Mascot collision. South Florida is not Buffalo. Kentucky is not Arizona.
{
  const buffalo = { pf: 10, pa: 80, wins: 0, losses: 4, tag: 'BUF' };
  const arizona = { pf: 200, pa: 20, wins: 5, losses: 0, tag: 'AZ' };
  const table = {
    'Buffalo Bulls': buffalo,
    'Charlotte 49ers': { pf: 40, pa: 40, wins: 2, losses: 2, tag: 'CLT' },
    'Arizona Wildcats': arizona,
    'Kansas State Wildcats': { pf: 30, pa: 30, wins: 2, losses: 2, tag: 'KSU' },
    'Northwestern Wildcats': { pf: 70, pa: 40, wins: 3, losses: 1, tag: 'NU' },
  };
  assert.strictEqual(id.modelRow('NCAAF', table, 'South Florida Bulls'), null);
  assert.strictEqual(id.modelRow('NCAAF', table, 'Kentucky Wildcats'), null);
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'South Florida Bulls'), id.resolveTeamId('NCAAF', 'Buffalo Bulls'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Kentucky Wildcats'), id.resolveTeamId('NCAAF', 'Arizona Wildcats'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Kentucky Wildcats'), id.resolveTeamId('NCAAF', 'Kansas State Wildcats'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Kentucky Wildcats'), id.resolveTeamId('NCAAF', 'Northwestern Wildcats'));

  const proj = epa.footballProjection({
    sport: 'NCAAF',
    home: 'South Florida Bulls',
    away: 'Kentucky Wildcats',
    standings: table,
    efficiency: {
      'Buffalo Bulls': { offEpa: 0.2, defEpa: 0.2 },
      'Arizona Wildcats': { offEpa: 0.15, defEpa: 0.1 },
    },
  });
  assert.strictEqual(proj.unknownTeam, false);
  assert.strictEqual(proj.usedEpa, false);
  assert.strictEqual(proj.modelMargin, config.HFA.NCAAF);
  assert.strictEqual(epa.lookupEpa('South Florida Bulls', {
    'Buffalo Bulls': { offEpa: 0.2, defEpa: 0.2 },
  }, 'NCAAF'), null);
  assert.strictEqual(epa.lookupEpa('Kentucky Wildcats', {
    'Arizona Wildcats': { offEpa: 0.15, defEpa: 0.1 },
    'Kansas State Wildcats': { offEpa: 0.05, defEpa: 0.05 },
    'Northwestern Wildcats': { offEpa: 0.04, defEpa: 0.04 },
  }, 'NCAAF'), null);

  const merged = ingest.mergeTalentIntoEfficiency(
    {
      'Kentucky Wildcats': { offEpa: 0.01, defEpa: 0.01 },
      'South Florida Bulls': { offEpa: 0.02, defEpa: 0.02 },
    },
    { 'Arizona Wildcats': 2.2, 'Buffalo Bulls': -1, 'Kentucky Wildcats': 0.4 },
    'centered',
  );
  assert.strictEqual(merged['Kentucky Wildcats'].talent, 0.4);
  assert.strictEqual(merged['South Florida Bulls'].talent, undefined);
}

// Unknown / no-row sides sit at 0. Margin is HFA only when both are unknown.
{
  const both = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Not A Real University',
    away: 'Also Not Real',
    standings: {},
    efficiency: {},
  });
  assert.strictEqual(both.unknownTeam, true);
  assert.strictEqual(both.modelMargin, config.HFA.NCAAF);

  const homeRow = { pf: 120, pa: 40, wins: 4, losses: 0 };
  const one = epa.footballProjection({
    sport: 'NCAAF',
    home: 'Ohio State Buckeyes',
    away: 'Not A Real University',
    standings: { 'Ohio State Buckeyes': homeRow },
    efficiency: {},
  });
  const homePow = powerFromStandings(homeRow, 'NCAAF');
  assert.ok(homePow > 0);
  assert.strictEqual(one.unknownTeam, true);
  assert.ok(Math.abs(one.modelMargin - (homePow + config.HFA.NCAAF)) < 1e-9);
  assert.notStrictEqual(one.modelMargin, config.HFA.NCAAF);
}

function gapCandidate(extra) {
  return Object.assign({
    sport: 'NCAAF',
    market: 'Spread',
    side: 'Home -3',
    homeTeam: 'Home',
    awayTeam: 'Away',
    matchup: 'Away @ Home',
    commenceTime: '2026-10-10T23:00:00Z',
    odds: -110,
    coverProb: 0.55,
    ev: 0.05,
    edgePct: 0.04,
    liquid: true,
    placeable: true,
  }, extra);
}

const gateOpts = { cardDate: '2026-10-10', asOfMs: Date.parse('2026-10-10T16:00:00Z') };

// 25 vs 3 is rejected. An 8-point gap still prices.
{
  const absurd = gapCandidate({ modelMarginRaw: 25, marketMargin: 3, modelLineGap: 22 });
  assert.strictEqual(gateReason(absurd, gateOpts), 'model_market_gap');
  const rejected = applyGates([absurd], gateOpts).rejected;
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].rejectReason, 'model_market_gap');

  const close = gapCandidate({ modelMarginRaw: 11, marketMargin: 3, modelLineGap: 8 });
  assert.strictEqual(gateReason(close, gateOpts), null);
  assert.strictEqual(applyGates([close], gateOpts).yesPool.length, 1);

  const wideTotal = gapCandidate({
    market: 'Total',
    side: 'Over 45',
    modelTotalRaw: 70,
    marketTotal: 45,
    modelLineGap: 25,
  });
  assert.strictEqual(gateReason(wideTotal, gateOpts), 'model_market_gap');
  const okTotal = gapCandidate({
    market: 'Total',
    side: 'Over 45',
    modelTotalRaw: 53,
    marketTotal: 45,
    modelLineGap: 8,
  });
  assert.strictEqual(gateReason(okTotal, gateOpts), null);
}

// Health counts the guard and screams when margin bias is past 3x the sport limit.
{
  const rec = buildHealthRecord({
    dateISO: '2026-10-08',
    snap: {
      espnBySport: {},
      oddsBySport: {},
      standingsBySport: {},
      mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
    },
    candidates: [
      gapCandidate({ modelMarginRaw: 25, marketMargin: 3, modelLineGap: 22 }),
      {
        sport: 'NCAAF',
        matchup: 'A @ B',
        homeTeam: 'B',
        awayTeam: 'A',
        market: 'Spread',
        side: 'B -1',
        modelProjection: 10,
        line: -1,
        consensusLine: -1,
      },
    ],
    yesPool: [],
    oddsErrors: [],
  });
  assert.ok(rec.bySport.NCAAF.modelMarketGap >= 1);
  const codes = rec.alerts.map(a => a.code);
  assert.ok(codes.includes('model_market_gap'), codes.join(','));
  assert.ok(codes.includes('bias_margin_extreme'), codes.join(','));
}

// Env off restores the old count, the fuzzy mascot hit, HFA-for-any-unknown, and no gap reject.
{
  const troy = { pf: 140, pa: 120, wins: 3, losses: null, ties: null, games: null, record: '3-2' };
  const msu = { pf: 96, pa: 128, wins: 1, losses: null, games: null, record: '1-3' };
  withEnv({ OMEGA_NCAAF_GP_FIX: '0' }, () => {
    assert.strictEqual(gamesPlayed(troy), 3);
    assert.ok(Math.abs(powerFromStandings(troy, 'NCAAF') - (20 / 3)) < 1e-9);
    assert.strictEqual(gamesPlayed(msu), 1);
    assert.strictEqual(powerFromStandings(msu, 'NCAAF'), 96 - 128);
    const bare = ingest.applyFootballStandingExtras(
      { pf: 140, pa: 120, wins: 3, losses: null },
      [overallStat('3-2')],
    );
    assert.strictEqual(bare.losses, null);
    assert.strictEqual(bare.record, undefined);
  });
  assert.strictEqual(gamesPlayed(troy), 5);
  assert.strictEqual(powerFromStandings(troy, 'NCAAF'), 4);

  withEnv({ OMEGA_NCAAF_SHRINK_K: '4' }, () => {
    const shrunk = powerFromStandings(troy, 'NCAAF');
    assert.ok(Math.abs(shrunk - (4 * (5 / 9))) < 1e-9, shrunk);
  });
  assert.strictEqual(powerFromStandings(troy, 'NCAAF'), 4);

  const buffalo = { pf: 10, pa: 80, wins: 0, losses: 4, tag: 'BUF' };
  // Both names resolve. The pre-fix lookup already refuses that mascot.
  withEnv({ OMEGA_TEAM_EXACT_ONLY: 'off' }, () => {
    assert.strictEqual(id.modelRow('NCAAF', { 'Buffalo Bulls': buffalo }, 'South Florida Bulls'), null);
  });
  // An unresolved key is what used to fall through to the last word.
  const loose = {
    'Buffalo Bulls': buffalo,
    'Mystery Club': { pf: 1, pa: 1, wins: 0, losses: 1, tag: 'X' },
  };
  withEnv({ OMEGA_TEAM_EXACT_ONLY: 'off' }, () => {
    assert.strictEqual(id.modelRow('NCAAF', loose, 'South Florida Bulls'), buffalo);
  });
  assert.strictEqual(id.modelRow('NCAAF', loose, 'South Florida Bulls'), null);

  const homeRow = { pf: 120, pa: 40, wins: 4, losses: 0 };
  withEnv({ OMEGA_CENTER_DEFAULT: '0' }, () => {
    const one = epa.footballProjection({
      sport: 'NCAAF',
      home: 'Ohio State Buckeyes',
      away: 'Not A Real University',
      standings: { 'Ohio State Buckeyes': homeRow },
      efficiency: {},
    });
    assert.strictEqual(one.modelMargin, config.HFA.NCAAF);
  });

  const absurd = gapCandidate({ modelMarginRaw: 25, marketMargin: 3, modelLineGap: 22 });
  withEnv({ OMEGA_FB_GAP_GUARD: 'off' }, () => {
    assert.notStrictEqual(gateReason(absurd, gateOpts), 'model_market_gap');
  });
  withEnv({ OMEGA_FB_GAP_NCAAF_MARGIN: '5' }, () => {
    const eight = gapCandidate({ modelMarginRaw: 11, marketMargin: 3, modelLineGap: 8 });
    assert.strictEqual(gateReason(eight, gateOpts), 'model_market_gap');
  });
  assert.strictEqual(gateReason(gapCandidate({ modelMarginRaw: 11, marketMargin: 3, modelLineGap: 8 }), gateOpts), null);
}

// NFL explicit losses / gp stay on the pre-fix power.
{
  assert.strictEqual(
    powerFromStandings({ pf: 46, pa: 55, wins: 2, losses: 1 }, 'NFL'),
    (46 - 55) / 3,
  );
  assert.strictEqual(
    powerFromStandings({ pf: 46, pa: 55, wins: 2, losses: 1, gamesPlayed: 3 }, 'NFL'),
    (46 - 55) / 3,
  );
  assert.strictEqual(
    powerFromStandings({ pf: 30, pa: 20, wins: 2, losses: 1 }, 'NFL'),
    10 / 3,
  );
  assert.strictEqual(
    powerFromStandings({ pf: 46, pa: 55, wins: 1, losses: 0 }, 'NFL'),
    46 - 55,
  );
  const nfl = ingest.applyFootballStandingExtras(
    { pf: 46, pa: 55, wins: 2, losses: 1 },
    [
      { name: 'wins', value: 2 },
      { name: 'losses', value: 1 },
      { name: 'gamesPlayed', value: 3 },
      overallStat('9-0'),
    ],
  );
  assert.strictEqual(nfl.losses, 1);
  assert.strictEqual(nfl.gamesPlayed, 3);
  assert.strictEqual(nfl.games, 3);
  assert.strictEqual(powerFromStandings(nfl, 'NFL'), (46 - 55) / 3);
  const untouched = ingest.applyFootballStandingExtras(
    { pf: 46, pa: 55, wins: 2, losses: 1 },
    [
      { name: 'pointsFor', value: 46 },
      { name: 'pointsAgainst', value: 55 },
      { name: 'wins', value: 2 },
      { name: 'losses', value: 1 },
    ],
  );
  assert.strictEqual(untouched.games, undefined);
  assert.strictEqual(untouched.gamesPlayed, undefined);
  assert.strictEqual(untouched.losses, 1);
  assert.strictEqual(untouched.record, undefined);
}

console.log('test-omega-ncaaf-ratings-v2: ok');
