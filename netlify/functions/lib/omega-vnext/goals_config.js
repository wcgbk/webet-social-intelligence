'use strict';
/** Process goals/targets from Ben's Good Bet Checker sheet (Goals +
 *  Thresholds tabs), implemented 2026-10-18. Most already existed in
 *  v1/model.js (commit 1685616) as display-only constants; this module is
 *  the pipeline-facing config. Nothing here places a bet. */
const V1 = require('../../../../v1/model.js');
module.exports = {
  source: 'Good Bet Checker sheet (Bet Check / Goals / Thresholds / README), 2026-10-18',
  // Goals tab, verbatim targets:
  straights: V1.GOALS.straights,          // { accuracy: 0.55, roi: 0.15 } (Record/Profit blank on sheet)
  parlays: V1.GOALS.parlays,              // { accuracy: 0.20, roi: 0.50 }
  clv: V1.GOALS.clv,                      // { scope: 'All Daily Data', target: 0.02 }
  card: V1.GOALS.card,                    // { candidates: 10, straights: 3 }
  seasons: V1.SEASONS,                    // sheet dates are the 2025-26 instances of these recurring windows
  thresholds: V1.THRESHOLDS,              // Thresholds tab (also Bet Check col H-R references)
  unitDollars: V1.THRESHOLDS.unitDollars, // $150
  rankKey: 'trueProbability',             // anchored final p (coverProb); edge/EV are gates + stake inputs
};
