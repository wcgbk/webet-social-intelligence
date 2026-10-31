'use strict';

/** Live Omega card. OMEGA_PIPELINE_V2=0 (or opts.pipelineV2 false) falls back to v1. */
const MODEL_VERSION = 'omega-v2-sharp-2026-10-30';
const UNIT_DOLLARS = 150;
/**
 * Stated bankroll is 100u. 1u = $150, so the roll behind the Kelly display
 * is $15,000. A 1% Kelly fraction prints as 1.0u (units = fraction * 100).
 * See DATA-THRESHOLDS-V2.md.
 */
const BANKROLL_UNITS = 100;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
/**
 * Per-bet ceiling, 2u = $300 = 2% of the $15,000 roll.
 * Quarter-Kelly on a -290 price at 3.5% EV is 2.54u before this cap, which
 * is why that price printed 2u. The cap is a risk limit. The short-price
 * edge rule below is what keeps a noisy favorite from reaching it.
 */
const PER_BET_CAP = 2;
const STRAIGHT_BUDGET = 3.5;
/** Straight budget 3.5u plus the 1u parlay cap. */
const CARD_BUDGET = 4.5;
const PARLAY_CAP = 0.5;
/** Parlay stake ceiling. Stated card limit for this path, not a fitted ROI cutoff. */
const PARLAY_STAKE_CAP = 1;
/**
 * Retired. The v1-seeded ticket used a 0.5u profit floor and a 0.25u lean.
 * The live path no longer reads these. A stake that rounds under 0.25u is
 * not a parlay.
 */
const PARLAY_PROFIT_FLOOR = 0.5;
const PARLAY_LEAN_STAKE = 0.25;
/** Retired. Joint EV must be positive. There is no 3% parlay floor. */
const PARLAY_MIN_EV = 0;
/**
 * Retired scaled floor. The live gate is the sign of the no-vig edge, plus
 * the short-price minimum. A 1pp scaled floor was not estimated from the
 * graded sample. Kept at 0 so a stale caller cannot revive the 1pp screen.
 */
const EDGE_FLOOR = 0;
/**
 * Calibrated edge above this is treated as miscalibration and is not a bet.
 * Graded Omega straights that stored an edge (audit ds.json, n=99) top out
 * at 8.7pp. 10pp sits one step past that sample, matching the existing
 * miscalibration screen.
 */
const MAX_EDGE = 0.10;
/**
 * American price at or below this is a short price.
 * Mode B's Brier excess over the no-vig market is 0.000428
 * (tools/omega-calibration/out/walkforward-cal4.md, n=4160 rows, 341 games).
 * RMSE = sqrt(0.000428) = 0.0207 probability.
 * Quarter-Kelly stake moves by 25 * RMSE / b, with b = 100/|price|.
 * That move reaches 1.0u at b = 0.517, American about -193.
 * -200 is the round price at which one RMSE of phantom edge is already
 * a full unit (1.03u). The suggested -250 leaves -200 to -249 uncapped
 * while that stake error is already above 1u.
 */
const FAV_AMERICAN = -200;
/**
 * Minimum no-vig edge (pCal - Pinnacle no-vig) required at a short price.
 * The 95% CI on mode B minus market Brier runs up to 0.001792 (same fit,
 * n=4160, 341 games). sqrt(0.001792) = 0.0423. An edge inside that band
 * is not separable from calibration noise. Threshold is 0.042.
 * Applied to straights and to parlay legs.
 */
const FAV_MIN_EDGE = 0.042;
/** Prior shrink toward the no-vig price. Matches the known ~54% forecast vs ~50% hits. */
const PRIOR_SHRINK_K = 0.70;
/**
 * Sport priors used until a walk-forward fit has its own holdout.
 * Higher k trusts the no-vig price more. MLB stays looser so a real
 * starter miss is not shrunk under the edge floor.
 */
const SPORT_PRIOR_K = {
  MLB: 0.46,
  NFL: 0.70,
  NCAAF: 0.72,
  NBA: 0.75,
  NHL: 0.68,
};
const SHRINK_GRID = [0.40, 0.55, 0.70, 0.85, 0.95];
const MIN_POOLED = 8;
const MIN_SPORT = 24;
const ISOTONIC_MIN = 40;
/** Penalty on Brier when the fitted shrink leaves the prior. Walk-forward only. */
const SHRINK_PRIOR_PENALTY = 0.05;
const PLATT_LAMBDA = 4;
/**
 * Retired flat haircuts. Same-game pairs use the measured phi in parlay.js.
 * These are not applied on the live path.
 */
const SAME_SPORT_HAIRCUT = 1;
const TOTAL_HAIRCUT = { 2: 1, 3: 1 };
/**
 * Same-game outcome correlation from graded kpi.picks pairs (all models,
 * read 2026-10-30, n is decided win/loss pairs on one matchup).
 * phi SE is about 1/sqrt(n). apply is 0 when |phi| is inside 1.96 SE,
 * so the joint probability stays the product. ML+spread is not in this
 * table: that pair is disallowed (n=4, phi=1.0, SE=0.50, the interval
 * excludes 0). See DATA-THRESHOLDS-V2.md.
 */
const PAIR_PHI = {
  'Moneyline+Total': { phi: -0.02595, n: 14, se: 0.267, apply: 0 },
  'Spread+Total': { phi: 0.18712, n: 26, se: 0.196, apply: 0 },
};
/** Decimal at -110. No longer scales an edge floor. */
const PRICE_BASE_DECIMAL = 1 + 100 / 110;
const UNC_BASELINE = 0.18;
const FLAG_ENV = 'OMEGA_PIPELINE_V2';

module.exports = {
  MODEL_VERSION,
  UNIT_DOLLARS,
  BANKROLL_UNITS,
  KELLY_FRACTION,
  MAX_STRAIGHTS,
  PER_BET_CAP,
  STRAIGHT_BUDGET,
  CARD_BUDGET,
  PARLAY_CAP,
  PARLAY_STAKE_CAP,
  PARLAY_PROFIT_FLOOR,
  PARLAY_LEAN_STAKE,
  PARLAY_MIN_EV,
  EDGE_FLOOR,
  MAX_EDGE,
  FAV_AMERICAN,
  FAV_MIN_EDGE,
  PAIR_PHI,
  PRIOR_SHRINK_K,
  SPORT_PRIOR_K,
  SHRINK_GRID,
  MIN_POOLED,
  MIN_SPORT,
  ISOTONIC_MIN,
  SHRINK_PRIOR_PENALTY,
  PLATT_LAMBDA,
  SAME_SPORT_HAIRCUT,
  TOTAL_HAIRCUT,
  PRICE_BASE_DECIMAL,
  UNC_BASELINE,
  FLAG_ENV,
};
