'use strict';
/**
 * NCAAF tempo total. Plays x points per play, shrunk to the FBS mean.
 * Weight 0 and a missing table leave the existing total unchanged.
 * No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const epa = require(path.join(root, 'sports/epa'));
const cfb = require(path.join(root, 'sports/cfb'));
const ingest = require(path.join(root, 'ingest'));

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

function synthEvent(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-03T23:30:00Z',
    bookmakers: ['pinnacle'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -140 }, { name: away, price: 120 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -7.5 },
          { name: away, price: -110, point: 7.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 51.5 },
          { name: 'Under', price: -110, point: 51.5 },
        ] },
      ],
    })),
  };
}

function byMarket(cands, market) {
  const row = cands.find((c) => c.market === market && (market !== 'Total' || /over/i.test(c.side)));
  assert.ok(row, 'missing ' + market);
  return row;
}

const HOME = 'Ohio State Buckeyes';
const AWAY = 'Iowa Hawkeyes';
const FCS = 'Cal Poly Mustangs';

assert.strictEqual(epa.NCAAF_TEMPO_WEIGHT, 0.25);
assert.strictEqual(epa.ncaafTempoWeight(), 0.25);
assert.strictEqual(epa.NCAAF_TEMPO_K_FBS, 4);
assert.strictEqual(epa.NCAAF_TEMPO_K_FCS, 24);
assert.strictEqual(epa.NCAAF_TEMPO_MEAN_PLAYS, 67);
assert.ok(/post-2023|plays cancel|points per game/i.test(epa.NCAAF_TEMPO_PROXY_NOTE));

// ESPN team statistics: offense categories, opponent list, plays and points.
{
  const body = {
    team: { id: '61', displayName: 'Georgia Bulldogs' },
    results: {
      stats: {
        categories: [
          { name: 'passing', stats: [
            { name: 'passingAttempts', value: 160 },
            { name: 'totalPoints', value: 277 },
            { name: 'teamGamesPlayed', value: 6 },
          ] },
          { name: 'rushing', stats: [
            { name: 'rushingAttempts', value: 203 },
            { name: 'totalOffensivePlays', value: 369 },
            { name: 'totalPoints', value: 277 },
            { name: 'teamGamesPlayed', value: 6 },
          ] },
        ],
      },
      opponent: [
        { name: 'rushing', stats: [
          { name: 'totalOffensivePlays', value: 391 },
          { name: 'totalPoints', value: 84 },
          { name: 'teamGamesPlayed', value: 6 },
        ] },
      ],
    },
  };
  const row = epa.parseEspnNcaafTeamStatistics(body);
  assert.strictEqual(row.espnId, '61');
  assert.strictEqual(row.games, 6);
  assert.ok(Math.abs(row.plays - 369 / 6) < 1e-9);
  assert.ok(Math.abs(row.offPpp - 277 / 369) < 1e-9);
  assert.ok(Math.abs(row.playsFaced - 391 / 6) < 1e-9);
  assert.ok(Math.abs(row.defPpp - 84 / 391) < 1e-9);
  assert.strictEqual(row.passAttempts, 160);
  assert.strictEqual(row.rushAttempts, 203);
  assert.strictEqual(epa.parseEspnNcaafTeamStatistics({ results: { stats: {}, opponent: [] } }), null);
}

// Points-per-game proxy. Four games, K=4, so the season is half weight.
// Plays are the mean and cancel. Total is 53.5.
{
  const table = {
    source: 'ppg-proxy',
    proxy: 'ppg',
    means: { plays: 67, offPpp: 26 / 67, defPpp: 26 / 67 },
    byName: {
      [HOME]: { games: 4, offPpg: 40, defPpg: 20, plays: null, offPpp: null, defPpp: null },
      [AWAY]: { games: 4, offPpg: 20, defPpg: 30, plays: null, offPpp: null, defPpp: null },
    },
  };
  const tempo = epa.ncaafTempoTotal({ home: HOME, away: AWAY, table });
  assert.ok(tempo);
  assert.strictEqual(tempo.proxy, 'ppg');
  assert.ok(Math.abs(tempo.total - 53.5) < 1e-9, tempo.total);
  assert.ok(Math.abs(tempo.combinedPlays - 134) < 1e-9, tempo.combinedPlays);
  assert.strictEqual(tempo.fcs, false);
}

// Real plays. Huge samples sit on the observation. Home 80 plays facing 50,
// away 60 plays facing 70, matchup PPP 0.475 and 0.325 → 52.
{
  const table = {
    source: 'espn-team-statistics',
    proxy: null,
    means: { plays: 67, offPpp: 0.4, defPpp: 0.4 },
    byName: {
      [HOME]: { games: 1e6, plays: 80, playsFaced: 70, offPpp: 0.5, defPpp: 0.3 },
      [AWAY]: { games: 1e6, plays: 60, playsFaced: 50, offPpp: 0.35, defPpp: 0.45 },
    },
  };
  const tempo = epa.ncaafTempoTotal({ home: HOME, away: AWAY, table });
  assert.ok(Math.abs(tempo.total - 52) < 1e-3, tempo.total);
  assert.ok(Math.abs(tempo.expPlaysHome - 65) < 1e-3, tempo.expPlaysHome);
  assert.ok(Math.abs(tempo.expPlaysAway - 65) < 1e-3, tempo.expPlaysAway);
  assert.strictEqual(tempo.fcs, false);
}

// FCS wide prior. The same hot offense shrinks harder for Cal Poly than for Iowa.
{
  const mean = { plays: 67, offPpp: 26 / 67, defPpp: 26 / 67 };
  const hot = { games: 6, offPpg: 50, defPpg: 26, plays: null, offPpp: null, defPpp: null };
  const calm = { games: 100, offPpg: 26, defPpg: 26, plays: null, offPpp: null, defPpp: null };
  const fcsTable = {
    proxy: 'ppg',
    means: mean,
    byName: { [HOME]: calm, [FCS]: hot },
  };
  const fbsTable = {
    proxy: 'ppg',
    means: mean,
    byName: { [HOME]: calm, [AWAY]: hot },
  };
  const fcs = epa.ncaafTempoTotal({ home: HOME, away: FCS, table: fcsTable });
  const fbs = epa.ncaafTempoTotal({ home: HOME, away: AWAY, table: fbsTable });
  assert.strictEqual(fcs.fcs, true);
  assert.strictEqual(fbs.fcs, false);
  assert.ok(Math.abs(fcs.total - 54.4) < 1e-9, fcs.total);
  assert.ok(Math.abs(fbs.total - 59.2) < 1e-9, fbs.total);
  assert.ok(Math.abs(fcs.total - 52) < Math.abs(fbs.total - 52));
}

// Standings record supplies games. Season sums become per-game rates.
{
  const table = epa.tempoTableFromStandings({
    [HOME]: { pf: 160, pa: 80, record: '4-0', wins: 4, losses: null, games: null },
    [AWAY]: { pf: 80, pa: 10, record: '1-0', wins: 1, losses: null, games: null },
    'Skip Me': { pf: 0, pa: 0, record: '0-0' },
  });
  assert.strictEqual(table.proxy, 'ppg');
  assert.strictEqual(table.byName[HOME].games, 4);
  assert.ok(Math.abs(table.byName[HOME].offPpg - 40) < 1e-9);
  assert.ok(Math.abs(table.byName[HOME].defPpg - 20) < 1e-9);
  assert.strictEqual(table.byName[HOME].plays, null);
  assert.strictEqual(table.byName[AWAY], undefined);
  assert.ok(table.skipped >= 2);
}

// Weight 0 is the existing total. A missing table at weight 0.5 is the same.
// A present table moves only the total. Spreads, uncertainty, and the floor stay put.
{
  const ev = synthEvent(HOME, AWAY);
  const standings = {
    [HOME]: { pf: 160, pa: 80, wins: 4, losses: 0 },
    [AWAY]: { pf: 90, pa: 100, wins: 2, losses: 2 },
  };
  const efficiency = {};
  const base = cfb.project({ oddsEvents: [ev], standings, efficiency, gameDay: {} });
  const baseTotal = byMarket(base, 'Total');
  const baseSpread = byMarket(base, 'Spread');
  const table = {
    proxy: 'ppg',
    means: { plays: 67, offPpp: 26 / 67, defPpp: 26 / 67 },
    byName: {
      [HOME]: { games: 4, offPpg: 40, defPpg: 20, plays: null },
      [AWAY]: { games: 4, offPpg: 20, defPpg: 30, plays: null },
    },
  };
  const off = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0' }, () => cfb.project({
    oddsEvents: [ev], standings, efficiency, gameDay: { ncaafTempo: table },
  }));
  assert.strictEqual(byMarket(off, 'Total').modelProjection, baseTotal.modelProjection);
  assert.strictEqual(byMarket(off, 'Total').projMethod, baseTotal.projMethod);
  assert.strictEqual(byMarket(off, 'Total').ncaafTempo, undefined);
  assert.strictEqual(byMarket(off, 'Total').uncertainty, baseTotal.uncertainty);

  // w=0 leaves every NCAAF candidate byte-identical to the pre-tempo
  // projection. The default weight is 0.25 and moves a table that is in hand.
  const evs = [ev, synthEvent(HOME, FCS)];
  const hotTable = {
    proxy: table.proxy,
    means: table.means,
    byName: {
      ...table.byName,
      [FCS]: { games: 6, offPpg: 50, defPpg: 10, plays: null },
    },
  };
  const zero = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0' }, () => cfb.project({
    oddsEvents: evs, standings, efficiency, gameDay: { ncaafTempo: hotTable },
  }));
  const bare = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0' }, () => cfb.project({
    oddsEvents: evs, standings, efficiency, gameDay: {},
  }));
  assert.strictEqual(JSON.stringify(zero), JSON.stringify(bare), 'w=0 leaves every NCAAF number byte-identical');
  const defOn = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: null }, () => cfb.project({
    oddsEvents: [ev], standings, efficiency, gameDay: { ncaafTempo: table },
  }));
  assert.strictEqual(byMarket(defOn, 'Total').ncaafTempo.weight, 0.25);
  assert.ok(String(byMarket(defOn, 'Total').projMethod).includes('tempo'));
  assert.ok(bare.length > off.length, 'both games are in the identity check');

  const missing = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0.5' }, () => cfb.project({
    oddsEvents: [ev], standings, efficiency, gameDay: {},
  }));
  assert.strictEqual(byMarket(missing, 'Total').modelProjection, baseTotal.modelProjection);
  assert.ok(!String(byMarket(missing, 'Total').projMethod).includes('tempo'));

  const moved = withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0.5' }, () => cfb.project({
    oddsEvents: [ev], standings, efficiency, gameDay: { ncaafTempo: table },
  }));
  const tot = byMarket(moved, 'Total');
  const spr = byMarket(moved, 'Spread');
  assert.ok(String(tot.projMethod).endsWith('-tempo'), tot.projMethod);
  assert.ok(!String(spr.projMethod).includes('tempo'));
  assert.strictEqual(spr.modelProjection, baseSpread.modelProjection);
  assert.strictEqual(tot.uncertainty, baseTotal.uncertainty);
  assert.strictEqual(tot.ncaafTempo.weight, 0.5);
  assert.strictEqual(tot.ncaafTempo.proxy, 'ppg');
  assert.strictEqual(tot.ncaafTempo.fcs, false);
  const expect = 0.5 * Number(baseTotal.modelTotalRaw) + 0.5 * 53.5;
  assert.ok(Math.abs(tot.modelTotalRaw - expect) < 1e-4, `${tot.modelTotalRaw} vs ${expect}`);
  assert.notStrictEqual(tot.modelProjection, baseTotal.modelProjection);
}

// Frozen snap and weight 0 do not call the statistics endpoint.
// The awaits sit inside a function so this file stays CommonJS.
(async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return {}; };
  const none = await withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0' }, () => ingest.loadNcaafTempo({
    standings: { [HOME]: { pf: 120, pa: 80, record: '4-0' } },
    teamIds: ['61'],
    fetchImpl,
  }));
  assert.strictEqual(none, null);
  assert.strictEqual(calls, 0);

  const prev = process.env.OMEGA_FROZEN_SNAP;
  process.env.OMEGA_FROZEN_SNAP = '/tmp/omega-frozen-snap-not-read.json';
  try {
    const frozen = await withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0.5' }, () => ingest.loadNcaafTempo({
      standings: { [HOME]: { pf: 120, pa: 80, record: '4-0' } },
      teamIds: ['61'],
      fetchImpl,
    }));
    assert.strictEqual(frozen, null);
    assert.strictEqual(calls, 0);
  } finally {
    if (prev == null) delete process.env.OMEGA_FROZEN_SNAP;
    else process.env.OMEGA_FROZEN_SNAP = prev;
  }

  // A provided fetch fills plays from the ESPN body and keeps the proxy row's name.
  const body = {
    team: { id: '194', displayName: HOME },
    results: {
      stats: { categories: [{ name: 'rushing', stats: [
        { name: 'totalOffensivePlays', value: 400 },
        { name: 'totalPoints', value: 200 },
        { name: 'teamGamesPlayed', value: 5 },
      ] }] },
      opponent: [{ name: 'rushing', stats: [
        { name: 'totalOffensivePlays', value: 350 },
        { name: 'totalPoints', value: 100 },
        { name: 'teamGamesPlayed', value: 5 },
      ] }],
    },
  };
  let seen = null;
  const table = await withEnv({ OMEGA_NCAAF_TEMPO_WEIGHT: '0.25' }, () => ingest.loadNcaafTempo({
    standings: { [HOME]: { pf: 150, pa: 90, record: '5-0' } },
    teamIds: ['194'],
    fetchImpl: async (url) => { seen = url; return body; },
  }));
  assert.ok(seen && seen.includes('/teams/194/statistics'), seen);
  assert.strictEqual(table.proxy, null);
  assert.strictEqual(table.source, 'espn-team-statistics');
  assert.ok(Math.abs(table.byName[HOME].plays - 80) < 1e-9);
  assert.ok(Math.abs(table.byName[HOME].offPpp - 0.5) < 1e-9);
  assert.strictEqual(table.byName[HOME].espnId, '194');

  console.log('test-omega-ncaaf-tempo: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
