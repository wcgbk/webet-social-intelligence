'use strict';

const { KELLY_FRACTION, PARLAY_FIXED_UNITS, PARLAY_TOTAL_HAIRCUT, PARLAY_MIN_COVER, LEAN_MIN_EV, LEAN_MIN_EDGE, LEAN_PARLAY_UNITS, GATES, EV_CAP_ALL, CORR_HAIRCUT_PER_LEG } = require('./config');
const { fairPickFields } = require('./prob_anchor');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyToUnits,
  formatMoneylinePick, formatEdgePct, ratingToConfidence,
  parseEdgeFraction, qualityScore, qualityToRating, sortByGradeThenUnits,
  normalizeRatingKey, ratingLetter, formatGameTimeET,
  stakeDollars, toWinDollars,
} = require('./odds_math');
const { matchupKey, passesPublishFloor, qualifiesAsLean, compareByEv, printedEdgeEv, publishedParlayUnits } = require('./select');
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

function legFairP(l) {
  const direct = Number(l && l.p_fair);
  if (Number.isFinite(direct) && direct > 0 && direct < 1) return direct;
  const text = l && l.fairP;
  if (text == null || text === '') return null;
  const n = Number(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  const p = String(text).includes('%') || n > 1 ? n / 100 : n;
  return p > 0 && p < 1 ? p : null;
}

/**
 * Soft or invalid fair. prob_anchor.js sets these; this file only reads them.
 * A missing field is valid. It is not a fitted cutoff.
 */
function fairIsSoft(leg) {
  if (!leg || typeof leg !== 'object') return false;
  if (leg.fairSoft === true) return true;
  if (leg.evAtFairValid === false) return true;
  return false;
}

/**
 * Joint = product of final p, times CORR_HAIRCUT_PER_LEG^(n-1).
 * That factor is a same-model-bias haircut (ASSUMED), not a fitted rho.
 * Payout is the product of the book's leg decimals.
 * ev is evAtModel and is the positive-EV gate.
 * evAtFair is the product of each leg's p_fair (the anchor fair, not a
 * separate DraftKings number) times the parlay decimal, with no haircut.
 */
function comboStats(legs) {
  const list = legs || [];
  let combinedDecimal = 1;
  let independent = 1;
  let fairProd = 1;
  let fairOk = list.length > 0;
  for (const l of list) {
    combinedDecimal *= americanToDecimal(l.odds);
    independent *= Number(l.coverProb);
    // fairSoft / evAtFairValid are stamped in prob_anchor.js by another pass.
    // Absent means the fair is usable. A soft or invalid fair is not a number
    // we can stake: evAtFair stays null (not available).
    if (fairIsSoft(l)) fairOk = false;
    const fp = legFairP(l);
    if (fp == null) fairOk = false;
    else fairProd *= fp;
  }
  const n = list.length;
  const bias = n > 1 ? Math.pow(Number(CORR_HAIRCUT_PER_LEG) || 0.95, n - 1) : 1;
  let combinedProb = independent;
  let corrApplied = false;
  if (Number.isFinite(independent)) {
    combinedProb = independent * bias;
    if (parlayCorrEnabled() && sameDirectionSides(list)) {
      const corr = correlatedTotalFactor(list.map(l => Number(l.coverProb)));
      if (Number.isFinite(corr) && corr > 0 && corr < 1) {
        const lowered = independent * corr;
        if (Number.isFinite(lowered) && lowered < combinedProb) {
          combinedProb = lowered;
          corrApplied = true;
        }
      }
    }
    if (!Number.isFinite(combinedProb) || combinedProb > independent) combinedProb = independent;
  }
  const ev = combinedProb * combinedDecimal - 1;
  const evAtFair = fairOk && Number.isFinite(combinedDecimal) ? (fairProd * combinedDecimal) - 1 : null;
  const games = new Set(list.map(matchupKey)).size;
  const sports = new Set(list.map(l => l.sport)).size;
  return {
    combinedDecimal,
    combinedProb,
    ev,
    evAtModel: ev,
    evAtFair,
    uniqueGames: games,
    uniqueSports: sports,
    haircutApplied: {
      applied: Number.isFinite(bias) && bias < 1,
      factor: bias,
      kind: 'same-model-bias',
    },
    corrApplied,
  };
}

function formatHaircutFactor(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n)) return String(factor);
  const text = String(n);
  if (!/[eE]/.test(text)) return text;
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function legListOf(ticketOrStats) {
  if (Array.isArray(ticketOrStats)) return ticketOrStats;
  if (ticketOrStats && Array.isArray(ticketOrStats.legs)) return ticketOrStats.legs;
  return null;
}

