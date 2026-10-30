'use strict';

const {
  PARLAY_CAP, PARLAY_MIN_EV, SAME_SPORT_HAIRCUT, TOTAL_HAIRCUT, KELLY_FRACTION, CARD_BUDGET,
} = require('./constants');
const { marketFamily, totalSide } = require('./select');
const { roundQuarter, stakeUsd, sumUnits } = require('./size');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyFraction,
} = require('../omega-vnext/odds_math');

function legMarket(leg) {
  return leg.marketFamily || marketFamily(leg.market, leg.pick);
}

/**
 * Same-game tickets are not built. Same-sport legs and same-direction totals
 * take a haircut strictly below 1. Unrelated sports stay at 1.
 */
function correlationFactor(legs) {
  const list = legs || [];
  const sports = list.map((leg) => String(leg.sport || '').toUpperCase());
  const sameSport = sports.some((sport, i) => sport && sports.indexOf(sport) !== i);
  const totals = list.filter((leg) => legMarket(leg) === 'Total');
  const sides = totals.map((leg) => totalSide(leg.pick));
  const sameDirectionTotals = totals.length >= 2 && sides.every((side) => side && side === sides[0]);
  let factor = 1;
  if (sameSport) factor *= SAME_SPORT_HAIRCUT;
  if (sameDirectionTotals) factor *= TOTAL_HAIRCUT[totals.length] || TOTAL_HAIRCUT[3];
  const correlated = sameSport || sameDirectionTotals;
  if (correlated && !(factor < 1)) factor = SAME_SPORT_HAIRCUT;
  return {
    factor,
    correlated,
    sameSport,
    sameDirectionTotals,
  };
}

function scoreLegs(legs) {
  let prob = 1;
  let dec = 1;
  for (const leg of legs) {
    const p = Number(leg.calibration && leg.calibration.pCal);
    const d = americanToDecimal(leg.odds);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || d == null) return null;
    prob *= p;
    dec *= d;
  }
  const corr = correlationFactor(legs);
  const pJoint = prob * corr.factor;
  if (!(pJoint > 0 && pJoint < 1)) return null;
  const american = decimalToAmerican(dec);
  const ev = pJoint * dec - 1;
  const kelly = kellyFraction(pJoint, american, KELLY_FRACTION);
  return {
    prob,
    pJoint,
    decimal: dec,
    american,
    combinedOdds: formatAmerican(american),
    ev,
    kelly,
    ...corr,
  };
}

function combinations(pool, n) {
  const out = [];
  const acc = [];
  function walk(start) {
    if (acc.length === n) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      const key = pool[i].gameKey;
      if (key && acc.some((leg) => leg.gameKey === key)) continue;
      acc.push(pool[i]);
      walk(i + 1);
      acc.pop();
    }
  }
  walk(0);
  return out;
}

function mixOk(legs) {
  const names = legs.map(legMarket);
  return names.includes('Moneyline') && names.includes('Total');
}

function chooseTicket(pool) {
  const usable = (pool || []).filter((leg) => leg.calibration && americanToDecimal(leg.odds));
  function best(n) {
    let winner = null;
    for (const legs of combinations(usable, n)) {
      if (!mixOk(legs)) continue;
      const scored = scoreLegs(legs);
      if (!scored || !(scored.ev >= PARLAY_MIN_EV) || !(scored.kelly > 0)) continue;
      const cand = { legs, scored };
      if (!winner || cand.scored.ev > winner.scored.ev + 1e-12) winner = cand;
    }
    return winner;
  }
  // A 3-leg ML+total wins when one clears. A 2-leg is the fallback. SPEC-1.
  return best(3) || best(2);
}

function growthCap(straights) {
  const live = (straights || []).filter((row) => row.units > 0 && !row.skipped);
  if (!live.length) return PARLAY_CAP;
  const minStraight = Math.min(...live.map((row) => row.units));
  return Math.min(PARLAY_CAP, minStraight);
}

/**
 * Stake is quarter-Kelly on the haircut joint, capped at 0.5u and at the
 * smallest straight so the parlay cannot outgrow the straight book.
 */
function sizeParlay(pool, straights) {
  const chosen = chooseTicket(pool);
  if (!chosen) {
    return {
      publish: false,
      units: 0,
      stakeUsd: 0,
      legs: [],
      skipReason: 'no ML+total ticket cleared EV 3%',
    };
  }
  let units = roundQuarter((chosen.scored.kelly || 0) * 100);
  const cap = growthCap(straights);
  if (units > cap) units = cap;
  const straightUnits = sumUnits(straights);
  const room = Math.max(0, CARD_BUDGET - straightUnits);
  if (units > room) units = roundQuarter(Math.floor((room + 1e-9) * 4) / 4);
  if (!(units >= 0.25)) {
    return {
      publish: false,
      units: 0,
      stakeUsd: 0,
      legs: [],
      skipReason: 'parlay stake rounded below 0.25u',
      ev: chosen.scored.ev,
    };
  }
  return {
    publish: true,
    units,
    stakeUsd: stakeUsd(units),
    legs: chosen.legs,
    skipReason: null,
    ...chosen.scored,
  };
}

module.exports = {
  correlationFactor,
  scoreLegs,
  chooseTicket,
  sizeParlay,
  legMarket,
};
