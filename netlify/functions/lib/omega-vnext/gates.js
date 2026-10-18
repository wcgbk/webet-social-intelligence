'use strict';

const { GATES, PLACEABILITY, MODEL_LINE_GAP } = require('./config');
const { minEdgeFor, mainMinEv, stakeQuoteIsStale, failsEdgeFloorSe } = require('./edge_floor');
const { formatMoneylinePick } = require('./odds_math');
const { eligibleForLeanPool } = require('./select');
const { adverseSteamReason } = require('./line_path');
const { footballMarketGapReason } = require('./sports/_common');
const { slateReason, nflProjectionGap, liveInPlayReason } = require('./selection_pass');

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

function normTeamToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenHit(side, team) {
  if (!side || !team) return false;
  return side === team || side.startsWith(`${team} `) || side.endsWith(` ${team}`) || side.includes(` ${team} `);
}

/** True when the side is that club, including a nickname on a full name. */
function sideNamesTeam(side, team) {
  const s = normTeamToken(side);
  const t = normTeamToken(team);
  if (!s || !t) return false;
  if (tokenHit(s, t)) return true;
  const words = t.split(' ').filter(Boolean);
  if (words.length < 2) return false;
  const nick = words[words.length - 1];
  if (nick.length < 4) return false;
  return tokenHit(s, nick);
}

/**
 * Injuries never exclude a side or a total. The starter/position haircut
 * reprices the probability. This stays exported so a caller can assert
 * the gate is off. Flags on the candidate are ignored.
 */
