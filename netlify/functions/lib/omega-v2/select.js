'use strict';

const {
  MAX_EDGE, MAX_STRAIGHTS, EDGE_FLOOR_K, NO_VIG_BUCKETS, forceTop3From,
  PAIR_SANITY_PP, PAIR_SANITY_LO, PAIR_SANITY_HI, pairFixEnabled, longshotAdjEnabled,
  KELLY_FRACTION,
} = require('./constants');
const { dkHrLineAgrees, quotePoint } = require('./board');

/** Same placeable books as a published straight. A missing book is not a reject. */
const PLACEABLE_BOOKS = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

/** Kickoff at or before asOf plus this window is not a pregame candidate. */
const PREGAME_GRACE_MS = 5 * 60 * 1000;

/**
 * Pregame clock. Replay passes opts.pregameAsOfMs. Live calls omit it and
 * use Date.now().
 */
function pregameClockMs(opts) {
  if (opts && Number.isFinite(Number(opts.pregameAsOfMs))) return Number(opts.pregameAsOfMs);
  return Date.now();
}

/**
 * True when commenceTime <= asOf + 5 minutes.
 * A missing or unparseable commenceTime is not dropped here.
 */
function pastPregameCutoff(commenceTime, asOfMs) {
  if (commenceTime == null || commenceTime === '') return false;
  const t = typeof commenceTime === 'number' ? commenceTime : Date.parse(commenceTime);
  if (!Number.isFinite(t)) return false;
  const clock = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  return t <= clock + PREGAME_GRACE_MS;
}
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

/**
 * Half-width of the linear blend across the 0.35 no-vig boundary.
 * Bucket SE and penalty stay the fitted table. Inside [0.33, 0.37) both
 * are interpolated so a 0.001 move cannot jump k*SE by 4pp (the hard step
 * is 1.5 * (0.037668 - 0.008385) = 4.39pp, plus the 3.24pp penalty step).
 * 0.02 is wide enough that a fair of 0.349 and Nashville's 0.3501 share a
 * side, and narrow enough that a price at 0.389 (Thunder) keeps the
 * middle-bucket SE. Interior points keep their bucket.
 */
const BOUNDARY_BLEND = 0.02;
const SMOOTH_BOUNDARY = 0.35;

/** No-vig bucket for the uncertainty floor. Last bucket includes p = 1. */
function bucketForNovig(pNovig) {
  const p = Number(pNovig);
  for (let i = 0; i < NO_VIG_BUCKETS.length; i += 1) {
    const bucket = NO_VIG_BUCKETS[i];
    const last = i === NO_VIG_BUCKETS.length - 1;
    if (p >= bucket.lo && (last || p < bucket.hi)) return bucket;
  }
  return NO_VIG_BUCKETS[NO_VIG_BUCKETS.length - 1];
}

/**
 * SE and long-shot penalty at pNovig. Hard bucket inside each band.
 * Across 0.35, linear in probability between the two adjacent buckets.
 */
function smoothedNovigStats(pNovig) {
  const bucket = bucketForNovig(pNovig);
  const p = Number(pNovig);
  const idx = NO_VIG_BUCKETS.findIndex((row) => row.hi === SMOOTH_BOUNDARY);
  const left = idx >= 0 ? NO_VIG_BUCKETS[idx] : null;
  const right = left ? NO_VIG_BUCKETS[idx + 1] : null;
  if (!left || !right || !Number.isFinite(p)) {
    return { bucket, se: bucket.se, penalty: bucket.penalty };
  }
  const lo = SMOOTH_BOUNDARY - BOUNDARY_BLEND;
  const hi = SMOOTH_BOUNDARY + BOUNDARY_BLEND;
  if (p < lo || p >= hi) return { bucket, se: bucket.se, penalty: bucket.penalty };
  const t = (p - lo) / (hi - lo);
  return {
    bucket,
    se: left.se + t * (right.se - left.se),
    penalty: left.penalty + t * (right.penalty - left.penalty),
  };
}

/**
 * (pCal - longshot penalty) - pNovig must exceed k * SE.
 * SE and the penalty are the bucket values, blended across 0.35.
 */
function uncertaintyFloor(pCal, pNovig) {
  const smooth = smoothedNovigStats(pNovig);
  const edge = Number(pCal) - Number(pNovig);
  const penalty = smooth.penalty;
  const adjusted = edge - penalty;
  const floor = EDGE_FLOOR_K * smooth.se;
  return {
    bucket: smooth.bucket,
    se: smooth.se,
    edge,
    penalty,
    adjusted,
    floor,
    ok: Number.isFinite(adjusted) && adjusted > floor,
  };
}

/**
 * DraftKings or Hard Rock, on the number the edge was computed on.
 * A missing book is left alone. A posted non-DK/HR book, or a DK/HR quote
 * whose point is a different number, is not a price we can stake.
 */
