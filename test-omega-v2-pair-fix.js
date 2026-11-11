'use strict';

/**
 * Spread opposite-side pairing when alternate lines are on the board.
 * DET -1.5 must de-vig against STL +1.5, not against STL -1.5.
 * OMEGA_V2_PAIR_FIX=off restores the old first-±point match.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const edge = require('./netlify/functions/lib/omega-vnext/edge');
const { noVigTwoWay } = require('./netlify/functions/lib/omega-vnext/odds_math');

const ENV = 'OMEGA_V2_PAIR_FIX';
const saved = process.env[ENV];

function pin(american) {
  return [{ book: 'pinnacle', american }];
}

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} vs ${expected}`);
}

/**
 * NHL alt puck lines in the order the board stores them:
 * STL -1.5, DET +1.5, STL 0, DET 0, STL +1.5, DET -1.5.
 */
function nhlBundles() {
  return [
    { side: 'St. Louis Blues', point: -1.5, prices: pin(220) },
    { side: 'Detroit Red Wings', point: 1.5, prices: pin(-270) },
    { side: 'St. Louis Blues', point: 0, prices: pin(-105) },
    { side: 'Detroit Red Wings', point: 0, prices: pin(-115) },
    { side: 'St. Louis Blues', point: 1.5, prices: pin(-300) },
    { side: 'Detroit Red Wings', point: -1.5, prices: pin(215) },
  ];
}

function findSide(bundles, side, point) {
  return bundles.find((s) => s.side === side && s.point === point);
}

function fair(bundles, side, point) {
  return edge.sharpFairForSide(bundles, side, point);
}

