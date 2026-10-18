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
 *
 * --- Moment match and the default quote (task G3, 2026-10-18) ---
 * Key multipliers are symmetric in |margin|, so they do not preserve the
 * caller's mean or SD. On an ARI side margin of -3.62 the unmatched PMF
 * moved +12.5 from 74.5% to 82.3% at SD 13.5 (SIM-REPORT.md, key-mass
 * variant). That is a distortion. After the weights are applied the integer
 * PMF is renormalized and moment-matched back to the input mean and SD
 * (exponential-family tilt exp(λk + βk²) on the integer grid). λ and β are
 * solved, not fitted: MATH, so the discrete mean and SD equal the inputs.
 * The conditional rates above are the pre-match solver targets. marginBin
 * is the matched PMF, so a caller does not read 0.090 back at margin 3.
 *
 * FITTED decision, 855 walk-forward rows in
 * /workspace/audit-scratch/elo_rows.json (home margin, Elo mean), SD 13.22,
 * ties dropped on the moneyline (n = 854). Log-loss, lower is better:
 *   moment-matched key PMF        0.634051
 *   that PMF after the 0.03 rail  0.634051
 *   plain normal Φ(μ/σ)          0.633890
 * The rail does not move these moneyline prices (max |Δ| = 0 on the 854
 * rows). The PMF is worse by 0.000161, so spreadQuote / mlQuote / totalQuote
 * default to the plain normal conditional cover plus an explicit integer
 * push. Set OMEGA_KEY_MASS=1 to price with the moment-matched PMF.
 * Offset table: /workspace/fix-1017/audit2/keymass-eval.txt.
 *
 * The plain push is not the normal density (2026-10-18). A normal atom
 * at 0 is about 3% of an NFL game. Scored finals tie about 0.3% of the
 * time, and margins of 3 and 7 are much fatter than that atom. NFL
 * moneyline pPush is the raw tie rate. NFL spread and total integer
 * pPush is the empirical frequency of that exact margin, shrunk toward
 * the normal bin and placed on the model mean. pWin = (1 − pPush) times
 * the conditional normal cover, so the mean and SD still set the price.
 * Half-points do not push. NCAAF keeps the overtime split (pPush 0).
 * Counts, the Wilson interval, and the pseudo-count sit with
 * NFL_ABS_MARGIN_COUNTS. Table: /workspace/fix-1017/prev/nfl-margin-freq.txt.
 *
 * ASSUMED safeguard, not a fit: when the PMF is on, |cover − plain normal
 * with explicit push| ≤ 0.03, and ≤ 0.009 once the line is at least 10
 * points from the mean (the requirement is < 0.01; 0.009 keeps it inside).
 * A 3-point cap cannot by itself flip an edge floor by more than that.
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

/**
 * ASSUMED safeguards, not fits. The unmatched PMF moved a 12.5-point
 * dog by about 8 points (SIM-REPORT key-mass variant). 0.03 is the hard
 * cap versus the plain normal with an explicit push. 0.009 is inside the
 * required 0.01 bound once |line − mean| ≥ 10, so a far line stays ~0.
 */
const KEY_MASS_CAP = 0.03;
const KEY_MASS_FAR_CAP = 0.009;
const KEY_MASS_FAR_POINTS = 10;

/**
 * Pricing gate. Unset / 0 / off stays on the plain normal: the 855-row
 * moneyline log-loss above is worse for the PMF (FITTED). OMEGA_KEY_MASS=1
 * (also on/true/yes) selects the moment-matched PMF. Read at call time.
 * This is stricter than gaps_flags.keyMassEnabled, which treats unset as on
 * and then calls these quotes. The quote itself is the default.
 */
function keyMassPmfOn() {
  const v = process.env.OMEGA_KEY_MASS;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'on' || s === 'true' || s === 'yes';
}

function integerLine(line) {
  return Math.abs(line - Math.round(line)) < 1e-6;
}

