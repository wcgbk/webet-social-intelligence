'use strict';

const { americanToImplied } = require('./odds_math');

/**
 * Odds-scaled minimum edge vs the de-vigged sharp fair price.
 *
 * v12.3.22 set minEV and minCoverProb to 0. Those were flat floors: a stake-EV
 * hurdle and a coverProb hurdle. A flat cover hurdle throws away plus-money
 * sides whose fair price is under that number. A flat EV hurdle does not grow
 * where a small probability error becomes a large bankroll error.
 *
 * Edge stays coverProb − fair_sharp (no-vig Pinnacle/Circa). The minimum is
 *
 *   min(6%,
 *     1.75%
 *     + 0.05 × max(0, implied(−110) − implied(price))
 *     + 0.04 × max(0, uncertainty − 0.15))
 *
 * 1.75% is the −110 anchor, inside the 1.5–2% band. At −110 the two-way hold
 * is about 4.5 cents and a normal model is only a point or two off the fair,
 * so a smaller edge is noise. Prices shorter than −110 (favorites) keep
 * 1.75%: the longshot term is zero on that side of the anchor.
 *
 * Plus-money adds 5 probability points of required edge per 1.00 of implied
 * distance from −110. That is the favorite-longshot correction. Quarter-Kelly
 * on a long price magnifies a miscalibrated tail, so the model has to be
 * further ahead of the fair before the price is a bet.
 *   −110 → 1.75%
 *   +150 (implied 0.40) → about 2.37%
 *   +200 (implied 0.333) → about 2.70%
 *   +300 (implied 0.25) → about 3.12%
 *
 * Uncertainty is the generator's 0–1 score (NFL EPA ~0.13, NCAAF EPA ~0.17,
 * MLB with a named starter ~0.14, NHL standings ~0.20, missing data
 * ~0.26–0.30, totals +0.05). 0.15 is a normal priced game. Each tenth above
 * that adds 0.40 probability points. A missing uncertainty does not raise
 * the floor. The 6% cap stops a thin longshot with a stale uncertainty from
 * demanding an edge the −300..+300 band cannot pay.
 *
 * minCoverProb stays 0. There is no flat cover floor.
 *
 * A main also needs stake EV at mainMinEv and edge >= 3% (MAIN_EDGE_FLOOR).
 * The odds-scaled curve still raises that 3% edge when plus-money or
 * uncertainty asks for more. mainMinEv is the sport EV floor times the
 * longshot band: 1× from −300 through +150, 1.5× from +151 through +200,
 * and 2× from +201 through +300. At a 3% base those bands are 3%, 4.5%,
 * and 6%. A main under 3% edge does not publish. A lean is a separate
 * tier at 1.5% edge and positive EV. This module does not apply the lean floor.
 */
const EDGE_FLOOR = Object.freeze({
  atMinus110: 0.0175,
  anchorAmerican: -110,
  longshotPerImpliedPoint: 0.05,
  uncertaintyBaseline: 0.15,
  uncertaintyPerUnit: 0.04,
  max: 0.06,
});

/** Hard 3% edge floor for a main pick. A lean stays at 1.5% and is not raised here. */
const MAIN_EDGE_FLOOR = 0.03;

function minEdgeFor(odds, uncertainty) {
  const anchor = americanToImplied(EDGE_FLOOR.anchorAmerican);
  const implied = americanToImplied(odds);
  let floor = EDGE_FLOOR.atMinus110;
  if (anchor != null && implied != null) {
    floor += EDGE_FLOOR.longshotPerImpliedPoint * Math.max(0, anchor - implied);
  }
  const unc = Number(uncertainty);
  if (Number.isFinite(unc)) {
    floor += EDGE_FLOOR.uncertaintyPerUnit * Math.max(0, unc - EDGE_FLOOR.uncertaintyBaseline);
  }
  if (floor > EDGE_FLOOR.max) floor = EDGE_FLOOR.max;
  if (floor < MAIN_EDGE_FLOOR) floor = MAIN_EDGE_FLOOR;
  return +floor.toFixed(6);
}

/**
 * Stake-EV multiplier for a main. +151..+200 inclusive is 1.5.
 * +201..+300 inclusive is 2. −300..+150, and a non-numeric price, stay at 1.
 * Prices outside −300/+300 are already odds-out-of-band before this runs.
 */
function evBandMultiplier(odds) {
  const n = typeof odds === 'number' ? odds : Number(odds);
  if (!Number.isFinite(n)) return 1;
  if (n >= 201 && n <= 300) return 2;
  if (n >= 151 && n <= 200) return 1.5;
  return 1;
}

/** Sport minEV times the longshot band. A missing base uses 3%. */
function mainMinEv(odds, base) {
  const n = Number(base);
  const b = base == null || base === '' || !Number.isFinite(n) ? 0.03 : n;
  return +((b * evBandMultiplier(odds)).toFixed(6));
}

module.exports = {
  EDGE_FLOOR,
  MAIN_EDGE_FLOOR,
  minEdgeFor,
  evBandMultiplier,
  mainMinEv,
};
