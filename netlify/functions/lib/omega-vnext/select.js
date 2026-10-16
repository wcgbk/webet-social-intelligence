'use strict';

const config = require('./config');
const {
  MAX_STRAIGHTS,
  DAILY_UNIT_CAP, STRAIGHT_UNIT_BUDGET, PARLAY_FIXED_UNITS,
  MAX_STRAIGHT_UNITS_PER_PICK, B_GRADE_UNIT_CAP, LEAN_MAX_UNITS, LEAN_MIN_EDGE,
  LEAN_PARLAY_UNITS, PM_SOFT,
  PER_GAME_EXPOSURE_CAP_ENABLED,
} = config;
const {
  ratingToConfidence, formatAmerican, americanToImplied, americanToDecimal,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
  parseEdgeFraction, qualityScore, qualityToRating, pickQualityScore,
  gradeStakeUnits, cardHasFullGrade, formatGameTimeET, stakeDollars, toWinDollars,
} = require('./odds_math');
const { minEdgeFor, mainMinEv, stakeQuoteIsStale } = require('./edge_floor');
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
  // Same number the letter grade uses: calibrated edge vs no-vig sharp,
  // plus a small residual-CLV nudge. Raw EV is not the rank — a +180 dog
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
 * Published floor straights. Flat stake EV at mainMinEv (2%). A stale
 * quote stays out. A -110 spread whose edge is 6% to 12% is not stale
 * just because that edge is more than 12% EV.
 */
