'use strict';
// Soft fair is a retail-only reference. Edge, stake EV, and a sharp EV@fair
// all use the row's bet price (the best retail quote already on the row).
const assert = require('assert');
const { americanToImplied, americanToDecimal, formatEdgePct } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { powerTwoWay } = require('./netlify/functions/lib/omega-vnext/sharp_fair');
const { pushAwareEv } = require('./netlify/functions/lib/omega-vnext/push_ev');
const {
  applyMarketAnchor, fairPickFields, priceEdgeAtBet,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { comboStats } = require('./netlify/functions/lib/omega-vnext/parlay');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');
const { pickPublic } = require('./netlify/functions/lib/public-picks');

const SOFT_EV = 'n/a (soft fair)';

function powerP(a1, a2) {
  const powered = powerTwoWay(americanToImplied(a1), americanToImplied(a2));
  assert.ok(powered, `${a1}/${a2}`);
  return powered.p1;
}

function stamp(p) {
  return +Number(p).toFixed(6);
}

function ml(side, prices, extra) {
  const dk = prices.find((p) => p.book === 'draftkings');
  return {
    sport: 'NFL',
    market: 'Moneyline',
    side,
    matchup: 'A @ B',
    awayTeam: 'A',
    homeTeam: 'B',
    commenceTime: 't',
    odds: dk ? dk.american : prices[0].american,
    book: 'draftkings',
    modelPureP: 0.5,
    coverProb: 0.5,
    bookPrices: prices.map((p) => ({ ...p, point: null })),
    ...extra,
  };
}

function runPair(aPrices, bPrices, aExtra, bExtra) {
  const out = applyMarketAnchor([
    ml('A', aPrices, aExtra),
    ml('B', bPrices, bExtra),
  ]);
  return out;
}

function expectSoft(row, source) {
  assert.strictEqual(row.anchorFairSource, source);
  assert.strictEqual(row.fairQuality, 'soft');
  assert.strictEqual(row.fairSoft, true);
  assert.strictEqual(row.evAtFairValid, false);
  assert.ok(row.p_fair > 0 && row.p_fair < 1);
  const printed = fairPickFields(row);
  assert.strictEqual(printed.fairSource, `${source}-soft`);
  assert.strictEqual(printed.fairQuality, 'soft');
  assert.strictEqual(printed.fairSoft, true);
  assert.strictEqual(printed.evAtFairValid, false);
  assert.strictEqual(printed.evAtFair, SOFT_EV);
  assert.ok(typeof printed.evAtFair !== 'number');
  assert.ok(!Number.isFinite(Number(printed.evAtFair)));
  assert.strictEqual(printed.p_fair, row.p_fair);
  const pub = pickPublic(toPickObject(row));
  assert.strictEqual(pub.fairSource, `${source}-soft`);
  assert.strictEqual(pub.fairQuality, 'soft');
  assert.strictEqual(pub.fairSoft, true);
  assert.strictEqual(pub.evAtFairValid, false);
  assert.strictEqual(pub.evAtFair, SOFT_EV);
}

function expectSharp(row, source) {
  assert.strictEqual(row.anchorFairSource, source);
  assert.strictEqual(row.fairQuality, 'sharp');
  assert.strictEqual(row.fairSoft, false);
  assert.strictEqual(row.evAtFairValid, true);
  const printed = fairPickFields(row);
  assert.strictEqual(printed.fairSource, source);
  assert.strictEqual(printed.fairQuality, 'sharp');
  assert.strictEqual(printed.fairSoft, false);
  assert.strictEqual(printed.evAtFairValid, true);
  assert.strictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(row.p_fair, row.odds, row.pPush)));
  assert.ok(typeof printed.evAtFair === 'string' && printed.evAtFair.endsWith('%'));
  const pub = pickPublic(toPickObject(row));
  assert.strictEqual(pub.fairQuality, 'sharp');
  assert.strictEqual(pub.fairSoft, false);
  assert.strictEqual(pub.evAtFairValid, true);
  assert.strictEqual(pub.evAtFair, printed.evAtFair);
  assert.strictEqual(pub.fairSource, source);
}

