'use strict';

const {
  PRIOR_SHRINK_K, SPORT_PRIOR_K, SHRINK_GRID, MIN_POOLED, MIN_SPORT, ISOTONIC_MIN,
  SHRINK_PRIOR_PENALTY, PLATT_LAMBDA, SHRINK_N0, SPORT_MIN_GAMES,
  NHL_ML_SHRINK_K, NHL_ML_WALKFORWARD_BEATS_NOVIG,
} = require('./constants');
const { marketFamily } = require('./select');

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function clipP(p) {
  return clamp(p, 0.02, 0.98);
}

function logit(p) {
  const x = clipP(p);
  return Math.log(x / (1 - x));
}

function sigmoid(z) {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Prior count for a sport x market intercept. The fitted mean residual is
 * shrunk toward 0 by n / (n + BIAS_N0). Thin cells stay on the market.
 * This is not a blend weight.
 */
const BIAS_N0 = 8;

/** origin/main blend, probability space. Replay uses it as CURRENT. */
let mathMode = 'logodds';

function setMathMode(mode) {
  mathMode = mode === 'linear' ? 'linear' : 'logodds';
  return mathMode;
}

function shrinkPLinear(pModel, pMkt, k) {
  return clipP((1 - k) * Number(pModel) + k * Number(pMkt));
}

/**
 * Blend in log-odds. `intercept` is the walk-forward mean of
 * (pModel - pFair) for this sport x market, removed before the blend so
 * the cell is centered on the no-vig price.
 *   p0 = pModel - intercept
 *   logit(p) = (1 - k) * logit(p0) + k * logit(pFair)
 */
function shrinkP(pModel, pMkt, k, intercept) {
  const shift = Number.isFinite(Number(intercept)) ? Number(intercept) : 0;
  const p0 = clipP(Number(pModel) - shift);
  const z = (1 - k) * logit(p0) + k * logit(pMkt);
  return clipP(sigmoid(z));
}

function cellKey(row) {
  const market = row && (row.market || row.betType || row.marketFamily);
  if (!market) return null;
  const sport = String((row && row.sport) || '').toUpperCase();
  if (!sport) return null;
  return `${sport}|${marketFamily(market, row.pick || row.side)}`;
}

function biasFor(bias, row) {
  if (!bias) return 0;
  const key = cellKey(row);
  if (!key || !Number.isFinite(Number(bias[key]))) return 0;
  return Number(bias[key]);
}

/**
 * Mean (pModel - pFair) per sport x market, shrunk toward 0.
 * Rows without a market are skipped so they do not land on Moneyline.
 */
function fitCellBias(rows) {
  const groups = {};
  for (const row of rows || []) {
    const key = cellKey(row);
    if (!key) continue;
    const pModel = Number(row.pModel);
    const pMkt = Number(row.pMkt);
    if (!Number.isFinite(pModel) || !Number.isFinite(pMkt)) continue;
    if (!groups[key]) groups[key] = { n: 0, sum: 0 };
    groups[key].n += 1;
    groups[key].sum += pModel - pMkt;
  }
  const bias = {};
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const mean = g.sum / g.n;
    const w = g.n / (g.n + BIAS_N0);
    bias[key] = w * mean;
  }
  return bias;
}

function centerRows(rows, bias) {
  return (rows || []).map((row) => {
    const shift = biasFor(bias, row);
    if (!shift) return row;
    return { ...row, pModel: clipP(Number(row.pModel) - shift) };
  });
}

function brier(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}

function logLoss(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) {
    const p = clipP(ps[i]);
    const y = ys[i];
    s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return s / ps.length;
}

/**
 * Throw if any training row is dated on or after the card. Date comparison is
 * calendar YYYY-MM-DD, which is the card key. A missing date is also leakage.
 */
