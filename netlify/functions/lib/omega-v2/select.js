'use strict';

const {
  MAX_EDGE, MAX_STRAIGHTS, EDGE_FLOOR_K, NO_VIG_BUCKETS,
} = require('./constants');

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
 * Straight: positive no-vig edge, positive EV at the DK/HR price, under the
 * miscalibration cap, and clear of k*SE in its no-vig bucket.
 * Parlay qualification here is that same no-vig screen. usableLegs also
 * requires pCal * decimal(DK/HR price) > 1. A leg that fails is skipped as
 * leg-ev-not-positive and is not on the ticket.
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
  // Both edges use the final map. The 10pp screen does not see the raw
  // model-minus-fair gap, and it does see an edge the map just created.
  const edgeNovig = cal.pCal - pMkt;
  const gate = uncertaintyFloor(cal.pCal, pMkt);
  const ev = evAtOdds(cal.pCal, candidate.odds);
  // Rank on the no-vig shrink, not on a later Platt lift. pShrink is the
  // shipped shrink (calibrate.js). Missing pShrink falls back to pCal.
  const pShrink = Number.isFinite(Number(cal.pShrink)) ? Number(cal.pShrink) : Number(cal.pCal);
  const evShrink = evAtOdds(pShrink, candidate.odds);
  let rejectReason = null;
  if (!(edgeNovig > 0)) rejectReason = 'novig-edge-not-positive';
  else if (edgeNovig > MAX_EDGE) rejectReason = 'edge-over-10pp';
  else if (!gate.ok) rejectReason = 'edge-below-uncertainty-floor';
  const straightReject = rejectReason
    || (!(edge > 0) || !(ev > 0) ? 'price-edge-not-positive' : null);
  return {
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
    parlayQualified: rejectReason == null,
    rejectReason: straightReject,
  };
}

/** Price EV after the no-vig shrink. Callers that only stored `ev` keep that order. */
function rankEv(row) {
  const shrunk = Number(row && row.evShrink);
  if (Number.isFinite(shrunk)) return shrunk;
  const ev = Number(row && row.ev);
  return Number.isFinite(ev) ? ev : -Infinity;
}

function selectStraights(annotated, opts) {
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
  annotateCandidate,
  selectStraights,
  PREGAME_GRACE_MS,
  pregameClockMs,
  pastPregameCutoff,
};
