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
function applyPureModelOne(c) {
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
};
