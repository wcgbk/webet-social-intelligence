'use strict';
// Parlay labels must describe comboStats. Numbers stay the pre-change values.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  comboStats, parlayFromStraights, parlayEvLabel, parlayIndependent, unifiedCoverProb,
} = require('./netlify/functions/lib/omega-vnext/parlay');
const select = require('./netlify/functions/lib/omega-vnext/select');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { applyPureModelOne } = require('./netlify/functions/lib/omega-vnext/pure_model');
const verify = require('./netlify/functions/verify-picks-omega');
const results = require('./netlify/functions/get-results-omega');
const kpis = require('./netlify/functions/lib/omega-vnext/result_kpis');
const tracking = require('./netlify/functions/lib/tracking-report');

function leg(matchup, side, extra) {
  const parts = matchup.split(' @ ');
  return Object.assign({
    sport: 'MLB',
    matchup,
    side,
    market: 'Total',
    odds: -110,
    coverProb: 0.55,
    ev: 0.04,
    edgePct: 0.03,
    homeTeam: parts[1],
    awayTeam: parts[0],
    book: 'draftkings',
    line: 8.5,
    tier: 'floor',
    rating: 'a',
    commenceTime: '2026-10-15T23:00:00Z',
  }, extra || {});
}

const NUM_KEYS = [
  'combinedOdds', 'combinedDecimal', 'combinedProb', 'combinedProbRaw',
  'ev', 'evRaw', 'units', 'riskDollars', 'toWinDollars', 'uniqueGames', 'uniqueSports',
];

function numericFields(ticket) {
  const out = {};
  for (const key of NUM_KEYS) out[key] = ticket[key];
  return out;
}

// Frozen from comboStats / parlayFromStraights before the label change.
const FROZEN_TWO = {
  combinedDecimal: 3.7272727272727275,
  combinedProb: 0.35928999999999994,
  ev: 0.33917181818181796,
  uniqueGames: 2,
  uniqueSports: 1,
};
const FROZEN_THREE_STATS = {
  combinedDecimal: 8.200000000000001,
  combinedProb: 0.2087664,
  ev: 0.7118844800000002,
  uniqueGames: 3,
  uniqueSports: 1,
};
const FROZEN_THREE_TICKET = {
  combinedOdds: '+720',
  combinedDecimal: 8.2,
  combinedProb: '20.9%',
  combinedProbRaw: 0.2087664,
  ev: '71.2%',
  evRaw: 0.7118844799999997,
  units: '0.5u',
  riskDollars: 75,
  toWinDollars: 540,
  uniqueGames: 3,
  uniqueSports: 1,
};

const twoOvers = [
  leg('A @ B', 'Over 8.5', { odds: -110, coverProb: 0.62, commenceTime: '2026-10-15T23:00:00Z' }),
  leg('C @ D', 'Over 7.5', { odds: -105, coverProb: 0.61, commenceTime: '2026-10-15T23:05:00Z' }),
];
const twoStats = comboStats(twoOvers);
assert.strictEqual(twoStats.combinedDecimal, FROZEN_TWO.combinedDecimal);
assert.strictEqual(twoStats.combinedProb, FROZEN_TWO.combinedProb);
assert.strictEqual(twoStats.ev, FROZEN_TWO.ev);
assert.strictEqual(twoStats.uniqueGames, FROZEN_TWO.uniqueGames);
assert.strictEqual(twoStats.uniqueSports, FROZEN_TWO.uniqueSports);
assert.deepStrictEqual(twoStats.haircutApplied, { applied: true, factor: 0.95 });
assert.strictEqual(twoStats.corrApplied, false);
assert.strictEqual(
  parlayEvLabel({ ...twoStats, legs: twoOvers }),
  'same-direction totals haircut x0.95 applied, other legs assumed independent',
);
assert.strictEqual(parlayIndependent({ ...twoStats, legs: twoOvers }), false);

const threeOvers = [
  leg('A @ B', 'Over 8.5', { coverProb: 0.62, odds: -110 }),
  leg('C @ D', 'Over 7.5', { coverProb: 0.61, odds: -105 }),
  leg('E @ F', 'Over 9', { coverProb: 0.60, odds: 120 }),
];
const threeStats = comboStats(threeOvers);
assert.strictEqual(threeStats.combinedDecimal, FROZEN_THREE_STATS.combinedDecimal);
assert.strictEqual(threeStats.combinedProb, FROZEN_THREE_STATS.combinedProb);
assert.strictEqual(threeStats.ev, FROZEN_THREE_STATS.ev);
assert.strictEqual(threeStats.uniqueGames, 3);
assert.strictEqual(threeStats.uniqueSports, 1);
assert.deepStrictEqual(threeStats.haircutApplied, { applied: true, factor: 0.92 });
assert.strictEqual(threeStats.corrApplied, false);

