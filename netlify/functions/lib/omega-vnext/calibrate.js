'use strict';

const fs = require('fs');
const path = require('path');
const { SHRINK_K, MLB_CALIBRATION } = require('./config');
const { clamp } = require('./odds_math');

/**
 * Unset OMEGA_CAL_MODE uses this.
 * A drops the unfitted 0.42–0.58 band and keeps the hand-set shrink.
 * It beats production log-loss out of sample and keeps 1.765 picks/day.
 * B fits K and stays selectable. The 2026-10-10 and 2026-10-11 dry runs
 * published 0 picks under that fitted K. C stays selectable.
 * 'legacy' is the hand-set shrink plus the unfitted band, and the rollback.
 */
const CAL_MODE_DEFAULT = 'A';

/**
 * Mode B box on the linear shrink weight.
 * p = (1 - K) * p_model + K * p_sharp.
 * K_MAX = 1 is the sharp end of that formula. K above 1 would pass the sharp.
 * K_MIN = 0.3 is a product constraint, not a log-loss estimate. It is the
 * lowest hand-set shrink already on the card (MLB moneyline). The
 * unconstrained minimizer is stored as kMle and may sit below 0.3.
 * The probability that is published never uses a K below 0.3.
 */
const K_POLICY = Object.freeze({
  min: 0.3,
  max: 1.0,
  gridStep: 0.01,
  minIsProductConstraint: true,
  note: 'K_MIN matches MLB moneyline hand-set shrinkK 0.30. It is not the log-loss minimizer. kMle records the unconstrained grid minimizer on [0, 1].',
});

/**
 * Pre-specified sample floors for the expanding-window fit.
 * Not tuned on the 2026-09-22..10-08 eval dates.
 * A cell under the floor uses the sport pool, then the global pool.
 * Mode C uses a Platt map (a, b) on the hand-set shrunk probability.
 * Isotonic regression is eligible only at the larger floor, and only when
 * its train log-loss beats Platt by isoTrainMargin. That margin is the
 * cost of a flexible step map. It is not fit on the eval day.
 */
const CAL_POOL = Object.freeze({
  minRows: 80,
  minGames: 20,
  isoMinRows: 400,
  isoMinGames: 50,
  isoTrainMargin: 0.001,
  plattA: Object.freeze([-2, 2]),
  plattB: Object.freeze([0, 2]),
});

/**
 * The legacy second step. Fixed band, not a fitted isotonic regression.
 * Outside [lo, hi], keep `keep` of the excess and drop the rest.
 * Default 0.42–0.58 keeping 0.25, every sport. The historical name was
 * isotonicClip. That name overclaimed the method.
 */
const BAND_CLIP = Object.freeze({
  lo: 0.42,
  hi: 0.58,
  keep: 0.25,
  fitted: false,
  name: 'bandRetainClip',
  historicalName: 'isotonicClip',
  note: 'Fixed band. Not an isotonic regression and not fit to outcomes.',
});

const BUNDLED_PARAMS = path.join(__dirname, 'data', 'omega-cal-mode.json');

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

function marketFamily(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return 'Total';
  if (/spread|run line|puck/i.test(m)) return 'Spread';
  if (/moneyline|^ml$/i.test(m)) return 'Moneyline';
  return 'default';
}

function cellKey(sport, market) {
  return `${sport || 'default'}|${marketFamily(market)}`;
}

/**
 * p = (1 - K) * p_model + K * p_sharp, clamped to [0.02, 0.98].
 * K is the weight on the no-vig sharp.
 */
function linearShrink(pModel, pSharp, K) {
  if (!Number.isFinite(pModel)) return null;
  const k = Number(K);
  if (!Number.isFinite(pSharp) || !Number.isFinite(k)) return clamp(pModel, 0.02, 0.98);
  const raw = (1 - k) * pModel + k * pSharp;
  return clamp(raw, 0.02, 0.98);
}

/**
 * Hand-set shrink. p_cal = (1 - K) * p_model + K * p_sharp.
 * K comes from SHRINK_K, or from MLB_CALIBRATION.shrinkK for MLB.
 */
function shrinkTowardSharp(pModel, pSharp, market, sport) {
  return linearShrink(pModel, pSharp, shrinkKForMarket(market, sport));
}

