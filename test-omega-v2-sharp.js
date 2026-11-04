'use strict';

/**
 * Live omega-v2 card. Legs need a positive no-vig edge. A parlay needs
 * two or three of those legs, a positive joint EV, and a quarter-Kelly
 * stake that survives the 0.25u step. There is no v1 parlay to copy.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const { publishEdgeCard } = require('./netlify/functions/lib/omega-vnext/assemble');
const { kellyFraction, americanToDecimal, kellyToUnits } = require('./netlify/functions/lib/omega-vnext/odds_math');

const DATE = '2026-10-30';
const COMMENCE = '2026-10-30T23:00:00Z';
const PREGAME = Date.parse('2026-10-30T16:00:00Z');

/**
 * Model probability whose log-odds blend at k lands on pCal.
 * Empty history uses intercept 0, so this is the preimage of shrinkP.
 */
function pModelFor(pCal, pMkt, k) {
  const clip = (p) => Math.max(0.02, Math.min(0.98, Number(p)));
  const logit = (p) => {
    const x = clip(p);
    return Math.log(x / (1 - x));
  };
  const z = (logit(pCal) - k * logit(pMkt)) / (1 - k);
  let pModel = 1 / (1 + Math.exp(-z));
  const got = v2.shrinkP(pModel, pMkt, k, 0);
  if (Math.abs(got - pCal) <= 1e-12) return pModel;
  let lo = 0.02;
  let hi = 0.98;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (v2.shrinkP(mid, pMkt, k, 0) < pCal) lo = mid;
    else hi = mid;
  }
  pModel = (lo + hi) / 2;
  return pModel;
}

function side(over) {
  const row = {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeTeam: 'Kansas City Chiefs',
    side: 'Kansas City Chiefs ML',
    pick: 'Kansas City Chiefs ML',
    market: 'Moneyline',
    odds: -110,
    oddsStr: '-110',
    book: 'draftkings',
    bestDkHr: { american: -110, book: 'draftkings' },
    coverProb: 0.56,
    ev: 0.04,
    edgePct: 0.02,
    pModel: 0.5238,
    pMkt: 0.5238,
    uncertainty: 0.18,
    commenceTime: COMMENCE,
    line: null,
    ...over,
  };
  if (!over || !Object.prototype.hasOwnProperty.call(over, 'bestDkHr')) {
    const book = String(row.book || '').toLowerCase();
    const dk = book === 'draftkings' || book === 'hardrockbet' || book === 'hardrock' || book === 'hardrockbet_oh';
    if (!dk) row.bestDkHr = null;
    else {
      const american = typeof row.odds === 'number'
        ? row.odds
        : Number(String(row.odds).replace(/[−–]/g, '-').replace(/^\+/, ''));
      const canon = (book === 'hardrock' || book === 'hardrockbet_oh') ? 'hardrockbet' : book;
      row.bestDkHr = { american, book: canon };
    }
  }
  return row;
}

function assertQuarter(units, cap) {
  assert.ok(units >= 0.25, `stake ${units}`);
  assert.ok(units <= cap + 1e-9, `stake ${units} over ${cap}`);
  assert.strictEqual(Math.round(units * 4) / 4, units);
}

function novig(pick) {
  const edge = Number(pick.edgeNovig);
  assert.ok(edge > 0, `${pick.pick} edgeNovig ${pick.edgeNovig}`);
  assert.ok(pick.pCal > pick.pMkt, `${pick.pick} pCal ${pick.pCal} pMkt ${pick.pMkt}`);
  const shown = parseFloat(pick.edgePct) / 100;
  assert.ok(Math.abs(shown - edge) < 0.001, `${pick.pick} edgePct ${pick.edgePct} is not pCal - pNovig`);
  assert.ok(pick.priceEdgePct != null, `${pick.pick} missing priceEdgePct`);
}

