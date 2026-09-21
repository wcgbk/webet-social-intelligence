'use strict';

const { SELECT_WEIGHTS, MAX_STRAIGHTS, KELLY_FRACTION, DAILY_UNIT_CAP } = require('./config');
const {
  kellyFraction, kellyToUnits, unitsToRating, ratingToConfidence, formatAmerican,
  formatEdgePct, formatMoneylinePick, sortByGradeThenUnits, ratingRank,
} = require('./odds_math');

function matchupKey(c) {
  return String(c.matchup || `${c.awayTeam} @ ${c.homeTeam}`).toLowerCase().trim();
}

function scoreCandidate(c, selectedSports) {
  const w = SELECT_WEIGHTS;
  const ev = c.ev || 0;
  const clv = (c.predictedClv || 0) / 100; // scale cents-ish to ~EV units
  const unc = c.uncertainty != null ? c.uncertainty : 0.15;
  let s = w.w_ev * ev + w.w_clv * clv - w.w_uncertainty * unc;
  if (selectedSports && selectedSports.size && !selectedSports.has(c.sport)) {
    s += w.softSportMixBonus;
  }
  return s;
}

/**
 * Greedy diversify: ≤1 per game, up to MAX_STRAIGHTS. Empty OK.
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

function parseU(u) {
  return parseFloat(String(u || '0').replace(/[^0-9.]/g, '')) || 0;
}

function fmtU(n) {
  const nu = Math.round(n * 4) / 4;
  return `${nu}u`;
}

function toPickObject(c, opts = {}) {
  const kFrac = kellyFraction(c.coverProb, c.odds, KELLY_FRACTION);
  let units = kellyToUnits(kFrac, 1.5);
  if (opts.drawdown) units = Math.max(0.25, units * 0.75);
  const rating = unitsToRating(units);

  // Honest Edge badge = model edge after shrink vs no-vig sharp (fraction on c.edgePct).
  // Fallback: coverProb - book implied. Never predictedClv cents / raw coverProb.
  const edgeFrac = (c.edgePct != null && Math.abs(c.edgePct) <= 1)
    ? c.edgePct
    : null;
  const edgePctStr = formatEdgePct(edgeFrac) || '0.0%';
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
  };
}

/**
 * Cap straights only (legacy). Prefer applyDailyUnitCap with parlay.
 */
function applyDailyCap(picks) {
  return applyDailyUnitCap(picks, null).picks;
}

/**
 * DAILY_UNIT_CAP includes straights + parlay stake.
 * Overage: cut parlay first (floor 0.25u), then lowest-confidence straights
 * in 0.25u steps (floor 0.25u). Recompute grades; sort A+→B then units desc.
 */
function applyDailyUnitCap(picks, parlayLegs) {
  let out = (picks || []).map(p => ({ ...p }));
  let parlays = Array.isArray(parlayLegs)
    ? parlayLegs.map(pl => ({ ...pl, legs: (pl.legs || []).map(l => ({ ...l })) }))
    : [];

  const totalOf = () => {
    const s = out.reduce((acc, p) => acc + parseU(p.units), 0);
    const p = parlays.reduce((acc, pl) => acc + parseU(pl.units), 0);
    return s + p;
  };

  let total = totalOf();
  if (total <= DAILY_UNIT_CAP) {
    out = sortByGradeThenUnits(out);
    return { picks: out, parlayLegs: parlays };
  }

  // 1) Scale parlay down first
  while (total > DAILY_UNIT_CAP && parlays.length) {
    let cut = false;
    for (const pl of parlays) {
      const u = parseU(pl.units);
      if (u > 0.25) {
        const nu = Math.max(0.25, Math.round((u - 0.25) * 4) / 4);
        pl.units = fmtU(nu);
        total = totalOf();
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }

  // 2) Reduce lowest-confidence straights (highest ratingRank first)
  while (total > DAILY_UNIT_CAP && out.length) {
    const order = out
      .map((_, i) => i)
      .sort((a, b) => {
        const ra = ratingRank(out[a].rating);
        const rb = ratingRank(out[b].rating);
        if (ra !== rb) return rb - ra; // lowest grade first
        return parseU(out[a].units) - parseU(out[b].units);
      });
    let reduced = false;
    for (const idx of order) {
      const u = parseU(out[idx].units);
      if (u > 0.25) {
        const nu = Math.max(0.25, Math.round((u - 0.25) * 4) / 4);
        out[idx].units = fmtU(nu);
        out[idx].rating = unitsToRating(nu);
        out[idx].confidence = ratingToConfidence(out[idx].rating);
        total = totalOf();
        reduced = true;
        break;
      }
    }
    if (!reduced) break;
  }

  out = sortByGradeThenUnits(out);
  return { picks: out, parlayLegs: parlays };
}

module.exports = {
  scoreCandidate,
  selectStraights,
  toPickObject,
  applyDailyCap,
  applyDailyUnitCap,
  matchupKey,
  formatMoneylinePick,
  sortByGradeThenUnits,
};
