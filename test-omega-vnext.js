'use strict';
/** Smoke test for omega-vnext — no network required. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const math = require(path.join(root, 'odds_math'));
const calibrate = require(path.join(root, 'calibrate'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));
const clv = require(path.join(root, 'clv_log'));
const edge = require(path.join(root, 'edge'));
const mlb = require(path.join(root, 'sports/mlb'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const nba = require(path.join(root, 'sports/nba'));
const nhl = require(path.join(root, 'sports/nhl'));
const { MODEL_VERSION } = require(path.join(root, 'index'));

assert.strictEqual(config.MODEL_VERSION, 'v12.1.0-omega-vnext-linemove');
assert.strictEqual(config.STRAIGHT_UNIT_BUDGET, 3.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.MAX_STRAIGHT_UNITS_PER_PICK, 1.25);
assert.strictEqual(MODEL_VERSION, config.MODEL_VERSION);
assert.strictEqual(config.DAILY_UNIT_CAP, 4.0);
assert.strictEqual(config.LEAN_PAD, false);
assert.ok(math.americanToImplied(-110) > 0.52 && math.americanToImplied(-110) < 0.53);
assert.ok(Math.abs(math.evAtOdds(0.55, -110) - (0.55 * (100/110 + 1) - 1)) < 1e-9);

// ML label helper
assert.strictEqual(math.formatMoneylinePick('Iowa Hawkeyes', 'Moneyline'), 'Iowa Hawkeyes ML');
assert.strictEqual(math.formatMoneylinePick('Iowa Hawkeyes ML', 'Moneyline'), 'Iowa Hawkeyes ML');
assert.strictEqual(math.formatMoneylinePick('Giants +6.5', 'Spread'), 'Giants +6.5');
assert.strictEqual(math.formatMoneylinePick('Over 45.5', 'Total'), 'Over 45.5');
assert.strictEqual(select.formatMoneylinePick('Mississippi State Bulldogs', 'Moneyline'), 'Mississippi State Bulldogs ML');

// Sort: A+ before A before B, then higher units
const sorted = math.sortByGradeThenUnits([
  { rating: 'b', units: '1.5u', pick: 'low' },
  { rating: 'a', units: '1u', pick: 'midA' },
  { rating: 'aplus', units: '1u', pick: 'top' },
  { rating: 'a', units: '1.5u', pick: 'midHigh' },
]);
assert.deepStrictEqual(sorted.map(p => p.pick), ['top', 'midHigh', 'midA', 'low']);

const pCal = calibrate.shrinkTowardSharp(0.60, 0.52, 'Spread');
assert.ok(pCal > 0.52 && pCal < 0.60);
// isotonic must compress toward band — not inflate just-above-hi values
assert.ok(calibrate.isotonicClip(0.60) <= 0.60, 'isotonic must not inflate at hi');
assert.ok(calibrate.isotonicClip(0.72) < 0.65, 'isotonic must pull 0.72 down');
const edgeProbe = edge.attachEv({ coverProb: calibrate.isotonicClip(calibrate.shrinkTowardSharp(0.725, 0.475, 'Spread')), odds: 105, fair_sharp_p: 0.475 });
assert.ok(edgeProbe.edgePct < 0.12, 'calibrated edge vs sharp should be modest, got '+edgeProbe.edgePct);


// Edge display: model edge after shrink vs fair_sharp (not predictedClv, not raw coverProb)
const withEv = edge.attachEv({
  coverProb: 0.55,
  odds: -110,
  fair_sharp_p: 0.52,
  predictedClv: 12.5, // must NOT become edgePct
});
assert.ok(Math.abs(withEv.edgePct - 0.03) < 1e-6, 'edgePct should be coverProb - fair_sharp');
assert.ok(withEv.ev > 0);
assert.ok(withEv.edgePctDisplay === '3.0%');
assert.ok(withEv.edgePct !== withEv.predictedClv);

const synth = [
  { sport: 'NFL', matchup: 'A @ B', side: 'B -3', market: 'Spread', odds: -110, coverProb: 0.56, ev: 0.05, edgePct: 0.04, predictedClv: 2.5, liquid: true, uncertainty: 0.1, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'B', awayTeam: 'A' },
  { sport: 'MLB', matchup: 'C @ D', side: 'Under 8.5', market: 'Total', odds: -105, coverProb: 0.55, ev: 0.045, edgePct: 0.035, predictedClv: 1.2, liquid: true, uncertainty: 0.12, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'D', awayTeam: 'C' },
  { sport: 'NCAAF', matchup: 'E @ F', side: 'F -7', market: 'Spread', odds: -110, coverProb: 0.54, ev: 0.04, edgePct: 0.03, predictedClv: 0.8, liquid: true, uncertainty: 0.2, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'F', awayTeam: 'E' },
  { sport: 'NFL', matchup: 'G @ H', side: 'Over 45.5', market: 'Total', odds: -110, coverProb: 0.53, ev: 0.035, edgePct: 0.025, predictedClv: 0.5, liquid: true, uncertainty: 0.15, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'H', awayTeam: 'G' },
  { sport: 'NCAAF', matchup: 'I @ J', side: 'Iowa Hawkeyes', market: 'Moneyline', odds: 185, coverProb: 0.48, ev: 0.08, edgePct: 0.05, predictedClv: 1.0, liquid: true, uncertainty: 0.18, commenceTime: new Date(Date.now() + 864e5).toISOString(), homeTeam: 'J', awayTeam: 'I' },
];

const { yesPool, rejected } = gates.applyGates(synth);
assert.ok(yesPool.length >= 3);
assert.ok(Array.isArray(rejected));

const picked = select.selectStraights(yesPool, 3);
assert.ok(picked.length <= 3);
assert.ok(picked.length >= 1);

const picks = picked.map(c => select.toPickObject(c, { modelVersion: MODEL_VERSION }));
assert.ok('whatLoses' in picks[0] && 'dataVerified' in picks[0] && 'clvExpectation' in picks[0]);
assert.ok(/%$/.test(picks[0].edgePct), 'edgePct display is percent string');
assert.ok(!/12\.5/.test(picks[0].edgePct), 'edge must not be predictedClv');

// ML label on moneyline pick objects
const mlPick = select.toPickObject({
  sport: 'NCAAF', matchup: 'I @ J', side: 'Iowa Hawkeyes', market: 'Moneyline',
  odds: 185, oddsStr: '+185', coverProb: 0.48, ev: 0.08, edgePct: 0.05,
  homeTeam: 'J', awayTeam: 'I',
}, { modelVersion: MODEL_VERSION });
assert.strictEqual(mlPick.pick, 'Iowa Hawkeyes ML');
assert.strictEqual(mlPick.pickDisplay, 'Iowa Hawkeyes ML');

const withClv = clv.attachClvFields(picks);
assert.ok(withClv[0].modelVersion === MODEL_VERSION);

const parlays = parlay.optimizeParlay(yesPool, picks);
assert.ok(Array.isArray(parlays));
if (parlays.length) {
  assert.ok(parlays[0].legs.length >= 2 && parlays[0].legs.length <= 3);
  assert.ok(parlays[0].type.includes('parlay'));
}

// Daily unit structure: straights ≤3.5u + fixed 0.5u parlay ≤ 4.0u MAX
{
  const fat = [
    { pick: 'A', rating: 'aplus', units: '1.5u', confidence: 90 },
    { pick: 'B', rating: 'a', units: '1.5u', confidence: 82 },
    { pick: 'C', rating: 'aminus', units: '1.5u', confidence: 75 },
  ];
  const fatParlay = [{ units: '1.5u', legs: [] }];
  const capped = select.applyDailyUnitCap(fat, fatParlay);
  const straightU = capped.picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const parlayU = capped.parlayLegs.reduce((s, pl) => s + parseFloat(pl.units), 0);
  const total = straightU + parlayU;
  assert.ok(straightU <= 3.5 + 1e-9, `straight budget=${straightU}`);
  assert.strictEqual(parlayU, 0.5, 'parlay must be fixed 0.5u');
  assert.ok(total <= 4.0 + 1e-9, `cap total=${total}`);
  assert.strictEqual(capped.picks[0].rating, 'aplus');
}

// Grade remap: 1.0u → A (not A+); 1.25u → A+
assert.strictEqual(math.unitsToRating(1.0), 'a');
assert.strictEqual(math.unitsToRating(1.24), 'a');
assert.strictEqual(math.unitsToRating(1.25), 'aplus');
assert.strictEqual(math.unitsToRating(0.75), 'aminus');

// Day-scope: same ET calendar day only
{
  assert.strictEqual(math.etCalendarDate('2026-09-22T23:30:00Z'), '2026-09-22'); // evening ET still Tue
  assert.strictEqual(math.etCalendarDate('2026-09-23T03:30:00Z'), '2026-09-22'); // late night ET = Tue
  assert.strictEqual(math.etCalendarDate('2026-09-27T17:00:00Z'), '2026-09-27'); // Sun NFL
  assert.ok(math.isSameEtDay('2026-09-22T18:00:00Z', '2026-09-22'));
  assert.ok(!math.isSameEtDay('2026-09-26T19:00:00Z', '2026-09-22'), 'Sat CFB must not pass Tue card');
  assert.ok(!math.isSameEtDay('2026-09-27T17:00:00Z', '2026-09-22'), 'Sun NFL must not pass Tue card');

  const tue = '2026-09-22';
  const mixed = [
    { sport: 'MLB', matchup: 'A @ B', side: 'B -1.5', market: 'Spread', odds: -110, coverProb: 0.56, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: '2026-09-22T23:05:00Z', homeTeam: 'B', awayTeam: 'A' },
    { sport: 'NCAAF', matchup: 'C @ D', side: 'D -7', market: 'Spread', odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: '2026-09-26T19:00:00Z', homeTeam: 'D', awayTeam: 'C' },
    { sport: 'NFL', matchup: 'E @ F', side: 'F -3', market: 'Spread', odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: '2026-09-27T17:00:00Z', homeTeam: 'F', awayTeam: 'E' },
  ];
  const gated = gates.applyGates(mixed, { cardDate: tue });
  assert.strictEqual(gated.yesPool.length, 1, 'only Tue MLB should pass');
  assert.strictEqual(gated.yesPool[0].sport, 'MLB');
  assert.ok(gated.rejected.some(r => r.rejectReason === 'not-same-et-day'));

  // ingest filter helper
  const { filterEventsSameEtDay } = require(path.join(root, 'ingest'));
  const filtered = filterEventsSameEtDay([
    { id: 1, commence_time: '2026-09-22T23:05:00Z' },
    { id: 2, commence_time: '2026-09-26T19:00:00Z' },
  ], tue);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 1);
}

// Fixed 0.5u parlay stake
{
  const pool = [
    { sport: 'MLB', matchup: 'A @ B', side: 'Under 8.5', market: 'Total', odds: -110, coverProb: 0.56, ev: 0.05, edgePct: 0.04, commenceTime: '2026-09-22T23:05:00Z', homeTeam: 'B', awayTeam: 'A' },
    { sport: 'MLB', matchup: 'C @ D', side: 'Over 9.0', market: 'Total', odds: -105, coverProb: 0.55, ev: 0.045, edgePct: 0.035, commenceTime: '2026-09-22T23:10:00Z', homeTeam: 'D', awayTeam: 'C' },
    { sport: 'MLB', matchup: 'E @ F', side: 'F -1.5', market: 'Spread', odds: -110, coverProb: 0.54, ev: 0.04, edgePct: 0.03, commenceTime: '2026-09-22T23:15:00Z', homeTeam: 'F', awayTeam: 'E' },
  ];
  const pls = parlay.optimizeParlay(pool, [], { cardDate: '2026-09-22' });
  assert.ok(pls.length >= 1, 'parlay should form from same-day pool');
  assert.strictEqual(parseFloat(pls[0].units), 0.5);
  // Weekend legs must be excluded even if in pool
  const withWeekend = pool.concat([
    { sport: 'NFL', matchup: 'G @ H', side: 'H -3', market: 'Spread', odds: -110, coverProb: 0.60, ev: 0.10, edgePct: 0.08, commenceTime: '2026-09-27T17:00:00Z', homeTeam: 'H', awayTeam: 'G' },
  ]);
  const pls2 = parlay.optimizeParlay(withWeekend, [], { cardDate: '2026-09-22' });
  if (pls2.length) {
    for (const leg of pls2[0].legs) {
      assert.ok(math.isSameEtDay(leg.commenceTime, '2026-09-22'), `parlay leg off-day: ${leg.commenceTime}`);
    }
  }
}

assert.deepStrictEqual(nba.project({}), []);
assert.deepStrictEqual(nhl.project({}), []);
assert.strictEqual(typeof mlb.project, 'function');
assert.strictEqual(typeof nfl.project, 'function');
assert.strictEqual(typeof cfb.project, 'function');

const narrate = require(path.join(root, 'narrate'));
const narrateSrc = require('fs').readFileSync(path.join(root, 'narrate.js'), 'utf8');
assert.ok(narrateSrc.includes("claude-sonnet-4-6"), 'narrate must use claude-sonnet-4-6');
assert.ok(!narrateSrc.includes("claude-sonnet-4-20250514"), 'old sonnet date-id must be gone');
const fb = narrate.buildFallbackNarrative({ pick: 'Under 45.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Total', odds: '-105' });
assert.ok(fb.includes('WeBetAI'));
assert.ok(!/clears Omega vNext gates|predicted CLV/i.test(fb));
const replaced = narrate.ensureNarrative({
  pick: 'Lakers ML', matchup: 'A @ B', sport: 'NBA', odds: '+120',
  coreReasoning: 'clears Omega vNext gates: calibrated cover 67%, predicted CLV 3¢. Method: sport-hybrid.',
});
assert.ok(!/clears Omega vNext gates/i.test(replaced.coreReasoning));
assert.ok(replaced.coreReasoning.length > 40);

// Parlay legs should expose coreReasoning field for public cards
if (parlays.length) {
  assert.ok('coreReasoning' in parlays[0].legs[0]);
}

// Parlay legs carry rating/confidence for badge chrome
if (parlays.length) {
  assert.ok(parlays[0].legs[0].rating, 'parlay leg must have rating');
  assert.ok(parlays[0].legs[0].confidence != null, 'parlay leg must have confidence');
}

// UI file checks
const html = require('fs').readFileSync(path.join(__dirname, 'daily-omega/index.html'), 'utf8');
assert.ok(!/Unlock — 1 WeBit/.test(html));
assert.ok(!/graded with the slip/i.test(html));
assert.ok(!/Sharp Depth \(premium gate/.test(html));
assert.ok(/Daily Lock Parlay/.test(html));
assert.ok(/Daily Lock - Top 3 Straight Picks/.test(html));
assert.ok(/Daily Lock - Top 3 Leg Parlay/.test(html));
assert.ok(/resolveRatingKey/.test(html));
assert.ok(!/apiParlay\.correlationNote/.test(html));
assert.ok(/Bet Slip — Summary/.test(html));
assert.ok(/ensureMlLabel/.test(html));
assert.ok(!/Optimized \$\{legCount\} Pick Parlay/.test(html));

console.log('PASS test-omega-vnext', {
  MODEL_VERSION,
  DAILY_UNIT_CAP: config.DAILY_UNIT_CAP,
  STRAIGHT_UNIT_BUDGET: config.STRAIGHT_UNIT_BUDGET,
  PARLAY_FIXED_UNITS: config.PARLAY_FIXED_UNITS,
  yesPool: yesPool.length,
  straights: picks.length,
  parlayLegs: parlays.length ? parlays[0].legs.length : 0,
  edgeFormula: 'coverProb - fair_sharp_p (fallback: vs book implied)',
});
