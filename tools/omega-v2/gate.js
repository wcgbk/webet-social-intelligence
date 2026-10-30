'use strict';

/**
 * Omega pipeline v2 test gate.
 * Checks card validity, leakage, the price-recheck hook, and that the
 * flag-off path matches current production publish, grading, prices, and
 * schedule output. Does not call The Odds API.
 */

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '../..');
const v2 = require('../../netlify/functions/lib/omega-v2');
const { publishEdgeCard } = require('../../netlify/functions/lib/omega-vnext/assemble');
const grading = require('../../netlify/functions/lib/omega-grading-rules');
const { etCalendarDate } = require('../../netlify/functions/lib/omega-vnext/odds_math');

function prodCandidate(over) {
  return {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeTeam: 'Kansas City Chiefs',
    side: 'Buffalo Bills ML',
    market: 'Moneyline',
    odds: -110,
    oddsStr: '-110',
    book: 'draftkings',
    bestDkHr: { american: -110, book: 'draftkings' },
    coverProb: 0.55,
    edgePct: 0.03,
    ev: 0.04,
    commenceTime: '2026-10-20T17:00:00Z',
    line: null,
    uncertainty: 0.18,
    fair_sharp_p: 0.52,
    modelRawP: 0.56,
    ...over,
  };
}

function priceOf(card) {
  return (card.picks || []).map((p) => ({
    pick: p.pick,
    matchup: p.matchup,
    odds: p.odds,
    commenceTime: p.commenceTime,
    units: p.units,
  }));
}

function strong(sport, matchup, pick, market) {
  return {
    sport,
    matchup,
    pick,
    market,
    odds: '-110',
    pModel: 0.68,
    pMkt: 0.50,
    uncertainty: 0.18,
    commenceTime: '2026-10-20T17:00:00Z',
    result: 'win',
    line: market === 'Total' ? 45.5 : null,
  };
}

function weak(i) {
  return {
    sport: 'NHL',
    matchup: `Away ${i} @ Home ${i}`,
    pick: `Away ${i} ML`,
    market: 'Moneyline',
    odds: '-110',
    pModel: 0.52,
    pMkt: 0.52,
    uncertainty: 0.18,
    commenceTime: '2026-10-20T23:00:00Z',
    result: 'loss',
  };
}