function assertNoLeakage(rows, cardDate) {
  const card = String(cardDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card)) {
    throw new Error(`leakage: card date is not YYYY-MM-DD (${cardDate})`);
  }
  for (const row of rows || []) {
    const d = row && row.date != null ? String(row.date) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= card) {
      throw new Error(`leakage: training row date ${d || '(missing)'} >= card date ${card}`);
    }
  }
  return true;
}

function yOf(row) {
  if (row.result === 'win') return 1;
  if (row.result === 'loss') return 0;
  return null;
}

function fitPlatt(ps, ys) {
  let a = 0;
  let b = 1;
  const lambda = PLATT_LAMBDA;
  for (let iter = 0; iter < 25; iter += 1) {
    let g0 = lambda * a;
    let g1 = lambda * (b - 1);
    let h00 = lambda;
    let h01 = 0;
    let h11 = lambda;
    for (let i = 0; i < ps.length; i += 1) {
      const x = logit(ps[i]);
      const p = sigmoid(a + b * x);
      const r = p - ys[i];
      const w = Math.max(p * (1 - p), 1e-4);
      g0 += r;
      g1 += r * x;
      h00 += w;
      h01 += w * x;
      h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a = clamp(a - da, -1.5, 1.5);
    b = clamp(b - db, 0.25, 1.5);
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a, b };
}

function applyPlatt(p, fit) {
  if (!fit) return clipP(p);
  return clipP(sigmoid(fit.a + fit.b * logit(p)));
}

function fitIsotonic(ps, ys) {
  const rows = ps.map((p, i) => ({ p, y: ys[i] })).sort((a, b) => a.p - b.p || a.y - b.y);
  const blocks = rows.map((r) => ({ lo: r.p, hi: r.p, sum: r.y, n: 1, avg: r.y }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].avg <= blocks[i + 1].avg + 1e-12) {
      i += 1;
      continue;
    }
    const merged = {
      lo: blocks[i].lo,
      hi: blocks[i + 1].hi,
      sum: blocks[i].sum + blocks[i + 1].sum,
      n: blocks[i].n + blocks[i + 1].n,
    };
    merged.avg = merged.sum / merged.n;
    blocks.splice(i, 2, merged);
    if (i > 0) i -= 1;
  }
  return blocks.map((b) => ({ lo: b.lo, hi: b.hi, avg: clipP(b.avg), n: b.n }));
}

function applyIsotonic(blocks, p) {
  if (!blocks || !blocks.length) return clipP(p);
  if (p <= blocks[0].lo) return blocks[0].avg;
  for (const b of blocks) {
    if (p <= b.hi + 1e-12) return b.avg;
  }
  return blocks[blocks.length - 1].avg;
}

function chooseShrink(rows) {
  let bestK = PRIOR_SHRINK_K;
  let best = Infinity;
  const ys = rows.map((r) => yOf(r));
  for (const k of SHRINK_GRID) {
    const ps = rows.map((r) => shrinkP(r.pModel, r.pMkt, k));
    const score = brier(ps, ys) + SHRINK_PRIOR_PENALTY * (k - PRIOR_SHRINK_K) ** 2;
    if (score < best - 1e-12) {
      best = score;
      bestK = k;
    }
  }
  return bestK;
}

function priorModel(n) {
  return {
    n: n || 0,
    k: PRIOR_SHRINK_K,
    platt: { a: 0, b: 1 },
    isotonic: null,
    method: 'prior',
  };
}

function fitShrinkOnly(rows) {
  return {
    n: rows.length,
    k: chooseShrink(rows),
    platt: { a: 0, b: 1 },
    isotonic: null,
    method: 'shrink',
  };
}

function fitPlattModel(rows) {
  const k = chooseShrink(rows);
  const shrunk = rows.map((r) => shrinkP(r.pModel, r.pMkt, k));
  return {
    n: rows.length,
    k,
    platt: fitPlatt(shrunk, rows.map((r) => yOf(r))),
    isotonic: null,
    method: 'platt',
  };
}