function placeableReject(candidate) {
  const book = String(candidate && candidate.book || '').toLowerCase();
  if (book && !PLACEABLE_BOOKS.has(book)) return 'no-dk-hr-price';
  const px = candidate && candidate.bestDkHr;
  if (!px || typeof px !== 'object') return null;
  const pxBook = String(px.book || '').toLowerCase();
  const pxAmerican = Number(px.american);
  const pxHasPrice = Number.isFinite(pxAmerican) && pxAmerican !== 0;
  if (pxHasPrice && pxBook && !PLACEABLE_BOOKS.has(pxBook)) return 'no-dk-hr-price';
  if (pxHasPrice && !dkHrLineAgrees(candidate.line, quotePoint(px))) return 'dk-hr-line-mismatch';
  return null;
}

/**
 * Own-price vs Pinnacle fair. Same band and gap as board.js mispairedOwnOdds.
 * A longshot outside (PAIR_SANITY_LO, PAIR_SANITY_HI) is not this reject.
 * opts.fullRange drops that window (force-top3): any |pMkt - implied| past
 * PAIR_SANITY_PP is a mismatch. Flag off never passes fullRange.
 */
function priceFairMismatch(implied, pMkt, opts) {
  if (!pairFixEnabled()) return false;
  if (implied == null || !Number.isFinite(Number(implied))) return false;
  if (!(opts && opts.fullRange) && !(implied > PAIR_SANITY_LO && implied < PAIR_SANITY_HI)) return false;
  const fair = Number(pMkt);
  if (!(fair > 0 && fair < 1)) return false;
  return Math.abs(fair - implied) > PAIR_SANITY_PP;
}

/**
 * Bet probability. Penalty is smoothedNovigStats(pMkt).penalty (~3.3pp below
 * 0.35, 0 above, blended 0.33–0.37). OMEGA_V2_LONGSHOT_ADJ=off keeps pCal.
 * Clamped to (0.001, 0.999).
 */
function forcedBetProb(pCal, pMkt, opts) {
  let p = Number(pCal);
  if (longshotAdjEnabled(opts && opts.env)) {
    const penalty = smoothedNovigStats(pMkt).penalty;
    if (Number.isFinite(penalty)) p -= penalty;
  }
  if (!Number.isFinite(p)) return null;
  if (p < 0.001) return 0.001;
  if (p > 0.999) return 0.999;
  return p;
}

/**
 * Straight gates.
 * Flag off: positive no-vig edge, positive EV at the DK/HR price, under the
 * miscalibration cap, and clear of k*SE in its no-vig bucket. Parlay
 * qualification is that no-vig screen. usableLegs also requires a positive
 * price EV. Nothing is added to fill a slot.
 * Flag on (force top 3): placeable DK/HR price, a real calibration, the 10pp
 * screen on edgeNovig, the price-fair mismatch guard over the full
 * probability range, and a 10pp screen on the price edge (pBet - implied).
 * pBet is pCal minus the longshot penalty. edge and ev are at pBet versus
 * the DK/HR price.
 * Rank is quarter-Kelly expected log growth at that pBet, not raw EV.
 * Negative EV and the uncertainty floor do not remove the row.
 */
function annotateCandidate(candidate, opts) {
  const force = forceTop3From(opts);
  const cal = candidate.calibration;
  if (!cal) {
    return {
      ...candidate,
      qualified: false,
      parlayQualified: false,
      rejectReason: 'no-calibration',
      ...(force ? { forced: true, forcePlaceable: false } : {}),
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
      ...(force ? { forced: true, forcePlaceable: false } : {}),
    };
  }
  const edge = cal.pCal - implied;
  // Both edges use the final map. The 10pp screen does not see the raw
  // model-minus-fair gap, and it does see an edge the map just created.
  const edgeNovig = cal.pCal - pMkt;
  const gate = uncertaintyFloor(cal.pCal, pMkt);
  const ev = evAtOdds(cal.pCal, candidate.odds);
  // Rank on the no-vig shrink, not on a later Platt lift, when the flag is
  // off. pShrink is the shipped shrink (calibrate.js). Missing pShrink
  // falls back to pCal. Flag-on rank is quarter-Kelly growth at pBet.
  const pShrink = Number.isFinite(Number(cal.pShrink)) ? Number(cal.pShrink) : Number(cal.pCal);
  const evShrink = evAtOdds(pShrink, candidate.odds);
  const bookReject = placeableReject(candidate);
  let rejectReason = null;
  if (bookReject) rejectReason = bookReject;
  else if (force) {
    if (!Number.isFinite(Number(cal.pCal)) || !Number.isFinite(edgeNovig)) rejectReason = 'no-calibration';
    else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
    else if (priceFairMismatch(implied, pMkt, { fullRange: true })) rejectReason = 'price-fair-mismatch';
  } else if (!(edgeNovig > 0)) rejectReason = 'novig-edge-not-positive';
  else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
  else if (!gate.ok) rejectReason = 'edge-below-uncertainty-floor';
  const straightReject = force
    ? rejectReason
    : (rejectReason || (!(edge > 0) || !(ev > 0) ? 'price-edge-not-positive' : null));
  const row = {
    ...candidate,
    implied,
    decimal: dec,
    edge,
    edgeNovig,
    edgeFloor: gate.floor,
    longshotPenalty: gate.penalty,
    ev,
    evShrink,
    qualified: straightReject == null,
    parlayQualified: force ? straightReject == null : rejectReason == null,
    rejectReason: straightReject,
  };
  if (!force) return row;
  const pBet = forcedBetProb(cal.pCal, pMkt, opts);
  let reason = straightReject;
  if (reason == null && pBet == null) reason = 'no-calibration';
  const priceEdge = pBet == null ? edge : pBet - implied;
  // Full-range pair check is above. This is the price edge, not edgeNovig.
  if (reason == null && pBet != null && (pBet - implied) > MAX_EDGE) reason = 'price-edge-over-10pp';
  const priceEv = pBet == null ? ev : (pBet * (dec - 1) - (1 - pBet));
  const forcePlaceable = reason == null;
  return {
    ...row,
    pBet,
    edge: priceEdge,
    ev: priceEv,
    forced: true,
    forcePlaceable,
    qualified: forcePlaceable,
    parlayQualified: forcePlaceable,
    rejectReason: reason,
  };
}

