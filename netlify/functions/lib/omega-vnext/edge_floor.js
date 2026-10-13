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
 * minCoverProb stays 0. There is no flat cover floor. A published pick
 * also needs calibrated stake EV at the sport floor and edge >= 3%
 * (MAIN_EDGE_FLOOR). The odds-scaled curve still raises that 3% when
 * plus-money or uncertainty asks for more. A row under 3% edge does not
 * publish, including as a lean. A thin slate publishes the rows that clear.
 */
const EDGE_FLOOR = Object.freeze({
  atMinus110: 0.0175,
  anchorAmerican: -110,
  longshotPerImpliedPoint: 0.05,
  uncertaintyBaseline: 0.15,
  uncertaintyPerUnit: 0.04,
  max: 0.06,
});

/** Hard edge floor for every published straight and parlay leg. */
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

module.exports = {
  EDGE_FLOOR,
  MAIN_EDGE_FLOOR,
  minEdgeFor,
};