function fitIsoModel(rows) {
  const base = fitPlattModel(rows);
  const shrunk = rows.map((r) => shrinkP(r.pModel, r.pMkt, base.k));
  const plattPs = shrunk.map((p) => applyPlatt(p, base.platt));
  return {
    ...base,
    isotonic: fitIsotonic(plattPs, rows.map((r) => yOf(r))),
    method: 'platt+isotonic',
  };
}

function predictRow(model, row) {
  const pShrink = shrinkP(row.pModel, row.pMkt, model.k);
  const pPlatt = applyPlatt(pShrink, model.platt);
  if (model.isotonic) return clipP(0.5 * pPlatt + 0.5 * applyIsotonic(model.isotonic, pPlatt));
  return pPlatt;
}

function scoreModel(model, rows) {
  const ps = rows.map((row) => predictRow(model, row));
  return brier(ps, rows.map((row) => yOf(row)));
}

/**
 * Pick prior, shrink, Platt, or isotonic on a chronological holdout inside
 * the training rows, then refit that method on every row before the card.
 * In-sample isotonic is not allowed to nominate itself.
 */
function fitSelected(rows) {
  const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < MIN_POOLED) return priorModel(sorted.length);
  if (sorted.length < 16) return fitShrinkOnly(sorted);
  const holdN = Math.max(8, Math.floor(sorted.length * 0.3));
  const train = sorted.slice(0, sorted.length - holdN);
  const test = sorted.slice(sorted.length - holdN);
  if (train.length < MIN_POOLED) return fitShrinkOnly(sorted);
  const options = [priorModel(train.length), fitShrinkOnly(train), fitPlattModel(train)];
  if (train.length >= ISOTONIC_MIN) options.push(fitIsoModel(train));
  let best = options[0];
  let bestScore = scoreModel(best, test);
  for (const model of options.slice(1)) {
    const score = scoreModel(model, test);
    if (score < bestScore - 1e-6) {
      best = model;
      bestScore = score;
    }
  }
  if (best.method === 'prior') return priorModel(sorted.length);
  if (best.method === 'shrink') return fitShrinkOnly(sorted);
  if (best.method === 'platt') return fitPlattModel(sorted);
  return fitIsoModel(sorted);
}

function usable(row) {
  const y = yOf(row);
  const pModel = Number(row && row.pModel);
  const pMkt = Number(row && row.pMkt);
  return y != null
    && Number.isFinite(pModel) && pModel > 0 && pModel < 1
    && Number.isFinite(pMkt) && pMkt > 0 && pMkt < 1;
}

function estimationUncertainty(rows) {
  if (!rows || rows.length < 5) return 0.30;
  let s = 0;
  for (const r of rows) {
    const p = shrinkP(r.pModel, r.pMkt, PRIOR_SHRINK_K);
    s += (p - yOf(r)) ** 2;
  }
  const rmse = Math.sqrt(s / rows.length);
  const se = rmse / Math.sqrt(rows.length);
  return clamp(0.12 + se, 0.12, 0.40);
}

/**
 * Fit per-sport shrink + Platt (isotonic blend once n >= 40).
 * Uses only rows dated before cardDate. Empty history returns the prior.
 * A sport under its floor is counted and then left out of bySport.
 * The pooled fit is kept for the card stamp. It is not an applied map
 * for a sport under the floor, and applyCalibration does not read it.
 */
