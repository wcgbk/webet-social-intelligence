'use strict';
// Hard Rock placeability is the candidate's line, not the nearest quote.
// A total at 5.5 with a Hard Rock point of 6.5 is not placeable and is swapped
// for the next edge-ranked distinct game that Hard Rock offers at that line.
const assert = require('assert');
const { hasHardRockPrice, ensureParlayPlaceable } = require('./netlify/functions/lib/omega-vnext/selection_pass');

function row(matchup, extra) {
  const parts = matchup.split(' @ ');
  return {
    sport: extra.sport || 'NHL',
    matchup,
    side: extra.side,
    market: extra.market || 'Moneyline',
    odds: extra.odds == null ? -110 : extra.odds,
    line: extra.line == null ? null : extra.line,
    coverProb: extra.coverProb == null ? 0.56 : extra.coverProb,
    edgePct: extra.edgePct,
    ev: extra.ev == null ? 0.04 : extra.ev,
    homeTeam: parts[1],
    awayTeam: parts[0],
    book: 'draftkings',
    hardRock: extra.hardRock,
    bookPrices: extra.bookPrices,
  };
}

const wrongTotal = row('Jets @ Oilers', {
  market: 'Total', side: 'Over 5.5', line: 5.5, edgePct: 0.07,
  hardRock: { american: -115, point: 6.5 },
});
const sameTotal = row('Ducks @ Bruins', {
  market: 'Total', side: 'Over 6.5', line: 6.5, edgePct: 0.04,
  hardRock: { american: -110, point: 6.5 },
});
const moneyline = row('Penguins @ Avalanche', {
  market: 'Moneyline', side: 'Avalanche', line: null, edgePct: 0.05,
  hardRock: { american: -145, point: null },
});
const sameSpread = row('Kings @ Flames', {
  market: 'Spread', side: 'Flames -1.5', line: -1.5, edgePct: 0.045,
  hardRock: { american: -105, point: -1.5 },
});
const nearSpread = row('Rangers @ Lightning', {
  market: 'Spread', side: 'Lightning -1.5', line: -1.5, edgePct: 0.06,
  hardRock: { american: -110, point: -2 },
});
const decoy = row('Stars @ Wild', {
  market: 'Total', side: 'Over 5.5', line: 5.5, edgePct: 0.11,
  hardRock: { american: -120, point: 6.5 },
});
const bookMismatch = row('Senators @ Maple Leafs', {
  market: 'Total', side: 'Under 6.5', line: 6.5, edgePct: 0.05,
  bookPrices: [{ book: 'hardrockbet', american: -110, point: 5.5 }],
});
const bookMatch = row('Canucks @ Kraken', {
  market: 'Total', side: 'Under 6.5', line: 6.5, edgePct: 0.05,
  bookPrices: [{ book: 'hardrockbet', american: -110, point: 6.5 }],
});
const bookNoPoint = row('Sabres @ Devils', {
  market: 'Moneyline', side: 'Devils', line: null, edgePct: 0.05,
  bookPrices: [{ book: 'hardrockbet', american: -130 }],
});

assert.strictEqual(hasHardRockPrice(wrongTotal), false);
assert.strictEqual(hasHardRockPrice(decoy), false);
assert.strictEqual(hasHardRockPrice(nearSpread), false);
assert.strictEqual(hasHardRockPrice(sameTotal), true);
assert.strictEqual(hasHardRockPrice(sameSpread), true);
assert.strictEqual(hasHardRockPrice(moneyline), true);
assert.strictEqual(hasHardRockPrice(bookMismatch), false);
assert.strictEqual(hasHardRockPrice(bookMatch), true);
assert.strictEqual(hasHardRockPrice(bookNoPoint), true);
assert.strictEqual(hasHardRockPrice({
  ...sameSpread,
  hardRock: { american: -105, point: -1.5 + 1e-12 },
}), true);
assert.strictEqual(hasHardRockPrice({
  ...sameSpread,
  hardRock: { american: -105, point: -1.5 + 1e-6 },
}), false);

// The bad Over 5.5 is on the ticket. A higher-edge decoy quotes a different
// total, so the swap takes the next distinct game Hard Rock offers at its line.
const straights = [moneyline, wrongTotal, sameSpread];
const pool = [decoy, wrongTotal, moneyline, sameSpread, sameTotal, nearSpread];
const out = ensureParlayPlaceable(straights, pool);
assert.strictEqual(out.changed, true);
assert.strictEqual(out.straights[0].matchup, moneyline.matchup);
assert.strictEqual(out.straights[2].matchup, sameSpread.matchup);
assert.strictEqual(out.straights[1].matchup, sameTotal.matchup);
assert.notStrictEqual(out.straights[1].matchup, decoy.matchup);
assert.notStrictEqual(out.straights[1].matchup, wrongTotal.matchup);
assert.ok(hasHardRockPrice(out.straights[1]));
assert.strictEqual(out.bugs.length, 1);
assert.strictEqual(out.bugs[0].action, 'swapped');
assert.strictEqual(out.bugs[0].replacement.matchup, sameTotal.matchup);

// A same-line total stays. Nothing is swapped.
const kept = ensureParlayPlaceable(
  [moneyline, sameTotal, sameSpread],
  [decoy, moneyline, sameTotal, sameSpread],
);
assert.strictEqual(kept.changed, false);
assert.deepStrictEqual(kept.straights.map((c) => c.matchup), [
  moneyline.matchup, sameTotal.matchup, sameSpread.matchup,
]);
assert.strictEqual(kept.bugs.length, 0);
