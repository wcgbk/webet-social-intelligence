'use strict';

const {
  PARLAY_STAKE_CAP, CARD_BUDGET,
} = require('./constants');
const { marketFamily, gameKey, normTeam, pastPregameCutoff, pregameClockMs } = require('./select');
const { dkHrLineAgrees, quotePoint } = require('./board');
const { roundQuarter, stakeUsd, sumUnits, quarterKellyFromDecimal } = require('./size');

/**
 * Same placeable list as straights (pipeline placeableDkHr).
 * hardrock aliases publish as hardrockbet. Any other posted book is not a leg.
 */
const PLACEABLE_BOOKS = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

function canonicalPlaceBook(book) {
  const key = String(book || '').toLowerCase();
  if (key === 'hardrock' || key === 'hardrockbet' || key === 'hardrockbet_oh') return 'hardrockbet';
  if (key === 'draftkings') return 'draftkings';
  return key;
}

function finiteAmerican(value) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * Price a parlay leg at DraftKings or Hard Rock.
 * bestDkHr wins, same as a straight, even when the posted book is a longer
 * number somewhere else (tipico_de, onexbet). No bestDkHr and a non-placeable
 * posted book returns null: the leg is dropped and the next +EV DK/HR leg
 * is used. A missing book is left as-is so an already-priced candidate
 * (the straight path already rejected no-dk-hr-price) still scores.
 */
function quotedLeg(leg) {
  if (!leg) return null;
  const px = leg.bestDkHr;
  const pxAmerican = px && typeof px === 'object' ? finiteAmerican(px.american) : null;
  const pxBook = px && typeof px === 'object' ? String(px.book || '').toLowerCase() : '';
  // A DK/HR number on a different point is a different bet. Do not borrow it.
  if (pxAmerican != null && px && !dkHrLineAgrees(leg.line, quotePoint(px))) return null;
  if (pxAmerican != null && pxBook && !PLACEABLE_BOOKS.has(pxBook)) return null;
  if (pxAmerican != null && PLACEABLE_BOOKS.has(pxBook)) {
    return {
      ...leg,
      odds: pxAmerican,
      book: canonicalPlaceBook(pxBook),
      decimal: americanToDecimal(pxAmerican),
    };
  }
  const posted = String(leg.book || '').toLowerCase();
  if (!posted) return { ...leg };
  if (!PLACEABLE_BOOKS.has(posted)) return null;
  const odds = finiteAmerican(leg.odds);
  return {
    ...leg,
    book: canonicalPlaceBook(posted),
    ...(odds != null ? { odds, decimal: americanToDecimal(odds) } : {}),
  };
}
const {
  americanToDecimal, decimalToAmerican, formatAmerican,
} = require('../omega-vnext/odds_math');
const { conflictsWithStraight } = require('../omega-vnext/parlay');

function conflictsWithAnyStraight(leg, straights) {
  return (straights || []).some((straight) => conflictsWithStraight(leg, straight));
}

function legMarket(leg) {
  return leg.marketFamily || marketFamily(leg.market || leg.betType, leg.pick || leg.side);
}

function legGame(leg) {
  return leg.gameKey || gameKey(leg.matchup || '');
}