const publishOvers = [
  leg('A @ B', 'Over 8.5', { coverProb: 0.55, odds: -110 }),
  leg('C @ D', 'Over 7.5', { coverProb: 0.55, odds: -105 }),
  leg('E @ F', 'Over 9', { coverProb: 0.50, odds: 120 }),
];
const haircutTicket = parlayFromStraights(publishOvers)[0];
assert.strictEqual(haircutTicket.combinedOdds, FROZEN_THREE_TICKET.combinedOdds);
assert.strictEqual(haircutTicket.combinedDecimal, FROZEN_THREE_TICKET.combinedDecimal);
assert.strictEqual(haircutTicket.units, '0.5u');
assert.strictEqual(haircutTicket.qualifying, true);
assert.ok(haircutTicket.evRaw > 0 && haircutTicket.evRaw < FROZEN_THREE_STATS.ev);
assert.strictEqual(haircutTicket.independent, false);
assert.strictEqual(haircutTicket.mirrorsCard, true);
assert.strictEqual(
  haircutTicket.evLabel,
  'same-direction totals haircut x0.92 applied, other legs assumed independent',
);
assert.strictEqual(haircutTicket.correlationNote, haircutTicket.evLabel);

const mixed = [
  leg('A @ B', 'Over 8.5', { market: 'Total', coverProb: 0.56, odds: -110, edgePct: 0.04 }),
  leg('C @ D', 'Yankees', { market: 'Moneyline', side: 'Yankees', coverProb: 0.48, odds: 130, edgePct: 0.05 }),
  leg('E @ F', 'Under 9', { market: 'Total', coverProb: 0.54, odds: -115, edgePct: 0.03 }),
];
const mixedTicket = parlayFromStraights(mixed)[0];
assert.strictEqual(mixedTicket.evLabel, 'assumes independent legs (different games)');
assert.strictEqual(mixedTicket.correlationNote, mixedTicket.evLabel);
assert.strictEqual(mixedTicket.independent, true);
assert.strictEqual(mixedTicket.mirrorsCard, true);
assert.strictEqual(mixedTicket.combinedProbRaw, 0.14515200000000003);
assert.strictEqual(mixedTicket.evRaw, 0.19156596363636358);
assert.strictEqual(mixedTicket.combinedOdds, '+721');
assert.strictEqual(mixedTicket.combinedDecimal, 8.21);

const sameGame = [
  leg('A @ B', 'Over 8.5', { coverProb: 0.6, odds: -110 }),
  leg('A @ B', 'Over 9.5', { coverProb: 0.58, odds: -110, commenceTime: '2026-10-15T23:00:00Z' }),
];
assert.strictEqual(
  parlayEvLabel({ legs: sameGame }),
  'legs share a game: not independent',
);
assert.strictEqual(parlayIndependent({ legs: sameGame }), false);
assert.strictEqual(
  parlayEvLabel({ corrApplied: true, legs: mixed }),
  'correlation-adjusted',
);
assert.strictEqual(parlayIndependent({ corrApplied: true, legs: mixed }), false);

