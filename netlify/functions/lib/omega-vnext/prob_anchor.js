'use strict';

/**
 * NHL and MLB post-calibration anchor, then the published edge.
 *
 * p_final = w * p_model + (1 - w) * p_fair
 * w is MARKET_ANCHOR_MODEL_WEIGHT (1 = model, 0 = market).
 * p_fair is the Pinnacle power no-vig on this side at this line, else the
 * DraftKings two-way no-vig (power past -250/+210, otherwise proportional).
 * No fair: the row stays on p_model and anchorFairSource is 'none'.
 * Other sports are not in the weight table and are not touched.
 *
 * Published edge = p - vigged implied(odds).
 * Published EV = p * decimal(odds) - 1.
 * This is not the marketAnchorOn() K-table. That switch stays off.
 */

const { MARKET_ANCHOR_MODEL_WEIGHT } = require('./config');
const { americanToImplied, americanToDecimal, formatEdgePct, noVigTwoWay } = require('./odds_math');
const { powerFair } = require('./pure_model');

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function modelWeightFor(sport) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  const key = String(sport || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const w = Number(table[key]);
  if (!Number.isFinite(w)) return null;
  if (w < 0) return 0;
  if (w > 1) return 1;
  return w;
}

/** w = 1 returns pModel. w = 0 returns pFair. */
function anchorProbability(pModel, pFair, modelWeight) {
  const w = Number(modelWeight);
  const pm = Number(pModel);
  const pf = Number(pFair);
  if (!Number.isFinite(w) || !Number.isFinite(pm) || !Number.isFinite(pf)) return null;
  return (w * pm) + ((1 - w) * pf);
}

function oneLine(a, b) {
  if (a == null || a === '' || b == null || b === '') return true;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 1e-6 || Math.abs(x + y) < 1e-6;
}

/** Pinnacle power no-vig for this side. Null when the row has no same-line pair. */
function pinnacleFair(c) {
  const ps = c && c.pinnacleSide;
  if (!ps || !Number.isFinite(Number(ps.american)) || !Number.isFinite(Number(ps.oppAmerican))) return null;
  if (!oneLine(ps.point, ps.oppPoint)) return null;
  const powered = powerFair(c);
  if (powered != null) return powered;
  return finiteProb(c.pinnacleNoVigP);
}

function marketFamily(market) {
  const m = String(market || '');
  if (/total/i.test(m)) return 'total';
  if (/spread|puck|run/i.test(m)) return 'spread';
  return 'ml';
}

function pairKey(c) {
  const line = c && c.line != null && c.line !== '' ? Number(c.line) : null;
  const abs = line == null || !Number.isFinite(line) ? 'ml' : Math.abs(line).toFixed(2);
  const game = (c && (c.matchup || `${c.awayTeam} @ ${c.homeTeam}`)) || '';
  return [
    String((c && c.sport) || ''),
    game,
    String((c && c.commenceTime) || ''),
    marketFamily(c && c.market),
    abs,
  ].join('\0');
}

function isOpposite(a, b) {
  if (!a || !b || a === b) return false;
  if (marketFamily(a.market) !== marketFamily(b.market)) return false;
  const fam = marketFamily(a.market);
  if (fam === 'total') {
    const ao = /^over\b/i.test(String(a.side || ''));
    const au = /^under\b/i.test(String(a.side || ''));
    const bo = /^over\b/i.test(String(b.side || ''));
    const bu = /^under\b/i.test(String(b.side || ''));
    if (!((ao && bu) || (au && bo))) return false;
    return Math.abs(Number(a.line) - Number(b.line)) < 1e-6;
  }
  if (fam === 'spread' && !(Math.abs(Number(a.line) + Number(b.line)) < 1e-6)) return false;
  return String(a.side || '') !== String(b.side || '');
}