/** Haircut, correlation, and whether two legs share a game. */
function adjustmentOf(ticketOrStats) {
  const src = ticketOrStats && typeof ticketOrStats === 'object' && !Array.isArray(ticketOrStats)
    ? ticketOrStats
    : {};
  const legs = legListOf(ticketOrStats);
  let hair = src.haircutApplied && typeof src.haircutApplied === 'object'
    ? {
      applied: src.haircutApplied.applied === true,
      factor: Number(src.haircutApplied.factor),
      kind: src.haircutApplied.kind || null,
    }
    : null;
  let corr = typeof src.corrApplied === 'boolean' ? src.corrApplied : null;
  if (legs && (hair == null || corr == null)) {
    const numeric = legs.length > 0 && legs.every((leg) => leg && typeof leg.coverProb === 'number' && Number.isFinite(leg.coverProb));
    if (numeric) {
      const st = comboStats(legs);
      if (hair == null) hair = st.haircutApplied;
      if (corr == null) corr = st.corrApplied;
    } else if (legs.length) {
      // Printed covers are strings, so comboStats cannot rerun. The label
      // still uses the same-model-bias haircut: 0.95^(n-1) on every ticket.
      const n = legs.length;
      const per = Number(CORR_HAIRCUT_PER_LEG);
      const factor = n > 1 ? Math.pow(Number.isFinite(per) ? per : 0.95, n - 1) : 1;
      if (hair == null) hair = { applied: factor < 1, factor, kind: 'same-model-bias' };
      if (corr == null) corr = false;
    }
  }
  if (!hair) hair = { applied: false, factor: 1 };
  if (!Number.isFinite(hair.factor)) hair.factor = legs ? sameDirectionTotalFactor(legs) : 1;
  if (corr == null) corr = false;
  let share = false;
  let distinct = false;
  if (legs && legs.length) {
    const games = new Set(legs.map((leg) => matchupKey(leg)));
    share = games.size < legs.length;
    distinct = games.size === legs.length;
  }
  return { share, hair, corr, distinct };
}

/**
 * Wording for the EV that comboStats actually computed.
 * evLabel and correlationNote both use this string.
 * plainProduct on the object means the displayed EV is a raw product.
 * The structural label stays, and a caveat is added when a haircut or
 * correlation term was not applied to that product.
 */
function parlayEvLabel(ticketOrStats) {
  const info = adjustmentOf(ticketOrStats);
  let label = '';
  if (info.share) label = 'legs share a game: not independent';
  else if (info.corr) label = 'correlation-adjusted';
  else if (info.hair.applied) {
    const kind = info.hair.kind === 'same-model-bias' ? 'same-model-bias' : 'same-direction totals';
    label = `${kind} haircut x${formatHaircutFactor(info.hair.factor)} applied`;
  } else if (info.distinct) label = 'assumes independent legs (different games)';
  const plain = !!(ticketOrStats && ticketOrStats.plainProduct === true);
  if (plain && label && (info.hair.applied || info.corr)) {
    const which = info.corr && info.hair.applied
      ? 'haircut and correlation adjustment were not applied'
      : (info.corr ? 'correlation adjustment was not applied' : 'haircut was not applied');
    label = `${label}; displayed EV is a plain product of the leg probabilities (${which})`;
  }
  return label;
}

/** True only when no haircut or correlation term changed the joint and every leg is a different game. */
function parlayIndependent(ticketOrStats) {
  const info = adjustmentOf(ticketOrStats);
  return info.distinct && !info.share && !info.hair.applied && !info.corr;
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

  // Type still records whether the legs are the card. That is mirrorsCard.
  // independent is the probability statement, not that mirror flag.
  // optimizeParlay ranks by edge and stake EV and keeps one leg per game.
  // It does not rank by CLV and it does not fit a correlation model.
  const mirrorsCard = !!parlayIsCardMirror(chosen.legs, straights);
  const evLabel = parlayEvLabel(chosen);
  const legsAreIndependent = parlayIndependent(chosen);

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
      ...fairPickFields(l),
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

  const out = [{
    type: `${legs.length}-leg-parlay-${mirrorsCard ? 'straight' : 'optimized'}`,
    legs,
    units: leanStake ? `${LEAN_PARLAY_UNITS}u` : `${stake}u`,
    ...(leanStake ? { leanDay: true } : {}),
    combinedOdds,
    combinedDecimal: +chosen.combinedDecimal.toFixed(2),
    combinedProb: `${(chosen.combinedProb * 100).toFixed(1)}%`,
    ev: `${(chosen.ev * 100).toFixed(1)}%`,
    evAtModel: formatEdgePct(chosen.evAtModel != null ? chosen.evAtModel : chosen.ev),
    evAtFair: chosen.evAtFair == null ? null : formatEdgePct(chosen.evAtFair),
    evLabel,
    uniqueGames: chosen.uniqueGames,
    uniqueSports: chosen.uniqueSports,
    independent: legsAreIndependent,
    mirrorsCard,
    legMarkets: chosen.legs.map(l => l.market),
    correlationNote: evLabel,
    candidatesScanned: search.length,
    source: 'omega-vnext',
  }];
  // Unrounded model EV. The printed tenth can be 0.0% while the joint is still positive.
  if (out[0].evRaw == null) out[0].evRaw = chosen.ev;
  if (out[0].legs.length >= 2) stampFairParlay(out[0], chosen.evAtFair);
  return out;
}

function numericAmerican(odds) {
  if (typeof odds === 'number' && Number.isFinite(odds) && odds !== 0) return odds;
  if (odds == null || odds === '') return null;
  const n = Number(String(odds).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Fraction in 0..1. "55%" and 55 both become 0.55. Missing stays null. */
function coverFraction(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1 && v <= 100) return v / 100;
    return v;
  }
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return (s.includes('%') || n > 1) ? n / 100 : n;
}