function teamToken(pick) {
  return String(pick || '')
    .toLowerCase()
    .replace(/\b(ml|moneyline)\b/g, ' ')
    .replace(/[+-]?\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(over|under)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function legPick(leg) {
  if (leg && typeof leg === 'object') return leg.pick || leg.side || '';
  return leg || '';
}

function sameSide(a, b) {
  const left = teamToken(legPick(a));
  const right = teamToken(legPick(b));
  if (!left || !right) return false;
  return left === right;
}

/**
 * Clubs on a leg. Names come from home, away, or the two sides of the
 * matchup, compared exactly. A pick token is used only when the game
 * names are missing, and a total still contributes no pick side.
 */
function legClubs(leg) {
  const out = new Set();
  const add = (name) => {
    const team = normTeam(name);
    if (team) out.add(team);
  };
  add(leg && leg.homeTeam);
  add(leg && leg.awayTeam);
  const parts = String((leg && leg.matchup) || '').split(/\s*@\s*/);
  if (parts.length === 2) {
    add(parts[0]);
    add(parts[1]);
  }
  if (out.size === 0 && legMarket(leg) !== 'Total') {
    const pickTeam = teamToken(legPick(leg));
    if (pickTeam) out.add(pickTeam);
  }
  return out;
}

function sharesTeam(a, b) {
  const right = legClubs(b);
  for (const club of legClubs(a)) {
    if (right.has(club)) return true;
  }
  return false;
}

/**
 * Every same-game pair is one ticket, including moneyline plus total and
 * spread plus total. The same club in two games is the same ban.
 * A surviving ticket is cross-game, and its joint is the product.
 */
function pairRule(a, b) {
  const leftGame = legGame(a);
  const rightGame = legGame(b);
  const sameGame = !!(leftGame && leftGame === rightGame);
  if (sameGame) {
    return { ok: false, sameGame: true, sameTeam: true, phi: 0, kind: 'same-game', reason: 'same-game' };
  }
  if (sharesTeam(a, b)) {
    return { ok: false, sameGame: false, sameTeam: true, phi: 0, kind: 'same-team', reason: 'same-team' };
  }
  return { ok: true, sameGame: false, sameTeam: false, phi: 0, kind: 'cross-game', n: null };
}

function bannedPairReason(legs) {
  const list = legs || [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const rule = pairRule(list[i], list[j]);
      if (!rule.ok) return rule.reason;
    }
  }
  return null;
}

function sigma(p) {
  if (!(p > 0) || !(p < 1)) return 0;
  return Math.sqrt(p * (1 - p));
}

/**
 * Joint probability of a legal ticket. Every pair is cross-game, so the
 * joint is the product of the leg probabilities. A banned pair returns null.
 */
function scoreLegs(legs) {
  const list = legs || [];
  if (list.length < 2) return null;
  let prob = 1;
  let dec = 1;
  const ps = [];
  for (const leg of list) {
    const p = Number(leg.calibration && leg.calibration.pCal);
    const d = leg.decimal || americanToDecimal(leg.odds);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || d == null) return null;
    ps.push(p);
    prob *= p;
    dec *= d;
  }
  const pairs = [];
  let covAdd = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const rule = pairRule(list[i], list[j]);
      if (!rule.ok) return null;
      pairs.push(rule);
      if (rule.phi) {
        const cov = rule.phi * sigma(ps[i]) * sigma(ps[j]);
        covAdd += (prob / (ps[i] * ps[j])) * cov;
      }
    }
  }
  const pJoint = prob + covAdd;
  if (!(pJoint > 0 && pJoint < 1) || !(dec > 1)) return null;
  const factor = prob > 0 ? pJoint / prob : 1;
  const american = decimalToAmerican(dec);
  const ev = pJoint * dec - 1;
  const sameGame = pairs.some((pair) => pair.sameGame);
  return {
    prob,
    pJoint,
    decimal: dec,
    american,
    combinedOdds: formatAmerican(american),
    ev,
    factor,
    pairs,
    correlated: sameGame,
    sameGame,
    correlationNote: correlationNote(pairs),
  };
}

function correlationNote() {
  return 'Distinct games. Joint probability is the product. No flat haircut.';
}

function combinations(pool, n) {
  const out = [];
  const acc = [];
  function walk(start) {
    if (acc.length === n) {
      if (!bannedPairReason(acc)) out.push(acc.slice());
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      acc.push(pool[i]);
      walk(i + 1);
      acc.pop();
    }
  }
  walk(0);
  return out;
}

function edgeSum(legs) {
  return legs.reduce((sum, leg) => sum + (Number(leg.edgeNovig) || 0), 0);
}

