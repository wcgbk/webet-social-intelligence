'use strict';

const { GATES, PLACEABILITY } = require('./config');
const { isSameEtDay } = require('./odds_math');
const { adverseSteamReason } = require('./line_path');

function sportFloor(map, sport) {
  return map[sport] != null ? map[sport] : map.default;
}

/**
 * US retail placeability. Distinct from insufficient-liquidity (that gate
 * counts MAJOR_LIQUIDITY_BOOKS, including Pinnacle, with no juice test).
 * Legacy candidates with no annotation are not vetoed.
 */
function failsPlaceability(c) {
  if (!c || c.placeable === true) return false;
  if (c.placeable === false) return true;
  if (Array.isArray(c.placeableBooks)) {
    return c.placeableBooks.length < PLACEABILITY.minMajorBooks;
  }
  return false;
}

/**
 * @param {object} c candidate
 * @param {{ cardDate?: string }} opts cardDate = ET YYYY-MM-DD for same-day scope
 */
function gateReason(c, opts = {}) {
  const sport = c.sport || 'default';
  const minEV = sportFloor(GATES.minEV, sport);
  const minCP = sportFloor(GATES.minCoverProb, sport);
  const cardDate = opts.cardDate || opts.dateISO || null;

  // Same ET calendar day only — reject weekend football on Tue/Wed cards, etc.
  if (GATES.sameEtDayOnly && cardDate) {
    if (!c.commenceTime) return 'missing-commenceTime';
    if (!isSameEtDay(c.commenceTime, cardDate)) return 'not-same-et-day';
  }

  if (GATES.pregameOnly && c.commenceTime) {
    const t = Date.parse(c.commenceTime);
    if (Number.isFinite(t) && t < Date.now() - 5 * 60 * 1000) {
      return 'in-progress-or-started';
    }
  }
  if (!Number.isFinite(c.odds)) return 'no-odds';
  if (c.odds < GATES.minAmericanOdds || c.odds > GATES.maxAmericanOdds) return 'odds-out-of-band';
  if (GATES.requireMajorBook && !c.liquid) return 'insufficient-liquidity';
  if (!Number.isFinite(c.coverProb) || c.coverProb < minCP) return 'coverProb-floor';
  if (!Number.isFinite(c.ev) || c.ev < minEV) return 'ev-floor';
  if (typeof c.predictedClv === 'number' && c.predictedClv < GATES.minPredictedClvCents) {
    return 'predictedClv-negative';
  }
  // Positive edge vs implied
  if (Number.isFinite(c.edgePct) && c.edgePct <= 0) return 'nonpositive-edge';

  // Open→now adverse steam (when line-move annotated)
  if (GATES.rejectAdverseSteam && c.lineMove) {
    const steamReason = adverseSteamReason(c.lineMove, { verify: false });
    if (steamReason) return steamReason;
  }

  // After quality gates: a strong edge that is not shoppable at US retail
  // books is a soft-veto, not a published ticket. Empty card OK.
  if (failsPlaceability(c)) return 'placeability-soft-veto';

  return null;
}

/**
 * Filter to YES pool. Empty OK — no force-fill.
 * Pass opts.cardDate (ET YYYY-MM-DD) to enforce same-day commenceTime scope.
 */
function applyGates(candidates, opts = {}) {
  const yes = [];
  const rejected = [];
  for (const c of candidates || []) {
    const reason = gateReason(c, opts);
    if (reason) rejected.push({ ...c, rejectReason: reason });
    else yes.push(c);
  }
  return { yesPool: yes, rejected };
}

module.exports = { applyGates, gateReason, failsPlaceability };
