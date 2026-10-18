'use strict';
// Short-card top-up and lean stake (2026-10-18). No odds pull. No network.
// A positive-EV lean is min(max(quarter Kelly, 0.25u), 0.5u) on the 0.25u grid.
// EV <= 0 at the bet price is 0u labelled 'no stake'. A short card fills to 3
// from thin positive EV first, then 0u listings when SHORT_CARD_NOSTAKE_FILL is on.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  quarterKellyUnits,
  leanStakeUnits,
  toPickObject,
  selectStraights,
  qualifiesAsLean,
  eligibleForLeanPool,
  passesLeanFill,
  eligibleShortCardPositive,
  eligibleShortCardNoStake,
  isNoStakeRow,
  applyDailyUnitCap,
} = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights } = require('./netlify/functions/lib/omega-vnext/parlay');
const { buildShortfall } = require('./netlify/functions/lib/omega-vnext/shortfall');
const { buildReserve, topUpStraights, finishShortCard } = require('./netlify/functions/lib/omega-vnext/card_topup');
const { winRateVsBreakEven } = require('./netlify/functions/lib/omega-vnext/result_kpis');

assert.strictEqual(config.SHORT_CARD_NOSTAKE_FILL, true);
assert.strictEqual(config.LEAN_MAX_UNITS, 0.5);
assert.strictEqual(config.MAX_STRAIGHTS, 3);
assert.strictEqual(config.EV_CAP_ALL, 0.10);
assert.strictEqual(config.GATES.minAmericanOdds, -250);
assert.strictEqual(config.GATES.maxAmericanOdds, 250);

const T0 = '2026-10-18T23:00:00Z';

function row(n, extra) {
  const away = `Away${n}`;
  const home = `Home${n}`;
  return {
    sport: 'NFL',
    matchup: `${away} @ ${home}`,
    side: `${home} +3`,
    market: 'Spread',
    line: 3,
    odds: -110,
    coverProb: 0.55,
    ev: 0.04,
    edgePct: 0.03,
    liquid: true,
    commenceTime: T0,
    homeTeam: home,
    awayTeam: away,
    book: 'draftkings',
    ...extra,
  };
}

function unitsOf(pick) {
  return parseFloat(String(pick && pick.units || '0').replace(/[^0-9.]/g, '')) || 0;
}

function assertLeanBand(pick) {
  const u = unitsOf(pick);
  assert.ok(u + 1e-12 >= 0.25 && u - 1e-12 <= 0.5, `${pick.side} ${pick.units}`);
  assert.strictEqual(pick.units, `${u}u`);
  assert.strictEqual(Math.round(u * 4) / 4, u);
  assert.strictEqual(pick.tier, 'lean');
  assert.strictEqual(pick.label, 'lean');
  assert.ok(pick.riskDollars >= 38 && pick.riskDollars <= 75);
}

// 0.25u grid. Raw 0.3u and 0.4u round to the nearest step inside [0.25, 0.5].
assert.strictEqual(leanStakeUnits(0.3), 0.25);
assert.strictEqual(leanStakeUnits(0.4), 0.5);
assert.strictEqual(leanStakeUnits(0.25), 0.25);
assert.strictEqual(leanStakeUnits(0.5), 0.5);
assert.strictEqual(leanStakeUnits(1.2), 0.5);
assert.strictEqual(leanStakeUnits(0), 0.25);

// At -110, raw quarter Kelly is 0.3u when p ≈ 0.5295238. The grid publishes 0.25u.
{
  const p = 0.5295238095238095;
  const kelly = quarterKellyUnits(p, -110, 0);
  assert.strictEqual(kelly, 0.25);
  const published = toPickObject(row(1, {
    coverProb: p,
    tier: 'lean',
    ev: (p * (210 / 110)) - 1,
    edgePct: 0.004,
    side: 'Home1 +3',
  }));
  assert.strictEqual(published.units, '0.25u');
  assert.strictEqual(published.tier, 'lean');
  assert.strictEqual(published.label, 'lean');
  assert.notStrictEqual(published.noStake, true);
}