/**
 * FITTED NFL finals, 2022–2025, nfl-hist/{2022,2023,2024,2025}.json.
 * Every row with numeric homeScore and awayScore. seasonType 2 (regular,
 * 1087) and 3 (playoffs, 52). n = 1139. No preseason. 0 missing scores.
 * |margin| counts are k = 0..21. The k = 0 count is the ties.
 * The moneyline uses the raw tie rate. It is not shrunk, and it does not
 * move with the model mean: a blowout still carries this unconditional
 * frequency. Wilson 95% uses z = 1.959963984540054 (MATH).
 */
const NFL_FINALS_N = 1139;
const NFL_TIE_COUNT = 3;
const NFL_ABS_MARGIN_COUNTS = Object.freeze([
  3, 61, 57, 175, 61, 53, 76, 92, 49, 18, 49,
  14, 22, 26, 52, 15, 23, 49, 26, 14, 19, 23,
]);
/** FITTED sum of (home + away) on the same 1139 games. Mean = sum / n. */
const NFL_TOTAL_SUM = 51201;
/**
 * FITTED exact-total counts on those games. A missing key was not observed.
 * Far keys stay here so the frequency file can list them. The push
 * multiplier ignores a key whose reference bin expects under one game.
 */
const NFL_TOTAL_COUNTS = Object.freeze({
  3: 1, 6: 1, 9: 2, 13: 2, 16: 6, 17: 6, 18: 1, 19: 10,
  20: 2, 21: 4, 22: 7, 23: 9, 24: 9, 25: 9, 26: 17, 27: 18, 28: 8, 29: 19,
  30: 28, 31: 15, 32: 17, 33: 34, 34: 28, 35: 24, 36: 32, 37: 47, 38: 23, 39: 26,
  40: 35, 41: 43, 42: 24, 43: 46, 44: 42, 45: 29, 46: 28, 47: 38, 48: 35, 49: 28,
  50: 21, 51: 46, 52: 23, 53: 15, 54: 26, 55: 16, 56: 9, 57: 27, 58: 26, 59: 18,
  60: 16, 61: 16, 62: 8, 63: 13, 64: 5, 65: 15, 66: 12, 67: 3, 68: 10, 69: 3,
  70: 2, 71: 8, 72: 2, 73: 8, 74: 6, 75: 5, 76: 5, 77: 3, 78: 4, 79: 2,
  80: 4, 81: 1, 82: 2, 84: 1, 86: 1, 89: 1, 90: 2, 93: 1,
});
/**
 * ASSUMED pseudo-count. Same prior-games scale as the NFL margin rating
 * k (NFL_PRIOR_K = 16). Not a log-loss fit, and not tuned to a conditional
 * push study. At n = 1139 the shrink weight is 16/1155.
 */
const NFL_PUSH_PSEUDO = 16;
/** MATH. Standard normal 97.5% quantile for a Wilson 95% interval. */
const WILSON_Z95 = 1.959963984540054;

function wilsonInterval(count, n, z = WILSON_Z95) {
  const nn = Number(n);
  const c = Number(count);
  if (!(nn > 0) || !Number.isFinite(c) || c < 0) return null;
  const phat = c / nn;
  const z2 = z * z;
  const den = 1 + z2 / nn;
  const center = (phat + z2 / (2 * nn)) / den;
  const half = z * Math.sqrt((phat * (1 - phat)) / nn + z2 / (4 * nn * nn)) / den;
  return { p: phat, lo: center - half, hi: center + half, center };
}

const NFL_TIE_WILSON = wilsonInterval(NFL_TIE_COUNT, NFL_FINALS_N);

/**
 * ASSUMED tail guard. A reference bin that expects under one game
 * (pi * n < 1) stays on the normal atom. An unseen integer (no count)
 * also stays on the normal atom: the empty-bin shrink alpha/(n+alpha)
 * would crush a conditional push when the model mean sits there.
 */
