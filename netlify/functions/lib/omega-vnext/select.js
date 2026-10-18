'use strict';

const config = require('./config');
const {
  MAX_STRAIGHTS,
  DAILY_UNIT_CAP, STRAIGHT_UNIT_BUDGET, PARLAY_FIXED_UNITS,
  MAX_STRAIGHT_UNITS_PER_PICK, B_GRADE_UNIT_CAP, LEAN_MAX_UNITS, LEAN_MIN_EDGE,
  BANKROLL_UNITS,
  LEAN_PARLAY_UNITS, PM_SOFT,
  PER_GAME_EXPOSURE_CAP_ENABLED,
} = config;
const {
  ratingToConfidence, formatAmerican, americanToImplied, americanToDecimal,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
  parseEdgeFraction, qualityScore, qualityToRating, pickQualityScore,
  cardHasFullGrade, formatGameTimeET, stakeDollars, toWinDollars,
} = require('./odds_math');
const { fairPickFields } = require('./prob_anchor');
const { minEdgeFor, mainMinEv, stakeQuoteIsStale } = require('./edge_floor');
const { anchoredStakeEv } = require('./push_ev');
const { footballAuditFields } = require('./sports/_common');
const { gameExposureEnabled, GAME_EXPOSURE_CAP } = require('./gaps_flags');
const { reviewFlag } = require('./pinnacle_flag');

