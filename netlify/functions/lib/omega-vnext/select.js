'use strict';

const { SELECT_WEIGHTS, MAX_STRAIGHTS, KELLY_FRACTION, DAILY_UNIT_CAP } = require('./config');
const { kellyFraction, kellyToUnits, unitsToRating, ratingToConfidence, formatAmerican } = require('./odds_math');

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
    // soft: prefer not taking 3 from same sport if alternatives within score band exist —
    // handled via softSportMixBonus on remaining scores; re-sort lightly
    const scored = { ...c, _score: scoreCandidate(c, sports) };
    picked.push(scored);
    usedGames.add(g);
    sports.add(c.sport);
  }

  // Re-rank final by score
  picked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return picked;
}

function toPickObject(c, opts = {}) {
  const kFrac = kellyFraction(c.coverProb, c.odds, KELLY_FRACTION);
  let units = kellyToUnits(kFrac, 1.5);
  if (opts.drawdown) units = Math.max(0.25, units * 0.75);
  const rating = unitsToRating(units);
  const edgePctVal = ((c.edgePct != null ? c.edgePct : (c.coverProb - 0)) * 100);
  const isML = /moneyline/i.test(c.market || '');
  const calibratedPct = ((c.coverProb || 0) * 100).toFixed(1);
  const modelEdge = isML
    ? `Model Win Prob: ${calibratedPct}%, Edge: ${edgePctVal.toFixed(1)}%`
    : `Model p: ${calibratedPct}%, Line: ${c.line != null ? c.line : c.consensusLine}, Edge: ${edgePctVal.toFixed(1)}%`;

  return {
    sport: c.sport,
    matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
    pick: c.side,
    betType: c.market,
    odds: c.oddsStr || formatAmerican(c.odds),
    rating,
    confidence: ratingToConfidence(rating),
    units: `${units}u`,
    ev: `${((c.ev || 0) * 100).toFixed(1)}%`,
    evRaw: c.ev,
    edgePct: `${edgePctVal.toFixed(1)}%`,
    coverProb: `${((c.coverProb || 0) * 100).toFixed(0)}%`,
    winProbability: `${((c.coverProb || 0) * 100).toFixed(0)}%`,
    coreReasoning: c.coreReasoning || '',
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
    projMethod: c.projMethod || '',
    uncertainty: c.uncertainty,
  };
}

function applyDailyCap(picks) {
  let total = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  if (total <= DAILY_UNIT_CAP) return picks;
  const out = picks.map(p => ({ ...p }));
  const order = out.map((_, i) => i).sort((a, b) => parseFloat(out[a].units) - parseFloat(out[b].units));
  while (total > DAILY_UNIT_CAP) {
    let reduced = false;
    for (const idx of order) {
      const u = parseFloat(out[idx].units);
      if (u > 0.25) {
        out[idx].units = `${(u - 0.25).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}u`;
        // normalize
        const nu = Math.round((u - 0.25) * 4) / 4;
        out[idx].units = `${nu}u`;
        out[idx].rating = unitsToRating(nu);
        out[idx].confidence = ratingToConfidence(out[idx].rating);
        total -= 0.25;
        reduced = true;
        break;
      }
    }
    if (!reduced) break;
  }
  return out;
}

module.exports = {
  scoreCandidate,
  selectStraights,
  toPickObject,
  applyDailyCap,
  matchupKey,
};