function shrunkPushMult(count, pi, n) {
  if (count == null || !Number.isFinite(count)) return 1;
  if (!(pi > 0) || !(n > 0) || pi * n < 1) return 1;
  const fHat = (count + NFL_PUSH_PSEUDO * pi) / (n + NFL_PUSH_PSEUDO);
  return fHat / pi;
}

function capPush(p) {
  if (!Number.isFinite(p) || p <= 0) return 0;
  // ASSUMED. Keeps pWin and pLoss positive. Fitted multipliers near the
  // game SD peak near 2.6, so an at-the-number push is about 0.08.
  if (p > 0.5) return 0.5;
  return p;
}

/**
 * Two-sided normal bin of |margin| = k at mean 0. Signs are pooled, so
 * the reference mean is 0, not the sample home-margin mean.
 * Sigma is the game SD, frozen so a rating-error SD does not rewrite it.
 */
function nflAbsMarginPi(k) {
  const sd = SPORT_SPREAD_STD.NFL;
  const ak = Math.abs(k);
  const pos = normalBin(0, sd, ak);
  if (ak === 0) return pos;
  return pos + normalBin(0, sd, -ak);
}

function nflMarginPushMult(absK) {
  const k = Math.abs(Math.round(absK));
  if (k > 21 || k >= NFL_ABS_MARGIN_COUNTS.length) return 1;
  return shrunkPushMult(NFL_ABS_MARGIN_COUNTS[k], nflAbsMarginPi(k), NFL_FINALS_N);
}

/**
 * P(margin exactly = signedK) around `mean`. Multiplier is frozen at the
 * game SD. `std` only shapes the normal atom under the model mean.
 */
function nflSpreadPush(mean, signedK, std) {
  return capPush(normalBin(mean, std, signedK) * nflMarginPushMult(signedK));
}

function nflTotalPi(k) {
  return normalBin(NFL_TOTAL_SUM / NFL_FINALS_N, SPORT_TOTAL_STD.NFL, k);
}

function nflTotalPushMult(totalK) {
  const k = Math.round(totalK);
  if (!Object.prototype.hasOwnProperty.call(NFL_TOTAL_COUNTS, k)) return 1;
  return shrunkPushMult(NFL_TOTAL_COUNTS[k], nflTotalPi(k), NFL_FINALS_N);
}

function nflTotalPush(mean, totalK, std) {
  return capPush(normalBin(mean, std, totalK) * nflTotalPushMult(totalK));
}

