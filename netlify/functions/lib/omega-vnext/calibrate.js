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
 * Soft-compress a number toward [lo, hi].
 * Excess above hi / below lo is retained at `keep` (default 25%; pull the rest back).
 * (Previous hi-branch used hi+(0.98-p)*f which inflated values just above hi.)
 * The band is 0.42–0.58 @ 0.25 unless a caller passes one. That band is centered
 * on 0.50 (±8pp). Apply it to an edge via compressEdge, not to a longshot p:
 * clipping p itself pulls a 0.30 dog up toward 0.42 and prints a fake edge.
 */
function isotonicClip(p, lo = 0.42, hi = 0.58, keep = 0.25) {
  if (!Number.isFinite(p)) return p;
  const retain = Number.isFinite(keep) ? keep : 0.25;
  if (p < lo) return lo - (lo - p) * retain;
  if (p > hi) return hi + (p - hi) * retain;
  return p;
}

/**
 * Soft-compress an edge (p - fair) with the 0.50-centered band.
 * Edges inside ±8pp are unchanged. Excess beyond that keeps `keep`.
 * p_final = fair + compressEdge(p_shrunk - fair).
 */
function compressEdge(edge, lo = 0.42, hi = 0.58, keep = 0.25) {
  if (!Number.isFinite(edge)) return edge;
  const center = (Number(lo) + Number(hi)) / 2;
  return isotonicClip(center + edge, lo, hi, keep) - center;
}

function calibrateCandidate(c) {
  const sport = c && c.sport;
  const pModel = c.modelRawP;
  const pSharp = c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP;
  let p = shrinkTowardSharp(pModel, pSharp, c.market, sport);
  // No fair: plain shrink only. Do not pull a dog's probability toward 0.50.
  if (Number.isFinite(p) && Number.isFinite(pSharp)) {
    p = clamp(pSharp + compressEdge(p - pSharp), 0.02, 0.98);
  }
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
  compressEdge,
  calibrateCandidate,
  calibrateAll,
};