// DK only. One retail book. Power fair still anchors. EV@fair is not a number.
{
  const [home] = runPair(
    [{ book: 'draftkings', american: 140 }],
    [{ book: 'draftkings', american: -160 }],
  );
  expectSoft(home, 'draftkings');
  assert.strictEqual(home.p_fair, stamp(powerP(140, -160)));
  const priced = priceEdgeAtBet(home);
  assert.strictEqual(priced.odds, 140);
  assert.strictEqual(priced.edgePct, +(priced.coverProb - americanToImplied(140)).toFixed(6));
  assert.strictEqual(priced.ev, +pushAwareEv(priced.coverProb, 140, priced.pPush).toFixed(6));
}

// DK + Hard Rock. Both retail, so the consensus is soft. Hard Rock is retail.
{
  const [home] = runPair(
    [{ book: 'draftkings', american: 140 }, { book: 'hardrockbet', american: 150 }],
    [{ book: 'draftkings', american: -160 }, { book: 'hardrockbet', american: -170 }],
  );
  expectSoft(home, 'consensus');
  const mean = (powerP(140, -160) + powerP(150, -170)) / 2;
  assert.strictEqual(home.p_fair, stamp(mean));
  const w = home.anchorWeight;
  // coverProb is the unrounded blend. p_fair on the row is stamped to 6 decimals.
  assert.ok(Math.abs(home.coverProb - (w * 0.5 + (1 - w) * mean)) < 1e-12);
}

// Hard Rock alone is retail, not a sharp book.
{
  const [home] = runPair(
    [{ book: 'hardrockbet', american: -110 }],
    [{ book: 'hardrockbet', american: -110 }],
    { book: 'hardrockbet', odds: -110 },
    { book: 'hardrockbet', odds: -110 },
  );
  expectSoft(home, 'hardrockbet');
  assert.strictEqual(home.p_fair, stamp(0.5));
}

// FanDuel + BetMGM + Caesars is still a retail-only consensus.
{
  const [home] = runPair(
    [
      { book: 'fanduel', american: -130 },
      { book: 'betmgm', american: -125 },
      { book: 'caesars', american: -120 },
    ],
    [
      { book: 'fanduel', american: 110 },
      { book: 'betmgm', american: 105 },
      { book: 'caesars', american: 100 },
    ],
    { book: 'fanduel', odds: -130 },
    { book: 'fanduel', odds: 110 },
  );
  expectSoft(home, 'consensus');
  const mean = (powerP(-130, 110) + powerP(-125, 105) + powerP(-120, 100)) / 3;
  assert.strictEqual(home.p_fair, stamp(mean));
}

// DK + bookmaker. The sharp book wins. DK is not mixed into the fair.
// Edge, stake EV, and EV@fair use the row's retail price, not bookmaker.
{
  const retail = -105;
  const [home, away] = runPair(
    [{ book: 'draftkings', american: 140 }, { book: 'bookmaker', american: 150 }],
    [{ book: 'draftkings', american: -160 }, { book: 'bookmaker', american: -165 }],
    { odds: retail, book: 'hardrockbet', pPush: 0.08 },
    { odds: retail, book: 'hardrockbet' },
  );
  expectSharp(home, 'sharp-books');
  expectSharp(away, 'sharp-books');
  const bm = powerP(150, -165);
  const dk = powerP(140, -160);
  assert.strictEqual(home.p_fair, stamp(bm));
  assert.ok(Math.abs(home.p_fair - dk) > 0.01);
  assert.ok(Math.abs(home.p_fair + away.p_fair - 1) < 1e-6);
  assert.strictEqual(home.odds, retail);
  const priced = priceEdgeAtBet(home);
  assert.strictEqual(priced.odds, retail);
  assert.strictEqual(priced.book, 'hardrockbet');
  const edgeRetail = +(priced.coverProb - americanToImplied(retail)).toFixed(6);
  const edgeSharp = +(priced.coverProb - americanToImplied(150)).toFixed(6);
  assert.strictEqual(priced.edgePct, edgeRetail);
  assert.notStrictEqual(priced.edgePct, edgeSharp);
  const evRetail = +pushAwareEv(priced.coverProb, retail, 0.08).toFixed(6);
  const evSharp = +pushAwareEv(priced.coverProb, 150, 0.08).toFixed(6);
  assert.strictEqual(priced.ev, evRetail);
  assert.notStrictEqual(priced.ev, evSharp);
  const printed = fairPickFields(priced);
  assert.strictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, retail, 0.08)));
  assert.notStrictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, 150, 0.08)));
  assert.notStrictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, 140, 0.08)));
}

