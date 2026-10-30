'use strict';

const {
  EDGE_FLOOR, MAX_EDGE, MAX_STRAIGHTS, PRICE_BASE_DECIMAL, UNC_BASELINE,
} = require('./constants');
const { clamp, uncertaintyFor } = require('./calibrate');
const { americanToImplied, americanToDecimal, evAtOdds } = require('../omega-vnext/odds_math');

function normTeam(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bsaint louis\b/g, 'st louis')
    .replace(/\bst\s+louis\b/g, 'st louis')
    .replace(/\s+/g, ' ')
    .trim();
}

function gameKey(matchup) {
  return normTeam(matchup).replace(/\s*@\s*/g, ' @ ');
}

function marketFamily(market, pick) {
  const token = String(market || '').toLowerCase();
  const text = String(pick || '');
  if (token === 'total' || token === 'totals' || /total/.test(token) || /^\s*(over|under)\b/i.test(text)) {
    return 'Total';
  }
  if (token === 'spread' || token === 'spreads' || /spread|puck|run line/.test(token)) return 'Spread';
  if (token === 'moneyline' || token === 'h2h' || token === 'ml' || /\bml\b/i.test(text)) return 'Moneyline';
  if (/[+-]\d/.test(text) && !/\bml\b/i.test(text)) return 'Spread';
  return 'Moneyline';
}

function totalSide(pick) {
  if (/^\s*over\b/i.test(pick || '')) return 'over';
  if (/^\s*under\b/i.test(pick || '')) return 'under';
  return null;
}

function edgeFloor(candidate, fit) {
  const dec = americanToDecimal(candidate.odds);
  const priceScale = clamp((dec || PRICE_BASE_DECIMAL) / PRICE_BASE_DECIMAL, 0.85, 2);
  const u = uncertaintyFor(fit, candidate.sport, candidate.uncertainty);
  const uncScale = clamp(u / UNC_BASELINE, 0.85, 2);
  return {
    floor: EDGE_FLOOR * priceScale * uncScale,
    priceScale,
    uncScale,
    uncertainty: u,
  };
}

/**
 * A side qualifies only when its calibrated edge over the pick-time price
 * clears the scaled floor. Nothing is added to fill a slot.
 */
function annotateCandidate(candidate, fit) {
  const cal = candidate.calibration;
  if (!cal) return { ...candidate, qualified: false, rejectReason: 'no-calibration' };
  const implied = americanToImplied(candidate.odds);
  const dec = americanToDecimal(candidate.odds);
  if (implied == null || dec == null) {
    return { ...candidate, qualified: false, rejectReason: 'bad-price' };
  }
  const edge = cal.pCal - implied;
  const ev = evAtOdds(cal.pCal, candidate.odds);
  const scaled = edgeFloor(candidate, fit);
  let rejectReason = null;
  if (!(edge >= scaled.floor)) rejectReason = 'edge-below-floor';
  else if (edge > MAX_EDGE) rejectReason = 'edge-over-10pp';
  else if (!(ev >= 0)) rejectReason = 'negative-ev';
  return {
    ...candidate,
    implied,
    decimal: dec,
    edge,
    ev,
    floor: scaled.floor,
    priceScale: scaled.priceScale,
    uncScale: scaled.uncScale,
    uncertaintyUsed: scaled.uncertainty,
    qualified: rejectReason == null,
    rejectReason,
  };
}

function selectStraights(annotated) {
  const ranked = (annotated || [])
    .filter((c) => c.qualified)
    .sort((a, b) => (b.ev - a.ev) || (b.edge - a.edge) || String(a.pick).localeCompare(String(b.pick)));
  const out = [];
  const used = new Set();
  for (const c of ranked) {
    if (out.length >= MAX_STRAIGHTS) break;
    if (used.has(c.gameKey)) continue;
    used.add(c.gameKey);
    out.push(c);
  }
  return out;
}

module.exports = {
  normTeam,
  gameKey,
  marketFamily,
  totalSide,
  edgeFloor,
  annotateCandidate,
  selectStraights,
};
