'use strict';

const { SHARP_BOOKS, US_BOOKS, MAJOR_LIQUIDITY_BOOKS } = require('./config');
const {
  americanToImplied, deVigMarket, evAtOdds, formatAmerican, clamp,
} = require('./odds_math');

function bookKey(b) {
  return String(b || '').toLowerCase();
}

/**
 * From an Odds API event + market key, collect outcomes with book prices.
 * marketKey: h2h | spreads | totals
 */
function collectMarketOutcomes(event, marketKey) {
  const books = event.bookmakers || [];
  const bySide = new Map(); // sideKey -> { side, point, prices: [{book, american}] }

  for (const bk of books) {
    const key = bookKey(bk.key);
    const mkt = (bk.markets || []).find(m => m.key === marketKey);
    if (!mkt) continue;
    for (const o of mkt.outcomes || []) {
      const point = o.point != null ? Number(o.point) : null;
      const sideName = o.name;
      const sideKey = point == null ? sideName : `${sideName}|${point}`;
      if (!bySide.has(sideKey)) {
        bySide.set(sideKey, { side: sideName, point, prices: [] });
      }
      bySide.get(sideKey).prices.push({ book: key, american: Number(o.price) });
    }
  }
  return [...bySide.values()];
}

function bestPrice(prices, allowBooks) {
  const set = allowBooks ? new Set(allowBooks.map(bookKey)) : null;
  let best = null;
  for (const p of prices || []) {
    if (set && !set.has(p.book)) continue;
    if (!Number.isFinite(p.american)) continue;
    // Higher American is better for the bettor
    if (!best || p.american > best.american) best = p;
  }
  return best;
}

function sharpConsensusAmerican(prices) {
  const sharp = (prices || []).filter(p => SHARP_BOOKS.includes(p.book));
  if (!sharp.length) {
    // fall back to median of all
    const all = (prices || []).map(p => p.american).filter(Number.isFinite).sort((a, b) => a - b);
    if (!all.length) return null;
    return all[Math.floor(all.length / 2)];
  }
  // Prefer pinnacle, else median of sharp
  const pin = sharp.find(p => p.book === 'pinnacle');
  if (pin) return pin.american;
  const sorted = sharp.map(p => p.american).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hasMajorLiquidity(prices) {
  const books = new Set((prices || []).map(p => p.book));
  let n = 0;
  for (const b of MAJOR_LIQUIDITY_BOOKS) if (books.has(b)) n++;
  return n >= 2;
}

/**
 * Build sharp no-vig fair p for a two-way market given all side bundles.
 */
function sharpFairForSide(sideBundles, targetSide, targetPoint) {
  // Pair opposite sides at same |point|
  const target = sideBundles.find(s => s.side === targetSide && (targetPoint == null || s.point === targetPoint));
  if (!target) return null;

  let opposite = null;
  if (targetPoint == null) {
    // ML: other team name
    opposite = sideBundles.find(s => s.side !== targetSide);
  } else {
    // spreads: other team same |point| opposite sign; totals: Over/Under same point
    opposite = sideBundles.find(s => {
      if (s === target) return false;
      if (/over|under/i.test(targetSide) && /over|under/i.test(s.side)) return s.point === targetPoint;
      return s.point === -targetPoint || s.point === targetPoint;
    });
  }
  if (!opposite) {
    const imp = americanToImplied(sharpConsensusAmerican(target.prices));
    return imp;
  }

  const a1 = sharpConsensusAmerican(target.prices);
  const a2 = sharpConsensusAmerican(opposite.prices);
  if (a1 == null || a2 == null) return americanToImplied(a1);
  const outcomes = [
    { side: 't', american: a1 },
    { side: 'o', american: a2 },
  ];
  const dv = deVigMarket(outcomes);
  const row = dv.find(r => r.side === 't');
  return row ? row.fairP : null;
}

/**
 * predicted CLV proxy in "cents": positive when best US price is better than sharp mid
 * OR when model fair implies value vs sharp (blend).
 */
function predictedClvCents(bestUsAmerican, sharpAmerican, pModel, fairSharpP) {
  let priceClv = 0;
  if (Number.isFinite(bestUsAmerican) && Number.isFinite(sharpAmerican)) {
    const iUs = americanToImplied(bestUsAmerican);
    const iSh = americanToImplied(sharpAmerican);
    if (iUs != null && iSh != null) {
      // Better price (lower implied) → positive
      priceClv = (iSh - iUs) * 100; // percentage points * 100 ≈ cents-ish
    }
  }
  let modelClv = 0;
  if (Number.isFinite(pModel) && Number.isFinite(fairSharpP)) {
    modelClv = (pModel - fairSharpP) * 100;
  }
  // Blend: price shopping + model vs sharp
  return +((0.55 * priceClv + 0.45 * modelClv)).toFixed(2);
}

function enrichCandidateWithEdge(raw, sideBundle, allBundles) {
  const bestUs = bestPrice(sideBundle.prices, US_BOOKS) || bestPrice(sideBundle.prices, null);
  const sharpAm = sharpConsensusAmerican(sideBundle.prices);
  const fairSharp = sharpFairForSide(allBundles, sideBundle.side, sideBundle.point);
  const odds = bestUs ? bestUs.american : sharpAm;
  const book = bestUs ? bestUs.book : 'consensus';
  const liquid = hasMajorLiquidity(sideBundle.prices);
  const predClv = predictedClvCents(odds, sharpAm, raw.modelRawP, fairSharp);
  const ev = (odds != null && Number.isFinite(raw.coverProb))
    ? evAtOdds(raw.coverProb, odds)
    : (odds != null && Number.isFinite(raw.modelRawP) ? evAtOdds(raw.modelRawP, odds) : null);

  return {
    ...raw,
    odds,
    oddsStr: formatAmerican(odds),
    book,
    sharpAmerican: sharpAm,
    fair_sharp_p: fairSharp,
    sharpFairP: fairSharp,
    predictedClv: predClv,
    liquid,
    majorBookCount: new Set((sideBundle.prices || []).map(p => p.book)
      .filter(b => MAJOR_LIQUIDITY_BOOKS.includes(b))).size,
  };
}

/**
 * After calibration, recompute EV at best US odds using coverProb.
 */
function attachEv(c) {
  const ev = evAtOdds(c.coverProb, c.odds);
  const edgePct = (Number.isFinite(c.coverProb) && Number.isFinite(americanToImplied(c.odds)))
    ? c.coverProb - americanToImplied(c.odds)
    : null;
  return {
    ...c,
    ev: ev != null ? +ev.toFixed(4) : null,
    edgePct: edgePct != null ? +edgePct.toFixed(4) : null,
  };
}

module.exports = {
  collectMarketOutcomes,
  bestPrice,
  sharpConsensusAmerican,
  hasMajorLiquidity,
  sharpFairForSide,
  predictedClvCents,
  enrichCandidateWithEdge,
  attachEv,
};
