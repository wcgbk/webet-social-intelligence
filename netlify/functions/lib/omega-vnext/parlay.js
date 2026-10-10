'use strict';

const { KELLY_FRACTION, PARLAY_FIXED_UNITS, PARLAY_TOTAL_HAIRCUT } = require('./config');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyToUnits,
  formatMoneylinePick, formatEdgePct, ratingToConfidence,
  isSameEtDay, parseEdgeFraction, qualityScore, qualityToRating, sortByGradeThenUnits,
} = require('./odds_math');
const { matchupKey } = require('./select');
const { footballAuditFields } = require('./sports/_common');
const { pushAwareKelly } = require('./push_ev');
const { parlayCorrEnabled, PARLAY_TOTAL_RHO } = require('./gaps_flags');

function marketRank(m) {
  if (/total/i.test(m || '')) return 3;
  if (/spread|run line|puck/i.test(m || '')) return 2;
  return 1; // ML
}

/** 'over' | 'under' when the leg is a total with a readable side, else null. */
function totalDirection(leg) {
  if (!leg) return null;
  const market = String(leg.market || leg.betType || '');
  const side = String(leg.side || leg.pick || '');
  const looksTotal = /total/i.test(market) || /^\s*(over|under)\b/i.test(side);
  if (!looksTotal) return null;
  if (/^\s*over\b/i.test(side)) return 'over';
  if (/^\s*under\b/i.test(side)) return 'under';
  return null;
}

/**
 * Same-direction totals move together. Sequential Gaussian pair:
 * P = pq + ρ√(p(1-p)q(1-q)), clamped to the Fréchet bounds.
 * Returns joint / independence, which is above 1 when ρ > 0.
 */
function correlatedTotalFactor(probs) {
  if (!Array.isArray(probs) || probs.length < 2) return 1;
  for (const p of probs) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 1;
  }
  let joint = probs[0];
  let indep = probs[0];
  for (let i = 1; i < probs.length; i++) {
    const p = joint;
    const q = probs[i];
    const cov = PARLAY_TOTAL_RHO * Math.sqrt(Math.max(0, p * (1 - p) * q * (1 - q)));
    let next = p * q + cov;
    const lo = Math.max(0, p + q - 1);
    const hi = Math.min(p, q);
    if (next < lo) next = lo;
    if (next > hi) next = hi;
    joint = next;
    indep *= q;
  }
  if (!(indep > 0) || !Number.isFinite(joint)) return 1;
  return joint / indep;
}

/**
 * Factor applied to the independent product when every leg is a total
 * on one side. Otherwise 1.
 * OMEGA_PARLAY_CORR on: positive correlation (factor can exceed 1).
 * Off: PARLAY_TOTAL_HAIRCUT, which is at most 1 (2e0a803).
 */
function sameDirectionTotalFactor(legs) {
  const list = Array.isArray(legs) ? legs : [];
  if (list.length < 2) return 1;
  const sides = [];
  for (const leg of list) {
    const side = totalDirection(leg);
    if (!side) return 1;
    sides.push(side);
  }
  if (!sides.every(s => s === sides[0])) return 1;
  if (parlayCorrEnabled()) {
    const factor = correlatedTotalFactor(list.map(l => Number(l.coverProb)));
    if (!Number.isFinite(factor) || factor <= 0) return 1;
    return factor;
  }
  const table = PARLAY_TOTAL_HAIRCUT || {};
  const raw = Number(table[sides.length]);
  if (!Number.isFinite(raw) || raw > 1) return 1;
  if (raw < 0) return 0;
  return raw;
}

function comboStats(legs) {
  let combinedDecimal = 1;
  let combinedProb = 1;
  for (const l of legs) {
    combinedDecimal *= americanToDecimal(l.odds);
    combinedProb *= l.coverProb;
  }
  const factor = sameDirectionTotalFactor(legs);
  const adjusted = combinedProb * factor;
  if (Number.isFinite(adjusted)) {
    if (parlayCorrEnabled()) {
      if (adjusted > 0) combinedProb = Math.min(0.999, adjusted);
    } else if (adjusted <= combinedProb) {
      combinedProb = adjusted;
    }
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

function ticketName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+ml$/, '').trim();
}

/** True when every leg is already a straight. Moneyline labels include the " ML" suffix. */
function parlayIsCardMirror(legs, straights) {
  if (!Array.isArray(legs) || !legs.length || !Array.isArray(straights) || !straights.length) return false;
  return legs.every(leg => straights.some(straight => {
    const pick = ticketName(straight.pick || straight.side);
    const raw = ticketName(leg.side || leg.pick);
    const formatted = ticketName(formatMoneylinePick(leg.side || leg.pick, leg.market || leg.betType));
    if (!pick || (pick !== raw && pick !== formatted)) return false;
    const game = String(leg.matchup || '').trim().toLowerCase();
    const pg = String(straight.matchup || '').trim().toLowerCase();
    if (game && pg && game !== pg) return false;
    return true;
  }));
}

/** Higher combined hit probability wins. EV breaks an exact tie and nothing else. */
function preferHit(a, b) {
  if (!b) return true;
  const dp = a.combinedProb - b.combinedProb;
  if (dp > 1e-9) return true;
  if (dp < -1e-9) return false;
  return a.ev > b.ev + 1e-12;
}