function injuryClusterReason() {
  return null;
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
  const minEV = mainMinEv(c.odds, sportFloor(GATES.minEV, sport));
  const minCP = sportFloor(GATES.minCoverProb, sport);
  const cardDate = opts.cardDate || opts.dateISO || null;

  // Unresolved NFL/NCAAF name. Checked before the floors so a bad id cannot publish.
  if (c && c.unknownTeam) return 'unknown_team';

  // Margin residual past 3× the sport limit. The rating is broken for that
  // game on this run. Not a lean, and not a fill for a short card.
  // Removed as a gate 2026-10-18: margin bias is a health alert/flag, not a
  // sheet floor. The measured correction lives in sports/nfl.js.
  void (c && c.marginBiasExtreme);

  // The printed projection and the side have to be the same story.
  // An Over whose total is under the number is not a bet, even when a
  // period model leaves a hair of stake EV.
  // pureModelPriced is no longer set on the card. The bet-price edge
  // path keeps the same projection check and the same skips below.
  const pure = !!(c && (c.pureModelPriced || c.edgeBasis === 'model-edge-vs-bet-price'));
  // Removed as a gate 2026-10-18: projection-vs-side is not a sheet floor.
  void (c && pure && projectionDisagrees(c));

  // Sharp-fair path. A bad Pinnacle pair is structural (not a lean).
  // A priced row skips the model-gap veto: the probability is the Pinnacle
  // power fair, so a model/line disagreement is not a reason to drop it.
  // Bet-price rows (and the old pure-model rows) do not use a Pinnacle
  // pair, a sharp gap, or steam as a gate.
  if (c && c.sharpFairReject && !pure) return c.sharpFairReject;
  if (!(c && c.sharpFairPriced) && !pure) {
    // Absurd model-vs-market gap. Caps live in FB_MARKET_GAP and are wider
    // than the MODEL_LINE_GAP flag. A normal disagreement still prices.
    const marketGap = footballMarketGapReason(c);
    if (marketGap) return marketGap;

    // NFL totals whose |projection − sharp| is above 10 and still inside the
    // wider FB_MARKET_GAP total cap. Spreads above 10 already returned
    // model_market_gap. Exactly 10 stays eligible.
    const projGap = nflProjectionGap(c);
    if (projGap) return projGap;

    // Football model-vs-line gap. Only mode 'block' rejects, and that mode
    // failed the 2026-10-06 replay gate. Shipped mode 'flag' leaves the
    // candidate on the same score and the same gates.
    if (gapBlocksTicket(c)) return 'model_line_gap_review';
  }

  // Live/in-play and a start already past the pregame clock are rejected
  // before the slate window. A game that has tipped keeps
  // in-progress-or-started (or live-in-play) even when that tip was also
  // before 11:15 ET.
  const live = liveInPlayReason(c);
  if (live) return live;

  if (GATES.pregameOnly && c.commenceTime) {
    const t = Date.parse(c.commenceTime);
    const asOfMs = resolvePregameAsOfMs(opts);
    if (Number.isFinite(t) && t < asOfMs - PREGAME_GRACE_MS) {
      return 'in-progress-or-started';
    }
  }

  // Slate: 11:15 ET on the card date through 6:00 ET the next day.
  // Earlier the same morning is starts-before-1115-et. At or after 6:00
  // next day is future-date. Other dates stay not-same-et-day.
  if (GATES.sameEtDayOnly && cardDate) {
    const slate = slateReason(c, cardDate, opts);
    if (slate) return slate;
  }
  if (!Number.isFinite(c.odds)) return 'no-odds';
  if (c.odds < GATES.minAmericanOdds || c.odds > GATES.maxAmericanOdds) return 'odds-out-of-band';
  if (GATES.requireMajorBook && !c.liquid) return 'insufficient-liquidity';
  // minCoverProb stays 0. A missing cover still rejects. There is no flat
  // coverProb floor, so a 30% cover is not rejected for the cover itself.
  // Main stake EV is a flat 2% for every sport. Odds do not raise it.
  // EV above EV_CAP_ALL is a model-error flag: logged, not a lean.
  // Edge under max(2%, k*SE) is edge-floor-se. Default k is 0, so this is
  // the flat 2% edge minimum. applyGates promotes that miss the same way
  // as ev-floor when the row is lean-eligible.
  // EV under the 2% floor returns ev-floor.
  if (!Number.isFinite(c.coverProb) || (minCP != null && c.coverProb < minCP)) return 'coverProb-floor';
  // Sheet-aligned (2026-10-18): EV above the cap is a flag-for-audit on the
  // candidate (bet_check credibility), NOT an outright gate rejection.
  if (stakeQuoteIsStale(c)) {
    console.log(`[omega-vnext] ev-audit-flag ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} ev=${c.ev} edge=${finiteEdge(c)} reason=ev-above-cap`);
    c.evAuditFlag = true;
  }
  if (failsEdgeFloorSe(c)) return 'edge-floor-se';
  // Pinnacle no-vig is a CLV input, not a selection gate. A miss of the
  // 2% stake-EV floor, including a non-positive EV, stays ev-floor so the
  // lean fill can still publish 3 straights.
  // Sharp card: grades are the price edge, p_fair − implied.
  // A− and up (≥2%) are mains. B is the 1–2% lean. Under 1% is edge-floor
  // here. selectStraights may still fill a short card from those same-line
  // Pinnacle pairs, ranked by EV, at a flat 0.5u lean.
  if (c && c.sharpFairPriced) {
    const edge = finiteEdge(c);
    if (!Number.isFinite(edge) || edge < 0.01 - 1e-12) return 'edge-floor';
    if (edge < 0.02 - 1e-12) return 'ev-floor';
    if (!Number.isFinite(c.ev)) return 'ev-floor';
  } else if (!Number.isFinite(c.ev) || (minEV != null && c.ev < minEV)) return 'ev-floor';
  // Removed 2026-10-18: predicted-CLV is not a sheet floor; tracked only.

  // Pinnacle (else Circa) 3:00→10:00 probability moved against this side.
  // The sharp-fair price is already the 10:00 two-way. The move is inside
  // that fair, so it does not veto a soft price that still beats it.
  // Pure-model rows do not use the move or the steam print to select.
  if (!(c && c.sharpFairPriced) && !pure && c.movementDrop) return c.movementDropReason || 'sharp_prob_against';

  // Open→now adverse steam on the Pinnacle print (when line-move annotated)
  if (!(c && c.sharpFairPriced) && !pure && GATES.rejectAdverseSteam && c.lineMove) {
    const steamReason = adverseSteamReason(c.lineMove, { verify: false });
    if (steamReason) return steamReason;
  }

  // One US book, or a price the other majors do not offer, is logged.
  // It does not block a qualifying EV. Verify still keeps a published
  // pick when Hard Rock or DraftKings can price it.
  if (failsPlaceability(c)) {
    const books = Array.isArray(c.placeableBooks) ? c.placeableBooks.length : 'na';
    console.log(`[omega-vnext] placeability-logged ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} books=${books}`);
  }

  return null;
}

