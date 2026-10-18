'use strict';
// Textbook path: fair anchor, SE edge floor, 10% EV cap, quarter Kelly, parlay haircut.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  anchorProbability, modelWeightFor, ratingSeOf, normalPdf, normalQuantile,
  fairPickFields, applyMarketAnchor, priceEdgeAtBet, pinnacleFair,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const {
  stakeQuoteIsStale, failsEdgeFloorSe, edgeFloorSe,
} = require('./netlify/functions/lib/omega-vnext/edge_floor');
const { gateReason } = require('./netlify/functions/lib/omega-vnext/gates');
const { quarterKellyUnits, toPickObject, applyDailyUnitCap } = require('./netlify/functions/lib/omega-vnext/select');
const {
  stakeDollars, americanToImplied, americanToDecimal, formatEdgePct,
} = require('./netlify/functions/lib/omega-vnext/odds_math');
const { comboStats, parlayFromStraights } = require('./netlify/functions/lib/omega-vnext/parlay');

assert.strictEqual(anchorProbability(0.62, 0.50, 0), 0.50);
assert.strictEqual(anchorProbability(0.62, 0.50, 1), 0.62);
assert.strictEqual(anchorProbability(0.62, 0.50, 0.25), 0.53);

assert.deepStrictEqual(config.MARKET_ANCHOR_MODEL_WEIGHT, {
  NCAAF: { spread: 0.25, ml: 0.25, total: 0.10 },
  NFL: { spread: 0.25, ml: 0.25, total: 0.10 },
  NHL: { spread: 0.25, ml: 0.25, total: 0.25 },
  MLB: { spread: 0.25, ml: 0.25, total: 0.25 },
});
assert.strictEqual(modelWeightFor('NCAAF', 'Spread'), 0.25);
assert.strictEqual(modelWeightFor('NCAAF', 'Moneyline'), 0.25);
assert.strictEqual(modelWeightFor('NCAAF', 'Total'), 0.10);
assert.strictEqual(modelWeightFor('NFL', 'Spread'), 0.25);
assert.strictEqual(modelWeightFor('NFL', 'Moneyline'), 0.25);
assert.strictEqual(modelWeightFor('NFL', 'Total'), 0.10);
assert.strictEqual(modelWeightFor('NHL', 'Puck Line'), 0.25);
assert.strictEqual(modelWeightFor('NHL', 'Moneyline'), 0.25);
assert.strictEqual(modelWeightFor('NHL', 'Total'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Run Line'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Moneyline'), 0.25);
assert.strictEqual(modelWeightFor('MLB', 'Total'), 0.25);
assert.strictEqual(modelWeightFor('NBA', 'Spread'), null);

assert.strictEqual(config.EV_CAP_ALL, 0.10);
assert.strictEqual(stakeQuoteIsStale({ market: 'Spread', odds: -110, ev: 0.11 }), true);
assert.strictEqual(stakeQuoteIsStale({ market: 'Total', odds: -110, ev: 0.11 }), true);
assert.strictEqual(stakeQuoteIsStale({ market: 'Moneyline', odds: -110, ev: 0.11 }), true);
assert.strictEqual(stakeQuoteIsStale({ market: 'Spread', odds: -110, ev: 0.10 }), false);

const asOf = { cardDate: '2026-10-13', asOfMs: Date.parse('2026-10-13T13:30:00Z') };
function side(extra) {
  return {
    sport: 'NFL', matchup: 'A @ B', side: 'A -3.5', market: 'Spread', line: -3.5,
    odds: -110, coverProb: 0.55, ev: 0.05, edgePct: 0.04, liquid: true,
    uncertainty: 0.15, commenceTime: '2026-10-13T20:00:00Z',
    homeTeam: 'B', awayTeam: 'A', book: 'draftkings',
    ...extra,
  };
}
assert.strictEqual(gateReason(side({ ev: 0.11, edgePct: 0.06 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ market: 'Total', side: 'Over 45.5', ev: 0.11, edgePct: 0.06 }), asOf), 'ev-stale');
assert.strictEqual(gateReason(side({ market: 'Moneyline', side: 'A ML', ev: 0.11, edgePct: 0.06 }), asOf), 'ev-stale');

