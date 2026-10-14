'use strict';

/**
 * Sharp fair for the daily card (sharp-math-1014).
 *
 * Default off. Set OMEGA_SHARP_FAIR=1 to price from a same-time Pinnacle
 * two-way instead of the sport-model blend and the hand-set shrink.
 * Off leaves coverProb, EV, and the gates on the v12.3.74 path.
 *
 * Fair is the power de-vig of Pinnacle's two-way on this side. The bet
 * decimal is DraftKings or Hard Rock. A model probability does not enter.
 */

const { americanToImplied, americanToDecimal } = require('./odds_math');

const SHARP_FAIR_VERSION = 'sharp-math-1014';
const FRESH_MINUTES = 20;
/** Close-conditioned NFL push rates. nflverse 1999–2025, spread exactly on the number. */
const NFL_SPREAD_PUSH = { 3: 0.090, 7: 0.065 };
const OVERROUND_MAX = 0.06;
const OVERROUND_MIN = -0.01;

/**
 * Default off. Unset, blank, 0, off, false, or no stays off.
 * Any other value prices the sharp fair.
 */
function sharpFairEnabled(env) {
  const src = env || process.env;
  const v = src.OMEGA_SHARP_FAIR;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === '0' || s === 'off' || s === 'false' || s === 'no') return false;
  return true;
}

