'use strict';

const {
  KELLY_FRACTION, PER_BET_CAP, STRAIGHT_BUDGET, UNIT_DOLLARS, BANKROLL_UNITS,
  forceTop3From,
} = require('./constants');
const { americanToDecimal, EDGE_B_UNIT_CAP } = require('../omega-vnext/odds_math');
const { letterFromPrintedEdge } = require('./letter');

function roundQuarter(n) {
  return Math.round((Number(n) + 1e-12) * 4) / 4;
}

function stakeUsd(units) {
  if (!(units > 0)) return 0;
  return Math.ceil(units * UNIT_DOLLARS - 1e-9);
}

/**
 * Full Kelly f = (b*p - q) / b, p = calibrated probability, q = 1-p,
 * b = decimal - 1. Quarter-Kelly multiplies by KELLY_FRACTION (0.25).
 * Units = that fraction * BANKROLL_UNITS. 1u = UNIT_DOLLARS ($150) and
 * the roll is 100u ($15,000), so 1% of bankroll is 1.0u.
 * Nearest 0.25u. Under 0.25u rounds to 0 (a pass, not a forced lean)
 * unless opts.floorToQuarter is set. Then Kelly <= 0 and a step under
 * 0.25u both print 0.25u, still inside the cap. The per-bet cap is last.
 *
 * A -290 price at 3.5% EV has b = 100/290 ≈ 0.345, so f ≈ 0.035/0.345 ≈ 10.2%
 * and quarter-Kelly ≈ 2.54u. The 2u print is this cap binding, not a
 * different formula. An edge inside k*SE(bucket) never reaches this function
 * on the flag-off path.
 */
function quarterKellyFromDecimal(pCal, decimal, cap, opts) {
  const dec = Number(decimal);
  const p = Number(pCal);
  const floorToQuarter = !!(opts && opts.floorToQuarter);
  if (!(dec > 1) || !(p > 0) || !(p < 1)) return { units: 0, kellyFrac: 0, full: 0 };
  const b = dec - 1;
  const full = (b * p - (1 - p)) / b;
  const ceiling = cap == null ? PER_BET_CAP : cap;
  if (!(full > 0)) {
    if (!floorToQuarter) return { units: 0, kellyFrac: 0, full: 0 };
    const units = ceiling >= 0.25 ? 0.25 : 0;
    return { units, kellyFrac: full * KELLY_FRACTION, full };
  }
  const frac = full * KELLY_FRACTION;
  let units = roundQuarter(frac * BANKROLL_UNITS);
  if (units > ceiling) units = ceiling;
  if (units < 0.25) units = floorToQuarter && ceiling >= 0.25 ? 0.25 : 0;
  return { units, kellyFrac: frac, full };
}

function quarterKellyUnits(pCal, american, cap) {
  return quarterKellyFromDecimal(pCal, americanToDecimal(american), cap);
}

function sizeStraight(candidate, opts) {
  const force = forceTop3From(opts);
  const p = force && Number.isFinite(Number(candidate && candidate.pBet))
    ? Number(candidate.pBet)
    : candidate.calibration.pCal;
  const sized = quarterKellyFromDecimal(
    p,
    candidate.decimal || americanToDecimal(candidate.odds),
    null,
    force ? { floorToQuarter: true } : null,
  );
  if (!(sized.units > 0)) {
    return { ...candidate, units: 0, stakeUsd: 0, skipped: true, skipReason: 'kelly-round-zero' };
  }
  let units = sized.units;
  if (force && letterFromPrintedEdge(candidate.edge) === 'b' && units > EDGE_B_UNIT_CAP) {
    units = EDGE_B_UNIT_CAP;
  }
  return {
    ...candidate,
    units,
    stakeUsd: stakeUsd(units),
    kellyFrac: sized.kellyFrac,
    skipped: false,
    skipReason: null,
  };
}

function sumUnits(rows) {
  return rows.reduce((sum, row) => sum + (row.units > 0 && !row.skipped ? row.units : 0), 0);
}

/**
 * Cut the lowest-EV straight by 0.25u until the straight budget holds.
 * Flag on: never below 0.25u, and never a budget drop.
 */
function trimBudget(rows, budget, opts) {
  const force = !!(opts && opts.forceTop3);
  const out = rows.map((row) => ({ ...row }));
  let guard = 0;
  while (sumUnits(out) > budget + 1e-9 && guard < 40) {
    guard += 1;
    const live = out.filter((row) => row.units > 0 && !row.skipped && (!force || row.units > 0.25 + 1e-9));
    if (!live.length) break;
    live.sort((a, b) => (a.ev - b.ev) || (a.units - b.units) || String(a.pick).localeCompare(String(b.pick)));
    const victim = live[0];
    const next = roundQuarter(victim.units - 0.25);
    if (force && !(next >= 0.25)) break;
    victim.units = next > 0 ? next : 0;
    victim.stakeUsd = stakeUsd(victim.units);
    victim.budgetTrimmed = true;
    if (!(victim.units > 0)) {
      victim.skipped = true;
      victim.skipReason = 'budget';
    }
  }
  return out;
}

/**
 * Quarter-Kelly on pBet. f <= 0 or a step under 0.25u prints 0.25u.
 * Cap is 2u, then 0.5u when the printed price edge is a B.
 * The 3.5u straight budget trims by 0.25u and never goes under 0.25u.
 */
function sizeForcedStraights(selected) {
  const sized = (selected || []).map((row) => {
    const p = Number.isFinite(Number(row && row.pBet))
      ? Number(row.pBet)
      : Number(row && row.calibration && row.calibration.pCal);
    const decimal = row.decimal || americanToDecimal(row.odds);
    const kelly = quarterKellyFromDecimal(p, decimal, PER_BET_CAP, { floorToQuarter: true });
    let units = kelly.units >= 0.25 ? kelly.units : 0.25;
    if (units > PER_BET_CAP) units = PER_BET_CAP;
    if (letterFromPrintedEdge(row.edge) === 'b' && units > EDGE_B_UNIT_CAP) units = EDGE_B_UNIT_CAP;
    return {
      ...row,
      forced: true,
      units,
      stakeUsd: stakeUsd(units),
      kellyFrac: kelly.kellyFrac,
      skipped: false,
      skipReason: null,
    };
  });
  return trimBudget(sized, STRAIGHT_BUDGET, { forceTop3: true });
}

function sizeStraights(selected, opts) {
  if (forceTop3From(opts)) return sizeForcedStraights(selected);
  const sized = (selected || [])
    .map((row) => sizeStraight(row, { forceTop3: false }))
    .filter((row) => !row.skipped && row.units > 0);
  return trimBudget(sized, STRAIGHT_BUDGET, { forceTop3: false });
}

module.exports = {
  roundQuarter,
  stakeUsd,
  quarterKellyFromDecimal,
  quarterKellyUnits,
  sizeStraight,
  trimBudget,
  sizeStraights,
  sizeForcedStraights,
  sumUnits,
};
