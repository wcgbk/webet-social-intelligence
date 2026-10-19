'use strict';

const { KELLY_FRACTION, PARLAY_FIXED_UNITS } = require('./config');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyFraction, kellyToUnits,
  formatMoneylinePick, formatEdgePct, ratingToConfidence,
  isSameEtDay, parseEdgeFraction, qualityScore, qualityToRating, sortByGradeThenUnits,
} = require('./odds_math');
const { matchupKey, positionKey, dkHrPriced } = require('./select');

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
  // Lock (2026-10-18): correlation haircut — raw independence overstates
  // combined probability. combinedProb *= 0.95^(legs-1) before EV.
  if (legs.length > 1) combinedProb *= Math.pow(0.95, legs.length - 1);
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

  // Cap search pool for runtime
  const search = pool.slice(0, 24);
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
  const ticket = ticketFromRawLegs(chosen.legs, straights, { candidatesScanned: search.length });
  return ticket ? [ticket] : [];
}

function parseAmerican(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function parseProb(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 && v <= 100 ? v / 100 : v;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const n = parseFloat(s.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (s.includes('%') || Math.abs(n) > 1) return n / 100;
  return n;
}

function legToRaw(leg) {
  if (!leg) return null;
  const odds = parseAmerican(leg.odds);
  const coverProb = parseProb(leg.coverProb != null ? leg.coverProb : leg.winProbability);
  let ev = parseProb(leg.ev);
  if (ev == null && coverProb != null && odds != null) {
    const dec = americanToDecimal(odds);
    if (dec) ev = coverProb * dec - 1;
  }
  if (odds == null || coverProb == null) return null;
  const side = leg.side || leg.pick;
  const market = leg.market || leg.betType;
  return {
    ...leg,
    side,
    market,
    odds,
    coverProb,
    ev: ev == null ? 0 : ev,
    matchup: leg.matchup || `${leg.awayTeam || ''} @ ${leg.homeTeam || ''}`,
    sport: leg.sport,
    commenceTime: leg.commenceTime || '',
  };
}

/** Same ticket shape optimizeParlay publishes. */
function ticketFromRawLegs(rawLegs, straights, meta = {}) {
  if (!rawLegs || rawLegs.length < 2) return null;
  const st = comboStats(rawLegs);
  const independent = !parlayIsCardMirror(rawLegs, straights);
  const stake = PARLAY_FIXED_UNITS;
  const combinedAmerican = decimalToAmerican(st.combinedDecimal);
  const combinedOdds = combinedAmerican == null ? '' : formatAmerican(combinedAmerican);
  const legs = sortByGradeThenUnits(rawLegs.map(l => {
    const kFrac = kellyFraction(l.coverProb, l.odds, KELLY_FRACTION);
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
      coverProb: `${(l.coverProb * 100).toFixed(1)}%`,
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
    };
  }));
  return {
    type: `${legs.length}-leg-parlay-${independent ? 'optimized' : 'straight'}`,
    legs,
    units: `${stake}u`,
    combinedOdds,
    combinedDecimal: +st.combinedDecimal.toFixed(2),
    combinedProb: `${(st.combinedProb * 100).toFixed(1)}%`,
    ev: `${(st.ev * 100).toFixed(1)}%`,
    uniqueGames: st.uniqueGames,
    uniqueSports: st.uniqueSports,
    independent,
    legMarkets: rawLegs.map(l => l.market),
    correlationNote: `CLV-first de-correlated — ${legs.length} legs / ${st.uniqueGames} games`,
    candidatesScanned: meta.candidatesScanned != null ? meta.candidatesScanned : rawLegs.length,
    source: 'omega-vnext',
  };
}

function onCardDate(c, cardDate) {
  if (!cardDate) return true;
  if (!c || !c.commenceTime) return false;
  return isSameEtDay(c.commenceTime, cardDate);
}

function takeParlayLegs(raw, n, allowSecond) {
  const ranked = [...raw].sort((a, b) => (b.coverProb - a.coverProb) || ((b.ev || 0) - (a.ev || 0)));
  const picked = [];
  const usedGames = new Set();
  const usedKeys = new Set();
  const consider = (second) => {
    for (const c of ranked) {
      if (picked.length >= n) return;
      const key = positionKey(c);
      if (usedKeys.has(key)) continue;
      const g = matchupKey(c);
      if (usedGames.has(g) && !second) continue;
      picked.push(c);
      usedKeys.add(key);
      usedGames.add(g);
    }
  };
  consider(false);
  if (picked.length < n && allowSecond) consider(true);
  return picked;
}

/**
 * Publish a 3-leg when the board has one. Gate-clear +EV search runs first
 * (unchanged optimizeParlay). If that cannot fill 3 legs and the DK/Hard Rock
 * board still has 3 games, the best remaining priced sides complete the slip.
 */
function ensureCardParlay(pool, straights, opts = {}) {
  const primaryPool = opts.yesPool || pool;
  const primary = optimizeParlay(primaryPool, straights, opts);
  if (primary[0] && Array.isArray(primary[0].legs) && primary[0].legs.length >= 3) return primary;
  const cardDate = opts.cardDate || opts.dateISO || null;
  const raw = [];
  const seen = new Set();
  for (const c of pool || []) {
    if (!onCardDate(c, cardDate)) continue;
    if (!dkHrPriced(c)) continue;
    const row = legToRaw(c);
    if (!row) continue;
    const key = positionKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    raw.push(row);
  }
  const games = new Set(raw.map(matchupKey));
  if (games.size < 3 && raw.length < 3) return primary;
  const picked = takeParlayLegs(raw, 3, games.size < 3);
  if (picked.length < 3) return primary;
  const ticket = ticketFromRawLegs(picked, straights, { candidatesScanned: raw.length });
  return ticket ? [ticket] : primary;
}

/**
 * Replace killed parlay legs from the remaining pool.
 * Returns a 3-leg ticket when at least 3 legs are still available, else null.
 */
function refillKilledParlay(parlayLegs, opts = {}) {
  const removed = new Set((opts.removedPicks || []).filter(Boolean).map(ticketName));
  const root = Array.isArray(parlayLegs) ? parlayLegs[0] : null;
  const legs = root && Array.isArray(root.legs) ? root.legs : [];
  const kept = legs.filter(leg => !removed.has(ticketName(leg.pick || leg.side)));
  if (kept.length >= 3 && kept.length === legs.length) return null;
  const pool = (opts.pool || []).filter(c => !removed.has(ticketName(c.pick || c.side)));
  const keptRaw = [];
  const keptSeen = new Set();
  for (const leg of kept) {
    const row = legToRaw(leg);
    if (!row) continue;
    if (removed.has(ticketName(row.side))) continue;
    const key = positionKey(row);
    if (keptSeen.has(key)) continue;
    keptSeen.add(key);
    keptRaw.push(row);
  }
  const ranked = [];
  const seen = new Set(keptSeen);
  for (const c of pool) {
    const row = legToRaw(c);
    if (!row) continue;
    if (removed.has(ticketName(row.side))) continue;
    const key = positionKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(row);
  }
  ranked.sort((a, b) => (b.coverProb - a.coverProb) || ((b.ev || 0) - (a.ev || 0)));
  const games = new Set(keptRaw.concat(ranked).map(matchupKey));
  const picked = [...keptRaw];
  const usedGames = new Set(picked.map(matchupKey));
  const usedKeys = new Set(picked.map(positionKey));
  for (const c of ranked) {
    if (picked.length >= 3) break;
    if (usedGames.has(matchupKey(c))) continue;
    picked.push(c);
    usedGames.add(matchupKey(c));
    usedKeys.add(positionKey(c));
  }
  if (picked.length < 3 && games.size < 3) {
    for (const c of ranked) {
      if (picked.length >= 3) break;
      if (usedKeys.has(positionKey(c))) continue;
      picked.push(c);
      usedKeys.add(positionKey(c));
    }
  }
  if (picked.length < 3) return null;
  return ticketFromRawLegs(picked.slice(0, 3), opts.straights || [], { candidatesScanned: ranked.length + keptRaw.length });
}

module.exports = {
  optimizeParlay,
  ensureCardParlay,
  refillKilledParlay,
  comboStats,
  enumerateCombos,
  preferHit,
  parlayIsCardMirror,
};