/**
 * Most likely to CONVERT (hit) among +EV cross-game parlays.
 * Rank is combined hit probability. EV is a tie-break only.
 * A clean 3-leg is published whenever one exists. A 2-leg is the fallback
 * when the pool has fewer than three clean legs.
 */
function optimizeParlay(yesPool, straights = [], opts = {}) {
  const cardDate = opts.cardDate || opts.dateISO || null;
  const pool = (yesPool || [])
    .filter(c => Number.isFinite(c.coverProb) && Number.isFinite(c.odds) && c.ev > 0)
    .filter(c => !cardDate || (c.commenceTime && isSameEtDay(c.commenceTime, cardDate)))
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

  // The gated +EV pool is small. Search every combo, not the top 24 by coverProb.
  const search = pool;
  if (search.length < 2) return [];

  const scoreCombo = (legs) => {
    const st = comboStats(legs);
    if (st.ev <= 0) return null;
    // Clean = one leg per game. A 3-leg must be three games.
    if (st.uniqueGames !== legs.length) return null;
    return { legs, ...st };
  };

  let best3 = null;
  for (const legs of enumerateCombos(search, 3)) {
    const s = scoreCombo(legs);
    if (!s) continue;
    if (preferHit(s, best3)) best3 = s;
  }

  let best2 = null;
  if (!best3) {
    for (const legs of enumerateCombos(search, 2)) {
      const s = scoreCombo(legs);
      if (!s) continue;
      if (preferHit(s, best2)) best2 = s;
    }
  }

  const chosen = best3 || best2;
  if (!chosen) return [];

  const independent = !parlayIsCardMirror(chosen.legs, straights);

  // v12.0.9: published parlay always fixed PARLAY_FIXED_UNITS (0.5u)
  const stake = PARLAY_FIXED_UNITS;

  const combinedAmerican = decimalToAmerican(chosen.combinedDecimal);
  const combinedOdds = combinedAmerican == null ? '' : formatAmerican(combinedAmerican);

  const legs = sortByGradeThenUnits(chosen.legs.map(l => {
    // Leg grade is edge-first quality, independent of the synthetic straight stake.
    const kFrac = pushAwareKelly(l.coverProb, l.odds, KELLY_FRACTION, l.pPush);
    const legUnits = kellyToUnits(Math.max(kFrac, 0), 1.25) || 0.25;
    const edgeFrac = parseEdgeFraction(l.edgePct != null ? l.edgePct : l.ev);
    const qualityClv = l.predictedResidualClv != null ? l.predictedResidualClv : l.predictedClv;
    const legQuality = qualityScore(edgeFrac, qualityClv, l.uncertainty);
    const rating = qualityToRating(edgeFrac, qualityClv, l.uncertainty);
    const confidence = ratingToConfidence(rating);
    return {
      pick: formatMoneylinePick(l.side, l.market),
      pickDisplay: formatMoneylinePick(l.side, l.market),
      sport: l.sport,
      matchup: l.matchup,
      betType: l.market,
      odds: formatAmerican(l.odds),
      commenceTime: l.commenceTime || '',
      coverProb: `${(l.coverProb * 100).toFixed(0)}%`,
      ev: `${((l.ev || 0) * 100).toFixed(1)}%`,
      edgePct: l.edgePct != null
        ? (typeof l.edgePct === 'number' ? (formatEdgePct(l.edgePct <= 1 ? l.edgePct : l.edgePct / 100) || undefined) : String(l.edgePct))
        : undefined,
      rating,
      qualityGrade: rating,
      qualityScore: +legQuality.toFixed(6),
      confidence,
      units: l.units || `${legUnits}u`,
      coreReasoning: l.coreReasoning || '',
      homeTeam: l.homeTeam,
      awayTeam: l.awayTeam,
      p_model: l.p_model,
      fair_sharp_p: l.fair_sharp_p,
      predictedClv: l.predictedClv,
      predictedResidualClv: l.predictedResidualClv != null ? l.predictedResidualClv : null,
      uncertainty: l.uncertainty,
      modelVersion: l.modelVersion,
      ...(Array.isArray(l.placeableBooks) ? { placeableBooks: l.placeableBooks.slice() } : {}),
      ...(l.bestPlaceable ? { bestPlaceable: l.bestPlaceable } : {}),
      ...footballAuditFields(l),
      ...(l.lateNews ? { lateNews: l.lateNews } : {}),
    };
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
    correlationNote: (parlayCorrEnabled() && sameDirectionTotalFactor(chosen.legs) > 1 + 1e-12)
      ? `same-direction totals ρ=${PARLAY_TOTAL_RHO} — ${legs.length} legs / ${chosen.uniqueGames} games`
      : `CLV-first de-correlated — ${legs.length} legs / ${chosen.uniqueGames} games`,
    candidatesScanned: search.length,
    source: 'omega-vnext',
  }];
}

module.exports = {
  optimizeParlay, comboStats, enumerateCombos, preferHit, parlayIsCardMirror,
  sameDirectionTotalFactor,
};
