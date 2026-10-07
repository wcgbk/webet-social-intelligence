'use strict';
/** MLB park factor applied once. No network. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const env = require(path.join(root, 'sports/mlb_env'));
const mlb = require(path.join(root, 'sports/mlb'));

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || 'close'} ${actual} vs ${expected}`);
}

function synthEvent(home, away, total) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-09-22T23:10:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -120 }, { name: away, price: 100 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ]},
      ],
    })),
  };
}

function totalOf(cands) {
  const row = cands.find(c => c.market === 'Total');
  assert.ok(row, 'missing total');
  return row;
}

const COL = 'Colorado Rockies';
const LAD = 'Los Angeles Dodgers';
const ATL = 'Atlanta Braves';
const KC = 'Kansas City Royals';

// (a) League-average clubs, parks 1.00, venue 1.00 → 8.8, unshifted.
{
  const parks = {
    [ATL]: { park: 1.00, abbr: 'ATL', team: ATL },
    [KC]: { park: 1.00, abbr: 'KC', team: KC },
  };
  const atl = { pf: 4.4, pa: 4.4 };
  const kc = { pf: 4.4, pa: 4.4 };
  const sum = 1 + 1;
  const n = 2;
  const pfRoad = (sum - 1) / (n - 1);
  const adj = (1 + pfRoad) / 2;
  close(adj, 1, 'league parks neutralize to 1');
  close(env.teamParkAdj(1, parks), adj, 'teamParkAdj league');

  const bare = env.mlbStandingsEnv(atl, kc);
  const neutral = env.mlbStandingsEnv(atl, kc, {
    parkFactors: parks, homeTeam: ATL, awayTeam: KC,
  });
  close(bare.modelTotal, 8.8, 'bare league total');
  close(neutral.modelTotal, 8.8, 'neutral league total');
  close(neutral.modelTotal, bare.modelTotal, '1.00 parks do not shift the environment');
  close(neutral.homeParkAdj, 1, 'home adj');
  close(neutral.awayParkAdj, 1, 'away adj');
  const parked = env.applySpPark({
    modelMargin: neutral.modelMargin,
    modelTotal: neutral.modelTotal,
    homeQ: null,
    awayQ: null,
    parkFactor: 1,
  });
  close(parked.modelTotal, 8.8, 'venue 1.00 leaves 8.8');
  assert.strictEqual(parked.modelMargin, neutral.modelMargin);

  const cands = mlb.project({
    oddsEvents: [synthEvent(ATL, KC, 8.5)],
    standings: { [ATL]: atl, [KC]: kc },
    parkFactors: parks,
    mlbPitcherStats: {},
    espnGames: [],
  });
  const tot = totalOf(cands);
  // One game: both total toggles default on, so n<3 subtracts the prior once
  // after the park-neutral environment. The 8.8 above is that environment.
  const leagueShifted = +env.applyMlbTotalShift(8.8, env.MLB_TOTAL_PRIOR_OFFSET).toFixed(2);
  close(tot.modelProjection, leagueShifted, 'projected league total');
  assert.strictEqual(tot.projMethod, 'mlb-sp-park-v1-total');
  close(tot.gameDay.homeParkAdj, 1, 'diag home');
  close(tot.gameDay.awayParkAdj, 1, 'diag away');
}

// (b) Coors-inflated club hosts a park-1.00 club. Venue 1.21 once.
// Two-team table: both exposures are (1.21 + 1.00) / 2.
{
  const pfCol = 1.21;
  const pfLad = 1.00;
  const parks = {
    [COL]: { park: pfCol, abbr: 'COL', team: COL },
    [LAD]: { park: pfLad, abbr: 'LAD', team: LAD },
  };
  const colRs = 5.5;
  const colRa = 5.0;
  const ladRs = 4.4;
  const ladRa = 4.4;
  const col = { pf: colRs, pa: colRa };
  const lad = { pf: ladRs, pa: ladRa };
  const sum = pfCol + pfLad;
  const n = 2;
  const colRoad = (sum - pfCol) / (n - 1);
  const ladRoad = (sum - pfLad) / (n - 1);
  const colAdj = (pfCol + colRoad) / 2;
  const ladAdj = (pfLad + ladRoad) / 2;
  close(colAdj, ladAdj, 'two-team exposures match');
  close(env.teamParkAdj(pfCol, parks), colAdj, 'teamParkAdj Coors');
  close(env.teamParkAdj(pfLad, parks), ladAdj, 'teamParkAdj neutral club');

  const nColRs = colRs / colAdj;
  const nColRa = colRa / colAdj;
  const nLadRs = ladRs / ladAdj;
  const nLadRa = ladRa / ladAdj;
  const neutralRuns = (nColRs + nLadRa) / 2 + (nLadRs + nColRa) / 2;
  const rawRuns = (colRs + ladRa) / 2 + (ladRs + colRa) / 2;
  const hand = neutralRuns * pfCol;
  const old = rawRuns * pfCol;
  assert.ok(hand < old, `neutralized ${hand} should be under raw×park ${old}`);
  close(old / hand, colAdj, 'lower than raw×1.21 by the neutralization factor');
  close(hand, neutralRuns * 1.21, 'venue once');
  assert.ok(Math.abs(hand - rawRuns * 1.21 * 1.21) > 0.5, 'not the doubled Coors factor');

  const runEnv = env.mlbStandingsEnv(col, lad, {
    parkFactors: parks, homeTeam: COL, awayTeam: LAD,
  });
  close(runEnv.homeRs, nColRs, 'home rs neutralized');
  close(runEnv.homeRa, nColRa, 'home ra neutralized');
  close(runEnv.awayRs, nLadRs, 'away rs neutralized');
  close(runEnv.awayRa, nLadRa, 'away ra neutralized');
  close(runEnv.modelTotal, neutralRuns, 'neutral environment');
  close(runEnv.homeParkAdj, colAdj, 'homeParkAdj');
  close(runEnv.awayParkAdj, ladAdj, 'awayParkAdj');
  const parked = env.applySpPark({
    modelMargin: runEnv.modelMargin,
    modelTotal: runEnv.modelTotal,
    homeQ: null,
    awayQ: null,
    parkFactor: pfCol,
  });
  close(parked.modelTotal, hand, 'hand total');
  assert.strictEqual(parked.modelMargin, runEnv.modelMargin, 'venue does not scale margin');

  const rpg = { rs: colRs, ra: colRa };
  const divided = env.neutralizeRpg(rpg, colAdj);
  close(divided.rs, nColRs, 'neutralizeRpg rs');
  close(divided.ra, nColRa, 'neutralizeRpg ra');
  assert.strictEqual(rpg.rs, colRs, 'neutralizeRpg does not mutate');

  const cands = mlb.project({
    oddsEvents: [synthEvent(COL, LAD, 9.5)],
    standings: { [COL]: col, [LAD]: lad },
    parkFactors: parks,
    mlbPitcherStats: {},
    espnGames: [],
  });
  const tot = totalOf(cands);
  // Same one-game prior, applied to the once-parked total.
  assert.strictEqual(tot.modelProjection, +env.applyMlbTotalShift(hand, env.MLB_TOTAL_PRIOR_OFFSET).toFixed(2));
  close(tot.gameDay.homeParkAdj, colAdj, 'projection homeParkAdj');
  close(tot.gameDay.awayParkAdj, ladAdj, 'projection awayParkAdj');
  const spread = cands.find(c => c.market === 'Spread');
  assert.strictEqual(spread.modelProjection, +runEnv.modelMargin.toFixed(2));
  assert.notStrictEqual(spread.modelProjection, +(runEnv.modelMargin * pfCol).toFixed(2));

  // (c) Same Coors club on the road at a 1.00 park. Rates stay neutralized.
  const roadEnv = env.mlbStandingsEnv(lad, col, {
    parkFactors: parks, homeTeam: LAD, awayTeam: COL,
  });
  assert.ok(roadEnv.awayRs < colRs, `road rs ${roadEnv.awayRs} vs raw ${colRs}`);
  assert.ok(roadEnv.awayRa < colRa, `road ra ${roadEnv.awayRa} vs raw ${colRa}`);
  close(roadEnv.awayRs, colRs / colAdj, 'road rs');
  close(roadEnv.awayRa, colRa / colAdj, 'road ra');
  close(roadEnv.awayParkAdj, colAdj, 'road awayParkAdj');
  const roadParked = env.applySpPark({
    modelMargin: roadEnv.modelMargin,
    modelTotal: roadEnv.modelTotal,
    homeQ: null,
    awayQ: null,
    parkFactor: pfLad,
  });
  close(roadParked.modelTotal, roadEnv.modelTotal * 1, 'venue 1.00 once');
  assert.ok(roadParked.modelTotal < rawRuns, `road total ${roadParked.modelTotal} vs raw ${rawRuns}`);
  const roadCands = mlb.project({
    oddsEvents: [synthEvent(LAD, COL, 8.5)],
    standings: { [COL]: col, [LAD]: lad },
    parkFactors: parks,
    mlbPitcherStats: {},
    espnGames: [],
  });
  const rawCands = mlb.project({
    oddsEvents: [synthEvent(LAD, COL, 8.5)],
    standings: { [COL]: col, [LAD]: lad },
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  });
  const roadTot = totalOf(roadCands);
  const rawTot = totalOf(rawCands);
  assert.ok(roadTot.modelProjection < rawTot.modelProjection, `${roadTot.modelProjection} vs raw ${rawTot.modelProjection}`);
  close(roadTot.gameDay.awayParkAdj, colAdj, 'road diag');
  assert.strictEqual(roadTot.modelProjection, +env.applyMlbTotalShift(roadParked.modelTotal, env.MLB_TOTAL_PRIOR_OFFSET).toFixed(2));
}

// (d) Missing park row matches the old factor-1 path.
{
  const col = { pf: 5.5, pa: 5.0 };
  const lad = { pf: 4.4, pa: 4.4 };
  const bare = env.mlbStandingsEnv(col, lad);
  const missing = env.mlbStandingsEnv(col, lad, {
    parkFactors: { 'New York Yankees': { park: 1.04, abbr: 'NYY', team: 'New York Yankees' } },
    homeTeam: COL,
    awayTeam: LAD,
  });
  assert.strictEqual(missing.modelTotal, bare.modelTotal);
  assert.strictEqual(missing.modelMargin, bare.modelMargin);
  assert.strictEqual(missing.homeRs, bare.homeRs);
  assert.strictEqual(missing.awayRs, bare.awayRs);
  assert.strictEqual(missing.homeParkAdj, 1);
  assert.strictEqual(missing.awayParkAdj, 1);
  assert.strictEqual(env.teamParkAdj(null, {}), 1);
  const kept = env.neutralizeRpg({ rs: 5.5, ra: 5 }, 1);
  assert.strictEqual(kept.rs, 5.5);
  assert.strictEqual(kept.ra, 5);
  const asOne = env.applySpPark({
    modelMargin: bare.modelMargin,
    modelTotal: bare.modelTotal,
    homeQ: null,
    awayQ: null,
    parkFactor: 1,
  });
  const noVenue = env.applySpPark({
    modelMargin: missing.modelMargin,
    modelTotal: missing.modelTotal,
    homeQ: null,
    awayQ: null,
    parkFactor: null,
  });
  close(noVenue.modelTotal, asOne.modelTotal, 'missing row matches factor 1');
  close(noVenue.modelTotal, bare.modelTotal, 'missing row leaves the old total');

  const standings = { [COL]: col, [LAD]: lad };
  const ev = synthEvent(COL, LAD, 9);
  const oldProj = totalOf(mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: {}, espnGames: [],
  }));
  const missProj = totalOf(mlb.project({
    oddsEvents: [ev],
    standings,
    parkFactors: { 'New York Yankees': { park: 1.04, abbr: 'NYY', team: 'New York Yankees' } },
    mlbPitcherStats: {},
    espnGames: [],
  }));
  assert.strictEqual(missProj.modelProjection, oldProj.modelProjection);
  assert.strictEqual(missProj.modelProjection, +env.applyMlbTotalShift(bare.modelTotal, env.MLB_TOTAL_PRIOR_OFFSET).toFixed(2));
  assert.strictEqual(missProj.projMethod, 'mlb-total-baseline');
  const spreadOld = mlb.project({
    oddsEvents: [ev], standings, parkFactors: {}, mlbPitcherStats: {}, espnGames: [],
  }).find(c => c.market === 'Spread');
  const spreadMiss = mlb.project({
    oddsEvents: [ev],
    standings,
    parkFactors: { 'New York Yankees': { park: 1.04, abbr: 'NYY', team: 'New York Yankees' } },
    mlbPitcherStats: {},
    espnGames: [],
  }).find(c => c.market === 'Spread');
  assert.strictEqual(spreadMiss.modelProjection, spreadOld.modelProjection);
}

console.log('PASS test-omega-mlb-park-single');