function fitWalkForward(history, cardDate) {
  const rows = (history || []).filter(usable);
  assertNoLeakage(rows, cardDate);
  const bias = mathMode === 'linear' ? {} : fitCellBias(rows);
  const trainRows = mathMode === 'linear' ? rows : centerRows(rows, bias);
  const pooled = fitSelected(trainRows);
  const bySport = {};
  const sportN = {};
  const sports = [...new Set(rows.map((r) => String(r.sport || '').toUpperCase()).filter(Boolean))];
  for (const sport of sports) {
    const subset = trainRows.filter((r) => String(r.sport || '').toUpperCase() === sport);
    sportN[sport] = subset.length;
    // Own holdout only. A thinner pooled fit must not fill this in.
    if (subset.length >= sportFloor(sport)) bySport[sport] = fitSelected(subset);
  }
  const uncertainty = { default: estimationUncertainty(rows) };
  for (const sport of sports) {
    const subset = rows.filter((r) => String(r.sport || '').toUpperCase() === sport);
    uncertainty[sport] = estimationUncertainty(subset.length >= 5 ? subset : rows);
  }
  let trainMaxDate = null;
  for (const r of rows) {
    if (trainMaxDate == null || r.date > trainMaxDate) trainMaxDate = r.date;
  }
  return {
    cardDate: String(cardDate),
    trainN: rows.length,
    trainMaxDate,
    pooled,
    bySport,
    sportN,
    bias,
    uncertainty,
    leakageChecked: true,
    mathMode,
  };
}

function priorKFor(sport) {
  const key = String(sport || '').toUpperCase();
  if (SPORT_PRIOR_K && Object.prototype.hasOwnProperty.call(SPORT_PRIOR_K, key)) {
    return SPORT_PRIOR_K[key];
  }
  return PRIOR_SHRINK_K;
}

