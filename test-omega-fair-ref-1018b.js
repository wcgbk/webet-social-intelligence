'use strict';
// Fair reference: Pinnacle, then other sharp books, then a same-book consensus.
const assert = require('assert');
const { americanToImplied, noVigTwoWay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { powerTwoWay } = require('./netlify/functions/lib/omega-vnext/sharp_fair');
const { powerFair } = require('./netlify/functions/lib/omega-vnext/pure_model');
const {
  applyMarketAnchor, fairPickFields, anchorProbability,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { comboStats } = require('./netlify/functions/lib/omega-vnext/parlay');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');

function powerP(a1, a2) {
  const powered = powerTwoWay(americanToImplied(a1), americanToImplied(a2));
  assert.ok(powered, `${a1}/${a2}`);
  return powered.p1;
}

function stamp(p) {
  return +Number(p).toFixed(6);
}

function side(extra) {
  return {
    sport: 'NFL',
    market: 'Spread',
    matchup: 'Away @ Home',
    awayTeam: 'Away',
    homeTeam: 'Home',
    commenceTime: '2026-10-18T17:00:00Z',
    modelPureP: 0.62,
    coverProb: 0.70,
    odds: -105,
    book: 'hardrockbet',
    ...extra,
  };
}

function pair(homeExtra, awayExtra) {
  const home = side({ side: 'Home', line: -3, ...homeExtra });
  const away = side({ side: 'Away', line: 3, modelPureP: 0.40, coverProb: 0.38, ...awayExtra });
  return applyMarketAnchor([home, away]);
}

// Pinnacle present: power no-vig, even when other books also post both sides.
{
  const pin = { american: -110, oppAmerican: -110, point: -3, oppPoint: 3 };
  const [home, away] = pair(
    {
      pinnacleSide: pin,
      bookPrices: [
        { book: 'pinnacle', american: -150, point: -3 },
        { book: 'bookmaker', american: -140, point: -3 },
        { book: 'draftkings', american: -130, point: -3 },
      ],
    },
    {
      pinnacleSide: { american: -110, oppAmerican: -110, point: 3, oppPoint: -3 },
      bookPrices: [
        { book: 'pinnacle', american: 130, point: 3 },
        { book: 'bookmaker', american: 120, point: 3 },
        { book: 'draftkings', american: 110, point: 3 },
      ],
    },
  );
  assert.strictEqual(home.anchorFairSource, 'pinnacle');
  assert.strictEqual(away.anchorFairSource, 'pinnacle');
  const fair = powerFair({ pinnacleSide: pin });
  assert.strictEqual(home.p_fair, stamp(fair));
  assert.ok(Math.abs(home.p_fair - 0.5) < 1e-9);
  assert.ok(Math.abs(home.coverProb - anchorProbability(0.62, fair, home.anchorWeight)) < 1e-12);
  assert.strictEqual(home.odds, -105);
  assert.strictEqual(home.book, 'hardrockbet');
}

// Pinnacle absent, two sharp books: unweighted mean of each book's power fair.
// DraftKings on the same rows is not in that mean.
{
  const [home, away] = pair(
    {
      bookPrices: [
        { book: 'bookmaker', american: -130, point: -3 },
        { book: 'betonlineag', american: -120, point: -3 },
        { book: 'lowvig', american: -110, point: -7 },
        { book: 'draftkings', american: -160, point: -3 },
      ],
    },
    {
      bookPrices: [
        { book: 'bookmaker', american: 110, point: 3 },
        { book: 'betonlineag', american: 100, point: 3 },
        { book: 'lowvig', american: -110, point: 7 },
        { book: 'draftkings', american: 140, point: 3 },
      ],
    },
  );
  const bm = powerP(-130, 110);
  const bo = powerP(-120, 100);
  const dk = powerP(-160, 140);
  const mean = (bm + bo) / 2;
  assert.strictEqual(home.anchorFairSource, 'sharp-books');
  assert.strictEqual(away.anchorFairSource, 'sharp-books');
  assert.strictEqual(home.p_fair, stamp(mean));
  assert.ok(Math.abs(home.p_fair - dk) > 0.01, 'DraftKings is not mixed into the sharp mean');
  assert.ok(Math.abs(home.p_fair + away.p_fair - 1) < 1e-6);
  assert.strictEqual(home.odds, -105);
}

// Pinnacle absent, DraftKings and Hard Rock both post the line: consensus mean.
{
  const [home] = pair(
    {
      odds: -105,
      book: 'hardrockbet',
      dkQuote: { book: 'draftkings', american: -130, point: -3 },
      hardRock: { american: -110, point: -3 },
      bookPrices: [
        { book: 'draftkings', american: -130, point: -3 },
        { book: 'hardrockbet', american: -110, point: -3 },
      ],
    },
    {
      dkQuote: { book: 'draftkings', american: 110, point: 3 },
      hardRock: { american: -110, point: 3 },
      bookPrices: [
        { book: 'draftkings', american: 110, point: 3 },
        { book: 'hardrockbet', american: -110, point: 3 },
      ],
    },
  );
  const dk = powerP(-130, 110);
  const hr = powerP(-110, -110);
  const mean = (dk + hr) / 2;
  assert.strictEqual(home.anchorFairSource, 'consensus');
  assert.strictEqual(home.p_fair, stamp(mean));
  assert.ok(Math.abs(home.p_fair - dk) > 1e-4);
  assert.ok(Math.abs(home.p_fair - hr) > 1e-4);
  assert.strictEqual(home.odds, -105);
  assert.strictEqual(home.book, 'hardrockbet');
  const printed = fairPickFields(home);
  // 2026-10-18: DK+Hard Rock is a retail-only consensus, so EV@fair is not a number.
  assert.strictEqual(printed.fairSource, 'consensus-soft');
  assert.strictEqual(printed.fairQuality, 'soft');
  assert.strictEqual(printed.fairSoft, true);
  assert.strictEqual(printed.evAtFairValid, false);
  assert.strictEqual(printed.evAtFair, 'n/a (soft fair)');
  assert.strictEqual(printed.p_fair, home.p_fair);
  assert.ok(Math.abs(home.p_fair - dk) > 1e-4);
  const pick = toPickObject(home);
  assert.strictEqual(pick.fairSource, 'consensus-soft');
  assert.strictEqual(pick.evAtFair, printed.evAtFair);
}

// Only DraftKings: the book name, power de-vig, not the proportional split.
{
  const [home] = pair(
    { book: 'draftkings', odds: -130, bookPrices: [{ book: 'draftkings', american: -130, point: -3 }] },
    { book: 'draftkings', odds: 110, bookPrices: [{ book: 'draftkings', american: 110, point: 3 }] },
  );
  const powered = powerP(-130, 110);
  const proportional = noVigTwoWay(-130, 110).p1;
  assert.ok(Math.abs(powered - proportional) > 1e-4);
  assert.strictEqual(home.anchorFairSource, 'draftkings');
  assert.strictEqual(home.p_fair, stamp(powered));
  assert.notStrictEqual(home.p_fair, stamp(proportional));
  const printed = fairPickFields(home);
  // 2026-10-18: a single retail book is a soft fair, so EV@fair is not a number.
  assert.strictEqual(printed.fairSource, 'draftkings-soft');
  assert.strictEqual(printed.fairQuality, 'soft');
  assert.strictEqual(printed.evAtFairValid, false);
  assert.strictEqual(printed.evAtFair, 'n/a (soft fair)');
}

// Mixed-book pairs are not a market. DK on one side and Hard Rock on the other stay 'none'.
{
  const [home, away] = pair(
    { book: 'draftkings', odds: -110, bookPrices: [{ book: 'draftkings', american: -110, point: -3 }] },
    { book: 'hardrockbet', odds: -110, bookPrices: [{ book: 'hardrockbet', american: -110, point: 3 }] },
  );
  assert.strictEqual(home.anchorFairSource, 'none');
  assert.strictEqual(away.anchorFairSource, 'none');
  assert.strictEqual(home.p_fair, null);
  assert.strictEqual(home.coverProb, 0.70);
  assert.strictEqual(away.coverProb, 0.38);
}

// Hard Rock on one side only does not pull a two-way DraftKings fair.
{
  const [home] = pair(
    {
      book: 'draftkings',
      odds: -130,
      bookPrices: [
        { book: 'draftkings', american: -130, point: -3 },
        { book: 'hardrockbet', american: -200, point: -3 },
      ],
    },
    {
      book: 'draftkings',
      odds: 110,
      bookPrices: [{ book: 'draftkings', american: 110, point: 3 }],
    },
  );
  assert.strictEqual(home.anchorFairSource, 'draftkings');
  assert.strictEqual(home.p_fair, stamp(powerP(-130, 110)));
}

// A retail-only fair leg nulls the parlay EV@fair. p_fair stays the consensus, not DK-only.
{
  const [home] = pair(
    {
      odds: -110,
      dkQuote: { american: -130, point: -3 },
      hardRock: { american: -110, point: -3 },
    },
    {
      odds: -110,
      dkQuote: { american: 110, point: 3 },
      hardRock: { american: -110, point: 3 },
    },
  );
  const other = {
    sport: 'NHL', matchup: 'C @ D', odds: 100, coverProb: 0.48,
    p_fair: 0.47, anchorFairSource: 'pinnacle',
  };
  const stats = comboStats([home, other]);
  // 2026-10-18: one retail-only leg makes the parlay EV@fair null. p_fair stays the consensus.
  assert.strictEqual(home.evAtFairValid, false);
  assert.strictEqual(stats.evAtFair, null);
  const dk = powerP(-130, 110);
  assert.ok(Math.abs(home.p_fair - dk) > 1e-4);
}

console.log('test-omega-fair-ref-1018b ok');