function cleanTeam(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * One game whether the matchup says "vs", "vs.", "at", or "@", and
 * whichever team is listed first. Event id is not part of the key: a row
 * that has one must still match a row that only has the team names.
 */
function canonicalGameName(c) {
  const row = c || {};
  const fromParts = (left, right) => [cleanTeam(left), cleanTeam(right)].filter(Boolean).sort().join(' @ ');
  const splitTeams = (raw) => {
    const parts = cleanTeam(raw).split(/\s+(?:@|vs\.?|at)\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return '';
    return fromParts(parts[0], parts.slice(1).join(' '));
  };
  const fromMatchup = splitTeams(row.matchup);
  if (fromMatchup) return fromMatchup;
  const home = cleanTeam(row.homeTeam);
  const away = cleanTeam(row.awayTeam);
  if (home && away && home !== 'undefined' && away !== 'undefined') return fromParts(away, home);
  const built = cleanTeam(`${row.awayTeam} @ ${row.homeTeam}`);
  return splitTeams(built) || built || cleanTeam(row.matchup);
}

function matchupKey(c) {
  const name = canonicalGameName(c);
  const when = (c && (c.commenceTime || c.commence_time)) || '';
  // Doubleheader halves are different games. An empty commence stays
  // name-only so two undated legs of one matchup still conflict, and the
  // undated key has no "|" suffix.
  if (!when) return name;
  return `${name}|${String(when)}`;
}

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

/** PM tie-break only. Line movement is applied to cover probability earlier. */
const SCORE_NUDGE_CAP = 0.002;

/** Calibrated edge vs no-vig fair. Missing edge sorts last. */
function edgeRank(c) {
  const e = parseEdgeFraction(c && c.edgePct);
  return Number.isFinite(e) ? e : -Infinity;
}

/**
 * PM only, inside ±SCORE_NUDGE_CAP. Steam and DK-lag flags do not nudge
 * the score. Movement already changed cover probability, edge, and EV.
 * compareByEdge reads this only after edge and stake EV are already tied.
 */
function selectionNudge(c) {
  if (!c || typeof c !== 'object') return 0;
  let nudge = clampPmScoreAdj(c._pmScoreAdj);
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return nudge;
}

function scoreCandidate(c) {
  // Letter-score diagnostic. selectStraights does not rank on this.
  // Rank is compareByEv: stake EV from the anchored p_final at the bet
  // price. The ±0.001 uncertainty term inside qualityScore is the existing
  // tie-break and is not an SE penalty.
  // Same number the letter grade uses: calibrated edge vs no-vig sharp,
  // plus a small residual-CLV nudge. Raw EV is not this score — a +180 dog
  // inflates EV without a better close.
  // Line movement is not a score bump. It adjusts cover probability before
  // this function runs. _pmScoreAdj stays inside ±SCORE_NUDGE_CAP so it
  // cannot outrank a higher calibrated edge. Adverse sharp moves drop in
  // the gate. They are not this cap.
  const clvRaw = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  let s = qualityScore(c.edgePct, clvRaw, c.uncertainty);
  let nudge = clampPmScoreAdj(c._pmScoreAdj);
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return s + nudge;
}

/** 0.2 percentage points of edge. Inside the band, higher stake EV wins. */
const EDGE_EV_BAND = 0.002;

/**
 * Edge is the primary key. Within 0.2 percentage points, higher stake EV
 * wins. Probability is not a key.
 *
 * The only ranking difference from the edge-then-EV sort is this exact
 * edge and stake-EV tie: the capped PM nudge breaks it. Movement is already
 * inside the edge and the stake EV. The nudge cannot outrank a higher edge
 * or, inside the band, a higher EV. qualityScore stays out of the tie so
 * CLV and uncertainty do not reorder an edge tie.
 */
function compareByEdge(a, b) {
  const ea = edgeRank(a);
  const eb = edgeRank(b);
  const bothEdges = Number.isFinite(ea) && Number.isFinite(eb);
  if (bothEdges && Math.abs(ea - eb) <= EDGE_EV_BAND) {
    const evd = finiteEv(b) - finiteEv(a);
    if (Math.abs(evd) > 1e-12) return evd;
  }
  const d = eb - ea;
  if (Math.abs(d) > 1e-12) return d;
  if (bothEdges) {
    const nd = selectionNudge(b) - selectionNudge(a);
    if (Math.abs(nd) > 1e-12) return nd;
  }
  return 0;
}

function publishMinEv(c) {
  const table = (config.GATES && config.GATES.minEV) || {};
  const sport = c && c.sport;
  const n = sport && table[sport] != null ? Number(table[sport]) : Number(table.default);
  return mainMinEv(c && c.odds, n);
}

/**
 * Published floor straights. Push-aware stake EV at mainMinEv (2%),
 * the same number gateReason uses. A stale quote stays out. EV above
 * EV_CAP_ALL is ev-stale for every market. Edge is not a floor.
 */
function passesPublishFloor(c) {
  if (c && c.marginBiasExtreme) return false;
  const ev = anchoredStakeEv(c);
  const minEV = publishMinEv(c);
  if (!Number.isFinite(ev) || !(ev + 1e-12 >= minEV)) return false;
  if (stakeQuoteIsStale({ ...c, ev })) return false;
  return true;
}

/**
 * Label for the published straight card.
 * A number keeps the floor-count strings. An array of picks notes leans
 * when LEAN_PAD filled open slots.
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

/**
 * Quarter Kelly on the final p, times BANKROLL_UNITS.
 * f* = 0.25 * (p*dec - 1) / (dec - 1). Nearest 0.25u. Cap 1.5u.
 * EV <= 0 is 0. There is no 0.5u floor in this function.
 * p is conditional on no push. f* does not depend on pPush (push_ev.js).
 * The pPush argument stays so the call site does not change.
 * Not FITTED: this is the Kelly maximiser. The 0.25 step and 1.5u cap
 * are the existing stake grid.
 */
function quarterKellyUnits(p, odds, pPush = 0) {
  void pPush;
  const prob = Number(p);
  const o = Number(String(odds).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(prob) || !Number.isFinite(o) || o === 0) return 0;
  const dec = o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
  const ev = (prob * dec) - 1;
  if (!(ev > 0) || !(dec > 1)) return 0;
  const bankroll = Number(BANKROLL_UNITS);
  const br = Number.isFinite(bankroll) ? bankroll : 100;
  const raw = 0.25 * (ev / (dec - 1)) * br;
  const rounded = Math.round(raw * 4) / 4;
  const cap = Number(MAX_STRAIGHT_UNITS_PER_PICK);
  const maxU = Number.isFinite(cap) ? cap : 1.5;
  if (!(rounded > 0)) return 0;
  return Math.min(maxU, rounded);
}

/** Conditional stake EV at the bet price. The same object Kelly sizes. */
function positiveKellyEv(c) {
  const prob = Number(c && c.coverProb);
  const o = Number(String(c && c.odds).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(prob) || !Number.isFinite(o) || o === 0) return false;
  const dec = o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
  return dec > 1 && (prob * dec) - 1 > 0;
}

/**
 * Higher anchored stake EV first. That EV is push-aware EV at the bet
 * price from p_final (the posterior mean). It is not an SE-penalised score.
 * Edge is the tiebreak. The capped PM nudge breaks an exact tie.
 */
function compareByEv(a, b) {
  const evd = finiteEv(b) - finiteEv(a);
  if (Math.abs(evd) > 1e-12) return evd;
  const ed = edgeRank(b) - edgeRank(a);
  if (Math.abs(ed) > 1e-12) return ed;
  const nd = selectionNudge(b) - selectionNudge(a);
  if (Math.abs(nd) > 1e-12) return nd;
  return 0;
}

function sideKey(c) {
  return `${matchupKey(c)}||${c && c.side}`;
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

/** DraftKings posts this side. A synthetic fixture with no ladder stays eligible. */
function hasDraftKingsLine(c) {
  if (!c) return false;
  if (Array.isArray(c.bookPrices)) {
    return c.bookPrices.some((p) => isDraftKingsBook(p && (p.book || p.key)));
  }
  const book = bookToken(c.book || c.executionBook);
  if (!book) return true;
  return isDraftKingsBook(book);
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
  // A negative EV is not a lean. The last card bet Texas State -13.5 at -19.9%.
  // A hair that prints as 0.0% EV is the same pass. An edge under 1% whose
  // EV also prints under 1% is not a B. A 0% edge with a real printed EV stays.
  if (!(ev > 0)) return false;
  if (ev < 0.0005) return false;
  const edge = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  if (Number.isFinite(edge) && edge < 0.01 - 1e-12 && ev < 0.01 - 1e-12) return false;
  // EV_CAP_ALL (0.10), not the legacy GATES.maxEV 0.12. Above the cap is
  // ev-stale: never a lean, and never staked as one.
  const maxEV = Number(config.EV_CAP_ALL);
  if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return false;
  if (!hasRetailLine(c)) return false;
  if (!isPregameRow(c)) return false;
  return true;
}

/**
 * Positive-EV lean fill. Edge is not required. LEAN_PAD false leaves the
 * slot empty until the last-resort pass inside selectStraights.
 */
function qualifiesAsLean(c) {
  const ev = Number(c && c.ev);
  if (!(ev > 0)) return false;
  const cap = Number(config.EV_CAP_ALL);
  if (Number.isFinite(cap) && ev > cap + 1e-12) return false;
  return eligibleForLeanPool(c);
}

function passesLeanFill(c) {
  if (config.LEAN_PAD !== true) return false;
  return qualifiesAsLean(c);
}

/** True when the row is the 0u listing, not a bet. */
function isNoStakeRow(row) {
  if (!row) return false;
  if (row.noStake === true) return true;
  const label = String(row.label == null ? '' : row.label).trim().toLowerCase();
  const tier = String(row.tier == null ? '' : row.tier).trim().toLowerCase();
  return label === 'no stake' || tier === 'no stake';
}

/**
 * Lean stake on the 0.25u grid inside [0.25, LEAN_MAX_UNITS].
 * ASSUMED publish rule, not a fitted stake. The 0.25 step is the existing
 * quarter-Kelly grid. The ceiling is LEAN_MAX_UNITS (0.5). A raw Kelly of
 * 0.3u clamps into the band and rounds to 0.25u. Caller passes 0 only for
 * a positive-EV lean whose quarter Kelly itself rounded to 0; that still
 * prints 0.25u. EV <= 0 does not call this.
 */
function leanStakeUnits(kellyUnits) {
  const k = Number(kellyUnits);
  const base = Number.isFinite(k) && k > 0 ? k : 0;
  const cap = Number(LEAN_MAX_UNITS);
  const maxU = Number.isFinite(cap) && cap > 0 ? cap : 0.5;
  const clamped = Math.min(maxU, Math.max(0.25, base));
  return Math.round(clamped * 4) / 4;
}

function americanOdds(c) {
  const o = Number(String(c && c.odds == null ? '' : c.odds).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(o) && o !== 0 ? o : null;
}

/** Started, live, or already in progress. A missing clock is not a start. */
function gameHasStarted(c) {
  if (!c || !isPregameRow(c)) return true;
  if (c.started === true || c.gameStarted === true) return true;
  const st = String(c.status || c.gameStatus || '').trim().toLowerCase();
  if (st === 'started' || st === 'in-progress' || st === 'inprogress' || st === 'final' || st === 'live') return true;
  const reason = String(c.rejectReason || c.reason || '').trim().toLowerCase();
  return reason === 'in-progress-or-started' || reason === 'live-in-play';
}

/**
 * Short-card structure. Pregame, inside the -250/+250 band, at or under
 * EV_CAP_ALL, and a retail line (or a synthetic with no ladder).
 * A bias-margin-extreme game stays off. A reject reason other than a
 * floor or edge miss stays off, so a started game, a bad team, or a
 * stale quote cannot fill. Rows with no reject reason are fixtures.
 */
function passesShortCardStructure(c) {
  if (!c || c.marginBiasExtreme) return false;
  if (gameHasStarted(c)) return false;
  const reason = c.rejectReason || c.reason;
  if (reason) {
    const name = String(reason);
    if (name !== 'ev-floor' && name !== 'edge-floor' && name !== 'edge-floor-se' && name !== 'nonpositive-edge') {
      return false;
    }
  }
  const price = americanOdds(c);
  if (price == null) return false;
  const min = Number(config.GATES.minAmericanOdds);
  const max = Number(config.GATES.maxAmericanOdds);
  if (Number.isFinite(min) && price < min) return false;
  if (Number.isFinite(max) && price > max) return false;
  const ev = Number(c.ev);
  if (!Number.isFinite(ev)) return false;
  const cap = Number(config.EV_CAP_ALL);
  if (Number.isFinite(cap) && ev > cap + 1e-12) return false;
  if (!hasRetailLine(c)) return false;
  return true;
}

/**
 * Positive anchored EV that may fill a short card.
 * ASSUMED 2026-10-18: thin positive anchored EV is still a lean at the
 * 0.25u grid floor. The noise rule (edge under 1% and EV under 1% is
 * not a lean) does not apply on this path. Stake is leanStakeUnits.
 */
function eligibleShortCardPositive(c) {
  if (!passesShortCardStructure(c)) return false;
  return Number(c.ev) > 0;
}

/** EV <= 0 listing. Off when SHORT_CARD_NOSTAKE_FILL is false. */
function eligibleShortCardNoStake(c) {
  if (config.SHORT_CARD_NOSTAKE_FILL === false) return false;
  if (!passesShortCardStructure(c)) return false;
  return Number(c.ev) <= 0;
}

/** Empty card may say No Qualifying Plays only when no pregame lean remains. */
function shouldPublishNoPlays(picks, leanPool) {
  if (Array.isArray(picks) && picks.length > 0) return false;
  return !(leanPool || []).some((c) => eligibleForLeanPool(c));
}

function claimStraight(c, onePer, usedGames, usedSides) {
  if (usedSides.has(sideKey(c))) return false;
  if (onePer && usedGames.has(matchupKey(c))) return false;
  usedSides.add(sideKey(c));
  if (onePer) usedGames.add(matchupKey(c));
  return true;
}

/** Sharp price edge as a fraction. Missing stays null. */
function sharpEdgeFraction(c) {
  if (!c) return null;
  return parseEdgeFraction(c.edgePct != null ? c.edgePct : c.edge);
}

/** Pinnacle-fair row whose price edge clears the 1% (B) tier. */
function clearsOnePctTier(c) {
  if (!c || c.sharpFairPriced !== true) return false;
  const edge = sharpEdgeFraction(c);
  return Number.isFinite(edge) && edge + 1e-12 >= 0.01;
}

/**
 * Same-line Pinnacle pair that did not clear 1%. Ranked later by stake EV.
 * Structural rejects (no pair, point mismatch, stale, live, ev-stale) are not
 * fills. A synthetic row with no ladder stays eligible, same as a lean.
 */
function eligiblePairedFill(c) {
  if (!c || c.sharpFairPriced !== true || c.sharpFairReject) return false;
  if (clearsOnePctTier(c)) return false;
  return eligibleForLeanPool(c);
}

/**
 * Top probability-edge rows, up to MAX_STRAIGHTS. Stake EV breaks a tie.
 * ONE_STRAIGHT_PER_GAME is read at call time and defaults true.
 * When fewer than maxN clear the 2% floor and LEAN_PAD is true, open
 * slots fill from positive-EV leans. The noise rule still applies there.
 * Same-line Pinnacle pairs that missed the 1% tier fill next.
 * If the card is still short of maxN, the short-card pass ranks every
 * remaining row by anchored stake EV. Positive EV (including a thin EV
 * the noise rule would skip) is a lean. EV <= 0 is a 0u 'no stake' row
 * when SHORT_CARD_NOSTAKE_FILL is on. One game. A started game is not a
 * fill. ev-stale is not a fill.
 */
function selectStraights(yesPool, maxN = MAX_STRAIGHTS, leanPool, pairedPool, restPool) {
  const onePer = config.ONE_STRAIGHT_PER_GAME === true;
  const usedGames = new Set();
  const usedSides = new Set();
  const out = [];
  for (const c of [...(yesPool || [])].sort(compareByEv)) {
    if (out.length >= maxN) break;
    if (!passesPublishFloor(c)) continue;
    if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
    out.push({ ...c, tier: 'floor', _score: finiteEv(c) });
  }
  if (config.LEAN_PAD === true && out.length < maxN) {
    const leans = [...(leanPool || [])].sort(compareByEv);
    for (const c of leans) {
      if (out.length >= maxN) break;
      if (!passesLeanFill(c)) continue;
      if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
      out.push({ ...c, tier: 'lean', _score: finiteEv(c) });
    }
    const paired = [...(pairedPool || [])].sort(compareByEv);
    for (const c of paired) {
      if (out.length >= maxN) break;
      if (!eligiblePairedFill(c)) continue;
      if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
      out.push({
        ...c,
        tier: 'lean',
        label: 'lean',
        pairedFill: true,
        leanReason: 'paired-ev',
        _score: finiteEv(c),
      });
    }
  }
  if (out.length >= maxN) return out;
  const rest = [];
  const seen = new Set(out.map((c) => sideKey(c)));
  for (const pool of [yesPool, leanPool, pairedPool, restPool]) {
    for (const c of pool || []) {
      if (!c) continue;
      const id = sideKey(c);
      if (seen.has(id)) continue;
      seen.add(id);
      rest.push(c);
    }
  }
  rest.sort(compareByEv);
  for (const c of rest) {
    if (out.length >= maxN) break;
    if (!eligibleShortCardPositive(c)) continue;
    if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
    out.push({
      ...c,
      tier: 'lean',
      label: 'lean',
      shortCardFill: true,
      leanReason: c.leanReason || 'short-card-ev',
      _score: finiteEv(c),
    });
  }
  if (out.length >= maxN) return out;
  for (const c of rest) {
    if (out.length >= maxN) break;
    if (!eligibleShortCardNoStake(c)) continue;
    if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
    out.push({
      ...c,
      tier: 'no stake',
      label: 'no stake',
      noStake: true,
      shortCardFill: true,
      leanReason: 'no-stake',
      _score: finiteEv(c),
    });
  }
  return out;
}

/** Same order selectStraights uses. Rank is anchored stake EV, then edge. */
function orderedByScore(pool) {
  return [...(pool || [])].sort(compareByEv);
}

function parseU(u) {
  return parseFloat(String(u || '0').replace(/[^0-9.]/g, '')) || 0;
}

function fmtU(n) {
  const nu = Math.round(n * 4) / 4;
  return `${nu}u`;
}

/** Card grade B only. 'b+' / 'bplus' are not B. */
function isGradeB(rating) {
  return String(rating == null ? '' : rating).trim().toLowerCase() === 'b';
}

/**
 * Post-Kelly B-grade cap. Other grades return `units` unchanged.
 * A result is never higher than the stake passed in.
 */
function capBGradeStake(units, rating) {
  const u = typeof units === 'number' && Number.isFinite(units) ? units : parseU(units);
  if (!isGradeB(rating)) return u;
  const cap = Number(B_GRADE_UNIT_CAP);
  if (!Number.isFinite(cap) || !(u > cap)) return u;
  return cap;
}

function applyBGradeUnitCap(pick) {
  if (!pick || typeof pick !== 'object') return pick;
  const rating = pick.rating != null && String(pick.rating).trim() !== ''
    ? pick.rating
    : pick.qualityGrade;
  const u = parseU(pick.units);
  const next = capBGradeStake(u, rating);
  if (!(next < u - 1e-9)) return pick;
  return { ...pick, units: fmtU(next) };
}

function isLeanPick(p) {
  return !!(p && p.tier === 'lean');
}

/**
 * Full card (a floor straight graded A- or better) parlays 0.5u.
 * A card whose straights are all leans parlays 0.25u, even when a
 * letter is A- or better. No full grade is also 0.25u.
 */
function publishedParlayUnits(picks) {
  const rows = (picks || []).filter(Boolean);
  const leanOnly = rows.length > 0 && rows.every((p) => p.tier === 'lean');
  if (leanOnly || !cardHasFullGrade(rows)) return LEAN_PARLAY_UNITS;
  return PARLAY_FIXED_UNITS;
}

/** Lean stake is at most LEAN_MAX_UNITS. A floor pick is unchanged. */
function applyLeanUnitCap(pick) {
  if (!isLeanPick(pick)) return pick;
  const u = parseU(pick.units);
  const cap = Number(LEAN_MAX_UNITS);
  if (!Number.isFinite(cap) || !(u > cap)) return pick;
  return { ...pick, units: fmtU(cap) };
}

/**
 * True after three graded losses in a row, until a win. A push is skipped.
 * Missing grades are not a streak. The caller treats a read failure as off.
 */
function drawdownActive(results) {
  if (!Array.isArray(results) || !results.length) return false;
  let losses = 0;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const row = results[i];
    const raw = typeof row === 'string' ? row : (row && (row.result || row.outcome));
    const text = String(raw || '').trim().toLowerCase();
    if (!text || text === 'push' || text === 'void' || text === 'pending') continue;
    if (text === 'loss' || text === 'l') {
      losses += 1;
      if (losses >= 3) return true;
      continue;
    }
    if (text === 'win' || text === 'w') return false;
    return false;
  }
  return false;
}

/**
 * Printed edge and EV. The page shows the win rate to one decimal.
 * When the stored edge is that cover minus this price, print
 * shownCover − implied (52.3% at -105 is 1.1% and 2.1%). A stored edge
 * that is not cover minus the price stays as stored. Grading and stake
 * EV keep the unrounded edgeFrac / evNum caller already holds.
 */
function printedEdgeEv(c) {
  const edgeFrac = parseEdgeFraction(c && c.edgePct);
  const fullCover = Number(c && c.coverProb);
  const shownCover = Number.isFinite(fullCover)
    ? Number((fullCover * 100).toFixed(1)) / 100
    : null;
  const price = Number(c && c.odds);
  const canPrice = shownCover != null && Number.isFinite(price);
  const fullImplied = canPrice ? americanToImplied(price) : null;
  const shownDecimal = canPrice ? americanToDecimal(price) : null;
  const fullEdge = canPrice ? fullCover - fullImplied : null;
  const shownEdge = canPrice ? shownCover - fullImplied : null;
  // Half a tenth: the stored edge is this cover minus the price.
  // 1e-9 absorbs a float that lands one ulp over 0.0005 (32.8% at +220).
  const edgeFromShown = fullEdge != null && shownEdge != null
    && Number.isFinite(edgeFrac) && Math.abs(edgeFrac - fullEdge) <= 0.0005 + 1e-9;
  const displayEdge = edgeFromShown ? shownEdge : edgeFrac;
  const edgePctStr = formatEdgePct(displayEdge) || '0.0%';
  const evParsed = c && (c.ev == null || c.ev === '') ? null : Number(c && c.ev);
  const fullEv = canPrice ? (fullCover * shownDecimal) - 1 : null;
  const shownEv = canPrice ? (shownCover * shownDecimal) - 1 : null;
  // 0.0015 covers a reserve fill that reprints the one-decimal win rate
  // with the unrounded stake EV (about 0.1pp under). A stored 0 stays 0.
  // An edge that is not this cover minus the price does not snap.
  const evFromShown = edgeFromShown && fullEv != null && shownEv != null
    && Number.isFinite(evParsed) && evParsed !== 0
    && Math.abs(evParsed - fullEv) <= 0.0015;
  const evNum = evFromShown ? shownEv : (Number.isFinite(evParsed) ? evParsed : null);
  const evStr = evNum == null || !Number.isFinite(evNum) ? null : formatEdgePct(evNum);
  return { edgeFrac, edgeFromShown, displayEdge, edgePctStr, evNum, evStr };
}

function toPickObject(c, opts = {}) {
  const sharp = !!(c && c.sharpFairPriced);
  const pure = !!(c && c.pureModelPriced);
  const onBetPrice = pure || !!(c && c.edgeBasis === 'model-edge-vs-bet-price');

  // Sharp card: edge is p_fair − implied. Bet-price card: edge is p − vigged implied.
  // Letter bands are that edge alone. CLV does not move the grade.
  // Older rows keep the model edge plus the small CLV nudge.
  const printed = printedEdgeEv(c);
  const edgeFrac = printed.edgeFrac;
  const edgePctStr = printed.edgePctStr;
  const gradeOnEdge = sharp || onBetPrice;
  const qualityClv = gradeOnEdge ? null : (c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv);
  const pickQuality = qualityScore(edgeFrac, qualityClv, gradeOnEdge ? null : c.uncertainty);
  const rating = qualityToRating(edgeFrac, qualityClv, gradeOnEdge ? null : c.uncertainty);
  let tier = 'floor';
  if (c && isNoStakeRow(c)) tier = 'no stake';
  else if (c && c.tier === 'lean') tier = 'lean';
  // Quarter Kelly on the anchored p_final. The letter above is a label only.
  // ASSUMED publish rule, not a fitted stake. A positive-EV lean is
  // min(max(Kelly, 0.25u), LEAN_MAX_UNITS 0.5u) on the 0.25u grid.
  // Kelly does not raise a lean above 0.5u. A lean whose Kelly is 0
  // because EV <= 0 at the bet price is 0u and labelled 'no stake':
  // not a bet. A graded row keeps its Kelly stake. If that stake rounds
  // under 0.5u and EV is positive, the row is a lean at max(Kelly, 0.25)
  // capped at 0.5u.
  let units = quarterKellyUnits(c.coverProb, c.odds, c.pPush);
  const betPositive = positiveKellyEv(c);
  if (tier === 'no stake' || (tier === 'lean' && !betPositive)) {
    tier = 'no stake';
    units = 0;
  } else if (tier === 'lean') {
    units = leanStakeUnits(units);
  } else if (units + 1e-12 < 0.5 && betPositive) {
    tier = 'lean';
    units = leanStakeUnits(units);
  }
  const evNum = printed.evNum;
  const evStr = printed.evStr;
  const dataReviewFlag = reviewFlag(c);

  const isML = /moneyline/i.test(c.market || '');
  const pickLabel = formatMoneylinePick(c.side, c.market);
  const calibratedPct = ((c.coverProb || 0) * 100).toFixed(1);
  const modelEdge = isML
    ? `Model Win Prob: ${calibratedPct}%, Edge: ${edgePctStr}`
    : `Model p: ${calibratedPct}%, Line: ${c.line != null ? c.line : c.consensusLine}, Edge: ${edgePctStr}`;

  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
    pick: pickLabel,
    pickDisplay: pickLabel,
    betType: c.market,
    odds: c.oddsStr || formatAmerican(c.odds),
    rating,
    qualityGrade: rating,
    qualityScore: +pickQuality.toFixed(6),
    confidence: ratingToConfidence(rating),
    units: `${units}u`,
    grade: rating === 'aplus' ? 'A+' : rating === 'a' ? 'A' : rating === 'aminus' ? 'A-' : rating === 'bplus' ? 'B+' : 'B',
    edge: edgePctStr,
    riskDollars: stakeDollars(units),
    toWinDollars: toWinDollars(units, c.oddsStr || formatAmerican(c.odds)),
    ev: evStr,
    evRaw: Number.isFinite(evNum) ? evNum : null,
    edgeBasis: c.edgeBasis || (pure ? 'pure-model-edge-vs-bet-price' : 'calibrated-edge-vs-pinnacle-no-vig'),
    evBasis: c.evBasis || (pure ? 'pure-model-stake-ev' : 'stake-ev-at-best-us-price'),
    gradeBasis: c.gradeBasis || (pure ? 'pure-model-edge-vs-bet-price' : 'calibrated-edge-vs-pinnacle-no-vig'),
    edgePct: edgePctStr,
    coverProb: `${((c.coverProb || 0) * 100).toFixed(1)}%`,
    winProbability: `${((c.coverProb || 0) * 100).toFixed(1)}%`,
    coreReasoning: c.coreReasoning || '',
    whatLoses: c.whatLoses || '',
    dataVerified: c.dataVerified || '',
    clvExpectation: c.clvExpectation || '',
    modelEdge,
    commenceTime: c.commenceTime || '',
    gameTime: c.gameTime || formatGameTimeET(c.commenceTime) || null,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    source: 'omega-vnext',
    ...fairPickFields(c),
    p_cal: c.coverProb != null && Number.isFinite(Number(c.coverProb)) ? +Number(c.coverProb).toFixed(4) : null,
    modelProjection: c.betProjection != null && Number.isFinite(Number(c.betProjection))
      ? +Number(c.betProjection).toFixed(2)
      : (c.modelProjection != null && Number.isFinite(Number(c.modelProjection))
        ? +Number(c.modelProjection).toFixed(2)
        : null),
    fair_sharp_p: c.fair_sharp_p != null ? +Number(c.fair_sharp_p).toFixed(4) : null,
    predictedClv: c.predictedClv,
    modelVersion: opts.modelVersion,
    book: c.book || c.executionBook || null,
    ...(c.priceBook ? { priceBook: c.priceBook } : {}),
    ...(c.executionBook ? { executionBook: c.executionBook } : {}),
    line: c.line != null ? c.line : null,
    tier,
    label: tier === 'no stake' ? 'no stake' : (tier === 'lean' ? 'lean' : 'floor'),
    ...(tier === 'no stake' ? { noStake: true, excludeFromKpi: true } : {}),
    projMethod: c.projMethod || '',
    uncertainty: c.uncertainty,
    steamToward: !!c.steamToward,
    steamAgainst: !!c.steamAgainst,
    ...(c.movementAdjusted ? {
      movement: {
        adj: c.movementAdj != null ? c.movementAdj : 0,
        deltaP: c.movementDeltaP != null ? c.movementDeltaP : null,
        drop: !!c.movementDrop,
        missing: c.movementMissing || null,
        snapshots: c.movementSnapshots || null,
      },
    } : {}),
    predictedResidualClv: c.predictedResidualClv != null ? c.predictedResidualClv : null,
    openPrint: c.openPrint || null,
    lineMove: c.lineMove || null,
    ...(Array.isArray(c.placeableBooks) ? { placeableBooks: c.placeableBooks.slice() } : {}),
    ...(c.bestPlaceable ? { bestPlaceable: c.bestPlaceable } : {}),
    ...(c.pmFeatures && typeof c.pmFeatures === 'object' ? { pmFeatures: { ...c.pmFeatures } } : {}),
    ...footballAuditFields(c),
    ...(c.lateNews ? { lateNews: c.lateNews } : {}),
    ...(c.hrFlags && c.hrFlags.length ? { hrFlags: c.hrFlags } : {}),
    ...(c.hardRockPriced === true || c.hardRockPriced === false ? { hardRockPriced: c.hardRockPriced === true } : {}),
    ...(dataReviewFlag ? { dataReviewFlag } : {}),
    ...(pure ? { pureModelPriced: true } : {}),
  };
}

/**
 * Cap straights only (legacy). Prefer applyDailyUnitCap with parlay.
 */
function applyDailyCap(picks) {
  return applyDailyUnitCap(picks, null).picks;
}

/**
 * Unit structure:
 * - Full card (any straight graded A- or better): parlay PARLAY_FIXED_UNITS (0.5u).
 * - Lean-only card: parlay LEAN_PARLAY_UNITS (0.25u).
 * - A no-qualifying marker keeps units null.
 * - Straights combined ≤ STRAIGHT_UNIT_BUDGET (4.5u)
 * - Total ≤ DAILY_UNIT_CAP (5.0u)
 * Overage: reduce lowest-quality straights in 0.25u steps.
 * The 0.5u trim floor is the daily-cap floor from 9a9be5b. Keep it.
 * It does not raise a graded Kelly stake to 0.5u. A trim never publishes
 * a straight under 0.5u. If the budget is still over once every straight
 * is at 0.5u, drop the lowest-quality straight.
 * Stake is the Kelly unit already on the pick. Grade does not resize it.
 * Preserve quality grades.
 * Never force-fill to max.
 * Published parlay tickets are not B-capped.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => applyLeanUnitCap({ ...p }));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  // Full card parlays 0.5u. Lean-only parlays 0.25u. A "no qualifying
  // parlay" marker is not a stake.
  const parlayStake = publishedParlayUnits(out);
  for (const pl of parlays) {
    if (pl && (pl.qualifying === false || pl.status === 'no qualifying parlay' || pl.type === 'no-qualifying-parlay')) {
      pl.units = null;
      continue;
    }
    // A fair-negative parlay is a lean at LEAN_PARLAY_UNITS (0.25u, the
    // existing minimum). The full-card stake does not raise it.
    const fairLean = pl && pl.isLean === true;
    const leanParlay = Number(LEAN_PARLAY_UNITS);
    const stakeU = fairLean && Number.isFinite(leanParlay) ? leanParlay : parlayStake;
    pl.units = fmtU(stakeU);
    pl.riskDollars = stakeDollars(stakeU);
    if (pl.combinedOdds) pl.toWinDollars = toWinDollars(stakeU, pl.combinedOdds);
    // Lazy require: parlay.js loads select.js at module scope.
    const staleLabel = (value) => !value || value === 'assumes independent legs';
    if (staleLabel(pl.evLabel) || staleLabel(pl.correlationNote)) {
      const { parlayEvLabel } = require('./parlay');
      const label = parlayEvLabel(pl);
      if (label) {
        if (staleLabel(pl.evLabel)) pl.evLabel = label;
        if (staleLabel(pl.correlationNote)) pl.correlationNote = pl.evLabel;
      }
    }
  }

  // A 'no stake' row is 0u. parseU('0u') is 0, so it does not spend the budget.
  const straightTotalOf = () => out.reduce((acc, p) => acc + parseU(p.units), 0);
  const parlayTotalOf = () => parlays.reduce((acc, pl) => acc + parseU(pl.units), 0);
  const totalOf = () => straightTotalOf() + parlayTotalOf();

  const reduceStraightsTo = (budget) => {
    let st = straightTotalOf();
    while (st > budget + 1e-9 && out.length) {
      const order = out
        .map((_, i) => i)
        .sort((a, b) => {
          const ra = ratingRank(out[a].rating);
          const rb = ratingRank(out[b].rating);
          if (ra !== rb) return rb - ra; // lowest grade first
          const qa = pickQualityScore(out[a]);
          const qb = pickQualityScore(out[b]);
          if (Math.abs(qa - qb) > 1e-12) return qa - qb;
          return parseU(out[a].units) - parseU(out[b].units);
        });
      let reduced = false;
      for (const idx of order) {
        const u = parseU(out[idx].units);
        if (u > 0.5 + 1e-9) {
          // Daily-cap floor 0.5u (9a9be5b). Do not trim a published straight under it.
          const nu = Math.max(0.5, Math.round((u - 0.25) * 4) / 4);
          out[idx].units = fmtU(nu);
          // Rating/confidence describe quality, not stake size. Never downgrade on trim.
          st = straightTotalOf();
          reduced = true;
          break;
        }
      }
      if (!reduced) {
        out.splice(order[0], 1);
        st = straightTotalOf();
      }
    }
  };

  // 1) Straights ≤ 3.5u
  reduceStraightsTo(STRAIGHT_UNIT_BUDGET);

  // 2) Total ≤ 4.0u (parlay fixed — only straights can absorb remaining overage)
  const maxStraightsForTotal = Math.max(0, DAILY_UNIT_CAP - parlayTotalOf());
  const finalStraightBudget = Math.min(STRAIGHT_UNIT_BUDGET, maxStraightsForTotal);
  reduceStraightsTo(finalStraightBudget);

  // Stake is the Kelly unit already on the pick. Grade does not resize it.
  // Same-game exposure still trims a straight. The parlay stake is not cut.
  out = capSameGameExposure(out, parlays);
  out = sortByGradeThenUnits(out);
  // v12.3.25: parlay legs copy the capped straights' units.
  const legKey = (x) => [x.game || x.matchup || '', x.pick || x.selection || '', x.market || ''].join('|');
  const capped = new Map(out.map(p => [legKey(p), p.units]));
  for (const pl of parlays) {
    for (const leg of pl.legs || []) {
      const u = capped.get(legKey(leg));
      if (u != null) leg.units = u;
    }
  }
  return { picks: out, parlayLegs: parlays };
}

function usableGameKey(c) {
  const key = matchupKey(c);
  if (!key || key === 'undefined @ undefined') return '';
  return key;
}

function isVoidPregame(p) {
  return !!(p && p.status === 'void-pregame');
}

/**
 * Straight units plus the full parlay stake on the same game, capped at
 * GAME_EXPOSURE_CAP (2.0u). The parlay is never cut. Steps are 0.25u,
 * floor 0.5u. A lean is not trimmed. OMEGA_GAME_EXPOSURE=0 turns this off.
 * A void-pregame leg is not stake at risk, so it does not count. A
 * void-pregame straight is left unchanged. Late-news removes a dropped
 * straight before enforceOmegaDailyUnitCap reruns this on the surviving card.
 */
function capSameGameExposure(picks, parlays) {
  if (!PER_GAME_EXPOSURE_CAP_ENABLED) return picks;
  if (!gameExposureEnabled()) return picks;
  const onGame = new Map();
  for (const pl of parlays || []) {
    const stake = parseU(pl.units);
    if (!(stake > 0)) continue;
    const seen = new Set();
    for (const leg of pl.legs || []) {
      if (isVoidPregame(leg)) continue;
      const key = usableGameKey(leg);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      onGame.set(key, (onGame.get(key) || 0) + stake);
    }
  }
  if (!onGame.size) return picks;
  return (picks || []).map((p) => {
    if (isVoidPregame(p) || isLeanPick(p)) return p;
    const extra = onGame.get(usableGameKey(p)) || 0;
    if (!(extra > 0)) return p;
    const u = parseU(p.units);
    const room = GAME_EXPOSURE_CAP - extra;
    if (u <= room + 1e-9) return p;
    let next = u;
    while (next > room + 1e-9 && next > 0.5 + 1e-9) {
      next = Math.max(0.5, Math.round((next - 0.25) * 4) / 4);
    }
    if (!(next < u - 1e-9)) return p;
    return { ...p, units: fmtU(next) };
  });
}

module.exports = {
  quarterKellyUnits,
  edgeRank,
  compareByEdge,
  compareByEv,
  EDGE_EV_BAND,
  scoreCandidate,
  passesPublishFloor,
  eligibleForLeanPool,
  hasRetailLine,
  drawdownActive,
  qualifiesAsLean,
  passesLeanFill,
  eligiblePairedFill,
  isNoStakeRow,
  leanStakeUnits,
  passesShortCardStructure,
  eligibleShortCardPositive,
  eligibleShortCardNoStake,
  clearsOnePctTier,
  shouldPublishNoPlays,
  straightCardLabel,
  selectStraights,
  orderedByScore,
  toPickObject,
  printedEdgeEv,
  applyDailyCap,
  applyDailyUnitCap,
  publishedParlayUnits,
  capSameGameExposure,
  matchupKey,
  formatMoneylinePick,
  sortByGradeThenUnits,
};
