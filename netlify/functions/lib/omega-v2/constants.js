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
 * is why that price printed 2u. The cap is a risk limit. The uncertainty
 * floor below is what keeps a noisy edge from reaching it.
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
 * Retired scaled floor. The live gate is the sign of the no-vig edge, then
 * the bucket uncertainty floor. A 1pp scaled floor was not estimated from
 * the graded sample. Kept at 0 so a stale caller cannot revive the 1pp screen.
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
 * One uncertainty floor for every straight and every parlay leg.
 * edge = (pCal - penalty) - pNovig must exceed EDGE_FLOOR_K * SE(bucket).
 * Buckets are on the no-vig probability. SE and the long-shot penalty are
 * fit on the 4,160 graded walk-forward rows (341 games). A thin bucket is
 * shrunk toward the global residual variance (0.234655) and toward bias 0,
 * with prior strength 80. Penalty is max(0, -bias) only when pNovig < 0.35.
 * See DATA-THRESHOLDS-V2.md. k = 1.5. The <0.2 floor is 7.805pp, so a
 * +575 with pCal 0.167 and pNovig 0.140 (2.7pp) does not qualify.
 */
const EDGE_FLOOR_K = 1.5;
const NO_VIG_BUCKETS = [
  { lo: 0, hi: 0.2, n: 56, games: 55, se: 0.052035, bias: -0.032896, penalty: 0.032896 },
  { lo: 0.2, hi: 0.35, n: 145, games: 127, se: 0.037668, bias: -0.032354, penalty: 0.032354 },
  { lo: 0.35, hi: 0.65, n: 3541, games: 341, se: 0.008385, bias: 0.000670, penalty: 0 },
  { lo: 0.65, hi: 0.8, n: 221, games: 160, se: 0.031055, bias: 0.006278, penalty: 0 },
  { lo: 0.8, hi: 1, n: 197, games: 122, se: 0.026143, bias: -0.001903, penalty: 0 },
];
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
  EDGE_FLOOR_K,
  NO_VIG_BUCKETS,
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
