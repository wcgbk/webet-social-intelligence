'use strict';

/**
 * Football margin and total distributions with empirical key-number mass.
 *
 * Spreads are pinned so P(M = k | margin = k) equals a conditional push
 * rate. NFL 3 and 7 are the nflverse conditional pushes (close exactly on
 * the number: 9.0% and 6.5%). NFL 10 is the DRatings half-point conditional
 * (4.4%). The other NFL integers scale the nflverse unconditional share by
 * 0.065/0.090 = 0.722, the 7-point conditional-to-unconditional ratio.
 * NCAAF has no public conditional study. Its 3 uses the NFL 3 ratio
 * 0.090/0.151 against the OddsBreakers 2005–2022 unconditional share.
 * The other college integers use 0.722 on those same unconditional shares.
 * NCAAF margin 0 is ~0.001 because FBS plays overtime.
 *
 * NFL totals are NOT pinned to a conditional. Boyd's long-run marginals sit
 * on the normal center bin at σ = 10.5 except 37 and 41. The priceable
 * effect is jaggedness. Sports Insights 2003 season shares, divided by
 * 0.038, are fixed multipliers on the integer bins, valleys included.
 * NCAAF totals stay on the normal: there is no cited frequency table.
 *
 * The normal CDF here is unclamped. odds_math.normCdf clamps to
 * [0.001, 0.999], which erases far-tail bin differences.
 * This module does not require sports/_common (that file requires this one).
 */

const { SPORT_SPREAD_STD, SPORT_TOTAL_STD } = require('./config');

const MARGIN_LO = -70;
const MARGIN_HI = 70;
const TOTAL_LO = 0;
const TOTAL_HI = 99;
const M_MIN = 0.02;
const M_MAX = 40;
const NFL_RATIO = 0.722;
const NFL_KEY3_RATIO = 0.09 / 0.151;

/**
 * Conditional push P(M = k | μ = k). Sources in the file header.
 * Valleys are included so mass can leave them (m < 1).
 */
const NFL_MARGIN_TARGETS = {
  0: 0.002,
  1: 0.042 * NFL_RATIO,
  2: 0.041 * NFL_RATIO,
  3: 0.09,
  4: 0.049 * NFL_RATIO,
  5: 0.036 * NFL_RATIO,
  6: 0.06 * NFL_RATIO,
  7: 0.065,
  8: 0.037 * NFL_RATIO,
  9: 0.016 * NFL_RATIO,
  10: 0.044,
  11: 0.024 * NFL_RATIO,
  12: 0.016 * NFL_RATIO,
  13: 0.028 * NFL_RATIO,
  14: 0.049 * NFL_RATIO,
};

const NCAAF_UNCOND = {
  1: 0.0338,
  3: 0.0898,
  4: 0.034,
  6: 0.029,
  7: 0.0753,
  10: 0.0419,
  14: 0.0422,
  17: 0.0326,
  21: 0.0358,
  24: 0.0278,
};

const NCAAF_MARGIN_TARGETS = { 0: 0.001 };
for (const key of Object.keys(NCAAF_UNCOND)) {
  const n = Number(key);
  const share = NCAAF_UNCOND[n];
  NCAAF_MARGIN_TARGETS[n] = n === 3 ? share * NFL_KEY3_RATIO : share * NFL_RATIO;
}

/**
 * Sports Insights 2003, percent of NFL games. Multiplier = (pct/100) / 0.038.
 * 0.038 is φ(0) / 10.5, the normal center bin at the NFL total σ.
 */
