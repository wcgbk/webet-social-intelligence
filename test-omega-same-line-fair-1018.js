'use strict';
// A Pinnacle pair prices only its own number. Over 6 is not a fair for Over 6.5.
const assert = require('assert');
const { pinnacleFair, applyMarketAnchor } = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { orderedByScore, selectStraights } = require('./netlify/functions/lib/omega-vnext/select');

const kraken = {
  sport: 'NHL',
  market: 'Total',
  side: 'Over 6.5',
  line: 6.5,
  odds: 105,
  book: 'hardrockbet',
  modelPureP: 0.55,
  coverProb: 0.55,
  matchup: 'Seattle Kraken @ Florida Panthers',
  awayTeam: 'Seattle Kraken',
  homeTeam: 'Florida Panthers',
  commenceTime: '2026-10-17T23:00:00Z',
  pinnacleSide: { american: -114, oppAmerican: 101, point: 6, oppPoint: 6 },
};

assert.strictEqual(pinnacleFair(kraken), null);
const [krakenOut] = applyMarketAnchor([kraken]);
assert.strictEqual(krakenOut.anchorFairSource, 'none');
assert.strictEqual(krakenOut.p_fair, null);
assert.strictEqual(krakenOut.coverProb, 0.55);

// A Pinnacle quote stored on the board at the other number does not fill this line.
const wrongBoard = {
  ...kraken,
  book: null,
  odds: null,
  bookPrices: [{ book: 'pinnacle', american: -114, point: 6 }],
};
const wrongOpp = {
  ...kraken,
  side: 'Under 6.5',
  modelPureP: 0.45,
  coverProb: 0.45,
  book: null,
  odds: null,
  pinnacleSide: { american: 101, oppAmerican: -114, point: 6, oppPoint: 6 },
  bookPrices: [{ book: 'pinnacle', american: 101, point: 6 }],
};
const [wrongOut] = applyMarketAnchor([wrongBoard, wrongOpp]);
assert.strictEqual(pinnacleFair(wrongBoard), null);
assert.strictEqual(wrongOut.anchorFairSource, 'none');
assert.strictEqual(wrongOut.p_fair, null);
assert.strictEqual(wrongOut.coverProb, 0.55);

// Hard Rock at 6.5 still prices 6.5 after the Pinnacle 6 pair is refused.
const retailOver = {
  ...kraken,
  bookPrices: [{ book: 'pinnacle', american: -114, point: 6 }],
};
const retailUnder = {
  ...kraken,
  side: 'Under 6.5',
  modelPureP: 0.45,
  coverProb: 0.45,
  odds: -130,
  pinnacleSide: { american: 101, oppAmerican: -114, point: 6, oppPoint: 6 },
  bookPrices: [{ book: 'pinnacle', american: 101, point: 6 }],
};
const [retailOut] = applyMarketAnchor([retailOver, retailUnder]);
assert.strictEqual(retailOut.anchorFairSource, 'hardrockbet');
assert.notStrictEqual(retailOut.anchorFairSource, 'pinnacle');

// The same number on the board is still a Pinnacle fair after the side pair misses.
const rightBoard = {
  ...kraken,
  bookPrices: [{ book: 'pinnacle', american: -114, point: 6.5 }],
};
const rightOpp = {
  ...wrongOpp,
  bookPrices: [{ book: 'pinnacle', american: 101, point: 6.5 }],
};
const [rightOut] = applyMarketAnchor([rightBoard, rightOpp]);
assert.strictEqual(pinnacleFair(rightBoard), null);
assert.strictEqual(rightOut.anchorFairSource, 'pinnacle');
assert.ok(rightOut.p_fair > 0 && rightOut.p_fair < 1);

const sameTotal = {
  ...kraken,
  pinnacleSide: { american: -114, oppAmerican: 101, point: 6.5, oppPoint: 6.5 },
};
const sameFair = pinnacleFair(sameTotal);
assert.ok(sameFair > 0 && sameFair < 1);
const [sameOut] = applyMarketAnchor([sameTotal]);
assert.strictEqual(sameOut.anchorFairSource, 'pinnacle');
assert.ok(Math.abs(sameOut.p_fair - sameFair) < 5e-7);

const spread = {
  sport: 'NFL', market: 'Spread', side: 'Home -3', line: -3,
  modelPureP: 0.55, coverProb: 0.55, odds: -110,
  matchup: 'Away @ Home',
  pinnacleSide: { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 },
};
assert.ok(Number.isFinite(pinnacleFair(spread)));
const dog = {
  ...spread,
  side: 'Away +3.5',
  line: 3.5,
  pinnacleSide: { american: -105, oppAmerican: -115, point: 3.5, oppPoint: -3.5 },
};
assert.ok(Number.isFinite(pinnacleFair(dog)));
const offNumber = {
  ...spread,
  line: -6.5,
  side: 'Home -6.5',
  pinnacleSide: { american: -110, oppAmerican: -110, point: -6, oppPoint: 6 },
};
assert.strictEqual(pinnacleFair(offNumber), null);

const ml = {
  sport: 'NHL', market: 'Moneyline', side: 'Florida Panthers', line: null,
  modelPureP: 0.60, coverProb: 0.60, odds: -120,
  matchup: 'Seattle Kraken @ Florida Panthers',
  pinnacleSide: { american: -120, oppAmerican: 100, point: null, oppPoint: null },
};
assert.ok(Number.isFinite(pinnacleFair(ml)));

function totalRow(side, line, ev, source, matchup) {
  const parts = matchup.split(' @ ');
  return {
    sport: 'NHL', market: 'Total', side, line, ev, edgePct: 0.04,
    anchorFairSource: source,
    matchup, awayTeam: parts[0], homeTeam: parts[1],
    odds: 105, coverProb: 0.55, liquid: true, book: 'hardrockbet',
    commenceTime: '2026-10-17T23:00:00Z',
  };
}

const game = 'Seattle Kraken @ Florida Panthers';
const alt = totalRow('Over 6', 6, 0.08, 'none', game);
const main = totalRow('Over 6.5', 6.5, 0.04, 'pinnacle', game);
assert.strictEqual(orderedByScore([alt, main])[0].side, 'Over 6.5');
assert.deepStrictEqual(
  selectStraights([alt, main], 1).map((c) => c.side),
  ['Over 6.5'],
);

const bothPin = totalRow('Under 6.5', 6.5, 0.07, 'pinnacle', game);
assert.strictEqual(orderedByScore([main, bothPin])[0].side, 'Under 6.5');

const other = totalRow('Over 5.5', 5.5, 0.09, 'none', 'Boston Bruins @ Toronto Maple Leafs');
assert.strictEqual(orderedByScore([main, other])[0].side, 'Over 5.5');
assert.deepStrictEqual(
  selectStraights([main, other], 2).map((c) => c.side),
  ['Over 5.5', 'Over 6.5'],
);

const spreadHi = {
  ...main,
  market: 'Puck Line',
  side: 'Florida -1.5',
  line: -1.5,
  ev: 0.03,
  anchorFairSource: 'pinnacle',
};
assert.strictEqual(orderedByScore([spreadHi, alt])[0].side, 'Over 6');

console.log('test-omega-same-line-fair-1018 ok');
