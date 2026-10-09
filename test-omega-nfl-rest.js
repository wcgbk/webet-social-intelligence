'use strict';
/**
 * NFL/NCAAF rest days. No network. No Odds API.
 * OMEGA_REST_ADJ=0 must match the played-yesterday proxy from 8c2d498.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const gd = require(path.join(root, 'sports/game_day'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const { applyEngineStack } = require(path.join(root, 'sports/epa'));
const { resolveTeamId, isFbsTeamId } = require(path.join(root, 'sports/team_identity'));
const { ingest } = require(path.join(root, 'ingest'));
const { etCalendarDate } = require(path.join(root, 'odds_math'));
const rest = require(path.join(root, 'sports/rest_schedule'));
const { runWithFetchMemo } = require(path.join(root, 'fetch_memo'));
const { buildHealthRecord } = require(path.join(root, 'health'));

const FIXTURES = '/workspace/omega-replay-2w/inputs/_shared/rest-schedules';

assert.strictEqual(config.MODEL_VERSION, 'v12.3.14-omega-vnext-rest');
assert.strictEqual(config.REST_ADJ.NFL.cap, 1);
assert.strictEqual(config.REST_ADJ.NCAAF.cap, 1);
assert.strictEqual(config.REST_ADJ.NFL.totalCap, 0);
assert.strictEqual(config.REST_ADJ.NCAAF.totalCap, 0);
assert.ok(/OMEGA_REST_ADJ=0/.test(config.MODEL_NOTES));

function sched(games) {
  return { loaded: true, fetchFailed: false, games, weeks: [1, 2, 3], week: 3, source: 'test' };
}

function kick(iso) {
  return iso;
}

// Thursday 8:20pm ET is 00:20Z Friday. Sunday 1pm ET is 17:00Z.
const SUN_W3 = '2026-09-27T17:00:00Z';
const MON_W3 = '2026-09-29T00:15:00Z'; // Monday Sep 28, 8:15pm ET
const TNF = '2026-10-02T00:20:00Z'; // Thursday Oct 1 ET
const SUN_W4 = '2026-10-04T17:00:00Z';
const SUN_W5 = '2026-10-11T17:00:00Z';
const SAT_W4 = '2026-10-03T17:00:00Z';

assert.strictEqual(etCalendarDate(TNF), '2026-10-01');
assert.strictEqual(gd.etWeekday(TNF), 'Thu');
assert.strictEqual(gd.etWeekday(SUN_W3), 'Sun');
assert.strictEqual(gd.etWeekday(MON_W3), 'Mon');
assert.strictEqual(gd.etCalendarDaysBetween(SUN_W3, TNF), 4);
assert.strictEqual(gd.etCalendarDaysBetween(TNF, SUN_W5), 10);
assert.strictEqual(gd.etCalendarDaysBetween(SUN_W3, SUN_W5), 14);
assert.strictEqual(gd.etCalendarDaysBetween(MON_W3, SUN_W4), 6);

// TNF after Sunday: both short, net is only the road-travel term.
{
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '2', commence: SUN_W3 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', TNF);
  assert.strictEqual(d.restDays.home, 4);
  assert.strictEqual(d.restDays.away, 4);
  assert.strictEqual(d.restCategory.home, 'short');
  assert.strictEqual(d.restCategory.away, 'short');
  assert.strictEqual(d.restAdj, config.REST_ADJ.NFL.roadShort);
  assert.strictEqual(d.restAdj, 0.35);
  assert.strictEqual(d.totalAdj, 0);
}

// One-sided short road team is inside −0.5 to −1.0.
{
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: '2026-09-24T00:20:00Z' }, // Thu Sep 23 ET → 8 days, normal
    { teamId: '2', commence: SUN_W3 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', TNF);
  assert.strictEqual(d.restCategory.home, 'normal');
  assert.strictEqual(d.restCategory.away, 'short');
  assert.strictEqual(d.restAdj, 0.9);
}

// Mini-bye (10 days after TNF) vs a normal Sunday team.
{
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: TNF },
    { teamId: '2', commence: SUN_W4 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', SUN_W5);
  assert.strictEqual(d.restDays.home, 10);
  assert.strictEqual(d.restDays.away, 7);
  assert.strictEqual(d.restCategory.home, 'mini-bye');
  assert.strictEqual(d.restCategory.away, 'normal');
  assert.strictEqual(d.restAdj, 0.35);
}

// Bye (≥13) vs normal.
{
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '2', commence: SUN_W4 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', SUN_W5);
  assert.strictEqual(d.restDays.home, 14);
  assert.strictEqual(d.restCategory.home, 'bye');
  assert.strictEqual(d.restDays.away, 7);
  assert.strictEqual(d.restAdj, 0.7);
}

// MNF → Sunday is 6 days and is not a normal week. Sunday → Saturday is 6 and is normal.
{
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: MON_W3 },
    { teamId: '2', commence: SUN_W3 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', SUN_W4);
  assert.strictEqual(d.restDays.home, 6);
  assert.strictEqual(d.restCategory.home, 'mnf');
  assert.strictEqual(d.restDays.away, 7);
  assert.strictEqual(d.restCategory.away, 'normal');
  assert.strictEqual(d.restAdj, -0.35);
  const sat = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '2', commence: SUN_W3 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', SAT_W4);
  assert.strictEqual(sat.restDays.home, 6);
  assert.strictEqual(gd.etWeekday(SAT_W4), 'Sat');
  assert.strictEqual(sat.restCategory.home, 'normal');
  assert.strictEqual(sat.restAdj, 0);
}

// Week 1: the game itself is not a prior game. Unknown → adj 0.
{
  const week1 = '2026-09-13T17:00:00Z';
  const d = gd.describeMatchRest('NFL', sched([
    { teamId: '12', commence: week1 },
    { teamId: '2', commence: week1 },
  ]), 'Kansas City Chiefs', 'Buffalo Bills', week1);
  assert.strictEqual(d.restDays.home, null);
  assert.strictEqual(d.restDays.away, null);
  assert.strictEqual(d.restCategory.home, 'unknown');
  assert.strictEqual(d.restCategory.away, 'unknown');
  assert.strictEqual(d.restAdj, 0);
}

// Exact ESPN id only. A nearby name and the other club's id do not match.
{
  assert.strictEqual(resolveTeamId('NFL', 'Chiefs'), null);
  assert.strictEqual(resolveTeamId('NFL', 'Kansas City Chiefs'), '12');
  const onlyRaiders = sched([{ teamId: '13', commence: SUN_W3 }]);
  assert.strictEqual(gd.teamRest('NFL', onlyRaiders, 'Kansas City Chiefs', TNF).restDays, null);
  assert.strictEqual(gd.teamRest('NFL', onlyRaiders, 'Chiefs', TNF).restDays, null);
  assert.strictEqual(gd.teamRest('NFL', onlyRaiders, 'Las Vegas Raiders', TNF).restDays, 4);
  const chiefs = sched([{ teamId: '12', commence: SUN_W3 }]);
  assert.strictEqual(gd.teamRest('NFL', chiefs, 'Las Vegas Raiders', TNF).category, 'unknown');
}

// No future leakage: a later kickoff on the same weekly board is ignored.
{
  const board = sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '12', commence: SUN_W4 },
    { teamId: '2', commence: SUN_W4 },
  ]);
  const chiefs = gd.teamRest('NFL', board, 'Kansas City Chiefs', TNF);
  assert.strictEqual(chiefs.restDays, 4);
  assert.strictEqual(chiefs.prevCommence, SUN_W3);
  const bills = gd.teamRest('NFL', board, 'Buffalo Bills', TNF);
  assert.strictEqual(bills.category, 'unknown');
  assert.strictEqual(bills.restDays, null);
}

// Cap ±1.0. Bye vs short-road is 1.60 raw; short home vs bye is −1.25 raw.
{
  const hi = gd.restMarginAdj('NFL', 'bye', 'short');
  const lo = gd.restMarginAdj('NFL', 'short', 'bye');
  assert.strictEqual(hi, 1);
  assert.strictEqual(lo, -1);
  assert.ok(Math.abs(hi) <= 1 && Math.abs(lo) <= 1);
  const raw = 0.70 - (-0.55) + 0.35;
  assert.ok(raw > 1);
  assert.ok((-0.55 - 0.70) < -1);
}

// NCAAF midweek after Saturday, and bye, at half the NFL size. Totals stay 0.
{
  const sat = '2026-09-26T23:00:00Z'; // Saturday Sep 26 ET (7pm-ish)
  const wed = '2026-09-30T23:00:00Z'; // Wednesday Sep 30 ET
  assert.strictEqual(gd.etWeekday(wed), 'Wed');
  assert.strictEqual(gd.etCalendarDaysBetween(sat, wed), 4);
  const both = gd.describeMatchRest('NCAAF', sched([
    { teamId: resolveTeamId('NCAAF', 'Georgia Bulldogs'), commence: sat },
    { teamId: resolveTeamId('NCAAF', 'Alabama Crimson Tide'), commence: sat },
  ]), 'Georgia Bulldogs', 'Alabama Crimson Tide', wed);
  assert.strictEqual(both.restCategory.home, 'short');
  assert.strictEqual(both.restCategory.away, 'short');
  assert.strictEqual(both.restDays.home, 4);
  assert.strictEqual(both.restAdj, 0.175);
  const bye = gd.describeMatchRest('NCAAF', sched([
    { teamId: resolveTeamId('NCAAF', 'Georgia Bulldogs'), commence: '2026-09-12T23:00:00Z' },
    // Prior Saturday, not the candidate kickoff. Seven ET days is a normal week.
    { teamId: resolveTeamId('NCAAF', 'Alabama Crimson Tide'), commence: '2026-09-19T23:00:00Z' },
  ]), 'Georgia Bulldogs', 'Alabama Crimson Tide', sat);
  assert.strictEqual(bye.restDays.home, 14);
  assert.strictEqual(bye.restDays.away, 7);
  assert.strictEqual(bye.restCategory.home, 'bye');
  assert.strictEqual(bye.restCategory.away, 'normal');
  assert.strictEqual(bye.restAdj, 0.35);
  const weekend = gd.describeMatchRest('NCAAF', sched([
    { teamId: resolveTeamId('NCAAF', 'Georgia Bulldogs'), commence: sat },
    { teamId: resolveTeamId('NCAAF', 'Alabama Crimson Tide'), commence: sat },
  ]), 'Georgia Bulldogs', 'Alabama Crimson Tide', '2026-10-03T23:00:00Z');
  assert.strictEqual(gd.etWeekday('2026-10-03T23:00:00Z'), 'Sat');
  assert.strictEqual(weekend.restCategory.home, 'normal');
  assert.strictEqual(weekend.restAdj, 0);
  assert.ok(Math.abs(both.restAdj) <= 1 && Math.abs(bye.restAdj) <= 1);
}

// ESPN 60s early is the current game, not a prior. Sunday −60s stays normal.
// Same pair inside 36h on the previous ET date is still this game.
{
  const sun = '2026-10-04T17:00:00Z';
  const early = '2026-10-04T16:59:00Z';
  const prior = '2026-09-27T17:00:00Z';
  const shifted = sched([
    { teamId: '12', opponentId: '2', commence: prior },
    { teamId: '2', opponentId: '12', commence: prior },
    { teamId: '12', opponentId: '2', commence: early },
    { teamId: '2', opponentId: '12', commence: early },
  ]);
  const d = gd.describeMatchRest('NFL', shifted, 'Kansas City Chiefs', 'Buffalo Bills', sun);
  assert.strictEqual(d.restDays.home, 7);
  assert.strictEqual(d.restDays.away, 7);
  assert.strictEqual(d.restCategory.home, 'normal');
  assert.strictEqual(d.restCategory.away, 'normal');
  assert.strictEqual(d.restAdj, 0);
  const cross = '2026-10-03T21:00:00Z';
  const crossed = sched([
    { teamId: '12', opponentId: '2', commence: prior },
    { teamId: '2', opponentId: '12', commence: prior },
    { teamId: '12', opponentId: '2', commence: cross },
    { teamId: '2', opponentId: '12', commence: cross },
  ]);
  const c = gd.describeMatchRest('NFL', crossed, 'Kansas City Chiefs', 'Buffalo Bills', sun);
  assert.strictEqual(c.restDays.home, 7);
  assert.strictEqual(c.restCategory.home, 'normal');
  assert.strictEqual(c.restAdj, 0);
  const satNight = sched([
    { teamId: '12', opponentId: '13', commence: cross },
    { teamId: '2', opponentId: '13', commence: prior },
  ]);
  const other = gd.describeMatchRest('NFL', satNight, 'Kansas City Chiefs', 'Buffalo Bills', sun);
  assert.strictEqual(other.restDays.home, 1);
  assert.strictEqual(other.restCategory.home, 'short');
  assert.strictEqual(other.restDays.away, 7);
}

// Neutral site drops roadShort and keeps a one-sided rest differential.
{
  assert.strictEqual(gd.restMarginAdj('NFL', 'short', 'short', { neutralSite: true }), 0);
  assert.strictEqual(gd.restMarginAdj('NFL', 'normal', 'short', { neutralSite: true }), 0.55);
  assert.strictEqual(gd.restMarginAdj('NFL', 'normal', 'short'), 0.9);
  assert.strictEqual(gd.restMarginAdj('NCAAF', 'short', 'short', { neutralSite: true }), 0);
  const sat = '2026-09-26T23:00:00Z';
  const wed = '2026-09-30T23:00:00Z';
  const geo = resolveTeamId('NCAAF', 'Georgia Bulldogs');
  const ala = resolveTeamId('NCAAF', 'Alabama Crimson Tide');
  const board = sched([
    { teamId: geo, opponentId: ala, commence: sat },
    { teamId: ala, opponentId: geo, commence: sat },
  ]);
  const plain = gd.describeMatchRest('NCAAF', board, 'Georgia Bulldogs', 'Alabama Crimson Tide', wed);
  const neutral = gd.describeMatchRest('NCAAF', board, 'Georgia Bulldogs', 'Alabama Crimson Tide', wed, { neutralSite: true });
  assert.strictEqual(plain.restAdj, 0.175);
  assert.strictEqual(neutral.restAdj, 0);
  assert.strictEqual(neutral.restCategory.home, 'short');
  assert.strictEqual(neutral.restCategory.away, 'short');
  const rows = cfb.project({
    oddsEvents: [synth('Georgia Bulldogs', 'Alabama Crimson Tide', wed)],
    standings: {
      'Georgia Bulldogs': { wins: 2, losses: 0, pf: 60, pa: 20, games: 2 },
      'Alabama Crimson Tide': { wins: 2, losses: 0, pf: 55, pa: 21, games: 2 },
    },
    efficiency: {},
    gameDay: { restByTeam: { NCAAF: {} }, qbStatusBySport: { NCAAF: {} }, restSchedule: { NCAAF: board } },
    espnGames: [{
      homeTeam: 'Georgia Bulldogs',
      awayTeam: 'Alabama Crimson Tide',
      commenceTime: wed,
      neutralSite: true,
    }],
  });
  const spread = rows.find((c) => c.market === 'Spread');
  assert.strictEqual(spread.restAdj, 0);
  assert.deepStrictEqual(spread.diag, { neutralSite: true });
  assert.strictEqual(spread.restDays.home, 4);
}

// Rest is outside the stacked engine cap. Success 3 is cut to 1.5; rest 0.70 stays.
{
  const board = sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '2', commence: SUN_W4 },
  ]);
  const adj = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 5,
    modelTotal: 45,
    uncertainty: 0.13,
    home: 'Kansas City Chiefs',
    away: 'Buffalo Bills',
    restByTeam: {},
    qbByTeam: {},
    commenceTime: SUN_W5,
    restSchedule: board,
  });
  assert.strictEqual(adj.modelMargin, 5, 'game_day records rest; epa adds it');
  assert.strictEqual(adj.modelTotal, 45);
  assert.strictEqual(adj.gameDay.restAdj, 0.7);
  assert.strictEqual(adj.gameDay.restPending, true);
  const stacked = applyEngineStack({
    sport: 'NFL',
    modelMargin: adj.modelMargin + 3,
    engineSoft: { success: { appliedMarginAdj: 3, marginAdj: 3, used: true } },
    gameDay: adj.gameDay,
  });
  assert.ok(Math.abs(stacked.modelMargin - 7.2) < 1e-9, stacked.modelMargin);
  assert.strictEqual(stacked.restAdj, 0.7);
}

function synth(home, away, commence) {
  return {
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -3.5 },
          { name: away, price: -110, point: 3.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 45.5 },
          { name: 'Under', price: -110, point: 45.5 },
        ] },
      ],
    })),
  };
}

const standings = {
  'Kansas City Chiefs': { wins: 2, losses: 0, pf: 50, pa: 30, games: 2 },
  'Buffalo Bills': { wins: 1, losses: 1, pf: 40, pa: 35, games: 2 },
};

function projectAt(restSchedule) {
  return nfl.project({
    oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills', TNF)],
    standings,
    efficiency: {},
    gameDay: { restByTeam: { NFL: {} }, qbStatusBySport: { NFL: {} }, restSchedule: { NFL: restSchedule } },
  });
}

// Candidates carry the private audit fields. The total does not move.
{
  const tnfBoard = sched([
    { teamId: '12', commence: SUN_W3 },
    { teamId: '2', commence: SUN_W3 },
  ]);
  const withRest = projectAt(tnfBoard);
  const plain = nfl.project({
    oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills', TNF)],
    standings,
    efficiency: {},
    gameDay: { restByTeam: { NFL: {} }, qbStatusBySport: { NFL: {} } },
  });
  assert.ok(withRest.length >= 3);
  const spread = withRest.find((c) => c.market === 'Spread');
  assert.strictEqual(spread.restDays.home, 4);
  assert.strictEqual(spread.restCategory.away, 'short');
  assert.strictEqual(spread.restAdj, 0.35);
  const plainSpread = plain.find((c) => c.market === 'Spread');
  assert.strictEqual(plainSpread.restAdj, undefined);
  assert.ok(Math.abs(spread.modelProjection - plainSpread.modelProjection - 0.35) < 1e-9);
  const tot = withRest.find((c) => c.market === 'Total');
  const plainTot = plain.find((c) => c.market === 'Total');
  assert.strictEqual(tot.modelProjection, plainTot.modelProjection);
  assert.strictEqual(tot.restAdj, 0.35);

  const neutralRows = nfl.project({
    oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills', TNF)],
    standings,
    efficiency: {},
    gameDay: { restByTeam: { NFL: {} }, qbStatusBySport: { NFL: {} }, restSchedule: { NFL: tnfBoard } },
    espnGames: [{
      homeTeam: 'Kansas City Chiefs',
      awayTeam: 'Buffalo Bills',
      commenceTime: TNF,
      neutralSite: true,
    }],
  });
  const neutralSpread = neutralRows.find((c) => c.market === 'Spread');
  assert.strictEqual(neutralSpread.restDays.home, 4);
  assert.strictEqual(neutralSpread.restCategory.home, 'short');
  assert.strictEqual(neutralSpread.restCategory.away, 'short');
  assert.strictEqual(neutralSpread.restAdj, 0);
  assert.deepStrictEqual(neutralSpread.diag, { neutralSite: true });
}

// Toggle off is the played-yesterday proxy, schedule or not. Byte-identical.
{
  const prev = process.env.OMEGA_REST_ADJ;
  process.env.OMEGA_REST_ADJ = '0';
  try {
    const yesterday = gd.restMapFromScoreboard([
      { homeTeam: 'Kansas City Chiefs', awayTeam: 'Buffalo Bills' },
    ], '2026-09-21');
    const rich = sched([
      { teamId: '12', commence: SUN_W3 },
      { teamId: '2', commence: SUN_W4 },
    ]);
    const baseArgs = {
      sport: 'NFL',
      modelMargin: 3,
      modelTotal: 45,
      uncertainty: 0.13,
      home: 'Kansas City Chiefs',
      away: 'Buffalo Bills',
      restByTeam: yesterday,
      qbByTeam: {},
      hfaBase: config.HFA.NFL,
      commenceTime: SUN_W5,
    };
    const offRich = gd.applyGameDayAdjustments(Object.assign({}, baseArgs, { restSchedule: rich }));
    const offPlain = gd.applyGameDayAdjustments(baseArgs);
    assert.deepStrictEqual(offRich, offPlain);
    const legacyHfa = gd.hfaAdjustment('NFL', 1, 1);
    assert.ok(Math.abs(legacyHfa - 0.035) < 1e-12, legacyHfa);
    assert.ok(Math.abs(offRich.modelMargin - (3 + legacyHfa)) < 1e-12);
    assert.strictEqual(offRich.modelTotal, 45);
    assert.strictEqual(offRich.gameDay.restAdj, undefined);
    assert.strictEqual(offRich.gameDay.restPending, undefined);
    assert.strictEqual(offRich.gameDay.playedYesterdayHome, true);
    const candsRich = projectAt(rich);
    const candsPlain = projectAt(null);
    assert.deepStrictEqual(candsRich, candsPlain);
    assert.ok(candsRich.every((c) => c.restAdj === undefined && c.restDays === undefined));
  } finally {
    if (prev == null) delete process.env.OMEGA_REST_ADJ;
    else process.env.OMEGA_REST_ADJ = prev;
  }
}

// Schedule rest does not fuzzy-scan the played-yesterday map.
{
  const board = sched([
    { teamId: '12', opponentId: '2', commence: SUN_W3 },
    { teamId: '2', opponentId: '12', commence: SUN_W3 },
  ]);
  const args = {
    sport: 'NFL',
    modelMargin: 1,
    modelTotal: 45,
    uncertainty: 0.1,
    home: 'Kansas City Chiefs',
    away: 'Buffalo Bills',
    restByTeam: {
      'Not Chiefs': { playedYesterday: true },
      'Not Bills': { playedYesterday: true },
    },
    qbByTeam: {},
    commenceTime: TNF,
    restSchedule: board,
  };
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => { warns.push(String(msg)); };
  try {
    const on = gd.applyGameDayAdjustments(args);
    assert.strictEqual(on.gameDay.restPending, true);
    assert.strictEqual(on.gameDay.playedYesterdayHome, false);
    assert.strictEqual(on.gameDay.playedYesterdayAway, false);
    assert.ok(!warns.some((w) => /exact_only refused fuzzy/.test(w)));
    gd.applyGameDayAdjustments(Object.assign({}, args, { restSchedule: null }));
    assert.ok(warns.some((w) => /exact_only refused fuzzy sport=NFL name=Kansas City Chiefs/.test(w)));
  } finally {
    console.warn = orig;
  }
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

(async () => {
  const prevDir = process.env.OMEGA_REST_SCHEDULE_DIR;
  try {
    // Fixture dir: no network. Thursday Oct 1 2026 is a 4-day short week.
    process.env.OMEGA_REST_SCHEDULE_DIR = FIXTURES;
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      throw new Error('network must not be used when OMEGA_REST_SCHEDULE_DIR is set');
    };
    const loaded = await rest.loadFootballRestSchedule('NFL', '2026-10-01', { fetchImpl });
    assert.strictEqual(fetches, 0);
    assert.strictEqual(loaded.source, 'dir');
    assert.strictEqual(loaded.fetchFailed, false);
    assert.strictEqual(loaded.loaded, true);
    assert.strictEqual(loaded.week, 4);
    assert.deepStrictEqual(loaded.weeks, [4, 3, 2]);
    assert.strictEqual(loaded.calls, 0);
    assert.ok(loaded.games.length > 0);

    const byKick = new Map();
    for (const g of loaded.games) {
      if (etCalendarDate(g.commence) !== '2026-10-01') continue;
      if (!byKick.has(g.commence)) byKick.set(g.commence, []);
      byKick.get(g.commence).push(g.teamId);
    }
    let shortGame = null;
    for (const [commence, ids] of byKick) {
      if (ids.length !== 2) continue;
      const names = ids.map((id) => {
        const row = require(path.join(root, 'sports/data/nfl-team-ids.json')).teams[id];
        return row && row.displayName;
      });
      if (names.some((n) => !n)) continue;
      const d = gd.describeMatchRest('NFL', loaded, names[0], names[1], commence);
      if (d.restDays.home === 4 && d.restDays.away === 4 && d.restCategory.home === 'short') {
        shortGame = { names, d, commence };
        break;
      }
    }
    assert.ok(shortGame, 'fixture week had no Thursday-after-Sunday short game');
    assert.strictEqual(shortGame.d.restAdj, 0.35);

    const cfbSched = await rest.loadFootballRestSchedule('NCAAF', '2026-09-26', { fetchImpl });
    assert.strictEqual(fetches, 0);
    assert.strictEqual(cfbSched.source, 'dir');
    assert.strictEqual(cfbSched.fetchFailed, false);
    assert.strictEqual(cfbSched.week, 4);
    assert.deepStrictEqual(cfbSched.weeks, [4, 3, 2]);
    assert.ok(cfbSched.games.length > 0);

    // Texas Tech @ Colorado: ESPN 23:30Z, odds 23:31Z. Real rest is 7, not 0.
    const ttWeek = await rest.loadFootballRestSchedule('NCAAF', '2026-10-03', { fetchImpl });
    assert.strictEqual(fetches, 0);
    assert.strictEqual(ttWeek.loaded, true);
    const ttRows = ttWeek.games.filter((g) => g.teamId === '2641' && String(g.commence).indexOf('2026-10-03T23:30') === 0);
    assert.ok(ttRows.length >= 1);
    assert.strictEqual(ttRows[0].opponentId, '38');
    const tt = gd.describeMatchRest(
      'NCAAF',
      ttWeek,
      'Colorado Buffaloes',
      'Texas Tech Red Raiders',
      '2026-10-03T23:31:00Z',
    );
    assert.strictEqual(tt.restDays.home, 7);
    assert.strictEqual(tt.restDays.away, 7);
    assert.strictEqual(tt.restCategory.home, 'normal');
    assert.strictEqual(tt.restCategory.away, 'normal');
    assert.strictEqual(tt.restAdj, 0);

    // Howard @ Rutgers: FCS side is unknown, so the 13-day FBS-only gap is not a bye.
    assert.strictEqual(isFbsTeamId('47'), false);
    assert.strictEqual(isFbsTeamId('2815'), false);
    assert.strictEqual(isFbsTeamId(resolveTeamId('NCAAF', 'Rutgers Scarlet Knights')), true);
    const howardWeek = await rest.loadFootballRestSchedule('NCAAF', '2026-09-25', { fetchImpl });
    assert.strictEqual(fetches, 0);
    const howardPrior = gd.priorKickoff(
      howardWeek,
      '47',
      '2026-09-25T23:00:00Z',
      resolveTeamId('NCAAF', 'Rutgers Scarlet Knights'),
    );
    assert.ok(howardPrior);
    assert.strictEqual(gd.etCalendarDaysBetween(howardPrior.commence, '2026-09-25T23:00:00Z'), 13);
    assert.strictEqual(gd.categoryForRest('NCAAF', 13, howardPrior.commence, '2026-09-25T23:00:00Z'), 'bye');
    const howard = gd.describeMatchRest(
      'NCAAF',
      howardWeek,
      'Rutgers Scarlet Knights',
      'Howard Bison',
      '2026-09-25T23:00:00Z',
    );
    assert.notStrictEqual(howard.restCategory.home, 'unknown');
    assert.strictEqual(howard.restDays.away, null);
    assert.strictEqual(howard.restCategory.away, 'unknown');
    assert.strictEqual(howard.restAdj, 0);

    // A real Sunday NFL kickoff shifted −60s keeps the unshifted category.
    const sunday = await rest.loadFootballRestSchedule('NFL', '2026-10-04', { fetchImpl });
    const nflIds = require(path.join(root, 'sports/data/nfl-team-ids.json'));
    const sundayKicks = new Map();
    for (const g of sunday.games) {
      if (etCalendarDate(g.commence) !== '2026-10-04') continue;
      if (gd.etWeekday(g.commence) !== 'Sun') continue;
      if (!sundayKicks.has(g.commence)) sundayKicks.set(g.commence, []);
      sundayKicks.get(g.commence).push(g);
    }
    let sundayGame = null;
    let unshifted = null;
    for (const [commence, rows] of sundayKicks) {
      if (rows.length !== 2) continue;
      const names = rows.map((r) => nflIds.teams[r.teamId] && nflIds.teams[r.teamId].displayName);
      if (names.some((n) => !n)) continue;
      const d = gd.describeMatchRest('NFL', sunday, names[1], names[0], commence);
      if (d.restDays.home == null || d.restDays.away == null) continue;
      sundayGame = { commence, names };
      unshifted = d;
      break;
    }
    assert.ok(sundayGame, 'fixture week had no Sunday NFL pair with a prior kickoff');
    const shiftedGames = sunday.games.map((g) => {
      if (g.commence !== sundayGame.commence) return g;
      return Object.assign({}, g, { commence: new Date(Date.parse(g.commence) - 60000).toISOString() });
    });
    const shiftedSunday = gd.describeMatchRest(
      'NFL',
      Object.assign({}, sunday, { games: shiftedGames }),
      sundayGame.names[1],
      sundayGame.names[0],
      sundayGame.commence,
    );
    assert.deepStrictEqual(shiftedSunday.restCategory, unshifted.restCategory);
    assert.deepStrictEqual(shiftedSunday.restDays, unshifted.restDays);
    assert.strictEqual(shiftedSunday.restAdj, unshifted.restAdj);
    assert.notStrictEqual(shiftedSunday.restDays.home, 0);
    assert.notStrictEqual(shiftedSunday.restDays.away, 0);

    const snapPath = path.join('/tmp', `omega-frozen-rest-${process.pid}.json`);
    fs.writeFileSync(snapPath, JSON.stringify({
      oddsBySport: { NFL: [], NCAAF: [] },
      espnBySport: {},
      standingsBySport: {},
      gameDay: { restByTeam: { NFL: {}, NCAAF: {} }, qbStatusBySport: { NFL: {}, NCAAF: {} } },
      fetchedAt: '2026-10-03T12:00:00.000Z',
    }));
    const prevSnap = process.env.OMEGA_FROZEN_SNAP;
    process.env.OMEGA_FROZEN_SNAP = snapPath;
    const origFetch = global.fetch;
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      throw new Error('offline');
    };
    try {
      const frozen = await ingest('2026-10-03');
      assert.strictEqual(frozen.snapshotNote, 'frozen-replay');
      assert.strictEqual(frozen.gameDay.restSchedule.NCAAF.source, 'dir');
      assert.strictEqual(frozen.gameDay.restSchedule.NCAAF.loaded, true);
      assert.strictEqual(frozen.gameDay.restSchedule.NFL.loaded, true);
      assert.ok(frozen.gameDay.restSchedule.NCAAF.games.length > 0);
      assert.ok(urls.every((u) => !/the-odds-api|site\.api\.espn/.test(u)));
      const fromFrozen = gd.describeMatchRest(
        'NCAAF',
        frozen.gameDay.restSchedule.NCAAF,
        'Colorado Buffaloes',
        'Texas Tech Red Raiders',
        '2026-10-03T23:31:00Z',
      );
      assert.strictEqual(fromFrozen.restDays.home, 7);
      assert.strictEqual(fromFrozen.restAdj, 0);
      delete process.env.OMEGA_REST_SCHEDULE_DIR;
      const bare = await ingest('2026-10-03');
      assert.strictEqual(bare.snapshotNote, 'frozen-replay');
      assert.strictEqual(bare.gameDay.restSchedule, undefined);
      process.env.OMEGA_REST_SCHEDULE_DIR = FIXTURES;
    } finally {
      global.fetch = origFetch;
      if (prevSnap == null) delete process.env.OMEGA_FROZEN_SNAP;
      else process.env.OMEGA_FROZEN_SNAP = prevSnap;
      try { delete require.cache[require.resolve(snapPath)]; } catch (e) { /* temp snap */ }
      fs.unlinkSync(snapPath);
    }

    // Memoized network path: card week + previous two, ≤3 calls, no date range.
    delete process.env.OMEGA_REST_SCHEDULE_DIR;
    const calendar = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'nfl-w1.json'), 'utf8')).leagues[0].calendar;
    const bodies = {};
    for (const w of [2, 3, 4]) {
      bodies[w] = JSON.parse(fs.readFileSync(path.join(FIXTURES, `nfl-w${w}.json`), 'utf8'));
    }
    await runWithFetchMemo(async () => {
      const urls = [];
      let n = 0;
      const netFetch = async (url) => {
        n += 1;
        urls.push(String(url));
        const m = String(url).match(/[?&]week=(\d+)/);
        assert.ok(m, url);
        assert.ok(!/dates=\d{8}-\d{8}/.test(url), url);
        assert.ok(/seasontype=2/.test(url), url);
        assert.ok(/dates=2026(?:&|$)/.test(url), url);
        return jsonResponse(bodies[m[1]]);
      };
      const a = await rest.loadFootballRestSchedule('NFL', '2026-10-01', {
        dir: null,
        fetchImpl: netFetch,
        dailyBoard: { calendar, seasonYear: 2026 },
      });
      const b = await rest.loadFootballRestSchedule('NFL', '2026-10-01', {
        dir: null,
        fetchImpl: netFetch,
        dailyBoard: { calendar, seasonYear: 2026 },
      });
      assert.strictEqual(n, 3);
      assert.deepStrictEqual(a.weeks, [4, 3, 2]);
      assert.strictEqual(b.games.length, a.games.length);
      assert.ok(urls.every((u) => u.indexOf('week=') > 0));
    });

    // No dir and no network → unknown, adj 0, health rest_unknown.
    const failed = await rest.loadFootballRestSchedule('NFL', '2026-10-01', {
      dir: null,
      fetchImpl: async () => { throw new Error('offline'); },
      dailyBoard: { calendar, seasonYear: 2026 },
    });
    assert.strictEqual(failed.fetchFailed, true);
    assert.strictEqual(failed.loaded, false);
    assert.deepStrictEqual(failed.games, []);
    const missed = gd.describeMatchRest('NFL', failed, 'Kansas City Chiefs', 'Buffalo Bills', TNF);
    assert.strictEqual(missed.restAdj, 0);
    assert.strictEqual(missed.restCategory.home, 'unknown');
    const record = buildHealthRecord({
      dateISO: '2026-10-01',
      snap: {
        espnBySport: {},
        oddsBySport: {
          NFL: [{ home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: TNF }],
        },
        standingsBySport: {},
        mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
        gameDay: { restSchedule: { NFL: failed } },
      },
      rawBySport: { NFL: 1 },
      candidates: [],
      yesPool: [],
      oddsErrors: [],
    });
    assert.ok(record.alerts.some((a) => a.sport === 'NFL' && a.code === 'rest_unknown'));
    assert.strictEqual(record.bySport.NFL.rest.known, 0);
    assert.strictEqual(record.bySport.NFL.rest.slate, 2);
    assert.strictEqual(record.bySport.NFL.rest.fetchFailed, true);

    const url = rest.weeklyScoreboardUrl('NCAAF', 2026, 4);
    assert.strictEqual(
      url,
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?seasontype=2&week=4&dates=2026&groups=80&limit=300'
    );
    assert.ok(!url.includes('dates=2026-'));

    console.log('PASS test-omega-nfl-rest', {
      tnf: shortGame.names.join(' @ '),
      restAdj: shortGame.d.restAdj,
    });
  } finally {
    if (prevDir == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
    else process.env.OMEGA_REST_SCHEDULE_DIR = prevDir;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