function publishLeg(leg) {
  if (leg && leg.pick && (leg.betType || leg.odds)) return { ...leg };
  const cover = coverFraction(leg && leg.coverProb);
  const american = numericAmerican(leg && leg.odds);
  const edgeRaw = leg && leg.edgePct;
  let edgePct = edgeRaw;
  if (typeof edgeRaw === 'number') {
    edgePct = formatEdgePct(edgeRaw <= 1 ? edgeRaw : edgeRaw / 100) || undefined;
  }
  return {
    pick: formatMoneylinePick(leg.side, leg.market),
    pickDisplay: formatMoneylinePick(leg.side, leg.market),
    sport: leg.sport,
    matchup: leg.matchup || `${leg.awayTeam || ''} @ ${leg.homeTeam || ''}`,
    betType: leg.market,
    odds: american == null ? '' : formatAmerican(american),
    commenceTime: leg.commenceTime || '',
    coverProb: cover == null ? '' : `${(cover * 100).toFixed(1)}%`,
    ev: Number.isFinite(Number(leg.ev)) ? `${(Number(leg.ev) * 100).toFixed(1)}%` : (leg.ev != null ? String(leg.ev) : ''),
    edgePct,
    homeTeam: leg.homeTeam,
    awayTeam: leg.awayTeam,
    book: leg.book || null,
    line: leg.line != null ? leg.line : null,
    tier: leg.tier || 'floor',
    coreReasoning: leg.coreReasoning || '',
    source: 'omega-vnext',
  };
}

const NO_QUALIFYING_PARLAY = 'no qualifying parlay';

function isNoQualifyingParlay(ticket) {
  if (!ticket || typeof ticket !== 'object') return false;
  return ticket.qualifying === false
    || ticket.status === NO_QUALIFYING_PARLAY
    || ticket.type === 'no-qualifying-parlay';
}

/**
 * Adjusted cover used for edge and stake EV. A candidate still holds that
 * cover as a fraction. A published pick stores it on p_cal and rounds the
 * display string, so the display string is not the probability.
 */
function unifiedCoverProb(row) {
  if (!row) return null;
  const raw = row.coverProb;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  const calibrated = Number(row.p_cal);
  if (Number.isFinite(calibrated) && calibrated > 0 && calibrated <= 1) return calibrated;
  const parsed = numericProb(raw != null ? raw : row.winProbability);
  if (parsed != null && parsed > 0 && parsed <= 1) return parsed;
  return null;
}

function edgeFractionOf(row, prob) {
  const parsed = parseEdgeFraction(row && (row.edgePct != null ? row.edgePct : row.edge));
  if (Number.isFinite(parsed)) return parsed;
  const fair = Number(row && (row.fair_sharp_p != null ? row.fair_sharp_p : row.sharpFairP));
  if (Number.isFinite(prob) && Number.isFinite(fair)) return prob - fair;
  return null;
}

function hardRockQuoteOf(row) {
  if (!row) return null;
  const direct = row.hardRock;
  if (direct && Number.isFinite(Number(direct.american)) && Number(direct.american) !== 0) {
    return {
      american: Number(direct.american),
      point: direct.point != null && direct.point !== '' ? Number(direct.point) : null,
    };
  }
  const prices = Array.isArray(row.bookPrices) ? row.bookPrices : null;
  if (!prices) return null;
  const hit = prices.find((p) => /hardrock/i.test(String((p && (p.book || p.key)) || '')));
  if (!hit) return null;
  const american = Number(hit.american != null ? hit.american : hit.price);
  if (!Number.isFinite(american) || american === 0) return null;
  return {
    american,
    point: hit.point != null && hit.point !== '' ? Number(hit.point) : null,
  };
}

/** True when this row carried a book ladder or an explicit Hard Rock flag. */
function hardRockChecked(row) {
  if (!row) return false;
  if (row.hardRockPriced === true || row.hardRockPriced === false) return true;
  if (row.hardRock && typeof row.hardRock === 'object') return true;
  return Array.isArray(row.bookPrices) && row.bookPrices.length > 0;
}

function sameHardRockLine(row, quote) {
  if (!quote || quote.point == null || !Number.isFinite(Number(quote.point))) return true;
  const line = row && row.line != null && row.line !== '' ? Number(row.line) : null;
  if (line == null || !Number.isFinite(line)) return true;
  return Math.abs(Number(quote.point) - line) <= 0.5 + 1e-9;
}

/**
 * One parlay leg at the unified adjusted probability.
 * Stake EV is cover × decimal − 1 at the price the ticket uses.
 * A row with Hard Rock data must be offered there on the same line.
 * A different Hard Rock price is the ticket price when that EV stays positive.
 * A fixture with no Hard Rock fields keeps its displayed price.
 * Returns null when edge is under the lean floor or EV is not positive.
 */
function priceParlayLeg(row) {
  if (!row) return null;
  const prob = unifiedCoverProb(row);
  if (!Number.isFinite(prob)) return null;
  const edge = edgeFractionOf(row, prob);
  const displayed = numericOdds(row.odds != null ? row.odds : row.oddsStr);
  let odds = displayed;
  let hardRockRepriced = false;
  if (hardRockChecked(row)) {
    const quote = hardRockQuoteOf(row);
    if (!quote || !sameHardRockLine(row, quote)) return null;
    if (displayed == null || quote.american !== displayed) {
      odds = quote.american;
      hardRockRepriced = true;
    }
  }
  if (!Number.isFinite(odds)) return null;
  const dec = americanToDecimal(odds);
  if (!Number.isFinite(dec) || !(dec > 1)) return null;
  const ev = prob * dec - 1;
  if (!(ev > 0)) return null;
  if (!Number.isFinite(edge) || edge + 1e-12 < LEAN_MIN_EDGE) return null;
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    odds,
    coverProb: prob,
    p_cal: prob,
    ev,
    edgePct: edge,
    hardRockRepriced,
    probBasis: 'unified-adjusted-cover',
  };
}

