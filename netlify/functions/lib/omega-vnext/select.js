'use strict';

const config = require('./config');
const {
  SELECT_WEIGHTS, MAX_STRAIGHTS, KELLY_FRACTION,
  DAILY_UNIT_CAP, STRAIGHT_UNIT_BUDGET, PARLAY_FIXED_UNITS,
  MAX_STRAIGHT_UNITS_PER_PICK, B_GRADE_UNIT_CAP, LEAN_MAX_UNITS, LEAN_MIN_EDGE,
  LEAN_PARLAY_UNITS, PM_SOFT,
  PER_GAME_EXPOSURE_CAP_ENABLED,
} = config;
const {
  kellyToUnits, ratingToConfidence, formatAmerican,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
  parseEdgeFraction, qualityScore, qualityToRating, pickQualityScore,
} = require('./odds_math');
const { minEdgeFor } = require('./edge_floor');
const { footballAuditFields } = require('./sports/_common');
const { pushAwareKelly } = require('./push_ev');
const { gameExposureEnabled, GAME_EXPOSURE_CAP } = require('./gaps_flags');
const { reviewFlag } = require('./pinnacle_flag');

function matchupKey(c) {
  const name = String((c && (c.matchup || `${c.awayTeam} @ ${c.homeTeam}`)) || '').toLowerCase().trim();
  const when = (c && (c.commenceTime || c.commence_time)) || '';
  // Doubleheader halves are different games. An empty commence stays
  // name-only so two undated legs of one matchup still conflict.
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

/** Steam, PM, and steamToward together. Tie-break only. Cannot outrank edge. */
const SCORE_NUDGE_CAP = 0.002;

/** Calibrated edge vs no-vig fair. Missing edge sorts last. */
function edgeRank(c) {
  const e = parseEdgeFraction(c && c.edgePct);
  return Number.isFinite(e) ? e : -Infinity;
}

function scoreCandidate(c) {
  const w = SELECT_WEIGHTS;
  const ev = c.ev || 0;
  // Same number the letter grade uses: calibrated edge vs no-vig sharp,
  // plus a small residual-CLV nudge. Raw EV is not the rank — a +180 dog
  // inflates EV without a better close.
  // _steamScoreAdj, _pmScoreAdj, and the steamToward softSportMixBonus are
  // score-only. Their sum is capped at ±SCORE_NUDGE_CAP so a 0.03 steam
  // boost plus the 0.02 mix bonus cannot outrank a higher calibrated edge.
  // Adverse-steam hard rejects stay in line_path and are not this cap.
  const clvRaw = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  let s = qualityScore(c.edgePct, clvRaw, c.uncertainty);
  let nudge = 0;
  if (typeof c._steamScoreAdj === 'number' && Number.isFinite(c._steamScoreAdj)) nudge += c._steamScoreAdj;
  nudge += clampPmScoreAdj(c._pmScoreAdj);
  if (c.steamToward && ev > 0) nudge += (w.softSportMixBonus || 0.02);
  // DK lagging the sharp line is a pre-lock selection input. It stays
  // inside the nudge cap and is not added to fair_sharp_p or EV.
  if (c.dkLagsSharp === true && ev > 0) nudge += 0.001;
  if (nudge > SCORE_NUDGE_CAP) nudge = SCORE_NUDGE_CAP;
  else if (nudge < -SCORE_NUDGE_CAP) nudge = -SCORE_NUDGE_CAP;
  return s + nudge;
}

/** 0.2 percentage points of edge. Inside the band, higher stake EV wins. */
const EDGE_EV_BAND = 0.002;

/**
 * Edge is the primary key. Within 0.2 percentage points, higher stake EV
 * wins. Probability is not a key. An exact edge and EV tie keeps sort order.
 */
function compareByEdge(a, b) {
  const ea = edgeRank(a);
  const eb = edgeRank(b);
  if (Number.isFinite(ea) && Number.isFinite(eb) && Math.abs(ea - eb) <= EDGE_EV_BAND) {
    const evd = finiteEv(b) - finiteEv(a);
    if (Math.abs(evd) > 1e-12) return evd;
  }
  const d = eb - ea;
  if (Math.abs(d) > 1e-12) return d;
  return 0;
}

function publishMinEv(c) {
  const table = (config.GATES && config.GATES.minEV) || {};
  const sport = c && c.sport;
  const n = sport && table[sport] != null ? Number(table[sport]) : Number(table.default);
  return Number.isFinite(n) ? n : 0.03;
}

/**
 * Published floor straights. Stake EV at the sport floor (3%) and edge
 * at or above minEdgeFor. A lean does not pass. Missing edge does not pass.
 */
function passesPublishFloor(c) {
  const ev = Number(c && c.ev);
  const minEV = publishMinEv(c);
  if (!(ev + 1e-12 >= minEV)) return false;
  const edge = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  if (!Number.isFinite(edge) || !(edge > 0)) return false;
  const need = minEdgeFor(c && c.odds, c && c.uncertainty);
  return edge + 1e-12 >= need;
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

/** Higher stake EV first. An EV tie uses the edge band. Positive EV is required to fill. */
function compareByEv(a, b) {
  const d = finiteEv(b) - finiteEv(a);
  if (Math.abs(d) > 1e-12) return d;
  return compareByEdge(a, b);
}

function sideKey(c) {
  return `${matchupKey(c)}||${c && c.side}`;
}

/** DraftKings posts this side. A synthetic fixture with no ladder stays eligible. */
function hasDraftKingsLine(c) {
  if (!c) return false;
  if (Array.isArray(c.bookPrices)) {
    return c.bookPrices.some((p) => {
      const book = String((p && (p.book || p.key)) || '').trim().toLowerCase();
      return book === 'draftkings' || book === 'draftkings_us';
    });
  }
  const book = String((c.book || c.executionBook) || '').trim().toLowerCase();
  if (!book) return true;
  return book === 'draftkings' || book === 'draftkings_us';
}

/** Live and in-play are not pregame. A missing clock is not a start. */
function isPregameRow(c) {
  if (!c) return false;
  if (c.inPlay === true || c.live === true || c.in_play === true) return false;
  const st = String(c.priceState || c.marketStatus || '').trim().toLowerCase();
  return st !== 'live' && st !== 'in-play' && st !== 'inplay';
}

/**
 * Lean fill. Stake EV > 0 after vig, edge >= LEAN_MIN_EDGE vs the no-vig
 * sharp, a DraftKings line, and pregame. LEAN_PAD false leaves the slot empty.
 */
function qualifiesAsLean(c) {
  const ev = Number(c && c.ev);
  if (!(ev > 0)) return false;
  const edge = parseEdgeFraction(c && (c.edgePct != null ? c.edgePct : c.edge));
  if (!Number.isFinite(edge) || edge + 1e-12 < LEAN_MIN_EDGE) return false;
  if (!hasDraftKingsLine(c)) return false;
  if (!isPregameRow(c)) return false;
  return true;
}

function passesLeanFill(c) {
  if (config.LEAN_PAD !== true) return false;
  return qualifiesAsLean(c);
}

/** Empty card may say No Qualifying Plays only when no publishable lean remains. */
function shouldPublishNoPlays(picks, leanPool) {
  if (Array.isArray(picks) && picks.length > 0) return false;
  return !(leanPool || []).some((c) => qualifiesAsLean(c));
}

/**
 * Top floor edges, up to MAX_STRAIGHTS.
 * ONE_STRAIGHT_PER_GAME is read at call time and defaults true. A game
 * already taken is skipped and the next distinct game fills the slot.
 * Set the flag false and a second side of the same game is a straight
 * when its edge is in the top N.
 * When fewer than maxN clear the floor and LEAN_PAD is true, the open
 * slots fill from positive-EV leans sorted by EV. One straight per game still
 * applies, and a game that already holds a straight is skipped. A lean
 * is tier 'lean' and the stake is flat LEAN_MAX_UNITS. The card still
 * publishes when the lean pool cannot fill the rest.
 */
function selectStraights(yesPool, maxN = MAX_STRAIGHTS, leanPool) {
  const onePer = config.ONE_STRAIGHT_PER_GAME === true;
  const usedGames = new Set();
  const usedSides = new Set();
  const floor = [];
  for (const c of [...(yesPool || [])].sort(compareByEdge)) {
    if (floor.length >= maxN) break;
    if (!passesPublishFloor(c)) continue;
    if (usedSides.has(sideKey(c))) continue;
    if (onePer && usedGames.has(matchupKey(c))) continue;
    floor.push({
      ...c,
      tier: 'floor',
      _score: edgeRank(c),
    });
    usedSides.add(sideKey(c));
    if (onePer) usedGames.add(matchupKey(c));
  }
  if (config.LEAN_PAD !== true || floor.length >= maxN) return floor;
  const leans = [];
  for (const c of [...(leanPool || [])].sort(compareByEv)) {
    if (floor.length + leans.length >= maxN) break;
    if (!passesLeanFill(c)) continue;
    if (usedSides.has(sideKey(c))) continue;
    if (onePer && usedGames.has(matchupKey(c))) continue;
    leans.push({
      ...c,
      tier: 'lean',
      _score: finiteEv(c),
    });
    usedSides.add(sideKey(c));
    if (onePer) usedGames.add(matchupKey(c));
  }
  return floor.concat(leans);
}

/** Same order selectStraights uses. Candidate-table rank follows this, not pool insertion. */
function orderedByScore(pool) {
  return [...(pool || [])].sort(compareByEdge);
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

function toPickObject(c, opts = {}) {
  const kFrac = pushAwareKelly(c.coverProb, c.odds, KELLY_FRACTION, c && c.pPush);
  const perPickCap = opts.perPickCap != null ? opts.perPickCap : MAX_STRAIGHT_UNITS_PER_PICK;
  let units = kellyToUnits(kFrac, perPickCap);
  if (opts.drawdown) units = Math.max(0.5, units * 0.75);

  // Honest Edge badge = model edge after shrink vs no-vig sharp (fraction on c.edgePct).
  // Fallback: coverProb - book implied. Never predictedClv cents / raw coverProb.
  const edgeFrac = parseEdgeFraction(c.edgePct);
  const edgePctStr = formatEdgePct(edgeFrac) || '0.0%';
  const qualityClv = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  const pickQuality = qualityScore(edgeFrac, qualityClv, c.uncertainty);
  const rating = qualityToRating(edgeFrac, qualityClv, c.uncertainty);
  // Kelly (and drawdown) already ran. Grade stays the edge letter.
  // B (edge under 2%) cannot keep a full Kelly unit. Never raises.
  units = capBGradeStake(units, rating);
  const tier = c && c.tier === 'lean' ? 'lean' : 'floor';
  // Flat lean stake. Kelly and the grade cap do not move it. The daily
  // cap may trim later. It must not raise the lean above this.
  if (tier === 'lean') units = Number(LEAN_MAX_UNITS);
  const evStr = formatEdgePct(c.ev) || edgePctStr;
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
    ev: evStr,
    evRaw: c.ev != null ? c.ev : edgeFrac,
    edgePct: edgePctStr,
    coverProb: `${((c.coverProb || 0) * 100).toFixed(0)}%`,
    winProbability: `${((c.coverProb || 0) * 100).toFixed(0)}%`,
    coreReasoning: c.coreReasoning || '',
    whatLoses: c.whatLoses || '',
    dataVerified: c.dataVerified || '',
    clvExpectation: c.clvExpectation || '',
    modelEdge,
    commenceTime: c.commenceTime || '',
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    source: 'omega-vnext',
    p_model: c.p_model != null ? +Number(c.p_model).toFixed(4) : null,
    p_cal: c.coverProb != null && Number.isFinite(Number(c.coverProb)) ? +Number(c.coverProb).toFixed(4) : null,
    modelProjection: c.modelProjection != null && Number.isFinite(Number(c.modelProjection))
      ? +Number(c.modelProjection).toFixed(2)
      : null,
    fair_sharp_p: c.fair_sharp_p != null ? +Number(c.fair_sharp_p).toFixed(4) : null,
    predictedClv: c.predictedClv,
    modelVersion: opts.modelVersion,
    book: c.book || c.executionBook || null,
    line: c.line != null ? c.line : null,
    tier,
    projMethod: c.projMethod || '',
    uncertainty: c.uncertainty,
    steamToward: !!c.steamToward,
    steamAgainst: !!c.steamAgainst,
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
  };
}

/**
 * Cap straights only (legacy). Prefer applyDailyUnitCap with parlay.
 */
function applyDailyCap(picks) {
  return applyDailyUnitCap(picks, null).picks;
}

/**
 * Unit structure (v12.0.9):
 * - Parlay fixed at PARLAY_FIXED_UNITS (0.5u) when present — never scaled
 * - Straights combined ≤ STRAIGHT_UNIT_BUDGET (3.5u)
 * - Total ≤ DAILY_UNIT_CAP (4.0u)
 * Overage: reduce lowest-quality straights in 0.25u steps (floor 0.25u).
 * Grade B straights are capped at B_GRADE_UNIT_CAP before that trim.
 * A lean is capped at LEAN_MAX_UNITS (0.5u) before that trim. The grade
 * hierarchy may lift a floor stake. It does not lift a lean, and it does
 * not trim a floor stake down to the lean. Preserve quality grades.
 * Never force-fill to max.
 * Parlay tickets stay PARLAY_FIXED_UNITS and are not B-capped.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => applyLeanUnitCap(applyBGradeUnitCap({ ...p })));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  // Floor-day parlays stay 0.5u. A lean-day ticket is already 0.25u.
  // Never raise it.
  for (const pl of parlays) {
    if (pl && pl.leanDay === true) {
      const u = parseU(pl.units);
      const cap = Number(LEAN_PARLAY_UNITS);
      const next = Number.isFinite(u) && u > 0 && u < cap ? u : cap;
      pl.units = fmtU(next);
      continue;
    }
    pl.units = fmtU(PARLAY_FIXED_UNITS);
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
 * GAME_EXPOSURE_CAP. The parlay is never cut. Steps are 0.25u, floor 0.25u.
 * PER_GAME_EXPOSURE_CAP_ENABLED is false, so this trim does not run.
 * OMEGA_GAME_EXPOSURE cannot turn it on.
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
    if (isVoidPregame(p)) return p;
    const extra = onGame.get(usableGameKey(p)) || 0;
    if (!(extra > 0)) return p;
    const u = parseU(p.units);
    const room = GAME_EXPOSURE_CAP - extra;
    if (u <= room + 1e-9) return p;
    let next = u;
    while (next > room + 1e-9 && next > 0.25 + 1e-9) {
      next = Math.max(0.25, Math.round((next - 0.25) * 4) / 4);
    }
    if (!(next < u - 1e-9)) return p;
    return { ...p, units: fmtU(next) };
  });
}

module.exports = {
  edgeRank,
  compareByEdge,
  EDGE_EV_BAND,
  scoreCandidate,
  passesPublishFloor,
  qualifiesAsLean,
  passesLeanFill,
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