(async () => {
  const saved = process.env.OMEGA_PIPELINE_V2;
  delete process.env.OMEGA_PIPELINE_V2;
  assert.strictEqual(v2.pipelineV2Enabled({}), true);
  process.env.OMEGA_PIPELINE_V2 = '0';
  assert.strictEqual(v2.pipelineV2Enabled({}), false);
  assert.strictEqual(v2.pipelineV2Enabled({ pipelineV2: true }), true);
  if (saved == null) delete process.env.OMEGA_PIPELINE_V2;
  else process.env.OMEGA_PIPELINE_V2 = saved;

  assert.strictEqual(v2.MODEL_VERSION, 'omega-v2-sharp-2026-11-01-dkhr');
  assert.strictEqual(v2.UNIT_DOLLARS, 150);
  assert.strictEqual(v2.BANKROLL_UNITS, 100);
  assert.strictEqual(v2.PER_BET_CAP, 2);
  assert.strictEqual(v2.PARLAY_STAKE_CAP, 1);
  assert.strictEqual(v2.EDGE_FLOOR_K, 1.5);
  assert.strictEqual(v2.NO_VIG_BUCKETS.length, 5);
  assert.ok(v2.NO_VIG_BUCKETS[2].se < v2.NO_VIG_BUCKETS[0].se, 'the middle bucket is tighter than the long-shot tail');
  const plusGate = v2.uncertaintyFloor(0.167, 0.140);
  assert.ok(plusGate.floor > 0.0269, `+575 floor ${plusGate.floor} must sit above a 2.69pp edge`);
  assert.strictEqual(plusGate.ok, false);
  assert.ok(v2.priorKFor('MLB') < v2.priorKFor('NFL'));

  const dec290 = americanToDecimal(-290);
  const pKent = 1.035 / dec290;
  const kelly = v2.quarterKellyFromDecimal(pKent, dec290);
  assert.ok(Math.abs(kelly.kellyFrac - kellyFraction(pKent, -290, 0.25)) < 1e-9);
  assert.ok(Math.abs(kelly.full - ((dec290 - 1) * pKent - (1 - pKent)) / (dec290 - 1)) < 1e-12);
  const uncapped = v2.quarterKellyFromDecimal(pKent, dec290, 100);
  assert.strictEqual(uncapped.units, 2.5, '3.5% EV at -290 is 2.5u before the cap');
  assert.strictEqual(kelly.units, 2, 'the 2u print is the per-bet cap');

  const flat = [0, 1, 2].map((i) => side({
    matchup: `Away ${i} @ Home ${i}`,
    awayTeam: `Away ${i}`,
    homeTeam: `Home ${i}`,
    side: `Home ${i} ML`,
    pick: `Home ${i} ML`,
  }));
  const noFill = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: flat,
    parlayPool: flat,
    history: [],
  });
  assert.strictEqual(noFill.picks.length, 0, 'flat prices must not be filled to 3');
  assert.strictEqual(noFill.parlayLegs.length, 0, 'zero no-vig edge is not a parlay');
  assert.strictEqual(noFill.v1WouldParlay, false);
  assert.strictEqual(noFill.parlaySource, null);
  assert.strictEqual(noFill.pass, true);
  assert.strictEqual(noFill.modelVersion, v2.MODEL_VERSION);
  assert.ok(noFill.rejections.some((row) => row.reason === 'fewer than 2 qualifying legs'));

  const edgeLeg = (i, over) => side({
    matchup: `Away ${i} @ Home ${i}`,
    awayTeam: `Away ${i}`,
    homeTeam: `Home ${i}`,
    side: `Home ${i} ML`,
    pick: `Home ${i} ML`,
    pModel: 0.62,
    pMkt: 0.52,
    ...over,
  });
  const pair = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [edgeLeg(0), edgeLeg(1)],
    history: [],
  });
  assert.strictEqual(pair.parlayLegs.length, 1, 'two qualifying legs publish');
  assert.strictEqual(pair.parlayLegs[0].legs.length, 2);
  assert.strictEqual(pair.parlaySource, 'calibrated-edge');
  for (const leg of pair.parlayLegs[0].legs) novig(leg);
  const pCal = v2.shrinkP(0.62, 0.52, v2.priorKFor('NFL'), 0);
  const jointDec = (americanToDecimal(-110) ** 2);
  const jointSized = v2.quarterKellyFromDecimal(pCal * pCal, jointDec, 1);
  assert.strictEqual(pair.parlayLegs[0].unitsNum, jointSized.units);
  assertQuarter(pair.parlayLegs[0].unitsNum, 1);
  assert.ok(pair.parlayLegs[0].unitsNum < 0.5 || pair.parlayLegs[0].unitsNum >= 0.25);
  assert.ok(parseFloat(pair.parlayLegs[0].ev) > 0);
  assert.strictEqual(Number(pair.parlayLegs[0].correlationFactor), 1);
  assert.ok(!/0\.95/.test(pair.parlayLegs[0].correlationNote));

  const one = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [edgeLeg(0)],
    history: [],
  });
  assert.strictEqual(one.parlayLegs.length, 0, 'one qualifying leg is not a parlay');
  assert.ok(one.picks.length <= 1);

  const pricedOut = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [0, 1].map((i) => edgeLeg(i, { odds: 100, oddsStr: '+100', pModel: 0.55, pMkt: 0.40 })),
    history: [],
  });
  assert.strictEqual(pricedOut.picks.length, 0, 'price edge must be positive for a straight');
  assert.strictEqual(pricedOut.parlayLegs.length, 0, 'negative joint EV does not publish');
  assert.ok(pricedOut.rejections.some((row) => row.reason === 'no ticket with positive joint EV'));

  const dust = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [0, 1].map((i) => edgeLeg(i, {
      odds: -110,
      oddsStr: '-110',
      pModel: 0.56,
      pMkt: 0.51,
    })),
    history: [],
  });
  assert.strictEqual(dust.parlayLegs.length, 0, 'stake that rounds under 0.25u is not a parlay');
  assert.ok(dust.rejections.some((row) => row.reason === 'parlay stake rounded below 0.25u'));

  const banned = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [
      edgeLeg(0, { matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B', pick: 'A ML', side: 'A ML', market: 'Moneyline' }),
      edgeLeg(0, { matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B', pick: 'A -3.5', side: 'A -3.5', market: 'Spread', line: -3.5 }),
      edgeLeg(1),
    ],
    history: [],
  });
  assert.ok(banned.parlayLegs.length === 1);
  assert.strictEqual(v2.bannedPairReason(banned.parlayLegs[0].legs), null);
  const bannedGames = banned.parlayLegs[0].legs.map((leg) => `${leg.matchup}|${leg.betType}`);
  assert.ok(!bannedGames.includes('A @ B|Moneyline') || !bannedGames.includes('A @ B|Spread'));
  for (const leg of banned.parlayLegs[0].legs) novig(leg);

  const same = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [
      edgeLeg(0, { matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B', pick: 'B ML', side: 'B ML' }),
      edgeLeg(0, {
        matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B',
        pick: 'Over 45.5', side: 'Over 45.5', market: 'Total', line: 45.5,
      }),
    ],
    history: [],
  });
  assert.strictEqual(same.picks.length, 1);
  assert.strictEqual(same.parlayLegs.length, 1, 'ML+total on one game still publishes');
  assert.strictEqual(same.parlayLegs[0].legs.length, 2);
  assert.strictEqual(Number(same.parlayLegs[0].correlationFactor), 1);
  assert.ok(/applied phi 0/.test(same.parlayLegs[0].correlationNote), same.parlayLegs[0].correlationNote);
  assert.ok(/n=14/.test(same.parlayLegs[0].correlationNote));

  const trio = [0, 1, 2].map((i) => edgeLeg(i, i === 1 ? {
    pick: `Over ${40 + i}`,
    side: `Over ${40 + i}`,
    market: 'Total',
    line: 40 + i,
  } : {}));
  const goal = await v2.buildCard({ date: DATE, pregameAsOfMs: PREGAME, candidates: trio, history: [] });
  assert.strictEqual(goal.parlayLegs[0].legs.length, 3, 'three qualifying legs are the goal');
  for (const leg of goal.parlayLegs[0].legs) novig(leg);
  assert.ok(parseFloat(goal.parlayLegs[0].ev) > 0);

  const ml = (matchup, pick, edge) => ({
    sport: 'NFL',
    matchup,
    pick,
    market: 'Moneyline',
    odds: -110,
    edgeNovig: edge,
    parlayQualified: true,
    calibration: { pCal: 0.56 },
  });
  const tied = v2.chooseTicket([
    ml('A @ B', 'A ML', 0.04),
    ml('C @ D', 'Over 45', 0.04),
    { ...ml('C @ D', 'Over 45', 0.04), market: 'Total', pick: 'Over 45' },
    ml('E @ F', 'E ML', 0.04),
    ml('G @ H', 'G ML', 0.04),
  ]);
  assert.ok(tied);
  assert.strictEqual(tied.legs.length, 3);
  assert.strictEqual(v2.mlTotalMix(tied.legs), 1, 'ML+total wins a tie on edge');
  const edged = v2.chooseTicket([
    ml('A @ B', 'A ML', 0.06),
    ml('C @ D', 'C ML', 0.06),
    ml('E @ F', 'E ML', 0.06),
    { ...ml('G @ H', 'Over 50', 0.01), market: 'Total', pick: 'Over 50' },
  ]);
  assert.strictEqual(v2.mlTotalMix(edged.legs), 0, 'a higher edge sum beats the ML+total pattern');

  const longshot = v2.sizeParlay([
    {
      sport: 'NBA', matchup: 'Denver Nuggets @ Phoenix Suns', pick: 'Under 231', market: 'Total',
      odds: 100, edgeNovig: 0.0246, parlayQualified: true, calibration: { pCal: 0.5091050480440619 },
    },
    {
      sport: 'NBA', matchup: 'Chicago Bulls @ Boston Celtics', pick: 'Chicago Bulls', market: 'Moneyline',
      odds: 650, edgeNovig: 0.0183, parlayQualified: true, calibration: { pCal: 0.1401382910181729 },
    },
    {
      sport: 'NBA', matchup: 'Charlotte Hornets @ Washington Wizards', pick: 'Charlotte Hornets', market: 'Moneyline',
      odds: 100, edgeNovig: 0.0168, parlayQualified: true, calibration: { pCal: 0.5143777178910498 },
    },
  ], []);
  assert.strictEqual(longshot.publish, true);
  assert.strictEqual(longshot.legs.length, 2, 'a 3-leg that rounds to 0u falls through to a 2-leg');
  assert.ok(longshot.legs.some((leg) => /Under 231/.test(leg.pick)));
  assert.ok(longshot.legs.some((leg) => /Bulls/.test(leg.pick)), 'the higher no-vig edge pair still includes the longshot');
  assert.strictEqual(longshot.units, 0.25);
  assert.ok(longshot.ev > 0);

  // Raw quarter-Kelly under ~0.125u steps to 0. It is not floored up to 0.25u.
  const dustP = 0.502;
  const dustLegs = [0, 1].map((i) => ({
    sport: 'NFL',
    matchup: `Dust ${i} Away @ Dust ${i} Home`,
    pick: `Dust ${i} ML`,
    market: 'Moneyline',
    odds: 100,
    book: 'draftkings',
    edgeNovig: 0.01,
    parlayQualified: true,
    calibration: { pCal: dustP },
  }));
  const dustStake = v2.sizeParlay(dustLegs, []);
  const dustJoint = dustP * dustP;
  const dustFull = ((4 - 1) * dustJoint - (1 - dustJoint)) / (4 - 1);
  const dustFrac = dustFull * 0.25;
  assert.ok(dustFrac * 100 < 0.125, `raw ${dustFrac * 100}u should step to 0`);
  assert.strictEqual(dustStake.publish, false);
  assert.strictEqual(dustStake.units, 0);
  assert.strictEqual(dustStake.skipReason, 'parlay stake rounded below 0.25u');
  assert.strictEqual(kellyToUnits(dustFrac, 1), 0.25, 'kellyToUnits would floor this; sizeParlay must not');

  // Raw ~0.20u is nearer 0.25u than 0. That stake still publishes.
  const nearP = Math.sqrt(0.256);
  const nearLegs = [0, 1].map((i) => ({
    sport: 'NFL',
    matchup: `Near ${i} Away @ Near ${i} Home`,
    pick: `Near ${i} ML`,
    market: 'Moneyline',
    odds: 100,
    book: 'draftkings',
    edgeNovig: 0.02,
    parlayQualified: true,
    calibration: { pCal: nearP },
  }));
  const nearStake = v2.sizeParlay(nearLegs, []);
  const nearFull = ((4 - 1) * 0.256 - (1 - 0.256)) / (4 - 1);
  const nearRaw = nearFull * 0.25 * 100;
  assert.ok(nearRaw > 0.125 && nearRaw < 0.25, `raw ${nearRaw}u`);
  assert.strictEqual(nearStake.publish, true);
  assert.strictEqual(nearStake.units, 0.25);

  const dec = dec290;
  const pClear = pKent;
  const pMktClear = pClear - 0.07;
  const kNcaaf = 0.72;
  const clear = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [side({
      sport: 'NCAAF',
      matchup: 'Kent State @ Toledo',
      awayTeam: 'Kent State',
      homeTeam: 'Toledo',
      pick: 'Kent State ML',
      side: 'Kent State ML',
      odds: -290,
      oddsStr: '-290',
      pMkt: pMktClear,
      pModel: pModelFor(pClear, pMktClear, kNcaaf),
    })],
    history: [],
  });
  assert.strictEqual(clear.picks.length, 1, 'a short price that clears its bucket floor is a bet');
  assert.ok(clear.picks[0].edgeNovig > v2.uncertaintyFloor(clear.picks[0].pCal, clear.picks[0].pMkt).floor);
  assert.strictEqual(clear.picks[0].edgePct, `${(clear.picks[0].edgeNovig * 100).toFixed(1)}%`);
  assert.ok(clear.picks[0].priceEdgePct);
  assert.strictEqual(clear.picks[0].unitsNum, 2, 'quarter-Kelly above 2u caps at 2u');
  assert.ok(Math.abs(clear.picks[0].pCal - pClear) < 1e-9);

  const pMktNoise = pKent - 0.02;
  const noisy = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [side({
      sport: 'NCAAF',
      matchup: 'Kent State @ Toledo',
      awayTeam: 'Kent State',
      homeTeam: 'Toledo',
      pick: 'Kent State ML',
      side: 'Kent State ML',
      odds: -290,
      oddsStr: '-290',
      pMkt: pMktNoise,
      pModel: pModelFor(pKent, pMktNoise, kNcaaf),
      coverProb: 0.77,
      ev: 0.035,
      edgePct: 0.026,
    })],
    history: [],
  });
  assert.strictEqual(noisy.picks.length, 0, '3.5% EV at -290 with a 2pp no-vig edge is not a straight');
  assert.strictEqual(noisy.parlayLegs.length, 0);
  assert.ok(noisy.rejections.some((row) => row.reason === 'edge-below-uncertainty-floor'));

  const plus575 = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [side({
      odds: 575,
      oddsStr: '+575',
      pMkt: 0.140,
      pModel: pModelFor(0.167, 0.140, v2.priorKFor('NFL')),
      coverProb: 0.167,
    })],
    history: [],
  });
  assert.strictEqual(plus575.picks.length, 0, '+575 at 2.7pp does not clear k*SE');
  assert.strictEqual(plus575.parlayLegs.length, 0);
  assert.ok(plus575.rejections.some((row) => row.reason === 'edge-below-uncertainty-floor'));
  assert.ok(Math.abs(plus575.rejections.find((row) => row.reason === 'edge-below-uncertainty-floor').edgeNovig - 0.027) < 1e-9);

  const warriorsGame = 'Houston Rockets @ Golden State Warriors';
  const bullsGame = 'Orlando Magic @ Chicago Bulls';
  const kentGame = 'Kent State @ Toledo';
  const noEdge = (over) => side({
    sport: 'NBA',
    odds: -110,
    oddsStr: '-110',
    pModel: 0.52,
    pMkt: 0.52,
    coverProb: 0.55,
    ev: 0.04,
    edgePct: 0.03,
    ...over,
  });
  const rejectedLegs = [
    noEdge({
      matchup: warriorsGame,
      awayTeam: 'Houston Rockets',
      homeTeam: 'Golden State Warriors',
      side: 'Golden State Warriors +2.5',
      pick: 'Golden State Warriors +2.5',
      market: 'Spread',
      line: 2.5,
    }),
    noEdge({
      matchup: bullsGame,
      awayTeam: 'Orlando Magic',
      homeTeam: 'Chicago Bulls',
      side: 'Chicago Bulls ML',
      pick: 'Chicago Bulls ML',
      market: 'Moneyline',
      odds: 650,
      oddsStr: '+650',
      bestDkHr: { american: 650, book: 'draftkings' },
      pModel: 0.133,
      pMkt: 0.133,
      coverProb: 0.22,
    }),
    noEdge({
      sport: 'NCAAF',
      matchup: kentGame,
      awayTeam: 'Kent State',
      homeTeam: 'Toledo',
      side: 'Kent State ML',
      pick: 'Kent State ML',
      odds: -290,
      oddsStr: '-290',
      pMkt: pMktNoise,
      pModel: pModelFor(pKent, pMktNoise, kNcaaf),
      coverProb: 0.77,
      ev: 0.035,
    }),
  ];
  const v1Card = publishEdgeCard({
    positions: rejectedLegs,
    qualified: rejectedLegs,
    yesPool: rejectedLegs,
    cardDate: DATE,
    dateFormatted: DATE,
  });
  const matched = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: rejectedLegs,
    parlayPool: rejectedLegs,
    v1Qualified: rejectedLegs,
    history: [],
  });
  assert.ok(v1Card.parlayLegs.length === 1, 'the fixture is the v1 ticket the owner rejected');
  assert.strictEqual(matched.parlayLegs.length, 0, 'v2 must not keep Warriors, Bulls, or a noisy favorite');
  assert.ok(!matched.picks.some((pick) => /warriors|bulls|kent state/i.test(pick.pick)));
  assert.strictEqual(matched.parlaySource, null);

  const hammer = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [side({
      pModel: pModelFor(0.3 * 0.82 + 0.7 * 0.52, 0.52, v2.priorKFor('NFL')),
      pMkt: 0.52,
      coverProb: 0.61,
      ev: 0.08,
      edgePct: 0.09,
    })],
    history: [],
  });
  assert.strictEqual(hammer.picks.length, 1);
  assert.strictEqual(hammer.parlayLegs.length, 0);
  assert.strictEqual(hammer.picks[0].unitsNum, 2, 'quarter-Kelly above 2u caps');
  assert.ok(hammer.picks[0].edgeNovig <= 0.10);
  assert.strictEqual(hammer.picks[0].modelVersion, v2.MODEL_VERSION);

  const board = await v2.saveMorningBoard(DATE, flat, { dryRun: true });
  assert.strictEqual(board.saved, false);
  assert.strictEqual(board.reason, 'no-write');
  assert.strictEqual(board.count, 3);
  assert.ok(String(board.key).includes('omega-v2/morning-board/'));

  const history = await v2.loadGradedHistory(DATE, {
    readDates: async () => [DATE, '2026-10-29', '2026-11-01'],
    readPicks: async (d) => ({
      date: d,
      picks: [{ sport: 'NFL', result: 'win', p_model: 0.6, fair_sharp_p: 0.5 }],
    }),
  });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].date, '2026-10-29');

  let leaked = false;
  try {
    await v2.buildCard({
      date: DATE,
      pregameAsOfMs: PREGAME,
      candidates: [side({ pModel: 0.6, pMkt: 0.5 })],
      history: [{ date: DATE, sport: 'NFL', pModel: 0.6, pMkt: 0.5, result: 'win' }],
    });
  } catch (err) {
    leaked = /leakage/.test(err.message);
  }
  assert.ok(leaked, 'same-day history must throw');

  console.log('PASS test-omega-v2-sharp');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
