'use strict';

/**
 * Floor, lean, and stake-EV helpers removed from select.js in the 61b9152
 * V1 reset. Semantics match d9d53c6 (parent of that reset).
 *
 * They live here, not in select.js. tools/omega-v2/gate.js freezes
 * select.js against a592e0b so the flag-off publish path stays
 * byte-identical. rerank.js, late_news.js, card_topup.js, and
 * selection_pass.js import these names from this module.
 *
 * The v2 news path does not call them. OMEGA_V2_NEWS_RERANK=off does not
 * route a v2 card through this order.
 */

const { PM_SOFT, GATES, LEAN_PAD } = require('./config');
const { parseEdgeFraction } = require('./odds_math');
const { mainMinEv } = require('./edge_floor');
const { matchupKey } = require('./select');

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

/** PM tie-break only, and only inside this band. */
const SCORE_NUDGE_CAP = 0.002;
/** EV above this (10%, the pre-reset EV_CAP_ALL) is not a lean. */
const EV_CAP_ALL = 0.10;

function publishMinEv(c) {
  const table = (GATES && GATES.minEV) || {};
  const sport = c && c.sport;
  const n = sport && table[sport] != null ? Number(table[sport]) : Number(table.default);
  return mainMinEv(c && c.odds, n);
}

/**
 * Published floor straights. Flat stake EV at mainMinEv. A stale quote
 * stays out of the lean pool, not out of this floor (pre-reset: ev-above-cap
 * is an audit flag, not a publish block).
 */
function passesPublishFloor(c) {
  if (c && c.marginBiasExtreme) return false;
  const ev = Number(c && c.ev);
  const minEV = publishMinEv(c);
  if (!Number.isFinite(ev) || !(ev + 1e-12 >= minEV)) return false;
  return true;
}

/**
 * Label for the published straight card.
 * A number keeps the floor-count strings. An array of picks notes leans.
 */
function straightCardLabel(count) {
  let n;
  let leans = 0;
  if (Array.isArray(count)) {
    n = count.length;
    leans = count.filter((p) => p && p.tier === 'lean').length;
  } else {
    n = Number(count) || 0;
  }
  if (n <= 0) return 'no floor plays';
  if (leans > 0) {
    const floors = n - leans;
    if (floors <= 0) return n === 1 ? 'short card: 1 lean' : `short card: ${n} leans`;
    return `${n} straights (${floors} floor, ${leans} lean)`;
  }
  if (n === 1) return 'short card: 1 floor straight';
  if (n < 3) return `short card: ${n} floor straights`;
  return '3 floor straights';
}

function finiteEv(c) {
  const n = Number(c && c.ev);
  return Number.isFinite(n) ? n : -Infinity;
}

function edgeRank(c) {
  const e = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  return Number.isFinite(e) ? e : -Infinity;
}

function selectionNudge(c) {
  if (!c || typeof c !== 'object') return 0;
  let nudge = clampPmScoreAdj(c._pmScoreAdj);
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return nudge;
}

function marketFamilyOf(row) {
  const market = String((row && (row.market || row.betType)) || '');
  if (/total/i.test(market)) return 'total';
  if (/spread|puck|run/i.test(market)) return 'spread';
  return 'ml';
}

/** Same game and market: a Pinnacle price at this number ranks first. */
function pinnacleLineFirst(a, b) {
  if (matchupKey(a) !== matchupKey(b)) return 0;
  if (marketFamilyOf(a) !== marketFamilyOf(b)) return 0;
  const pa = a && a.anchorFairSource === 'pinnacle' ? 1 : 0;
  const pb = b && b.anchorFairSource === 'pinnacle' ? 1 : 0;
  return pb - pa;
}

/**
 * Higher anchored stake EV first. Edge breaks a tie. The capped PM nudge
 * breaks an exact tie. Same game and market: Pinnacle at this number first.
 */
function compareByEv(a, b) {
  const lined = pinnacleLineFirst(a, b);
  if (lined !== 0) return lined;
  const evd = finiteEv(b) - finiteEv(a);
  if (Math.abs(evd) > 1e-12) return evd;
  const ed = edgeRank(b) - edgeRank(a);
  if (Math.abs(ed) > 1e-12) return ed;
  const nd = selectionNudge(b) - selectionNudge(a);
  if (Math.abs(nd) > 1e-12) return nd;
  return 0;
}

function bookToken(value) {
  return String(value || '').trim().toLowerCase();
}

function isDraftKingsBook(value) {
  const name = bookToken(value);
  return name === 'draftkings' || name === 'draftkings_us';
}

function isHardRockBook(value) {
  const name = bookToken(value);
  return name === 'hardrockbet' || name === 'hardrock';
}

/** DraftKings or Hard Rock. A synthetic fixture with no ladder stays eligible. */
function hasRetailLine(c) {
  if (!c) return false;
  if (Array.isArray(c.bookPrices)) {
    return c.bookPrices.some((p) => {
      const name = p && (p.book || p.key);
      return isDraftKingsBook(name) || isHardRockBook(name);
    });
  }
  const book = bookToken(c.book || c.executionBook);
  if (!book) return true;
  return isDraftKingsBook(book) || isHardRockBook(book);
}

/** Live and in-play are not pregame. A missing clock is not a start. */
function isPregameRow(c) {
  if (!c) return false;
  if (c.inPlay === true || c.live === true || c.in_play === true) return false;
  const st = String(c.priceState || c.marketStatus || '').trim().toLowerCase();
  return st !== 'live' && st !== 'in-play' && st !== 'inplay';
}

/**
 * Structural lean pool. Positive EV at or under the stale rule, DraftKings
 * or Hard Rock (or a synthetic with no ladder), and pregame. A non-positive
 * EV is not a lean. EV above the stale rule is not a lean.
 */
function eligibleForLeanPool(c) {
  if (c && c.marginBiasExtreme) return false;
  const ev = Number(c && c.ev);
  if (!(ev > 0)) return false;
  if (ev < 0.0005) return false;
  const edge = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  if (Number.isFinite(edge) && edge < 0.01 - 1e-12 && ev < 0.01 - 1e-12) return false;
  const maxEV = Number(EV_CAP_ALL);
  if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return false;
  if (!hasRetailLine(c)) return false;
  if (!isPregameRow(c)) return false;
  return true;
}

/** Positive-EV lean fill. Disabled on the 2026-10-18 card (LEAN_PAD and the early return). */
function qualifiesAsLean(c) {
  void c;
  return false;
}

function passesLeanFill(c) {
  if (LEAN_PAD !== true) return false;
  return qualifiesAsLean(c);
}

function sharpEdgeFraction(c) {
  if (!c) return null;
  return parseEdgeFraction(c.edgePct != null ? c.edgePct : c.edge);
}

function clearsOnePctTier(c) {
  if (!c || c.sharpFairPriced !== true) return false;
  const edge = sharpEdgeFraction(c);
  return Number.isFinite(edge) && edge + 1e-12 >= 0.01;
}

/**
 * Same-line Pinnacle pair that did not clear 1%. Structural rejects are not fills.
 */
function eligiblePairedFill(c) {
  if (!c || c.sharpFairPriced !== true || c.sharpFairReject) return false;
  if (clearsOnePctTier(c)) return false;
  return eligibleForLeanPool(c);
}

module.exports = {
  passesPublishFloor,
  passesLeanFill,
  compareByEv,
  straightCardLabel,
  eligibleForLeanPool,
  eligiblePairedFill,
};
