'use strict';

const { SHRINK_K, MLB_CALIBRATION } = require('./config');
const { clamp } = require('./odds_math');

function shrinkTableForSport(sport) {
  if (sport === 'MLB' && MLB_CALIBRATION && MLB_CALIBRATION.shrinkK) {
    return MLB_CALIBRATION.shrinkK;
  }
  return SHRINK_K;
}

function shrinkKForMarket(market, sport) {
  const table = shrinkTableForSport(sport);
  const m = String(market || '');
  if (/total/i.test(m)) return table.Total;
  if (/spread|run line|puck/i.test(m)) return table.Spread;
  if (/moneyline|ml/i.test(m)) return table.Moneyline;
  return table.default;
}

/**
 * Shrink model probability toward no-vig sharp fair.
 * p_cal = (1-K)*p_model + K*p_sharp
 */
function shrinkTowardSharp(pModel, pSharp, market, sport) {
  const K = shrinkKForMarket(market, sport);
  if (!Number.isFinite(pModel)) return null;
  if (!Number.isFinite(pSharp)) return clamp(pModel, 0.02, 0.98);
  const raw = (1 - K) * pModel + K * pSharp;
  return clamp(raw, 0.02, 0.98);
}

/**
 * Soft-compress calibrated probs toward [lo, hi].
 * Excess above hi / below lo is retained at `keep` (default 25%; pull the rest back).
 * (Previous hi-branch used hi+(0.98-p)*f which inflated values just above hi.)
 * Every sport, including MLB, uses 0.42–0.58 @ 0.25 unless a caller passes a band.
 */
function isotonicClip(p, lo = 0.42, hi = 0.58, keep = 0.25) {
  if (!Number.isFinite(p)) return p;
  const retain = Number.isFinite(keep) ? keep : 0.25;
  if (p < lo) return lo - (lo - p) * retain;
  if (p > hi) return hi + (p - hi) * retain;
  return p;
}

function calibrateCandidate(c) {
  const sport = c && c.sport;
  const pModel = c.modelRawP;
  const pSharp = c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP;
  let p = shrinkTowardSharp(pModel, pSharp, c.market, sport);
  p = isotonicClip(p);
  return {
    ...c,
    p_model: pModel,
    fair_sharp_p: pSharp,
    coverProb: p,
    calibK: shrinkKForMarket(c.market, sport),
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