function parlaySideId(row) {
  const side = String((row && (row.side || row.pick)) || '').trim().toLowerCase();
  const market = String((row && (row.market || row.betType)) || '').trim().toLowerCase();
  return `${matchupKey(row)}|${market}|${side}`;
}

function rankParlayLegs(rows) {
  return (rows || []).slice().sort((a, b) => {
    const d = (b.edgePct || 0) - (a.edgePct || 0);
    if (Math.abs(d) > 1e-12) return d;
    return (b.ev || 0) - (a.ev || 0);
  });
}

function ticketIfPositive(legs) {
  if (!Array.isArray(legs) || legs.length !== 3) return null;
  if (new Set(legs.map(matchupKey)).size !== 3) return null;
  const stats = comboStats(legs);
  if (!(stats.ev > 0) || stats.uniqueGames !== 3) return null;
  if (!Number.isFinite(stats.combinedDecimal) || !(stats.combinedDecimal > 1)) return null;
  return { legs, ...stats };
}

function straightSource(straight, pool) {
  const hit = (pool || []).find((row) => row && parlayIsCardMirror([row], [straight]));
  if (!hit) return straight;
  return {
    ...hit,
    tier: straight.tier || hit.tier || 'floor',
    pick: straight.pick || hit.side,
    coreReasoning: straight.coreReasoning || hit.coreReasoning || '',
  };
}

/**
 * Top three straights when each leg is +EV on the unified cover and the
 * ticket is +EV. Otherwise the next-best +EV legs from distinct games,
 * keeping as many of those straights as the ticket allows.
 */
function selectGatedParlay(straights, pool) {
  const originals = (straights || []).filter(Boolean).slice(0, 3);
  const pricedStraights = [];
  const seenStraight = new Set();
  for (const straight of originals) {
    const priced = priceParlayLeg(straightSource(straight, pool));
    if (!priced) continue;
    const id = parlaySideId(priced);
    if (seenStraight.has(id)) continue;
    seenStraight.add(id);
    pricedStraights.push(priced);
  }
  const direct = originals.length === 3 && pricedStraights.length === 3
    ? ticketIfPositive(pricedStraights)
    : null;
  if (direct) {
    return {
      ...direct,
      corrected: pricedStraights.some((leg) => leg.hardRockRepriced),
      scanned: originals.length,
    };
  }

  const seen = new Set(pricedStraights.map(parlaySideId));
  const pricedPool = pricedStraights.slice();
  for (const row of pool || []) {
    const priced = priceParlayLeg(row);
    if (!priced) continue;
    const id = parlaySideId(priced);
    if (seen.has(id)) continue;
    seen.add(id);
    pricedPool.push(priced);
  }
  const ranked = rankParlayLegs(pricedPool).slice(0, 15);
  const straightIds = new Set(pricedStraights.map(parlaySideId));
  let best = null;
  for (const combo of enumerateCombos(ranked, 3)) {
    const ticket = ticketIfPositive(combo);
    if (!ticket) continue;
    const keep = combo.filter((leg) => straightIds.has(parlaySideId(leg))).length;
    const rankSum = combo.reduce((sum, leg) => sum + ranked.indexOf(leg), 0);
    const betterKeep = !best || keep > best.keep;
    const sameKeep = best && keep === best.keep && rankSum < best.rankSum;
    if (betterKeep || sameKeep) best = { ...ticket, keep, rankSum };
  }
  if (!best) return null;
  return {
    ...best,
    corrected: true,
    scanned: ranked.length,
  };
}

function noQualifyingParlay(reason) {
  const why = reason || 'no positive-EV 3-leg from distinct games';
  console.log(`[omega-vnext] parlay none — no qualifying parlay (${why})`);
  return {
    type: 'no-qualifying-parlay',
    status: NO_QUALIFYING_PARLAY,
    label: NO_QUALIFYING_PARLAY,
    qualifying: false,
    legs: [],
    units: null,
    ev: null,
    evRaw: null,
    combinedOdds: '',
    combinedProb: null,
    combinedProbRaw: null,
    reason: why,
    source: 'omega-vnext',
  };
}

/** One-decimal win rate the card prints, as a fraction. */
function shownFraction(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Number((n * 100).toFixed(1)) / 100;
}

/**
 * EV of the win rate printed on the card at the American price printed
 * next to it. The unrounded cover can print 63.4% and 8.1% together.
 */
function evAtShownPrice(prob, american) {
  const shown = shownFraction(prob);
  const dec = americanToDecimal(numericAmerican(american));
  if (shown == null || !Number.isFinite(dec) || !(dec > 1)) return null;
  return shown * dec - 1;
}

function printedPct(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text.includes('%') ? text : null;
}