// select.js backfill uses the helper, including a stale independent-legs string.
{
  const straights = [{ pick: 'A', rating: 'a', units: '1u' }];
  const mixedLegs = [
    { pick: 'Over 8.5', betType: 'Total', matchup: 'A @ B', odds: '-110', coverProb: '55%', sport: 'MLB', homeTeam: 'B', awayTeam: 'A' },
    { pick: 'Yankees ML', betType: 'Moneyline', matchup: 'C @ D', odds: '+130', coverProb: '48%', sport: 'MLB', homeTeam: 'D', awayTeam: 'C' },
    { pick: 'Under 9', betType: 'Total', matchup: 'E @ F', odds: '-115', coverProb: '54%', sport: 'MLB', homeTeam: 'F', awayTeam: 'E' },
  ];
  const filled = select.applyDailyUnitCap(straights, [{
    units: '0.5u',
    combinedOdds: '+600',
    legs: mixedLegs,
  }]);
  assert.strictEqual(filled.parlayLegs[0].evLabel, 'assumes independent legs (different games)');
  assert.strictEqual(filled.parlayLegs[0].correlationNote, filled.parlayLegs[0].evLabel);

  const overs = select.applyDailyUnitCap(straights, [{
    units: '0.5u',
    evLabel: 'assumes independent legs',
    correlationNote: 'assumes independent legs',
    combinedOdds: '+600',
    legs: [
      { pick: 'Over 8.5', betType: 'Total', matchup: 'A @ B', odds: '-110', coverProb: '55%', sport: 'MLB', homeTeam: 'B', awayTeam: 'A' },
      { pick: 'Over 7.5', betType: 'Total', matchup: 'C @ D', odds: '-110', coverProb: '55%', sport: 'MLB', homeTeam: 'D', awayTeam: 'C' },
      { pick: 'Over 9', betType: 'Total', matchup: 'E @ F', odds: '-110', coverProb: '55%', sport: 'MLB', homeTeam: 'F', awayTeam: 'E' },
    ],
  }]);
  assert.strictEqual(
    overs.parlayLegs[0].evLabel,
    'same-direction totals haircut x0.92 applied, other legs assumed independent',
  );
  assert.strictEqual(overs.parlayLegs[0].correlationNote, overs.parlayLegs[0].evLabel);
  assert.strictEqual(overs.parlayLegs[0].units, '0.5u');
}

// verify reprice keeps the plain product and says so when a haircut would apply.
{
  const root = {
    type: '3-leg-parlay',
    units: '0.5u',
    mirrorsCard: true,
    evLabel: 'assumes independent legs',
    correlationNote: 'assumes independent legs',
    legs: [
      { pick: 'Over 8.5', betType: 'Total', odds: '-110', coverProb: '55%', matchup: 'A @ B', sport: 'MLB', homeTeam: 'B', awayTeam: 'A' },
      { pick: 'Over 7.5', betType: 'Total', odds: '-110', coverProb: '54%', matchup: 'C @ D', sport: 'MLB', homeTeam: 'D', awayTeam: 'C' },
      { pick: 'Over 9', betType: 'Total', odds: '-105', coverProb: '53%', matchup: 'E @ F', sport: 'MLB', homeTeam: 'F', awayTeam: 'E' },
    ],
  };
  const resized = verify.resolveLockedParlay([root], { removedPicks: ['Over 9'] });
  const ticket = resized.parlayLegs[0];
  assert.strictEqual(resized.action, 'resized');
  const p1 = 0.55;
  const p2 = 0.54;
  const dec = (1 + 100 / 110);
  const plainProb = p1 * p2;
  const plainEv = plainProb * (dec * dec) - 1;
  assert.strictEqual(ticket.combinedProb, `${(plainProb * 100).toFixed(1)}%`);
  assert.strictEqual(ticket.ev, `${(plainEv * 100).toFixed(1)}%`);
  assert.notStrictEqual(ticket.combinedProb, `${(plainProb * 0.95 * 100).toFixed(1)}%`);
  assert.ok(ticket.evLabel.includes('same-direction totals haircut x0.95 applied'));
  assert.ok(ticket.evLabel.includes('plain product of the leg probabilities'));
  assert.ok(ticket.evLabel.includes('haircut was not applied'));
  assert.strictEqual(ticket.correlationNote, ticket.evLabel);
  assert.strictEqual(ticket.independent, false);
  assert.strictEqual(ticket.mirrorsCard, false);

  const mixedRoot = {
    type: '3-leg-parlay',
    units: '0.5u',
    legs: [
      { pick: 'Yankees ML', betType: 'Moneyline', odds: '-110', coverProb: '55%', matchup: 'Red Sox @ Yankees', sport: 'MLB', homeTeam: 'Yankees', awayTeam: 'Red Sox' },
      { pick: 'Over 8.5', betType: 'Total', odds: '-105', coverProb: '53%', matchup: 'Cubs @ Cards', sport: 'MLB', homeTeam: 'Cards', awayTeam: 'Cubs' },
    ],
  };
  const kept = verify.resolveLockedParlay([{
    ...mixedRoot,
    legs: mixedRoot.legs.concat([
      { pick: 'Dodgers -1.5', betType: 'Spread', odds: '-110', coverProb: '54%', matchup: 'Padres @ Dodgers', sport: 'MLB', homeTeam: 'Dodgers', awayTeam: 'Padres' },
    ]),
  }], { removedPicks: ['Dodgers -1.5'] });
  assert.strictEqual(kept.parlayLegs[0].evLabel, 'assumes independent legs (different games)');
  assert.strictEqual(kept.parlayLegs[0].correlationNote, kept.parlayLegs[0].evLabel);
  assert.strictEqual(kept.parlayLegs[0].independent, true);
}

