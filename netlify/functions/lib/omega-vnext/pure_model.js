'use strict';

/**
 * Published edge and EV use the sport model's own probability.
 * Edge = model probability − implied probability of the bet price.
 * EV = model probability × decimal odds − 1.
 * Pinnacle no-vig, the market blend, the hand-set shrink, line-move
 * weight, DraftKings lag, and the power fair do not enter either number.
 * fair_sharp_p stays on the row for CLV grading only.
 */

const { americanToImplied, americanToDecimal, formatEdgePct } = require('./odds_math');

const PURE_MODEL_VERSION = 'pure-model-1014';

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

/** Sport-model probability before any sharp blend. Null when it was not stamped. */
function pureProbability(c) {
  if (!c) return null;
  return finiteProb(c.modelPureP);
}

function retailBook(c) {
  const book = String((c && (c.book || c.priceBook || c.executionBook)) || '').toLowerCase();
  if (book === 'hardrockbet_oh' || book === 'hardrock') return 'hardrockbet';
  return book;
}

/**
 * One candidate. A missing pure probability cannot fall back to the blend
 * or to Pinnacle. Cover, edge, and EV are cleared so the gates reject it.
 */
/**
 * 2026-10-15 market anchor. Published p = (1 - K) * p_model + K * p_fair,
 * p_fair = Pinnacle no-vig (both sides), else the paired sharp no-vig fair.
 * K per sport|market is the walk-forward log-loss minimizer (kMle, no 0.3
 * floor) from data/omega-cal-mode.json ship. Edge = p - p_fair. EV is at the
 * execution price. No fair: the bet is skipped. Raw model p stays diagnostic.
 */
let K_TABLE = null;
const K_FLOOR = 0.7;
function kFor(sport, market) {
  if (!K_TABLE) {
    K_TABLE = {};
    try {
      const cal = require('./data/omega-cal-mode.json');
      const cells = (cal && cal.ship && cal.ship.B && cal.ship.B.cells) || {};
      for (const [key, v] of Object.entries(cells)) {
        const k = v && (v.kMle != null ? v.kMle : v.k);
        if (Number.isFinite(Number(k))) K_TABLE[key] = Math.min(1, Math.max(0, Number(k)));
      }
    } catch (_) { /* default below */ }
  }
  const m = /money/i.test(market || '') ? 'Moneyline' : (/total|over|under/i.test(market || '') ? 'Total' : 'Spread');
  const k = K_TABLE[`${sport}|${m}`];
  // Floor 0.7 toward the market until a fresh fit justifies less (2026-10-15).
  return Number.isFinite(k) ? Math.max(K_FLOOR, k) : 1;
}

function powerFair(c) {
  // Power de-vig on the Pinnacle pair at the same line (handles longshot bias).
  const ps = c && c.pinnacleSide;
  if (!ps || !Number.isFinite(Number(ps.american)) || !Number.isFinite(Number(ps.oppAmerican))) return null;
  try {
    const { powerTwoWay } = require('./sharp_fair');
    const i1 = americanToImplied(Number(ps.american));
    const i2 = americanToImplied(Number(ps.oppAmerican));
    const r = typeof powerTwoWay === 'function' ? powerTwoWay(i1, i2) : null;
    return r ? finiteProb(r.p1) : null;
  } catch (_) { return null; }
}

function fairProbability(c) {
  return powerFair(c) || finiteProb(c && c.pinnacleNoVigP) || finiteProb(c && c.fair_sharp_p) || finiteProb(c && c.sharpFairP);
}

function calibratedProbability(pModel, pFair, k) {
  return (1 - k) * pModel + k * pFair;
}

function applyPureModelOne(c) {
  if (!c) return c;
  if (!require('./config').marketAnchorOn()) return applyPureModelLegacy(c);
  const pModel = pureProbability(c);
  const pFair = fairProbability(c);
  const cleared = {
    sharpFairPriced: false,
    sharpFairReject: null,
    movementDrop: false,
    movementDropReason: null,
  };
  if (pModel == null || pFair == null) {
    return {
      ...c,
      ...cleared,
      pureModelPriced: false,
      pureModelMissing: pModel == null,
      fairMissing: pFair == null,
      coverProb: null,
      ev: null,
      edgePct: null,
    };
  }
  const k = kFor(c.sport, c.market);
  const p = calibratedProbability(pModel, pFair, k);
  const dec = americanToDecimal(c.odds);
  const ev = dec != null ? (p * dec) - 1 : null;
  const edge = p - pFair;
  const book = retailBook(c);
  const retail = book === 'draftkings' || book === 'hardrockbet';
  return {
    ...c,
    ...cleared,
    coverProb: p,
    p_model: pModel,
    p_calibrated: +p.toFixed(6),
    p_fair: +pFair.toFixed(6),
    calK: k,
    p_blended: c.modelRawP != null ? c.modelRawP : null,
    ev: ev != null ? +ev.toFixed(6) : null,
    edgePct: +edge.toFixed(6),
    edgePctDisplay: formatEdgePct(edge),
    pureModelPriced: true,
    pureModelVersion: 'market-anchor-1015',
    edgeBasis: 'calibrated-p-vs-pinnacle-novig',
    evBasis: 'calibrated-p-at-execution-price',
    gradeBasis: 'calibrated-p-vs-pinnacle-novig',
    ...(retail ? { liquid: true } : {}),
  };
}

function applyPureModelLegacy(c) {
  if (!c) return c;
  const p = pureProbability(c);
  const cleared = {
    sharpFairPriced: false,
    sharpFairReject: null,
    movementDrop: false,
    movementDropReason: null,
  };
  if (p == null) {
    return {
      ...c,
      ...cleared,
      pureModelPriced: false,
      pureModelMissing: true,
      coverProb: null,
      ev: null,
      edgePct: null,
    };
  }
  const dec = americanToDecimal(c.odds);
  const implied = americanToImplied(c.odds);
  const ev = dec != null ? (p * dec) - 1 : null;
  const edge = implied != null ? p - implied : null;
  const book = retailBook(c);
  const retail = book === 'draftkings' || book === 'hardrockbet';
  return {
    ...c,
    ...cleared,
    coverProb: p,
    p_model: p,
    p_blended: c.modelRawP != null ? c.modelRawP : null,
    ev: ev != null ? +ev.toFixed(6) : null,
    edgePct: edge != null ? +edge.toFixed(6) : null,
    edgePctDisplay: formatEdgePct(edge),
    pureModelPriced: true,
    pureModelVersion: PURE_MODEL_VERSION,
    edgeBasis: 'pure-model-edge-vs-bet-price',
    evBasis: 'pure-model-stake-ev',
    gradeBasis: 'pure-model-edge-vs-bet-price',
    // DK or Hard Rock is the bet. Pinnacle is not required for liquidity.
    ...(retail ? { liquid: true } : {}),
  };
}

function applyPureModel(candidates) {
  return (candidates || []).map(applyPureModelOne);
}

module.exports = {
  PURE_MODEL_VERSION,
  pureProbability,
  applyPureModelOne,
  applyPureModel,
  kFor,
  fairProbability,
  calibratedProbability,
};