/** Same game, side, price, and line as a published straight. */
function sameBetStraight(leg, straights) {
  if (!leg || !Array.isArray(straights)) return null;
  for (const straight of straights) {
    if (!straight || !parlayIsCardMirror([leg], [straight])) continue;
    const legOdds = numericAmerican(leg.odds);
    const straightOdds = numericAmerican(straight.odds != null ? straight.odds : straight.oddsStr);
    if (legOdds != null && straightOdds != null && legOdds !== straightOdds) continue;
    const legLine = leg.line != null && leg.line !== '' ? Number(leg.line) : null;
    const straightLine = straight.line != null && straight.line !== '' ? Number(straight.line) : null;
    if (Number.isFinite(legLine) && Number.isFinite(straightLine) && Math.abs(legLine - straightLine) > 1e-9) continue;
    return straight;
  }
  return null;
}

function publishGatedLeg(leg, straights) {
  const base = { ...leg };
  // publishLeg returns a pick object unchanged. Price from the candidate
  // fields so the card leg does not carry the book ladder.
  delete base.pick;
  delete base.bookPrices;
  delete base.hardRock;
  const published = publishLeg(base);
  published.odds = formatAmerican(leg.odds);
  published.coverProb = `${(leg.coverProb * 100).toFixed(1)}%`;
  published.p_cal = +Number(leg.coverProb).toFixed(6);
  const shownLegEv = evAtShownPrice(leg.coverProb, published.odds);
  const shownEvStr = formatEdgePct(shownLegEv != null ? shownLegEv : Number(leg.ev))
    || `${(Number(leg.ev) * 100).toFixed(1)}%`;
  // evRaw stays the unrounded stake EV. Grading below uses that edge too.
  published.evRaw = +Number(leg.ev).toFixed(6);
  const cover = unifiedCoverProb(leg);
  const edgeFrac = edgeFractionOf(leg, cover);
  // Same one-decimal cover rule as the straight badge. The stored edge
  // used for rank and grade is edgeFrac, not this display string.
  const computed = printedEdgeEv({
    coverProb: cover,
    odds: numericAmerican(leg.odds),
    edgePct: edgeFrac,
    ev: leg.ev,
  });
  const straight = sameBetStraight(leg, straights);
  const straightEdge = printedPct(straight && (straight.edge != null && straight.edge !== '' ? straight.edge : straight.edgePct));
  const straightEv = printedPct(straight && straight.ev);
  // The straight badge already rounded this bet. Copy that cover string too,
  // so a p_cal that moved the tenth (0.64749 → 0.6475) does not print 64.8%
  // next to the straight's 5.5% edge. p_cal and evRaw stay on the leg.
  const straightCover = printedPct(straight && straight.coverProb);
  if (straightCover) published.coverProb = straightCover;
  const edgeStr = straightEdge || computed.edgePctStr || formatEdgePct(edgeFrac) || published.edgePct || null;
  published.ev = straightEv || shownEvStr;
  const rating = normalizeRatingKey(leg.rating || leg.qualityGrade || leg.grade)
    || qualityToRating(edgeFrac, null, null);
  published.edgePct = edgeStr || published.edgePct;
  published.edge = edgeStr;
  published.rating = rating;
  published.qualityGrade = rating;
  published.grade = ratingLetter(rating);
  published.book = published.book || leg.book || null;
  published.sport = published.sport || leg.sport || null;
  published.matchup = published.matchup || leg.matchup || null;
  published.pick = published.pick || formatMoneylinePick(leg.side || leg.pick, leg.market || leg.betType);
  if (published.confidence == null) published.confidence = ratingToConfidence(rating);
  if (!published.gameTime) {
    published.gameTime = formatGameTimeET(published.commenceTime || leg.commenceTime) || null;
  }
  published.probBasis = 'unified-adjusted-cover';
  if (leg.hardRockRepriced) published.hardRockRepriced = true;
  if (leg.tier) published.tier = leg.tier;
  Object.assign(published, fairPickFields(leg));
  // Defensive copy. Missing flags mean the fair is valid. Do not invent them.
  if (leg.fairSoft === true) published.fairSoft = true;
  if (leg.evAtFairValid === false) published.evAtFairValid = false;
  return published;
}

/** American payout from the product of each leg's decimal odds. */
function combinedFromLegOdds(legs) {
  let dec = 1;
  for (const leg of legs || []) {
    const american = numericAmerican(leg && leg.odds);
    const d = americanToDecimal(american);
    if (!(d > 1)) return null;
    dec *= d;
  }
  if (!(dec > 1)) return null;
  const american = decimalToAmerican(dec);
  return {
    combinedDecimal: dec,
    combinedOdds: american == null ? '' : formatAmerican(american),
  };
}

/**
 * One card leg at the unified adjusted cover. Hard Rock and the edge
 * floor are not required. Stake EV is cover × decimal − 1.
 */
function priceCardLeg(row) {
  if (!row) return null;
  const prob = unifiedCoverProb(row);
  const odds = numericOdds(row.odds != null ? row.odds : row.oddsStr);
  if (!Number.isFinite(prob) || !Number.isFinite(odds)) return null;
  const dec = americanToDecimal(odds);
  if (!Number.isFinite(dec) || !(dec > 1)) return null;
  const edge = edgeFractionOf(row, prob);
  return {
    ...row,
    side: row.side || row.pick,
    market: row.market || row.betType,
    odds,
    coverProb: prob,
    p_cal: prob,
    ev: prob * dec - 1,
    edgePct: Number.isFinite(edge) ? edge : row.edgePct,
    matchup: row.matchup || `${row.awayTeam} @ ${row.homeTeam}`,
  };
}

