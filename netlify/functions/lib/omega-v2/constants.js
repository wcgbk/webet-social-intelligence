'use strict';

/** Live Omega card. OMEGA_PIPELINE_V2=0 (or opts.pipelineV2 false) falls back to v1. */
const MODEL_VERSION = 'omega-v2-sharp-2026-10-30';
const UNIT_DOLLARS = 150;
const KELLY_FRACTION = 0.25;
const MAX_STRAIGHTS = 3;
const PER_BET_CAP = 2;
const STRAIGHT_BUDGET = 3.5;
const CARD_BUDGET = 4.5;
const PARLAY_CAP = 0.5;
const PARLAY_STAKE_CAP = 1;
/** Minimum parlay stake when the historical ticket's joint EV is not negative. */
const PARLAY_PROFIT_FLOOR = 0.5;
const PARLAY_LEAN_STAKE = 0.25;
const PARLAY_MIN_EV = 0.03;
/** Probability-point edge versus the pick-time price, before price and uncertainty scales. */
const EDGE_FLOOR = 0.01;
/** A calibrated edge above this is treated as miscalibration and is not a bet. */
const MAX_EDGE = 0.10;
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
const SAME_SPORT_HAIRCUT = 0.95;
const TOTAL_HAIRCUT = { 2: 0.95, 3: 0.92 };
/** Decimal at -110. Longer prices scale the edge floor up from here. */
const PRICE_BASE_DECIMAL = 1 + 100 / 110;
const UNC_BASELINE = 0.18;
const FLAG_ENV = 'OMEGA_PIPELINE_V2';

module.exports = {
  MODEL_VERSION,
  UNIT_DOLLARS,
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