/** MATH. exp(λk + βk²) tilt so the integer PMF has the input mean and SD. */
function momentMatch(w0, lo, targetMean, targetSd) {
  const n = w0.length;
  const logw = new Float64Array(n);
  let rawSum = 0;
  for (let i = 0; i < n; i++) {
    rawSum += w0[i];
    logw[i] = w0[i] > 0 ? Math.log(w0[i]) : -1e300;
  }
  if (!(rawSum > 0) || !(targetSd > 0)) return null;

  function dist(lambda, beta) {
    let m = -Infinity;
    const sc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = lo + i;
      const s = logw[i] + lambda * k + beta * k * k;
      sc[i] = s;
      if (s > m) m = s;
    }
    if (!Number.isFinite(m)) return null;
    let z = 0;
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const e = Math.exp(sc[i] - m);
      p[i] = e;
      z += e;
    }
    if (!(z > 0)) return null;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < n; i++) {
      p[i] /= z;
      const k = lo + i;
      m1 += k * p[i];
      m2 += k * k * p[i];
    }
    const variance = m2 - m1 * m1;
    return { p, mean: m1, sd: Math.sqrt(variance > 0 ? variance : 0) };
  }

  function matchMean(beta) {
    let loL = -0.5;
    let hiL = 0.5;
    let a = dist(loL, beta);
    let b = dist(hiL, beta);
    if (!a || !b) return a || b;
    let guard = 0;
    while (a.mean > targetMean && guard++ < 40) {
      loL *= 2;
      a = dist(loL, beta);
      if (!a) return null;
    }
    guard = 0;
    while (b.mean < targetMean && guard++ < 40) {
      hiL *= 2;
      b = dist(hiL, beta);
      if (!b) return null;
    }
    let best = a;
    for (let i = 0; i < 50; i++) {
      const mid = 0.5 * (loL + hiL);
      const d = dist(mid, beta);
      if (!d) return best;
      best = d;
      if (Math.abs(d.mean - targetMean) < 1e-8) return d;
      if (d.mean < targetMean) loL = mid;
      else hiL = mid;
    }
    return best;
  }

  let loB = -1e-3;
  let hiB = 1e-3;
  let sLo = matchMean(loB);
  let sHi = matchMean(hiB);
  if (!sLo || !sHi) return null;
  let guard = 0;
  while (sLo.sd > targetSd && guard++ < 40) {
    loB = loB * 1.6 - 1e-6;
    sLo = matchMean(loB);
    if (!sLo) return null;
  }
  guard = 0;
  while (sHi.sd < targetSd && guard++ < 40) {
    hiB = hiB * 1.6 + 1e-6;
    sHi = matchMean(hiB);
    if (!sHi) return null;
  }
  let best = sHi;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (loB + hiB);
    const s = matchMean(mid);
    if (!s) return best;
    best = s;
    if (Math.abs(s.sd - targetSd) < 1e-4 && Math.abs(s.mean - targetMean) < 1e-6) break;
    if (s.sd < targetSd) loB = mid;
    else hiB = mid;
  }
  if (Math.abs(best.mean - targetMean) > 0.05 || Math.abs(best.sd - targetSd) > 0.1) return null;
  return best.p;
}

const MATCH_CACHE = new Map();

function matchedMasses(tag, mean, std, mult, lo, hi) {
  const key = tag + '|' + mean + '|' + std;
  const hit = MATCH_CACHE.get(key);
  if (hit) return hit;
  const n = hi - lo + 1;
  const w = new Float64Array(n);
  for (let k = lo; k <= hi; k++) {
    const nb = normalBin(mean, std, k);
    const abs = k < 0 ? -k : k;
    const m = mult && mult[abs] != null ? mult[abs] : 1;
    w[k - lo] = nb * m;
  }
  let p = momentMatch(w, lo, mean, std);
  if (!p) {
    p = new Float64Array(n);
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      p[k - lo] = normalBin(mean, std, k);
      sum += p[k - lo];
    }
    if (!(sum > 0)) return null;
    for (let i = 0; i < n; i++) p[i] /= sum;
  }
  const masses = { w: p, sum: 1, left: 0, right: 0, lo, hi };
  if (MATCH_CACHE.size > 4000) MATCH_CACHE.clear();
  MATCH_CACHE.set(key, masses);
  return masses;
}

function deltaCap(distance) {
  if (distance >= KEY_MASS_FAR_POINTS) return KEY_MASS_FAR_CAP;
  return KEY_MASS_CAP;
}

function unclampedCover(pWin, pPush) {
  const win = Math.max(0, pWin);
  const push = Math.max(0, Math.min(0.999, pPush));
  if (push > 1e-15 && push < 1) return win / (1 - push);
  return win;
}

/**
 * Integer push is the bin mass (no 0.001 wipe: a real atom must survive).
 * Half-point callers pass pPush 0. coverProb is the conditional win.
 */
function packQuote(pWin, pPush) {
  const win = Math.max(0, pWin);
  const push = Math.max(0, Math.min(0.999, pPush));
  const cover = clamp(unclampedCover(win, push), 0.001, 0.999);
  return {
    coverProb: cover,
    pWin: win,
    pPush: push > 1e-15 ? push : 0,
    pLoss: Math.max(0, 1 - win - push),
  };
}

