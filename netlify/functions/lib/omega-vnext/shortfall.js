'use strict';

/**
 * Private card shortfall. Diagnostic only.
 * Does not add a pick, change a gate, or force-fill a negative-EV play.
 * The public pick list must not include this object. publicPicksPayload
 * drops `shortfall`. The generate-time health blob keeps a copy.
 */

const { GATES, MAX_STRAIGHTS } = require('./config');

const NEXT_BEST_CAP = 10;
const STRAIGHTS_TARGET = MAX_STRAIGHTS;
const PARLAY_TARGET = 3;

function finite(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function sportFloor(table, sport) {
  if (!table || typeof table !== 'object') return null;
  if (sport && table[sport] != null && Number.isFinite(Number(table[sport]))) return Number(table[sport]);
  if (table.default != null && Number.isFinite(Number(table.default))) return Number(table.default);
  return null;
}

function gameOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.matchup) return String(row.matchup);
  if (row.awayTeam && row.homeTeam) return `${row.awayTeam} @ ${row.homeTeam}`;
  return null;
}

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+ml$/, '').trim();
}

function parlayLegCount(parlayLegs) {
  let best = 0;
  for (const ticket of parlayLegs || []) {
    const n = Array.isArray(ticket && ticket.legs) ? ticket.legs.length : 0;
    if (n > best) best = n;
  }
  return best;
}

function failingGateOf(row) {
  if (!row || typeof row !== 'object') return null;
  const gate = row.rejectReason || row.reason || null;
  return gate ? String(gate) : null;
}

/**
 * Numeric floor the failing gate compares against. Null when the miss is
 * not a numeric floor (liquidity, identity, same-game rank, and so on).
 */
function requiredFloor(row, gate) {
  const reason = gate || failingGateOf(row);
  const sport = row && row.sport;
  if (reason === 'ev-floor') return sportFloor(GATES.minEV, sport);
  if (reason === 'coverProb-floor') return sportFloor(GATES.minCoverProb, sport);
  if (reason === 'nonpositive-edge') return 0;
  if (reason === 'predictedClv-negative') return Number(GATES.minPredictedClvCents);
  if (reason === 'odds-out-of-band') {
    const price = finite(row && row.odds);
    if (price != null && price > GATES.maxAmericanOdds) return GATES.maxAmericanOdds;
    return GATES.minAmericanOdds;
  }
  return null;
}

function rankScore(row) {
  const ev = finite(row && row.ev);
  const edge = finite(row && (row.edgePct != null ? row.edgePct : row.edge));
  const p = finite(row && row.coverProb);
  return [ev == null ? -Infinity : ev, edge == null ? -Infinity : edge, p == null ? -Infinity : p];
}

function betterRank(a, b) {
  const aa = rankScore(a);
  const bb = rankScore(b);
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? -1 : 1;
  }
  return 0;
}

function isPublishedStraight(candidate, picks) {
  const game = norm(gameOf(candidate));
  const side = norm(candidate && candidate.side);
  const market = norm(candidate && candidate.market);
  return (picks || []).some((pick) => {
    const pg = norm(pick && pick.matchup);
    if (game && pg && game !== pg) return false;
    const pm = norm(pick && (pick.betType || pick.market));
    if (market && pm && market !== pm) return false;
    const label = norm(pick && (pick.pick || pick.side));
    return !!side && label === side;
  });
}

function toNextBest(row, gate) {
  const edge = row && (row.edgePct != null ? row.edgePct : row.edge);
  return {
    sport: row && row.sport ? row.sport : null,
    game: gameOf(row),
    market: row && (row.market || row.betType) ? (row.market || row.betType) : null,
    side: row && (row.side || row.pick) ? (row.side || row.pick) : null,
    price: finite(row && row.odds),
    p_cal: finite(row && row.coverProb),
    p_sharp: finite(row && (row.fair_sharp_p != null ? row.fair_sharp_p : row.p_sharp)),
    edge: finite(edge),
    ev: finite(row && row.ev),
    requiredFloor: requiredFloor(row, gate),
    failingGate: gate || null,
  };
}

/**
 * @param {{ picks?: object[], parlayLegs?: object[], yesPool?: object[], rejected?: object[] }} input
 *   picks and parlayLegs are the published card. yesPool cleared the gates.
 *   rejected did not. Next-best is diagnostic and is not a ticket.
 */
function buildShortfall(input) {
  const src = input || {};
  const picks = Array.isArray(src.picks) ? src.picks : [];
  const straightsCleared = picks.length;
  const legs = parlayLegCount(src.parlayLegs);
  const parlayCleared = legs >= PARLAY_TARGET;
  const active = straightsCleared < STRAIGHTS_TARGET || !parlayCleared;
  const report = {
    active,
    straightsCleared,
    straightsTarget: STRAIGHTS_TARGET,
    parlayLegs: legs,
    parlayTarget: PARLAY_TARGET,
    parlayCleared,
    nextBest: [],
  };
  if (!active) return report;

  const rows = [];
  for (const row of src.rejected || []) {
    if (!row || typeof row !== 'object') continue;
    rows.push({ row, gate: failingGateOf(row) || 'gate' });
  }
  for (const row of src.yesPool || []) {
    if (!row || typeof row !== 'object') continue;
    if (isPublishedStraight(row, picks)) continue;
    rows.push({ row, gate: 'not-selected' });
  }
  rows.sort((a, b) => betterRank(a.row, b.row));

  const seen = new Set();
  for (const item of rows) {
    const next = toNextBest(item.row, item.gate);
    const id = [next.sport, next.game, next.market, next.side, next.failingGate].join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    report.nextBest.push(next);
    if (report.nextBest.length >= NEXT_BEST_CAP) break;
  }
  return report;
}

module.exports = {
  buildShortfall,
  parlayLegCount,
  requiredFloor,
  NEXT_BEST_CAP,
  STRAIGHTS_TARGET,
  PARLAY_TARGET,
};