function bandRetainClip(p, lo = BAND_CLIP.lo, hi = BAND_CLIP.hi, keep = BAND_CLIP.keep) {
  if (!Number.isFinite(p)) return p;
  const retain = Number.isFinite(keep) ? keep : BAND_CLIP.keep;
  if (p < lo) return lo - (lo - p) * retain;
  if (p > hi) return hi + (p - hi) * retain;
  return p;
}

/** Historical name for bandRetainClip. Not a fitted isotonic regression. */
function isotonicClip(p, lo, hi, keep) {
  return bandRetainClip(p, lo, hi, keep);
}

function logit(p) {
  const x = clamp(Number(p), 1e-6, 1 - 1e-6);
  return Math.log(x / (1 - x));
}

function sigmoid(z) {
  if (!Number.isFinite(z)) return null;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function clampK(k) {
  if (!Number.isFinite(k)) return null;
  return clamp(k, K_POLICY.min, K_POLICY.max);
}

function clampPlatt(a, b) {
  const aa = Number(a);
  const bb = Number(b);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return null;
  return {
    a: clamp(aa, CAL_POOL.plattA[0], CAL_POOL.plattA[1]),
    b: clamp(bb, CAL_POOL.plattB[0], CAL_POOL.plattB[1]),
  };
}

/**
 * Apply a mode-C map to an already shrunk probability.
 * identity leaves it unchanged (still clamped).
 * platt is sigmoid(a + b * logit(p)) with b >= 0 so the map stays nondecreasing.
 * isotonic is a monotone regression stored as blocks. Gaps between blocks
 * are linear in p. This is the only isotonic in the stack, and only mode C
 * uses it, and only when the train fold cleared CAL_POOL.isoMinRows.
 */
function applyProbabilityMap(p, map) {
  if (!Number.isFinite(p)) return p;
  if (!map || map.type == null || map.type === 'identity') return clamp(p, 0.02, 0.98);
  if (map.type === 'platt') {
    const box = clampPlatt(map.a, map.b);
    if (!box) return clamp(p, 0.02, 0.98);
    const y = sigmoid(box.a + box.b * logit(p));
    if (!Number.isFinite(y)) return clamp(p, 0.02, 0.98);
    return clamp(y, 0.02, 0.98);
  }
  if (map.type === 'isotonic') {
    const knots = Array.isArray(map.knots) ? map.knots : [];
    if (!knots.length || !Number.isFinite(knots[0].v)) return clamp(p, 0.02, 0.98);
    if (p <= knots[0].x0) return clamp(knots[0].v, 0.02, 0.98);
    const last = knots[knots.length - 1];
    if (p >= last.x1) return clamp(last.v, 0.02, 0.98);
    for (let i = 0; i < knots.length; i++) {
      const k = knots[i];
      if (p >= k.x0 && p <= k.x1) return clamp(k.v, 0.02, 0.98);
      const n = knots[i + 1];
      if (n && p > k.x1 && p < n.x0) {
        const span = n.x0 - k.x1;
        const t = span > 0 ? (p - k.x1) / span : 0;
        return clamp(k.v + t * (n.v - k.v), 0.02, 0.98);
      }
    }
    return clamp(last.v, 0.02, 0.98);
  }
  return clamp(p, 0.02, 0.98);
}

function resolveCalMode(raw) {
  const v = raw === undefined ? process.env.OMEGA_CAL_MODE : raw;
  if (v == null || String(v).trim() === '') return CAL_MODE_DEFAULT;
  const s = String(v).trim().toLowerCase();
  if (s === 'legacy' || s === 'production' || s === 'current' || s === '0') return 'legacy';
  if (s === 'a') return 'A';
  if (s === 'b') return 'B';
  if (s === 'c') return 'C';
  return 'legacy';
}

let paramsCache = { key: '', data: undefined };

function clearCalParamsCache() {
  paramsCache = { key: '', data: undefined };
}

function paramsFilePath() {
  return process.env.OMEGA_CAL_PARAMS_FILE || BUNDLED_PARAMS;
}

function readParamsDoc() {
  const file = paramsFilePath();
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (paramsCache.key === key) return paramsCache.data;
  try {
    paramsCache = { key, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    paramsCache = { key, data: null };
  }
  return paramsCache.data;
}

/**
 * byDate[D] was fit on rows dated before D. An exact key is the replay record.
 * A card after the last key uses `ship`, which was fit on the whole study
 * window including the last day. Do not use `ship` to score a date that has
 * its own byDate key.
 */
function recordForCardDate(doc, cardDate) {
  if (!doc || typeof doc !== 'object') return { record: null, source: 'none' };
  const by = doc.byDate && typeof doc.byDate === 'object' ? doc.byDate : {};
  if (cardDate && by[cardDate]) return { record: by[cardDate], source: 'byDate' };
  const keys = Object.keys(by).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (cardDate && keys.length) {
    const last = keys[keys.length - 1];
    if (cardDate > last && doc.ship) return { record: doc.ship, source: 'ship' };
    const prior = keys.filter((d) => d <= cardDate);
    if (prior.length) return { record: by[prior[prior.length - 1]], source: 'byDate' };
    if (doc.ship) return { record: doc.ship, source: 'ship' };
  }
  if (doc.ship) return { record: doc.ship, source: 'ship' };
  return { record: null, source: 'none' };
}

function cellFromRecord(record, mode, sport, market) {
  if (!record) return null;
  const block = record[mode];
  if (!block || !block.cells) return null;
  return block.cells[cellKey(sport, market)] || null;
}

function probabilityForMode(mode, pModel, pSharp, market, sport, record) {
  const handK = shrinkKForMarket(market, sport);
  if (mode === 'A') {
    return {
      p: linearShrink(pModel, pSharp, handK),
      calibK: handK,
      level: 'handset',
      mapType: null,
    };
  }
  if (mode === 'B') {
    const cell = cellFromRecord(record, 'B', sport, market);
    const applied = cell && Number.isFinite(Number(cell.k)) ? clampK(Number(cell.k)) : handK;
    return {
      p: linearShrink(pModel, pSharp, applied),
      calibK: applied,
      level: cell && cell.level ? cell.level : 'handset',
      mapType: null,
    };
  }
  if (mode === 'C') {
    const shrunk = linearShrink(pModel, pSharp, handK);
    const cell = cellFromRecord(record, 'C', sport, market);
    const map = cell && cell.type ? cell : { type: 'identity' };
    return {
      p: applyProbabilityMap(shrunk, map),
      calibK: handK,
      level: cell && cell.level ? cell.level : 'identity',
      mapType: map.type || 'identity',
    };
  }
  return {
    p: bandRetainClip(linearShrink(pModel, pSharp, handK)),
    calibK: handK,
    level: 'band',
    mapType: 'bandRetainClip',
  };
}

function cardDateOf(c, opts) {
  if (opts && opts.cardDate) return String(opts.cardDate);
  if (process.env.OMEGA_CAL_CARD_DATE) return String(process.env.OMEGA_CAL_CARD_DATE);
  if (c && c.cardDate) return String(c.cardDate);
  return null;
}

function calibrateCandidate(c, opts) {
  const mode = resolveCalMode();
  const sport = c && c.sport;
  const pModel = c.modelRawP;
  const pSharp = c.fair_sharp_p != null ? c.fair_sharp_p : c.sharpFairP;
  const cardDate = cardDateOf(c, opts);
  let record = null;
  let source = 'none';
  if (mode === 'B' || mode === 'C') {
    const found = recordForCardDate(readParamsDoc(), cardDate);
    record = found.record;
    source = found.source;
  }
  const out = probabilityForMode(mode, pModel, pSharp, c && c.market, sport, record);
  return {
    ...c,
    p_model: pModel,
    fair_sharp_p: pSharp,
    coverProb: out.p,
    calibK: out.calibK,
    calMode: mode,
    calLevel: out.level,
    calMap: out.mapType,
    calParamsSource: source,
    calCardDate: cardDate,
  };
}

function calibrateAll(candidates, opts) {
  return (candidates || []).map((c) => calibrateCandidate(c, opts));
}

module.exports = {
  CAL_MODE_DEFAULT,
  K_POLICY,
  CAL_POOL,
  BAND_CLIP,
  BUNDLED_PARAMS,
  shrinkKForMarket,
  marketFamily,
  cellKey,
  linearShrink,
  shrinkTowardSharp,
  bandRetainClip,
  isotonicClip,
  logit,
  sigmoid,
  clampK,
  clampPlatt,
  applyProbabilityMap,
  resolveCalMode,
  clearCalParamsCache,
  paramsFilePath,
  readParamsDoc,
  recordForCardDate,
  probabilityForMode,
  calibrateCandidate,
  calibrateAll,
};