function passesPublishFloor(c) {
  if (c && c.marginBiasExtreme) return false;
  const ev = Number(c && c.ev);
  const minEV = publishMinEv(c);
  if (!Number.isFinite(ev) || !(ev + 1e-12 >= minEV)) return false;
  if (stakeQuoteIsStale(c)) return false;
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

/** Higher stake EV first. An exact EV tie uses edge. */
/**
 * Quarter Kelly on the calibrated p, as a fraction of a 100u bankroll,
 * rounded to 0.25u, floor 0.25u, cap 1u.
 */
function quarterKellyUnits(p, odds) {
  const prob = Number(p);
  const o = Number(String(odds).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(prob) || !Number.isFinite(o) || o === 0) return 0.25;
  const b = o > 0 ? o / 100 : 100 / Math.abs(o);
  const f = (prob * (b + 1) - 1) / b;
  const u = Math.round((f / 4) * 100 * 4) / 4;
  return Math.min(1, Math.max(0.25, u));
}

function compareByEv(a, b) {
  // Probability edge is the rank. Stake EV breaks a tie inside 0.2
  // percentage points (compareByEdge) and any exact-edge tie left over.
  // A plus-money price must not outrank a higher edge.
  const e = compareByEdge(a, b);
  if (e !== 0) return e;
  return finiteEv(b) - finiteEv(a);
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
  const maxEV = Number(config.GATES && config.GATES.maxEV);
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
  return eligibleForLeanPool(c);
}

function passesLeanFill(c) {
  if (config.LEAN_PAD !== true) return false;
  return qualifiesAsLean(c);
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
 * slots fill from positive-EV leans. A non-positive EV stays off the card.
 * If the card is still short of 3, the open slots fill from same-line
 * Pinnacle pairs that missed the 1% tier, ranked by EV vs Pinnacle.
 * One game. A lean is tier 'lean' and the paired fill is flat
 * LEAN_MAX_UNITS. ev-stale is not a fill.
 */
function selectStraights(yesPool, maxN = MAX_STRAIGHTS, leanPool, pairedPool) {
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
  if (config.LEAN_PAD !== true || out.length >= maxN) return out;
  const leans = [...(leanPool || [])].sort(compareByEv);
  for (const c of leans) {
    if (out.length >= maxN) break;
    if (!passesLeanFill(c)) continue;
    if (!claimStraight(c, onePer, usedGames, usedSides)) continue;
    out.push({ ...c, tier: 'lean', _score: finiteEv(c) });
  }
  if (out.length >= maxN) return out;
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
  return out;
}

/** Same order selectStraights uses. Rank follows probability edge, then stake EV. */
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

function toPickObject(c, opts = {}) {
  const sharp = !!(c && c.sharpFairPriced);
  const pure = !!(c && c.pureModelPriced);

  // Sharp card: edge is p_fair − implied. Pure model: edge is p_model − implied.
  // Letter bands are that edge alone. CLV does not move the grade.
  // Older rows keep the model edge plus the small CLV nudge.
  const edgeFrac = parseEdgeFraction(c.edgePct);
  // The page prints the win rate to one decimal. When the stored edge or EV
  // is that same probability at this price, print the one-decimal version.
  // 52.3% at -105 is 1.1% and 2.1%. A stored edge that is not cover minus
  // the price stays as stored.
  const fullCover = Number(c.coverProb);
  const shownCover = Number.isFinite(fullCover)
    ? Number((fullCover * 100).toFixed(1)) / 100
    : null;
  const price = Number(c.odds);
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
  const gradeOnEdge = sharp || pure;
  const qualityClv = gradeOnEdge ? null : (c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv);
  const pickQuality = qualityScore(edgeFrac, qualityClv, gradeOnEdge ? null : c.uncertainty);
  const rating = qualityToRating(edgeFrac, qualityClv, gradeOnEdge ? null : c.uncertainty);
  const tier = c && c.tier === 'lean' ? 'lean' : 'floor';
  // Flat stake by grade. Kelly rounding, the cover cap, and drawdown do not
  // override it. B and every lean stay at 0.5u. The B cap never raises.
  let units;
  if (config.marketAnchorOn()) {
    units = quarterKellyUnits(c.coverProb, c.odds);
  } else {
    units = gradeStakeUnits(rating, tier);
    units = capBGradeStake(units, rating);
    if (tier === 'lean') units = Number(LEAN_MAX_UNITS);
  }
  const evParsed = c.ev == null || c.ev === '' ? null : Number(c.ev);
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
    p_model: c.p_model != null ? +Number(c.p_model).toFixed(4) : null,
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
    label: tier === 'lean' ? 'lean' : 'floor',
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
 * Overage: reduce lowest-quality straights in 0.25u steps (floor 0.25u).
 * Grade B straights are capped at B_GRADE_UNIT_CAP before that trim.
 * A lean is capped at LEAN_MAX_UNITS (0.5u) before that trim. The grade
 * hierarchy may lift a floor stake. It does not lift a lean, and it does
 * not trim a floor stake down to the lean. Preserve quality grades.
 * Never force-fill to max.
 * Published parlay tickets are not B-capped.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => applyLeanUnitCap(applyBGradeUnitCap({ ...p })));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  // Full card parlays 0.5u. Lean-only parlays 0.25u. A "no qualifying
  // parlay" marker is not a stake.
  const parlayStake = cardHasFullGrade(out) ? PARLAY_FIXED_UNITS : LEAN_PARLAY_UNITS;
  for (const pl of parlays) {
    if (pl && (pl.qualifying === false || pl.status === 'no qualifying parlay' || pl.type === 'no-qualifying-parlay')) {
      pl.units = null;
      continue;
    }
    pl.units = fmtU(parlayStake);
    pl.riskDollars = stakeDollars(parlayStake);
    if (pl.combinedOdds) pl.toWinDollars = toWinDollars(parlayStake, pl.combinedOdds);
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
        if (u > 0.25) {
          const nu = Math.max(0.25, Math.round((u - 0.25) * 4) / 4);
          out[idx].units = fmtU(nu);
          // Rating/confidence describe quality, not stake size. Never downgrade on trim.
          st = straightTotalOf();
          reduced = true;
          break;
        }
      }
      if (!reduced) break;
    }
  };

  // 1) Straights ≤ 3.5u
  reduceStraightsTo(STRAIGHT_UNIT_BUDGET);

  // 2) Total ≤ 4.0u (parlay fixed — only straights can absorb remaining overage)
  const maxStraightsForTotal = Math.max(0, DAILY_UNIT_CAP - parlayTotalOf());
  const finalStraightBudget = Math.min(STRAIGHT_UNIT_BUDGET, maxStraightsForTotal);
  reduceStraightsTo(finalStraightBudget);

  // A higher quality grade must never carry less stake than a lower one. Use any
  // remaining budget to lift the better pick first; if that cannot fully resolve
  // the inversion, trim the lower-grade pick. Grades themselves never change.
  let straightTotal = straightTotalOf();
  const ordered = out.map((_, i) => i).sort((a, b) => {
    const rankDelta = ratingRank(out[a].rating) - ratingRank(out[b].rating);
    if (rankDelta) return rankDelta;
    return pickQualityScore(out[b]) - pickQualityScore(out[a]);
  });
  for (let hiPos = 0; hiPos < ordered.length; hiPos++) {
    for (let loPos = hiPos + 1; loPos < ordered.length; loPos++) {
      const hi = out[ordered[hiPos]];
      const lo = out[ordered[loPos]];
      if (ratingRank(hi.rating) >= ratingRank(lo.rating)) continue;
      let hiUnits = parseU(hi.units);
      let loUnits = parseU(lo.units);
      if (hiUnits >= loUnits) continue;
      // A B is already at or under the post-Kelly cap. Do not lift it.
      if (isGradeB(hi.rating || hi.qualityGrade)) continue;
      // A lean stays at or under 0.5u. Do not lift it, and do not trim the
      // lower-grade floor down to the lean.
      if (isLeanPick(hi)) continue;

      const headroom = Math.max(0, finalStraightBudget - straightTotal);
      const lift = Math.floor(Math.min(loUnits - hiUnits, headroom, Math.max(0, MAX_STRAIGHT_UNITS_PER_PICK - hiUnits)) * 4 + 1e-9) / 4;
      if (lift > 0) {
        hiUnits += lift;
        hi.units = fmtU(hiUnits);
        straightTotal += lift;
      }
      if (hiUnits < loUnits) {
        lo.units = fmtU(hiUnits);
        straightTotal -= (loUnits - hiUnits);
      }
    }
  }

  // Hierarchy trims can only lower a B. Re-apply so a lift cannot undo the cap.
  out = out.map(applyBGradeUnitCap);
  // A parlay leg puts the whole ticket at risk on that game. Trim the straight
  // after the hierarchy lift so the lift cannot put the game back over the cap.
  out = capSameGameExposure(out, parlays);
  out = out.map(applyLeanUnitCap);
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
 * GAME_EXPOSURE_CAP (1.75u). The parlay is never cut. Steps are 0.25u,
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
  clearsOnePctTier,
  shouldPublishNoPlays,
  straightCardLabel,
  selectStraights,
  orderedByScore,
  toPickObject,
  applyDailyCap,
  applyDailyUnitCap,
  capSameGameExposure,
  matchupKey,
  formatMoneylinePick,
  sortByGradeThenUnits,
};