const pub = publicPicksPayload({ picks: [], parlayLegs: [haircutTicket, mixedTicket] });
assert.strictEqual(pub.parlayLegs[0].mirrorsCard, true);
assert.strictEqual(pub.parlayLegs[0].independent, false);
assert.strictEqual(pub.parlayLegs[0].evLabel, haircutTicket.evLabel);
assert.strictEqual(pub.parlayLegs[1].mirrorsCard, true);
assert.strictEqual(pub.parlayLegs[1].independent, true);
assert.strictEqual(pub.parlayLegs[1].evLabel, mixedTicket.evLabel);
assert.ok(pub.parlayLegs[0].correlationNote);

const html = fs.readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
assert.ok(!html.includes('assumes independent legs'), 'client must not invent the independent-legs label');
assert.ok(html.includes('apiParlay.evLabel'));
assert.ok(/parlayEvLabel \?/.test(html));

function gradedCard(type) {
  const picks = [
    { sport: 'MLB', pick: 'Over 8.5', matchup: 'A @ B', odds: '-110', units: '0.5u', betType: 'Total' },
    { sport: 'MLB', pick: 'Over 7.5', matchup: 'C @ D', odds: '-110', units: '0.5u', betType: 'Total' },
    { sport: 'MLB', pick: 'Over 9', matchup: 'E @ F', odds: '-110', units: '0.5u', betType: 'Total' },
  ];
  return {
    date: '2026-10-15',
    picks,
    parlayLegs: [{ type, units: '0.5u', legs: picks }],
  };
}

