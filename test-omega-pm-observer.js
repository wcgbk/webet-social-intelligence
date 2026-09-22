'use strict';
/** Omega v12.2.2 PM observer — mapping + never-mutates picks. No network required. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const pm = require(path.join(root, 'pm_observer'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.4-omega-vnext-replay-asof');
assert.ok(/pm.?observer|Kalshi\/Polymarket OBSERVER/i.test(config.MODEL_NOTES));
assert.ok(config.MODEL_NOTES.includes('NEVER') || /never mixes|NEVER mixes/i.test(config.MODEL_NOTES));

// Team matching
assert.ok(pm.teamsMatch('New York Yankees', 'NY Yankees'));
assert.ok(pm.teamsMatch('Los Angeles Dodgers', 'LA Dodgers'));
assert.ok(!pm.teamsMatch('New York Yankees', 'Boston Red Sox'));

assert.strictEqual(pm.isMoneylineCandidate({ market: 'Moneyline', side: 'Yankees' }), true);
assert.strictEqual(pm.isMoneylineCandidate({ market: 'Spread', side: 'Yankees -1.5' }), false);
assert.strictEqual(pm.isMoneylineCandidate({ market: 'Total', side: 'Over 8.5' }), false);

const candidate = {
  sport: 'MLB',
  market: 'Moneyline',
  homeTeam: 'New York Yankees',
  awayTeam: 'Tampa Bay Rays',
  side: 'New York Yankees',
  matchup: 'Tampa Bay Rays @ New York Yankees',
  rating: 'A',
  units: '1.0u',
  edgePct: '3.2%',
  ev: 0.04,
  coverProb: 0.55,
};

const polyMarkets = [
  {
    id: 'poly-1',
    slug: 'mlb-tb-nyy-2026-09-22',
    question: 'Tampa Bay Rays vs. New York Yankees',
    sportsMarketType: 'moneyline',
    outcomes: JSON.stringify(['Tampa Bay Rays', 'New York Yankees']),
    outcomePrices: JSON.stringify(['0.445', '0.555']),
    volume24hr: 120000,
    liquidity: 50000,
  },
  {
    id: 'poly-noise',
    slug: 'mlb-bos-bal-2026-09-22',
    question: 'Boston Red Sox vs. Baltimore Orioles',
    sportsMarketType: 'moneyline',
    outcomes: JSON.stringify(['Boston Red Sox', 'Baltimore Orioles']),
    outcomePrices: JSON.stringify(['0.5', '0.5']),
  },
];

const mappedPoly = pm.mapPolymarketMoneyline(candidate, polyMarkets);
assert.ok(mappedPoly, 'expected clean 1:1 polymarket map');
assert.strictEqual(mappedPoly.venue, 'polymarket');
assert.ok(Math.abs(mappedPoly.impliedPick - 0.555) < 1e-9);

// Ambiguous (2 markets for same teams) → null
const ambiguous = pm.mapPolymarketMoneyline(candidate, [
  ...polyMarkets,
  { ...polyMarkets[0], id: 'poly-dup', slug: 'mlb-tb-nyy-dup' },
]);
assert.strictEqual(ambiguous, null, 'ambiguous maps must be rejected');

const kalshiMarkets = [
  {
    ticker: 'KXMLBGAME-TBANYY-NYY',
    event_ticker: 'KXMLBGAME-TBANYY',
    yes_sub_title: 'New York Yankees',
    last_price: 56,
    yes_bid: 55,
    yes_ask: 57,
    volume: 900,
    open_interest: 400,
    _sport: 'MLB',
  },
  {
    ticker: 'KXMLBGAME-TBANYY-TBA',
    event_ticker: 'KXMLBGAME-TBANYY',
    yes_sub_title: 'Tampa Bay Rays',
    last_price: 44,
    yes_bid: 43,
    yes_ask: 45,
    volume: 800,
    open_interest: 350,
    _sport: 'MLB',
  },
];

const mappedKalshi = pm.mapKalshiMoneyline(candidate, kalshiMarkets);
assert.ok(mappedKalshi, 'expected clean 1:1 kalshi map');
assert.strictEqual(mappedKalshi.venue, 'kalshi');
assert.ok(Math.abs(mappedKalshi.impliedPick - 0.56) < 1e-9);

const picks = [{ ...candidate, pick: 'New York Yankees' }];
const before = picks.map((p) => ({ ...p }));
const notes = pm.buildObserverNotes([candidate], { polyMarkets, kalshiMarkets });
assert.ok(notes.length >= 1);
assert.ok(notes[0].polymarket || notes[0].kalshi);
// Snapshot frozen — observer must not write back into picks
pm.assertNeverMutatesPicks(before, picks);
assert.strictEqual(picks[0].rating, 'A');
assert.strictEqual(picks[0].units, '1.0u');
assert.strictEqual(picks[0].edgePct, '3.2%');
assert.strictEqual(picks[0].ev, 0.04);
assert.strictEqual(picks[0].coverProb, 0.55);

// Mutate detection works
assert.throws(() => {
  pm.assertNeverMutatesPicks(before, [{ ...picks[0], units: '9.9u' }]);
}, /mutated/);

assert.throws(() => {
  pm.assertNeverMutatesPicks(before, [{ ...picks[0], rating: 'aplus' }]);
}, /mutated/);

assert.throws(() => {
  pm.assertNeverMutatesPicks(before, [{ ...picks[0], edgePct: '99%' }]);
}, /mutated/);

assert.throws(() => {
  pm.assertNeverMutatesPicks(before, [{ ...picks[0], ev: 0.99 }]);
}, /mutated/);

console.log('test-omega-pm-observer: OK');