/** Historical ML+total pattern. Last tiebreak, after EV, leg count, and edge. */
function mlTotalMix(legs) {
  const names = legs.map(legMarket);
  return names.includes('Moneyline') && names.includes('Total') ? 1 : 0;
}

function betterTicket(a, b) {
  const evGap = a.scored.ev - b.scored.ev;
  if (Math.abs(evGap) > 1e-12) return evGap;
  if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
  const edgeGap = edgeSum(a.legs) - edgeSum(b.legs);
  if (Math.abs(edgeGap) > 1e-12) return edgeGap;
  return mlTotalMix(a.legs) - mlTotalMix(b.legs);
}

/**
 * Price EV at the leg's DK/HR American number.
 * Null when the probability or the price cannot be scored.
 */
function legPriceEv(leg) {
  const p = Number(leg && leg.calibration && leg.calibration.pCal);
  const dec = americanToDecimal(leg && leg.odds);
  if (!(p > 0 && p < 1) || dec == null) return null;
  return p * dec - 1;
}

/**
 * A no-vig leg whose DK/HR price is not +EV. Other disqualifications
 * (no calibration, no no-vig edge, uncertainty floor) are not this skip.
 */
function legFailsPriceEv(leg) {
  if (!leg || leg.parlayQualified === false) return false;
  const p = Number(leg.calibration && leg.calibration.pCal);
  const dec = americanToDecimal(leg.odds);
  if (!(p > 0 && p < 1 && dec != null && (leg.edgeNovig > 0))) return false;
  return !(legPriceEv(leg) > 0);
}

function legEvSkips(pool) {
  const skips = [];
  for (const leg of pool || []) {
    if (!legFailsPriceEv(leg)) continue;
    const p = Number(leg.calibration && leg.calibration.pCal);
    skips.push({
      matchup: leg.matchup || null,
      side: leg.pick || leg.side || null,
      market: leg.market || null,
      sport: leg.sport || null,
      reason: 'leg-ev-not-positive',
      odds: leg.odds,
      edge: leg.edge != null ? leg.edge : null,
      edgeNovig: leg.edgeNovig != null ? leg.edgeNovig : null,
      pCal: p,
      pMkt: leg.calibration && leg.calibration.pMkt != null ? leg.calibration.pMkt : null,
    });
  }
  return skips;
}

/**
 * A posted book that is not DraftKings or Hard Rock. Other skips
 * (no calibration, no no-vig edge) are not this reason.
 */
function legBookSkips(pool) {
  const skips = [];
  for (const leg of pool || []) {
    if (!leg || leg.parlayQualified === false) continue;
    if (quotedLeg(leg)) continue;
    const posted = String(leg.book || '').toLowerCase();
    if (!posted) continue;
    skips.push({
      matchup: leg.matchup || null,
      side: leg.pick || leg.side || null,
      market: leg.market || null,
      sport: leg.sport || null,
      reason: 'no-dk-hr-price',
      odds: leg.odds,
      book: leg.book,
      edgeNovig: leg.edgeNovig != null ? leg.edgeNovig : null,
    });
  }
  return skips;
}

function usableLegs(pool, opts) {
  const asOfMs = pregameClockMs(opts);
  const out = [];
  for (const raw of pool || []) {
    const leg = quotedLeg(raw);
    if (!leg) continue;
    if (pastPregameCutoff(leg.commenceTime, asOfMs)) continue;
    if (leg.parlayQualified === false) continue;
    const p = Number(leg.calibration && leg.calibration.pCal);
    const dec = americanToDecimal(leg.odds);
    if (!(p > 0 && p < 1 && dec != null && (leg.edgeNovig > 0))) continue;
    if (!(legPriceEv(leg) > 0)) continue;
    out.push(leg);
  }
  return out;
}

/**
 * Ranked tickets with positive joint EV.
 * A ticket whose quarter-Kelly rounds below 0.25u is not a candidate.
 * The next ticket is, so a 3-leg that cannot be staked falls through
 * to a 2-leg that can. The higher joint EV ranks first. Leg count
 * breaks a tie.
 */
