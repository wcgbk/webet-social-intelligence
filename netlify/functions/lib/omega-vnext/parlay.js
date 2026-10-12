'use strict';

const { KELLY_FRACTION, PARLAY_FIXED_UNITS, PARLAY_TOTAL_HAIRCUT, PARLAY_MIN_COVER, LEAN_MIN_EV, LEAN_PARLAY_UNITS } = require('./config');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyToUnits,
  formatMoneylinePick, formatEdgePct, ratingToConfidence,
  parseEdgeFraction, qualityScore, qualityToRating, sortByGradeThenUnits,
} = require('./odds_math');
const { matchupKey, passesPublishFloor, qualifiesAsLean } = require('./select');
const { inSlate } = require('./selection_pass');
const { footballAuditFields } = require('./sports/_common');
const { pushAwareKelly } = require('./push_ev');
const { parlayCorrEnabled, PARLAY_TOTAL_RHO } = require('./gaps_flags');
const { reviewFlag } = require('./pinnacle_flag');

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
 * Returns joint / independence. Positive ρ is above 1.
 * That raise is not used for EV. See comboStats.
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

/** Sides when every leg is a total on one side. Otherwise null. */
function sameDirectionSides(legs) {
  const list = Array.isArray(legs) ? legs : [];
  if (list.length < 2) return null;
  const sides = [];
  for (const leg of list) {
    const side = totalDirection(leg);
    if (!side) return null;
    sides.push(side);
  }
  if (!sides.every(s => s === sides[0])) return null;
  return sides;
}

/**
 * Factor applied to the independent product when every leg is a total
 * on one side. Otherwise 1.
 * Always the legacy haircut (at most 1). Positive ρ is not a substitute.
 * OMEGA_PARLAY_CORR defaults off and cannot replace this with a raise.
 */
function sameDirectionTotalFactor(legs) {
  const sides = sameDirectionSides(legs);
  if (!sides) return 1;
  const table = PARLAY_TOTAL_HAIRCUT || {};
  const raw = Number(table[sides.length]);
  if (!Number.isFinite(raw) || raw > 1) return 1;
  if (raw < 0) return 0;
  return raw;
}

function comboStats(legs) {
  let combinedDecimal = 1;
  let independent = 1;
  for (const l of legs) {
    combinedDecimal *= americanToDecimal(l.odds);
    independent *= Number(l.coverProb);
  }
  let combinedProb = independent;
  if (Number.isFinite(independent)) {
    const haircutProb = independent * sameDirectionTotalFactor(legs);
    if (Number.isFinite(haircutProb) && haircutProb <= independent) {
      combinedProb = haircutProb;
    }
    // Correlation may only lower the joint. The ρ prior is positive, so
    // this branch does not fire for same-direction totals. The haircut stays.
    if (parlayCorrEnabled() && sameDirectionSides(legs)) {
      const corr = correlatedTotalFactor((legs || []).map(l => Number(l.coverProb)));
      if (Number.isFinite(corr) && corr > 0 && corr < 1) {
        const lowered = independent * corr;
        if (Number.isFinite(lowered) && lowered < combinedProb) combinedProb = lowered;
      }
    }
    if (!Number.isFinite(combinedProb) || combinedProb > independent) combinedProb = independent;
  }
  const ev = combinedProb * combinedDecimal - 1;
  const games = new Set(legs.map(matchupKey)).size;
  const sports = new Set(legs.map(l => l.sport)).size;
  return { combinedDecimal, combinedProb, ev, uniqueGames: games, uniqueSports: sports };
}

function leagueKey(leg) {
  const s = String((leg && leg.sport) || '').trim().toUpperCase();
  if (s === 'CFB' || s === 'NCAAF') return 'NCAAF';
  return s;
}

