'use strict';

const {
  KELLY_FRACTION, PER_BET_CAP, STRAIGHT_BUDGET, UNIT_DOLLARS, BANKROLL_UNITS,
} = require('./constants');
const { americanToDecimal } = require('../omega-vnext/odds_math');

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
 * Nearest 0.25u. Under 0.25u rounds to 0 (a pass, not a forced lean).
 * Then the per-bet cap.
 *
 * A -290 price at 3.5% EV has b = 100/290 ≈ 0.345, so f ≈ 0.035/0.345 ≈ 10.2%
 * and quarter-Kelly ≈ 2.54u. The 2u print is this cap binding, not a
 * different formula. An edge inside k*SE(bucket) never reaches this function.
 */
function quarterKellyFromDecimal(pCal, decimal, cap) {
  const dec = Number(decimal);
  const p = Number(pCal);
  if (!(dec > 1) || !(p > 0) || !(p < 1)) return { units: 0, kellyFrac: 0, full: 0 };
  const b = dec - 1;
  const full = (b * p - (1 - p)) / b;
  if (!(full > 0)) return { units: 0, kellyFrac: 0, full: 0 };
  const frac = full * KELLY_FRACTION;
  let units = roundQuarter(frac * BANKROLL_UNITS);
  const ceiling = cap == null ? PER_BET_CAP : cap;
  if (units > ceiling) units = ceiling;
  if (units < 0.25) units = 0;
  return { units, kellyFrac: frac, full };
}

function quarterKellyUnits(pCal, american, cap) {
  return quarterKellyFromDecimal(pCal, americanToDecimal(american), cap);
}

function sizeStraight(candidate) {
  const sized = quarterKellyUnits(candidate.calibration.pCal, candidate.odds);
  if (!(sized.units > 0)) {
    return { ...candidate, units: 0, stakeUsd: 0, skipped: true, skipReason: 'kelly-round-zero' };
  }
  return {
    ...candidate,
    units: sized.units,
    stakeUsd: stakeUsd(sized.units),
    kellyFrac: sized.kellyFrac,
    skipped: false,
    skipReason: null,
  };
}

function sumUnits(rows) {
  return rows.reduce((sum, row) => sum + (row.units > 0 && !row.skipped ? row.units : 0), 0);
}

/** Cut the lowest-EV straight by 0.25u until the straight budget holds. */
function trimBudget(rows, budget) {
  const out = rows.map((row) => ({ ...row }));
  let guard = 0;
  while (sumUnits(out) > budget + 1e-9 && guard < 40) {
    guard += 1;
    const live = out.filter((row) => row.units > 0 && !row.skipped);
    if (!live.length) break;
    live.sort((a, b) => (a.ev - b.ev) || (a.units - b.units) || String(a.pick).localeCompare(String(b.pick)));
    const victim = live[0];
    const next = roundQuarter(victim.units - 0.25);
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

function sizeStraights(selected) {
  const sized = (selected || []).map(sizeStraight).filter((row) => !row.skipped && row.units > 0);
  return trimBudget(sized, STRAIGHT_BUDGET);
}

module.exports = {
  roundQuarter,
  stakeUsd,
  quarterKellyFromDecimal,
  quarterKellyUnits,
  sizeStraight,
  trimBudget,
  sizeStraights,
  sumUnits,
};