function powerTwoWay(i1, i2) {
  if (!(i1 > 0 && i1 < 1 && i2 > 0 && i2 < 1)) return null;
  const raw = i1 + i2;
  if (!(raw > 0)) return null;
  if (Math.abs(raw - 1) < 1e-12) {
    return { p1: i1, p2: i2, k: 1, vig: 0 };
  }
  let lo;
  let hi;
  if (raw > 1) {
    lo = 1;
    hi = 1;
    let sumHi = raw;
    while (sumHi > 1 && hi < 64) {
      hi *= 2;
      sumHi = Math.pow(i1, hi) + Math.pow(i2, hi);
    }
    if (!(sumHi <= 1)) return null;
  } else {
    hi = 1;
    lo = 1;
    let sumLo = raw;
    while (sumLo < 1 && lo > 1e-6) {
      lo /= 2;
      sumLo = Math.pow(i1, lo) + Math.pow(i2, lo);
    }
    if (!(sumLo >= 1)) return null;
  }
  for (let n = 0; n < 80; n += 1) {
    const mid = (lo + hi) / 2;
    const sum = Math.pow(i1, mid) + Math.pow(i2, mid);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const p1 = Math.pow(i1, k);
  const p2 = Math.pow(i2, k);
  if (!(p1 > 0 && p2 > 0 && Math.abs(p1 + p2 - 1) < 1e-8)) return null;
  return { p1, p2, k, vig: raw - 1 };
}

function isSpread(market) {
  return /spread|run line|puck line/i.test(String(market || ''));
}

function isTotal(market) {
  return /total/i.test(String(market || ''));
}

function isMoneyline(market) {
  return !isSpread(market) && !isTotal(market);
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isIntegerPoint(point) {
  const n = numOrNull(point);
  if (n == null) return false;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

function pointsEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-6;
}

function nflSport(sport) {
  return String(sport || '').toUpperCase() === 'NFL';
}

function pushAt(sport, market, point) {
  if (!nflSport(sport) || !isSpread(market) || !isIntegerPoint(point)) return 0;
  const key = Math.abs(Math.round(Number(point)));
  return NFL_SPREAD_PUSH[key] || 0;
}

/**
 * Move a power fair across one NFL half point on 3 or 7.
 * Returns the conditional win probability and the push rate of the bet,
 * or null when the move is not that hook.
 */
function hookFair(pCond, pinPoint, betPoint) {
  const gap = Math.abs(betPoint - pinPoint);
  if (Math.abs(gap - 0.5) > 1e-6) return null;
  const pinInt = isIntegerPoint(pinPoint);
  const betInt = isIntegerPoint(betPoint);
  if (pinInt === betInt) return null;
  const crossed = pinInt ? Math.round(pinPoint) : Math.round(betPoint);
  const q = NFL_SPREAD_PUSH[Math.abs(crossed)] || 0;
  if (!(q > 0)) return null;
  if (pinInt && !betInt) {
    if (betPoint > pinPoint) return { p: pCond * (1 - q) + q, q: 0, hook: 'buy' };
    return { p: pCond * (1 - q), q: 0, hook: 'lay' };
  }
  if (pinPoint > betPoint) {
    const p = (pCond - q) / (1 - q);
    if (!(p > 0 && p < 1)) return null;
    return { p, q, hook: 'bet-integer-from-easy' };
  }
  const p = pCond / (1 - q);
  if (!(p > 0 && p < 1)) return null;
  return { p, q, hook: 'bet-integer-from-hard' };
}

function stakeEv(pCond, american, q) {
  const dec = americanToDecimal(american);
  if (dec == null || !Number.isFinite(pCond)) return null;
  const push = Number.isFinite(q) && q > 0 ? q : 0;
  return (1 - push) * (pCond * dec - 1);
}

function parseMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Minutes the soft quote sits after the Pinnacle quote.
 * Null when either clock is missing.
 */
function lagMinutes(pinAt, softAt) {
  const pin = parseMs(pinAt);
  const soft = parseMs(softAt);
  if (pin == null || soft == null) return null;
  return (soft - pin) / 60000;
}

function reject(reason, extra) {
  return {
    ok: false,
    reason,
    version: SHARP_FAIR_VERSION,
    p: null,
    q: 0,
    ev: null,
    k: null,
    vig: null,
    ...extra,
  };
}

/**
 * Pure quote check. pinAmerican is this side. betAmerican is the DK/HR price.
 * pinLagMin is used when the two clocks are absent. sameSnapshot treats a
 * missing clock as the 10:00 board (lag 0). A known lag must sit in [−1, N].
 */
function evaluateQuote(input) {
  const q = input || {};
  const fresh = Number.isFinite(Number(q.freshMinutes)) ? Number(q.freshMinutes) : FRESH_MINUTES;
  const pinAmerican = numOrNull(q.pinAmerican);
  const pinOpp = numOrNull(q.pinOppAmerican);
  const betAmerican = numOrNull(q.betAmerican);
  if (pinAmerican == null || pinOpp == null || betAmerican == null) {
    return reject('no-two-way');
  }
  const i1 = americanToImplied(pinAmerican);
  const i2 = americanToImplied(pinOpp);
  if (i1 == null || i2 == null) return reject('no-two-way');
  const vig = i1 + i2 - 1;
  if (vig > OVERROUND_MAX || vig < OVERROUND_MIN) return reject('wide-sharp', { vig });
  const powered = powerTwoWay(i1, i2);
  if (!powered) return reject('no-two-way', { vig });

  let lag = lagMinutes(q.pinAt, q.softAt);
  let freshHow = lag != null ? 'timestamps' : null;
  if (lag == null && q.pinLagMin != null && Number.isFinite(Number(q.pinLagMin))) {
    lag = Number(q.pinLagMin);
    freshHow = 'pinLagMin';
  }
  if (lag == null && q.sameSnapshot === true) {
    lag = 0;
    freshHow = 'same-snapshot';
  }
  if (lag == null || lag < -1 || lag > fresh) {
    return reject('stale-sharp', { vig, lagMin: lag, freshHow });
  }

  const market = q.market;
  const pinPoint = numOrNull(q.pinPoint);
  const betPoint = numOrNull(q.betPoint);
  let p = powered.p1;
  let push = 0;
  let pointRule = 'exact';
  if (isMoneyline(market)) {
    if (pinPoint != null || betPoint != null) {
      return reject('point-mismatch', { vig, lagMin: lag });
    }
  } else if (pointsEqual(pinPoint, betPoint)) {
    push = pushAt(q.sport, market, betPoint);
    pointRule = push > 0 ? 'exact-push' : 'exact';
  } else if (nflSport(q.sport) && isSpread(market)) {
    const hooked = hookFair(powered.p1, pinPoint, betPoint);
    if (!hooked) return reject('point-mismatch', { vig, lagMin: lag });
    p = hooked.p;
    push = hooked.q;
    pointRule = hooked.hook;
  } else {
    return reject('point-mismatch', { vig, lagMin: lag });
  }

  const ev = stakeEv(p, betAmerican, push);
  if (ev == null || !Number.isFinite(p)) return reject('no-two-way', { vig, lagMin: lag });
  return {
    ok: true,
    reason: null,
    version: SHARP_FAIR_VERSION,
    p,
    q: push,
    ev,
    k: powered.k,
    vig,
    lagMin: lag,
    freshHow,
    pointRule,
    method: 'power',
    pPower: powered.p1,
  };
}

function betPointOf(c) {
  if (!c) return null;
  if (isMoneyline(c.market)) return null;
  if (c.line != null && c.line !== '') return numOrNull(c.line);
  return null;
}

function retailBook(name) {
  const k = String(name || '').toLowerCase();
  if (k === 'hardrockbet_oh' || k === 'hardrock') return 'hardrockbet';
  if (k === 'draftkings' || k === 'hardrockbet') return k;
  return null;
}

/**
 * DraftKings and Hard Rock offers on this candidate.
 * A quote at a different point is a different candidate, except the caller
 * passes the bet point into evaluateQuote, which converts only the NFL 3/7 hook.
 */
function retailOffers(c) {
  const offers = [];
  const seen = new Set();
  const add = (book, american, point, at) => {
    const name = retailBook(book);
    const price = numOrNull(american);
    if (!name || price == null) return;
    const pt = isMoneyline(c.market) ? null : numOrNull(point);
    const key = `${name}|${price}|${pt == null ? 'ml' : pt}`;
    if (seen.has(key)) return;
    seen.add(key);
    offers.push({ book: name, american: price, point: pt, at: at || null });
  };
  if (c.dkQuote) add('draftkings', c.dkQuote.american, c.dkQuote.point != null ? c.dkQuote.point : c.line, c.dkQuote.lastUpdate);
  if (c.hardRock) {
    add('hardrockbet', c.hardRock.american != null ? c.hardRock.american : c.hardRock.price, c.hardRock.point, c.hardRock.lastUpdate);
  }
  if (Array.isArray(c.bookPrices)) {
    for (const p of c.bookPrices) {
      if (!p) continue;
      add(p.book || p.key, p.american != null ? p.american : p.price, p.point != null ? p.point : c.line, p.lastUpdate);
    }
  }
  if (!offers.length && numOrNull(c.odds) != null) {
    add(c.book || c.executionBook || 'draftkings', c.odds, c.line, c.softQuotedAt);
  }
  return offers;
}

/**
 * Replace coverProb and stake EV on one candidate.
 * A failed pair sets sharpFairReject and leaves the row off the floor and the lean fill.
 */
function priceCandidate(c, opts) {
  if (!c) return c;
  const options = opts || {};
  const exact = c.pinnacleSide || null;
  const hook = !exact && c.pinnacleHook ? c.pinnacleHook : null;
  const pair = exact || hook || null;
  const pinAmerican = pair && pair.american != null ? pair.american : c.pinnacleAmerican;
  const pinOpp = pair && pair.oppAmerican != null ? pair.oppAmerican : c.pinnacleOppAmerican;
  const pinPoint = pair && Object.prototype.hasOwnProperty.call(pair, 'point')
    ? pair.point
    : (c.pinnacleSidePoint != null ? c.pinnacleSidePoint : c.pinnaclePoint);
  const pinAt = (pair && pair.lastUpdate) || c.pinQuotedAt || c.pinnacleQuotedAt;
  const offers = retailOffers(c);
  let fair = null;
  let chosen = null;
  let firstReject = null;
  for (const offer of offers) {
    const got = evaluateQuote({
      sport: c.sport,
      market: c.market,
      pinAmerican,
      pinOppAmerican: pinOpp,
      pinPoint: isMoneyline(c.market) ? null : pinPoint,
      betPoint: isMoneyline(c.market) ? null : (offer.point != null ? offer.point : betPointOf(c)),
      betAmerican: offer.american,
      pinAt,
      softAt: offer.at || c.softQuotedAt || c.entryTs,
      pinLagMin: c.pinLagMin,
      sameSnapshot: options.sameSnapshot === true,
      freshMinutes: options.freshMinutes,
    });
    if (!got.ok) {
      if (!firstReject) firstReject = got;
      continue;
    }
    if (!fair || got.ev > fair.ev + 1e-12) {
      fair = got;
      chosen = offer;
    }
  }
  if (!fair) {
    const miss = firstReject || reject('no-two-way');
    return {
      ...c,
      sharpFairReject: miss.reason,
      sharpFairPriced: false,
      priceVersion: SHARP_FAIR_VERSION,
      sharpVig: miss.vig != null ? miss.vig : null,
      sharpLagMin: miss.lagMin != null ? miss.lagMin : null,
      fair_sharp_p: null,
      coverProb: null,
      ev: null,
      movementDrop: false,
    };
  }
  const implied = americanToImplied(chosen.american);
  const edge = implied != null ? fair.p - implied : null;
  const line = isMoneyline(c.market) ? null : (chosen.point != null ? chosen.point : betPointOf(c));
  return {
    ...c,
    odds: chosen.american,
    line,
    book: chosen.book,
    priceBook: chosen.book,
    executionBook: chosen.book,
    sharpFairReject: null,
    sharpFairPriced: true,
    priceVersion: SHARP_FAIR_VERSION,
    coverProb: fair.p,
    pPush: fair.q,
    ev: fair.ev,
    fair_sharp_p: fair.pPower,
    sharpFairP: fair.pPower,
    pinnacleNoVigP: fair.pPower,
    sharpAnchorBook: 'pinnacle',
    sharpMethod: fair.method,
    sharpK: fair.k,
    sharpVig: fair.vig,
    sharpLagMin: fair.lagMin,
    sharpPointRule: fair.pointRule,
    edgePct: edge != null ? edge : null,
    movementDrop: false,
    modelPricedEv: c.ev,
  };
}

function applySharpFair(candidates, opts) {
  return (candidates || []).map((c) => priceCandidate(c, opts));
}

module.exports = {
  SHARP_FAIR_VERSION,
  FRESH_MINUTES,
  NFL_SPREAD_PUSH,
  OVERROUND_MAX,
  OVERROUND_MIN,
  sharpFairEnabled,
  powerTwoWay,
  evaluateQuote,
  priceCandidate,
  applySharpFair,
  retailOffers,
  stakeEv,
  lagMinutes,
};