function rankedTickets(pool, opts) {
  const usable = usableLegs(pool, opts);
  const out = [];
  let positiveEv = 0;
  if (usable.length < 2) return { usable: usable.length, positiveEv, tickets: out };
  for (const n of [3, 2]) {
    if (usable.length < n) continue;
    for (const legs of combinations(usable, n)) {
      const scored = scoreLegs(legs);
      if (!scored || !(scored.ev > 0)) continue;
      positiveEv += 1;
      const sized = quarterKellyFromDecimal(scored.pJoint, scored.decimal, PARLAY_STAKE_CAP);
      if (!(sized.units >= 0.25)) continue;
      out.push({ legs, scored, kellyUnits: sized.units, kellyFrac: sized.kellyFrac });
    }
  }
  out.sort((a, b) => betterTicket(b, a));
  return { usable: usable.length, positiveEv, tickets: out };
}

function chooseTicket(pool, opts) {
  const ranked = rankedTickets(pool, opts);
  return ranked.tickets[0] || null;
}

/**
 * Quarter-Kelly on the joint decimal, cap 1u, nearest 0.25u.
 * A result that rounds under 0.25u does not publish. It is not floored
 * up to 0.25u (kellyToUnits does that; this path must not).
 * Room left under the card budget can shrink the stake. It cannot raise it.
 * A leg priced off DraftKings and Hard Rock is not in the search. The next
 * positive-EV DK/HR ticket is, including a shorter ticket when the longer
 * one was the non-placeable leg.
 */
function sizeParlay(pool, straights, opts) {
  const asOfMs = pregameClockMs(opts);
  const pregame = (pool || []).filter((leg) => !pastPregameCutoff(leg.commenceTime, asOfMs));
  const filtered = pregame.filter((leg) => !conflictsWithAnyStraight(leg, straights));
  const placeable = filtered.filter((leg) => quotedLeg(leg));
  const ranked = rankedTickets(placeable, opts);
  if (!ranked.tickets.length) {
    const hadPair = pregame.length >= 2;
    let skipReason = 'no ticket with positive joint EV';
    if (pregame.length < 2) skipReason = 'fewer than 2 qualifying legs';
    else if (hadPair && filtered.length < 2) skipReason = 'fewer than 2 legs after straight conflicts';
    else if (filtered.length >= 2 && placeable.length < 2) skipReason = 'no-dk-hr-price';
    else if (ranked.positiveEv > 0) skipReason = 'parlay stake rounded below 0.25u';
    return {
      publish: false,
      units: 0,
      stakeUsd: 0,
      legs: [],
      skipReason,
    };
  }
  const room = Math.max(0, CARD_BUDGET - sumUnits(straights));
  for (const chosen of ranked.tickets) {
    let units = chosen.kellyUnits;
    if (units > room) units = roundQuarter(Math.floor((room + 1e-9) * 4) / 4);
    if (!(units >= 0.25)) continue;
    return {
      publish: true,
      units,
      stakeUsd: stakeUsd(units),
      legs: chosen.legs,
      skipReason: null,
      kellyFrac: chosen.kellyFrac,
      ...chosen.scored,
    };
  }
  return {
    publish: false,
    units: 0,
    stakeUsd: 0,
    legs: [],
    skipReason: 'parlay stake rounded below 0.25u',
    ev: ranked.tickets[0].scored.ev,
    kellyFrac: ranked.tickets[0].kellyFrac,
  };
}

module.exports = {
  correlationNote,
  pairRule,
  bannedPairReason,
  scoreLegs,
  chooseTicket,
  rankedTickets,
  sizeParlay,
  legMarket,
  mlTotalMix,
  sameSide,
  legPriceEv,
  legFailsPriceEv,
  legEvSkips,
  legBookSkips,
  quotedLeg,
  canonicalPlaceBook,
  PLACEABLE_BOOKS,
};
