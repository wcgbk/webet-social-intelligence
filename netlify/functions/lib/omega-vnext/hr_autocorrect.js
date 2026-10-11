'use strict';

/**
 * Verify auto-correct against Hard Rock.
 *
 * A material line or price gap (more than half a point, or more than 6
 * implied points worse) is not a warning that keeps the published number.
 * The pick is repriced at Hard Rock's line and price. Edge is cover minus
 * the de-vigged fair at that number, then the odds-scaled floor. If it
 * still clears, the pick stays at the Hard Rock number. If it does not,
 * the next candidate confirmed at Hard Rock replaces it. The parlay is
 * rebuilt: straights stay the top edges, and the parlay is the best edges
 * on distinct games. Every change is logged. The card is not withheld.
 */

const { SPORT_SPREAD_STD, SPORT_TOTAL_STD, GATES, LEAN_MIN_EV, LEAN_MAX_UNITS } = require('./config');
const { americanToImplied, formatAmerican, normCdf, parseEdgeFraction, clamp } = require('./odds_math');
const { attachEv } = require('./edge');
const { toPickObject } = require('./select');
const { optimizeParlay } = require('./parlay');
const { minEdgeFor } = require('./edge_floor');

const HR_KEYS = new Set(['hardrockbet', 'hardrockbet_oh', 'hardrock']);
const POINT_MATERIAL = 0.5;
const PRICE_MATERIAL_PP = 6;

function lastWord(name) {
  return String(name || '').trim().split(/\s+/).pop().toLowerCase();
}

