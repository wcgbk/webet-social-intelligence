'use strict';

const { SHARP_BOOKS, US_BOOKS, US_BOOK_PRIORITY, MAJOR_LIQUIDITY_BOOKS, PLACEABILITY } = require('./config');
const {
  americanToImplied, deVigMarket, evAtOdds, formatAmerican, formatEdgePct,
  noVigTwoWay,
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

const US_BOOK_RANK = new Map(US_BOOK_PRIORITY.map((b, i) => [b, i]));

/** hardrockbet_oh / hardrock are the same retail brand as hardrockbet. */
function canonicalizeBook(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'hardrockbet_oh' || k === 'hardrock') return 'hardrockbet';
  return k;
}

/**
 * Bettor-worse American cents of `book` vs `published`.
 * Positive means the book is a worse price. +110 → -110 is 20 cents
 * (the scale skips the +100/-100 gap).
 */
function americanCentsWorse(published, book) {
  const p = Number(published);
  const b = Number(book);
  if (!Number.isFinite(p) || !Number.isFinite(b)) return null;
  const line = (a) => {
    if (a >= 100) return a - 100;
    if (a <= -100) return a + 100;
    return 0;
  };
  return line(p) - line(b);
}

/**
 * True when `bookAmerican` is the published price, a better price, or inside
 * the juice ballpark (≤N implied pp worse OR ≤N American cents worse).
 */
function withinPlaceableJuice(bookAmerican, publishedAmerican, cfg = PLACEABILITY) {
  const book = Number(bookAmerican);
  const published = Number(publishedAmerican);
  if (!Number.isFinite(book) || !Number.isFinite(published) || book === 0 || published === 0) return false;
  const worseCents = americanCentsWorse(published, book);
  const iBook = americanToImplied(book);
  const iPub = americanToImplied(published);
  if (worseCents == null || iBook == null || iPub == null) return false;
  const worsePp = (iBook - iPub) * 100;
  if (worseCents <= cfg.maxAmericanCentsWorse) return true;
  if (worsePp <= cfg.maxImpliedWorsePp) return true;
  return false;
}

/**
 * US retail books in US_BOOK_PRIORITY that offer this side near the published
 * price. Pinnacle / Circa / other sharp books do not count. One brand once.
 * @returns {{ placeableBooks: string[], bestPlaceable: {book: string, american: number, point?: number}|null, placeable: boolean }}
 */
function assessPlaceability(prices, publishedAmerican, point) {
  const bestByBook = new Map();
  for (const p of prices || []) {
    const book = canonicalizeBook(p.book);
    if (!US_BOOK_RANK.has(book)) continue;
    const american = Number(p.american);
    if (!Number.isFinite(american)) continue;
    if (!withinPlaceableJuice(american, publishedAmerican)) continue;
    const prev = bestByBook.get(book);
    if (prev == null || american > prev) bestByBook.set(book, american);
  }
  const placeableBooks = [...bestByBook.keys()].sort((a, b) => US_BOOK_RANK.get(a) - US_BOOK_RANK.get(b));
  let bestPlaceable = null;
  for (const book of placeableBooks) {
    const american = bestByBook.get(book);
    if (!bestPlaceable || american > bestPlaceable.american) bestPlaceable = { book, american };
  }
  if (bestPlaceable && point != null && Number.isFinite(Number(point))) {
    bestPlaceable.point = Number(point);
  }
  return {
    placeableBooks,
    bestPlaceable,
    placeable: placeableBooks.length >= PLACEABILITY.minMajorBooks,
  };
}

const PLACEABILITY_VETO_REASON = 'placeability-soft-veto: Hard Rock + majors coverage failed';

function countUsRetailBooks(list) {
  const set = new Set();
  for (const b of list || []) {
    const book = canonicalizeBook(b);
    if (US_BOOK_RANK.has(book)) set.add(book);
  }
  return set.size;
}

/**
 * Hard Rock failed when the check recorded an error, or the market is
 * missing with no "not checked" warning. Warnings alone (half-point, slightly
 * worse price) are not a fail. Unsupported bet types warn and do not fail.
 */
function hardRockFailed(hr) {
  if (!hr || hr.unknowable) return false;
  if (Array.isArray(hr.errors) && hr.errors.length > 0) return true;
  if (hr.available === false && (!hr.warnings || hr.warnings.length === 0)) return true;
  return false;
}

/**
 * Verify soft-veto. Drop only when Hard Rock fails AND US-major coverage fails.
 * Odds API / feed down, or a game missing from a live feed, warns and does not drop.
 * Prefer pick.placeableBooks when that array is present; otherwise the caller
 * passes livePlaceableBooks from a fresh odds pull.
 */
