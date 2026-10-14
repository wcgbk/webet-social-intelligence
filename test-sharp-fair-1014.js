'use strict';

const assert = require('assert');
const { noVigTwoWay, americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { enrichCandidateWithEdge } = require('./netlify/functions/lib/omega-vnext/edge');
const { gateReason, applyGates } = require('./netlify/functions/lib/omega-vnext/gates');
const {
  SHARP_FAIR_VERSION,
  FRESH_MINUTES,
  sharpFairEnabled,
  powerTwoWay,
  evaluateQuote,
  priceCandidate,
  applySharpFair,
  stakeEv,
} = require('./netlify/functions/lib/omega-vnext/sharp_fair');

assert.strictEqual(SHARP_FAIR_VERSION, 'sharp-math-1014');
assert.strictEqual(FRESH_MINUTES, 20);
assert.strictEqual(sharpFairEnabled({}), false);
assert.strictEqual(sharpFairEnabled({ OMEGA_SHARP_FAIR: '0' }), false);
assert.strictEqual(sharpFairEnabled({ OMEGA_SHARP_FAIR: 'off' }), false);
assert.strictEqual(sharpFairEnabled({ OMEGA_SHARP_FAIR: '1' }), true);

function implied(a) {
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

const even = powerTwoWay(implied(-110), implied(-110));
assert.ok(Math.abs(even.p1 - 0.5) < 1e-9);
assert.ok(Math.abs(even.p2 - 0.5) < 1e-9);
assert.ok(even.k > 1);

const brewersI = [implied(121), implied(-131)];
const brewersPower = powerTwoWay(brewersI[0], brewersI[1]);
const brewersMult = noVigTwoWay(121, -131);
assert.ok(Math.abs(brewersPower.p1 - 0.44217584694940515) < 1e-9, brewersPower.p1);
assert.ok(Math.abs(brewersMult.p1 - 0.4437955082515226) < 1e-9);
assert.ok(Math.abs(brewersPower.p1 + brewersPower.p2 - 1) < 1e-9);
const brewersEv = stakeEv(brewersPower.p1, 118, 0);
assert.ok(brewersEv < -0.03 && brewersEv > -0.04, brewersEv);

const dog = powerTwoWay(implied(210), implied(-250));
const dogMult = implied(210) / (implied(210) + implied(-250));
assert.ok(dog.p1 < dogMult - 0.008, 'power cuts the longshot versus multiplicative');
assert.ok(Math.abs(dog.p1 - 0.30057) < 1e-3, dog.p1);

const under = powerTwoWay(implied(105), implied(105));
assert.ok(under.k < 1, under.k);
assert.ok(Math.abs(under.p1 - 0.5) < 1e-9);
assert.ok(Math.abs(under.p1 + under.p2 - 1) < 1e-9);

function quote(extra) {
  return evaluateQuote({
    sport: 'MLB',
    market: 'Moneyline',
    pinAmerican: 121,
    pinOppAmerican: -131,
    betAmerican: 118,
    pinLagMin: 0,
    ...extra,
  });
}

const brewers = quote();
assert.strictEqual(brewers.ok, true);
assert.ok(brewers.ev < 0);
assert.strictEqual(brewers.method, 'power');

assert.strictEqual(quote({ pinLagMin: 15 }).ok, true);
assert.strictEqual(quote({ pinLagMin: 20 }).ok, true);
assert.strictEqual(quote({ pinLagMin: 20.01 }).reason, 'stale-sharp');
assert.strictEqual(quote({ pinLagMin: -5 }).reason, 'stale-sharp');
assert.strictEqual(quote({ pinLagMin: null }).reason, 'stale-sharp');
assert.strictEqual(quote({ pinLagMin: null, sameSnapshot: true }).ok, true);
assert.strictEqual(quote({ pinAmerican: null }).reason, 'no-two-way');

const wide = quote({ pinAmerican: -200, pinOppAmerican: -200 });
assert.strictEqual(wide.reason, 'wide-sharp');

const nbaMiss = evaluateQuote({
  sport: 'NBA',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -3,
  betPoint: -2.5,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(nbaMiss.reason, 'point-mismatch');

const nflExact = evaluateQuote({
  sport: 'NFL',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -3,
  betPoint: -3,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(nflExact.ok, true);
assert.strictEqual(nflExact.q, 0.09);
assert.ok(nflExact.ev < 0);
const noPush = stakeEv(0.5, -110, 0);
assert.ok(Math.abs(nflExact.ev - noPush) < 1e-9);

const bought = evaluateQuote({
  sport: 'NFL',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -3,
  betPoint: -2.5,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(bought.ok, true);
assert.strictEqual(bought.q, 0);
assert.ok(Math.abs(bought.p - (0.5 * 0.91 + 0.09)) < 1e-6, bought.p);
assert.ok(bought.ev > 0.03, bought.ev);

const laid = evaluateQuote({
  sport: 'NFL',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -3,
  betPoint: -3.5,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(laid.ok, true);
assert.ok(Math.abs(laid.p - 0.5 * 0.91) < 1e-6, laid.p);
assert.ok(laid.ev < 0);

const fromHard = evaluateQuote({
  sport: 'NFL',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -3.5,
  betPoint: -3,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(fromHard.ok, true);
assert.strictEqual(fromHard.q, 0.09);
assert.ok(Math.abs(fromHard.p - 0.5 / 0.91) < 1e-6, fromHard.p);

const offKey = evaluateQuote({
  sport: 'NFL',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -5,
  betPoint: -4.5,
  betAmerican: -110,
  pinLagMin: 0,
});
assert.strictEqual(offKey.reason, 'point-mismatch');

const totalMiss = evaluateQuote({
  sport: 'NFL',
  market: 'Total',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: 47,
  betPoint: 47.5,
  betAmerican: -105,
  pinLagMin: 0,
});
assert.strictEqual(totalMiss.reason, 'point-mismatch');

const softEdge = evaluateQuote({
  sport: 'NBA',
  market: 'Spread',
  pinAmerican: -110,
  pinOppAmerican: -110,
  pinPoint: -4.5,
  betPoint: -4.5,
  betAmerican: 110,
  pinAt: '2026-10-14T14:00:00Z',
  softAt: '2026-10-14T14:10:00Z',
});
assert.strictEqual(softEdge.ok, true);
assert.ok(Math.abs(softEdge.lagMin - 10) < 1e-9);
assert.ok(softEdge.ev > 0.02 && softEdge.ev < 0.12, softEdge.ev);

const modelRow = {
  sport: 'MLB',
  market: 'Moneyline',
  side: 'Milwaukee Brewers',
  matchup: 'Milwaukee Brewers @ Philadelphia Phillies',
  odds: 118,
  line: null,
  coverProb: 0.47783835486687376,
  ev: 0.0417,
  liquid: true,
  commenceTime: '2026-09-22T22:41:00Z',
  homeTeam: 'Philadelphia Phillies',
  awayTeam: 'Milwaukee Brewers',
  book: 'draftkings',
  pinnacleSide: { american: 121, oppAmerican: -131, point: null, oppPoint: null },
  pinLagMin: 0,
  movementDrop: true,
  movementDropReason: 'sharp_prob_against',
  nflGameProjectionGap: true,
};
const priced = priceCandidate(modelRow);
assert.strictEqual(priced.sharpFairPriced, true);
assert.strictEqual(priced.priceVersion, 'sharp-math-1014');
assert.ok(priced.coverProb < 0.45);
assert.ok(priced.ev < 0);
assert.notStrictEqual(priced.coverProb, modelRow.coverProb);
assert.strictEqual(priced.movementDrop, false);
assert.strictEqual(priced.modelPricedEv, 0.0417);

const stale = priceCandidate({ ...modelRow, pinLagMin: 90 });
assert.strictEqual(stale.sharpFairReject, 'stale-sharp');
assert.strictEqual(stale.coverProb, null);

const asOf = { cardDate: '2026-09-22', asOfMs: Date.parse('2026-09-22T14:00:00Z') };
assert.strictEqual(gateReason(priced, asOf), 'edge-floor');
const gated = applyGates([priced, stale], asOf);
assert.strictEqual(gated.yesPool.length, 0);
assert.strictEqual(gated.leanPool.length, 0);
assert.ok(gated.rejected.some((row) => row.side === 'Milwaukee Brewers' && row.rejectReason === 'edge-floor'));
assert.strictEqual(gated.rejected.length, 2);
assert.ok(gated.rejected.some((row) => row.rejectReason === 'stale-sharp'));

const floor = priceCandidate({
  ...modelRow,
  sport: 'NBA',
  market: 'Spread',
  side: 'Celtics -4.5',
  odds: 110,
  line: -4.5,
  commenceTime: '2026-10-14T23:30:00Z',
  pinnacleSide: { american: -110, oppAmerican: -110, point: -4.5, oppPoint: 4.5 },
  movementDrop: false,
});
assert.ok(floor.ev > 0.02 && floor.ev < 0.12, floor.ev);
assert.strictEqual(gateReason(floor, {
  cardDate: '2026-10-14',
  asOfMs: Date.parse('2026-10-14T14:00:00Z'),
}), null);

const untouched = {
  sport: 'NFL',
  matchup: 'Jets @ Bills',
  side: 'Bills',
  market: 'Moneyline',
  line: null,
  odds: -110,
  coverProb: 0.55,
  ev: 0.04,
  liquid: true,
  commenceTime: '2026-10-14T23:15:00Z',
  homeTeam: 'Bills',
  awayTeam: 'Jets',
};
assert.strictEqual(gateReason(untouched, {
  cardDate: '2026-10-14',
  asOfMs: Date.parse('2026-10-14T14:00:00Z'),
}), null);

const bundles = [
  {
    side: 'Milwaukee Brewers',
    point: null,
    prices: [
      { book: 'pinnacle', american: 121 },
      { book: 'draftkings', american: 118 },
    ],
  },
  {
    side: 'Philadelphia Phillies',
    point: null,
    prices: [
      { book: 'pinnacle', american: -131 },
      { book: 'draftkings', american: -142 },
    ],
  },
];
const enriched = enrichCandidateWithEdge({
  sport: 'MLB',
  market: 'Moneyline',
  coverProb: 0.48,
  modelRawP: 0.49,
}, bundles[0], bundles);
assert.ok(enriched.pinnacleSide);
assert.strictEqual(enriched.pinnacleSide.american, 121);
assert.strictEqual(enriched.pinnacleSide.oppAmerican, -131);
assert.ok(Math.abs(enriched.fair_sharp_p - brewersMult.p1) < 1e-9);
assert.ok(americanToImplied(118) > enriched.fair_sharp_p);

const batch = applySharpFair([modelRow], { sameSnapshot: false });
assert.strictEqual(batch.length, 1);
assert.strictEqual(batch[0].sharpFairPriced, true);

const shop = priceCandidate({
  ...modelRow,
  odds: 100,
  book: 'draftkings',
  dkQuote: { book: 'draftkings', american: 100, point: null },
  hardRock: { book: 'hardrockbet', american: 130, point: null },
});
assert.strictEqual(shop.book, 'hardrockbet');
assert.strictEqual(shop.odds, 130);
assert.ok(shop.ev > priceCandidate({ ...modelRow, odds: 100, book: 'draftkings' }).ev);

const { sharpFairForSide } = require('./netlify/functions/lib/omega-vnext/edge');
const { stampClose } = require('./netlify/functions/lib/omega-vnext/candidate_closes_v2');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
process.env.OMEGA_SHARP_FAIR = '1';
const softOnly = sharpFairForSide([
  { side: 'A', point: null, prices: [{ book: 'draftkings', american: -110 }, { book: 'hardrockbet', american: -108 }] },
  { side: 'B', point: null, prices: [{ book: 'draftkings', american: -110 }, { book: 'hardrockbet', american: -112 }] },
], 'A', null);
assert.strictEqual(softOnly, null);
const dec110 = americanToDecimal(-110);
const stamped = stampClose(
  { odds: -110, fair_sharp_p: 0.47 },
  { book: 'pinnacle', line: -3, sideOdds: -105, oppOdds: -115, closeNoVig: 0.52, pointAdjusted: false },
  '2026-10-14T16:00:00Z',
);
assert.ok(Math.abs(stamped.clvAtPrice - (dec110 * 0.52 - 1)) < 1e-12);
assert.strictEqual(stamped.clv, stamped.clvAtPrice);
assert.strictEqual(stamped.beatClose, stamped.clvAtPrice > 0);
assert.ok(Math.abs(stamped.marketDrift - (0.52 - 0.47)) < 1e-12);
const shifted = stampClose(
  { odds: -110, fair_sharp_p: 0.5 },
  { book: 'pinnacle', line: 7.5, sideOdds: -110, oppOdds: -110, closeNoVig: 0.5, pointAdjusted: true },
  '2026-10-14T16:00:00Z',
);
assert.strictEqual(shifted.clvAtPrice, null);
assert.strictEqual(shifted.clv, null);
assert.strictEqual(shifted.beatClose, null);
delete process.env.OMEGA_SHARP_FAIR;

const { toPickObject, selectStraights } = require('./netlify/functions/lib/omega-vnext/select');
const { parlayFromStraights } = require('./netlify/functions/lib/omega-vnext/parlay');
const implied110 = americanToImplied(-110);
const mainP = implied110 + 0.04;
const main = toPickObject({
  sharpFairPriced: true,
  sport: 'MLB',
  market: 'Moneyline',
  side: 'Chicago White Sox',
  matchup: 'Chicago White Sox @ Houston Astros',
  homeTeam: 'Houston Astros',
  awayTeam: 'Chicago White Sox',
  odds: -110,
  coverProb: mainP,
  edgePct: mainP - implied110,
  ev: mainP * dec110 - 1,
  tier: 'floor',
  liquid: true,
});
assert.strictEqual(main.rating, 'a');
assert.ok(parseFloat(main.units) <= 1 + 1e-9, main.units);
assert.ok(parseFloat(main.units) > 0.5, main.units);
const leanP = implied110 + 0.015;
const lean = toPickObject({
  sharpFairPriced: true,
  sport: 'MLB',
  market: 'Total',
  side: 'Over 7.5',
  matchup: 'Chicago Cubs @ San Diego Padres',
  odds: -110,
  coverProb: leanP,
  edgePct: 0.015,
  ev: leanP * dec110 - 1,
  tier: 'lean',
  liquid: true,
});
assert.strictEqual(lean.rating, 'b');
assert.ok(parseFloat(lean.units) <= 0.5 + 1e-9, lean.units);
const strong = toPickObject({
  ...main,
  sharpFairPriced: true,
  coverProb: implied110 + 0.05,
  edgePct: 0.05,
  odds: -110,
  tier: 'floor',
});
assert.strictEqual(strong.rating, 'aplus');
assert.ok(parseFloat(strong.units) <= 1 + 1e-9);

function pairedRow(matchup, side, ev, edge, extra) {
  const parts = matchup.split(' @ ');
  return {
    sharpFairPriced: true,
    sport: 'NCAAF',
    matchup,
    side,
    market: 'Moneyline',
    odds: 105,
    coverProb: 0.48,
    ev,
    edgePct: edge,
    liquid: true,
    book: 'draftkings',
    homeTeam: parts[1],
    awayTeam: parts[0],
    commenceTime: '2026-10-14T23:00:00Z',
    rejectReason: 'edge-floor',
    ...extra,
  };
}

const floorGame = pairedRow('A @ B', 'B ML', 0.04, 0.03, { tier: 'floor', rejectReason: null });
const bGame = pairedRow('C @ D', 'D ML', 0.02, 0.015, { tier: 'lean', rejectReason: null });
const bestEv = pairedRow('E @ F', 'F ML', -0.014, -0.0069);
const sameGameWorse = pairedRow('E @ F', 'E +1.5', -0.014, -0.0074, { market: 'Spread', line: 1.5 });
const midEv = pairedRow('G @ H', 'H +1.5', -0.015, -0.0103, { market: 'Spread', line: 1.5, odds: -225 });
const lowEv = pairedRow('I @ J', 'J ML', -0.018, -0.0077, { odds: 136 });
const worseEv = pairedRow('K @ L', 'L ML', -0.029, -0.0117, { odds: 150 });
const notPaired = pairedRow('M @ N', 'N ML', 0.05, -0.01, { sharpFairPriced: false, sharpFairReject: 'no-two-way' });

const short = selectStraights([floorGame], 3, [bGame], [worseEv, sameGameWorse, lowEv, notPaired, midEv, bestEv]);
assert.deepStrictEqual(short.map((row) => row.side), ['B ML', 'D ML', 'F ML']);
assert.deepStrictEqual(short.map((row) => row.tier), ['floor', 'lean', 'lean']);
assert.strictEqual(short[2].pairedFill, true);
assert.strictEqual(short[2].label, 'lean');
assert.ok(!short.some((row) => row.side === 'E +1.5' || row.side === 'N ML'));

const filledOnly = selectStraights([], 3, [], [worseEv, sameGameWorse, lowEv, midEv, bestEv, notPaired]);
assert.deepStrictEqual(filledOnly.map((row) => row.side), ['F ML', 'H +1.5', 'J ML']);
assert.ok(filledOnly.every((row) => row.tier === 'lean' && row.pairedFill === true));
const fullFloor = selectStraights([
  pairedRow('A @ B', 'B ML', 0.04, 0.03),
  pairedRow('C @ D', 'D ML', 0.03, 0.025),
  pairedRow('E @ F', 'F ML', 0.025, 0.021),
], 3, [], [bestEv]);
assert.ok(fullFloor.every((row) => row.tier === 'floor'));
assert.strictEqual(fullFloor.length, 3);

const leanStake = toPickObject(filledOnly[0]);
assert.strictEqual(leanStake.tier, 'lean');
assert.strictEqual(leanStake.label, 'lean');
assert.strictEqual(leanStake.units, '0.5u');

const negTicket = parlayFromStraights(filledOnly.map((row) => toPickObject(row)), { pool: filledOnly });
assert.strictEqual(negTicket.length, 1);
assert.strictEqual(negTicket[0].type, '3-leg-parlay-labeled');
assert.strictEqual(negTicket[0].units, '0.25u');
assert.strictEqual(negTicket[0].label, 'combined EV not positive');
assert.strictEqual(negTicket[0].legs.length, 3);
assert.strictEqual(negTicket[0].qualifying, true);

console.log('test-sharp-fair-1014 ok');
