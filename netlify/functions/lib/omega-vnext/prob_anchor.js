'use strict';

/**
 * Post-calibration anchor, then the published edge.
 *
 * p_final = w(sport, market) * modelPureP + (1 - w) * p_fair
 * w = 1 is the model. w = 0 is the market. NBA is absent and is not touched.
 * modelPureP already carries the rating-error SD. coverProb is the fallback
 * only when modelPureP is missing, so calibration is not mixed in again.
 * p_fair is the Pinnacle power no-vig on this side at this line, else the
 * DraftKings two-way no-vig. No fair: the row is not dropped. coverProb
 * stays, and anchorFairSource is 'none'.
 *
 * Published edge = p - vigged implied(odds).
 * Published EV = p * decimal(odds) - 1.
 * This is not the marketAnchorOn() K-table. That switch stays off.
 */

const {
  MARKET_ANCHOR_MODEL_WEIGHT, ratingErrorSd, effectiveSd,
} = require('./config');
const { americanToImplied, americanToDecimal, formatEdgePct, noVigTwoWay } = require('./odds_math');
const { powerFair } = require('./pure_model');

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function sportAnchored(sport) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  return Object.prototype.hasOwnProperty.call(table, String(sport || '').toUpperCase());
}

/** Per sport and market. A bare number in the table applies to every market. */
function modelWeightFor(sport, market) {
  const table = MARKET_ANCHOR_MODEL_WEIGHT || {};
  const key = String(sport || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const entry = table[key];
  let w;
  if (entry != null && typeof entry === 'object') {
    const mk = marketFamily(market);
    if (!Object.prototype.hasOwnProperty.call(entry, mk)) return null;
    w = Number(entry[mk]);
  } else {
    w = Number(entry);
  }
  if (!Number.isFinite(w)) return null;
  if (w < 0) return 0;
  if (w > 1) return 1;
  return w;
}

function normalPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Acklam rational approximation. p outside (0, 1) returns null. */
function normalQuantile(p) {
  const x = Number(p);
  if (!(x > 0) || !(x < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  if (x < plow) {
    q = Math.sqrt(-2 * Math.log(x));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (x > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - x));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = x - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * SE of the anchored p. w * phi(z) * SD_rating / SD_eff.
 * z is the standard normal quantile of the model probability.
 * Missing n uses 6. A zero rating SD (NBA) returns 0.
 */
function ratingSeOf(row) {
  if (!row) return 0;
  const market = row.market || row.betType;
  const kind = /total/i.test(String(market || '')) ? 'total' : 'margin';
  const nRaw = row.ratingN != null ? row.ratingN : row.nGames;
  const n = Number(nRaw);
  const usedN = Number.isFinite(n) && n > 0 ? n : 6;
  const sdR = ratingErrorSd(row.sport, kind, usedN);
  const sdE = effectiveSd(row.sport, kind, usedN);
  if (!(sdR > 0) || !(sdE > 0)) return 0;
  const w = modelWeightFor(row.sport, market);
  if (w == null) return 0;
  const pm = finiteProb(row.modelPureP);
  const p = pm != null ? pm : (finiteProb(row.p_model) != null ? finiteProb(row.p_model) : finiteProb(row.coverProb));
  if (p == null) return 0;
  const z = normalQuantile(p);
  if (z == null || !Number.isFinite(z)) return 0;
  return w * normalPdf(z) * sdR / sdE;
}

function pctString(p) {
  if (p == null || !Number.isFinite(Number(p))) return null;
  return `${(Number(p) * 100).toFixed(1)}%`;
}

function fairNumber(c) {
  const direct = finiteProb(c && c.p_fair);
  if (direct != null) return direct;
  const text = c && c.fairP;
  if (text == null || text === '') return null;
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  const p = String(text).includes('%') || n > 1 ? n / 100 : n;
  return finiteProb(p);
}

/** Printed fair p, source, EV-at-fair, raw model p, and the anchor weight. */
function fairPickFields(c) {
  const fair = fairNumber(c);
  const dec = americanToDecimal(c && (c.odds != null ? c.odds : c.oddsStr));
  const evFair = fair != null && dec != null ? (fair * dec) - 1 : null;
  const raw = c && c.p_model != null ? Number(c.p_model) : null;
  const weight = c && c.anchorWeight != null ? Number(c.anchorWeight) : null;
  return {
    fairP: pctString(fair),
    fairSource: (c && c.anchorFairSource) || 'none',
    evAtFair: evFair == null || !Number.isFinite(evFair) ? null : formatEdgePct(evFair),
    p_model: raw != null && Number.isFinite(raw) ? +raw.toFixed(4) : null,
    p_fair: fair != null ? +Number(fair).toFixed(6) : null,
    modelWeight: weight != null && Number.isFinite(weight) ? weight : null,
  };
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
 * Anchor coverProb from modelPureP and the fair price.
 * A sport missing from the weight table is returned unchanged.
 * No fair: the row is kept, coverProb is not replaced, anchorFairSource is 'none'.
 * The incoming coverProb is kept as p_calibrated. It does not feed final p
 * when a fair price is present.
 */
function applyMarketAnchor(candidates) {
  const rows = candidates || [];
  const groups = new Map();
  for (const c of rows) {
    if (!c || !sportAnchored(c.sport)) continue;
    const key = pairKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return rows.map((c) => {
    if (!c) return c;
    const w = modelWeightFor(c.sport, c.market);
    if (w == null) return c;
    const fromPure = finiteProb(c.modelPureP);
    const pModel = fromPure != null ? fromPure : finiteProb(c.coverProb);
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
    const se = ratingSeOf({
      ...c,
      modelPureP: pModel != null ? pModel : c.modelPureP,
      anchorWeight: w,
    });
    const stamped = {
      p_model: pModel != null ? +Number(pModel).toFixed(6) : (c.p_model != null ? c.p_model : null),
      p_fair: pFair != null ? +Number(pFair).toFixed(6) : null,
      p_calibrated: finiteProb(c.coverProb),
      anchorWeight: w,
      anchorFairSource: source,
      ratingSe: Number.isFinite(se) ? se : 0,
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
  sportAnchored,
  ratingSeOf,
  normalPdf,
  normalQuantile,
  fairPickFields,
};