// Tiny positive EV rounds Kelly to 0 and still publishes 0.25u. EV <= 0 is 0u.
{
  const tiny = toPickObject(row(1, {
    coverProb: 0.525,
    tier: 'lean',
    ev: 0.002,
    edgePct: 0.002,
  }));
  assert.strictEqual(quarterKellyUnits(0.525, -110, 0), 0);
  assert.strictEqual(tiny.units, '0.25u');
  assert.strictEqual(tiny.tier, 'lean');

  const deadLean = toPickObject(row(2, {
    coverProb: 0.51,
    tier: 'lean',
    ev: -0.02,
    edgePct: -0.01,
  }));
  assert.strictEqual(quarterKellyUnits(0.51, -110, 0), 0);
  assert.strictEqual(deadLean.units, '0u');
  assert.strictEqual(deadLean.tier, 'no stake');
  assert.strictEqual(deadLean.label, 'no stake');
  assert.strictEqual(deadLean.noStake, true);
  assert.strictEqual(deadLean.excludeFromKpi, true);
  assert.strictEqual(deadLean.riskDollars, 0);
  assert.strictEqual(deadLean.toWinDollars, 0);

  // A graded row with Kelly 0 and EV <= 0 stays a floor at 0u. It is not relabelled.
  const deadFloor = toPickObject(row(3, {
    coverProb: 0.20,
    odds: 300,
    ev: -0.2,
    edgePct: -0.05,
  }));
  assert.strictEqual(deadFloor.tier, 'floor');
  assert.strictEqual(deadFloor.units, '0u');
  assert.notStrictEqual(deadFloor.label, 'no stake');
}

// One floor plus two thin positive rows (edge and EV both under 1%) fills to 3.
{
  const floor = row(1, { ev: 0.05, edgePct: 0.04, coverProb: 0.545, side: 'Home1 +3' });
  const thinHi = row(2, {
    ev: 0.008,
    edgePct: 0.004,
    coverProb: 0.527,
    side: 'Home2 +3',
    rejectReason: 'ev-floor',
  });
  const thinLo = row(3, {
    ev: 0.002,
    edgePct: 0.003,
    coverProb: 0.533,
    side: 'Home3 +3',
    rejectReason: 'edge-floor-se',
  });
  assert.strictEqual(qualifiesAsLean(thinHi), false);
  assert.strictEqual(eligibleForLeanPool(thinLo), false);
  assert.strictEqual(passesLeanFill(thinHi), false);
  assert.strictEqual(eligibleShortCardPositive(thinHi), true);
  assert.strictEqual(eligibleShortCardPositive(thinLo), true);

  const picked = selectStraights([floor], 3, [], [], [thinLo, thinHi]);
  assert.strictEqual(picked.length, 3);
  assert.deepStrictEqual(picked.map((r) => r.side), ['Home1 +3', 'Home2 +3', 'Home3 +3']);
  assert.deepStrictEqual(picked.map((r) => r.tier), ['floor', 'lean', 'lean']);
  assert.strictEqual(picked[1].leanReason, 'short-card-ev');
  assert.strictEqual(picked[1].shortCardFill, true);

  const published = picked.map((r) => toPickObject(r));
  assert.strictEqual(published[0].tier, 'floor');
  assert.ok(unitsOf(published[0]) >= 0.5);
  assertLeanBand(published[1]);
  assertLeanBand(published[2]);
  assert.strictEqual(published[1].units, '0.25u');
  assert.strictEqual(published[2].units, '0.5u');

  const reserve = buildReserve({
    yesPool: [floor],
    rejected: [thinHi, thinLo],
    picks: [],
  });
  const names = reserve.map((r) => r.pick || r.side);
  assert.deepStrictEqual(names.slice(0, 3), ['Home1 +3', 'Home2 +3', 'Home3 +3']);
  const up = topUpStraights({ picks: [], reserve, blocked: [] });
  assert.strictEqual(up.picks.length, 3);
  assert.strictEqual(up.picks[0].tier, 'floor');
  assertLeanBand(up.picks[1]);
  assertLeanBand(up.picks[2]);
  const finished = finishShortCard({
    picks: [toPickObject(floor)],
    reserve,
    parlayPool: [],
  });
  assert.strictEqual(finished.picks.length, 3);
  assert.ok(finished.picks.slice(1).every((p) => p.tier === 'lean' && unitsOf(p) >= 0.25 && unitsOf(p) <= 0.5));
}