// FanDuel + Caesars + bookmaker. Still sharp-books, and only bookmaker.
{
  const [home] = runPair(
    [
      { book: 'fanduel', american: -130 },
      { book: 'caesars', american: -120 },
      { book: 'bookmaker', american: -140 },
    ],
    [
      { book: 'fanduel', american: 110 },
      { book: 'caesars', american: 100 },
      { book: 'bookmaker', american: 120 },
    ],
    { book: 'fanduel', odds: -108 },
    { book: 'fanduel', odds: -108 },
  );
  expectSharp(home, 'sharp-books');
  assert.strictEqual(home.p_fair, stamp(powerP(-140, 120)));
  assert.ok(Math.abs(home.p_fair - powerP(-130, 110)) > 0.01);
  const printed = fairPickFields(home);
  assert.strictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, -108, home.pPush)));
  assert.notStrictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, -140, home.pPush)));
}

// lowvig alone is a sharp reference, even as the only book.
{
  const [home] = runPair(
    [{ book: 'lowvig', american: -115 }],
    [{ book: 'lowvig', american: -105 }],
    { book: 'draftkings', odds: -110 },
    { book: 'draftkings', odds: -110 },
  );
  expectSharp(home, 'sharp-books');
  assert.strictEqual(home.p_fair, stamp(powerP(-115, -105)));
  const printed = fairPickFields(home);
  assert.strictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, -110, home.pPush)));
  assert.notStrictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, -115, home.pPush)));
}

// Mixed-book pair is not a market. DK one side, Hard Rock the other.
{
  const [home, away] = runPair(
    [{ book: 'draftkings', american: 140 }],
    [{ book: 'hardrockbet', american: -170 }],
  );
  assert.strictEqual(home.anchorFairSource, 'none');
  assert.strictEqual(away.anchorFairSource, 'none');
  assert.strictEqual(home.fairQuality, 'none');
  assert.strictEqual(away.fairQuality, 'none');
  assert.strictEqual(home.fairSoft, false);
  assert.strictEqual(home.evAtFairValid, false);
  assert.strictEqual(home.p_fair, null);
  assert.strictEqual(home.coverProb, 0.5);
  assert.strictEqual(fairPickFields(home).evAtFair, null);
  assert.strictEqual(fairPickFields(home).fairSource, 'none');
  assert.strictEqual(fairPickFields(home).fairQuality, 'none');
}

// Pinnacle on one side only does not beat a two-sided DraftKings pair.
{
  const [home] = runPair(
    [{ book: 'draftkings', american: 140 }, { book: 'pinnacle', american: 145 }],
    [{ book: 'draftkings', american: -160 }],
  );
  expectSoft(home, 'draftkings');
  assert.strictEqual(home.p_fair, stamp(powerP(140, -160)));
  assert.ok(Math.abs(home.p_fair - powerP(145, -160)) > 1e-4);
  assert.strictEqual(home.odds, 140);
}

