'use strict';

const { GATES, PLACEABILITY, MODEL_LINE_GAP } = require('./config');
const { isSameEtDay, formatMoneylinePick } = require('./odds_math');
const { adverseSteamReason } = require('./line_path');
const { footballMarketGapReason } = require('./sports/_common');

function sportFloor(map, sport) {
  return map[sport] != null ? map[sport] : map.default;
}

/** Totals and spreads only. Moneyline has no point line to review. */
function isGapReviewMarket(market) {
  const m = String(market || '');
  if (/moneyline|^ml$/i.test(m)) return false;
  return /total|spread/i.test(m);
}

/**
 * Shipped mode is 'flag'. 'block' failed the 2026-10-06 replay gate and
 * is not the default. A missing mode does not reject.
 */
function gapBlocksTicket(c) {
  if (!MODEL_LINE_GAP || MODEL_LINE_GAP.mode !== 'block') return false;
  return !!(c && c.gapFlag === true && isGapReviewMarket(c.market));
}

function sameGapTicket(c, p) {
  if (!c || !p) return false;
  const labeled = formatMoneylinePick(c.side, c.market);
  const pickName = p.pick || p.side;
  if (pickName !== c.side && pickName !== labeled) return false;
  if (p.matchup && c.matchup && p.matchup !== c.matchup) return false;
  const market = p.betType || p.market;
  if (market && c.market && market !== c.market) return false;
  return true;
}

function ticketSelected(c, picks, parlayLegs) {
  if ((picks || []).some(p => sameGapTicket(c, p))) return true;
  for (const pl of parlayLegs || []) {
    if ((pl.legs || []).some(leg => sameGapTicket(c, leg))) return true;
  }
  return false;
}

/**
 * Private card list. Flagged totals and spreads only. Does not change
 * who competes. selected is true when the side is a published straight
 * or a published parlay leg.
 */
function buildGapReview(candidates, picks, parlayLegs) {
  const rows = [];
  for (const c of candidates || []) {
    if (!c || c.gapFlag !== true || !isGapReviewMarket(c.market)) continue;
    const isTotal = /total/i.test(String(c.market || ''));
    rows.push({
      sport: c.sport,
      matchup: c.matchup,
      side: c.side,
      line: c.line != null ? c.line : c.marketLine,
      modelRaw: isTotal ? c.modelTotalRaw : c.modelMarginRaw,
      gap: c.modelLineGap,
      selected: ticketSelected(c, picks, parlayLegs),
    });
  }
  return rows;
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

const PREGAME_GRACE_MS = 5 * 60 * 1000;

/**
 * Clock for pregameOnly. Live calls omit asOf and stay on Date.now().
 * Historical replay passes asOfMs or an ISO asOf so a past slate is judged
 * against the snapshot, not wall-clock now. Unparseable asOf falls back to now.
 */
function resolvePregameAsOfMs(opts = {}) {
  if (opts && Number.isFinite(opts.asOfMs)) return opts.asOfMs;
  if (opts && opts.asOf != null && opts.asOf !== '') {
    const n = typeof opts.asOf === 'number' ? opts.asOf : Date.parse(opts.asOf);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

/**
 * @param {object} c candidate
 * @param {{ cardDate?: string, asOfMs?: number, asOf?: string|number }} opts
 *   cardDate = ET YYYY-MM-DD for same-day scope.
 *   asOfMs / asOf = pregame clock (snapshot instant). Omit for live Date.now().
 */
function gateReason(c, opts = {}) {
  const sport = c.sport || 'default';
  const minEV = sportFloor(GATES.minEV, sport);
  const minCP = sportFloor(GATES.minCoverProb, sport);
  const cardDate = opts.cardDate || opts.dateISO || null;

  // Unresolved NFL/NCAAF name. Checked before the floors so a bad id cannot publish.
  if (c && c.unknownTeam) return 'unknown_team';

  // Absurd model-vs-market gap. Caps live in FB_MARKET_GAP and are wider
  // than the MODEL_LINE_GAP flag. A normal disagreement still prices.
  const marketGap = footballMarketGapReason(c);
  if (marketGap) return marketGap;

  // Football model-vs-line gap. Only mode 'block' rejects, and that mode
  // failed the 2026-10-06 replay gate. Shipped mode 'flag' leaves the
  // candidate on the same score and the same gates. Moneyline is not a
  // point market. MLB/NHL never set the flag.
  if (gapBlocksTicket(c)) return 'model_line_gap_review';

  // Same ET calendar day only — reject weekend football on Tue/Wed cards, etc.
  if (GATES.sameEtDayOnly && cardDate) {
    if (!c.commenceTime) return 'missing-commenceTime';
    if (!isSameEtDay(c.commenceTime, cardDate)) return 'not-same-et-day';
  }

  if (GATES.pregameOnly && c.commenceTime) {
    const t = Date.parse(c.commenceTime);
    const asOfMs = resolvePregameAsOfMs(opts);
    if (Number.isFinite(t) && t < asOfMs - PREGAME_GRACE_MS) {
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
 * Pass opts.asOfMs or opts.asOf to judge pregame against a snapshot instant
 * (historical replay). Omit both for live Date.now() semantics.
 */
function applyGates(candidates, opts = {}) {
  const yes = [];
  const rejected = [];
  for (const c of candidates || []) {
    const reason = gateReason(c, opts);
    if (reason) {
      if (reason === 'model_line_gap_review') {
        console.log(`[omega-vnext] model_line_gap_review ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} gap=${c.modelLineGap} line=${c.marketLine}`);
      }
      if (reason === 'model_market_gap') {
        console.log(`[omega-vnext] model_market_gap ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} gap=${c.modelLineGap}`);
      }
      rejected.push({ ...c, rejectReason: reason });
    } else yes.push(c);
  }
  return { yesPool: yes, rejected };
}

module.exports = {
  applyGates, gateReason, failsPlaceability, resolvePregameAsOfMs, PREGAME_GRACE_MS,
  isGapReviewMarket, buildGapReview, gapBlocksTicket,
};