/**
 * A parlay leg on the pure-model card. Cover at or above PARLAY_MIN_COVER,
 * stake EV positive and at or under the EV cap, and not a sport the
 * margin check already banned. Rank is probability edge.
 */
function parlayLegQualifies(leg) {
  if (!leg || leg.marginBiasExtreme) return false;
  const cover = Number(leg.coverProb);
  if (!(Number.isFinite(cover) && cover + 1e-12 >= PARLAY_MIN_COVER)) return false;
  const ev = Number(leg.ev);
  if (!(Number.isFinite(ev) && ev > 1e-12)) return false;
  const maxEV = Number(EV_CAP_ALL);
  if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return false;
  return true;
}

/**
 * The two published straights, when that is the whole card. Cover may sit
 * under 45%. Each leg still needs positive stake EV at or under the EV cap, a
 * price, and its own game. A negative-EV straight does not make a ticket.
 */
function twoTeamFromPublished(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) return null;
  const priced = [];
  const games = new Set();
  const maxEV = Number(EV_CAP_ALL);
  for (const row of rows) {
    if (row && row.marginBiasExtreme) return null;
    const leg = priceCardLeg(row);
    if (!leg || leg.marginBiasExtreme) return null;
    const ev = Number(leg.ev);
    if (!(ev > 1e-12)) return null;
    if (Number.isFinite(maxEV) && ev > maxEV + 1e-12) return null;
    const key = matchupKey(leg);
    if (!key || games.has(key)) return null;
    games.add(key);
    priced.push(leg);
  }
  return priced.length === 2 ? priced : null;
}

/**
 * Both-EV rule for every ticket size. Not FITTED. The cut is the sign of
 * EV, not a tuned hurdle.
 * Model EV is comboStats.ev: product of final p, times 0.95^(n-1)
 * (CORR_HAIRCUT_PER_LEG, ASSUMED same-model-bias), times the parlay decimal,
 * minus 1. evAtFair is the product of no-vig fair probs times that decimal,
 * minus 1, with no haircut.
 * A real ticket needs model EV > 0 and, when the fair number exists, EV at
 * fair > 0. That stake is the one already chosen (full card 0.5u, lean card
 * 0.25u). Either test failing still publishes (10/10 never-block) but only
 * as a lean at LEAN_PARLAY_UNITS (the existing 0.25u minimum).
 * Fair EV <= 0, or a soft/invalid fair (not available), uses FAIR_LEAN_LABEL.
 * Fair that is positive while model EV is not uses MODEL_LEAN_LABEL.
 * A missing fair price is not a negative: Number(null) is 0 and would fake
 * a lean. Absent fairSoft / evAtFairValid means the fair is valid.
 */
const FAIR_LEAN_LABEL = 'lean - negative EV at fair price';
const MODEL_LEAN_LABEL = 'lean - model EV not positive after haircut';

function ticketModelEv(ticket) {
  if (!ticket) return null;
  if (ticket.evRaw != null && ticket.evRaw !== '') {
    const raw = Number(ticket.evRaw);
    if (Number.isFinite(raw)) return raw;
  }
  const parsed = parseEdgeFraction(ticket.evAtModel != null ? ticket.evAtModel : ticket.ev);
  return Number.isFinite(parsed) ? parsed : null;
}

function stampFairParlay(ticket, evAtFair) {
  if (!ticket || !Array.isArray(ticket.legs) || ticket.legs.length < 2) return ticket;
  const n = ticket.legs.length;
  const soft = ticket.fairSoft === true || ticket.legs.some(fairIsSoft);
  // null is a missing fair price. Number(null) is 0, which would fake a lean.
  let fair = null;
  if (!soft && evAtFair != null && evAtFair !== '') {
    const num = Number(evAtFair);
    if (Number.isFinite(num)) fair = num;
  }
  const model = ticketModelEv(ticket);
  const modelOk = model == null ? true : model > 0;
  const fairBlocks = soft || (fair != null && !(fair > 0));
  if (modelOk && !fairBlocks) {
    // A finite positive fair is what makes isLean explicit. A missing fair
    // price leaves isLean unset, same as before this rule.
    if (fair != null && fair > 0) {
      ticket.isLean = false;
      if (ticket.label === FAIR_LEAN_LABEL || ticket.label === MODEL_LEAN_LABEL || ticket.label === 'combined EV not positive') {
        delete ticket.label;
        delete ticket.leanDay;
      }
      if (typeof ticket.type === 'string' && ticket.type.endsWith('-labeled')) {
        ticket.type = `${n}-leg-parlay`;
      }
    }
    return ticket;
  }
  // Fair failure wins the label when both fail. Soft fair is not available,
  // so it is not a real ticket even if a stale fair product would be positive.
  const label = fairBlocks ? FAIR_LEAN_LABEL : MODEL_LEAN_LABEL;
  const stake = Number(LEAN_PARLAY_UNITS);
  const units = Number.isFinite(stake) ? stake : 0.25;
  ticket.isLean = true;
  ticket.leanDay = true;
  ticket.label = label;
  ticket.qualifying = true;
  ticket.type = `${n}-leg-parlay-labeled`;
  ticket.units = `${units}u`;
  ticket.riskDollars = stakeDollars(units);
  if (ticket.combinedOdds) ticket.toWinDollars = toWinDollars(units, ticket.combinedOdds);
  return ticket;
}