// 2026-10-18: default k is 0. The 1.5*SE hurdle double-counted the anchor (SIM-REPORT). Flat 2% remains.
assert.strictEqual(config.EDGE_FLOOR_K, 0);
assert.strictEqual(edgeFloorSe(0.04), 0.02);
assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.05, ratingSe: 0.04 }), false);
assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.07, ratingSe: 0.04 }), false);
assert.strictEqual(failsEdgeFloorSe({ edgePct: 0.01, ratingSe: 0.04 }), true);
assert.strictEqual(gateReason(side({ edgePct: 0.05, ev: 0.05, ratingSe: 0.04 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.07, ev: 0.05, ratingSe: 0.04 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.01, ev: 0.05, ratingSe: 0.04 }), asOf), 'edge-floor-se');

const seRow = { sport: 'NFL', market: 'Spread', modelPureP: 0.6, ratingN: 6 };
const z = normalQuantile(0.6);
const seExpected = modelWeightFor('NFL', 'Spread')
  * normalPdf(z)
  * config.ratingErrorSd('NFL', 'margin', 6)
  / config.effectiveSd('NFL', 'margin', 6);
assert.ok(Math.abs(ratingSeOf(seRow) - seExpected) < 1e-12, String(ratingSeOf(seRow)));
assert.strictEqual(ratingSeOf({ sport: 'NBA', market: 'Spread', modelPureP: 0.6, ratingN: 6 }), 0);

const anchored = applyMarketAnchor([{
  sport: 'NFL', market: 'Spread', side: 'Home -3', line: -3,
  modelPureP: 0.6, coverProb: 0.7, ratingN: 6,
  matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
  pinnacleSide: { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 },
}]);
assert.strictEqual(anchored[0].anchorFairSource, 'pinnacle');
assert.ok(Math.abs(anchored[0].ratingSe - seExpected) < 1e-9);

const implied = americanToImplied(-110);
assert.strictEqual(quarterKellyUnits(implied, -110), 0);
assert.strictEqual(quarterKellyUnits(implied - 0.01, -110), 0);
assert.strictEqual(quarterKellyUnits(0.53, -110), 0.5);
assert.strictEqual(quarterKellyUnits(0.54, -110), 0.75);
assert.strictEqual(quarterKellyUnits(0.55, -110), 1.5);
assert.strictEqual(quarterKellyUnits(0.60, -110), 1.5);
assert.strictEqual(quarterKellyUnits(0.9, 0), 0);
let prev = -1;
for (let i = 0; i <= 40; i++) {
  const p = implied + i * 0.005;
  const u = quarterKellyUnits(p, -110);
  assert.ok(u >= prev, `${p} units ${u} < ${prev}`);
  assert.ok(Math.abs(u * 4 - Math.round(u * 4)) < 1e-9);
  prev = u;
}
assert.strictEqual(stakeDollars(0.75), 113);
assert.strictEqual(stakeDollars(0.5), 75);
assert.strictEqual(stakeDollars(1), 150);
assert.strictEqual(stakeDollars(1.5), 225);

function evOf(p, odds) { return p * americanToDecimal(odds) - 1; }
function edgeOf(p, odds) { return p - americanToImplied(odds); }
assert.ok(edgeOf(0.48, -110) < 0);
assert.ok(evOf(0.48, -110) < 0);
const dec110 = americanToDecimal(-110);
for (const p of [0.48, 0.55, 0.60]) {
  const ratio = evOf(p, -110) / edgeOf(p, -110);
  assert.ok(Math.abs(ratio - dec110) < 1e-9, String(ratio));
  assert.ok(Math.abs(ratio - 2) < 0.15);
}

const legs = [
  { coverProb: 0.6, odds: -110, p_fair: 0.52, sport: 'NFL', matchup: 'A @ B' },
  { coverProb: 0.55, odds: -115, p_fair: 0.50, sport: 'NHL', matchup: 'C @ D' },
  { coverProb: 0.5, odds: 100, p_fair: 0.48, sport: 'MLB', matchup: 'E @ F' },
];
const stats = comboStats(legs);
const prod = 0.6 * 0.55 * 0.5;
const hair = Math.pow(0.95, 2);
const payout = legs.reduce((acc, l) => acc * americanToDecimal(l.odds), 1);
assert.ok(Math.abs(stats.combinedProb - prod * hair) < 1e-12);
assert.ok(Math.abs(stats.combinedDecimal - payout) < 1e-12);
assert.ok(Math.abs(stats.ev - (prod * hair * payout - 1)) < 1e-12);
assert.strictEqual(stats.evAtModel, stats.ev);
assert.ok(Math.abs(stats.evAtFair - (0.52 * 0.50 * 0.48 * payout - 1)) < 1e-12);
const two = comboStats(legs.slice(0, 2));
assert.ok(Math.abs(two.combinedProb - (0.6 * 0.55 * 0.95)) < 1e-12);
assert.strictEqual(config.CORR_HAIRCUT_PER_LEG, 0.95);

