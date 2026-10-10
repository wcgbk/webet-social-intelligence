'use strict';

/**
 * Construction toggles for the elite-sharp gap fixes.
 * Unset, blank, or any value other than 0/off/false/no means ON.
 * OFF reproduces the 2e0a803 path for that fix alone.
 * Read at call time so a replay can flip one fix without a new commit.
 */
function flagEnabled(name) {
  const v = process.env[name];
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === '') return true;
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

function keyMassEnabled() {
  return flagEnabled('OMEGA_KEY_MASS');
}

function pushEvEnabled() {
  return flagEnabled('OMEGA_PUSH_EV');
}

function nhlPeriodEnabled() {
  return flagEnabled('OMEGA_NHL_PERIOD');
}

/**
 * Default OFF. Unset, blank, 0, off, false, or no stays off.
 * Any other value turns the same-game stake cap on.
 */
function gameExposureEnabled() {
  const v = process.env.OMEGA_GAME_EXPOSURE;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

/**
 * Default OFF. Unset, blank, 0, off, false, or no stays off.
 * Any other value turns the prior on.
 *
 * The Pearson ρ below only raises the joint probability of same-direction
 * totals. That raises parlay EV. Cross-game total correlation is a weak
 * estimate and must not do that, so the flag is not on with the other
 * construction fixes. Same-direction totals keep PARLAY_TOTAL_HAIRCUT.
 * When the flag is on, a correlation term is applied only if it lowers
 * the joint. This prior never does, so turning the flag on adds no EV.
 */
function parlayCorrEnabled() {
  const v = process.env.OMEGA_PARLAY_CORR;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

function auditCardEnabled() {
  return flagEnabled('OMEGA_CARD_AUDIT');
}

/**
 * Straight units plus the full parlay stake on that game.
 * The parlay dies if the leg dies, so the 0.5u ticket is exposed on every leg.
 * 1.50u sits above the 1.25u per-straight cap and below 1.25+0.5.
 */
const GAME_EXPOSURE_CAP = 1.5;

/**
 * Pearson prior for same-direction cross-game totals.
 * Same-slate overs (or unders) move together. 0.08 is inside the
 * usual 0.05–0.15 band and is a desk prior, not a fitted coefficient.
 * Inside the Fréchet bounds it only raises the joint, which raises EV.
 * Pricing does not apply that raise. OMEGA_PARLAY_CORR defaults off.
 */
const PARLAY_TOTAL_RHO = 0.08;

/** Private audit label. Not a model-version bump. */
const GAPS_BUILD = 'elite-sharp-gaps-1';

module.exports = {
  flagEnabled,
  keyMassEnabled,
  pushEvEnabled,
  nhlPeriodEnabled,
  gameExposureEnabled,
  parlayCorrEnabled,
  auditCardEnabled,
  GAME_EXPOSURE_CAP,
  PARLAY_TOTAL_RHO,
  GAPS_BUILD,
};
