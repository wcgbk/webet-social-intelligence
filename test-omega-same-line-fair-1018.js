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
    odds: -110, coverProb: 0.55, liquid: true, book: 'hardrockbet', // -110: sheet-consistent (2.6pt edge, 5% EV); +105 at 55% was 12.8% EV = audit-flagged
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
// True-probability ranking (2026-10-18): equal coverProb, so the sourced
// Pinnacle row wins the tiebreak ahead of the higher-EV unsourced row.
// Old order ranked by stake EV and put Over 5.5 first.
assert.deepStrictEqual(
  selectStraights([main, other], 2).map((c) => c.side),
  ['Over 6.5', 'Over 5.5'],
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

const blankPoint = {
  ...kraken,
  pinnacleSide: { american: -114, oppAmerican: 101 },
};
assert.strictEqual(pinnacleFair(blankPoint), null);
const [blankOut] = applyMarketAnchor([blankPoint]);
assert.strictEqual(blankOut.anchorFairSource, 'none');

const { applyExecutionBook } = require('./netlify/functions/lib/omega-vnext/selection_pass');
const { enrichCandidateWithEdge } = require('./netlify/functions/lib/omega-vnext/edge');
const { buildFallbackNarrative } = require('./netlify/functions/lib/omega-vnext/narrate');

const hrOffNumber = applyExecutionBook([{
  sport: 'NCAAF', market: 'Total', side: 'Under 55', line: 55,
  coverProb: 0.565, matchup: 'Navy Midshipmen @ UTSA Roadrunners',
  bookPrices: [],
  hardRock: { american: -105, point: 54.5 },
}]);
assert.strictEqual(hrOffNumber.candidates.length, 0);

const sameNumber = applyExecutionBook([{
  sport: 'NCAAF', market: 'Total', side: 'Under 55', line: 55,
  coverProb: 0.565, matchup: 'Navy Midshipmen @ UTSA Roadrunners',
  bookPrices: [
    { book: 'hardrockbet', american: -115, point: 55 },
    { book: 'hardrockbet', american: 120, point: 54.5 },
  ],
  hardRock: { american: 120, point: 54.5 },
}]);
assert.strictEqual(sameNumber.candidates.length, 1);
assert.strictEqual(sameNumber.candidates[0].odds, -115);
assert.strictEqual(sameNumber.candidates[0].line, 55);
assert.strictEqual(sameNumber.candidates[0].side, 'Under 55');

const raw = {
  sport: 'NCAAF', market: 'Spread', side: 'Arkansas Razorbacks +6.5', line: 6.5,
  coverProb: 0.567, modelRawP: 0.567,
  homeTeam: 'Vanderbilt Commodores', awayTeam: 'Arkansas Razorbacks',
};
const bundle = {
  side: 'Arkansas Razorbacks', point: 6.5,
  prices: [{ book: 'betonlineag', american: -110 }],
};
const nearer = {
  side: 'Arkansas Razorbacks', point: 5.5,
  prices: [{ book: 'hardrockbet', american: -105 }],
};
const enriched = enrichCandidateWithEdge(raw, bundle, [bundle, nearer]);
assert.strictEqual(enriched.hardRock, null);

const sentence = buildFallbackNarrative({
  sport: 'NCAAF',
  pick: 'Arkansas Razorbacks +6.5',
  side: 'Arkansas Razorbacks +6.5',
  market: 'Spread',
  matchup: 'Arkansas Razorbacks @ Vanderbilt Commodores',
  awayTeam: 'Arkansas Razorbacks',
  homeTeam: 'Vanderbilt Commodores',
  odds: '-105',
  units: '1.5u',
  rating: 'aplus',
  winProbability: '56.7%',
  edgePct: '5.5%',
  ev: '10.7%',
  modelProjection: -0.8,
  line: 5.5,
});
assert.ok(sentence.includes('+6.5'), sentence);
assert.ok(!sentence.includes('+5.5'), sentence);

const totalSentence = buildFallbackNarrative({
  sport: 'NCAAF',
  pick: 'Under 55',
  market: 'Total',
  matchup: 'Navy Midshipmen @ UTSA Roadrunners',
  odds: '-105',
  units: '1.5u',
  rating: 'aplus',
  winProbability: '56.5%',
  edgePct: '5.3%',
  ev: '10.3%',
  modelProjection: 49.8,
  line: 54.5,
});
assert.ok(totalSentence.includes('55.0'), totalSentence);
assert.ok(!totalSentence.includes('54.5'), totalSentence);

console.log('test-omega-same-line-fair-1018 ok');