function verifyPlaceabilityDecision(args = {}) {
  const pick = args.pick || {};
  if (args.apiDown || args.feedDown) {
    return {
      drop: false,
      reason: null,
      warning: 'odds API unavailable — placeability not reconfirmed',
    };
  }
  if (args.gameMissing || (args.hr && args.hr.unknowable)) {
    return {
      drop: false,
      reason: null,
      warning: 'game not in the current odds feed — placeability not reconfirmed',
    };
  }

  const hrFailed = hardRockFailed(args.hr);
  const stored = Array.isArray(pick.placeableBooks) ? pick.placeableBooks : null;
  let majorsOk = false;
  let majorsKnown = false;
  if (stored) {
    majorsOk = countUsRetailBooks(stored) >= PLACEABILITY.minMajorBooks;
    majorsKnown = true;
  } else if (Array.isArray(args.livePlaceableBooks)) {
    majorsOk = countUsRetailBooks(args.livePlaceableBooks) >= PLACEABILITY.minMajorBooks;
    majorsKnown = true;
  }

  if (!hrFailed) return { drop: false, reason: null, warning: null };
  if (!majorsKnown) {
    return {
      drop: false,
      reason: null,
      warning: 'majors coverage not reconfirmed — placeability not dropped',
    };
  }
  if (majorsOk) {
    return {
      drop: false,
      reason: null,
      warning: 'Hard Rock missed; US majors still cover the published line',
    };
  }
  return { drop: true, reason: PLACEABILITY_VETO_REASON, warning: null };
}

function placeabilitySideKey(row) {
  return `${String((row && (row.pick || row.side)) || '').trim().toLowerCase()}@@${String((row && row.matchup) || '').trim().toLowerCase()}`;
}