function dkAmerican(c) {
  if (!c) return null;
  const quote = c.dkQuote;
  if (quote && Number.isFinite(Number(quote.american))) {
    const pt = quote.point != null ? Number(quote.point) : null;
    const line = c.line != null && c.line !== '' ? Number(c.line) : null;
    if (pt == null || line == null || Math.abs(pt - line) < 1e-6) return Number(quote.american);
  }
  const prices = Array.isArray(c.bookPrices) ? c.bookPrices : [];
  for (const p of prices) {
    if (String(p && p.book || '').toLowerCase() !== 'draftkings') continue;
    if (!Number.isFinite(Number(p.american))) continue;
    const pt = p.point != null ? Number(p.point) : null;
    const line = c.line != null && c.line !== '' ? Number(c.line) : null;
    if (pt != null && line != null && Math.abs(pt - line) > 1e-6) continue;
    return Number(p.american);
  }
  const book = String(c.book || c.executionBook || c.priceBook || '').toLowerCase();
  if (book === 'draftkings' && Number.isFinite(Number(c.odds))) return Number(c.odds);
  return null;
}

function draftkingsFair(c, opp) {
  const a1 = dkAmerican(c);
  const a2 = dkAmerican(opp);
  if (a1 == null || a2 == null) return null;
  const nv = noVigTwoWay(a1, a2);
  return nv ? finiteProb(nv.p1) : null;
}

/**
 * Anchor NHL and MLB coverProb. Other sports return the same row.
 * Does not drop a row.
 */
function applyMarketAnchor(candidates) {
  const rows = candidates || [];
  const groups = new Map();
  for (const c of rows) {
    if (!c || modelWeightFor(c.sport) == null) continue;
    const key = pairKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return rows.map((c) => {
    if (!c) return c;
    const w = modelWeightFor(c.sport);
    if (w == null) return c;
    const pModel = finiteProb(c.coverProb);
    let pFair = pinnacleFair(c);
    let source = pFair != null ? 'pinnacle' : 'none';
    if (pFair == null) {
      const opp = (groups.get(pairKey(c)) || []).find((row) => isOpposite(c, row));
      const dk = opp ? draftkingsFair(c, opp) : null;
      if (dk != null) {
        pFair = dk;
        source = 'draftkings';
      }
    }
    const stamped = {
      p_model: pModel != null ? pModel : (c.p_model != null ? c.p_model : null),
      p_fair: pFair != null ? +Number(pFair).toFixed(6) : null,
      anchorWeight: w,
      anchorFairSource: source,
    };
    if (pModel == null || pFair == null) {
      return { ...c, ...stamped, anchorFairSource: 'none', p_fair: null };
    }
    const p = anchorProbability(pModel, pFair, w);
    if (p == null || !Number.isFinite(p)) {
      return { ...c, ...stamped, anchorFairSource: 'none' };
    }
    return { ...c, ...stamped, coverProb: p };
  });
}

function retailBook(c) {
  const book = String((c && (c.book || c.priceBook || c.executionBook)) || '').toLowerCase();
  if (book === 'hardrockbet_oh' || book === 'hardrock') return 'hardrockbet';
  return book;
}

/**
 * edge = p - vigged implied. EV = p * decimal - 1.
 * Leaves coverProb and modelPureP. DK and Hard Rock stay liquid.
 * Clears the sharp-fair and movement flags the old pure-model step cleared,
 * so those gates do not start rejecting the calibrated row.
 */
function priceEdgeAtBet(c) {
  if (!c) return c;
  const p = Number(c.coverProb);
  if (!Number.isFinite(p)) return c;
  const implied = americanToImplied(c.odds);
  const dec = americanToDecimal(c.odds);
  const edge = implied != null ? p - implied : null;
  const ev = dec != null ? (p * dec) - 1 : null;
  const retail = retailBook(c) === 'draftkings' || retailBook(c) === 'hardrockbet';
  return {
    ...c,
    sharpFairPriced: false,
    sharpFairReject: null,
    movementDrop: false,
    movementDropReason: null,
    ev: ev != null ? +ev.toFixed(6) : null,
    edgePct: edge != null ? +edge.toFixed(6) : null,
    edgePctDisplay: formatEdgePct(edge),
    edgeBasis: 'model-edge-vs-bet-price',
    evBasis: 'model-stake-ev',
    gradeBasis: 'model-edge-vs-bet-price',
    ...(retail ? { liquid: true } : {}),
  };
}

function priceEdgesAtBet(candidates) {
  return (candidates || []).map(priceEdgeAtBet);
}

module.exports = {
  anchorProbability,
  applyMarketAnchor,
  priceEdgeAtBet,
  priceEdgesAtBet,
  pinnacleFair,
  modelWeightFor,
};
