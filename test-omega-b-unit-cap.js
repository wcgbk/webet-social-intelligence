'use strict';
/** Post-Kelly B-grade unit cap. No network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const math = require(path.join(root, 'odds_math'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.16-omega-vnext-ncaaf-oa-wx');
assert.strictEqual(config.B_GRADE_UNIT_CAP, 0.5);
assert.strictEqual(config.KELLY_FRACTION, 0.25);
assert.strictEqual(config.MAX_STRAIGHT_UNITS_PER_PICK, 1.25);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.QUALITY_GRADE.aplus, 0.05);
assert.strictEqual(config.QUALITY_GRADE.a, 0.035);
assert.strictEqual(config.QUALITY_GRADE.aminus, 0.02);
assert.strictEqual(config.GATES.minEV.MLB, 0.03);
assert.strictEqual(config.GATES.minEV.NFL, 0.025);
assert.strictEqual(config.GATES.minCoverProb.MLB, 0.48);
assert.strictEqual(config.GATES.minCoverProb.NFL, 0.48);

function kellyUnits(coverProb, unitCap) {
  const cap = unitCap == null ? config.MAX_STRAIGHT_UNITS_PER_PICK : unitCap;
  return math.kellyToUnits(math.kellyFraction(coverProb, -110, config.KELLY_FRACTION), cap);
}

// Kelly itself is unchanged. The cap is a later step.
assert.strictEqual(kellyUnits(0.5427), 1);
assert.strictEqual(kellyUnits(0.55), 1.25);
assert.strictEqual(kellyUnits(0.533), 0.5);
assert.strictEqual(kellyUnits(0.527), 0.25);
assert.strictEqual(kellyUnits(0.55, 2), 1.5);
assert.strictEqual(math.qualityToRating(0.015, 0, 0.12), 'b');
assert.strictEqual(math.qualityToRating(0.008, 0, 0.12), 'b');
assert.strictEqual(math.qualityToRating(0.02, 0, 0.12), 'aminus');
assert.strictEqual(math.qualityToRating(0.053, 0, 0.12), 'aplus');

const oddsSrc = fs.readFileSync(path.join(root, 'odds_math.js'), 'utf8');
const parlaySrc = fs.readFileSync(path.join(root, 'parlay.js'), 'utf8');
const selectSrc = fs.readFileSync(path.join(root, 'select.js'), 'utf8');
assert.ok(!/B_GRADE_UNIT_CAP/.test(oddsSrc), 'Kelly helpers stay uncapped');
assert.ok(!/B_GRADE_UNIT_CAP/.test(parlaySrc), 'parlay path is not the B cap');
assert.ok(/const stake = PARLAY_FIXED_UNITS/.test(parlaySrc));
const rateAt = selectSrc.indexOf('const rating = qualityToRating');
const capAt = selectSrc.indexOf('units = capBGradeStake(units, rating)');
assert.ok(rateAt > 0 && capAt > rateAt, 'cap runs after the edge grade exists');

function candidate(overrides) {
  return {
    sport: 'MLB',
    matchup: 'Milwaukee Brewers @ San Diego Padres',
    side: 'Over 7.5',
    market: 'Total',
    odds: -110,
    coverProb: 0.5427,
    ev: 0.036,
    edgePct: 0.008,
    predictedClv: 0,
    uncertainty: 0.12,
    homeTeam: 'San Diego Padres',
    awayTeam: 'Milwaukee Brewers',
    ...overrides,
  };
}

function stake(pick) {
  return parseFloat(pick.units);
}

// Motivating case: 0.8% edge → B, 3.6% EV → Kelly 1u, published 0.5u.
{
  const pick = select.toPickObject(candidate({}), { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(pick.rating, 'b');
  assert.strictEqual(pick.qualityGrade, 'b');
  assert.strictEqual(pick.edgePct, '0.8%');
  assert.strictEqual(pick.ev, '3.6%');
  assert.strictEqual(kellyUnits(0.5427), 1);
  assert.strictEqual(pick.units, '0.5u');
  assert.ok(stake(pick) < 1);
  assert.strictEqual(pick.modelVersion, config.MODEL_VERSION);
}

// Kelly 1.25u on a 1.5% edge is still grade B, and the cap lowers it to 0.5u.
{
  const pick = select.toPickObject(candidate({
    matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C',
    coverProb: 0.55, ev: 0.05, edgePct: 0.015,
  }));
  assert.strictEqual(pick.rating, 'b');
  assert.strictEqual(math.qualityToRating(0.015, 0, 0.12), 'b');
  assert.strictEqual(kellyUnits(0.55), 1.25);
  assert.strictEqual(pick.units, '0.5u');
}

// A B already at 0.5u stays 0.5u. A smaller Kelly stake is not raised.
{
  const atCap = select.toPickObject(candidate({ coverProb: 0.533, ev: 0.018, edgePct: 0.008 }));
  assert.strictEqual(atCap.rating, 'b');
  assert.strictEqual(kellyUnits(0.533), 0.5);
  assert.strictEqual(atCap.units, '0.5u');

  const under = select.toPickObject(candidate({ coverProb: 0.527, ev: 0.006, edgePct: 0.008 }));
  assert.strictEqual(under.rating, 'b');
  assert.strictEqual(kellyUnits(0.527), 0.25);
  assert.strictEqual(under.units, '0.25u');
  assert.ok(stake(under) <= stake(atCap));
}

// A- at the Kelly per-pick cap is unchanged. Exact 2% edge is still A-.
{
  const amin = select.toPickObject(candidate({
    matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E', side: 'F -1.5', market: 'Spread',
    coverProb: 0.55, ev: 0.05, edgePct: 0.025,
  }));
  assert.strictEqual(amin.rating, 'aminus');
  assert.strictEqual(amin.qualityGrade, 'aminus');
  assert.strictEqual(kellyUnits(0.55), 1.25);
  assert.strictEqual(amin.units, '1.25u');

  const floor = select.toPickObject(candidate({
    coverProb: 0.55, ev: 0.05, edgePct: 0.02,
  }));
  assert.strictEqual(floor.rating, 'aminus');
  assert.strictEqual(floor.units, '1.25u');
}

// A+ whose Kelly stake is 1.5u (above the B cap) is unchanged.
{
  const aplus = select.toPickObject(candidate({
    matchup: 'G @ H', homeTeam: 'H', awayTeam: 'G', side: 'H -1.5', market: 'Spread',
    coverProb: 0.55, ev: 0.05, edgePct: 0.053,
  }), { perPickCap: 2 });
  assert.strictEqual(aplus.rating, 'aplus');
  assert.strictEqual(aplus.qualityGrade, 'aplus');
  assert.strictEqual(kellyUnits(0.55, 2), 1.5);
  assert.strictEqual(aplus.units, '1.5u');
}

// Drawdown still runs before the cap. It does not shrink an A-.
{
  const bDraw = select.toPickObject(candidate({ coverProb: 0.55, ev: 0.05, edgePct: 0.008 }), { drawdown: true });
  assert.strictEqual(bDraw.rating, 'b');
  assert.strictEqual(bDraw.units, '0.5u');
  const aDraw = select.toPickObject(candidate({ coverProb: 0.55, ev: 0.05, edgePct: 0.025 }), { drawdown: true });
  assert.strictEqual(aDraw.rating, 'aminus');
  assert.strictEqual(aDraw.units, '0.9375u');
}

// Card-level cap: B stakes above 0.5u drop; A+ / A- and the parlay ticket do not.
{
  const capped = select.applyDailyUnitCap([
    { pick: 'A+', rating: 'aplus', qualityGrade: 'aplus', units: '1.5u', edgePct: '5.3%', qualityScore: 0.053 },
    { pick: 'A-', rating: 'aminus', qualityGrade: 'aminus', units: '1.25u', edgePct: '2.5%', qualityScore: 0.025 },
    { pick: 'B', rating: 'b', qualityGrade: 'b', units: '1.25u', edgePct: '0.8%', qualityScore: 0.008 },
  ], [{
    units: '0.5u',
    legs: [{ pick: 'Over 7.5', rating: 'b', units: '1.25u', matchup: 'Milwaukee Brewers @ San Diego Padres' }],
  }]);
  const byPick = Object.fromEntries(capped.picks.map(p => [p.pick, p]));
  assert.strictEqual(byPick['A+'].units, '1.5u');
  assert.strictEqual(byPick['A+'].rating, 'aplus');
  assert.strictEqual(byPick['A-'].units, '1.25u');
  assert.strictEqual(byPick['A-'].rating, 'aminus');
  assert.strictEqual(byPick.B.units, '0.5u');
  assert.strictEqual(byPick.B.rating, 'b');
  const already = select.applyDailyUnitCap([
    { pick: 'B at cap', rating: 'b', qualityGrade: 'b', units: '0.5u', edgePct: '0.8%', qualityScore: 0.008 },
  ], null);
  assert.strictEqual(already.picks[0].units, '0.5u');
  assert.strictEqual(capped.parlayLegs[0].units, '0.5u');
  assert.strictEqual(capped.parlayLegs[0].legs[0].units, '1.25u');
  assert.strictEqual(capped.parlayLegs[0].legs[0].rating, 'b');
}

// 'b+' is not grade B. Uppercase 'B' is.
{
  const bplus = select.applyDailyUnitCap([
    { pick: 'B+', rating: 'bplus', units: '1.25u', qualityScore: 0.015 },
  ], null);
  assert.strictEqual(bplus.picks[0].units, '1.25u');
  const upper = select.applyDailyUnitCap([
    { pick: 'B', rating: 'B', units: '1u', qualityScore: 0.008 },
  ], null);
  assert.strictEqual(upper.picks[0].units, '0.5u');
  assert.strictEqual(upper.picks[0].rating, 'B');
}

// Parlay ticket stays the fixed 0.5u when every leg is a B that Kelly would stake 1.25u.
{
  const pool = [
    candidate({
      side: 'Over 7.5', market: 'Total', coverProb: 0.55, ev: 0.05, edgePct: 0.008,
      commenceTime: '2026-09-22T23:05:00Z',
    }),
    candidate({
      matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C', side: 'D -1.5', market: 'Spread',
      coverProb: 0.55, ev: 0.05, edgePct: 0.008, commenceTime: '2026-09-22T23:10:00Z',
    }),
    candidate({
      matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E', side: 'F ML', market: 'Moneyline',
      coverProb: 0.55, ev: 0.05, edgePct: 0.009, commenceTime: '2026-09-22T23:15:00Z',
    }),
  ];
  const tickets = parlay.optimizeParlay(pool, [], { cardDate: '2026-09-22' });
  assert.strictEqual(tickets.length, 1);
  assert.strictEqual(tickets[0].units, `${config.PARLAY_FIXED_UNITS}u`);
  assert.strictEqual(parseFloat(tickets[0].units), 0.5);
  assert.ok(tickets[0].legs.length >= 2);
  for (const leg of tickets[0].legs) {
    assert.strictEqual(leg.rating, 'b');
    assert.strictEqual(leg.units, '1.25u');
  }
  const sameLegsAsStraights = pool.map(c => select.toPickObject(c));
  for (const straight of sameLegsAsStraights) {
    assert.strictEqual(straight.rating, 'b');
    assert.strictEqual(straight.units, '0.5u');
  }
}

console.log('PASS test-omega-b-unit-cap', {
  B_GRADE_UNIT_CAP: config.B_GRADE_UNIT_CAP,
  where: 'select.toPickObject after qualityToRating; select.applyDailyUnitCap before budget trim',
});
