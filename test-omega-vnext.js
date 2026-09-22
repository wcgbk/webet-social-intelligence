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

assert.strictEqual(config.MODEL_VERSION, 'v12.3.4-omega-vnext-replay-asof');
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


// Quality grades from edge, not units / not coverProb
assert.strictEqual(math.qualityToRating(0.053, 0, 0.1), 'aplus');
assert.strictEqual(math.qualityToRating(0.047, 0, 0.1), 'a');
assert.strictEqual(math.qualityToRating(0.038, 0, 0.1), 'a');
assert.ok(math.qualityScore(0.053, 0, 0.1) > math.qualityScore(0.047, 0, 0.1));

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

  // Kickoff must still be pregame. A fixed Sep 22 night tip is already
  // behind Date.now() once that evening passes, so use a few hours ahead
  // and the ET date of that tip. Off-days stay later in the week.
  const tueKick = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const tue = math.etCalendarDate(tueKick);
  const offSat = new Date(Date.now() + 4 * 864e5).toISOString();
  const offSun = new Date(Date.now() + 5 * 864e5).toISOString();
  const mixed = [
    { sport: 'MLB', matchup: 'A @ B', side: 'B -1.5', market: 'Spread', odds: -110, coverProb: 0.56, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: tueKick, homeTeam: 'B', awayTeam: 'A' },
    { sport: 'NCAAF', matchup: 'C @ D', side: 'D -7', market: 'Spread', odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: offSat, homeTeam: 'D', awayTeam: 'C' },
    { sport: 'NFL', matchup: 'E @ F', side: 'F -3', market: 'Spread', odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.04, predictedClv: 2, liquid: true, commenceTime: offSun, homeTeam: 'F', awayTeam: 'E' },
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
assert.ok(/4–6 sentence journalistic blurbs/.test(narrateSrc), 'header states 4-6 sentence blurbs');
assert.ok(/4-6 sentence/.test(narrateSrc), 'prompt asks for 4-6 sentence straights');
assert.ok(/3-5 sentence/.test(narrateSrc), 'prompt asks for 3-5 sentence legs and sections');
assert.ok(!/2-4 sentence/.test(narrateSrc), 'stubby 2-4 sentence parlay rule must be gone');
assert.ok(!/1-2 sentence/.test(narrateSrc), 'thin 1-2 sentence edge/insights rule must be gone');
assert.ok(/NARRATIVE_MAX_TOKENS = 5800/.test(narrateSrc), 'max_tokens raised into 5500-6000');
assert.ok(/max_tokens: NARRATIVE_MAX_TOKENS/.test(narrateSrc));
assert.ok(narrateSrc.includes('JSON.stringify(lockedStraights || [], null, 2)'), 'context fields must reach Claude');
assert.ok(narrateSrc.includes('JSON.stringify(lockedLegs || [], null, 2)'));
assert.ok(!narrateSrc.includes('_contextEv, _contextCover, ...r'), 'callClaudeOnce must not strip context');
assert.ok(/ESPN/.test(narrateSrc) && /handicap/i.test(narrateSrc));
assert.ok(/No em dashes/.test(narrateSrc));

function countSentences(text) {
  const masked = String(text || '').replace(/(\d)\.(\d)/g, '$1<$2');
  return masked.split(/[.!?]+/).map(s => s.trim()).filter(Boolean).length;
}
const JARGON = /\bthe model\b|Kelly|coverProb|\bCLV\b|\bEV%|ORtg|DVOA|\bFIP\b|xFIP|\bATS\b|clears Omega vNext gates|predicted CLV|form and injuries line up/i;
function assertDeskCopy(text, label, minSentences, maxSentences) {
  assert.ok(text && text.includes('WeBetAI'), `${label} brands WeBetAI`);
  assert.ok(!JARGON.test(text), `${label} leaked jargon: ${text}`);
  assert.ok(!text.includes('—'), `${label} uses an em dash`);
  const n = countSentences(text);
  assert.ok(n >= minSentences && n <= maxSentences, `${label} has ${n} sentences, want ${minSentences}-${maxSentences}: ${text}`);
}

const fb = narrate.buildFallbackNarrative({ pick: 'Under 45.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Total', odds: '-105', units: '1u', rating: 'a', edgePct: '4.2%' });
assertDeskCopy(fb, 'total fallback', 4, 6);
assert.ok(/Under 45\.5/.test(fb) && /DAL @ NYG/.test(fb));
assert.ok(/little high/i.test(fb), 'total fallback translates the number into English');
assert.ok(/under/i.test(fb));

const fbDog = narrate.buildFallbackNarrative({ pick: 'Giants +6.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Spread', odds: '-110', units: '0.75u', steamAgainst: true, edgePct: 0.028 });
assertDeskCopy(fbDog, 'dog fallback', 4, 6);
assert.ok(/Giants \+6\.5/.test(fbDog));
assert.ok(/points/i.test(fbDog));
assert.ok(/leaning the other way/i.test(fbDog), 'steam against is translated, not dumped as cents');

const fbMl = narrate.buildFallbackNarrative({ pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline', odds: '+120', edgePct: '5.4%', steamToward: true });
assertDeskCopy(fbMl, 'ml fallback', 4, 6);
assert.ok(/\+120/.test(fbMl) && /Yankees ML/.test(fbMl));
assert.ok(/strong/i.test(fbMl) && /leaning this way/i.test(fbMl));

const replaced = narrate.ensureNarrative({
  pick: 'Lakers ML', matchup: 'A @ B', sport: 'NBA', odds: '+120',
  coreReasoning: 'clears Omega vNext gates: calibrated cover 67%, predicted CLV 3¢. Method: sport-hybrid.',
});
assert.ok(!/clears Omega vNext gates/i.test(replaced.coreReasoning));
assert.ok(replaced.coreReasoning.length > 40);
assertDeskCopy(replaced.coreReasoning, 'replaced template', 4, 6);

const extra = narrate.ensureExtraFields({ pick: 'Under 45.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Total', odds: '-105', edgePct: '4.0%' });
assert.ok(!/opposite outcome|monitor into close|Model-grounded/i.test(`${extra.whatLoses} ${extra.clvExpectation} ${extra.dataVerified}`));
assert.ok(/Under 45\.5/.test(extra.whatLoses) && /DAL @ NYG/.test(extra.whatLoses));
assert.ok(/closing number|close/i.test(extra.clvExpectation));
assert.ok(!/\bCLV\b|Kelly|coverProb/i.test(extra.clvExpectation));
assert.ok(/WeBetAI/.test(extra.dataVerified) && !/the model/i.test(extra.dataVerified));
const kept = narrate.ensureExtraFields({ ...extra, whatLoses: extra.whatLoses, clvExpectation: extra.clvExpectation, dataVerified: extra.dataVerified });
assert.strictEqual(kept.whatLoses, extra.whatLoses);

const row = narrate.lockedRow({
  sport: 'NFL', matchup: 'DAL @ NYG', pick: 'Under 45.5', betType: 'Total',
  odds: '-105', units: '1u', rating: 'a', ev: '4.2%', coverProb: '55%',
  edgePct: '4.2%', steamToward: true, lineMove: { oddsMoveCents: -12, lineMovePts: -0.5 },
}, 0, 'straight');
assert.strictEqual(row._contextEv, '4.2%');
assert.strictEqual(row._contextCover, '55%');
assert.strictEqual(row.edgeBand, 'solid');
assert.strictEqual(row.rating, 'A');
assert.strictEqual(row.grade, 'A');
assert.ok(/toward/i.test(row.steamHint));
assert.ok(!('lineMove' in row), 'raw line-move cents must not be sent to Claude');
assert.strictEqual(narrate.edgeBandFrom({ edgePct: '5.0%' }), 'strong');
assert.strictEqual(narrate.edgeBandFrom({ edgePct: 0.05 }), 'strong');
assert.strictEqual(narrate.edgeBandFrom({ edgePct: '3.5%' }), 'solid');
assert.strictEqual(narrate.edgeBandFrom({ ev: '2.4%' }), 'modest');
assert.strictEqual(narrate.edgeBandFrom({ edgePct: '0.0%', ev: '6%' }), null);
assert.strictEqual(narrate.steamHintFrom({ steamAgainst: true }), 'line has moved against this side, and the price may still be the value');
assert.strictEqual(narrate.steamHintFrom({ lineMove: { steamToward: true } }), 'line has moved toward this side');
assert.ok(/held/i.test(narrate.steamHintFrom({ lineMove: { lineMovePts: 0, oddsMoveCents: 0 } }) || ''));

const emptyCopy = narrate.buildCardFallbackCopy({ picks: [], dateFormatted: 'Tuesday, September 22' });
assertDeskCopy(emptyCopy.edgeSummary, 'empty edge', 3, 5);
assertDeskCopy(emptyCopy.insights, 'empty insights', 3, 5);
assert.ok(/starter|quarterback|weather/i.test(emptyCopy.insights));
const cardCopy = narrate.buildCardFallbackCopy({
  picks: [
    { pick: 'Under 45.5', sport: 'NFL', matchup: 'DAL @ NYG', edgePct: '5.5%' },
    { pick: 'Yankees ML', sport: 'MLB', matchup: 'BOS @ NYY', edgePct: '3.0%' },
  ],
  dateFormatted: 'Tuesday, September 22',
});
assertDeskCopy(cardCopy.edgeSummary, 'card edge', 3, 5);
assertDeskCopy(cardCopy.insights, 'card insights', 3, 5);
assert.ok(/Under 45\.5/.test(cardCopy.edgeSummary) && /Yankees ML/.test(cardCopy.edgeSummary));
assert.ok(/NFL/.test(cardCopy.insights) && /MLB/.test(cardCopy.insights));
assert.ok(/starter|quarterback|weather/i.test(cardCopy.insights));

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

// C2: verify replace/backfill grades are quality/edge, not units → rating.
{
  const verifySrc = require('fs').readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  assert.ok(!/rating:\s*unitsToRating\s*\(/.test(verifySrc), 'no rating: unitsToRating(...) write');
  assert.ok(!/\.rating\s*=\s*unitsToRating\s*\(/.test(verifySrc), 'no .rating = unitsToRating(...) write');
  assert.ok(!/unitsToRating\s*\(\s*cappedKellyUnits\s*\(/.test(verifySrc));
  assert.ok(!/unitsToRating\s*\(\s*u\s*\)/.test(verifySrc));
  assert.ok(!/confFromUnits\s*\(/.test(verifySrc));
  assert.ok(!/confidence:\s*u\s*>=/.test(verifySrc), 'confidence must not be a letter derived from units');
  assert.ok(/toPickObject/.test(verifySrc));
  assert.ok(/buildQualityReplacement/.test(verifySrc));
  assert.ok(/require\('\.\/lib\/omega-vnext\/select'\)/.test(verifySrc));

  const verify = require('./netlify/functions/verify-picks-omega');
  // candidateTable shape: edge fraction lives on `edge`, stake would be a low units grade.
  const highEdgeLowUnits = verify.buildQualityReplacement({
    sport: 'NFL', matchup: 'A @ B', side: 'B -3', market: 'Spread',
    odds: -110, coverProb: 0.53, ev: 0.02, edge: 0.055, kellyUnits: 0.5,
    predictedClv: 0, homeTeam: 'B', awayTeam: 'A',
  }, { modelVersion: MODEL_VERSION });
  assert.strictEqual(highEdgeLowUnits.rating, 'aplus');
  assert.strictEqual(highEdgeLowUnits.qualityGrade, 'aplus');
  assert.strictEqual(highEdgeLowUnits.units, '0.5u');
  assert.strictEqual(typeof highEdgeLowUnits.confidence, 'number');
  assert.strictEqual(highEdgeLowUnits.confidence, math.ratingToConfidence('aplus'));
  assert.notStrictEqual(highEdgeLowUnits.rating, math.unitsToRating(0.5));
  assert.ok(typeof highEdgeLowUnits.qualityScore === 'number' && highEdgeLowUnits.qualityScore >= 0.05);
  assert.strictEqual(highEdgeLowUnits.modelVersion, MODEL_VERSION);

  // High stake, thin edge → B, not the units letter (1.5u would be A+ on the old map).
  const lowEdgeHighUnits = verify.buildQualityReplacement({
    sport: 'NFL', matchup: 'C @ D', side: 'Over 45.5', market: 'Total',
    odds: -110, coverProb: 0.54, ev: 0.03, edgePct: 0.012, kellyUnits: 1.5,
    predictedClv: 0, uncertainty: 0.12, homeTeam: 'D', awayTeam: 'C',
  }, { modelVersion: MODEL_VERSION });
  assert.strictEqual(lowEdgeHighUnits.rating, 'b');
  assert.strictEqual(lowEdgeHighUnits.qualityGrade, 'b');
  assert.strictEqual(lowEdgeHighUnits.units, '1.5u');
  assert.strictEqual(typeof lowEdgeHighUnits.confidence, 'number');
  assert.notStrictEqual(lowEdgeHighUnits.rating, math.unitsToRating(1.5));
  assert.strictEqual(lowEdgeHighUnits.rating, math.qualityToRating(0.012, 0, 0.12));
}

(async () => {
  const prevA = process.env.ANTHROPIC_API_KEY;
  const prevB = process.env.ANTHROPIC_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_KEY;
  try {
    const empty = await narrate.narrateAndVerify({
      picks: [], parlayLegs: [], dateFormatted: 'Tuesday, September 22',
    });
    assert.strictEqual(empty.claudeVerified, true);
    assert.strictEqual(empty.picks.length, 0);
    assertDeskCopy(empty.edgeSummary, 'empty narrate edge', 3, 5);
    assertDeskCopy(empty.insights, 'empty narrate insights', 3, 5);

    const out = await narrate.narrateAndVerify({
      picks: [{
        pick: 'Under 45.5', matchup: 'DAL @ NYG', sport: 'NFL', betType: 'Total',
        odds: '-105', units: '1u', rating: 'a', edgePct: '4.2%', coreReasoning: '',
      }],
      parlayLegs: [{
        units: '0.5u',
        legs: [{
          pick: 'Yankees ML', matchup: 'BOS @ NYY', sport: 'MLB', betType: 'Moneyline',
          odds: '+120', edgePct: '3.1%',
        }],
      }],
      dateFormatted: 'Tuesday, September 22',
      apiKey: '',
    });
    assert.strictEqual(out.claudeVerified, false);
    assertDeskCopy(out.edgeSummary, 'no-key edge', 3, 5);
    assertDeskCopy(out.insights, 'no-key insights', 3, 5);
    assertDeskCopy(out.picks[0].coreReasoning, 'no-key straight', 4, 6);
    assert.ok(/Under 45\.5/.test(out.picks[0].whatLoses));
    assert.ok(/closing number|holds near|quiet close/i.test(out.picks[0].clvExpectation));
    assert.ok(!/the model|Kelly|coverProb|\bCLV\b/i.test(out.picks[0].dataVerified));
    const leg = out.parlayLegs[0].legs[0];
    assertDeskCopy(leg.coreReasoning, 'no-key leg', 4, 6);
    assert.ok(/Yankees ML/.test(leg.whatLoses));
    assert.ok(/starter|quarterback|weather/i.test(out.insights));
  } finally {
    if (prevA == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevA;
    if (prevB == null) delete process.env.ANTHROPIC_KEY;
    else process.env.ANTHROPIC_KEY = prevB;
  }

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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