const pick = toPickObject({
  sport: 'NFL', matchup: 'A @ B', side: 'A -3', market: 'Spread',
  odds: -110, coverProb: 0.55, edgePct: 0.04, ev: 0.05,
  edgeBasis: 'model-edge-vs-bet-price',
  p_fair: 0.504, anchorFairSource: 'pinnacle', anchorWeight: 0.25,
  p_model: 0.62, modelPureP: 0.62,
  homeTeam: 'B', awayTeam: 'A',
});
assert.strictEqual(pick.fairP, '50.4%');
assert.strictEqual(pick.fairSource, 'pinnacle');
assert.strictEqual(pick.modelWeight, 0.25);
assert.strictEqual(pick.p_model, 0.62);
assert.strictEqual(pick.evAtFair, formatEdgePct(0.504 * americanToDecimal(-110) - 1));
const printed = fairPickFields(pick);
assert.strictEqual(printed.fairP, '50.4%');

// Push scales EV and Kelly only. Edge stays p − vigged implied.
{
  const p = 0.5286;
  const pPush = 0.0747;
  const odds = -102;
  const dec = americanToDecimal(odds);
  const naive = p * dec - 1;
  const expectedEv = (1 - pPush) * naive;
  assert.ok(Math.abs(dec - 1.98039) < 1e-5);
  assert.ok(Math.abs(expectedEv - 0.0433) < 5e-4);
  assert.ok(Math.abs(naive - 0.0468) < 5e-4);
  const priced = priceEdgeAtBet({
    sport: 'NFL', market: 'Spread', side: 'A +3', line: 3, odds, book: 'draftkings',
    coverProb: p, pPush,
  });
  assert.strictEqual(priced.ev, +expectedEv.toFixed(6));
  assert.notStrictEqual(priced.ev, +naive.toFixed(6));
  assert.strictEqual(priced.edgePct, +(p - americanToImplied(odds)).toFixed(6));
  assert.strictEqual(priced.coverProb, p);

  function kellyFromEv(ev, decimal) {
    const raw = 0.25 * (ev / (decimal - 1)) * 100;
    const rounded = Math.round(raw * 4) / 4;
    return Math.min(1.5, Math.max(0.5, rounded));
  }
  const scaledUnits = quarterKellyUnits(p, odds, pPush);
  const plainUnits = quarterKellyUnits(p, odds);
  assert.strictEqual(scaledUnits, kellyFromEv(expectedEv, dec));
  assert.strictEqual(plainUnits, kellyFromEv(naive, dec));
  assert.ok(scaledUnits < plainUnits);
  assert.strictEqual(quarterKellyUnits(p, odds, 0), plainUnits);
  assert.strictEqual(quarterKellyUnits(p, odds, undefined), plainUnits);
  const zeroPush = priceEdgeAtBet({ odds, coverProb: p, pPush: 0, book: 'draftkings' });
  const missingPush = priceEdgeAtBet({ odds, coverProb: p, book: 'draftkings' });
  assert.strictEqual(zeroPush.ev, +naive.toFixed(6));
  assert.strictEqual(missingPush.ev, zeroPush.ev);
  assert.strictEqual(zeroPush.edgePct, missingPush.edgePct);

  const pushedPick = toPickObject({
    sport: 'NFL', matchup: 'A @ B', side: 'A +3', market: 'Spread', line: 3,
    odds, coverProb: p, pPush, edgePct: p - americanToImplied(odds), ev: expectedEv,
    homeTeam: 'B', awayTeam: 'A',
  });
  assert.strictEqual(pushedPick.units, `${scaledUnits}u`);
  const plainPick = toPickObject({
    sport: 'NFL', matchup: 'A @ B', side: 'A +3', market: 'Spread', line: 3,
    odds, coverProb: p, edgePct: p - americanToImplied(odds), ev: naive,
    homeTeam: 'B', awayTeam: 'A',
  });
  assert.strictEqual(plainPick.units, `${plainUnits}u`);
}

