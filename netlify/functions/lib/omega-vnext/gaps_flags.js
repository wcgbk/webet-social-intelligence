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

function gameExposureEnabled() {
  return flagEnabled('OMEGA_GAME_EXPOSURE');
}

function parlayCorrEnabled() {
  return flagEnabled('OMEGA_PARLAY_CORR');
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
 * Pearson correlation prior for same-direction cross-game totals.
 * Same-slate overs (or unders) move together. 0.08 is inside the
 * usual 0.05–0.15 band and is a desk prior, not a fitted coefficient.
 * The Fréchet bounds keep the joint inside [max(0, p+q-1), min(p, q)].
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
