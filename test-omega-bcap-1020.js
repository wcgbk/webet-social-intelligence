'use strict';
/**
 * v12.5.4: Edge grade B straights are capped at 0.5u after Kelly.
 * A- and the other letters keep Kelly. No-edge stays 0.5u.
 * The daily-cap inversion lift cannot raise a B, and parlay legs copy the cap.
 * No network, no blobs.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const math = require(path.join(root, 'odds_math'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));

assert.strictEqual(config.MODEL_VERSION, 'v12.5.4-omega-vnext');

function kellyUnits(coverProb, odds) {
  return math.kellyToUnits(
    math.kellyFraction(coverProb, odds, config.KELLY_FRACTION),
    config.MAX_STRAIGHT_UNITS_PER_PICK,
  );
}

function row(overrides) {
  return {
    sport: 'NFL',
    market: 'Spread',
    predictedClv: 0,
    uncertainty: 0.18,
    homeTeam: 'Home',
    awayTeam: 'Away',
    ...overrides,
  };
}

const bRaw = row({
  matchup: 'A @ B', side: 'B +3', homeTeam: 'B', awayTeam: 'A',
  odds: 100, coverProb: 0.515, ev: 0.03, edgePct: 0.015,
});
const aRaw = row({
  matchup: 'C @ D', side: 'D -3', homeTeam: 'D', awayTeam: 'C',
  odds: -110, coverProb: 0.542857142857, ev: 0.036363636363, edgePct: 0.025,
});

// B with Kelly 0.75u publishes 0.5u. The same price at A keeps 0.75u.
{
  assert.strictEqual(kellyUnits(bRaw.coverProb, bRaw.odds), 0.75);
  const bPick = select.toPickObject(bRaw, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(bPick.rating, 'b');
  assert.strictEqual(bPick.grade, 'b');
  assert.strictEqual(bPick.qualityGrade, 'b');
  assert.strictEqual(bPick.units, '0.5u');

  const samePriceA = select.toPickObject(
    { ...bRaw, matchup: 'K @ L', side: 'L +3', edgePct: 0.04 },
    { modelVersion: config.MODEL_VERSION },
  );
  assert.strictEqual(samePriceA.rating, 'a');
  assert.strictEqual(samePriceA.units, '0.75u');
}

// A- at Kelly 1u stays 1u. A thinner B stays on its Kelly stake under the cap.
{
  assert.strictEqual(kellyUnits(aRaw.coverProb, aRaw.odds), 1);
  const aPick = select.toPickObject(aRaw, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(aPick.rating, 'aminus');
  assert.strictEqual(aPick.grade, 'aminus');
  assert.strictEqual(aPick.units, '1u');

  const thin = row({
    matchup: 'E @ F', side: 'F +1.5', odds: 100, coverProb: 0.505, ev: 0.01, edgePct: 0.012,
  });
  assert.strictEqual(kellyUnits(thin.coverProb, thin.odds), 0.25);
  const thinPick = select.toPickObject(thin, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(thinPick.rating, 'b');
  assert.strictEqual(thinPick.units, '0.25u');
}

// No-edge fill stays 0.5u even when Kelly would be 0.75u.
{
  const flat = select.toPickObject(
    { ...bRaw, matchup: 'G @ H', side: 'H +3', edgePct: 0, ev: 0, leanFill: true },
    { modelVersion: config.MODEL_VERSION },
  );
  assert.strictEqual(flat.rating, 'no-edge');
  assert.strictEqual(flat.grade, 'no-edge');
  assert.strictEqual(flat.units, '0.5u');
  assert.strictEqual(flat.flag, 'no-edge-lean');
}

const bPick = select.toPickObject(bRaw, { modelVersion: config.MODEL_VERSION });
const aPick = select.toPickObject(aRaw, { modelVersion: config.MODEL_VERSION });

function rawLeg(c) {
  return {
    sport: c.sport, matchup: c.matchup, side: c.side, market: c.market,
    odds: c.odds, coverProb: c.coverProb, ev: c.ev, edgePct: c.edgePct,
    uncertainty: 0.18, predictedClv: 0, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
  };
}

// Parlay legs copy the capped straight stakes: B 0.5u, A- 1u.
{
  const third = row({
    matchup: 'E @ F', side: 'F -3', homeTeam: 'F', awayTeam: 'E',
    odds: -110, coverProb: 0.56, ev: 0.05, edgePct: 0.03,
  });
  const tickets = parlay.optimizeParlay(
    [rawLeg(bRaw), rawLeg(aRaw), rawLeg(third)],
    [bPick, aPick],
    {},
  );
  assert.strictEqual(tickets.length, 1);
  const legs = tickets[0].legs;
  const bLeg = legs.find(l => l.matchup === 'A @ B');
  const aLeg = legs.find(l => l.matchup === 'C @ D');
  assert.ok(bLeg && aLeg);
  assert.strictEqual(bLeg.rating, 'b');
  assert.strictEqual(bLeg.units, bPick.units);
  assert.strictEqual(bLeg.units, '0.5u');
  assert.strictEqual(aLeg.rating, 'aminus');
  assert.strictEqual(aLeg.units, aPick.units);
  assert.strictEqual(aLeg.units, '1u');

  // Inversion would lift the B toward a fatter lean. The ceiling holds at 0.5u.
  const lean = {
    pick: 'Lean dog', rating: 'lean', grade: 'lean', qualityGrade: 'lean',
    units: '1.25u', qualityScore: 0, sport: 'NFL', matchup: 'I @ J',
  };
  const capped = select.applyDailyUnitCap([bPick, lean], null);
  assert.strictEqual(capped.picks.find(p => p.rating === 'b').units, '0.5u');
  assert.strictEqual(capped.picks.find(p => p.rating === 'lean').units, '0.5u');

  // Reuse of an inflated B stake still cannot put the leg above 0.5u.
  const inflated = { ...bPick, units: '0.75u' };
  const synced = parlay.syncLegsToPublishedStraights(tickets, [inflated, aPick]);
  const syncedB = synced[0].legs.find(l => l.matchup === 'A @ B');
  const syncedA = synced[0].legs.find(l => l.matchup === 'C @ D');
  assert.strictEqual(syncedB.units, '0.5u');
  assert.strictEqual(syncedB.rating, 'b');
  assert.strictEqual(syncedA.units, '1u');
  assert.strictEqual(syncedA.rating, 'aminus');
}

console.log('PASS test-omega-bcap-1020');