/** Pull the conditional cover onto the plain normal, then rebuild pWin. */
function railQuote(pWin, pPush, plainCover, distance) {
  const push = Math.max(0, Math.min(0.999, pPush));
  let cover = unclampedCover(pWin, push);
  const cap = deltaCap(distance);
  const plain = Number.isFinite(plainCover) ? plainCover : cover;
  const delta = cover - plain;
  if (Math.abs(delta) > cap) cover = plain + Math.sign(delta) * cap;
  cover = clamp(cover, 0.001, 0.999);
  let win = (push > 1e-15 && push < 1) ? cover * (1 - push) : cover;
  if (win < 0) win = 0;
  if (win + push > 1) win = Math.max(0, 1 - push);
  return {
    coverProb: cover,
    pWin: win,
    pPush: push > 1e-15 ? push : 0,
    pLoss: Math.max(0, 1 - win - push),
  };
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
  return matchedMasses('m:' + sport, mean, s, mult, MARGIN_LO, MARGIN_HI);
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

/**
 * Plain normal conditional cover, plus an explicit integer push.
 * NCAAF line 0 splits in overtime (no push). NFL integer push is the
 * empirical margin mass. Other sports keep the normal atom.
 */
function plainSpreadParts(mean, line, sport, std) {
  const thresh = -line;
  const integer = integerLine(line);
  if (sport === 'NCAAF' && integer && Math.round(line) === 0) {
    const p0 = normalBin(mean, std, 0);
    const pWin = (1 - normCdfOpen((0.5 - mean) / std)) + 0.5 * p0;
    return { pWin, pPush: 0, cover: pWin };
  }
  if (!integer) {
    const pWin = 1 - normCdfOpen((thresh - mean) / std);
    return { pWin, pPush: 0, cover: pWin };
  }
  const k = Math.round(thresh);
  const atom = normalBin(mean, std, k);
  const tail = 1 - normCdfOpen((k + 0.5 - mean) / std);
  const cover = unclampedCover(tail, atom);
  if (sport !== 'NFL') return { pWin: tail, pPush: atom, cover };
  const pPush = nflSpreadPush(mean, k, std);
  return { pWin: cover * (1 - pPush), pPush, cover };
}

/**
 * NFL ties push at the raw empirical rate. NCAAF overtime splits the tie.
 * The conditional cover stays the normal cover given no tie.
 */
function plainMlParts(mean, sport, std) {
  const p0 = normalBin(mean, std, 0);
  const pPos = 1 - normCdfOpen((0.5 - mean) / std);
  if (sport === 'NCAAF') {
    const pWin = pPos + 0.5 * p0;
    return { pWin, pPush: 0, cover: pWin };
  }
  if (sport !== 'NFL') return { pWin: pPos, pPush: p0, cover: unclampedCover(pPos, p0) };
  const cover = unclampedCover(pPos, p0);
  const pPush = NFL_TIE_COUNT / NFL_FINALS_N;
  return { pWin: cover * (1 - pPush), pPush, cover };
}

function plainTotalParts(mean, line, side, std) {
  const over = /over/i.test(String(side || ''));
  const integer = integerLine(line);
  if (!integer) {
    const z = (mean - line) / std;
    const pWin = over ? normCdfOpen(z) : normCdfOpen(-z);
    return { pWin, pPush: 0, cover: pWin };
  }
  const k = Math.round(line);
  const atom = normalBin(mean, std, k);
  const pOver = 1 - normCdfOpen((k + 0.5 - mean) / std);
  const pUnder = normCdfOpen((k - 0.5 - mean) / std);
  const tail = over ? pOver : pUnder;
  const cover = unclampedCover(tail, atom);
  const pPush = nflTotalPush(mean, k, std);
  return { pWin: cover * (1 - pPush), pPush, cover };
}

/**
 * Side margin and the side's points. Cover when margin + line > 0.
 * Integer line pushes at margin = −line. Half points do not push.
 * NCAAF pick'em (line 0) does not push: overtime produces a winner.
 * Default cover is the plain normal conditional. NFL integer push is
 * nflSpreadPush. OMEGA_KEY_MASS=1 uses the matched PMF.
 */
function spreadQuote(modelMargin, line, sport, std) {
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  if (!Number.isFinite(modelMargin) || !Number.isFinite(line)) return null;
  const s = std > 0 ? std : spreadStd(sport);
  if (!(s > 0)) return null;
  const plain = plainSpreadParts(modelMargin, line, sport, s);
  if (!keyMassPmfOn()) return packQuote(plain.pWin, plain.pPush);
  const masses = marginMasses(modelMargin, sport, s);
  if (!masses) return null;
  const thresh = -line;
  const integer = integerLine(line);
  if (sport === 'NCAAF' && integer && Math.round(line) === 0) {
    const p0 = probEq(masses, 0);
    const pWin = probGt(masses, 0) + 0.5 * p0;
    return railQuote(pWin, 0, plain.cover, Math.abs(modelMargin));
  }
  const pushK = integer ? Math.round(thresh) : null;
  const pPush = pushK == null ? 0 : probEq(masses, pushK);
  const pWin = probGt(masses, thresh);
  return railQuote(pWin, pPush, plain.cover, Math.abs(modelMargin + line));
}

/**
 * NFL moneyline pushes on a tie at the raw empirical rate. NCAAF splits
 * the tie (overtime). coverProb is the conditional win for NFL and the
 * full win for NCAAF. OMEGA_KEY_MASS=1 uses the matched PMF.
 */
function mlQuote(modelMargin, sport, std) {
  if (!Number.isFinite(modelMargin)) return null;
  if (sport !== 'NFL' && sport !== 'NCAAF') return null;
  const s = std > 0 ? std : spreadStd(sport);
  if (!(s > 0)) return null;
  const plain = plainMlParts(modelMargin, sport, s);
  if (!keyMassPmfOn()) return packQuote(plain.pWin, plain.pPush);
  const masses = marginMasses(modelMargin, sport, s);
  if (!masses) return null;
  const pPos = probGt(masses, 0);
  const p0 = probEq(masses, 0);
  if (sport === 'NCAAF') {
    return railQuote(pPos + 0.5 * p0, 0, plain.cover, Math.abs(modelMargin));
  }
  return railQuote(pPos, p0, plain.cover, Math.abs(modelMargin));
}

function totalMasses(mean, std) {
  if (!Number.isFinite(mean) || !(std > 0)) return null;
  return matchedMasses('t', mean, std, NFL_TOTAL_MULT, TOTAL_LO, TOTAL_HI);
}

/** NFL total only. Over wins when total > line. Integer push is nflTotalPush. */
function totalQuote(modelTotal, line, side, sport, std) {
  if (sport !== 'NFL') return null;
  if (!Number.isFinite(modelTotal) || !Number.isFinite(line)) return null;
  const s = std > 0 ? std : totalStd(sport);
  if (!(s > 0)) return null;
  const plain = plainTotalParts(modelTotal, line, side, s);
  if (!keyMassPmfOn()) return packQuote(plain.pWin, plain.pPush);
  const masses = totalMasses(modelTotal, s);
  if (!masses) return null;
  const over = /over/i.test(String(side || ''));
  const integer = integerLine(line);
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
  return railQuote(pWinU / masses.sum, pPush, plain.cover, Math.abs(modelTotal - line));
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
  NFL_FINALS_N,
  NFL_TIE_COUNT,
  NFL_ABS_MARGIN_COUNTS,
  NFL_TOTAL_SUM,
  NFL_TOTAL_COUNTS,
  NFL_PUSH_PSEUDO,
  NFL_TIE_WILSON,
  nflSpreadPush,
  nflTotalPush,
  nflMarginPushMult,
  nflTotalPushMult,
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
