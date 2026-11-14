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
const FUTURE_COMMENCE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
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
    book: 'draftkings',
    pModel: 0.68,
    pMkt: 0.50,
    uncertainty: 0.18,
    commenceTime: FUTURE_COMMENCE,
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
    book: 'draftkings',
    pModel: 0.52,
    pMkt: 0.52,
    uncertainty: 0.18,
    commenceTime: FUTURE_COMMENCE,
    result: 'loss',
  };
}

async function main() {
  // Replay reports go to a temp dir unless the caller asks for repo copies.
  if (!process.env.OMEGA_V2_GATE) process.env.OMEGA_V2_GATE = '1';
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

  // Legacy assertions below are the positive-edge card. The default card is
  // now the top 3 by expected growth. Turn that off here so those checks stay
  // the old gates. The force-top3 block further down turns it back on, then
  // off again so the child tests inherit the legacy flag.
  process.env.OMEGA_V2_FORCE_TOP3 = 'off';
  assert.strictEqual(v2.forceTop3Enabled(), false, 'legacy gate runs with force-top3 off');

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
    'netlify/functions/lib/omega-vnext/select.js',
    'netlify/functions/lib/omega-vnext/assemble.js',
    'netlify/functions/lib/omega-vnext/parlay.js',
    'netlify/functions/lib/omega-vnext/calibrate.js',
    'netlify/functions/lib/omega-vnext/odds_math.js',
  ];
  // get-results-omega.js is outside this freeze: day.record counts straights
  // only (test-omega-results-kpi-1030.js). Grading rules, prices, and
  // selection stay frozen. et-schedule.js stays out (DST-corrected slots).
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
  assert.strictEqual(prior.modelVersion, 'omega-v2-sharp-2026-11-01-dkhr');

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
  assert.strictEqual(one.picks[0].commenceTime, FUTURE_COMMENCE);
  const units = one.picks[0].unitsNum;
  assert.ok(units > 0 && units <= 2, `stake ${units} outside quarter-Kelly cap`);
  assert.strictEqual(Math.round(units * 4) / 4, units);

  const sameGame = await v2.buildCard({
    date: '2026-10-03',
    candidates: [
      strong('NFL', 'A @ B', 'A ML', 'Moneyline'),
      strong('NFL', 'A @ B', 'A -3.5', 'Spread'),
    ],
    history: [],
  });
  assert.strictEqual(sameGame.parlayLegs.length, 0, 'same-game ML+spread must not publish');
  assert.ok(sameGame.picks.length <= 1);
  assert.ok(sameGame.rejections.some((row) => row.reason === 'no ticket with positive joint EV'
    || row.reason === 'fewer than 2 qualifying legs'));

  const priced = (row) => {
    const american = Number(String(row.odds).replace(/[^0-9.+-]/g, ''));
    return {
      ...row,
      side: row.pick,
      odds: american,
      oddsStr: String(row.odds),
      book: 'draftkings',
      bestDkHr: { american, book: 'draftkings' },
      coverProb: 0.57,
      ev: 0.05,
      edgePct: 0.03,
    };
  };
  const ticket = await v2.buildCard({
    date: '2026-10-20',
    candidates: [
      priced(strong('NFL', 'Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline')),
      priced(strong('NFL', 'Dallas Cowboys @ Philadelphia Eagles', 'Over 45.5', 'Total')),
      priced(strong('NFL', 'Green Bay Packers @ Chicago Bears', 'Green Bay Packers ML', 'Moneyline')),
    ],
    history: [],
  });
  assert.ok(ticket.parlayLegs.length === 1, 'three positive-edge legs should publish a parlay');
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
      // NFL, not NHL: an NHL moneyline is shrunk onto the no-vig fair (k = 1)
      // and would not clear an edge. This check is the same-game pair.
      strong('NFL', 'Buffalo Bills @ St. Louis Battlehawks', 'Buffalo Bills ML', 'Moneyline'),
      strong('NFL', 'Buffalo Bills @ st louis battlehawks', 'Over 45.5', 'Total'),
    ],
    history: [],
  });
  assert.strictEqual(st.picks.length, 1, 'st. louis and st louis are one game, so one straight');
  assert.strictEqual(st.parlayLegs.length, 0, 'same-game ML+total does not publish');
  assert.strictEqual(st.pass, false, 'the straight still publishes');
  assert.strictEqual(v2.bannedPairReason([
    { matchup: 'Buffalo Bills @ St. Louis Battlehawks', pick: 'Buffalo Bills ML', market: 'Moneyline', homeTeam: 'St. Louis Battlehawks', awayTeam: 'Buffalo Bills' },
    { matchup: 'Buffalo Bills @ st louis battlehawks', pick: 'Over 45.5', market: 'Total', line: 45.5, homeTeam: 'st louis battlehawks', awayTeam: 'Buffalo Bills' },
  ]), 'same-game');

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

  // A sport at the 24-row floor does not take a Platt map unless the
  // walk-forward log-loss beats the shrink and the no-vig price. Hits at
  // the price, with the model sitting above it, are not that beat.
  const mapHist = [];
  for (let i = 0; i < 24; i += 1) {
    mapHist.push({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      sport: 'NCAAF',
      market: 'Total',
      pick: 'Over 44.5',
      pModel: 0.80,
      pMkt: 0.50,
      result: i % 2 ? 'win' : 'loss',
    });
  }
  const mapFit = v2.fitWalkForward(mapHist, '2026-11-03');
  const mapModel = mapFit.bySport && mapFit.bySport.NCAAF;
  assert.ok(mapModel, '24 graded rows clear the sport floor');
  assert.strictEqual(mapModel.method, 'shrink', 'walk-forward log-loss keeps the shrink');
  assert.ok(mapModel.wfLogLoss && mapModel.wfLogLoss.n >= 5, 'walk-forward scored a tail');
  assert.ok(!(mapModel.wfLogLoss.platt < mapModel.wfLogLoss.market), 'Platt does not beat the no-vig price');
  const mapCal = v2.applyCalibration({
    sport: 'NCAAF', market: 'Total', pick: 'Over 44.5', pModel: 0.80, pMkt: 0.50,
  }, mapFit);
  assert.strictEqual(mapCal.mapApplied, false, 'a losing map is not applied');
  assert.ok(Math.abs(mapCal.pCal - mapCal.pShrink) < 1e-12, 'pCal stays on the shrink');

  await testFixOmegaCard1103();

  process.env.OMEGA_V2_FORCE_TOP3 = '1';
  assert.strictEqual(v2.forceTop3Enabled(), true, 'force-top3 flag on');
  const forcedCard = await v2.buildCard({
    date: '2026-10-04',
    dateFormatted: 'Saturday, October 4, 2026',
    candidates: [0, 1, 2, 3].map(weak),
    history: [],
  });
  assert.strictEqual(forcedCard.selectionRule, 'force-top3');
  assert.strictEqual(forcedCard.parlaySource, 'top3-straights');
  assert.strictEqual(forcedCard.picks.length, 3, 'negative-edge slate still publishes the top 3');
  assert.strictEqual(new Set(forcedCard.picks.map((p) => String(p.matchup).toLowerCase())).size, 3);
  assert.strictEqual(forcedCard.parlayLegs.length, 1);
  assert.strictEqual(forcedCard.parlayLegs[0].legs.length, 3);
  assert.deepStrictEqual(
    forcedCard.parlayLegs[0].legs.map((leg) => leg.pick).sort(),
    forcedCard.picks.map((p) => p.pick).sort(),
  );
  assert.ok(forcedCard.picks.every((p) => p.unitsNum >= 0.25 && p.unitsNum <= 2));
  assert.strictEqual(forcedCard.edgeSummary, 'Saturday, October 4, 2026: top 3 plays by expected growth.');
  assert.ok(!/\b(Alpha|Omega)\b/.test(`${forcedCard.edgeSummary} ${forcedCard.insights || ''}`));
  const mismatched = await v2.buildCard({
    date: '2026-10-04',
    dateFormatted: 'Saturday, October 4, 2026',
    candidates: [{
      sport: 'NBA',
      matchup: 'Mismatch Away @ Mismatch Home',
      pick: 'Mismatch Away ML',
      market: 'Moneyline',
      odds: '-110',
      book: 'draftkings',
      pModel: 0.40,
      pMkt: 0.40,
      commenceTime: FUTURE_COMMENCE,
    }],
    history: [],
  });
  assert.ok(mismatched.rejections.some((row) => row.reason === 'price-fair-mismatch'), 'price-fair-mismatch rejects');
  assert.strictEqual(mismatched.picks.length, 0);
  assert.strictEqual(mismatched.edgeSummary, 'Saturday, October 4, 2026: no placeable plays.');
  assert.strictEqual(v2.longshotAdjEnabled(), true, 'longshot adjustment defaults on');
  // Child tests spawned below inherit this env. Keep the legacy flag off.
  process.env.OMEGA_V2_FORCE_TOP3 = 'off';
  assert.strictEqual(v2.forceTop3Enabled(), false);

  await testMarketSkill();

  console.log('PASS omega-v2 gate');

  const fnLoad = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-netlify-functions-load.js')],
    { stdio: 'inherit' }
  );
  if (fnLoad.status !== 0) throw new Error('netlify functions load gate failed');

  const regradeLetters = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-regrade-omega-letters.js')],
    { stdio: 'inherit' }
  );
  if (regradeLetters.status !== 0) throw new Error('regrade omega letters gate failed');

  const nhlInputs = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-nhl-inputs.js')],
    { stdio: 'inherit' }
  );
  if (nhlInputs.status !== 0) throw new Error('nhl public-input gate failed');

  const biasBoard = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-bias-board.js')],
    { stdio: 'inherit' }
  );
  if (biasBoard.status !== 0) throw new Error('board bias gate failed');

  // Math gate: replay stored v2 cards against the approved GATE_SPEC rules.
  const math = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'math-gate.js')], { stdio: 'inherit' });
  if (math.status !== 0) throw new Error('omega-v2 math gate failed');

  const resultsKpi = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-results-kpi-1030.js')],
    { stdio: 'inherit' }
  );
  if (resultsKpi.status !== 0) throw new Error('results kpi gate failed');

  const candidateClv = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-candidate-clv.js')],
    { stdio: 'inherit' }
  );
  if (candidateClv.status !== 0) throw new Error('candidate clv gate failed');

  const candidateInputs = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-candidate-inputs.js')],
    { stdio: 'inherit' }
  );
  if (candidateInputs.status !== 0) throw new Error('candidate inputs gate failed');

  const placeParlay = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-place-parlay.js')],
    { stdio: 'inherit' }
  );
  if (placeParlay.status !== 0) throw new Error('place and parlay gate failed');

  const replayDkhr = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-v2-replay-dkhr.js')],
    { stdio: 'inherit' }
  );
  if (replayDkhr.status !== 0) throw new Error('replay dkhr gate failed');

  const boardOrder = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-odds-master-board-order.js')],
    { stdio: 'inherit' }
  );
  if (boardOrder.status !== 0) throw new Error('odds-master board order gate failed');

  const captureDegraded = require('child_process').spawnSync(
    process.execPath,
    [path.join(root, 'test-omega-capture-degraded.js')],
    { stdio: 'inherit' }
  );
  if (captureDegraded.status !== 0) throw new Error('capture degraded gate failed');
}

