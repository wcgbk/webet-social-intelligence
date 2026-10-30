'use strict';

const {
  KELLY_FRACTION, PER_BET_CAP, STRAIGHT_BUDGET, UNIT_DOLLARS,
} = require('./constants');
const { kellyFraction } = require('../omega-vnext/odds_math');

function roundQuarter(n) {
  return Math.round((Number(n) + 1e-12) * 4) / 4;
}

function stakeUsd(units) {
  if (!(units > 0)) return 0;
  return Math.ceil(units * UNIT_DOLLARS - 1e-9);
}

/**
 * Quarter-Kelly at the pick-time American price.
 * 1% of bankroll displays as 1.0u (same scale as the live kellyToUnits).
 * Nearest 0.25u. No 0.25 floor: a dust stake is a pass, not a forced lean.
 * Per-bet cap is 1.25u.
 */
function quarterKellyUnits(pCal, american) {
  const frac = kellyFraction(pCal, american, KELLY_FRACTION);
  if (!(frac > 0)) return { units: 0, kellyFrac: frac || 0 };
  let units = roundQuarter(frac * 100);
  if (units > PER_BET_CAP) units = PER_BET_CAP;
  if (units < 0.25) units = 0;
  return { units, kellyFrac: frac };
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
  quarterKellyUnits,
  sizeStraight,
  trimBudget,
  sizeStraights,
  sumUnits,
};