/**
 * Filter to YES pool. Empty OK — no force-fill.
 * Pass opts.cardDate (ET YYYY-MM-DD) to enforce same-day commenceTime scope.
 * Pass opts.asOfMs or opts.asOf to judge pregame against a snapshot instant
 * (historical replay). Omit both for live Date.now() semantics.
 */
function printedProjection(c) {
  const bet = Number(c && c.betProjection);
  if (Number.isFinite(bet)) return bet;
  const raw = Number(c && c.modelProjection);
  return Number.isFinite(raw) ? raw : null;
}

/**
 * True when the side fights the projection the card prints.
 * Totals: Over needs the total above the number, Under below it.
 * Spreads: the side's cover residual (side margin + line) has to be positive.
 * A moneyline has no point, so this check does not apply.
 */
function projectionDisagrees(c) {
  const market = String((c && c.market) || '');
  const line = Number(c && (c.line != null ? c.line : c.consensusLine));
  const proj = printedProjection(c);
  if (!Number.isFinite(proj) || !Number.isFinite(line)) return false;
  const side = String((c && (c.side || c.pick)) || '').toLowerCase();
  if (/total/i.test(market)) {
    if (/^over\b/i.test(side)) return !(proj > line);
    if (/^under\b/i.test(side)) return !(proj < line);
    return false;
  }
  if (!/spread|puck|run line/i.test(market)) return false;
  const away = String((c && c.awayTeam) || '').toLowerCase();
  const sideProj = away && side.startsWith(away) ? -proj : proj;
  return !(sideProj + line > 0);
}

function finiteEdge(c) {
  const raw = c && c.edgePct;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1 ? raw / 100 : raw;
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}

/**
 * A floor miss can still be a lean. ev-floor and edge-floor-se both
 * promote. ev-stale and structural rejects stay rejects. The row must
 * pass eligibleForLeanPool: positive EV, pregame, a retail line, and
 * EV at or under EV_CAP_ALL.
 */
function asLean(c, reason) {
  if (reason !== 'ev-floor' && reason !== 'edge-floor-se') return null;
  if (!eligibleForLeanPool(c)) return null;
  return { ...c, tier: 'lean', leanReason: reason };
}

function applyGates(candidates, opts = {}) {
  const yes = [];
  const lean = [];
  const rejected = [];
  for (const c of candidates || []) {
    const reason = gateReason(c, opts);
    if (!reason) {
      yes.push({ ...c, tier: 'floor' });
      continue;
    }
    const leanRow = asLean(c, reason);
    if (leanRow) {
      lean.push(leanRow);
      continue;
    }
    if (reason === 'model_line_gap_review') {
      console.log(`[omega-vnext] model_line_gap_review ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} gap=${c.modelLineGap} line=${c.marketLine}`);
    }
    if (reason === 'model_market_gap') {
      console.log(`[omega-vnext] model_market_gap ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} gap=${c.modelLineGap}`);
    }
    if (reason === 'nfl-projection-gap') {
      console.log(`[omega-vnext] nfl-projection-gap ${c.sport || ''} ${c.matchup || ''} ${c.side || ''} gap=${c.modelLineGap} proj=${c.modelTotalRaw != null ? c.modelTotalRaw : c.modelProjection} market=${c.marketTotal != null ? c.marketTotal : c.marketLine}`);
    }
    rejected.push({ ...c, rejectReason: reason });
  }
  if (rejected.length || lean.length) {
    const counts = {};
    for (const r of rejected) counts[r.rejectReason] = (counts[r.rejectReason] || 0) + 1;
    console.log(`[omega-vnext] gate-rejects ${JSON.stringify(counts)} yes=${yes.length} lean=${lean.length}`);
  }
  return { yesPool: yes, leanPool: lean, rejected };
}

module.exports = {
  applyGates, gateReason, failsPlaceability, resolvePregameAsOfMs, PREGAME_GRACE_MS,
  isGapReviewMarket, buildGapReview, gapBlocksTicket, minEdgeFor,
  nflProjectionGap, slateReason, liveInPlayReason, injuryClusterReason, sideNamesTeam,
  projectionDisagrees,
};
