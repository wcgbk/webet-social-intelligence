'use strict';

const {
  SELECT_WEIGHTS, MAX_STRAIGHTS, KELLY_FRACTION,
  DAILY_UNIT_CAP, STRAIGHT_UNIT_BUDGET, PARLAY_FIXED_UNITS,
  MAX_STRAIGHT_UNITS_PER_PICK, PM_SOFT,
} = require('./config');
const {
  kellyFraction, kellyToUnits, ratingToConfidence, formatAmerican,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
  parseEdgeFraction, qualityScore, qualityToRating, pickQualityScore,
} = require('./odds_math');

function matchupKey(c) {
  return String(c.matchup || `${c.awayTeam} @ ${c.homeTeam}`).toLowerCase().trim();
}

function clampPmScoreAdj(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const cap = Math.abs(Number(PM_SOFT && PM_SOFT.maxAbsScoreAdj));
  if (!Number.isFinite(cap)) return 0;
  if (v > cap) return cap;
  if (v < -cap) return -cap;
  return v;
}

function scoreCandidate(c, selectedSports) {
  const w = SELECT_WEIGHTS;
  const ev = c.ev || 0;
  // Same number the letter grade uses: calibrated edge vs no-vig sharp,
  // plus a small residual-CLV nudge. Raw EV is not the rank — a +180 dog
  // inflates EV without a better close. Steam and PM stay score-only.
  const clvRaw = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  let s = qualityScore(c.edgePct, clvRaw, c.uncertainty);
  if (typeof c._steamScoreAdj === 'number') s += c._steamScoreAdj;
  s += clampPmScoreAdj(c._pmScoreAdj);
  if (c.steamToward && ev > 0) s += (w.softSportMixBonus || 0.02);
  if (selectedSports && selectedSports.size && !selectedSports.has(c.sport)) {
    s += w.softSportMixBonus;
  }
  return s;
}

/**
 * Greedy diversify: ≤1 per game, up to MAX_STRAIGHTS.
 * When the pool has at least maxN distinct games, the result length is maxN.
 * A shorter pool stays short. Never pads with leans.
 */
function selectStraights(yesPool, maxN = MAX_STRAIGHTS) {
  const pool = [...(yesPool || [])].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const picked = [];
  const usedGames = new Set();
  const sports = new Set();

  for (const c of pool) {
    if (picked.length >= maxN) break;
    const g = matchupKey(c);
    if (usedGames.has(g)) continue;
    const scored = { ...c, _score: scoreCandidate(c, sports) };
    picked.push(scored);
    usedGames.add(g);
    sports.add(c.sport);
  }

  picked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return picked;
}

/** Same order selectStraights uses. Candidate-table rank follows this, not pool insertion. */
function orderedByScore(pool) {
  return [...(pool || [])].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

function parseU(u) {
  return parseFloat(String(u || '0').replace(/[^0-9.]/g, '')) || 0;
}

function fmtU(n) {
  const nu = Math.round(n * 4) / 4;
  return `${nu}u`;
}

function toPickObject(c, opts = {}) {
  const kFrac = kellyFraction(c.coverProb, c.odds, KELLY_FRACTION);
  const perPickCap = opts.perPickCap != null ? opts.perPickCap : MAX_STRAIGHT_UNITS_PER_PICK;
  let units = kellyToUnits(kFrac, perPickCap);
  if (opts.drawdown) units = Math.max(0.25, units * 0.75);

  // Honest Edge badge = model edge after shrink vs no-vig sharp (fraction on c.edgePct).
  // Fallback: coverProb - book implied. Never predictedClv cents / raw coverProb.
  const edgeFrac = parseEdgeFraction(c.edgePct);
  const edgePctStr = formatEdgePct(edgeFrac) || '0.0%';
  const qualityClv = c.predictedResidualClv != null ? c.predictedResidualClv : c.predictedClv;
  const pickQuality = qualityScore(edgeFrac, qualityClv, c.uncertainty);
  const rating = qualityToRating(edgeFrac, qualityClv, c.uncertainty);
  const evStr = formatEdgePct(c.ev) || edgePctStr;

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
    fair_sharp_p: c.fair_sharp_p != null ? +Number(c.fair_sharp_p).toFixed(4) : null,
    predictedClv: c.predictedClv,
    modelVersion: opts.modelVersion,
    book: c.book,
    line: c.line != null ? c.line : null,
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
 * Preserve quality grades; align grade/stake hierarchy; never force-fill to max.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => ({ ...p }));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  // Lock published parlays to fixed 0.5u
  for (const pl of parlays) {
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

  out = sortByGradeThenUnits(out);
  return { picks: out, parlayLegs: parlays };
}

module.exports = {
  scoreCandidate,
  selectStraights,
  orderedByScore,
  toPickObject,
  applyDailyCap,
  applyDailyUnitCap,
  matchupKey,
  formatMoneylinePick,
  sortByGradeThenUnits,
};
