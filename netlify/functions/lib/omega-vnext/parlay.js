'use strict';

const { KELLY_FRACTION } = require('./config');
const {
  americanToDecimal, formatAmerican, kellyFraction, kellyToUnits,
} = require('./odds_math');
const { matchupKey } = require('./select');

function marketRank(m) {
  if (/total/i.test(m || '')) return 3;
  if (/spread|run line|puck/i.test(m || '')) return 2;
  return 1; // ML
}

function comboStats(legs) {
  let combinedDecimal = 1;
  let combinedProb = 1;
  for (const l of legs) {
    combinedDecimal *= americanToDecimal(l.odds);
    combinedProb *= l.coverProb;
  }
  const ev = combinedProb * combinedDecimal - 1;
  const games = new Set(legs.map(matchupKey)).size;
  const sports = new Set(legs.map(l => l.sport)).size;
  return { combinedDecimal, combinedProb, ev, uniqueGames: games, uniqueSports: sports };
}

function conflicts(a, b) {
  if (matchupKey(a) === matchupKey(b)) return true;
  // same team ML+spread
  if (a.homeTeam && a.side && b.side) {
    const sameGame = matchupKey(a) === matchupKey(b);
    if (sameGame) return true;
  }
  return false;
}

function enumerateCombos(pool, size) {
  const out = [];
  const n = pool.length;
  if (n < size) return out;
  const idxs = [...Array(size).keys()];
  const next = () => {
    let i = size - 1;
    while (i >= 0 && idxs[i] === i + n - size) i--;
    if (i < 0) return false;
    idxs[i]++;
    for (let j = i + 1; j < size; j++) idxs[j] = idxs[j - 1] + 1;
    return true;
  };
  do {
    const legs = idxs.map(i => pool[i]);
    let bad = false;
    for (let i = 0; i < legs.length && !bad; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        if (conflicts(legs[i], legs[j])) { bad = true; break; }
      }
    }
    if (!bad) out.push(legs);
  } while (next());
  return out;
}

/**
 * Optimize MOST LIKELY TO HIT among +EV parlays.
 * Prefer 3-leg cross-game; 2-leg only if clearly better EV/hit.
 */
function optimizeParlay(yesPool, straights = []) {
  const pool = (yesPool || [])
    .filter(c => Number.isFinite(c.coverProb) && Number.isFinite(c.odds) && c.ev > 0)
    .map(c => ({
      ...c,
      side: c.side,
      market: c.market,
      odds: c.odds,
      coverProb: c.coverProb,
      matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
      sport: c.sport,
      commenceTime: c.commenceTime || '',
    }))
    // Prefer higher coverProb for hit-rate; keep +EV
    .sort((a, b) => (b.coverProb - a.coverProb) || (b.ev - a.ev));

  // Cap search pool for runtime
  const search = pool.slice(0, 24);
  if (search.length < 2) return [];

  const scoreCombo = (legs) => {
    const st = comboStats(legs);
    if (st.ev <= 0) return null;
    if (st.uniqueGames < 2) return null;
    // Primary: hit probability; secondary: EV; soft prefer more sports
    return {
      legs,
      ...st,
      score: st.combinedProb * 1.0 + st.ev * 0.15 + (st.uniqueSports > 1 ? 0.01 : 0),
    };
  };

  let best3 = null;
  for (const legs of enumerateCombos(search, 3)) {
    const s = scoreCombo(legs);
    if (!s) continue;
    if (!best3 || s.score > best3.score) best3 = s;
  }

  let best2 = null;
  for (const legs of enumerateCombos(search, 2)) {
    const s = scoreCombo(legs);
    if (!s) continue;
    if (!best2 || s.score > best2.score) best2 = s;
  }

  let chosen = best3;
  // 2-leg only if clearly better EV/hit than best 3-leg
  if (!best3 && best2) chosen = best2;
  else if (best3 && best2) {
    const clearlyBetter =
      (best2.ev > best3.ev + 0.05 && best2.combinedProb > best3.combinedProb) ||
      (best2.combinedProb > best3.combinedProb * 1.35 && best2.ev > best3.ev);
    if (clearlyBetter) chosen = best2;
  }
  if (!chosen) return [];

  const straightSides = new Set((straights || []).map(p => p.pick || p.side));
  const independent = !chosen.legs.every(l => straightSides.has(l.side));

  // ¼ Kelly on parlay; typical ~0.5u
  const parlayKelly = kellyFraction(chosen.combinedProb, (() => {
    const dec = chosen.combinedDecimal;
    return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  })(), KELLY_FRACTION);
  let stake = kellyToUnits(Math.max(parlayKelly, 0.005), 0.75);
  stake = Math.max(0.25, Math.min(0.75, stake || 0.5));
  if (!stake) stake = 0.5;

  const combinedOdds = chosen.combinedDecimal >= 2
    ? `+${Math.round((chosen.combinedDecimal - 1) * 100)}`
    : `${Math.round(-100 / (chosen.combinedDecimal - 1))}`;

  const legs = chosen.legs.map(l => ({
    pick: l.side,
    sport: l.sport,
    matchup: l.matchup,
    betType: l.market,
    odds: formatAmerican(l.odds),
    commenceTime: l.commenceTime || '',
    coverProb: `${(l.coverProb * 100).toFixed(0)}%`,
    ev: `${((l.ev || 0) * 100).toFixed(1)}%`,
    edgePct: l.edgePct != null
      ? (typeof l.edgePct === 'number' ? `${(l.edgePct * (l.edgePct <= 1 ? 100 : 1)).toFixed(1)}%` : String(l.edgePct))
      : undefined,
    // Optional card chrome — straights carry rating/units; legs may inherit later from matching straight
    rating: l.rating || null,
    confidence: l.confidence || null,
    units: l.units || null,
    coreReasoning: l.coreReasoning || '',
    homeTeam: l.homeTeam,
    awayTeam: l.awayTeam,
    p_model: l.p_model,
    fair_sharp_p: l.fair_sharp_p,
    predictedClv: l.predictedClv,
    modelVersion: l.modelVersion,
  }));

  return [{
    type: `${legs.length}-leg-parlay-${independent ? 'optimized' : 'straight'}`,
    legs,
    units: `${stake}u`,
    combinedOdds,
    combinedDecimal: +chosen.combinedDecimal.toFixed(2),
    combinedProb: `${(chosen.combinedProb * 100).toFixed(1)}%`,
    ev: `${(chosen.ev * 100).toFixed(1)}%`,
    uniqueGames: chosen.uniqueGames,
    uniqueSports: chosen.uniqueSports,
    independent,
    legMarkets: chosen.legs.map(l => l.market),
    correlationNote: `CLV-first de-correlated — ${legs.length} legs / ${chosen.uniqueGames} games`,
    candidatesScanned: search.length,
    source: 'omega-vnext',
  }];
}

module.exports = { optimizeParlay, comboStats, enumerateCombos };