function parseUnitsLoose(u) {
  const n = parseFloat(String(u == null ? '' : u).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Drop straights whose verify decision says so. Clear the parlay when any
 * leg fails (do not refill or invent a replacement leg). Other straights stay.
 */
function applyPlaceabilityDrops(picksData, decisions, legDecisions) {
  const data = picksData || {};
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const decs = Array.isArray(decisions) ? decisions : [];
  if (!Array.isArray(data.rejections)) data.rejections = [];
  const kept = [];
  const droppedKeys = new Set();
  let dropped = 0;
  picks.forEach((pick, i) => {
    const d = decs[i];
    if (d && d.drop) {
      data.rejections.push({
        matchup: pick.matchup,
        side: pick.pick,
        reason: d.reason || PLACEABILITY_VETO_REASON,
        placeability: true,
      });
      droppedKeys.add(placeabilitySideKey(pick));
      dropped++;
    } else {
      kept.push(pick);
    }
  });
  data.picks = kept;

  let legFailed = false;
  for (const pl of data.parlayLegs || []) {
    for (const leg of pl.legs || []) {
      if (droppedKeys.has(placeabilitySideKey(leg))) legFailed = true;
    }
  }
  if (Array.isArray(legDecisions)) {
    for (const d of legDecisions) {
      if (!d || !d.drop) continue;
      const key = placeabilitySideKey(d);
      if (droppedKeys.has(key)) continue;
      legFailed = true;
      data.rejections.push({
        matchup: d.matchup,
        side: d.pick,
        reason: d.reason || PLACEABILITY_VETO_REASON,
        placeability: true,
      });
      droppedKeys.add(key);
    }
  }

  let parlayCleared = false;
  if (legFailed && Array.isArray(data.parlayLegs) && data.parlayLegs.length) {
    data.parlayLegs = [];
    parlayCleared = true;
  }
  if (kept.length === 0) {
    data.parlayLegs = [];
    parlayCleared = true;
    if (!data.noPlays) data.noPlays = 'No qualifying edges after placeability soft-veto.';
  }
  if (data.summary) {
    const straightU = kept.reduce((s, p) => s + parseUnitsLoose(p.units), 0);
    const parlayU = (data.parlayLegs || []).reduce((s, pl) => s + parseUnitsLoose(pl.units), 0);
    data.summary.totalPicks = kept.length;
    data.summary.totalStraightBets = kept.length;
    data.summary.totalUnits = `${(straightU + parlayU).toFixed(1)}u`;
    if (Array.isArray(data.summary.sportsCovered)) {
      data.summary.sportsCovered = [...new Set(kept.map(p => p.sport).filter(Boolean))];
    }
  }
  return { dropped, parlayCleared };
}

/**
 * Opposite side of a two-way bundle (ML team, spread other side, total Over/Under).
 */
function oppositeBundle(sideBundles, target) {
  if (!target) return null;
  const targetSide = target.side;
  const targetPoint = target.point;
  if (targetPoint == null) return (sideBundles || []).find(s => s.side !== targetSide) || null;
  return (sideBundles || []).find(s => {
    if (s === target) return false;
    if (/over|under/i.test(targetSide) && /over|under/i.test(s.side)) return s.point === targetPoint;
    return s.point === -targetPoint || s.point === targetPoint;
  }) || null;
}

function americanForBook(prices, book) {
  const want = bookKey(book);
  const row = (prices || []).find(p => bookKey(p.book) === want && Number.isFinite(Number(p.american)));
  return row ? Number(row.american) : null;
}

/** No-vig probability for `target` at one book, when that book posts both sides. */
function noVigForBook(sideBundles, target, book) {
  const opp = oppositeBundle(sideBundles, target);
  if (!opp) return null;
  const a1 = americanForBook(target.prices, book);
  const a2 = americanForBook(opp.prices, book);
  if (a1 == null || a2 == null) return null;
  const nv = noVigTwoWay(a1, a2);
  return nv ? nv.p1 : null;
}

/**
 * Spread/total market anchor: no-vig Pinnacle and Circa at equal weight.
 * One book alone is used when the other has no two-way price.
 * Missing both falls back to the existing sharp no-vig pair (still not prices[0]).
 */
function noVigPinnacleCircaImplied(sideBundles, target) {
  if (!target) return null;
  const pin = noVigForBook(sideBundles, target, 'pinnacle');
  const circa = noVigForBook(sideBundles, target, 'circa');
  const circaAlt = circa != null ? circa : noVigForBook(sideBundles, target, 'circasports');
  const parts = [pin, circaAlt].filter(v => v != null && Number.isFinite(v));
  if (parts.length) return parts.reduce((s, v) => s + v, 0) / parts.length;
  return sharpFairForSide(sideBundles, target.side, target.point);
}

/**
 * Build sharp no-vig fair p for a two-way market given all side bundles.
 */
function sharpFairForSide(sideBundles, targetSide, targetPoint) {
  // Pair opposite sides at same |point|
  const target = sideBundles.find(s => s.side === targetSide && (targetPoint == null || s.point === targetPoint));
  if (!target) return null;

  const opposite = oppositeBundle(sideBundles, target);
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
 * NOTE: this is NOT the Edge badge — do not display as %.
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
  const place = assessPlaceability(sideBundle.prices, odds, sideBundle.point);
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
    placeableBooks: place.placeableBooks,
    bestPlaceable: place.bestPlaceable,
    placeable: place.placeable,
  };
}

/**
 * After calibration, recompute EV at best US odds using coverProb.
 *
 * UI Edge badge (edgePct) = model edge after shrink vs no-vig sharp fair:
 *   coverProb - fair_sharp_p
 * Fallback when sharp fair missing: coverProb - vigged book implied.
 * NOT predictedClv cents, NOT raw coverProb, NOT full Kelly EV% (dogs inflate EV%).
 * `ev` remains true EV at posted odds for sizing/gates.
 */
function attachEv(c) {
  const ev = evAtOdds(c.coverProb, c.odds);
  const implied = americanToImplied(c.odds);
  const fair = (c.fair_sharp_p != null && Number.isFinite(c.fair_sharp_p))
    ? c.fair_sharp_p
    : (c.sharpFairP != null && Number.isFinite(c.sharpFairP) ? c.sharpFairP : null);
  let edgeFrac = null;
  if (Number.isFinite(c.coverProb) && Number.isFinite(fair)) {
    edgeFrac = c.coverProb - fair;
  } else if (Number.isFinite(c.coverProb) && Number.isFinite(implied)) {
    edgeFrac = c.coverProb - implied;
  }
  return {
    ...c,
    ev: ev != null ? +ev.toFixed(4) : null,
    edgePct: edgeFrac != null ? +edgeFrac.toFixed(4) : null,
    edgePctDisplay: formatEdgePct(edgeFrac),
  };
}

module.exports = {
  collectMarketOutcomes,
  bestPrice,
  sharpConsensusAmerican,
  hasMajorLiquidity,
  americanCentsWorse,
  withinPlaceableJuice,
  assessPlaceability,
  verifyPlaceabilityDecision,
  applyPlaceabilityDrops,
  sharpFairForSide,
  noVigPinnacleCircaImplied,
  oppositeBundle,
  predictedClvCents,
  enrichCandidateWithEdge,
  attachEv,
  PLACEABILITY_VETO_REASON,
};
