'use strict';

/**
 * Push-aware half-point conversion.
 *
 * Landing rates are the Holzhauer push chart as published by Unabated:
 * the chance the margin (or total) lands on that integer. Moving a
 * half point across integer k shifts cover probability by P(k) / 2.
 * A half point onto the integer takes the push; a half point off it
 * takes the win. NFL +3 versus +3.5 is 4.5pp (0.090 / 2).
 *
 * NHL and MLB are not converted. Distance above 1.5 points is not converted.
 */

const MAX_DIST = 1.5;

const NFL_SPREAD = {
  3: 0.090,
  7: 0.065,
  10: 0.035,
  4: 0.035,
  6: 0.035,
  14: 0.030,
  1: 0.025,
  2: 0.020,
};
const NCAAF_SPREAD = {
  3: 0.060,
  7: 0.045,
  10: 0.025,
  4: 0.025,
  6: 0.025,
  14: 0.025,
};
const NFL_TOTAL_HI = { 41: 0.025, 43: 0.025, 44: 0.025, 47: 0.025, 51: 0.025 };
const NFL_TOTAL_MID = { 37: 0.022, 40: 0.022, 45: 0.022, 48: 0.022, 54: 0.022 };

function sportOf(sport) {
  const s = String(sport || '').toUpperCase();
  if (s === 'NCAAB') return 'NCAAM';
  if (s === 'AMERICANFOOTBALL_NFL') return 'NFL';
  if (s === 'AMERICANFOOTBALL_NCAAF') return 'NCAAF';
  if (s === 'BASKETBALL_NBA') return 'NBA';
  if (s === 'BASKETBALL_NCAAB') return 'NCAAM';
  if (s === 'ICEHOCKEY_NHL') return 'NHL';
  if (s === 'BASEBALL_MLB') return 'MLB';
  return s;
}

function marketOf(market) {
  const token = String(market || '').toLowerCase();
  if (token === 'total' || token === 'totals' || /total/.test(token)) return 'Total';
  if (token === 'spread' || token === 'spreads' || /spread|puck|run line/.test(token)) return 'Spread';
  return 'Moneyline';
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isIntegerPoint(point) {
  const n = num(point);
  if (n == null) return false;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/** True when this sport and market may move a price across a number. */
function conversionAllowed(sport, market) {
  const s = sportOf(sport);
  const m = marketOf(market);
  if (m === 'Moneyline') return false;
  if (s === 'NHL' || s === 'MLB') return false;
  return s === 'NFL' || s === 'NCAAF' || s === 'NBA' || s === 'NCAAM';
}

/**
 * P(land exactly on this integer). Spreads use the absolute margin.
 * A non-integer returns 0.
 */
function pushProb(sport, market, point) {
  const n = num(point);
  if (n == null || !isIntegerPoint(n)) return 0;
  const s = sportOf(sport);
  const m = marketOf(market);
  const k = Math.round(n);
  if (m === 'Spread') {
    const a = Math.abs(k);
    if (s === 'NFL') return NFL_SPREAD[a] != null ? NFL_SPREAD[a] : 0.015;
    if (s === 'NCAAF') return NCAAF_SPREAD[a] != null ? NCAAF_SPREAD[a] : 0.012;
    if (s === 'NBA' || s === 'NCAAM') return 0.030;
    return 0;
  }
  if (m === 'Total') {
    if (s === 'NFL') {
      if (NFL_TOTAL_HI[k] != null) return NFL_TOTAL_HI[k];
      if (NFL_TOTAL_MID[k] != null) return NFL_TOTAL_MID[k];
      return 0.015;
    }
    if (s === 'NCAAF') return 0.012;
    if (s === 'NBA' || s === 'NCAAM') return 0.020;
    return 0;
  }
  return 0;
}

function roundHalf(n) {
  return Math.round(n * 2) / 2;
}

/**
 * Shift a cover probability from one number to another.
 * `side` is 'over' or 'under' for totals. Spreads treat a higher number
 * as easier for the quoted side. Returns null when the move is not allowed.
 * `p` at an integer is the conditional win probability. `q` is the push
 * rate of the destination number (0 on a half point).
 */
function convertCoverProb(input) {
  const q = input || {};
  const sport = q.sport;
  const market = marketOf(q.market);
  const from = num(q.fromPoint);
  const to = num(q.toPoint);
  const p0 = num(q.p);
  if (from == null || to == null || p0 == null) return null;
  if (!(p0 > 0 && p0 < 1)) return null;
  const dist = Math.abs(to - from);
  // maxDist is optional. Callers that omit it keep the 1.5 pricing cap.
  const requested = num(q.maxDist);
  const limit = requested == null ? MAX_DIST : requested;
  if (dist > limit + 1e-9) return null;
  if (!conversionAllowed(sport, market)) {
    if (dist < 1e-9) return { p: p0, q: 0, distance: 0 };
    return null;
  }
  const side = String(q.side || '').toLowerCase();
  const easier = market === 'Total' && side === 'over' ? -1 : 1;
  const steps = Math.round(dist * 2);
  let p = p0;
  if (steps > 0) {
    const dir = to > from ? 1 : -1;
    let cur = roundHalf(from);
    for (let i = 0; i < steps; i += 1) {
      const next = roundHalf(cur + dir * 0.5);
      const key = isIntegerPoint(cur) ? cur : (isIntegerPoint(next) ? next : null);
      if (key != null) {
        const mass = pushProb(sport, market, key);
        p += dir * easier * (mass / 2);
      }
      cur = next;
    }
  }
  if (!(p > 0.001 && p < 0.999)) return null;
  const destQ = isIntegerPoint(to) ? pushProb(sport, market, to) : 0;
  return { p, q: destQ, distance: dist };
}

/**
 * EV with a push returning the stake.
 * pCond is P(win | no push). q is P(push).
 * EV = pWin * (d - 1) - pLoss.
 */
function pushAwareEv(pCond, decimal, q) {
  const p = Number(pCond);
  const d = Number(decimal);
  const push = Number(q);
  if (!(p > 0 && p < 1) || !(d > 1)) return null;
  const mass = push > 0 && push < 1 ? push : 0;
  return (1 - mass) * (p * d - 1);
}

module.exports = {
  MAX_DIST,
  NFL_SPREAD,
  NCAAF_SPREAD,
  sportOf,
  marketOf,
  conversionAllowed,
  pushProb,
  convertCoverProb,
  pushAwareEv,
  isIntegerPoint,
};
