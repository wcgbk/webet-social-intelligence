'use strict';

const {
  PAIR_PHI, PARLAY_STAKE_CAP, CARD_BUDGET,
} = require('./constants');
const { marketFamily, gameKey, pastPregameCutoff, pregameClockMs } = require('./select');
const { roundQuarter, stakeUsd, sumUnits, quarterKellyFromDecimal } = require('./size');
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
 * Same-game market pairs.
 * ML+spread is disallowed. The graded same-game sample of that pair is
 * n=4, phi=1.0, SE=0.50 (kpi.picks, all models). The 95% interval excludes
 * 0: the spread side and the moneyline side are one outcome, not two bets.
 * Same side is the measured case. The opposite side is the complement
 * (a middle) and is not a second leg either.
 * ML+total and spread+total keep the product of the probabilities.
 * Their measured phi sits inside 1.96 SE, so PAIR_PHI.apply is 0.
 * That is not the flat 0.95 haircut.
 */
function pairRule(a, b) {
  const sameGame = legGame(a) && legGame(a) === legGame(b);
  if (!sameGame) return { ok: true, sameGame: false, phi: 0, kind: 'cross-game', n: null };
  const key = [legMarket(a), legMarket(b)].sort().join('+');
  if (key === 'Moneyline+Spread') {
    const side = sameSide(a, b) ? 'same-side' : 'opposite';
    return { ok: false, sameGame: true, kind: key, reason: `same-game-ml-spread-${side}` };
  }
  if (key === 'Moneyline+Moneyline' || key === 'Spread+Spread' || key === 'Total+Total') {
    return { ok: false, sameGame: true, kind: key, reason: 'same-game-same-market' };
  }
  const measured = PAIR_PHI[key];
  if (!measured) return { ok: false, sameGame: true, kind: key, reason: 'same-game-unmeasured' };
  return {
    ok: true,
    sameGame: true,
    kind: key,
    phi: measured.apply,
    measuredPhi: measured.phi,
    n: measured.n,
    se: measured.se,
  };
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
 * Joint probability. Cross-game pairs and same-game pairs whose phi is
 * inside sampling noise contribute the product. A measured phi that cleared
 * its SE would add phi * sigma_a * sigma_b on that pair only.
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

function correlationNote(pairs) {
  const same = (pairs || []).filter((pair) => pair.sameGame);
  if (!same.length) return 'Distinct games. Joint probability is the product. No flat haircut.';
  return same.map((pair) => {
    const measured = Number(pair.measuredPhi);
    const n = pair.n;
    const applied = pair.phi || 0;
    return `${pair.kind} measured phi ${measured.toFixed(3)} on n=${n} (SE ${Number(pair.se).toFixed(3)}); applied phi ${applied} because the 95% interval includes 0.`;
  }).join(' ');
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

/** Historical ML+total pattern. Tiebreak only, after leg count and edge. */
function mlTotalMix(legs) {
  const names = legs.map(legMarket);
  return names.includes('Moneyline') && names.includes('Total') ? 1 : 0;
}

function betterTicket(a, b) {
  if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
  const edgeGap = edgeSum(a.legs) - edgeSum(b.legs);
  if (Math.abs(edgeGap) > 1e-12) return edgeGap;
  const mixGap = mlTotalMix(a.legs) - mlTotalMix(b.legs);
  if (mixGap) return mixGap;
  return a.scored.ev - b.scored.ev;
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

function usableLegs(pool, opts) {
  const asOfMs = pregameClockMs(opts);
  return (pool || []).filter((leg) => {
    if (pastPregameCutoff(leg.commenceTime, asOfMs)) return false;
    if (leg.parlayQualified === false) return false;
    const p = Number(leg.calibration && leg.calibration.pCal);
    const dec = americanToDecimal(leg.odds);
    if (!(p > 0 && p < 1 && dec != null && (leg.edgeNovig > 0))) return false;
    return legPriceEv(leg) > 0;
  });
}

/**
 * Ranked tickets with positive joint EV.
 * A ticket whose quarter-Kelly rounds below 0.25u is not a candidate.
 * The next ticket is, so a 3-leg that cannot be staked falls through
 * to a 2-leg that can. 3 legs still rank ahead of 2.
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
 * Quarter-Kelly on the joint decimal, cap 1u, 0.25u steps.
 * A result under 0.25u does not publish. There is no 0.5u floor.
 * Room left under the card budget can shrink the stake. It cannot raise it.
 */
function sizeParlay(pool, straights, opts) {
  const asOfMs = pregameClockMs(opts);
  const pregame = (pool || []).filter((leg) => !pastPregameCutoff(leg.commenceTime, asOfMs));
  const filtered = pregame.filter((leg) => !conflictsWithAnyStraight(leg, straights));
  const ranked = rankedTickets(filtered, opts);
  if (!ranked.tickets.length) {
    const hadPair = pregame.length >= 2;
    let skipReason = 'no ticket with positive joint EV';
    if (pregame.length < 2) skipReason = 'fewer than 2 qualifying legs';
    else if (hadPair && filtered.length < 2) skipReason = 'fewer than 2 legs after straight conflicts';
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
};