(async () => {
  const plain = await results._test.gradeDay('2026-10-15', gradedCard('3-leg-parlay'), { games: [] });
  const optimized = await results._test.gradeDay('2026-10-15', gradedCard('3-leg-parlay-optimized'), { games: [] });
  const labeled = await results._test.gradeDay('2026-10-15', gradedCard('3-leg-parlay-labeled'), { games: [] });
  const nameOf = (day) => day.picks.find((row) => row.sport === 'PARLAY').pick;
  assert.strictEqual(nameOf(plain), '3-Team Parlay');
  assert.strictEqual(nameOf(optimized), '3-Team Parlay (Optimized)');
  assert.strictEqual(nameOf(labeled), '3-Team Parlay');
  const recomputed = results._test.recomputeParlayFields({
    date: '2026-10-15',
    wagered: 0,
    profit: 0,
    parlayResult: 'pending',
    parlayProfit: 0,
    parlayRisk: 0,
    picks: [{ sport: 'PARLAY', pick: '3-Team Parlay (Optimized)', units: '0.5u', result: 'pending', profit: 0 }],
  }, gradedCard('3-leg-parlay'));
  assert.strictEqual(nameOf(recomputed), '3-Team Parlay');
  const recomputedOpt = results._test.recomputeParlayFields({
    date: '2026-10-15',
    wagered: 0,
    profit: 0,
    parlayResult: 'pending',
    parlayProfit: 0,
    parlayRisk: 0,
    picks: [],
  }, gradedCard('2-leg-parlay-optimized'));
  assert.strictEqual(nameOf(recomputedOpt), '3-Team Parlay (Optimized)');

  const straight = { sport: 'MLB', pick: 'Yankees ML', odds: '-110', units: '1u', result: 'win', profit: 100 };
  const dayOld = {
    date: '2026-10-01',
    wins: 1,
    losses: 0,
    wagered: 150,
    profit: 100,
    parlayResult: 'win',
    parlayRisk: 75,
    parlayProfit: 200,
    picks: [straight, { sport: 'PARLAY', pick: '3-Team Parlay (Optimized)', units: '0.5u', result: 'win', profit: 200 }],
  };
  const dayNew = {
    date: '2026-10-02',
    wins: 1,
    losses: 0,
    wagered: 150,
    profit: 100,
    parlayResult: 'loss',
    parlayRisk: 75,
    parlayProfit: -75,
    picks: [
      { ...straight, pick: 'Dodgers ML' },
      { pick: '3-Team Parlay', units: '0.5u', result: 'loss', profit: -75 },
    ],
  };
  const oldAgg = results._test.aggregateDays([dayOld]);
  const newAgg = results._test.aggregateDays([dayNew]);
  assert.strictEqual(oldAgg.straight.wins, 1);
  assert.strictEqual(newAgg.straight.wins, 1);
  assert.strictEqual(oldAgg.straight.losses, 0);
  assert.strictEqual(newAgg.straight.losses, 0);
  assert.strictEqual(oldAgg.parlay.wins, 1);
  assert.strictEqual(newAgg.parlay.losses, 1);
  assert.strictEqual(kpis.isParlayGradeName('3-Team Parlay (Optimized)'), true);
  assert.strictEqual(kpis.isParlayGradeName('3-Team Parlay'), true);
  assert.strictEqual(kpis.canonicalParlayGradeName('3-Team Parlay (Optimized)'), kpis.canonicalParlayGradeName('3-Team Parlay'));
  assert.strictEqual(kpis.isParlayPick(dayOld.picks[1]), true);
  assert.strictEqual(kpis.isParlayPick(dayNew.picks[1]), true);
  const rate = kpis.winRateVsBreakEven([dayOld, dayNew]);
  assert.strictEqual(rate.wins, 2);
  assert.strictEqual(rate.losses, 0);

  const clv = tracking.clvPublishedFromRows([
    { kind: 'pick', source: 'omega', date: '2026-10-01', clvPp: 1, market: 'moneyline', selection: 'Yankees ML' },
    { kind: 'pick', source: 'omega', date: '2026-10-02', clvPp: 2, selection: '3-Team Parlay (Optimized)' },
    { kind: 'pick', source: 'omega', date: '2026-10-03', clvPp: 4, selection: '3-Team Parlay' },
  ], { asOf: '2026-10-15' });
  assert.strictEqual(clv.omega.n, 1);
  assert.strictEqual(clv.omega.parlay.available, true);
  assert.strictEqual(clv.omega.parlay.n, 2);

  // Probability basis vs published p_model. Report only. Math is unchanged.
  function pureRow(matchup, side, p) {
    const teams = matchup.split(' @ ');
    return applyPureModelOne({
      sport: 'MLB',
      matchup,
      side,
      market: 'Moneyline',
      odds: -110,
      modelPureP: p,
      homeTeam: teams[1],
      awayTeam: teams[0],
      book: 'draftkings',
      tier: 'floor',
      commenceTime: '2026-10-15T23:00:00Z',
    });
  }
  const downP = 0.55124;
  const upP = 0.55126;
  const downCands = [
    pureRow('A @ B', 'Yankees', downP),
    pureRow('C @ D', 'Dodgers', downP),
    pureRow('E @ F', 'Mets', downP),
  ];
  const downPicks = downCands.map((row) => select.toPickObject(row));
  assert.strictEqual(downCands[0].coverProb, downP);
  assert.strictEqual(downCands[0].p_model, downP);
  assert.strictEqual(downPicks[0].p_model, 0.5512);
  assert.strictEqual(downPicks[0].p_cal, 0.5512);
  assert.strictEqual(unifiedCoverProb(downPicks[0]), downPicks[0].p_model);
  const fromPool = parlayFromStraights(downPicks, { pool: downCands })[0];
  assert.notStrictEqual(fromPool.legs[0].p_cal, downPicks[0].p_model);
  assert.strictEqual(fromPool.legs[0].p_cal, +downP.toFixed(6));
  const fromCard = parlayFromStraights(downPicks)[0];
  assert.strictEqual(fromCard.legs[0].p_cal, downPicks[0].p_model);
  const upCands = [
    pureRow('A @ B', 'Yankees', upP),
    pureRow('C @ D', 'Dodgers', upP),
    pureRow('E @ F', 'Mets', upP),
  ];
  const upPicks = upCands.map((row) => select.toPickObject(row));
  const upFromPool = parlayFromStraights(upPicks, { pool: upCands })[0];
  assert.strictEqual(upPicks[0].p_model, 0.5513);
  assert.strictEqual(upFromPool.legs[0].p_cal, upPicks[0].p_model);

  console.log('PASS test-omega-parlay-label-1015');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
