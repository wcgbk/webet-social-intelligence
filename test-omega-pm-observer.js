'use strict';
/** Omega PM observer + v12.3.6 soft score features. No network required. */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const pm = require(path.join(root, 'pm_observer'));
const select = require(path.join(root, 'select'));
const store = require(path.join(root, 'store'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.12-omega-vnext-desk-lock');
assert.ok(/v12\.3\.6/.test(config.MODEL_NOTES));
assert.ok(/soft feature/i.test(config.MODEL_NOTES));
assert.ok(/hard cap/i.test(config.MODEL_NOTES));
assert.ok(/soft-fail/i.test(config.MODEL_NOTES));
assert.ok(/No TSP/.test(config.MODEL_NOTES));
assert.ok(/No FIT/.test(config.MODEL_NOTES));
assert.ok(/pm observer|Kalshi\/Polymarket/i.test(config.MODEL_NOTES));
assert.ok(!/NEVER mixes PM prices into selection/i.test(config.MODEL_NOTES));
assert.ok(config.PM_SOFT.scoreWeightVsBook >= 0.15 && config.PM_SOFT.scoreWeightVsBook <= 0.25);
assert.ok(config.PM_SOFT.scoreWeightMove > 0 && config.PM_SOFT.scoreWeightMove < config.PM_SOFT.scoreWeightVsBook);
assert.ok(config.PM_SOFT.maxAbsScoreAdj >= 0.025 && config.PM_SOFT.maxAbsScoreAdj <= 0.04);
assert.strictEqual(config.PM_SOFT.venueCombine, 'average');
assert.ok(/hard-capped|_pmScoreAdj/.test(pm.OBSERVER_DISCLAIMER));
assert.ok(/does not mutate locked pick/i.test(pm.OBSERVER_DISCLAIMER));

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

assert.strictEqual(store.pmObserverStorageKey('2026-09-23', 'post'), 'omega-pm-observer/2026-09-23');
assert.strictEqual(store.pmObserverStorageKey('2026-09-23', 'open'), 'omega-pm-observer/2026-09-23-open');
assert.strictEqual(store.pmObserverAliasKey('2026-09-23', 'open'), 'pm-sidecar-2026-09-23-open');
assert.throws(() => store.pmObserverStorageKey('09-23', 'open'), /bad date/);

// --- soft features: gap, move, hard cap, soft-fail. Score only. ---
const ml = {
  ...candidate,
  odds: -110,
  fair_sharp_p: 0.52,
  coverProb: 0.55,
  edgePct: 0.03,
  ev: 0.04,
};

function polyAt(yankeesPrice) {
  const away = (1 - yankeesPrice).toFixed(3);
  return [{
    ...polyMarkets[0],
    outcomePrices: JSON.stringify([away, String(yankeesPrice)]),
  }];
}

const gapFeat = pm.computePmFeatures(ml, {
  polyMarkets: polyAt(0.60),
  kalshiMarkets: [],
});
// 0.60 − 0.52 = 0.08 gap × 0.20 = 0.016, under the cap. No prior → pmMove null.
assert.ok(Math.abs(gapFeat.pmFeatures.pmVsBookGap - 0.08) < 1e-6);
assert.strictEqual(gapFeat.pmFeatures.pmMove, null);
assert.strictEqual(gapFeat.pmFeatures.bookImpliedSource, 'fair_sharp_p');
assert.deepStrictEqual(gapFeat.pmFeatures.venues, ['polymarket']);
assert.ok(Math.abs(gapFeat._pmScoreAdj - (config.PM_SOFT.scoreWeightVsBook * 0.08)) < 1e-6);
assert.strictEqual(gapFeat.pmFeatures.capped, false);
assert.strictEqual(ml.coverProb, 0.55);
assert.strictEqual(ml.edgePct, 0.03);
assert.strictEqual(ml.ev, 0.04);

// American fallback when sharp fair is absent. -110 → ~0.52381.
const am = pm.computePmFeatures({ ...ml, fair_sharp_p: null, sharpFairP: null, odds: -110 }, {
  polyMarkets: polyAt(0.60),
  kalshiMarkets: [],
});
assert.strictEqual(am.pmFeatures.bookImpliedSource, 'american');
assert.ok(Math.abs(am.pmFeatures.bookImplied - (110 / 210)) < 1e-6);
assert.ok(am.pmFeatures.pmVsBookGap > 0);

// Average of both venues. Poly 0.60, Kalshi last 56 → 0.56. Mean 0.58.
const both = pm.computePmFeatures(ml, { polyMarkets: polyAt(0.60), kalshiMarkets });
assert.deepStrictEqual(both.pmFeatures.venues, ['polymarket', 'kalshi']);
assert.ok(Math.abs(both.pmFeatures.pmImplied - 0.58) < 1e-6);
assert.ok(Math.abs(both.pmFeatures.pmVsBookGap - 0.06) < 1e-6);

// pmMove: paired venues only. Open poly 0.50 / kalshi 0.52, now poly 0.60 / kalshi 0.56.
const openSnap = {
  polyMarkets: polyAt(0.50),
  kalshiMarkets: kalshiMarkets.map((m) => (
    /NYY/.test(m.ticker) ? { ...m, last_price: 52 } : { ...m, last_price: 48 }
  )),
};
const moved = pm.computePmFeatures(ml, {
  polyMarkets: polyAt(0.60),
  kalshiMarkets,
  priorArtifact: openSnap,
});
// poly +0.10, kalshi +0.04 → move 0.07. Gap uses current mean 0.58 − 0.52 = 0.06.
assert.ok(Math.abs(moved.pmFeatures.pmMove - 0.07) < 1e-6);
assert.ok(Math.abs(moved.pmFeatures.pmVsBookGap - 0.06) < 1e-6);
const expectedMoveAdj = config.PM_SOFT.scoreWeightVsBook * 0.06 + config.PM_SOFT.scoreWeightMove * 0.07;
assert.ok(Math.abs(moved._pmScoreAdj - expectedMoveAdj) < 1e-6);
assert.ok(Math.abs(moved._pmScoreAdj) < config.PM_SOFT.maxAbsScoreAdj);

// Venue only on one side does not invent a move. Prior is poly-only; kalshi is new.
const partialMove = pm.computePmFeatures(ml, {
  polyMarkets: polyAt(0.60),
  kalshiMarkets,
  priorArtifact: { polyMarkets: polyAt(0.50), kalshiMarkets: [] },
});
assert.ok(Math.abs(partialMove.pmFeatures.pmMove - 0.10) < 1e-6);
assert.ok(partialMove.pmFeatures.venues.includes('kalshi'));

// HARD CAP. 0.90 vs 0.52 is a huge gap; |adj| must equal the cap, not the raw weight.
const hot = pm.computePmFeatures({ ...ml, fair_sharp_p: 0.52 }, {
  polyMarkets: polyAt(0.90),
  kalshiMarkets: [],
});
assert.ok(hot.pmFeatures.pmVsBookGap > 0.3);
assert.strictEqual(hot._pmScoreAdj, config.PM_SOFT.maxAbsScoreAdj);
assert.strictEqual(hot.pmFeatures._pmScoreAdj, config.PM_SOFT.maxAbsScoreAdj);
assert.strictEqual(hot.pmFeatures.capped, true);
const cold = pm.computePmFeatures({ ...ml, fair_sharp_p: 0.70 }, {
  polyMarkets: polyAt(0.10),
  kalshiMarkets: [],
});
assert.ok(cold.pmFeatures.pmVsBookGap < -0.3);
assert.strictEqual(cold._pmScoreAdj, -config.PM_SOFT.maxAbsScoreAdj);
assert.strictEqual(cold.pmFeatures.capped, true);

// Missing map and non-ML → 0. Inputs not mutated.
const unmappedSrc = { ...ml };
const unmapped = pm.computePmFeatures(unmappedSrc, { polyMarkets: [], kalshiMarkets: [] });
assert.strictEqual(unmapped._pmScoreAdj, 0);
assert.strictEqual(unmapped.pmFeatures.reason, 'no-map');
assert.strictEqual(unmappedSrc.coverProb, 0.55);
assert.strictEqual(unmappedSrc.edgePct, 0.03);
const spread = pm.computePmFeatures({ ...ml, market: 'Spread', side: 'Yankees -1.5' }, {
  polyMarkets: polyAt(0.90),
  kalshiMarkets,
});
assert.strictEqual(spread._pmScoreAdj, 0);
assert.strictEqual(spread.pmFeatures.reason, 'not-moneyline');

// scoreCandidate adds _pmScoreAdj and does not let it change badge inputs.
const scoreBase = {
  ev: 0.04, predictedClv: 1.2, uncertainty: 0.12, sport: 'MLB', _steamScoreAdj: 0,
};
const s0 = select.scoreCandidate(scoreBase);
const sPos = select.scoreCandidate({ ...scoreBase, _pmScoreAdj: 0.012 });
const sNeg = select.scoreCandidate({ ...scoreBase, _pmScoreAdj: -0.012 });
assert.ok(Math.abs((sPos - s0) - 0.012) < 1e-12);
assert.ok(Math.abs((sNeg - s0) - (-0.012)) < 1e-12);
const sHuge = select.scoreCandidate({ ...scoreBase, _pmScoreAdj: 5 });
const sCold = select.scoreCandidate({ ...scoreBase, _pmScoreAdj: -5 });
assert.ok(Math.abs((sHuge - s0) - config.PM_SOFT.maxAbsScoreAdj) < 1e-12);
assert.ok(Math.abs((sCold - s0) - (-config.PM_SOFT.maxAbsScoreAdj)) < 1e-12);
const ranked = select.selectStraights([
  { ...scoreBase, matchup: 'A @ B', side: 'B', homeTeam: 'B', awayTeam: 'A', market: 'Moneyline', _pmScoreAdj: 0, coverProb: 0.55, odds: -110 },
  { ...scoreBase, matchup: 'C @ D', side: 'D', homeTeam: 'D', awayTeam: 'C', market: 'Moneyline', _pmScoreAdj: 0.02, coverProb: 0.55, odds: -110 },
], 1);
assert.strictEqual(ranked[0].matchup, 'C @ D');

const pickBase = {
  sport: 'MLB', matchup: 'Tampa Bay Rays @ New York Yankees',
  side: 'New York Yankees', market: 'Moneyline',
  odds: -110, oddsStr: '-110', coverProb: 0.55, ev: 0.04, edgePct: 0.03,
  homeTeam: 'New York Yankees', awayTeam: 'Tampa Bay Rays',
  predictedClv: 1.2, uncertainty: 0.12,
};
const plainPick = select.toPickObject(pickBase);
const adjPick = select.toPickObject({
  ...pickBase,
  _pmScoreAdj: config.PM_SOFT.maxAbsScoreAdj,
  pmFeatures: hot.pmFeatures,
});
assert.strictEqual(plainPick.units, adjPick.units);
assert.strictEqual(plainPick.rating, adjPick.rating);
assert.strictEqual(plainPick.edgePct, adjPick.edgePct);
assert.strictEqual(plainPick.coverProb, adjPick.coverProb);
assert.strictEqual(plainPick.ev, adjPick.ev);
assert.ok(adjPick.pmFeatures && adjPick.pmFeatures._pmScoreAdj === config.PM_SOFT.maxAbsScoreAdj);
assert.ok(!plainPick.pmFeatures);

async function main() {
  const src = { ...ml };
  const down = await pm.annotatePmSoftFeatures([src], {
    fetchPolymarketSportsMl: async () => { throw new Error('poly down'); },
    fetchKalshiSportsMl: async () => { throw new Error('kalshi down'); },
  });
  assert.strictEqual(down.candidates.length, 1);
  assert.strictEqual(down.candidates[0]._pmScoreAdj, 0);
  assert.strictEqual(down.candidates[0].pmFeatures.reason, 'no-map');
  assert.strictEqual(down.candidates[0].coverProb, 0.55);
  assert.strictEqual(down.candidates[0].edgePct, 0.03);
  assert.strictEqual(down.candidates[0].ev, 0.04);
  assert.strictEqual(src.coverProb, 0.55, 'annotate must not mutate the input');
  assert.strictEqual(src._pmScoreAdj, undefined);
  assert.strictEqual(down.sources.polymarket.ok, false);
  assert.strictEqual(down.sources.kalshi.ok, false);
  assert.ok(/poly down/.test(down.sources.polymarket.error));

  const open = await pm.buildPmOpenArtifact({
    dateISO: '2026-09-23',
    candidates: [],
    picks: [],
    modelVersion: config.MODEL_VERSION,
    fetchPolymarketSportsMl: async () => polyMarkets,
    fetchKalshiSportsMl: async () => ({ markets: kalshiMarkets, errors: [] }),
  });
  assert.strictEqual(open.slot, 'open');
  assert.ok(open.polyMarkets.length >= 1);
  assert.ok(open.kalshiMarkets.length >= 1);
  assert.strictEqual(open.mappedCount, 0, 'open snap does not require picks');
  const fromOpen = pm.computePmFeatures(ml, {
    polyMarkets: polyAt(0.60),
    kalshiMarkets,
    priorArtifact: open,
  });
  assert.ok(fromOpen.pmFeatures.pmMove != null, 'compact open snap must still map');
  assert.ok(Math.abs(fromOpen.pmFeatures.pmImplied - 0.58) < 1e-6);

  const locked = [{ ...candidate, pick: 'New York Yankees' }];
  const frozen = locked.map((p) => ({ ...p }));
  const obs = await pm.runPmObserver({
    dateISO: '2026-09-23',
    candidates: [candidate],
    picks: locked,
    polyMarkets,
    kalshiMarkets,
    modelVersion: config.MODEL_VERSION,
  });
  pm.assertNeverMutatesPicks(frozen, locked);
  assert.ok(obs.mappedCount >= 1);
  assert.ok(/hard-capped/.test(obs.disclaimer));
  assert.strictEqual(locked[0].rating, 'A');
  assert.strictEqual(locked[0].units, '1.0u');
  assert.strictEqual(locked[0].edgePct, '3.2%');
  assert.strictEqual(locked[0].ev, 0.04);
  assert.strictEqual(locked[0].coverProb, 0.55);

  const openLocked = [{ ...candidate, pick: 'New York Yankees' }];
  const openFrozen = openLocked.map((p) => ({ ...p }));
  const openWithPicks = await pm.buildPmOpenArtifact({
    dateISO: '2026-09-23',
    candidates: [candidate],
    picks: openLocked,
    fetchPolymarketSportsMl: async () => polyMarkets,
    fetchKalshiSportsMl: async () => ({ markets: kalshiMarkets, errors: [] }),
  });
  pm.assertNeverMutatesPicks(openFrozen, openLocked);
  assert.ok(openWithPicks.mappedCount >= 1);
  assert.strictEqual(openLocked[0].units, '1.0u');
  assert.strictEqual(openLocked[0].rating, 'A');
  assert.strictEqual(openLocked[0].edgePct, '3.2%');

  console.log('test-omega-pm-observer: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