// Negative remainder is 'no stake' at 0u when the flag is on, and absent when it is off.
{
  const floor = row(1, { ev: 0.05, edgePct: 0.04, coverProb: 0.545, side: 'Home1 +3' });
  const better = row(2, {
    ev: -0.01,
    edgePct: -0.005,
    coverProb: 0.51,
    side: 'Home2 +3',
    rejectReason: 'ev-floor',
  });
  const worse = row(3, {
    ev: -0.04,
    edgePct: -0.02,
    coverProb: 0.50,
    side: 'Home3 +3',
    rejectReason: 'nonpositive-edge',
  });
  assert.strictEqual(eligibleShortCardNoStake(better), true);

  const on = selectStraights([floor], 3, [], [], [worse, better]).map((r) => toPickObject(r));
  assert.strictEqual(on.length, 3);
  assert.strictEqual(on[0].tier, 'floor');
  assert.strictEqual(on[1].side || on[1].pick, 'Home2 +3');
  assert.strictEqual(on[1].tier, 'no stake');
  assert.strictEqual(on[1].label, 'no stake');
  assert.strictEqual(on[1].units, '0u');
  assert.strictEqual(on[1].noStake, true);
  assert.strictEqual(on[1].riskDollars, 0);
  assert.strictEqual(on[2].label, 'no stake');
  assert.strictEqual(on[2].units, '0u');
  const spent = on.reduce((sum, pick) => sum + unitsOf(pick), 0);
  assert.strictEqual(spent, unitsOf(on[0]));
  const capped = applyDailyUnitCap(on, []);
  assert.strictEqual(capped.picks.length, 3);
  assert.strictEqual(unitsOf(capped.picks[1]), 0);
  assert.strictEqual(capped.picks.reduce((sum, pick) => sum + unitsOf(pick), 0), unitsOf(on[0]));

  const short = buildShortfall({ picks: on, parlayLegs: [] });
  assert.strictEqual(short.straightsCleared, 1);
  assert.strictEqual(short.active, true);

  const saved = config.SHORT_CARD_NOSTAKE_FILL;
  try {
    config.SHORT_CARD_NOSTAKE_FILL = false;
    assert.strictEqual(eligibleShortCardNoStake(better), false);
    const off = selectStraights([floor], 3, [], [], [better, worse]);
    assert.strictEqual(off.length, 1);
    assert.strictEqual(off[0].side, 'Home1 +3');
    assert.ok(!off.some((r) => r.side === 'Home2 +3' || r.side === 'Home3 +3'));
    const reserveOff = buildReserve({
      yesPool: [floor],
      restPool: [better, worse],
      picks: [],
    });
    assert.ok(!reserveOff.some((r) => String(r.pick || r.side).includes('Home2')));
    assert.ok(!reserveOff.some((r) => String(r.label || r.tier).toLowerCase() === 'no stake'));
  } finally {
    config.SHORT_CARD_NOSTAKE_FILL = saved;
  }
  assert.strictEqual(config.SHORT_CARD_NOSTAKE_FILL, true);
}

