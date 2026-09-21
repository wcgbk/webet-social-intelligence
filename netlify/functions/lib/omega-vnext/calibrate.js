'use strict';

const { SHRINK_K } = require('./config');
const { clamp } = require('./odds_math');

function shrinkKForMarket(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return SHRINK_K.Total;
  if (/spread|run line|puck/i.test(m)) return SHRINK_K.Spread;
  if (/moneyline|ml/i.test(m)) return SHRINK_K.Moneyline;
  return SHRINK_K.default;
}

/**
 * Shrink model probability toward no-vig sharp fair.
 * p_cal = (1-K)*p_model + K*p_sharp
 */
function shrinkTowardSharp(pModel, pSharp, market) {
  const K = shrinkKForMarket(market);
  if (!Number.isFinite(pModel)) return null;
  if (!Number.isFinite(pSharp)) return clamp(pModel, 0.02, 0.98);
  const raw = (1 - K) * pModel + K * pSharp;
  return clamp(raw, 0.02, 0.98);
}

/**
 * Soft-compress calibrated probs toward [lo, hi].
 * Excess above hi / below lo is retained at 25% (pull 75% back to the band).
 * (Previous hi-branch used hi+(0.98-p)*f which inflated values just above hi.)
 */
function isotonicClip(p, lo = 0.42, hi = 0.58) {
  if (!Number.isFinite(p)) return p;
  if (p < lo) return lo - (lo - p) * 0.25;
  if (p > hi) return hi + (p - hi) * 0.25;
  return p;
}

function calibrateCandidate(c) {
  const pModel = c.modelRawP;
  const pSharp = c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP;
  let p = shrinkTowardSharp(pModel, pSharp, c.market);
  p = isotonicClip(p);
  return {
    ...c,
    p_model: pModel,
    fair_sharp_p: pSharp,
    coverProb: p,
    calibK: shrinkKForMarket(c.market),
  };
}

function calibrateAll(candidates) {
  return (candidates || []).map(calibrateCandidate);
}

module.exports = {
  shrinkKForMarket,
  shrinkTowardSharp,
  isotonicClip,
  calibrateCandidate,
  calibrateAll,
};
