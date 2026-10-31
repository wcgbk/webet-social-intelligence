'use strict';

const {
  MAX_EDGE, MAX_STRAIGHTS, FAV_AMERICAN, FAV_MIN_EDGE,
} = require('./constants');
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

/** Short prices need a larger no-vig edge. See FAV_AMERICAN / FAV_MIN_EDGE. */
function failsFavoriteLimit(odds, edgeNovig) {
  const american = Number(odds);
  if (!Number.isFinite(american) || american > FAV_AMERICAN) return false;
  return !(edgeNovig >= FAV_MIN_EDGE);
}

/**
 * Straight: positive no-vig edge, positive EV at the bet price, under the
 * miscalibration cap, and clear of the short-price minimum.
 * Parlay leg: the same, except a negative price-EV can still sit in the
 * pool. The ticket is dropped later if the joint EV is not positive.
 * Nothing is added to fill a slot.
 */
function annotateCandidate(candidate) {
  const cal = candidate.calibration;
  if (!cal) {
    return {
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: 'no-calibration',
    };
  }
  const implied = americanToImplied(candidate.odds);
  const dec = americanToDecimal(candidate.odds);
  const pMkt = Number(cal.pMkt);
  if (implied == null || dec == null || !Number.isFinite(pMkt)) {
    return {
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: 'bad-price',
    };
  }
  const edge = cal.pCal - implied;
  const edgeNovig = cal.pCal - pMkt;
  const ev = evAtOdds(cal.pCal, candidate.odds);
  let rejectReason = null;
  if (!(edgeNovig > 0)) rejectReason = 'novig-edge-not-positive';
  else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
  else if (failsFavoriteLimit(candidate.odds, edgeNovig)) rejectReason = 'heavy-favorite-edge';
  const straightReject = rejectReason
    || (!(edge > 0) || !(ev > 0) ? 'price-edge-not-positive' : null);
  return {
    ...candidate,
    implied,
    decimal: dec,
    edge,
    edgeNovig,
    ev,
    qualified: straightReject == null,
    parlayQualified: rejectReason == null,
    rejectReason: straightReject,
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
  failsFavoriteLimit,
  annotateCandidate,
  selectStraights,
};