/** Price EV after the no-vig shrink. Callers that only stored `ev` keep that order. */
function rankEv(row) {
  const shrunk = Number(row && row.evShrink);
  if (Number.isFinite(shrunk)) return shrunk;
  const ev = Number(row && row.ev);
  return Number.isFinite(ev) ? ev : -Infinity;
}

function finiteRank(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : -Infinity;
}

/**
 * Expected log growth of a quarter-Kelly stake.
 * b = decimal - 1, full = (b*p - (1-p)) / b, f = KELLY_FRACTION * full.
 * Null when full Kelly is not positive or the inputs are not a real price.
 */
function kellyGrowth(p, decimal) {
  const prob = Number(p);
  const d = Number(decimal);
  if (!Number.isFinite(prob) || !Number.isFinite(d)) return null;
  const b = d - 1;
  if (!(b > 0)) return null;
  const full = (b * prob - (1 - prob)) / b;
  if (!(full > 0)) return null;
  const f = KELLY_FRACTION * full;
  const growth = prob * Math.log(1 + f * b) + (1 - prob) * Math.log(1 - f);
  return Number.isFinite(growth) ? growth : null;
}

/**
 * Positive growth first (desc), then null growth by price EV (desc).
 * Ties break on edge, then pick name.
 */
function compareForcedGrowth(a, b) {
  const ag = a.kellyGrowth;
  const bg = b.kellyGrowth;
  const aHas = ag != null;
  const bHas = bg != null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bg !== ag) return bg > ag ? 1 : -1;
  if (!aHas) {
    const ev = finiteRank(b.ev) - finiteRank(a.ev);
    if (ev) return ev;
  }
  return (finiteRank(b.edge) - finiteRank(a.edge))
    || String(a.pick).localeCompare(String(b.pick));
}

/**
 * Top 3 placeable straights by quarter-Kelly expected log growth, one per game.
 * Growth uses pBet and the decimal price. full Kelly <= 0 stores null and
 * ranks after every positive-growth row, by price EV. Pregame cutoff still applies.
 */
function selectForcedTop3(annotated, opts) {
  const asOfMs = pregameClockMs(opts);
  const ranked = (annotated || [])
    .filter((c) => c && c.qualified && !pastPregameCutoff(c.commenceTime, asOfMs))
    .map((c) => ({ ...c, kellyGrowth: kellyGrowth(c.pBet, c.decimal) }))
    .sort(compareForcedGrowth);
  const out = [];
  const used = new Set();
  for (const c of ranked) {
    if (out.length >= MAX_STRAIGHTS) break;
    const key = c.gameKey != null && c.gameKey !== '' ? c.gameKey : gameKey(c.matchup);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ ...c, forced: true });
  }
  return out;
}

function selectStraights(annotated, opts) {
  if (forceTop3From(opts)) return selectForcedTop3(annotated, opts);
  const asOfMs = pregameClockMs(opts);
  const ranked = (annotated || [])
    .filter((c) => c.qualified && !pastPregameCutoff(c.commenceTime, asOfMs))
    .sort((a, b) => (rankEv(b) - rankEv(a)) || (b.edge - a.edge) || String(a.pick).localeCompare(String(b.pick)));
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
  bucketForNovig,
  smoothedNovigStats,
  uncertaintyFloor,
  BOUNDARY_BLEND,
  rankEv,
  kellyGrowth,
  annotateCandidate,
  selectStraights,
  selectForcedTop3,
  PREGAME_GRACE_MS,
  pregameClockMs,
  pastPregameCutoff,
};
