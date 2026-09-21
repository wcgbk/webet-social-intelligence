'use strict';

const { GATES } = require('./config');

function sportFloor(map, sport) {
  return map[sport] != null ? map[sport] : map.default;
}

function gateReason(c) {
  const sport = c.sport || 'default';
  const minEV = sportFloor(GATES.minEV, sport);
  const minCP = sportFloor(GATES.minCoverProb, sport);

  if (GATES.pregameOnly && c.commenceTime) {
    const t = Date.parse(c.commenceTime);
    if (Number.isFinite(t) && t < Date.now() - 5 * 60 * 1000) {
      return 'in-progress-or-started';
    }
  }
  if (!Number.isFinite(c.odds)) return 'no-odds';
  if (c.odds < GATES.minAmericanOdds || c.odds > GATES.maxAmericanOdds) return 'odds-out-of-band';
  if (GATES.requireMajorBook && !c.liquid) return 'insufficient-liquidity';
  if (!Number.isFinite(c.coverProb) || c.coverProb < minCP) return 'coverProb-floor';
  if (!Number.isFinite(c.ev) || c.ev < minEV) return 'ev-floor';
  if (typeof c.predictedClv === 'number' && c.predictedClv < GATES.minPredictedClvCents) {
    return 'predictedClv-negative';
  }
  // Positive edge vs implied
  if (Number.isFinite(c.edgePct) && c.edgePct <= 0) return 'nonpositive-edge';
  return null;
}

/**
 * Filter to YES pool. Empty OK — no force-fill.
 */
function applyGates(candidates) {
  const yes = [];
  const rejected = [];
  for (const c of candidates || []) {
    const reason = gateReason(c);
    if (reason) rejected.push({ ...c, rejectReason: reason });
    else yes.push(c);
  }
  return { yesPool: yes, rejected };
}

module.exports = { applyGates, gateReason };