async function main() {
  const savedFlag = process.env.OMEGA_PIPELINE_V2;
  delete process.env.OMEGA_PIPELINE_V2;
  assert.strictEqual(v2.pipelineV2Enabled({}), true, 'flag defaults on');
  process.env.OMEGA_PIPELINE_V2 = '0';
  assert.strictEqual(v2.pipelineV2Enabled({}), false, '0 falls back to v1');
  process.env.OMEGA_PIPELINE_V2 = '1';
  assert.strictEqual(v2.pipelineV2Enabled({}), true, 'env flag on');
  assert.strictEqual(v2.pipelineV2Enabled({ pipelineV2: false }), false, 'explicit off wins');
  if (savedFlag == null) delete process.env.OMEGA_PIPELINE_V2;
  else process.env.OMEGA_PIPELINE_V2 = savedFlag;

  const positions = [
    prodCandidate({}),
    prodCandidate({
      matchup: 'Dallas Cowboys @ Philadelphia Eagles',
      awayTeam: 'Dallas Cowboys',
      homeTeam: 'Philadelphia Eagles',
      side: 'Over 45.5',
      market: 'Total',
      line: 45.5,
      commenceTime: '2026-10-20T20:00:00Z',
    }),
    prodCandidate({
      matchup: 'Green Bay Packers @ Chicago Bears',
      awayTeam: 'Green Bay Packers',
      homeTeam: 'Chicago Bears',
      side: 'Green Bay Packers +3',
      market: 'Spread',
      line: 3,
      odds: -105,
      oddsStr: '-105',
      bestDkHr: { american: -105, book: 'hardrockbet' },
      commenceTime: '2026-10-20T17:00:00Z',
    }),
  ];
  const prodArgs = {
    positions,
    qualified: [positions[0]],
    yesPool: positions,
    rejected: [],
    miscalibrated: [],
    hardFails: [],
    cardDate: '2026-10-20',
    modelVersion: 'v12.5.4-omega-vnext',
    dateFormatted: 'Monday, October 20, 2026',
  };
  const direct = publishEdgeCard(prodArgs);
  const viaFlag = await v2.runPipeline({ pipelineV2: false, prodArgs });
  assert.deepStrictEqual(priceOf(viaFlag), priceOf(direct), 'flag-off prices and schedule differ from prod');
  assert.strictEqual(direct.picks.length, viaFlag.picks.length);
  assert.ok(direct.picks.length >= 1);
  for (const pick of viaFlag.picks) {
    assert.ok(pick.commenceTime, 'schedule commenceTime missing');
    assert.ok(pick.odds, 'price missing');
  }
  assert.strictEqual(etCalendarDate('2026-10-20T17:00:00Z'), '2026-10-20');

  assert.strictEqual(grading.GRADING_RULES_V2_FROM, '2026-10-07');
  assert.strictEqual(grading.NHL_SHOOTOUT_RULE_FROM, '2026-10-15');
  assert.strictEqual(grading.CLV_POINT_AWARE_FROM, '2026-10-09');
  assert.strictEqual(grading.nhlShootoutExcluded('2026-10-14'), false);
  assert.strictEqual(grading.nhlShootoutExcluded('2026-10-15'), true);
  const scored = grading.nhlRegulationScores({
    dateISO: '2026-10-14',
    market: 'total',
    pick: { pick: 'Over 5.5', sport: 'NHL', betType: 'Total' },
    awayScore: 3,
    homeScore: 2,
    game: { awayScore: 3, homeScore: 2 },
  });
  assert.strictEqual(scored.applied, false);
  assert.strictEqual(scored.awayScore, 3);
  assert.strictEqual(scored.homeScore, 2);

  const forbidden = [
    'netlify/functions/lib/omega-grading-rules.js',
    'netlify/functions/get-results-omega.js',
    'netlify/functions/lib/omega-vnext/select.js',
    'netlify/functions/lib/omega-vnext/assemble.js',
    'netlify/functions/lib/omega-vnext/parlay.js',
    'netlify/functions/lib/omega-vnext/calibrate.js',
    'netlify/functions/lib/omega-vnext/odds_math.js',
    'netlify/functions/lib/et-schedule.js',
  ];
  const diff = execSync(`git diff --name-only a592e0b -- ${forbidden.join(' ')}`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.strictEqual(diff, '', `flag-off prod files changed:\n${diff}`);

  const dir = path.join(root, 'netlify/functions/lib/omega-v2');
  const banned = /the-odds-api|api\.the-odds-api|odds-api\.com/i;
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!banned.test(text), `${file} references an odds API`);
    assert.ok(!/\bfetch\s*\(/.test(text), `${file} calls fetch`);
  }

  let leaked = false;
  try {
    await v2.buildCard({
      date: '2026-10-02',
      candidates: [strong('NFL', 'A @ B', 'A ML', 'Moneyline')],
      history: [{ date: '2026-10-02', sport: 'NFL', pModel: 0.6, pMkt: 0.5, result: 'win' }],
    });
  } catch (err) {
    leaked = /leakage/.test(err.message);
  }
  assert.ok(leaked, 'same-day training row must throw');

  const prior = await v2.buildCard({
    date: '2026-10-01',
    candidates: [strong('NFL', 'A @ B', 'A ML', 'Moneyline')],
    history: [],
  });
  assert.strictEqual(prior.calibration.trainN, 0);
  assert.strictEqual(prior.leakageChecked, true);
  assert.strictEqual(prior.modelVersion, 'omega-v2-sharp-2026-10-30');

  const next = await v2.buildCard({
    date: '2026-10-02',
    candidates: [strong('NFL', 'C @ D', 'C ML', 'Moneyline')],
    history: [{ date: '2026-10-01', sport: 'NFL', pModel: 0.6, pMkt: 0.5, result: 'win' }],
  });
  assert.strictEqual(next.calibration.trainN, 1);
  assert.ok(next.calibration.trainMaxDate < '2026-10-02');

  const pass = await v2.buildCard({
    date: '2026-10-03',
    candidates: [0, 1, 2, 3, 4].map(weak),
    history: [],
  });
  assert.strictEqual(pass.picks.length, 0, 'pass day must be allowed');
  assert.strictEqual(pass.parlayLegs.length, 0);
  assert.strictEqual(pass.pass, true);

  const one = await v2.buildCard({
    date: '2026-10-03',
    candidates: [strong('NFL', 'A @ B', 'A ML', 'Moneyline'), ...[0, 1, 2, 3].map(weak)],
    history: [],
  });
  assert.strictEqual(one.picks.length, 1, 'must not force-fill to 3');
  assert.strictEqual(one.picks[0].odds, '-110');
  assert.strictEqual(one.picks[0].commenceTime, '2026-10-20T17:00:00Z');
  const units = one.picks[0].unitsNum;
  assert.ok(units > 0 && units <= 2, `stake ${units} outside quarter-Kelly cap`);
  assert.strictEqual(Math.round(units * 4) / 4, units);

  const sameGame = await v2.buildCard({
    date: '2026-10-03',
    candidates: [
      strong('NFL', 'A @ B', 'A ML', 'Moneyline'),
      strong('NFL', 'A @ B', 'Over 45.5', 'Total'),
    ],
    history: [],
  });
  assert.strictEqual(sameGame.parlayLegs.length, 0, 'same-game parlay must not publish');
  assert.ok(sameGame.picks.length <= 1);

  const ticket = await v2.buildCard({
    date: '2026-10-20',
    candidates: [
      strong('NFL', 'Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline'),
      strong('NFL', 'Dallas Cowboys @ Philadelphia Eagles', 'Over 45.5', 'Total'),
      strong('NFL', 'Green Bay Packers @ Chicago Bears', 'Green Bay Packers ML', 'Moneyline'),
    ],
    history: [],
  });
  assert.ok(ticket.parlayLegs.length === 1, 'historical parlay should publish');
  const parlay = ticket.parlayLegs[0];
  assert.ok(parlay.legs.length === 2 || parlay.legs.length === 3);
  assert.ok(parlay.legMarkets.includes('Moneyline') && parlay.legMarkets.includes('Total'));
  assert.strictEqual(Number(parlay.correlationFactor), 1, 'distinct games are not haircut');
  assert.ok(parseFloat(parlay.units) >= 0.25);
  const games = new Set(parlay.legs.map((leg) => leg.matchup.toLowerCase()));
  assert.strictEqual(games.size, parlay.legs.length);

  const st = await v2.buildCard({
    date: '2026-10-03',
    candidates: [
      strong('NHL', 'Boston Bruins @ St. Louis Blues', 'Boston Bruins ML', 'Moneyline'),
      strong('NHL', 'Boston Bruins @ st louis blues', 'Over 5.5', 'Total'),
    ],
    history: [],
  });
  assert.strictEqual(st.parlayLegs.length, 0, 'st. louis and st louis are the same game');
  assert.ok(st.picks.length <= 1);

  let networkCalls = 0;
  const rechecked = await v2.buildCard({
    date: '2026-10-03',
    candidates: [
      strong('NFL', 'A @ B', 'A ML', 'Moneyline'),
      strong('NFL', 'C @ D', 'Over 44.5', 'Total'),
    ],
    history: [],
    recheck: async (leg) => {
      networkCalls += 1;
      if (leg.pick === 'A ML') return { american: -180, line: null };
      return { american: -110, line: 44.5 };
    },
  });
  assert.ok(networkCalls >= 1);
  assert.ok(!rechecked.picks.some((p) => p.pick === 'A ML'), 'worse price must drop');
  assert.strictEqual(rechecked.priceRecheck.checked, true);

  console.log('PASS omega-v2 gate');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