function pickSlim(card) {
  return {
    picks: (card.picks || []).map((p) => ({
      pick: p.pick,
      odds: p.odds,
      units: p.units,
      unitsNum: p.unitsNum,
      pCal: p.pCal,
      edgePct: p.edgePct,
      ev: p.ev,
    })),
    parlay: (card.parlayLegs || []).map((ticket) => ({
      odds: ticket.combinedOdds,
      units: ticket.units,
      legs: (ticket.legs || []).map((leg) => ({ pick: leg.pick, odds: leg.odds, pCal: leg.pCal })),
    })),
  };
}

function antiRows(n, sport, date) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      date,
      sport,
      market: 'Moneyline',
      y: 0,
      pMkt: 0.5,
      pCal: 0.8,
    });
  }
  return rows;
}

/**
 * Market-skill weight. The fit trusts the model only where graded boards
 * beat the no-vig price. Flag off is the previous card.
 */
async function testMarketSkill() {
  const anti = antiRows(80, 'NBA', '2026-11-01');
  const antiFit = v2.fitMarketSkillWeight(anti);
  assert.strictEqual(antiFit.wHat, 0, 'anti-informative model fits wHat 0');
  assert.strictEqual(antiFit.n, 80);
  assert.ok(Math.abs(antiFit.w - ((80 * 0 + 150 * 1) / (80 + 150))) < 1e-12, 'EB shrink toward 1');

  const info = [];
  for (let i = 0; i < 40; i += 1) {
    info.push({ pMkt: 0.5, pCal: i % 2 ? 0.82 : 0.18, y: i % 2 ? 1 : 0 });
  }
  const infoFit = v2.fitMarketSkillWeight(info);
  assert.ok(infoFit.wHat >= 0.95, `informative model wHat near 1, got ${infoFit.wHat}`);

  const none = v2.fitMarketSkillWeight([]);
  assert.strictEqual(none.w, 1);
  assert.strictEqual(none.wHat, null);
  assert.strictEqual(none.n, 0);
  const emptyCard = v2.fitMarketSkill([], '2026-11-06');
  assert.strictEqual(emptyCard.enabled, true);
  assert.strictEqual(emptyCard.bySport.NBA.w, 1);
  assert.strictEqual(emptyCard.bySport.NBA.n, 0);
  assert.strictEqual(emptyCard.N0, 150);

  const half = v2.fitMarketSkillWeight(antiRows(150, 'NBA', '2026-11-01'));
  assert.strictEqual(half.wHat, 0);
  assert.ok(Math.abs(half.w - 0.5) < 1e-12, 'n = N0 and wHat 0 is w 0.5');

  const leaked = v2.fitMarketSkill([
    { date: '2026-11-06', sport: 'NFL', y: 0, pMkt: 0.5, pCal: 0.9 },
    { date: '2026-11-07', sport: 'NFL', y: 0, pMkt: 0.5, pCal: 0.9 },
    { d: '2026-11-05', sport: 'NFL', y: 0, pMkt: 0.5, pCal: 0.9 },
    { date: 'not-a-date', sport: 'NFL', y: 0, pMkt: 0.5, pCal: 0.9 },
  ], '2026-11-06');
  assert.strictEqual(leaked.NFL ? leaked.bySport.NFL.n : leaked.bySport.NFL.n, 1);
  assert.deepStrictEqual(leaked.bySport.NFL.dates, ['2026-11-05']);

  const rawVsCover = [];
  for (let i = 0; i < 30; i += 1) {
    const y = i % 2;
    rawVsCover.push({
      date: '2026-11-01',
      sport: 'NHL',
      y,
      pMkt: 0.5,
      coverProb: y ? 0.85 : 0.15,
      pCalRaw: y ? 0.15 : 0.85,
    });
  }
  const usedRaw = v2.fitMarketSkill(rawVsCover, '2026-11-04');
  assert.strictEqual(usedRaw.bySport.NHL.wHat, 0, 'fit reads pCalRaw, not the weighted coverProb');
  const coverOnly = rawVsCover.map((row) => ({ ...row, pCalRaw: undefined }));
  const usedCover = v2.fitMarketSkill(coverOnly, '2026-11-04');
  assert.ok(usedCover.bySport.NHL.wHat >= 0.95, 'without pCalRaw the fit uses coverProb');

  assert.strictEqual(v2.blendMarketSkill(0.42, 0.71, 1), 0.71);
  assert.strictEqual(v2.blendMarketSkill(0.42, 0.71, 0), 0.42);
  const mid = v2.blendMarketSkill(0.42, 0.71, 0.5);
  assert.ok(mid > 0.42 && mid < 0.71);

  const savedFlag = process.env.OMEGA_V2_MARKET_SKILL;
  const base = {
    date: '2026-11-06',
    candidates: [strong('NFL', 'Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline')],
    history: [],
  };
  try {
    process.env.OMEGA_V2_MARKET_SKILL = 'off';
    assert.strictEqual(v2.marketSkillEnabled({}), false);
    assert.strictEqual(v2.shouldLoadMarketSkill({}), false);
    const offEnv = await v2.buildCard(base);
    const offWithRows = await v2.buildCard({ ...base, gradedBoardRows: antiRows(2000, 'NFL', '2026-11-01') });
    delete process.env.OMEGA_V2_MARKET_SKILL;
    const offOpt = await v2.buildCard({ ...base, marketSkill: 'off' });
    const onEmpty = await v2.buildCard(base);
    assert.strictEqual(v2.marketSkillEnabled({}), true);
    assert.ok(offEnv.picks.length === 1, 'flag off still publishes the straight');
    assert.deepStrictEqual(pickSlim(offEnv), pickSlim(offWithRows), 'flag off ignores graded boards');
    assert.deepStrictEqual(pickSlim(offEnv), pickSlim(offOpt));
    assert.deepStrictEqual(pickSlim(offEnv), pickSlim(onEmpty), 'no graded rows keeps w = 1');
    assert.strictEqual(offEnv.calibration.marketSkill.enabled, false);
    assert.strictEqual(offEnv.calibration.marketSkill.NFL.w, 1);
    const nflRow = (offEnv.sportCoverage.rows || []).find((row) => row.sport === 'NFL');
    assert.ok(nflRow && nflRow.marketSkill && nflRow.marketSkill.w === 1);

    const onAnti = await v2.buildCard({
      ...base,
      gradedBoardRows: antiRows(2000, 'NFL', '2026-11-05').concat([
        { date: '2026-11-06', sport: 'NFL', y: 0, pMkt: 0.5, pCal: 0.99 },
      ]),
    });
    assert.strictEqual(onAnti.picks.length, 0, 'a weight near 0 removes the straight');
    assert.strictEqual(onAnti.pass, true, 'no straight is a pass, not a throw');
    assert.strictEqual(onAnti.calibration.marketSkill.enabled, true);
    assert.strictEqual(onAnti.calibration.marketSkill.NFL.wHat, 0);
    assert.strictEqual(onAnti.calibration.marketSkill.NFL.n, 2000, 'card-date row is not in the fit');
    assert.ok(onAnti.calibration.marketSkill.NFL.w < 0.1);
    const antiNfl = (onAnti.sportCoverage.rows || []).find((row) => row.sport === 'NFL');
    assert.ok(antiNfl && antiNfl.marketSkill && antiNfl.marketSkill.n === 2000);
    // Default-on checks below must not see an inherited OMEGA_V2_MARKET_SKILL=off.
    // Restore the process env in the function's finally, not here.
    delete process.env.OMEGA_V2_MARKET_SKILL;
    assert.strictEqual(v2.shouldLoadMarketSkill({ gradedBoardRows: [] }), false);
    assert.strictEqual(v2.shouldLoadMarketSkill({ fixtureCandidates: [{}] }), false);
    assert.strictEqual(v2.shouldLoadMarketSkill({}), true);

  const indexSrc = fs.readFileSync(path.join(root, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  assert.ok(indexSrc.includes('loadMarketSkillRows'), 'live card grades prior boards');
  assert.ok(indexSrc.includes('market skill timeout'), 'the grade is raced like graded history');
  assert.ok(indexSrc.includes('20000'));

  const mem = new Map();
  let fetches = 0;
  let writes = 0;
  let boardReads = 0;
  const pendingBoard = {
    date: '2026-11-01',
    candidates: [
      {
        sport: 'NBA', market: 'Moneyline', side: 'Away Team',
        matchup: 'Away Team @ Home Team', homeTeam: 'Home Team', awayTeam: 'Away Team',
        pMkt: 0.46, coverProb: 0.7, pCalRaw: 0.25, commenceTime: '2026-11-01T00:00:00Z',
      },
      {
        sport: 'NBA', market: 'Moneyline', side: 'Celtics',
        matchup: 'Celtics @ Knicks', homeTeam: 'Knicks', awayTeam: 'Celtics',
        pMkt: 0.52, coverProb: 0.6, commenceTime: '2026-11-01T02:00:00Z',
      },
    ],
  };
  const finals = [
    {
      awayTeam: 'Away Team', homeTeam: 'Home Team', awayAbbr: 'AWY', homeAbbr: 'HOM',
      awayScore: 90, homeScore: 100, state: 'post', completed: true, statusName: 'STATUS_FINAL',
      startISO: '2026-11-01T00:00:00Z',
    },
    {
      awayTeam: 'Celtics', homeTeam: 'Knicks', awayAbbr: 'BOS', homeAbbr: 'NYK',
      awayScore: 10, homeScore: 12, state: 'in', completed: false, statusName: 'STATUS_IN_PROGRESS',
      startISO: '2026-11-01T02:00:00Z',
    },
  ];
  const loadOpts = {
    // The in-progress game starts at 2026-11-01T02:00Z. Pin now inside 36h
    // of that so a later real clock does not treat it as postponed.
    now: '2026-11-02T12:00:00Z',
    readDates: async () => ['2026-11-01', '2026-11-02', '2026-11-03'],
    readCache: async (date) => mem.get(date) || null,
    writeCache: async (date, body) => { writes += 1; mem.set(date, body); },
    readBoard: async () => { boardReads += 1; return pendingBoard; },
    fetchScores: async () => { fetches += 1; return finals; },
    budgetMs: 5000,
  };
  const pendingRows = await v2.loadMarketSkillRows('2026-11-02', loadOpts);
  assert.strictEqual(writes, 0, 'cache is not written while a game is live');
  assert.strictEqual(pendingRows.length, 0, 'a live slate is not a partial training set');
  assert.ok(fetches >= 1);

  finals[1] = { ...finals[1], state: 'post', completed: true, statusName: 'STATUS_FINAL', awayScore: 101, homeScore: 99 };
  const graded = await v2.loadMarketSkillRows('2026-11-02', loadOpts);
  assert.strictEqual(writes, 1, 'cache is written once every row is final');
  assert.ok(graded.length >= 1);
  const away = graded.find((row) => row.pCal === 0.25);
  assert.ok(away, 'cached pCal is pCalRaw, not coverProb');
  assert.strictEqual(away.y, 0);
  assert.strictEqual(away.sport, 'NBA');
  assert.ok(away.pMkt === 0.46);
  const stored = mem.get('2026-11-01');
  assert.strictEqual(stored.complete, true);
  assert.ok(stored.rows.every((row) => row.pCal !== 0.7));
  assert.ok(stored.rows.some((row) => row.pCal === 0.25));

  const fetchesAfter = fetches;
  const readsAfter = boardReads;
  const again = await v2.loadMarketSkillRows('2026-11-02', loadOpts);
  assert.strictEqual(fetches, fetchesAfter, 'a complete cache is not re-graded');
  assert.strictEqual(boardReads, readsAfter, 'a complete cache does not re-read the board');
  assert.strictEqual(writes, 1);
  assert.strictEqual(again.length, graded.length);

  writes = 0;
  mem.clear();
  const noWriteRows = await v2.loadMarketSkillRows('2026-11-02', { ...loadOpts, noWrite: true });
  assert.strictEqual(writes, 0, 'noWrite does not store the cache');
  assert.ok(noWriteRows.length >= 1, 'noWrite still returns the graded rows');

  fetches = 0;
  const skipped = await v2.loadMarketSkillRows('2026-11-02', {
    ...loadOpts,
    budgetMs: 0,
    readCache: async () => null,
  });
  assert.strictEqual(fetches, 0, 'a spent budget skips the date');
  assert.deepStrictEqual(skipped, []);

  function boardCandidate(side, commence) {
    return {
      sport: 'NBA',
      market: 'Moneyline',
      side,
      matchup: `${side} @ Home Team`,
      homeTeam: 'Home Team',
      awayTeam: side,
      pMkt: 0.46,
      pCalRaw: 0.62,
      commenceTime: commence,
    };
  }
  async function loadScripted(card, dates, boards, gamesByDate, extra = {}) {
    const store = new Map();
    let writes = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const rows = await v2.loadMarketSkillRows(card, {
      now: extra.now,
      budgetMs: extra.budgetMs == null ? 5000 : extra.budgetMs,
      readDates: async () => dates,
      readCache: async (date) => store.get(date) || null,
      writeCache: async (date, body) => { writes += 1; store.set(date, body); },
      readBoard: async (date) => boards[date],
      fetchScores: async (date) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        if (extra.delayMs) await new Promise((resolve) => setTimeout(resolve, extra.delayMs));
        inFlight -= 1;
        return gamesByDate[date] || [];
      },
      gradePick: (_pick, game) => game && game.grade,
      findGame: (pick, games) => (games || []).find((game) => game.side === pick.pick) || null,
    });
    return { rows, store, writes, maxInFlight };
  }

  const oldDate = '2026-11-05';
  const old = await loadScripted('2026-11-07', [oldDate], {
    [oldDate]: {
      date: oldDate,
      candidates: [
        boardCandidate('Alpha', '2026-11-05T00:00:00Z'),
        boardCandidate('Beta', '2026-11-05T02:00:00Z'),
      ],
    },
  }, {
    [oldDate]: [
      { side: 'Alpha', grade: 'win' },
      { side: 'Beta', grade: 'pending' },
    ],
  }, { now: '2026-11-07T15:00:00Z' });
  assert.strictEqual(old.rows.length, 1, 'old date keeps the graded rows');
  assert.strictEqual(old.rows[0].y, 1);
  assert.strictEqual(old.rows[0].date, oldDate);
  assert.strictEqual(old.writes, 1, 'old date writes the cache');
  assert.strictEqual(old.store.get(oldDate).complete, true);
  assert.strictEqual(old.store.get(oldDate).droppedPending, 1, 'pending rows on an old date are dropped');

  const newest = '2026-11-06';
  const live = await loadScripted('2026-11-07', [newest], {
    [newest]: {
      date: newest,
      candidates: [
        boardCandidate('Alpha', '2026-11-06T23:00:00Z'),
        boardCandidate('Beta', '2026-11-06T23:30:00Z'),
      ],
    },
  }, {
    [newest]: [
      { side: 'Alpha', grade: 'win' },
      { side: 'Beta', grade: 'pending' },
    ],
  }, { now: '2026-11-07T12:00:00Z' });
  assert.strictEqual(live.rows.length, 0, 'newest date with a pending recent game is skipped');
  assert.strictEqual(live.writes, 0, 'newest date with a pending recent game is not cached');
  assert.strictEqual(live.store.size, 0);

  const stale = await loadScripted('2026-11-07', [newest], {
    [newest]: {
      date: newest,
      candidates: [
        boardCandidate('Alpha', '2026-11-06T00:00:00Z'),
        boardCandidate('Beta', '2026-11-06T01:00:00Z'),
      ],
    },
  }, {
    [newest]: [
      { side: 'Alpha', grade: 'win' },
      { side: 'Beta', grade: 'pending' },
    ],
  }, { now: '2026-11-07T16:00:00Z' });
  assert.strictEqual(stale.rows.length, 1, 'a pending game more than 36h old is dropped');
  assert.strictEqual(stale.writes, 1);
  assert.strictEqual(stale.store.get(newest).complete, true);
  assert.strictEqual(stale.store.get(newest).droppedPending, 1);

  const sides = Array.from({ length: 10 }, (_, i) => `Side${i}`);
  const mostly = await loadScripted('2026-11-07', [newest], {
    [newest]: {
      date: newest,
      candidates: sides.map((side, i) => boardCandidate(side, i === 9 ? '2026-11-07T04:00:00Z' : '2026-11-06T18:00:00Z')),
    },
  }, {
    [newest]: sides.map((side, i) => ({ side, grade: i === 9 ? 'pending' : 'win' })),
  }, { now: '2026-11-07T12:00:00Z' });
  assert.strictEqual(mostly.rows.length, 9, 'newest date is kept when at least 90% settled');
  assert.strictEqual(mostly.writes, 1);
  assert.strictEqual(mostly.store.get(newest).complete, true);
  assert.strictEqual(mostly.store.get(newest).droppedPending, 1);

  const dates = ['2026-11-03', '2026-11-04', '2026-11-05'];
  const boards = {};
  const games = {};
  for (const date of dates) {
    boards[date] = { date, candidates: [boardCandidate('Alpha', `${date}T00:00:00Z`)] };
    games[date] = [{ side: 'Alpha', grade: 'win' }];
  }
  const parallel = await loadScripted('2026-11-07', dates, boards, games, {
    now: '2026-11-07T16:00:00Z',
    delayMs: 60,
  });
  assert.strictEqual(parallel.maxInFlight, dates.length, 'prior dates are graded in parallel');
  assert.deepStrictEqual(
    [...new Set(parallel.rows.map((row) => row.date))].sort(),
    dates,
    'parallel load returns rows from all dates',
  );

  // ML, spread, and total of one matchup are one game. The scoreboard
  // walk is the slow part of a Saturday board, so a second market must
  // not walk it again. The total is still graded from its own side.
  let lookups = 0;
  const sharedBoard = {
    date: '2026-11-05',
    candidates: [
      boardCandidate('Alpha', '2026-11-05T00:00:00Z'),
      { ...boardCandidate('Alpha', '2026-11-05T00:00:00Z'), market: 'Spread' },
      { ...boardCandidate('Alpha', '2026-11-05T00:00:00Z'), market: 'Total', side: 'Over 6.5' },
      { ...boardCandidate('Alpha', '2026-11-05T18:00:00Z'), market: 'Moneyline' },
    ],
  };
  const shared = await v2.loadMarketSkillRows('2026-11-07', {
    now: '2026-11-07T16:00:00Z',
    budgetMs: 500,
    readDates: async () => ['2026-11-05'],
    readCache: async () => null,
    writeCache: async () => {},
    readBoard: async () => sharedBoard,
    fetchScores: async () => [{ id: 'game' }],
    gradePick: (pick, game) => {
      if (!game) return 'pending';
      return /over/i.test(pick.pick) ? 'loss' : 'win';
    },
    findGame: () => {
      lookups += 1;
      return { id: 'game' };
    },
  });
  assert.strictEqual(lookups, 2, 'one lookup per matchup and start, not per market');
  assert.strictEqual(shared.length, 4, 'every market of a located game is still graded');
  assert.strictEqual(shared.filter((row) => row.y === 0).length, 1, 'the total keeps its own grade');
  assert.strictEqual(shared.filter((row) => row.y === 1).length, 3);

  // A total has no team name. Caching that miss would drop a later side
  // of the same matchup when the matchup string itself did not match.
  let missLookups = 0;
  const missBoard = {
    date: '2026-11-05',
    candidates: [
      { ...boardCandidate('Alpha', '2026-11-05T00:00:00Z'), market: 'Total', side: 'Over 6.5' },
      boardCandidate('Alpha', '2026-11-05T00:00:00Z'),
    ],
  };
  const afterMiss = await v2.loadMarketSkillRows('2026-11-07', {
    now: '2026-11-07T16:00:00Z',
    budgetMs: 500,
    readDates: async () => ['2026-11-05'],
    readCache: async () => null,
    writeCache: async () => {},
    readBoard: async () => missBoard,
    fetchScores: async () => [{ id: 'game' }],
    gradePick: (_pick, game) => (game ? 'win' : 'pending'),
    findGame: (pick) => {
      missLookups += 1;
      return /over/i.test(pick.pick) ? null : { id: 'game' };
    },
  });
  assert.strictEqual(missLookups, 2, 'a miss is not reused for a later side of the same game');
  assert.strictEqual(afterMiss.length, 1, 'the side is graded after the total misses');

  let burns = 0;
  const copies = Array.from({ length: 30 }, () => boardCandidate('Alpha', '2026-11-05T00:00:00Z'));
  const burnStarted = Date.now();
  const burned = await v2.loadMarketSkillRows('2026-11-07', {
    now: '2026-11-07T16:00:00Z',
    budgetMs: 200,
    readDates: async () => ['2026-11-05'],
    readCache: async () => null,
    writeCache: async () => {},
    readBoard: async () => ({ date: '2026-11-05', candidates: copies }),
    fetchScores: async () => [{ side: 'Alpha', grade: 'win' }],
    gradePick: (_pick, game) => game && game.grade,
    findGame: (pick, games) => {
      burns += 1;
      const until = Date.now() + 15;
      while (Date.now() < until) { /* a slow school-name walk */ }
      return (games || []).find((game) => game.side === pick.pick) || null;
    },
  });
  assert.strictEqual(burns, 1, 'thirty markets of one side walk the scoreboard once');
  assert.ok(Date.now() - burnStarted < 200, 'a repeated side stays inside a short budget');
  assert.strictEqual(burned.length, 30);

  console.log('PASS market-skill weight');
  } finally {
    if (savedFlag == null) delete process.env.OMEGA_V2_MARKET_SKILL;
    else process.env.OMEGA_V2_MARKET_SKILL = savedFlag;
  }
}

/**
 * Fake-store correction for the 2026-11-03 card. Sharks +1.5 was listed a
 * day early. The grader (get-results-omega gradeDay) is not modified: the
 * corrected card is what it reads after the results cache is deleted.
 */
async function testFixOmegaCard1103() {
  const {
    handle,
    fixOmegaCard1103,
    isSharksEarly,
    DATE,
    CORRECTION_NOTE,
    CACHE_KEYS,
    BLOB_STORE,
  } = require('../../netlify/functions/fix-omega-card-1103');
  const { americanToDecimal, decimalToAmerican, formatAmerican } = require('../../netlify/functions/lib/omega-vnext/odds_math');
  const grader = require('../../netlify/functions/get-results-omega')._test;

  assert.strictEqual(DATE, '2026-11-03');
  assert.strictEqual(BLOB_STORE, 'edge-picks-omega');
  assert.deepStrictEqual(CACHE_KEYS, [
    'results-omega-cache-v9-kpi1030',
    'results-omega-cache-v10-parlay-legs',
  ]);

  const fnSrc = fs.readFileSync(path.join(root, 'netlify/functions/fix-omega-card-1103.js'), 'utf8');
  const resultsSrc = fs.readFileSync(path.join(root, 'netlify/functions/get-results-omega.js'), 'utf8');
  const trackingSrc = fs.readFileSync(path.join(root, 'netlify/functions/lib/tracking-report.js'), 'utf8');
  const clvSrc = fs.readFileSync(path.join(root, 'netlify/functions/track-clv-omega.js'), 'utf8');
  assert.ok(resultsSrc.includes("const RESULTS_CACHE_KEY = 'results-omega-cache-v9-kpi1030'"));
  assert.ok(trackingSrc.includes("const RESULTS_CACHE_KEY = 'results-omega-cache-v10-parlay-legs'"));
  assert.ok(/readPicksLocated\(/.test(fnSrc));
  assert.ok(/writePicksRaw\(/.test(fnSrc));
  assert.ok(/\.setJSON\(/.test(fnSrc));
  assert.ok(/PICKS_SECRET_KEY/.test(fnSrc));
  assert.ok(!/getStore\(\s*\{/.test(fnSrc), 'fix must not open getStore({ siteID, token })');
  assert.ok(!/storePicks\s*\(/.test(fnSrc), 'fix must not call storePicks');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(fnSrc));
  assert.ok(/for \(const pick of picksData\.picks\)/.test(clvSrc), 'track-clv rebuilds rows from the card picks');
  assert.ok(/merged\.published = !!\(prev\.published \|\| row\.published\)/.test(
    fs.readFileSync(path.join(root, 'netlify/functions/lib/omega-v2/candidate_clv.js'), 'utf8')
  ), 'an old published candidate is kept until the row is removed');

  function memoryStore(seed) {
    const data = Object.assign({}, seed);
    const writes = [];
    const deletes = [];
    return {
      writes,
      deletes,
      data,
      async get(key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      async setJSON(key, value) {
        writes.push(key);
        data[key] = value;
      },
      async delete(key) {
        deletes.push(key);
        delete data[key];
      },
    };
  }

  function leg(extra) {
    return Object.assign({
      sport: 'NHL',
      betType: 'Spread',
      units: '0.25u',
      stakeUsd: 38,
      winProbability: '50.0%',
    }, extra);
  }

  const canucks = leg({
    pick: 'Vancouver Canucks +1.5',
    matchup: 'Vancouver Canucks @ Seattle Kraken',
    odds: '-145',
    book: 'hardrockbet',
    winProbability: '60.0%',
  });
  const oilers = leg({
    pick: 'Edmonton Oilers +1.5',
    matchup: 'Edmonton Oilers @ Calgary Flames',
    odds: '-185',
    book: 'draftkings',
    winProbability: '50.0%',
  });
  const sharks = leg({
    pick: 'San Jose Sharks +1.5',
    pickDisplay: 'San Jose Sharks +1.5',
    matchup: 'San Jose Sharks @ Los Angeles Kings',
    odds: '-180',
    book: 'draftkings',
    winProbability: '70.0%',
  });
  assert.strictEqual(isSharksEarly(sharks), true);
  assert.strictEqual(isSharksEarly(canucks), false);
  assert.strictEqual(isSharksEarly(oilers), false);

  const original = {
    date: DATE,
    dateFormatted: 'Tuesday, November 3, 2026',
    model: 'omega-v2-sharp-2026-11-01-dkhr',
    picks: [
      Object.assign({}, canucks, { units: '0.5u', unitsNum: 0.5, stakeUsd: 75 }),
      Object.assign({}, oilers, { units: '0.75u', unitsNum: 0.75, stakeUsd: 113 }),
      Object.assign({}, sharks, { units: '0.25u', unitsNum: 0.25, stakeUsd: 38, result: 'pending' }),
    ],
    parlayLegs: [{
      type: '3-leg',
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: 38,
      combinedOdds: '+450',
      combinedDecimal: 5.5,
      combinedProb: '21.0%',
      uniqueGames: 3,
      legMarkets: ['Spread', 'Spread', 'Spread'],
      legs: [canucks, oilers, sharks],
    }],
    parlayPool: [canucks, oilers, sharks],
    chosen: [sharks],
    candidateTable: [sharks, { pick: 'San Jose Sharks ML', matchup: 'San Jose Sharks @ Los Angeles Kings', odds: '+140' }],
    straightUnits: 1.5,
    parlayUnits: 0.25,
    totalUnits: 1.75,
    summary: {
      totalPicks: 3,
      totalStraightBets: 3,
      totalUnits: '1.75u',
      sportsCovered: ['NHL'],
      modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
      aplusLocks: 0,
    },
    edgeSummary: 'Tuesday, November 3, 2026: 3 straights cleared a positive calibrated edge.',
  };

  const games = [
    {
      awayTeam: 'Vancouver Canucks',
      homeTeam: 'Seattle Kraken',
      awayScore: 5,
      homeScore: 4,
      state: 'post',
      completed: true,
      statusName: 'Final',
      _sport: 'NHL',
    },
    {
      awayTeam: 'Edmonton Oilers',
      homeTeam: 'Calgary Flames',
      awayScore: 4,
      homeScore: 2,
      state: 'post',
      completed: true,
      statusName: 'Final',
      _sport: 'NHL',
    },
  ];

  const listedEarly = await grader.gradeDay(DATE, original, { games });
  assert.ok(listedEarly.picks.some((pick) => /Sharks \+1\.5/.test(pick.pick)));
  assert.strictEqual(listedEarly.picks.find((pick) => /Sharks \+1\.5/.test(pick.pick)).result, 'pending');
  assert.strictEqual(listedEarly.parlayResult, 'pending');
  assert.ok(listedEarly.pending >= 1);

  const clv = {
    date: DATE,
    picks: [
      { pick: 'Vancouver Canucks +1.5', matchup: canucks.matchup, odds: '-145', result: 'win', profit: 52, clv: 0.01, beatClosing: true },
      { pick: 'San Jose Sharks +1.5', matchup: sharks.matchup, odds: '-180', result: 'pending', profit: 0, clv: 0.02, beatClosing: false },
    ],
    parlayLegs: [
      { pick: 'San Jose Sharks +1.5', matchup: sharks.matchup, odds: '-180', isParlayLeg: true },
      { pick: 'Vancouver Canucks +1.5', matchup: canucks.matchup, odds: '-145', isParlayLeg: true },
    ],
    candidates: [
      { pick: 'San Jose Sharks +1.5', matchup: sharks.matchup, odds: '-180', published: true, result: 'pending' },
      { side: 'San Jose Sharks ML', matchup: sharks.matchup, odds: '+140', clvPct: 1.1 },
    ],
    wins: 1,
    losses: 0,
    pushes: 0,
    totalProfit: 52,
    totalPicks: 2,
    settled: 1,
    pending: 1,
    avgCLV: 0.015,
    totalTracked: 2,
  };
  const cache = {
    cachedAt: 1,
    days: [{
      date: DATE,
      picks: [{ pick: 'San Jose Sharks +1.5', matchup: sharks.matchup, odds: '-180', sport: 'NHL', result: 'pending' }],
      pending: 1,
    }],
  };
  const nov4 = { date: '2026-11-04', picks: [{ pick: 'Stay off 11/4', odds: '-110' }], parlayLegs: [] };

  const store = memoryStore({
    [`picks-${DATE}`]: JSON.parse(JSON.stringify(original)),
    'picks-2026-11-04': nov4,
    'latest-date': DATE,
    'picks-dates': [DATE],
    [`clv-${DATE}`]: clv,
    'clv-candidates-v2/2026-11-03': {
      candidates: [{ pick: 'San Jose Sharks +1.5', matchup: sharks.matchup, odds: '-180', result: 'pending', published: true }],
    },
    [CACHE_KEYS[0]]: JSON.parse(JSON.stringify(cache)),
    [CACHE_KEYS[1]]: JSON.parse(JSON.stringify(cache)),
  });
  const snapshot = JSON.parse(JSON.stringify(store.data[`picks-${DATE}`]));

  const dry = await fixOmegaCard1103({ date: DATE, store });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(dry.alreadyCorrect, false);
  assert.strictEqual(store.writes.length, 0);
  assert.strictEqual(store.deletes.length, 0);
  assert.deepStrictEqual(store.data[`picks-${DATE}`], snapshot, 'dry run must not mutate the stored card');
  assert.ok(dry.cacheKeys.includes(CACHE_KEYS[0]) && dry.cacheKeys.includes(CACHE_KEYS[1]));
  assert.ok(dry.settlement.some((row) => row.key === `clv-${DATE}` && row.removed >= 2));
  assert.strictEqual(dry.after.parlay.type, '2-leg');
  assert.strictEqual(dry.after.parlay.units, '0.25u');
  assert.strictEqual(dry.after.parlay.stakeUsd, 38);
  assert.strictEqual(dry.before.parlay.type, '3-leg');
  assert.ok(dry.before.picks.some((pick) => /Sharks/.test(pick.pick)));
  assert.ok(!dry.after.picks.some((pick) => /Sharks/.test(pick.pick)));

  const asString = await fixOmegaCard1103({ date: DATE, dryRun: 'false', store });
  assert.strictEqual(asString.dryRun, true);
  assert.strictEqual(store.writes.length, 0);

  const savedKey = process.env.PICKS_SECRET_KEY;
  process.env.PICKS_SECRET_KEY = 'test-secret';
  const denied = await handle({ httpMethod: 'POST', queryStringParameters: {}, body: JSON.stringify({ date: DATE, dryRun: false }) }, { store });
  assert.strictEqual(denied.statusCode, 401);
  const badDate = await handle({
    httpMethod: 'POST',
    queryStringParameters: { key: 'test-secret' },
    body: JSON.stringify({ date: '2026-11-04', dryRun: true }),
  }, { store });
  assert.strictEqual(badDate.statusCode, 400);
  const wrongMethod = await handle({ httpMethod: 'GET', queryStringParameters: { key: 'test-secret' } }, { store });
  assert.strictEqual(wrongMethod.statusCode, 405);
  if (savedKey == null) delete process.env.PICKS_SECRET_KEY;
  else process.env.PICKS_SECRET_KEY = savedKey;
  assert.strictEqual(store.writes.length, 0);

  const live = await fixOmegaCard1103({ date: DATE, dryRun: false, store });
  assert.strictEqual(live.dryRun, false);
  assert.strictEqual(live.wrote, true);
  assert.strictEqual(live.alreadyCorrect, false);
  assert.ok(store.writes.includes(`picks-${DATE}`));
  assert.ok(store.writes.includes(`clv-${DATE}`));
  assert.ok(store.writes.includes('clv-candidates-v2/2026-11-03'));
  assert.deepStrictEqual(store.deletes.slice().sort(), CACHE_KEYS.slice().sort());
  assert.strictEqual(store.data['picks-2026-11-04'], nov4);
  assert.strictEqual(store.data['latest-date'], DATE);
  assert.deepStrictEqual(store.data['picks-dates'], [DATE]);
  assert.strictEqual(store.data[CACHE_KEYS[0]], undefined);
  assert.strictEqual(store.data[CACHE_KEYS[1]], undefined);

  const written = store.data[`picks-${DATE}`];
  const product = americanToDecimal(-145) * americanToDecimal(-185);
  const ticket = written.parlayLegs[0];
  assert.strictEqual(ticket.type, '2-leg');
  assert.strictEqual(ticket.units, '0.25u');
  assert.strictEqual(ticket.stakeUsd, 38);
  assert.strictEqual(ticket.combinedDecimal, +product.toFixed(4));
  assert.strictEqual(ticket.combinedDecimal, 2.603);
  assert.strictEqual(ticket.combinedOdds, formatAmerican(decimalToAmerican(ticket.combinedDecimal)));
  assert.strictEqual(ticket.combinedOdds, '+160');
  assert.strictEqual(ticket.combinedProb, '30.0%');
  assert.strictEqual(ticket.uniqueGames, 2);
  assert.deepStrictEqual(ticket.legMarkets, ['Spread', 'Spread']);
  assert.deepStrictEqual(ticket.legs.map((row) => row.pick), [canucks.pick, oilers.pick]);
  assert.deepStrictEqual(written.picks.map((row) => row.pick), [canucks.pick, oilers.pick]);
  assert.strictEqual(written.straightUnits, 1.25);
  assert.strictEqual(written.parlayUnits, 0.25);
  assert.strictEqual(written.totalUnits, 1.5);
  assert.strictEqual(written.summary.totalPicks, 2);
  assert.strictEqual(written.summary.totalStraightBets, 2);
  assert.strictEqual(written.summary.totalUnits, '1.5u');
  assert.deepStrictEqual(written.summary.sportsCovered, ['NHL']);
  assert.strictEqual(written.summary.modelVersion, original.summary.modelVersion);
  assert.strictEqual(written.summary.aplusLocks, 0);
  assert.strictEqual(written.correctionNote, CORRECTION_NOTE);
  assert.ok(/2 straights/.test(written.edgeSummary));
  assert.ok(!written.parlayPool.some((row) => /Sharks \+1\.5/.test(row.pick)));
  assert.ok(!written.chosen.some(isSharksEarly));
  assert.ok(written.candidateTable.some((row) => row.pick === 'San Jose Sharks ML'));
  assert.ok(!written.candidateTable.some(isSharksEarly));
  assert.strictEqual(written.picks[0].units, '0.5u');
  assert.strictEqual(written.picks[0].stakeUsd, 75);
  assert.strictEqual(written.picks[1].odds, '-185');

  const clvAfter = store.data[`clv-${DATE}`];
  assert.ok(!clvAfter.picks.some(isSharksEarly));
  assert.ok(!clvAfter.parlayLegs.some(isSharksEarly));
  assert.ok(!clvAfter.candidates.some(isSharksEarly));
  assert.ok(clvAfter.candidates.some((row) => row.side === 'San Jose Sharks ML'));
  assert.strictEqual(clvAfter.totalPicks, 1);
  assert.strictEqual(clvAfter.wins, 1);
  assert.strictEqual(clvAfter.pending, 0);
  assert.strictEqual(clvAfter.totalProfit, 52);
  const closes = store.data['clv-candidates-v2/2026-11-03'];
  assert.deepStrictEqual(closes.candidates, []);

  const graded = await grader.gradeDay(DATE, written, { games });
  const straights = graded.picks.filter((pick) => pick.sport !== 'PARLAY');
  assert.strictEqual(straights.length, 2);
  assert.ok(straights.every((pick) => pick.result === 'win'));
  assert.strictEqual(straights.find((pick) => /Canucks/.test(pick.pick)).score, '5-4');
  assert.strictEqual(straights.find((pick) => /Oilers/.test(pick.pick)).result, 'win');
  assert.strictEqual(graded.wins, 2);
  assert.strictEqual(graded.losses, 0);
  assert.strictEqual(graded.pending, 0);
  const parlay = graded.picks.find((pick) => pick.sport === 'PARLAY');
  assert.strictEqual(parlay.result, 'win');
  assert.strictEqual(parlay.units, '0.25u');
  const stake = grader.wholeUp(0.25 * grader.DOLLAR_PER_UNIT);
  assert.strictEqual(stake, 38);
  assert.strictEqual(parlay.stakeDollars, 38);
  // wholeUp rounds the stake and the win up to the next dollar (ceil, dust guard).
  const profit = grader.wholeUp(stake * (product - 1));
  assert.strictEqual(profit, 61);
  assert.strictEqual(parlay.profit, profit);
  assert.ok(!graded.picks.some((pick) => /Shark/i.test(pick.pick)));

  const writesAfter = store.writes.length;
  const deletesAfter = store.deletes.length;
  const again = await fixOmegaCard1103({ date: DATE, dryRun: false, store });
  assert.strictEqual(again.wrote, false);
  assert.strictEqual(again.alreadyCorrect, true);
  assert.deepStrictEqual(again.before, {});
  assert.deepStrictEqual(again.after, {});
  assert.strictEqual(store.writes.length, writesAfter);
  assert.strictEqual(store.deletes.length, deletesAfter);

  const corrected = JSON.parse(JSON.stringify(written));
  const stale = memoryStore({
    [`picks-${DATE}`]: corrected,
    [CACHE_KEYS[0]]: JSON.parse(JSON.stringify(cache)),
  });
  const bustOnly = await fixOmegaCard1103({ date: DATE, dryRun: false, store: stale });
  assert.strictEqual(bustOnly.wrote, true);
  assert.ok(!stale.writes.includes(`picks-${DATE}`));
  assert.deepStrictEqual(stale.deletes, [CACHE_KEYS[0]]);
  assert.strictEqual(stale.data[CACHE_KEYS[0]], undefined);
  assert.strictEqual(stale.data[`picks-${DATE}`].correctionNote, CORRECTION_NOTE);

  let refused = false;
  try {
    await fixOmegaCard1103({ date: '2026-11-04', dryRun: false, store });
  } catch (err) {
    refused = err.statusCode === 400;
  }
  assert.ok(refused, 'other dates are refused');
  assert.strictEqual(store.data['picks-2026-11-04'], nov4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