function parseAmerican(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9\-+]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function coverFraction(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? v / 100 : v;
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function edgeOf(c) {
  if (!c) return null;
  if (typeof c.edgePct === 'number' && Number.isFinite(c.edgePct)) {
    return c.edgePct > 1 ? c.edgePct / 100 : c.edgePct;
  }
  if (typeof c.edge === 'number' && Number.isFinite(c.edge)) {
    return c.edge > 1 ? c.edge / 100 : c.edge;
  }
  return parseEdgeFraction(c.edgePct != null ? c.edgePct : c.edge);
}

function family(label) {
  const s = String(label || '').trim();
  if (/^over\b/i.test(s)) return 'over';
  if (/^under\b/i.test(s)) return 'under';
  return s.replace(/[-+]?\d+(\.\d+)?\s*$/, '').trim().toLowerCase();
}

function sideKey(c) {
  const matchup = String((c && c.matchup) || '').toLowerCase();
  const side = String((c && (c.pick || c.side)) || '').toLowerCase();
  const market = String((c && (c.market || c.betType)) || '').toLowerCase();
  return `${matchup}|${market}|${side}`;
}

function marketKeyFor(c) {
  const m = String((c && (c.betType || c.market)) || '');
  if (/total/i.test(m)) return 'totals';
  if (/moneyline|^ml$/i.test(m)) return 'h2h';
  if (/spread/i.test(m)) return 'spreads';
  return null;
}

function relabel(label, point, market) {
  const src = String(label || '');
  const m = String(market || '');
  if (/total/i.test(m) || /^\s*(over|under)\b/i.test(src)) {
    const side = /under/i.test(src) ? 'Under' : 'Over';
    if (!Number.isFinite(Number(point))) return src;
    return `${side} ${Number(point)}`;
  }
  if (/moneyline/i.test(m)) return src;
  if (!Number.isFinite(Number(point))) return src;
  const team = src.replace(/[-+]?\d+(\.\d+)?\s*$/, '').trim();
  const n = Number(point);
  return `${team} ${n > 0 ? `+${n}` : n}`;
}

function matchGame(games, matchup) {
  const m = String(matchup || '').toLowerCase();
  return (games || []).find((g) => {
    const h = String(g.home_team || '').toLowerCase();
    const a = String(g.away_team || '').toLowerCase();
    if (m.includes(lastWord(g.home_team)) && m.includes(lastWord(g.away_team))) return true;
    const hSchool = h.replace(/\s+\S+$/, '');
    const aSchool = a.replace(/\s+\S+$/, '');
    return hSchool.length > 3 && aSchool.length > 3 && m.includes(hSchool) && m.includes(aSchool);
  }) || null;
}

function gamesFor(sportGames, sport) {
  if (!sportGames) return [];
  const rows = sportGames[sport];
  return Array.isArray(rows) ? rows : [];
}

function quoteFor(c, game) {
  const key = marketKeyFor(c);
  if (!key || !game) return null;
  const book = (game.bookmakers || []).find((b) => HR_KEYS.has(String(b.key || '').toLowerCase()));
  if (!book) return null;
  const market = (book.markets || []).find((mk) => mk.key === key);
  if (!market) return null;
  const label = c.pick || c.side || '';
  let outcome = null;
  if (key === 'totals') {
    const side = /under/i.test(label) ? 'Under' : 'Over';
    outcome = (market.outcomes || []).find((o) => o.name === side);
  } else {
    const team = key === 'h2h'
      ? String(label).replace(/\s*ML\s*$/i, '').trim()
      : String(label).replace(/[-+]?\d+(\.\d+)?\s*$/, '').trim();
    outcome = (market.outcomes || []).find((o) => lastWord(o.name) === lastWord(team));
  }
  if (!outcome || !Number.isFinite(Number(outcome.price))) return null;
  return {
    american: Number(outcome.price),
    point: outcome.point != null && outcome.point !== '' ? Number(outcome.point) : null,
  };
}

function material(pick, quote) {
  const pubPoint = pick.line != null && pick.line !== '' ? Number(pick.line) : null;
  if (pubPoint != null && quote.point != null && Math.abs(quote.point - pubPoint) > POINT_MATERIAL + 1e-9) {
    return true;
  }
  const pub = parseAmerican(pick.odds);
  if (pub != null && quote.american != null) {
    const worsePp = (americanToImplied(quote.american) - americanToImplied(pub)) * 100;
    if (worsePp > PRICE_MATERIAL_PP) return true;
  }
  return false;
}

function inverseNorm(p) {
  const target = clamp(p, 0.001, 0.999);
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Move a published cover onto Hard Rock's number when the candidate table
 * has no row at that number. A higher spread point is easier. A higher
 * total is harder for Over and easier for Under. The published fair stays
 * the anchor, so a worse number has to still beat it.
 */
function coverAtNewLine(pick, newPoint) {
  const cover = coverFraction(pick.p_cal != null ? pick.p_cal : (pick.coverProb != null ? pick.coverProb : pick.winProbability));
  const oldPoint = pick.line != null ? Number(pick.line) : null;
  if (!Number.isFinite(cover) || !Number.isFinite(oldPoint) || !Number.isFinite(Number(newPoint))) return cover;
  const market = String(pick.betType || pick.market || '');
  const sport = pick.sport || 'NCAAF';
  let std;
  let sign;
  if (/total/i.test(market)) {
    std = SPORT_TOTAL_STD[sport] || 13.5;
    sign = /under/i.test(pick.pick || pick.side || '') ? 1 : -1;
  } else if (/spread/i.test(market)) {
    std = SPORT_SPREAD_STD[sport] || 16;
    sign = 1;
  } else {
    return cover;
  }
  const z = inverseNorm(cover);
  const dz = sign * (Number(newPoint) - oldPoint) / std;
  return clamp(normCdf(z + dz), 0.02, 0.98);
}

function stakeEv(c) {
  return typeof c.ev === 'number' ? c.ev : parseEdgeFraction(c.ev);
}

/** Full floor: stake EV >= 3% and the odds-scaled edge curve. */
function clears(c) {
  const edge = edgeOf(c);
  const ev = stakeEv(c);
  const cp = coverFraction(c.coverProb);
  if (!Number.isFinite(cp)) return false;
  if (!Number.isFinite(ev) || ev + 1e-12 < (GATES.minEV.default || 0.03)) return false;
  if (!Number.isFinite(edge) || edge <= 0) return false;
  const odds = typeof c.odds === 'number' ? c.odds : parseAmerican(c.odds);
  if (edge + 1e-12 < minEdgeFor(odds, c.uncertainty)) return false;
  return true;
}

/** Lean keep: positive edge and stake EV >= 1.5%. Not a floor play. */
function leanClears(c) {
  const edge = edgeOf(c);
  const ev = stakeEv(c);
  const cp = coverFraction(c.coverProb);
  if (!Number.isFinite(cp) || !Number.isFinite(ev) || ev + 1e-12 < LEAN_MIN_EV) return false;
  if (!Number.isFinite(edge) || edge <= 0) return false;
  return true;
}

function markLean(built) {
  if (!built || !built.pick) return built;
  built.pick.tier = 'lean';
  built.cand.tier = 'lean';
  const u = parseFloat(String(built.pick.units || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(u) && u > LEAN_MAX_UNITS) built.pick.units = `${LEAN_MAX_UNITS}u`;
  return built;
}

function normalizePool(table) {
  return (Array.isArray(table) ? table : []).map((row) => {
    const odds = parseAmerican(row.odds);
    const edge = edgeOf(row);
    const cover = coverFraction(row.coverProb);
    let fair = Number(row.fair_sharp_p);
    if (!Number.isFinite(fair) && Number.isFinite(cover) && Number.isFinite(edge)) fair = cover - edge;
    return {
      ...row,
      odds: Number.isFinite(odds) ? odds : row.odds,
      edgePct: Number.isFinite(edge) ? edge : row.edgePct,
      coverProb: Number.isFinite(cover) ? cover : row.coverProb,
      fair_sharp_p: Number.isFinite(fair) ? fair : row.fair_sharp_p,
      line: row.line != null && row.line !== '' ? Number(row.line) : null,
      side: row.side || row.pick,
      market: row.market || row.betType,
    };
  });
}

function scoreAt(row, quote) {
  const market = row.market || row.betType;
  const line = quote.point != null ? quote.point : row.line;
  const side = relabel(row.side || row.pick, line, market);
  return attachEv({
    ...row,
    side,
    market,
    odds: quote.american,
    line,
    coverProb: coverFraction(row.coverProb),
    fair_sharp_p: Number.isFinite(Number(row.fair_sharp_p)) ? Number(row.fair_sharp_p) : row.fair_sharp_p,
    book: 'hardrockbet',
    placeableBooks: ['hardrockbet'],
  });
}

function pickToCand(pick) {
  const edge = edgeOf(pick);
  const cover = coverFraction(pick.coverProb != null ? pick.coverProb : pick.winProbability);
  let fair = Number(pick.fair_sharp_p);
  if (!Number.isFinite(fair) && Number.isFinite(cover) && Number.isFinite(edge)) fair = cover - edge;
  return {
    sport: pick.sport,
    matchup: pick.matchup,
    side: pick.pick || pick.side,
    market: pick.betType || pick.market,
    odds: parseAmerican(pick.odds),
    line: pick.line != null && pick.line !== '' ? Number(pick.line) : null,
    coverProb: cover,
    ev: parseEdgeFraction(pick.ev),
    edgePct: edge,
    fair_sharp_p: Number.isFinite(fair) ? fair : null,
    commenceTime: pick.commenceTime,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    uncertainty: pick.uncertainty,
    book: pick.book,
    coreReasoning: pick.coreReasoning,
    whatLoses: pick.whatLoses,
  };
}

function sameRow(row, pick) {
  if (String(row.matchup || '').toLowerCase() !== String(pick.matchup || '').toLowerCase()) return false;
  return family(row.side || row.pick) === family(pick.pick || pick.side);
}

function reprice(pick, quote, pool) {
  const hit = (pool || []).find((row) => (
    sameRow(row, pick)
    && row.line != null
    && quote.point != null
    && Math.abs(Number(row.line) - Number(quote.point)) < 0.051
  ));
  let cand;
  if (hit) {
    cand = scoreAt({
      ...hit,
      sport: hit.sport || pick.sport,
      matchup: hit.matchup || pick.matchup,
      homeTeam: hit.homeTeam || pick.homeTeam,
      awayTeam: hit.awayTeam || pick.awayTeam,
      commenceTime: hit.commenceTime || pick.commenceTime,
      uncertainty: hit.uncertainty != null ? hit.uncertainty : pick.uncertainty,
      coreReasoning: pick.coreReasoning,
      whatLoses: pick.whatLoses,
    }, quote);
  } else {
    const fair = Number(pick.fair_sharp_p);
    cand = attachEv({
      sport: pick.sport,
      matchup: pick.matchup,
      market: pick.betType || pick.market,
      side: relabel(pick.pick || pick.side, quote.point, pick.betType || pick.market),
      line: quote.point,
      odds: quote.american,
      coverProb: coverAtNewLine(pick, quote.point),
      fair_sharp_p: Number.isFinite(fair) ? fair : undefined,
      uncertainty: pick.uncertainty,
      commenceTime: pick.commenceTime,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      book: 'hardrockbet',
      coreReasoning: pick.coreReasoning,
      whatLoses: pick.whatLoses,
      p_model: pick.p_model,
    });
  }
  const pickObj = toPickObject(cand, { modelVersion: pick.modelVersion });
  pickObj.coreReasoning = pick.coreReasoning || pickObj.coreReasoning || '';
  pickObj.whatLoses = pick.whatLoses || pickObj.whatLoses || '';
  pickObj.book = 'hardrockbet';
  pickObj.line = quote.point != null ? quote.point : pick.line;
  pickObj.commenceTime = pick.commenceTime || pickObj.commenceTime;
  pickObj.homeTeam = pick.homeTeam || pickObj.homeTeam;
  pickObj.awayTeam = pick.awayTeam || pickObj.awayTeam;
  return { pick: pickObj, cand };
}

function nextBest(pool, sportGames, used) {
  const ranked = [...pool].sort((a, b) => (edgeOf(b) || -Infinity) - (edgeOf(a) || -Infinity));
  for (const row of ranked) {
    if (used.has(sideKey(row))) continue;
    const game = matchGame(gamesFor(sportGames, row.sport), row.matchup);
    if (!game) continue;
    const quote = quoteFor(row, game);
    if (!quote) continue;
    if (quote.point != null && row.line != null && Math.abs(quote.point - Number(row.line)) > POINT_MATERIAL + 1e-9) {
      continue;
    }
    const cand = scoreAt(row, quote);
    if (!clears(cand)) continue;
    const pickObj = toPickObject(cand, { modelVersion: row.modelVersion });
    pickObj.book = 'hardrockbet';
    pickObj.line = quote.point != null ? quote.point : row.line;
    pickObj.commenceTime = row.commenceTime || pickObj.commenceTime;
    pickObj.homeTeam = row.homeTeam;
    pickObj.awayTeam = row.awayTeam;
    pickObj.coreReasoning = row.coreReasoning || '';
    pickObj.whatLoses = row.whatLoses || '';
    return { pick: pickObj, cand };
  }
  return null;
}

function autoCorrectHardRock(picksData, sportGames) {
  const data = picksData || {};
  const picks = Array.isArray(data.picks) ? data.picks.slice() : [];
  const pool = normalizePool(data.candidateTable);
  const log = [];
  const built = [];

  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const game = matchGame(gamesFor(sportGames, pick.sport), pick.matchup);
    const quote = game ? quoteFor(pick, game) : null;
    if (!quote || !material(pick, quote)) {
      built.push({ pick, cand: pickToCand(pick) });
      continue;
    }
    const repriced = reprice(pick, quote, pool);
    if (repriced && clears(repriced.cand)) {
      log.push({
        index: i,
        action: 'repriced',
        from: pick.pick,
        to: repriced.pick.pick,
        line: quote.point,
        odds: formatAmerican(quote.american),
        edge: repriced.cand.edgePct,
        reason: 'Hard Rock line/price differs; edge still clears at that number',
      });
      built.push(repriced);
      continue;
    }
    if (repriced && leanClears(repriced.cand)) {
      markLean(repriced);
      log.push({
        index: i,
        action: 'repriced',
        from: pick.pick,
        to: repriced.pick.pick,
        line: quote.point,
        odds: formatAmerican(quote.american),
        edge: repriced.cand.edgePct,
        reason: 'Hard Rock number misses the 3% floor; kept as a lean',
      });
      built.push(repriced);
      continue;
    }
    const used = new Set(built.map((b) => sideKey(b.pick)));
    used.add(sideKey(pick));
    const alt = nextBest(pool, sportGames, used);
    if (alt) {
      log.push({
        index: i,
        action: 'replaced',
        from: pick.pick,
        to: alt.pick.pick,
        line: alt.pick.line,
        odds: alt.pick.odds,
        edge: alt.cand.edgePct,
        reason: 'edge at the Hard Rock number failed the floor; next Hard Rock candidate',
      });
      built.push(alt);
    } else {
      log.push({
        index: i,
        action: 'dropped',
        from: pick.pick,
        to: null,
        line: quote.point,
        odds: formatAmerican(quote.american),
        edge: repriced && repriced.cand ? repriced.cand.edgePct : null,
        reason: 'edge at the Hard Rock number failed and no confirmed replacement cleared',
      });
    }
  }

  built.sort((a, b) => (edgeOf(b.cand) || -Infinity) - (edgeOf(a.cand) || -Infinity));

  let nextParlay = data.parlayLegs;
  if (log.length) {
    const seen = new Set();
    const parlayPool = [];
    const pushCand = (c) => {
      if (!c || !(c.ev > 0) || !Number.isFinite(c.odds)) return;
      const k = sideKey(c);
      if (seen.has(k)) return;
      seen.add(k);
      parlayPool.push(c);
    };
    for (const b of built) pushCand(b.cand);
    for (const row of pool) {
      const game = matchGame(gamesFor(sportGames, row.sport), row.matchup);
      const quote = game ? quoteFor(row, game) : null;
      if (!quote) continue;
      if (quote.point != null && row.line != null && Math.abs(quote.point - Number(row.line)) > POINT_MATERIAL + 1e-9) {
        continue;
      }
      const cand = scoreAt(row, quote);
      if (!clears(cand)) continue;
      pushCand(cand);
    }
    const straights = built.map((b) => b.cand);
    const tickets = optimizeParlay(parlayPool, straights, { cardDate: data.date || null });
    nextParlay = tickets && tickets.length ? tickets : (optimizeParlay(straights, straights, { cardDate: data.date || null }) || []);
  }

  data.picks = built.map((b) => b.pick);
  if (log.length) data.parlayLegs = nextParlay;
  if (data.summary) {
    data.summary.totalPicks = data.picks.length;
    data.summary.totalStraightBets = data.picks.length;
  }
  data.hardRockCorrections = log;
  for (const row of log) {
    console.log(`[verify-hardrock] auto-correct ${row.action} ${row.from || ''} → ${row.to || ''} line=${row.line != null ? row.line : ''} odds=${row.odds || ''} edge=${row.edge != null ? row.edge : ''} ${row.reason}`);
  }
  return {
    log,
    changed: log.length > 0,
    picks: data.picks,
    parlayLegs: data.parlayLegs,
  };
}

module.exports = {
  autoCorrectHardRock,
  minEdgeClears: clears,
  quoteFor,
  materialHardRockGap: material,
};
