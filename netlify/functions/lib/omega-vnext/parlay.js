'use strict';

const { KELLY_FRACTION, PARLAY_FIXED_UNITS } = require('./config');
const {
  americanToDecimal, decimalToAmerican, formatAmerican, kellyFraction, kellyToUnits,
  formatMoneylinePick, formatEdgePct, ratingToConfidence, evAtOdds,
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

function marketFamily(market) {
  const s = String(market || '');
  if (/total/i.test(s)) return 'total';
  if (/spread|puck|run line/i.test(s)) return 'spread';
  return 'ml';
}

function totalSideOf(side) {
  const s = String(side || '');
  if (/^over\b/i.test(s)) return 'over';
  if (/^under\b/i.test(s)) return 'under';
  return null;
}

function teamOf(side, market) {
  let s = String(side || '').replace(/\s+ml$/i, '').trim();
  if (marketFamily(market) === 'total') return null;
  if (marketFamily(market) === 'spread') {
    const m = s.match(/^(.*)\s+[+-]?\d+(?:\.\d+)?$/);
    if (m) s = m[1];
  }
  return s.trim().toLowerCase();
}

function spreadSignOf(side, market) {
  if (marketFamily(market) !== 'spread') return '';
  const m = String(side || '').match(/([+-]?\d+(?:\.\d+)?)\s*$/);
  if (!m) return '';
  const n = Number(m[1]);
  if (n > 0) return 'plus';
  if (n < 0) return 'minus';
  return 'pk';
}

/** Same game, same market, same side. The straight itself is not a conflict. */
function sameStraightLeg(a, b) {
  if (!a || !b) return false;
  if (matchupKey(a) !== matchupKey(b)) return false;
  const ma = marketFamily(a.market || a.betType);
  const mb = marketFamily(b.market || b.betType);
  if (ma !== mb) return false;
  const sa = a.side || a.pick;
  const sb = b.side || b.pick;
  if (ma === 'total') {
    const ta = totalSideOf(sa);
    const tb = totalSideOf(sb);
    return !!ta && ta === tb;
  }
  const teamA = teamOf(sa, a.market || a.betType);
  const teamB = teamOf(sb, b.market || b.betType);
  if (!teamA || teamA !== teamB) return false;
  if (ma === 'spread') return spreadSignOf(sa, a.market || a.betType) === spreadSignOf(sb, b.market || b.betType);
  return true;
}

/**
 * Opposite side of a straight's game+market, or a negatively correlated
 * outcome in that game: the other team on a moneyline or spread, or the
 * other side of a total. The straight's own side is allowed.
 */
function conflictsWithStraight(leg, straight) {
  if (!leg || !straight) return false;
  if (matchupKey(leg) !== matchupKey(straight)) return false;
  if (sameStraightLeg(leg, straight)) return false;
  const lm = marketFamily(leg.market || leg.betType);
  const sm = marketFamily(straight.market || straight.betType);
  if (lm === sm) return true;
  const lt = totalSideOf(leg.side || leg.pick);
  const st = totalSideOf(straight.side || straight.pick);
  if (lt && st && lt !== st) return true;
  if (lm !== 'total' && sm !== 'total') {
    const teamL = teamOf(leg.side || leg.pick, leg.market || leg.betType);
    const teamS = teamOf(straight.side || straight.pick, straight.market || straight.betType);
    if (teamL && teamS && teamL !== teamS) return true;
  }
  return false;
}

function conflictsWithAnyStraight(leg, straights) {
  return (straights || []).some(st => conflictsWithStraight(leg, st));
}

function straightHits(legs, straights) {
  if (!straights || !straights.length) return 0;
  let n = 0;
  for (const leg of legs || []) {
    if (straights.some(st => sameStraightLeg(leg, st))) n += 1;
  }
  return n;
}

function dkHrAmerican(c) {
  const px = c && c.bestDkHr;
  if (px && Number.isFinite(Number(px.american))) return Number(px.american);
  return null;
}

function rejectionOf(row, reason) {
  return {
    matchup: row.matchup || null,
    side: row.side || row.pick || null,
    market: row.market || row.betType || null,
    sport: row.sport || null,
    reason,
  };
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
function preferQualifying(a, b) {
  if (!b) return true;
  const ds = (a.straightHits || 0) - (b.straightHits || 0);
  if (ds > 0) return true;
  if (ds < 0) return false;
  return preferHit(a, b);
}

function optimizeParlay(yesPool, straights = [], opts = {}) {
  const cardDate = opts.cardDate || opts.dateISO || null;
  const pool = (yesPool || [])
    .filter(c => Number.isFinite(c.coverProb) && Number.isFinite(Number(c.odds)) && c.ev > 0)
    .filter(c => !conflictsWithAnyStraight(c, straights))
    .filter(c => !cardDate || (c.commenceTime && isSameEtDay(c.commenceTime, cardDate)))
    .map(c => {
      const dk = dkHrAmerican(c);
      return {
        ...c,
        side: c.side,
        market: c.market,
        odds: dk != null ? dk : c.odds,
        coverProb: c.coverProb,
        matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
        sport: c.sport,
        commenceTime: c.commenceTime || '',
      };
    })
    // Prefer higher coverProb for hit-rate; keep +EV
    .sort((a, b) => (b.coverProb - a.coverProb) || (b.ev - a.ev));

  // Cap search pool for runtime. Straight sides stay in even when the cap bites.
  const pinned = pool.filter(c => straightHits([c], straights) > 0);
  const rest = pool.filter(c => straightHits([c], straights) === 0);
  const search = pinned.concat(rest).slice(0, Math.max(24, pinned.length));
  if (search.length < 2) return [];

  const scoreCombo = (legs) => {
    const st = comboStats(legs);
    if (st.ev <= 0) return null;
    // Clean = one leg per game. A 3-leg must be three games.
    if (st.uniqueGames !== legs.length) return null;
    return { legs, ...st, straightHits: straightHits(legs, straights) };
  };

  let best3 = null;
  for (const legs of enumerateCombos(search, 3)) {
    const s = scoreCombo(legs);
    if (!s) continue;
    if (preferQualifying(s, best3)) best3 = s;
  }

  let best2 = null;
  if (!best3) {
    for (const legs of enumerateCombos(search, 2)) {
      const s = scoreCombo(legs);
      if (!s) continue;
      if (preferQualifying(s, best2)) best2 = s;
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
  const dk = dkHrAmerican(leg);
  const odds = dk != null ? dk : parseAmerican(leg.odds);
  const coverProb = parseProb(leg.coverProb != null ? leg.coverProb : leg.winProbability);
  let ev = coverProb != null && odds != null ? evAtOdds(coverProb, odds) : null;
  if (ev == null) ev = parseProb(leg.ev);
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
  const lean = !!meta.lean;
  const qualifying = !lean && rawLegs.length >= 3 && rawLegs.every(l => (l.ev || 0) > 1e-12) && st.ev >= -1e-12;
  const kind = lean ? 'lean' : (independent ? 'optimized' : 'straight');
  return {
    type: `${legs.length}-leg-parlay-${kind}`,
    legs,
    units: `${stake}u`,
    combinedOdds,
    combinedDecimal: +st.combinedDecimal.toFixed(2),
    combinedProb: `${(st.combinedProb * 100).toFixed(1)}%`,
    ev: `${(st.ev * 100).toFixed(1)}%`,
    uniqueGames: st.uniqueGames,
    uniqueSports: st.uniqueSports,
    independent,
    qualifying,
    lean,
    ...(lean ? { flag: 'parlay-lean', label: 'lean' } : {}),
    legMarkets: rawLegs.map(l => l.market),
    correlationNote: lean
      ? `Lean — best non-conflicting ${legs.length}-leg by joint EV. Not a qualifying +EV parlay.`
      : `CLV-first de-correlated — ${legs.length} legs / ${st.uniqueGames} games`,
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

function pushUnique(rows, seen, row) {
  if (!row) return;
  const key = positionKey(row);
  if (seen.has(key)) return;
  seen.add(key);
  rows.push(row);
}

/**
 * Best combo of `size` legs. Qualifying rank prefers straight sides, then
 * hit probability. Lean rank is joint EV. One leg per game either way.
 */
function bestSizedCombo(pool, straights, size, rank) {
  let best = null;
  for (const legs of enumerateCombos(pool, size)) {
    const st = comboStats(legs);
    if (st.uniqueGames !== legs.length) continue;
    const row = { legs, ...st, straightHits: straightHits(legs, straights) };
    if (rank === 'ev') {
      if (!best || row.ev > best.ev + 1e-12 || (Math.abs(row.ev - best.ev) <= 1e-12 && preferQualifying(row, best))) {
        best = row;
      }
    } else if (preferQualifying(row, best)) {
      best = row;
    }
  }
  return best;
}

function legsQualify(rawLegs) {
  if (!rawLegs || rawLegs.length < 3) return false;
  if (!rawLegs.every(l => (l.ev || 0) > 1e-12)) return false;
  return comboStats(rawLegs).ev >= -1e-12;
}

/**
 * One leg per game until `n`. A second market on a game is allowed only when
 * the non-conflicting board has fewer than 3 games and still has `n` sides,
 * matching the straight never-block fill.
 */
function takeLegs(pool, n, allowSecond, straights) {
  const ranked = [...(pool || [])].sort((a, b) => {
    const hs = straightHits([b], straights) - straightHits([a], straights);
    if (hs) return hs;
    const ev = (b.ev || 0) - (a.ev || 0);
    if (Math.abs(ev) > 1e-12) return ev;
    return (b.coverProb || 0) - (a.coverProb || 0);
  });
  const picked = [];
  const gameCount = new Map();
  const used = new Set();
  const cap = allowSecond ? 2 : 1;
  for (const c of ranked) {
    if (picked.length >= n) break;
    const key = positionKey(c);
    if (used.has(key)) continue;
    const g = matchupKey(c);
    const seen = gameCount.get(g) || 0;
    if (seen >= cap) continue;
    picked.push(c);
    used.add(key);
    gameCount.set(g, seen + 1);
  }
  return picked;
}

/**
 * Publish a 3-leg when the board has one. A qualifying slip is three
 * non-conflicting +EV legs whose joint EV is at least 0, preferring the
 * straights themselves. Otherwise the best non-conflicting 3-leg by joint
 * EV still publishes as a 0.5u lean (flag parlay-lean). Never blocks the card.
 * Exclusions are hung on the returned array as parlayExclusions.
 */
function ensureCardParlay(pool, straights, opts = {}) {
  const cardDate = opts.cardDate || opts.dateISO || null;
  const exclusions = [];
  const raw = [];
  const seen = new Set();
  for (const c of pool || []) {
    if (!onCardDate(c, cardDate)) continue;
    if (!dkHrPriced(c)) continue;
    pushUnique(raw, seen, legToRaw(c));
  }
  for (const s of straights || []) {
    const row = legToRaw(s);
    if (!row) continue;
    if (row.commenceTime && !onCardDate(row, cardDate)) continue;
    pushUnique(raw, seen, row);
  }

  const allowed = [];
  for (const row of raw) {
    if (conflictsWithAnyStraight(row, straights)) {
      exclusions.push(rejectionOf(row, 'conflict-with-straight'));
      continue;
    }
    allowed.push(row);
  }

  const positive = allowed.filter(r => (r.ev || 0) > 1e-12);
  const games = new Set(allowed.map(matchupKey));
  let ticket = null;

  if (positive.length >= 2) {
    const qualifying = bestSizedCombo(positive, straights, 3, 'hit');
    if (qualifying && legsQualify(qualifying.legs)) {
      ticket = ticketFromRawLegs(qualifying.legs, straights, { candidatesScanned: positive.length });
    } else {
      const primary = optimizeParlay(positive, straights, { ...opts, cardDate });
      const primaryRaw = primary[0] && (primary[0].legs || []).map(legToRaw).filter(Boolean);
      if (primaryRaw && legsQualify(primaryRaw)) {
        ticket = ticketFromRawLegs(primaryRaw, straights, { candidatesScanned: positive.length });
      }
    }
  }

  if (!ticket && games.size >= 3) {
    const lean = bestSizedCombo(allowed, straights, 3, 'ev');
    if (lean && lean.legs.length === 3) {
      const ok = legsQualify(lean.legs);
      ticket = ticketFromRawLegs(lean.legs, straights, {
        candidatesScanned: allowed.length,
        lean: !ok,
      });
    }
  }

  if (!ticket && allowed.length >= 3 && games.size < 3) {
    const picked = takeLegs(allowed, 3, true, straights);
    if (picked.length >= 3) {
      ticket = ticketFromRawLegs(picked, straights, {
        candidatesScanned: allowed.length,
        lean: !legsQualify(picked),
      });
    }
  }

  if (!ticket && positive.length >= 2) {
    const primary = optimizeParlay(positive, straights, { ...opts, cardDate });
    if (primary[0]) ticket = primary[0];
  }

  const used = new Set();
  for (const leg of (ticket && ticket.legs) || []) {
    const row = legToRaw(leg);
    if (row) used.add(positionKey(row));
  }
  for (const row of allowed) {
    if (used.has(positionKey(row))) continue;
    exclusions.push(rejectionOf(row, 'parlay-excluded'));
  }

  const out = ticket ? [ticket] : [];
  out.parlayExclusions = exclusions;
  return out;
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
  const straightCard = opts.straights || [];
  for (const c of pool) {
    const row = legToRaw(c);
    if (!row) continue;
    if (removed.has(ticketName(row.side))) continue;
    if (conflictsWithAnyStraight(row, straightCard)) continue;
    if (conflictsWithAnyStraight(row, keptRaw)) continue;
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
  conflictsWithStraight,
  sameStraightLeg,
};