// Pinnacle both sides. Numeric EV@fair at the retail quote, not at Pinnacle.
{
  const retail = -105;
  const pinSide = -150;
  const pinOpp = 130;
  const [home] = applyMarketAnchor([{
    sport: 'NFL',
    market: 'Spread',
    side: 'Home -3',
    line: -3,
    matchup: 'A @ B',
    awayTeam: 'A',
    homeTeam: 'B',
    commenceTime: 't',
    odds: retail,
    book: 'hardrockbet',
    modelPureP: 0.62,
    coverProb: 0.70,
    pPush: 0.0747,
    pinnacleSide: { american: pinSide, oppAmerican: pinOpp, point: -3, oppPoint: 3 },
    bookPrices: [
      { book: 'draftkings', american: -130, point: -3 },
      { book: 'pinnacle', american: pinSide, point: -3 },
    ],
  }]);
  expectSharp(home, 'pinnacle');
  // p_fair is stamped to 6 decimals on the row; the raw power fair is finer.
  assert.strictEqual(home.p_fair, stamp(powerP(pinSide, pinOpp)));
  assert.strictEqual(home.odds, retail);
  assert.strictEqual(home.book, 'hardrockbet');
  const w = home.anchorWeight;
  const rawFair = powerP(pinSide, pinOpp);
  // coverProb blends the unrounded fair. p_fair on the row is stamped to 6 decimals.
  assert.ok(Math.abs(home.coverProb - (w * 0.62 + (1 - w) * rawFair)) < 1e-12);
  const priced = priceEdgeAtBet(home);
  assert.strictEqual(priced.odds, retail);
  assert.strictEqual(priced.edgePct, +(priced.coverProb - americanToImplied(retail)).toFixed(6));
  assert.notStrictEqual(priced.edgePct, +(priced.coverProb - americanToImplied(pinSide)).toFixed(6));
  assert.strictEqual(priced.ev, +pushAwareEv(priced.coverProb, retail, 0.0747).toFixed(6));
  assert.notStrictEqual(priced.ev, +pushAwareEv(priced.coverProb, pinSide, 0.0747).toFixed(6));
  assert.notStrictEqual(priced.ev, +(priced.coverProb * americanToDecimal(retail) - 1).toFixed(6));
  const printed = fairPickFields(priced);
  assert.strictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, retail, 0.0747)));
  assert.notStrictEqual(printed.evAtFair, formatEdgePct(pushAwareEv(home.p_fair, pinSide, 0.0747)));
  assert.notStrictEqual(printed.evAtFair, SOFT_EV);
  const pub = pickPublic(toPickObject(priced));
  assert.strictEqual(pub.fairSource, 'pinnacle');
  assert.strictEqual(pub.fairQuality, 'sharp');
  assert.strictEqual(pub.evAtFairValid, true);
  assert.strictEqual(pub.evAtFair, printed.evAtFair);
}

// Parlay EV@fair is null when any leg is a soft fair. Two sharp legs keep the product
// at each leg's bet decimal, not at the sharp book's price.
{
  const [soft] = runPair(
    [{ book: 'draftkings', american: 140 }, { book: 'hardrockbet', american: 150 }],
    [{ book: 'draftkings', american: -160 }, { book: 'hardrockbet', american: -170 }],
  );
  const sharpA = applyMarketAnchor([{
    sport: 'NFL', market: 'Moneyline', side: 'A', matchup: 'A @ B',
    awayTeam: 'A', homeTeam: 'B', commenceTime: 't1',
    odds: -110, book: 'draftkings', modelPureP: 0.55, coverProb: 0.55,
    pinnacleSide: { american: -120, oppAmerican: 100, point: null, oppPoint: null },
  }])[0];
  const sharpB = applyMarketAnchor([{
    sport: 'NHL', market: 'Moneyline', side: 'C', matchup: 'C @ D',
    awayTeam: 'C', homeTeam: 'D', commenceTime: 't2',
    odds: 100, book: 'hardrockbet', modelPureP: 0.48, coverProb: 0.48,
    pinnacleSide: { american: -130, oppAmerican: 110, point: null, oppPoint: null },
  }])[0];
  assert.strictEqual(sharpA.evAtFairValid, true);
  assert.strictEqual(sharpB.evAtFairValid, true);
  assert.strictEqual(soft.evAtFairValid, false);
  const both = comboStats([sharpA, sharpB]);
  const payout = americanToDecimal(sharpA.odds) * americanToDecimal(sharpB.odds);
  assert.ok(Math.abs(both.evAtFair - (sharpA.p_fair * sharpB.p_fair * payout - 1)) < 1e-12);
  const pinPayout = americanToDecimal(-120) * americanToDecimal(-130);
  assert.ok(Math.abs(both.evAtFair - (sharpA.p_fair * sharpB.p_fair * pinPayout - 1)) > 1e-4);
  const mixed = comboStats([sharpA, soft]);
  assert.strictEqual(mixed.evAtFair, null);
  assert.ok(Number.isFinite(mixed.ev));
  const legacy = { coverProb: 0.56, odds: -110, p_fair: 0.53, sport: 'NFL', matchup: 'E @ F' };
  const dec = americanToDecimal(-110);
  const kept = comboStats([legacy, { ...legacy, matchup: 'G @ H' }]);
  assert.ok(Math.abs(kept.evAtFair - (0.53 * 0.53 * dec * dec - 1)) < 1e-12);
  const blocked = comboStats([legacy, { ...legacy, matchup: 'G @ H', evAtFairValid: false }]);
  assert.strictEqual(blocked.evAtFair, null);
}

console.log('test-omega-fair-soft-1018c ok');
