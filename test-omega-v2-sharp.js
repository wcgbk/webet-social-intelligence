'use strict';

/**
 * Live omega-v2 sharp card: default on, no forced straight fill,
 * historical parlay kept, same-game haircut only, quarter-Kelly cap.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const DATE = '2026-10-30';
const COMMENCE = '2026-10-30T23:00:00Z';

function side(over) {
  return {
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
}

function assertQuarter(units, cap) {
  assert.ok(units >= 0.25, `stake ${units}`);
  assert.ok(units <= cap + 1e-9, `stake ${units} over ${cap}`);
  assert.strictEqual(Math.round(units * 4) / 4, units);
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

  assert.strictEqual(v2.MODEL_VERSION, 'omega-v2-sharp-2026-10-30');
  assert.strictEqual(v2.UNIT_DOLLARS, 150);
  assert.strictEqual(v2.PER_BET_CAP, 2);
  assert.ok(v2.priorKFor('MLB') < v2.priorKFor('NFL'));

  const flat = [0, 1, 2].map((i) => side({
    matchup: `Away ${i} @ Home ${i}`,
    awayTeam: `Away ${i}`,
    homeTeam: `Home ${i}`,
    side: `Home ${i} ML`,
    pick: `Home ${i} ML`,
  }));
  const noFill = await v2.buildCard({
    date: DATE,
    candidates: flat,
    parlayPool: flat,
    history: [],
  });
  assert.strictEqual(noFill.picks.length, 0, 'flat prices must not be filled to 3');
  assert.strictEqual(noFill.parlayLegs.length, 1, 'historical parlay still publishes');
  assert.strictEqual(noFill.v1WouldParlay, true);
  assert.strictEqual(noFill.parlayLegs[0].legs.length, 3);
  assert.strictEqual(Number(noFill.parlayLegs[0].correlationFactor), 1);
  assertQuarter(noFill.parlayLegs[0].unitsNum, 1);
  assert.ok(noFill.parlayLegs[0].unitsNum >= 0.5, 'positive-EV parlay keeps a profit stake');
  assert.strictEqual(noFill.pass, false);
  assert.strictEqual(noFill.modelVersion, v2.MODEL_VERSION);

  const sameGame = [
    side({
      matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B',
      side: 'B ML', pick: 'B ML', market: 'Moneyline', ev: 0.02, coverProb: 0.55,
    }),
    side({
      matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B',
      side: 'Over 45.5', pick: 'Over 45.5', market: 'Total', line: 45.5,
      ev: -0.01, coverProb: 0.48,
    }),
    side({
      matchup: 'C @ D', awayTeam: 'C', homeTeam: 'D',
      side: 'D ML', pick: 'D ML', market: 'Moneyline', ev: -0.02, coverProb: 0.48,
    }),
    side({
      matchup: 'C @ D', awayTeam: 'C', homeTeam: 'D',
      side: 'Over 44', pick: 'Over 44', market: 'Total', line: 44,
      ev: -0.01, coverProb: 0.47,
    }),
  ];
  const haircut = await v2.buildCard({
    date: DATE,
    candidates: sameGame,
    parlayPool: sameGame,
    history: [],
  });
  assert.strictEqual(haircut.picks.length, 0);
  assert.strictEqual(haircut.parlayLegs.length, 1, 'same-game ticket is haircut, not dropped');
  assert.ok(Number(haircut.parlayLegs[0].correlationFactor) < 1);
  assert.ok(String(haircut.parlayLegs[0].correlationHaircut).startsWith('0.95^'));
  assertQuarter(haircut.parlayLegs[0].unitsNum, 1);
  const games = haircut.parlayLegs[0].legs.map((leg) => String(leg.matchup).toLowerCase());
  assert.ok(games.length >= 2);
  assert.ok(new Set(games).size < games.length, 'ticket actually shares a game');

  const hammer = await v2.buildCard({
    date: DATE,
    candidates: [side({
      pModel: 0.82,
      pMkt: 0.52,
      coverProb: 0.61,
      ev: 0.08,
      edgePct: 0.09,
    })],
    history: [],
  });
  assert.strictEqual(hammer.picks.length, 1);
  assert.strictEqual(hammer.picks[0].unitsNum, 2, 'quarter-Kelly above 2u caps');
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
