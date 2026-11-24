'use strict';

/**
 * Compact replacement pool stored on a v2 card.
 * OMEGA_V2_RANKED_POOL defaults on. Unset stays on.
 * on / 1 / true / yes are on. off / 0 / false / blank are off.
 * The pool is the next 12 distinct games after the published three,
 * in the same forced order selectForcedTop3 used (orderForcedPool /
 * forcedPacks, including the live EV-first, line-move, and Pinnacle
 * fair flags). It is additive JSON. Picks, the parlay, and units are
 * not touched.
 */

const { orderForcedPool, gameKey, favoriteOutOfBand } = require('./select');
const { favCapEnabled } = require('./constants');

const RANKED_POOL_N = 12;
const FLAG = 'OMEGA_V2_RANKED_POOL';

function rankedPoolEnabled(env) {
  const source = env == null ? process.env : env;
  if (source == null || source[FLAG] == null) return true;
  const v = String(source[FLAG]).trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === '0' || v === 'false' || v === '') return false;
  return false;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function american(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
  const n = Number(String(v == null ? '' : v).trim().replace(/[−–]/g, '-').replace(/^\+/, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function rowGame(row) {
  if (!row) return '';
  if (row.gameKey != null && row.gameKey !== '') return String(row.gameKey);
  return gameKey(row.matchup || `${row.awayTeam || ''} @ ${row.homeTeam || ''}`);
}

/**
 * Fields materializeReplacement and orderForcedPool read.
 * noSharpFair and staleSoft are copied only when true so a stored-fair
 * or soft-stale row keeps its place in the forced order.
 */
function compactPoolRow(row, capOn) {
  const pick = row.pick || row.side || '';
  const odds = american(row.odds);
  const pBet = num(row.pBet) != null
    ? num(row.pBet)
    : num(row.calibration && row.calibration.pCal);
  const pMkt = num(row.pMkt) != null
    ? num(row.pMkt)
    : num(row.calibration && row.calibration.pMkt);
  const matchup = row.matchup || '';
  const out = {
    sport: row.sport || null,
    matchup,
    gameKey: rowGame(row),
    pick,
    side: row.side || pick,
    market: row.market || row.betType || null,
    line: row.line != null ? row.line : null,
    odds,
    book: row.book || null,
    commenceTime: row.commenceTime || '',
    homeTeam: row.homeTeam || null,
    awayTeam: row.awayTeam || null,
    pBet,
    pMkt,
    ev: num(row.ev),
    edge: num(row.edge),
    ...(num(row.evRank) != null ? { evRank: num(row.evRank) } : {}),
    sharpBook: row.sharpBook || null,
    inBand: !(capOn && favoriteOutOfBand({ odds })),
  };
  if (row.noSharpFair === true) out.noSharpFair = true;
  if (row.staleSoft === true) out.staleSoft = true;
  return out;
}

/**
 * Top N rows after the published games. Null when the flag is off
 * (the card then omits rankedPool). An empty array means the flag is
 * on and no other game was left.
 */
function buildStoredRankedPool(kept, published, opts) {
  if (!rankedPoolEnabled(opts && opts.env)) return null;
  const ordered = orderForcedPool(kept || [], opts);
  const used = new Set();
  for (const row of published || []) {
    const g = rowGame(row);
    if (g) used.add(g);
  }
  const capOn = favCapEnabled(opts && opts.env);
  const out = [];
  for (const row of ordered) {
    const g = rowGame(row);
    if (!g || used.has(g)) continue;
    used.add(g);
    out.push(compactPoolRow(row, capOn));
    if (out.length >= RANKED_POOL_N) break;
  }
  return out;
}

module.exports = {
  RANKED_POOL_N,
  FLAG,
  rankedPoolEnabled,
  compactPoolRow,
  buildStoredRankedPool,
};