function sportFloor(sport) {
  const key = String(sport || '').toUpperCase();
  if (SPORT_MIN_GAMES && Object.prototype.hasOwnProperty.call(SPORT_MIN_GAMES, key)) {
    const n = Number(SPORT_MIN_GAMES[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return MIN_SPORT;
}

/** Graded rows for this sport. A missing count is 0, not the pooled n. */
function sportCount(fit, sport) {
  const key = String(sport || '').toUpperCase();
  if (fit && fit.sportN && Number.isFinite(Number(fit.sportN[key]))) return Number(fit.sportN[key]);
  if (fit && fit.bySport && fit.bySport[key] && Number.isFinite(Number(fit.bySport[key].n))) {
    return Number(fit.bySport[key].n);
  }
  return 0;
}

/**
 * Weight on the sport prior. n0 / (n0 + n), clamped to [0, 1].
 * Zero rows is a full prior (w = 1).
 */
function priorWeight(nSport) {
  const n = Number(nSport);
  const sample = Number.isFinite(n) && n > 0 ? n : 0;
  return clamp(SHRINK_N0 / (SHRINK_N0 + sample), 0, 1);
}

function nhlMoneylineLocked(sport, market, pick, beatsNovig) {
  const flag = beatsNovig == null ? NHL_ML_WALKFORWARD_BEATS_NOVIG : !!beatsNovig;
  if (flag) return false;
  if (String(sport || '').toUpperCase() !== 'NHL') return false;
  return marketFamily(market, pick) === 'Moneyline';
}

/**
 * Shrink toward the sharp no-vig fair.
 * p = (1 - k) * pModel + k * pFair.
 * Under the sport floor, or with no fitted k, k is the sport prior.
 * At or above the floor, k blends that prior with the sport fit:
 *   w = priorWeight(n), k = w * k_prior + (1 - w) * k_fit.
 * NHL moneylines return NHL_ML_SHRINK_K until a walk-forward beats no-vig.
 */
function shrinkKFor(sport, nSport, kFit, market, pick, beatsNovig) {
  if (nhlMoneylineLocked(sport, market, pick, beatsNovig)) return NHL_ML_SHRINK_K;
  const kPrior = priorKFor(sport);
  const n = Number(nSport);
  const sample = Number.isFinite(n) && n > 0 ? n : 0;
  if (sample < sportFloor(sport) || !Number.isFinite(Number(kFit))) return kPrior;
  const w = priorWeight(sample);
  return clamp(w * kPrior + (1 - w) * Number(kFit), 0, 1);
}

/**
 * Sport model only when that sport is at its floor.
 * The pooled fit is not a fallback. Callers under the floor use the prior.
 */
function modelFor(fit, sport) {
  const key = String(sport || '').toUpperCase();
  const n = sportCount(fit, sport);
  if (n >= sportFloor(sport) && fit && fit.bySport && fit.bySport[key]) return fit.bySport[key];
  return {
    n,
    k: priorKFor(sport),
    platt: { a: 0, b: 1 },
    isotonic: null,
    method: n > 0 ? 'sport-floor' : 'prior',
  };
}

function uncertaintyFor(fit, sport, candidateUncertainty) {
  const u = Number(candidateUncertainty);
  if (Number.isFinite(u) && u > 0 && u <= 1) return u;
  const key = String(sport || '').toUpperCase();
  if (fit && fit.uncertainty && Number.isFinite(fit.uncertainty[key])) return fit.uncertainty[key];
  if (fit && fit.uncertainty && Number.isFinite(fit.uncertainty.default)) return fit.uncertainty.default;
  return 0.30;
}

/**
 * Final probability, then the 10pp screen in select.js reads this pCal.
 * Shrink first. A Platt or isotonic map runs only for a sport at its floor,
 * and only from that sport's fit. NHL moneylines skip the map while the
 * no-vig lock is on, so pCal is the fair. Pooled coefficients are never read.
 */
function applyCalibration(candidate, fit) {
  const pModel = Number(candidate && candidate.pModel);
  const pMkt = Number(candidate && candidate.pMkt);
  if (!Number.isFinite(pModel) || !Number.isFinite(pMkt)) return null;
  const sport = candidate && candidate.sport;
  const market = candidate && (candidate.market || candidate.marketFamily || candidate.betType);
  const pick = candidate && (candidate.pick || candidate.side);
  const n = sportCount(fit, sport);
  const locked = nhlMoneylineLocked(sport, market, pick);
  const floor = sportFloor(sport);
  const key = String(sport || '').toUpperCase();
  const sportModel = !locked && n >= floor && fit && fit.bySport && fit.bySport[key]
    ? fit.bySport[key]
    : null;
  const k = shrinkKFor(sport, n, sportModel ? sportModel.k : null, market, pick);
  const intercept = locked || mathMode === 'linear' ? 0 : biasFor(fit && fit.bias, candidate);
  const pShrink = mathMode === 'linear'
    ? shrinkPLinear(pModel, pMkt, k)
    : shrinkP(pModel, pMkt, k, intercept);
  let method = locked ? 'nhl-ml-novig' : (sportModel ? sportModel.method : (n > 0 ? 'sport-floor' : 'prior'));
  let pCal = pShrink;
  let mapApplied = false;
  if (sportModel && (sportModel.method === 'platt' || sportModel.method === 'platt+isotonic')) {
    const pPlatt = applyPlatt(pShrink, sportModel.platt);
    pCal = pPlatt;
    if (sportModel.isotonic) {
      pCal = clipP(0.5 * pPlatt + 0.5 * applyIsotonic(sportModel.isotonic, pPlatt));
    }
    mapApplied = true;
    method = sportModel.method;
  }
  return {
    pModel: clipP(pModel),
    pMkt: clipP(pMkt),
    pShrink,
    pCal,
    intercept,
    shrinkK: k,
    method,
    trainN: n,
    sportFloor: floor,
    mapApplied,
    pooledIgnored: true,
  };
}

module.exports = {
  clamp,
  clipP,
  brier,
  logLoss,
  assertNoLeakage,
  fitWalkForward,
  applyCalibration,
  uncertaintyFor,
  shrinkP,
  shrinkPLinear,
  setMathMode,
  fitCellBias,
  biasFor,
  cellKey,
  BIAS_N0,
  modelFor,
  priorKFor,
  sportFloor,
  sportCount,
  priorWeight,
  nhlMoneylineLocked,
  shrinkKFor,
};