function ticketFromLegs(chosen, rows, opts) {
  const st = comboStats(chosen);
  const anchor = require('./config').marketAnchorOn();
  if (anchor && !(st.ev > 0) && !(chosen.length === 3 && Number.isFinite(st.evAtFair))) {
    return [noQualifyingParlay('combined EV not positive')];
  }
  const straightIds = new Set(rows.map((row) => parlaySideId(row)));
  const mirrored = rows.length >= chosen.length
    && chosen.every((leg) => straightIds.has(parlaySideId(leg)));
  const labelInput = { ...st, legs: chosen };
  const evLabel = parlayEvLabel(labelInput);
  const publishedLegs = chosen.map((leg) => publishGatedLeg(leg, rows));
  const fromLegs = combinedFromLegOdds(publishedLegs);
  const combinedDecimal = fromLegs ? fromLegs.combinedDecimal : st.combinedDecimal;
  const combinedOdds = fromLegs
    ? fromLegs.combinedOdds
    : (decimalToAmerican(st.combinedDecimal) == null ? '' : formatAmerican(decimalToAmerican(st.combinedDecimal)));
  const stakeUnits = publishedParlayUnits(rows);
  const n = chosen.length;
  const modelEvStr = formatEdgePct(st.evAtModel != null ? st.evAtModel : st.ev);
  const ticket = {
    type: `${n}-leg-parlay`,
    legs: publishedLegs,
    units: `${stakeUnits}u`,
    qualifying: true,
    combinedOdds,
    combinedDecimal: Number.isFinite(combinedDecimal) ? +combinedDecimal.toFixed(2) : null,
    evLabel,
    riskDollars: stakeDollars(stakeUnits),
    toWinDollars: toWinDollars(stakeUnits, combinedOdds),
    combinedProb: Number.isFinite(st.combinedProb) ? `${(st.combinedProb * 100).toFixed(1)}%` : '',
    combinedProbRaw: Number.isFinite(st.combinedProb) ? st.combinedProb : null,
    ev: modelEvStr || '',
    evAtModel: modelEvStr,
    evAtFair: st.evAtFair == null ? null : formatEdgePct(st.evAtFair),
    evRaw: Number.isFinite(st.ev) ? st.ev : null,
    uniqueGames: st.uniqueGames,
    uniqueSports: st.uniqueSports,
    independent: parlayIndependent(labelInput),
    mirrorsCard: mirrored,
    legMarkets: chosen.map((leg) => leg.market || leg.betType || null),
    correlationNote: evLabel,
    candidatesScanned: chosen.length,
    autoCorrected: !mirrored,
    probBasis: 'unified-adjusted-cover',
    evBasis: 'combined-prob-times-decimal-minus-1',
    source: 'omega-vnext',
  };
  if (opts && opts.hrPlaceabilityNote) ticket.hrPlaceabilityNote = opts.hrPlaceabilityNote;
  if (chosen.some(fairIsSoft)) ticket.fairSoft = true;
  if (n >= 2) stampFairParlay(ticket, st.evAtFair);
  const labeled = ticket.isLean === true;
  if (!mirrored || labeled) {
    const names = chosen.map((leg) => leg.side || leg.pick).join(' | ');
    console.log(`[omega-vnext] parlay ${labeled ? 'labeled' : 'auto-correct'} ev=${ticket.ev} legs=${names}`);
  }
  return [ticket];
}

/**
 * Day's parlay board. Not a fitted sample size: the product top-10, the same
 * list selectTop10 / selectStraights ranks by anchored stake EV (compareByEv).
 */
const PARLAY_TOP_N = 10;

function rankView(leg) {
  return {
    ev: leg && leg._rankEv,
    edgePct: leg && leg.edgePct,
    _pmScoreAdj: leg && leg._pmScoreAdj,
  };
}

/** -250/+250 inclusive. Same band as GATES. Not refit here. */
function oddsInPublishBand(odds) {
  const n = numericOdds(odds);
  if (!Number.isFinite(n)) return false;
  const min = Number(GATES && GATES.minAmericanOdds);
  const max = Number(GATES && GATES.maxAmericanOdds);
  if (Number.isFinite(min) && n < min) return false;
  if (Number.isFinite(max) && n > max) return false;
  return true;
}

/**
 * Live and in-play are not pregame. A missing clock is not a start: the
 * slate gate already ran, and Date.now() would drop a stored card whose
 * kickoff is earlier than this process.
 */
function isPregameLeg(row) {
  if (!row) return false;
  if (row.inPlay === true || row.live === true || row.in_play === true) return false;
  const st = String(row.priceState || row.marketStatus || row.status || '').trim().toLowerCase();
  if (st === 'live' || st === 'in-play' || st === 'inplay' || st === 'in-progress-or-started') return false;
  return true;
}

/**
 * Top 10 distinct games. Rank is the anchored stake EV already on the row
 * (compareByEv, the same order selectStraights uses). The bet-price EV from
 * priceCardLeg is the inclusion test: positive, at or under EV_CAP_ALL (10%,
 * ASSUMED), inside -250/+250, pregame, one leg per game. A margin-bias ban
 * is not a leg. Cover is not re-gated here.
 * Straights and the pool are one board. The published card is not the only source.
 */