// Parlay ticket EV is evAtModel, not the rounded win rate at the rounded price.
{
  const probs = [0.4642, 0.5696, 0.5477];
  const odds = [136, -112, -105];
  const decs = odds.map(americanToDecimal);
  assert.ok(Math.abs(decs[0] - 2.36) < 1e-12);
  assert.ok(Math.abs(decs[1] - 1.892857) < 1e-6);
  assert.ok(Math.abs(decs[2] - 1.952381) < 1e-6);
  const hair = Math.pow(0.95, 2);
  assert.strictEqual(hair, 0.9025);
  const joint = probs[0] * probs[1] * probs[2] * hair;
  const decimalProduct = decs[0] * decs[1] * decs[2];
  const ev = joint * decimalProduct - 1;
  const legs = probs.map((coverProb, i) => {
    const matchup = `${String.fromCharCode(65 + i * 2)} @ ${String.fromCharCode(66 + i * 2)}`;
    const parts = matchup.split(' @ ');
    return {
      sport: 'NFL', matchup, side: parts[1], homeTeam: parts[1], awayTeam: parts[0],
      market: 'Moneyline', odds: odds[i], coverProb,
      edgePct: coverProb - americanToImplied(odds[i]),
      ev: coverProb * decs[i] - 1,
      book: 'draftkings',
    };
  });
  const ticket = parlayFromStraights(legs)[0];
  assert.strictEqual(ticket.qualifying, true, ticket && ticket.reason);
  assert.strictEqual(ticket.legs.length, 3);
  assert.strictEqual(ticket.ev, ticket.evAtModel);
  assert.strictEqual(ticket.ev, formatEdgePct(ev));
  assert.ok(Math.abs(parseFloat(ticket.ev) / 100 - ev) <= 0.001 + 1e-12);
}

// Three max straights plus the 0.5u parlay sit on the 5.0u cap, so nothing moves.
// An overage drops a straight instead of printing one under 0.5u.
{
  const maxed = ['A', 'B', 'C'].map((name, i) => ({
    pick: name, rating: 'aplus', qualityGrade: 'aplus', tier: 'floor',
    units: '1.5u', qualityScore: 0.06 - i * 0.001, edgePct: '5.0%',
  }));
  const held = applyDailyUnitCap(maxed, [{ units: '0.5u', qualifying: true, legs: [] }]);
  assert.strictEqual(held.picks.length, 3);
  assert.ok(held.picks.every((p) => p.units === '1.5u'));
  assert.strictEqual(held.parlayLegs[0].units, '0.5u');

  const over = Array.from({ length: 10 }, (_, i) => ({
    pick: `S${i}`, rating: 'b', qualityGrade: 'b', tier: 'floor',
    units: '0.5u', qualityScore: 0.001 * (i + 1), edgePct: '0.8%',
  }));
  const trimmed = applyDailyUnitCap(over, [{ units: '0.5u', qualifying: true, legs: [] }]);
  assert.ok(trimmed.picks.length < over.length);
  assert.ok(trimmed.picks.every((p) => parseFloat(p.units) >= 0.5 - 1e-9));
  assert.ok(!trimmed.picks.some((p) => p.pick === 'S0'));
  const straightU = trimmed.picks.reduce((sum, p) => sum + parseFloat(p.units), 0);
  assert.ok(straightU <= 4.5 + 1e-9);
}

// A line-move nudge on the row does not enter the anchored cover probability.
{
  const row = {
    sport: 'NFL', market: 'Spread', side: 'Home -3', line: -3,
    modelPureP: 0.6, ratingN: 6,
    matchup: 'Away @ Home', homeTeam: 'Home', awayTeam: 'Away',
    pinnacleSide: { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 },
  };
  const nudged = {
    ...row,
    coverProb: 0.81,
    p_cal: 0.81,
    movementAdjusted: true,
    movementAdj: 0.014,
  };
  const [plain] = applyMarketAnchor([row]);
  const [moved] = applyMarketAnchor([nudged]);
  const w = moved.anchorWeight;
  const pModel = row.modelPureP;
  const pFair = pinnacleFair(row);
  assert.strictEqual(moved.movementAdj, 0.014);
  assert.strictEqual(moved.p_cal, nudged.p_cal);
  assert.notStrictEqual(moved.coverProb, nudged.coverProb);
  assert.notStrictEqual(moved.coverProb, nudged.p_cal + nudged.movementAdj);
  assert.strictEqual(moved.coverProb, plain.coverProb);
  assert.strictEqual(moved.coverProb, anchorProbability(pModel, pFair, w));
  // p_model / p_fair on the row are stamped to 6 decimals. The cover is the
  // unrounded blend, so reconstruct it from those inputs, not from the stamp.
  assert.strictEqual(moved.coverProb, w * pModel + (1 - w) * pFair);
  assert.strictEqual(moved.p_model, +Number(pModel).toFixed(6));
  assert.strictEqual(moved.p_fair, +Number(pFair).toFixed(6));
}

console.log('test-omega-textbook-1017 ok');