const NFL_TOTAL_PERCENT = {
  30: 3.73, 31: 1.73, 32: 1.08, 33: 3.08, 34: 2.73, 35: 1.60, 36: 2.04,
  37: 4.25, 38: 2.25, 39: 1.69, 40: 3.34, 41: 4.07, 42: 1.26, 43: 3.81,
  44: 4.12, 45: 2.64, 46: 1.73, 47: 2.99, 48: 3.47, 49: 1.73, 50: 2.34,
  51: 3.47, 52: 2.25, 53: 1.52, 54: 1.56, 55: 2.30, 56: 0.56, 57: 1.73,
  58: 2.34,
};
const TOTAL_REF = 0.038;
const NFL_TOTAL_MULT = {};
for (const key of Object.keys(NFL_TOTAL_PERCENT)) {
  NFL_TOTAL_MULT[Number(key)] = (NFL_TOTAL_PERCENT[key] / 100) / TOTAL_REF;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Abramowitz-Stegun 26.2.17. Clamped to [0, 1] only, never [0.001, 0.999]. */
function normCdfOpen(z) {
  if (z > 8) return 1;
  if (z < -8) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function normalBin(mean, std, k) {
  if (!(std > 0) || !Number.isFinite(mean) || !Number.isFinite(k)) return 0;
  const hi = normCdfOpen((k + 0.5 - mean) / std);
  const lo = normCdfOpen((k - 0.5 - mean) / std);
  return Math.max(0, hi - lo);
}

function spreadStd(sport) {
  return (SPORT_SPREAD_STD && SPORT_SPREAD_STD[sport]) || 13.5;
}

function totalStd(sport) {
  return (SPORT_TOTAL_STD && SPORT_TOTAL_STD[sport]) || 10.5;
}

/**
 * Weighted integer masses on [lo, hi], plus the two tails.
 * `mult[abs]` scales both +k and −k. Missing keys stay at weight 1.
 * `sum` is the unnormalized total. Bins are unnormalized.
 */
function weightedMasses(mean, std, mult, lo, hi) {
  const n = hi - lo + 1;
  const w = new Float64Array(n);
  let sum = 0;
  const left = Math.max(0, normCdfOpen((lo - 0.5 - mean) / std));
  const right = Math.max(0, 1 - normCdfOpen((hi + 0.5 - mean) / std));
  sum += left + right;
  for (let k = lo; k <= hi; k++) {
    const nb = normalBin(mean, std, k);
    const abs = k < 0 ? -k : k;
    const m = mult && mult[abs] != null ? mult[abs] : 1;
    const wk = nb * m;
    w[k - lo] = wk;
    sum += wk;
  }
  return { w, sum, left, right, lo, hi };
}

function binProb(masses, k) {
  if (!masses || !(masses.sum > 0)) return 0;
  if (k < masses.lo || k > masses.hi) return 0;
  return masses.w[k - masses.lo] / masses.sum;
}

function solveMultipliers(std, targets) {
  const keys = Object.keys(targets).map(Number).filter((k) => k >= 0 && targets[k] > 0).sort((a, b) => a - b);
  const m = Object.create(null);
  for (const k of keys) {
    const nb = normalBin(k, std, k);
    const raw = nb > 1e-8 ? targets[k] / nb : 1;
    m[k] = clamp(raw, M_MIN, M_MAX);
  }
  let maxLog = Infinity;
  for (let iter = 0; iter < 80; iter++) {
    maxLog = 0;
    for (const k of keys) {
      const masses = weightedMasses(k, std, m, MARGIN_LO, MARGIN_HI);
      const got = binProb(masses, k);
      const target = targets[k];
      if (!(got > 0)) continue;
      const logErr = Math.abs(Math.log(got / target));
      if (logErr > maxLog) maxLog = logErr;
      m[k] = clamp(m[k] * Math.pow(target / got, 0.7), M_MIN, M_MAX);
    }
    if (maxLog < 1e-4) break;
  }
  const pins = {};
  let primary = 0;
  for (const k of keys) {
    const masses = weightedMasses(k, std, m, MARGIN_LO, MARGIN_HI);
    const got = binProb(masses, k);
    pins[k] = got;
    const onClamp = m[k] <= M_MIN + 1e-9 || m[k] >= M_MAX - 1e-9;
    if (!onClamp) {
      const logErr = Math.abs(Math.log(got / targets[k]));
      if (logErr > primary) primary = logErr;
    }
  }
  return { m, maxLog, primary, pins };
}

function primaryOk(solved, required) {
  if (!solved) return false;
  for (const k of required) {
    const got = solved.pins[k];
    const target = solved.targets ? solved.targets[k] : null;
    if (!(got > 0) || !(target > 0)) return false;
    if (Math.abs(Math.log(got / target)) > 0.02) return false;
  }
  if (solved.primary > 0.05) return false;
  return true;
}

const NFL_SOLVED = (() => {
  try {
    const solved = solveMultipliers(spreadStd('NFL'), NFL_MARGIN_TARGETS);
    solved.targets = NFL_MARGIN_TARGETS;
    return solved;
  } catch (err) {
    console.error(`[omega-vnext] key-mass NFL solver failed: ${err && err.message}`);
    return null;
  }
})();

const NCAAF_SOLVED = (() => {
  try {
    const solved = solveMultipliers(spreadStd('NCAAF'), NCAAF_MARGIN_TARGETS);
    solved.targets = NCAAF_MARGIN_TARGETS;
    return solved;
  } catch (err) {
    console.error(`[omega-vnext] key-mass NCAAF solver failed: ${err && err.message}`);
    return null;
  }
})();

const NFL_READY = primaryOk(NFL_SOLVED, [3, 7, 10]);
const NCAAF_READY = primaryOk(NCAAF_SOLVED, [3, 7]);
if (!NFL_READY) console.error('[omega-vnext] key-mass NFL pins missed; spreads stay on the legacy normal');
if (!NCAAF_READY) console.error('[omega-vnext] key-mass NCAAF pins missed; spreads stay on the normal');

function keyMassReady(sport) {
  if (sport === 'NFL') return NFL_READY;
  if (sport === 'NCAAF') return NCAAF_READY;
  return false;
}

function marginMult(sport) {
  if (sport === 'NFL' && NFL_READY) return NFL_SOLVED.m;
  if (sport === 'NCAAF' && NCAAF_READY) return NCAAF_SOLVED.m;
  return null;
}

function marginMasses(mean, sport, std) {
  const mult = marginMult(sport);
  if (!mult) return null;
  const s = std > 0 ? std : spreadStd(sport);
  if (!Number.isFinite(mean) || !(s > 0)) return null;
  return weightedMasses(mean, s, mult, MARGIN_LO, MARGIN_HI);
}

function probGt(masses, t) {
  if (!masses || !(masses.sum > 0)) return 0;
  let u = 0;
  if (masses.hi + 0.5 > t) u += masses.right;
  if (masses.lo - 0.5 > t) u += masses.left;
  for (let k = masses.lo; k <= masses.hi; k++) {
    if (k > t) u += masses.w[k - masses.lo];
  }
  return u / masses.sum;
}

function probEq(masses, k) {
  return binProb(masses, k);
}

function quoteFromWinPush(pWin, pPush) {
  const win = Math.max(0, pWin);
  const push = Math.max(0, Math.min(0.999, pPush));
  const loss = Math.max(0, 1 - win - push);
  let cover = win;
  if (push >= 0.001 && push < 1) cover = win / (1 - push);
  cover = clamp(cover, 0.001, 0.999);
  return {
    coverProb: cover,
    pWin: win,
    pPush: push >= 0.001 ? push : 0,
    pLoss: loss,
  };
}

/**
 * Side margin and the side's points. Cover when margin + line > 0.
 * Integer line pushes at margin = −line. Half points do not push.
 * NCAAF pick'em (line 0) does not push: overtime produces a winner.
 */
function spreadQuote(modelMargin, line, sport, std) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  if (!Number.isFinite(modelMargin) || !Number.isFinite(line)) return null;
  const masses = marginMasses(modelMargin, sport, std);
  if (!masses) return null;
  const thresh = -line;
  const integer = Math.abs(line - Math.round(line)) < 1e-6;
  if (sport === 'NCAAF' && integer && Math.round(line) === 0) {
    const p0 = probEq(masses, 0);
    const pWin = probGt(masses, 0) + 0.5 * p0;
    return quoteFromWinPush(pWin, 0);
  }
  const pushK = integer ? Math.round(thresh) : null;
  const pPush = pushK == null ? 0 : probEq(masses, pushK);
  const pWin = probGt(masses, thresh);
  return quoteFromWinPush(pWin, pPush);
}

/**
 * NFL moneyline pushes on a tie. NCAAF splits the tie (overtime).
 * coverProb is the conditional win for NFL and the full win for NCAAF.
 */
function mlQuote(modelMargin, sport, std) {
  if (!Number.isFinite(modelMargin)) return null;
  const masses = marginMasses(modelMargin, sport, std);
  if (!masses) return null;
  const pPos = probGt(masses, 0);
  const p0 = probEq(masses, 0);
  if (sport === 'NCAAF') return quoteFromWinPush(pPos + 0.5 * p0, 0);
  if (sport !== 'NFL') return null;
  return quoteFromWinPush(pPos, p0);
}

function totalMasses(mean, std) {
  if (!Number.isFinite(mean) || !(std > 0)) return null;
  return weightedMasses(mean, std, NFL_TOTAL_MULT, TOTAL_LO, TOTAL_HI);
}

/** NFL total only. Over wins when total > line. Integer line pushes on total = line. */
function totalQuote(modelTotal, line, side, sport, std) {
  if (sport !== 'NFL') return null;
  if (!Number.isFinite(modelTotal) || !Number.isFinite(line)) return null;
  const s = std > 0 ? std : totalStd(sport);
  const masses = totalMasses(modelTotal, s);
  if (!masses) return null;
  const over = /over/i.test(String(side || ''));
  const integer = Math.abs(line - Math.round(line)) < 1e-6;
  const pushK = integer ? Math.round(line) : null;
  const pPush = pushK == null ? 0 : probEq(masses, pushK);
  let pWinU = 0;
  if (over) {
    if (masses.hi + 0.5 > line) pWinU += masses.right;
    if (masses.lo - 0.5 > line) pWinU += masses.left;
  } else {
    if (masses.lo + 0.5 < line) pWinU += masses.left;
    if (masses.hi - 0.5 < line) pWinU += masses.right;
  }
  for (let k = masses.lo; k <= masses.hi; k++) {
    if (pushK != null && k === pushK) continue;
    const win = over ? k > line : k < line;
    if (win) pWinU += masses.w[k - masses.lo];
  }
  return quoteFromWinPush(pWinU / masses.sum, pPush);
}

function marginBin(mean, k, sport, std) {
  const masses = marginMasses(mean, sport, std);
  return masses ? binProb(masses, k) : null;
}

function totalBin(mean, k, std) {
  const s = std > 0 ? std : totalStd('NFL');
  const masses = totalMasses(mean, s);
  return masses ? binProb(masses, k) : null;
}

function normalTotalBin(mean, k, std) {
  const s = std > 0 ? std : totalStd('NFL');
  return normalBin(mean, s, k);
}

module.exports = {
  NFL_MARGIN_TARGETS,
  NCAAF_MARGIN_TARGETS,
  NFL_TOTAL_MULT,
  NFL_TOTAL_PERCENT,
  keyMassReady,
  spreadQuote,
  totalQuote,
  mlQuote,
  marginBin,
  totalBin,
  normalTotalBin,
  normalBin,
  normCdfOpen,
};