function eligibleParlayLegs(straights, pool) {
  const byId = new Map();
  const rows = [].concat(straights || [], pool || []);
  for (const row of rows) {
    if (!row || row.marginBiasExtreme) continue;
    if (!isPregameLeg(row)) continue;
    const priced = priceCardLeg(row);
    if (!priced || priced.marginBiasExtreme) continue;
    if (!isPregameLeg(priced)) continue;
    const betEv = Number(priced.ev);
    if (!(betEv > 1e-12)) continue;
    const maxEV = Number(EV_CAP_ALL);
    if (Number.isFinite(maxEV) && betEv > maxEV + 1e-12) continue;
    if (!oddsInPublishBand(priced.odds)) continue;
    const stored = Number(row.ev);
    // Stored ev is the anchored stake EV selectStraights ranks. A percent
    // string does not parse; the bet-price EV is then the rank.
    priced._rankEv = Number.isFinite(stored) ? stored : betEv;
    const id = parlaySideId(priced);
    const prev = byId.get(id);
    if (!prev || compareByEv(rankView(priced), rankView(prev)) < 0) byId.set(id, priced);
  }
  const byGame = new Map();
  const ranked = [...byId.values()].sort((a, b) => compareByEv(rankView(a), rankView(b)));
  for (const leg of ranked) {
    const key = matchupKey(leg);
    if (!key || byGame.has(key)) continue;
    byGame.set(key, leg);
    if (byGame.size >= PARLAY_TOP_N) break;
  }
  return [...byGame.values()];
}

/**
 * Highest model EV after the haircut. A tie keeps the higher EV at fair,
 * then the earlier rank order. Neither tie-break is a fitted weight.
 * predicate selects which combos are allowed. uniqueGames is one leg per game.
 */
function bestModelCombo(legs, size, predicate) {
  let best = null;
  for (const combo of enumerateCombos(legs, size)) {
    const st = comboStats(combo);
    if (st.uniqueGames !== combo.length) continue;
    if (predicate && !predicate(st, combo)) continue;
    const fair = Number.isFinite(st.evAtFair) ? st.evAtFair : -Infinity;
    if (!best || st.ev > best.ev + 1e-12) {
      best = { legs: combo, ...st, _fairKey: fair };
      continue;
    }
    if (best && Math.abs(st.ev - best.ev) <= 1e-12 && fair > best._fairKey + 1e-12) {
      best = { legs: combo, ...st, _fairKey: fair };
    }
  }
  return best;
}

/**
 * Real ticket: model EV after the haircut > 0, and EV at fair > 0 when that
 * number exists. A soft or invalid fair is not available, so the combo is
 * not real. A missing p_fair leaves evAtFair null and does not invent a
 * negative (see stampFairParlay).
 */
function comboPassesReal(st, legs) {
  if (!st || !(st.ev > 0)) return false;
  if ((legs || []).some(fairIsSoft)) return false;
  if (st.evAtFair == null) return true;
  return st.evAtFair > 0;
}

function tooFewLegsReason(n) {
  const found = n === 1 ? 'only 1 candidate is' : 'none of the top 10 ranked candidates are';
  return `fewer than 2 eligible legs: ${found} pregame, positive EV at the bet price, inside the 10% cap, and inside -250/+250`;
}

/**
 * Published parlay from the day's top 10, not only the straights.
 * Prefer a 3-leg when some 3-leg passes both EV tests (model after the
 * haircut, and fair). Otherwise the best 2-leg that passes both. A 2-leg
 * that fails is not forced as a real ticket. If nothing passes and at least
 * two legs exist, the best 2-leg by model EV still publishes as a lean at
 * 0.25u. Fewer than two eligible legs is no parlay, with a reason.
 * Among tickets of one size, the highest model EV after the haircut wins.
 * A passing 3-leg beats every 2-leg, even when the 2-leg EV is higher.
 */
function parlayFromStraights(straights, opts = {}) {
  const rows = (straights || []).filter(Boolean);
  const pool = (opts && opts.pool) || [];
  if (!rows.length && !(pool && pool.length)) return [];
  const eligible = eligibleParlayLegs(rows, pool);
  if (eligible.length < 2) return [noQualifyingParlay(tooFewLegsReason(eligible.length))];
  const finish = (chosen) => {
    const ticket = ticketFromLegs(chosen, rows, opts);
    if (ticket[0] && ticket[0].qualifying !== false) ticket[0].candidatesScanned = eligible.length;
    return ticket;
  };
  const real3 = eligible.length >= 3 ? bestModelCombo(eligible, 3, comboPassesReal) : null;
  if (real3) return finish(real3.legs);
  const real2 = bestModelCombo(eligible, 2, comboPassesReal);
  if (real2) return finish(real2.legs);
  // 10/10 never-block. Best 2-leg by model EV, including a negative one.
  // Not a 3-leg: a failing 3-leg is not the fallback.
  const lean2 = bestModelCombo(eligible, 2, () => true);
  if (!lean2) return [noQualifyingParlay('no 2-leg combination from the eligible legs')];
  return finish(lean2.legs);
}

module.exports = {
  optimizeParlay, parlayFromStraights, comboStats, enumerateCombos, preferHit, parlayIsCardMirror,
  sameDirectionTotalFactor, correlatedTotalFactor, legsConflict, bestEdgeLegs, legEdge,
  passesParlayCandidate, isNoQualifyingParlay, unifiedCoverProb, priceParlayLeg,
  parlayEvLabel, parlayIndependent,
  ticketFromLegs, stampFairParlay,
  NO_QUALIFYING_PARLAY,
  FAIR_LEAN_LABEL, MODEL_LEAN_LABEL,
};