function normConference(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

/** Conference tokens on a leg. A missing token is not a shared conference. */
function conferenceSet(leg) {
  const out = new Set();
  if (!leg) return out;
  const add = (value) => {
    const n = normConference(value);
    if (n) out.add(n);
  };
  add(leg.conference);
  add(leg.homeConference);
  add(leg.awayConference);
  if (Array.isArray(leg.conferences)) {
    for (const c of leg.conferences) add(c);
  }
  return out;
}

function shareConference(a, b) {
  const left = conferenceSet(a);
  const right = conferenceSet(b);
  if (!left.size || !right.size) return false;
  for (const c of left) {
    if (right.has(c)) return true;
  }
  return false;
}

/**
 * Two legs conflict only when they are the same game.
 * Same-direction totals and same-conference totals may share a ticket.
 * The haircut in comboStats can still lower joint probability.
 */
function legsConflict(a, b) {
  if (!a || !b) return false;
  return matchupKey(a) === matchupKey(b);
}

function legEdge(c) {
  const raw = c && (c.edgePct != null ? c.edgePct : c.ev);
  const e = parseEdgeFraction(raw);
  return Number.isFinite(e) ? e : -Infinity;
}

/** Best n legs by edge. A later leg is skipped only when it shares a game. */
function bestEdgeLegs(pool, n) {
  const sorted = [...(pool || [])].sort((a, b) => {
    const d = legEdge(b) - legEdge(a);
    if (Math.abs(d) > 1e-12) return d;
    const evd = (b.ev || 0) - (a.ev || 0);
    if (Math.abs(evd) > 1e-12) return evd;
    return (b.coverProb || 0) - (a.coverProb || 0);
  });
  const legs = [];
  for (const c of sorted) {
    if (legs.length >= n) break;
    if (legs.some(l => legsConflict(l, c))) continue;
    legs.push(c);
  }
  return legs;
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
        if (legsConflict(legs[i], legs[j])) { bad = true; break; }
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

function betterEdgeTuple(aLegs, aEv, bLegs, bEv) {
  const ea = aLegs.map(legEdge).sort((x, y) => y - x);
  const eb = bLegs.map(legEdge).sort((x, y) => y - x);
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    const d = (ea[i] == null ? -Infinity : ea[i]) - (eb[i] == null ? -Infinity : eb[i]);
    if (Math.abs(d) > 1e-12) return d > 0;
  }
  return aEv > bEv + 1e-12;
}

function straightBook(straight) {
  return String(straight && straight.book || '').trim().toLowerCase();
}

function lineClose(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.051;
}

/**
 * The published straights, when they are three distinct games already in
 * the filtered pool, each cover is >= 45%, and comboStats EV is positive.
 * Otherwise null and the edge search runs.
 */
function preferredStraightCombo(search, straights) {
  if (!Array.isArray(straights) || straights.length !== 3) return null;
  const used = new Set();
  const rows = [];
  for (const straight of straights) {
    const hits = [];
    for (let i = 0; i < search.length; i++) {
      if (used.has(i)) continue;
      if (!parlayIsCardMirror([search[i]], [straight])) continue;
      hits.push(i);
    }
    if (!hits.length) return null;
    const book = straightBook(straight);
    const line = straight.line;
    let pick = hits[0];
    let bestScore = -1;
    for (const i of hits) {
      const row = search[i];
      let score = 0;
      if (book && String(row.book || '').trim().toLowerCase() === book) score += 2;
      if (lineClose(row.line, line)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    used.add(pick);
    rows.push(search[pick]);
  }
  if (new Set(rows.map(matchupKey)).size !== 3) return null;
  if (rows.some(r => !(Number.isFinite(r.coverProb) && r.coverProb >= PARLAY_MIN_COVER))) return null;
  const st = comboStats(rows);
  if (!(st.ev > 0) || st.uniqueGames !== 3) return null;
  return { legs: rows, ...st };
}

function isFloorLeg(c) {
  return !!(c && c.tier !== 'lean' && passesPublishFloor(c));
}

/** Same game: a floor straight beats a lean. Then higher edge, then EV. */
function betterParlayLeg(c, prev) {
  if (!prev) return true;
  const cFloor = isFloorLeg(c);
  const pFloor = isFloorLeg(prev);
  if (cFloor !== pFloor) return cFloor;
  if (legEdge(c) > legEdge(prev) + 1e-12) return true;
  if (legEdge(prev) > legEdge(c) + 1e-12) return false;
  return (c.ev || 0) > (prev.ev || 0);
}

/**
 * A floor row, or a lean with stake EV at or above LEAN_MIN_EV and a
 * positive edge. Structural rejects are not leans.
 */
function passesParlayCandidate(c) {
  if (passesPublishFloor(c)) return true;
  if (!c || c.tier !== 'lean') return false;
  const ev = Number(c.ev);
  if (!(ev + 1e-12 >= LEAN_MIN_EV)) return false;
  const edge = parseEdgeFraction(c.edgePct != null ? c.edgePct : c.edge);
  return Number.isFinite(edge) && edge > 0;
}

function isLeanCard(straights) {
  return Array.isArray(straights) && straights.some((s) => s && s.tier === 'lean');
}

function numericOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function numericProb(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1 ? value / 100 : value;
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const n = parseFloat(text.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return text.includes('%') || Math.abs(n) > 1 ? n / 100 : n;
}

/** Card pick or candidate, with numeric odds and cover for comboStats. */
function legFromRow(row) {
  if (!row) return null;
  const odds = numericOdds(row.odds);
  const coverProb = numericProb(row.coverProb);
  if (!Number.isFinite(odds) || !Number.isFinite(coverProb)) return null;
  const evRaw = numericProb(row.ev);
  const edgeRaw = numericProb(row.edgePct != null ? row.edgePct : row.edge);
  const dec = americanToDecimal(odds);
  const ev = Number.isFinite(evRaw) ? evRaw : (Number.isFinite(dec) ? coverProb * dec - 1 : 0);
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    odds,
    coverProb,
    ev: Number.isFinite(ev) ? ev : 0,
    edgePct: Number.isFinite(edgeRaw) ? edgeRaw : row.edgePct,
    matchup: row.matchup || `${row.awayTeam} @ ${row.homeTeam}`,
  };
}

/**
 * Top 3 published card picks on distinct games. Combined EV must be > 0.
 * Cover floor is not reapplied: these picks are already on the card.
 * A formatted pick is priced from the numeric pool row when one matches.
 */
function topCardCombo(straights, pool) {
  if (!Array.isArray(straights)) return null;
  const rows = [];
  const seen = new Set();
  for (const straight of straights) {
    if (rows.length >= 3) break;
    const key = matchupKey(straight);
    if (!key || seen.has(key)) continue;
    let source = straight;
    const cover = straight && straight.coverProb;
    const alreadyNumeric = typeof cover === 'number' && Number.isFinite(cover) && Number.isFinite(numericOdds(straight.odds));
    if (!alreadyNumeric) {
      const hit = (pool || []).find((row) => parlayIsCardMirror([row], [straight]));
      if (hit) source = hit;
    }
    const leg = legFromRow(source);
    if (!leg) return null;
    seen.add(key);
    rows.push(leg);
  }
  if (rows.length !== 3) return null;
  const st = comboStats(rows);
  if (!(st.ev > 0) || st.uniqueGames !== 3) return null;
  return { legs: rows, ...st };
}

/** Floors plus publishable leans. Cover >= 45%, positive stake EV, in the slate. */
function eligibleLeanParlayPool(pool, cardDate) {
  const out = [];
  for (const c of pool || []) {
    if (!c) continue;
    if (!(passesPublishFloor(c) || qualifiesAsLean(c))) continue;
    const cover = numericProb(c.coverProb);
    const odds = numericOdds(c.odds);
    const ev = numericProb(c.ev);
    if (!(Number.isFinite(cover) && cover >= PARLAY_MIN_COVER)) continue;
    if (!Number.isFinite(odds) || !(Number.isFinite(ev) && ev > 0)) continue;
    if (cardDate && !inSlate(c, cardDate)) continue;
    out.push({ ...c, odds, coverProb: cover, ev });
  }
  return out;
}

/** Highest combined EV among distinct-game n-leg tickets. Edge breaks a tie. */
function bestEvCombo(pool, size) {
  const games = pool || [];
  if (games.length < size) return null;
  let best = null;
  for (const legs of enumerateCombos(games, size)) {
    const st = comboStats(legs);
    if (st.uniqueGames !== legs.length || !(st.ev > 0)) continue;
    const betterEv = !best || st.ev > best.ev + 1e-12;
    const tied = best && Math.abs(st.ev - best.ev) <= 1e-12 && betterEdgeTuple(legs, st.ev, best.legs, best.ev);
    if (betterEv || tied) best = { legs, ...st };
  }
  return best;
}

/** Best side per game, then the best-edge combo whose combined EV is positive. */
function bestPositiveCombo(pool, size) {
  const byGame = new Map();
  for (const c of pool || []) {
    const key = matchupKey(c);
    const prev = byGame.get(key);
    if (betterParlayLeg(c, prev)) byGame.set(key, c);
  }
  const games = [...byGame.values()];
  if (games.length < size) return null;
  let best = null;
  for (const legs of enumerateCombos(games, size)) {
    const st = comboStats(legs);
    if (st.uniqueGames !== legs.length || !(st.ev > 0)) continue;
    if (!best || betterEdgeTuple(legs, st.ev, best.legs, best.ev)) best = { legs, ...st };
  }
  return best;
}

/**
 * On a card that includes a lean, the parlay is the top 3 card picks on
 * distinct games when their combined EV is positive, sized
 * LEAN_PARLAY_UNITS. If that combo's EV is not positive, it is the best
 * positive-EV distinct-game 3-leg from the eligible pool, also
 * LEAN_PARLAY_UNITS. Otherwise the floor-day rule below runs at 0.5u.
 * When the three published straights are on distinct games, each cover
 * is >= 45%, and their combined EV is positive, the parlay is those
 * straights. Otherwise the best edges on distinct games, preferring a
 * floor leg over a lean on the same game. A +EV lean may be a leg.
 * No two legs share a game. Each leg needs coverProb >= 45%.
 * The ticket's combined EV must be > 0. A positive-EV 3-leg wins.
 * Otherwise the best positive-EV 2-leg. If neither exists, there is no
 * parlay. Straights still publish.
 */
function optimizeParlay(yesPool, straights = [], opts = {}) {
  const cardDate = opts.cardDate || opts.dateISO || null;
  const pool = (yesPool || [])
    .filter(passesParlayCandidate)
    .filter(c => Number.isFinite(c.coverProb) && c.coverProb >= PARLAY_MIN_COVER)
    .filter(c => Number.isFinite(c.odds) && c.ev > 0)
    .filter(c => !cardDate || inSlate(c, cardDate))
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
    .sort((a, b) => legEdge(b) - legEdge(a) || (b.ev - a.ev));

  const search = pool;
  let chosen = null;
  let leanStake = false;
  if (isLeanCard(straights)) {
    const cardCombo = topCardCombo(straights, yesPool);
    if (cardCombo) {
      chosen = cardCombo;
      leanStake = true;
    } else {
      const best3 = bestEvCombo(eligibleLeanParlayPool(yesPool, cardDate), 3);
      if (best3) {
        chosen = best3;
        leanStake = true;
      }
    }
  }
  if (!chosen) {
    const preferred = preferredStraightCombo(search, straights);
    if (!preferred && search.length < 2) return [];
    chosen = preferred || bestPositiveCombo(search, 3) || bestPositiveCombo(search, 2);
  }
  if (!chosen) {
    console.log('[omega-vnext] parlay none — no positive-EV 3-leg or 2-leg with cover >= 45%');
    return [];
  }

  const independent = !parlayIsCardMirror(chosen.legs, straights);

  // v12.0.9: published parlay always fixed PARLAY_FIXED_UNITS (0.5u)
  // A lean-day ticket overrides this with LEAN_PARLAY_UNITS below.
  const stake = PARLAY_FIXED_UNITS;

  const combinedAmerican = decimalToAmerican(chosen.combinedDecimal);
  const combinedOdds = combinedAmerican == null ? '' : formatAmerican(combinedAmerican);

  const legs = sortByGradeThenUnits(chosen.legs.map(l => {
    // Leg grade is edge-first quality, independent of the synthetic straight stake.
    const dataReviewFlag = reviewFlag(l);
    const kFrac = pushAwareKelly(l.coverProb, l.odds, KELLY_FRACTION, l.pPush);
    const legUnits = kellyToUnits(Math.max(kFrac, 0), 1.25);
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
      book: l.book || null,
      line: l.line != null ? l.line : null,
      predictedClv: l.predictedClv,
      predictedResidualClv: l.predictedResidualClv != null ? l.predictedResidualClv : null,
      uncertainty: l.uncertainty,
      modelVersion: l.modelVersion,
      ...(Array.isArray(l.placeableBooks) ? { placeableBooks: l.placeableBooks.slice() } : {}),
      ...(l.bestPlaceable ? { bestPlaceable: l.bestPlaceable } : {}),
      ...footballAuditFields(l),
      ...(l.lateNews ? { lateNews: l.lateNews } : {}),
      ...(dataReviewFlag ? { dataReviewFlag } : {}),
    };
  }));

  return [{
    type: `${legs.length}-leg-parlay-${independent ? 'optimized' : 'straight'}`,
    legs,
    units: leanStake ? `${LEAN_PARLAY_UNITS}u` : `${stake}u`,
    ...(leanStake ? { leanDay: true } : {}),
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

module.exports = {
  optimizeParlay, comboStats, enumerateCombos, preferHit, parlayIsCardMirror,
  sameDirectionTotalFactor, correlatedTotalFactor, legsConflict, bestEdgeLegs, legEdge,
  passesParlayCandidate,
};
