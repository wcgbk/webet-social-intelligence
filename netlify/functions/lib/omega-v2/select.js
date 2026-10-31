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
 * (pCal - longshot penalty) - pNovig must exceed k * SE(bucket).
 * The penalty is already 0 outside the long-shot buckets.
 */
function uncertaintyFloor(pCal, pNovig) {
  const bucket = bucketForNovig(pNovig);
  const edge = Number(pCal) - Number(pNovig);
  const penalty = bucket.penalty;
  const adjusted = edge - penalty;
  const floor = EDGE_FLOOR_K * bucket.se;
  return {
    bucket,
    edge,
    penalty,
    adjusted,
    floor,
    ok: Number.isFinite(adjusted) && adjusted > floor,
  };
}

/**
 * Straight: positive no-vig edge, positive EV at the bet price, under the
 * miscalibration cap, and clear of k*SE in its no-vig bucket.
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
  const gate = uncertaintyFloor(cal.pCal, pMkt);
  const ev = evAtOdds(cal.pCal, candidate.odds);
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
    qualified: straightReject == null,
    parlayQualified: rejectReason == null,
    rejectReason: straightReject,
  };
}

function selectStraights(annotated, opts) {
  const asOfMs = pregameClockMs(opts);
  const ranked = (annotated || [])
    .filter((c) => c.qualified && !pastPregameCutoff(c.commenceTime, asOfMs))
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
  bucketForNovig,
  uncertaintyFloor,
  annotateCandidate,
  selectStraights,
  PREGAME_GRACE_MS,
  pregameClockMs,
  pastPregameCutoff,
};
