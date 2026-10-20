'use strict';
/**
 * v12.5.1: edge-space calibration clip, pre-cal miscalibration gate,
 * parlay legs reuse the straight grade/units, parlay stake off the per-game cap.
 * No network, no blobs.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const calibrate = require(path.join(root, 'calibrate'));
const edge = require(path.join(root, 'edge'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));

assert.strictEqual(config.MODEL_VERSION, 'v12.5.2-omega-vnext');

function evAt(p, american) {
  const dec = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return p * dec - 1;
}

// Kraken -1.5 +215: fair 0.2922, post-shrink 0.3036. The old p-clip lifted that
// to ~0.3909 and printed a fake +23% EV. Edge-space compression leaves p at the shrink.
{
  const fair = 0.2922;
  const shrunkTarget = 0.3036;
  const K = config.SHRINK_K.Spread;
  const modelRawP = (shrunkTarget - K * fair) / (1 - K);
  const row = calibrate.calibrateCandidate({
    sport: 'NHL', market: 'Spread', side: 'Seattle Kraken -1.5',
    matchup: 'Seattle Kraken @ Vancouver Canucks',
    modelRawP, fair_sharp_p: fair, odds: 215,
  });
  assert.ok(Math.abs(row.coverProb - shrunkTarget) < 1e-9, `kraken p ${row.coverProb}`);
  const attached = edge.attachEv(row);
  assert.ok(attached.ev < 0, `kraken EV ${attached.ev}`);
  assert.ok(evAt(row.coverProb, 215) < 0);
  const pulled = calibrate.isotonicClip(shrunkTarget);
  assert.ok(Math.abs(pulled - 0.3909) < 1e-3, `old clip ${pulled}`);
  assert.ok(row.coverProb < 0.32);
  assert.ok(evAt(pulled, 215) > 0.2, 'the retired clip was the fake edge');
}

// Oilers -1.5 +185: fair 0.326, shrunk 0.3308. Same bug, same fix.
{
  const fair = 0.326;
  const shrunkTarget = 0.3308;
  const K = config.SHRINK_K.Spread;
  const modelRawP = (shrunkTarget - K * fair) / (1 - K);
  const row = calibrate.calibrateCandidate({
    sport: 'NHL', market: 'Spread', side: 'Edmonton Oilers -1.5',
    matchup: 'Edmonton Oilers @ Calgary Flames',
    modelRawP, fair_sharp_p: fair, odds: 185,
  });
  assert.ok(Math.abs(row.coverProb - shrunkTarget) < 1e-9, `oilers p ${row.coverProb}`);
  assert.ok(edge.attachEv(row).ev < 0, edge.attachEv(row).ev);
}

// No fair: plain shrink, no clip toward 0.42.
{
  const row = calibrate.calibrateCandidate({
    sport: 'NHL', market: 'Spread', modelRawP: 0.30, odds: 215,
  });
  assert.ok(Math.abs(row.coverProb - 0.30) < 1e-12, row.coverProb);
  assert.ok(calibrate.isotonicClip(0.30) > 0.35);
}

// Raw modelRawP - fair above 10pp is excluded before shrink can hide it.
// A calibrated edge above 10pp is still excluded after.
{
  const wild = {
    sport: 'NHL', market: 'Moneyline', side: 'Wild Team',
    matchup: 'Wild Team @ Other', modelRawP: 0.62, fair_sharp_p: 0.50, odds: -110,
  };
  const calm = {
    sport: 'NHL', market: 'Moneyline', side: 'Calm Team',
    matchup: 'Calm Team @ Other', modelRawP: 0.53, fair_sharp_p: 0.50, odds: -110,
    edgePct: 0.02, coverProb: 0.52, ev: 0.02,
  };
  const shrunk = calibrate.shrinkTowardSharp(wild.modelRawP, wild.fair_sharp_p, wild.market, wild.sport);
  assert.ok(shrunk - wild.fair_sharp_p < 0.10, `shrink hides the raw edge: ${shrunk - wild.fair_sharp_p}`);
  const split = select.splitRawMiscalibrated([wild, calm]);
  assert.strictEqual(split.candidates.length, 1);
  assert.strictEqual(split.candidates[0].side, 'Calm Team');
  assert.strictEqual(split.miscalibrated.length, 1);
  assert.strictEqual(split.miscalibrated[0].reason, 'edge-over-10pp');
  assert.strictEqual(split.miscalibrated[0].stage, 'pre-calibration');
  assert.ok(split.miscalibrated[0].edgePct > 0.10);

  const after = select.prepareEdgePositions([
    { ...calm, edgePct: 0.04 },
    {
      sport: 'NFL', matchup: 'A @ B', side: 'Home -3', market: 'Spread',
      edgePct: 0.15, odds: -110, coverProb: 0.65, ev: 0.2, alternate: false,
    },
  ]);
  assert.strictEqual(after.diagnostics.miscalibrated.length, 1);
  assert.strictEqual(after.diagnostics.miscalibrated[0].reason, 'edge-over-10pp');
  assert.strictEqual(after.diagnostics.miscalibrated[0].stage, 'post-calibration');
  const merged = split.miscalibrated.concat(after.diagnostics.miscalibrated);
  assert.strictEqual(merged.length, 2);
  assert.ok(merged.every(m => m.reason === 'edge-over-10pp'));
}

// A 1u A-grade straight that is also a parlay leg stays 1u.
{
  const capped = select.applyExposureCaps(
    [{ matchup: 'Seattle Kraken @ Vancouver Canucks', units: '1u', rating: 'a' }],
    [{ units: '0.5u', legs: [{ matchup: 'Seattle Kraken @ Vancouver Canucks' }] }],
  );
  assert.strictEqual(capped.picks[0].units, '1u');
  assert.strictEqual(capped.picks[0].rating, 'a');
  assert.strictEqual(capped.parlayLegs[0].units, '0.5u');
  assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
}

// Parlay leg matching a published straight reuses that rating, quality grade, and units.
{
  const straight = {
    sport: 'NFL', matchup: 'A @ B',
    pick: 'B -3', side: 'B -3', betType: 'Spread', market: 'Spread',
    rating: 'a', qualityGrade: 'a', units: '1u', qualityScore: 0.04,
    odds: -110, coverProb: 0.55, ev: 0.045,
  };
  const leg = (matchup, side) => ({
    sport: 'NFL', matchup, side, market: 'Spread',
    odds: -110, coverProb: 0.55, ev: 0.045, edgePct: 0.012,
    commenceTime: '2026-10-20T17:00:00Z', homeTeam: 'H', awayTeam: 'A',
  });
  const pool = [
    leg('A @ B', 'B -3'),
    leg('C @ D', 'D -3'),
    leg('E @ F', 'F -3'),
  ];
  const tickets = parlay.optimizeParlay(pool, [straight], {});
  assert.strictEqual(tickets.length, 1, '3-leg ticket');
  const legs = tickets[0].legs;
  assert.strictEqual(legs.length, 3);
  const matched = legs.find(l => l.matchup === 'A @ B');
  const other = legs.find(l => l.matchup === 'C @ D');
  assert.ok(matched && other);
  assert.strictEqual(matched.rating, 'a');
  assert.strictEqual(matched.qualityGrade, 'a');
  assert.strictEqual(matched.units, '1u');
  assert.notStrictEqual(other.units, '1u');
  assert.notStrictEqual(other.rating, 'a');
}

// The ticket is built before exposure caps. A 1.25u straight trimmed to 1u
// must pull the matching parlay leg down with it.
{
  const straight = {
    sport: 'NFL', matchup: 'A @ B',
    pick: 'B -3', side: 'B -3', betType: 'Spread', market: 'Spread',
    rating: 'a', qualityGrade: 'a', units: '1.25u', qualityScore: 0.04,
  };
  const leg = (matchup, side) => ({
    sport: 'NFL', matchup, side, market: 'Spread',
    odds: -110, coverProb: 0.55, ev: 0.045, edgePct: 0.012,
    commenceTime: '2026-10-20T17:00:00Z', homeTeam: 'H', awayTeam: 'A',
  });
  const tickets = parlay.optimizeParlay([
    leg('A @ B', 'B -3'),
    leg('C @ D', 'D -3'),
    leg('E @ F', 'F -3'),
  ], [straight], {});
  const before = tickets[0].legs.find(l => l.matchup === 'A @ B');
  assert.strictEqual(before.units, '1.25u');
  const capped = select.applyExposureCaps([straight], tickets);
  assert.strictEqual(capped.picks[0].units, '1u');
  const synced = parlay.syncLegsToPublishedStraights(capped.parlayLegs, capped.picks);
  const after = synced[0].legs.find(l => l.matchup === 'A @ B');
  const untouched = synced[0].legs.find(l => l.matchup === 'C @ D');
  assert.strictEqual(after.units, '1u');
  assert.strictEqual(after.rating, 'a');
  assert.strictEqual(after.qualityGrade, 'a');
  assert.notStrictEqual(untouched.units, '1u');
  assert.strictEqual(synced[0].units, '0.5u');
}

console.log('PASS test-omega-fixes-1020');