// A started game is never filled. One pick per game. Band and EV cap hold.
{
  const floor = row(1, { ev: 0.05, edgePct: 0.04, coverProb: 0.545, side: 'Home1 +3' });
  const started = row(2, {
    ev: 0.03,
    edgePct: 0.02,
    coverProb: 0.54,
    side: 'Home2 +3',
    inPlay: true,
  });
  const flagged = row(3, {
    ev: 0.02,
    edgePct: 0.01,
    coverProb: 0.54,
    side: 'Home3 +3',
    started: true,
  });
  const liveReason = row(4, {
    ev: 0.015,
    edgePct: 0.008,
    coverProb: 0.53,
    side: 'Home4 +3',
    rejectReason: 'in-progress-or-started',
  });
  const sameGame = row(1, {
    ev: 0.009,
    edgePct: 0.004,
    coverProb: 0.53,
    side: 'Away1 +3',
    matchup: 'Away1 @ Home1',
  });
  const dog = row(5, {
    ev: 0.006,
    edgePct: 0.004,
    coverProb: 0.40,
    odds: 250,
    side: 'Home5 +3',
  });
  const chalk = row(6, {
    ev: 0.005,
    edgePct: 0.004,
    coverProb: 0.72,
    odds: -250,
    side: 'Home6 -3',
  });
  const longDog = row(7, { ev: 0.08, edgePct: 0.05, coverProb: 0.40, odds: 300, side: 'Home7 ML' });
  const heavy = row(8, { ev: 0.04, edgePct: 0.03, coverProb: 0.75, odds: -260, side: 'Home8 ML' });
  const stale = row(9, { ev: 0.11, edgePct: 0.06, coverProb: 0.58, side: 'Home9 +3', rejectReason: 'ev-stale' });
  const otherBook = row(10, {
    ev: 0.02,
    edgePct: 0.01,
    coverProb: 0.54,
    book: 'fanduel',
    side: 'Home10 +3',
  });
  const badModel = row(11, {
    ev: 0.03,
    edgePct: 0.02,
    coverProb: 0.55,
    rejectReason: 'projection-disagrees',
    side: 'Home11 +3',
  });
  assert.strictEqual(eligibleShortCardPositive(started), false);
  assert.strictEqual(eligibleShortCardPositive(flagged), false);
  assert.strictEqual(eligibleShortCardPositive(liveReason), false);
  assert.strictEqual(eligibleShortCardPositive(longDog), false);
  assert.strictEqual(eligibleShortCardPositive(heavy), false);
  assert.strictEqual(eligibleShortCardPositive(stale), false);
  assert.strictEqual(eligibleShortCardPositive(otherBook), false);
  assert.strictEqual(eligibleShortCardPositive(badModel), false);
  assert.strictEqual(eligibleShortCardPositive(dog), true);
  assert.strictEqual(eligibleShortCardPositive(chalk), true);

  const picked = selectStraights([floor], 3, [], [], [
    started, flagged, liveReason, sameGame, longDog, heavy, stale, otherBook, badModel, dog, chalk,
  ]);
  assert.deepStrictEqual(picked.map((r) => r.side), ['Home1 +3', 'Home5 +3', 'Home6 -3']);
  const games = new Set(picked.map((r) => r.matchup));
  assert.strictEqual(games.size, picked.length);
  assert.ok(!picked.some((r) => r.inPlay || r.started || r.rejectReason === 'in-progress-or-started'));
}

// No-stake rows are not parlay legs. Two real straights still make a 2-leg.
{
  const a = row(1, { ev: 0.05, edgePct: 0.04, coverProb: 0.55, side: 'Home1 +3' });
  const b = row(2, { ev: 0.04, edgePct: 0.035, coverProb: 0.55, side: 'Home2 +3' });
  const neg = row(3, { ev: -0.02, edgePct: -0.01, coverProb: 0.50, side: 'Home3 +3' });
  const card = selectStraights([a, b], 3, [], [], [neg]);
  assert.strictEqual(card.length, 3);
  assert.strictEqual(card[2].label, 'no stake');
  const tickets = parlayFromStraights(card);
  assert.strictEqual(tickets.length, 1);
  const legs = tickets[0].legs || [];
  assert.strictEqual(legs.length, 2);
  assert.ok(legs.every((leg) => !isNoStakeRow(leg)));
  assert.ok(!legs.some((leg) => String(leg.side || leg.pick).includes('Home3')));

  const thin = row(3, { ev: 0.006, edgePct: 0.004, coverProb: 0.53, side: 'Home3 +3' });
  const positive = selectStraights([a], 3, [], [], [thin, row(4, {
    ev: 0.004, edgePct: 0.003, coverProb: 0.528, side: 'Home4 +3',
  })]);
  const leanTicket = parlayFromStraights(positive);
  assert.strictEqual(leanTicket.length, 1);
  assert.strictEqual((leanTicket[0].legs || []).length, 3);
  // Published legs store the stake EV on evRaw. The ev field is the display string.
  assert.ok((leanTicket[0].legs || []).every((leg) => Number(leg.evRaw) > 0 && !isNoStakeRow(leg)));
}

// KPI win rate ignores a 0u listing. A real loss still counts.
{
  const view = winRateVsBreakEven([{
    date: '2026-10-18',
    picks: [
      { sport: 'NFL', pick: 'Home1 +3', odds: -110, result: 'win', units: '1u' },
      {
        sport: 'NFL', pick: 'Home2 +3', odds: -110, result: 'loss', units: '0u',
        tier: 'no stake', label: 'no stake', noStake: true,
      },
    ],
  }]);
  assert.strictEqual(view.n, 1);
  assert.strictEqual(view.wins, 1);
  assert.strictEqual(view.losses, 0);
}