try {
  assert.strictEqual(v2.PAIR_FIX_ENV, ENV);

  delete process.env[ENV];
  const nhl = nhlBundles();
  const detDog = findSide(nhl, 'Detroit Red Wings', -1.5);
  const stlFav = findSide(nhl, 'St. Louis Blues', 1.5);
  const detFav = findSide(nhl, 'Detroit Red Wings', 1.5);
  const stlDog = findSide(nhl, 'St. Louis Blues', -1.5);
  const detPick = findSide(nhl, 'Detroit Red Wings', 0);
  const stlPick = findSide(nhl, 'St. Louis Blues', 0);

  assert.strictEqual(edge.oppositeBundle(nhl, detDog), stlFav, 'DET -1.5 pairs with STL +1.5');
  assert.strictEqual(edge.oppositeBundle(nhl, stlFav), detDog, 'STL +1.5 pairs with DET -1.5');
  assert.strictEqual(edge.oppositeBundle(nhl, detFav), stlDog, 'DET +1.5 pairs with STL -1.5');
  assert.strictEqual(edge.oppositeBundle(nhl, stlDog), detFav, 'STL -1.5 pairs with DET +1.5');

  // Same book on both sides uses the power no-vig. +215 vs -300 is ~0.28.
  const detDogFair = noVigTwoWay(215, -300).p1;
  close(fair(nhl, 'Detroit Red Wings', -1.5), detDogFair, 'DET -1.5 fair');
  assert.ok(detDogFair > 0.25 && detDogFair < 0.33, `DET -1.5 fair ~0.30, got ${detDogFair}`);
  close(fair(nhl, 'St. Louis Blues', 1.5), noVigTwoWay(-300, 215).p1, 'STL +1.5 fair');
  close(fair(nhl, 'Detroit Red Wings', 1.5), noVigTwoWay(-270, 220).p1, 'DET +1.5 fair');

  // No shared sharp book falls through to proportional de-vig: ~0.30 vs ~0.50.
  const softNhl = nhl.map((b) => ({ ...b, prices: [{ book: 'draftkings', american: b.prices[0].american }] }));
  const softFair = fair(softNhl, 'Detroit Red Wings', -1.5);
  assert.ok(softFair > 0.28 && softFair < 0.32, `proportional DET -1.5 ~0.30, got ${softFair}`);

  // Pick'em 0 pairs with the other team's 0, including a stored -0.
  assert.strictEqual(edge.oppositeBundle(nhl, detPick), stlPick);
  assert.strictEqual(edge.oppositeBundle(nhl, stlPick), detPick);
  const pickem = [
    { side: 'Detroit Red Wings', point: -0, prices: pin(-115) },
    { side: 'St. Louis Blues', point: 0, prices: pin(-105) },
    { side: 'Detroit Red Wings', point: -1.5, prices: pin(215) },
    { side: 'St. Louis Blues', point: 1.5, prices: pin(-300) },
  ];
  assert.strictEqual(edge.oppositeBundle(pickem, pickem[0]), pickem[1], '0 and -0 are the same pick\'em');
  close(fair(pickem, 'Detroit Red Wings', -0), noVigTwoWay(-115, -105).p1, 'pick\'em fair');

  // Alt totals: a second Over at the same point must not win over Under.
  const totals = [
    { side: 'Over', point: 6.5, prices: pin(-110) },
    { side: 'Over', point: 6.5, prices: pin(-105) },
    { side: 'Under', point: 6.5, prices: pin(-110) },
    { side: 'Over', point: 5.5, prices: pin(120) },
    { side: 'Under', point: 5.5, prices: pin(-140) },
    { side: 'Over', point: 7.5, prices: pin(-130) },
    { side: 'Under', point: 7.5, prices: pin(110) },
  ];
  assert.strictEqual(edge.oppositeBundle(totals, totals[0]), totals[2], 'Over 6.5 pairs with Under 6.5');
  assert.strictEqual(edge.oppositeBundle(totals, totals[2]), totals[0], 'Under 6.5 pairs with the first Over 6.5');
  assert.strictEqual(edge.oppositeBundle(totals, totals[3]), totals[4], 'Over 5.5 stays on 5.5');
  assert.strictEqual(edge.oppositeBundle(totals, totals[6]), totals[5], 'Under 7.5 pairs with Over 7.5');
  close(fair(totals, 'Over', 6.5), noVigTwoWay(-110, -110).p1, 'total fair uses Under');
  close(fair(totals, 'Over', 5.5), noVigTwoWay(120, -140).p1, 'alt total fair');

  const ml = [
    { side: 'Detroit Red Wings', point: null, prices: pin(130) },
    { side: 'St. Louis Blues', point: null, prices: pin(-150) },
  ];
  assert.strictEqual(edge.oppositeBundle(ml, ml[0]), ml[1]);
  assert.strictEqual(edge.oppositeBundle(ml, ml[1]), ml[0]);
  close(fair(ml, 'Detroit Red Wings', null), noVigTwoWay(130, -150).p1, 'moneyline fair');
  assert.strictEqual(edge.oppositeBundle(ml, null), null);

  // Flag off is the old same-sign match: DET -1.5 -> STL -1.5, fair ~0.506.
  process.env[ENV] = 'off';
  const oldOpp = edge.oppositeBundle(nhl, detDog);
  assert.strictEqual(oldOpp, stlDog, 'flag off pairs DET -1.5 with STL -1.5');
  const oldFair = noVigTwoWay(215, 220).p1;
  close(fair(nhl, 'Detroit Red Wings', -1.5), oldFair, 'flag off fair');
  assert.ok(Math.abs(oldFair - detDogFair) > 0.4, 'flag off fair is the same-sign pair');
  const softOld = fair(softNhl, 'Detroit Red Wings', -1.5);
  assert.ok(softOld > 0.48 && softOld < 0.53, `flag off proportional ~0.506, got ${softOld}`);
  assert.strictEqual(edge.oppositeBundle(totals, totals[0]), totals[1], 'flag off keeps the same-name total');
  process.env[ENV] = '0';
  assert.strictEqual(edge.oppositeBundle(nhl, detDog), stlDog, '0 disables the fix');
  process.env[ENV] = 'false';
  assert.strictEqual(edge.oppositeBundle(nhl, detDog), stlDog, 'false disables the fix');
  process.env[ENV] = 'on';
  assert.strictEqual(edge.oppositeBundle(nhl, detDog), stlFav, 'on is the fixed pair');
  delete process.env[ENV];
  assert.strictEqual(edge.oppositeBundle(nhl, detDog), stlFav, 'default is on');

  console.log(`PASS pair fix DET-1.5 power=${detDogFair.toFixed(4)} proportional=${softFair.toFixed(4)} oldPower=${oldFair.toFixed(4)} oldProportional=${softOld.toFixed(4)}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (saved == null) delete process.env[ENV];
  else process.env[ENV] = saved;
}

if (process.exitCode) process.exit(process.exitCode);
