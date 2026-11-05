'use strict';

/**
 * Full morning candidate board, one blob per card date.
 * Writes omega-v2/morning-board/{date} only. Never a live picks key.
 * Dry runs and OMEGA_REPLAY_NO_WRITE skip the write.
 */

const { MODEL_VERSION } = require('./constants');

function boardKey(dateISO) {
  return `omega-v2/morning-board/${dateISO}`;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A spread or total number. Moneyline and a missing quote stay null. */
function finitePoint(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Point on a DK/HR quote, when the quote recorded one. */
function quotePoint(px) {
  if (!px || typeof px !== 'object') return null;
  if (px.point != null && px.point !== '') return finitePoint(px.point);
  if (px.line != null && px.line !== '') return finitePoint(px.line);
  return null;
}

/**
 * True when the DK/HR number is the number the edge was computed on.
 * A moneyline, or a quote that did not record a point, does not disagree.
 * Any other difference is a different bet.
 */
function dkHrLineAgrees(edgeLine, quoteLine) {
  const edge = finitePoint(edgeLine);
  const quote = finitePoint(quoteLine);
  if (edge == null || quote == null) return true;
  return Math.abs(edge - quote) <= 1e-6;
}

function slimCandidate(c) {
  if (!c) return null;
  return {
    sport: c.sport || null,
    matchup: c.matchup || null,
    side: c.side || c.pick || null,
    market: c.market || c.betType || null,
    odds: c.oddsStr != null ? c.oddsStr : (c.odds != null ? c.odds : null),
    line: c.line != null ? c.line : null,
    pModel: numOrNull(c.modelRawP != null ? c.modelRawP : (c.p_model != null ? c.p_model : c.pModel)),
    pMkt: numOrNull(c.fair_sharp_p != null ? c.fair_sharp_p : (c.sharpFairP != null ? c.sharpFairP : c.pMkt)),
    coverProb: numOrNull(c.coverProb),
    ev: numOrNull(c.ev),
    edgePct: c.edgePct != null ? c.edgePct : null,
    uncertainty: numOrNull(c.uncertainty),
    book: c.book || null,
    edgeLine: c.line != null ? c.line : null,
    dkLine: quotePoint(c.bestDkHr),
    lineAgrees: dkHrLineAgrees(c.line, quotePoint(c.bestDkHr)),
    openPrice: c.openPrint && c.openPrint.odds != null ? c.openPrint.odds : (c.openPrice != null ? c.openPrice : null),
    openBook: c.openPrint && c.openPrint.book ? c.openPrint.book : (c.openBook || null),
    commenceTime: c.commenceTime || '',
    homeTeam: c.homeTeam || null,
    awayTeam: c.awayTeam || null,
  };
}

function noWrite(meta) {
  if (meta && (meta.dryRun || meta.noWrite || meta.shadow)) return 'no-write';
  if (process.env.OMEGA_REPLAY_NO_WRITE === '1') return 'no-write';
  return null;
}

async function saveMorningBoard(dateISO, candidates, meta = {}) {
  const key = boardKey(dateISO);
  const rows = (candidates || []).map(slimCandidate).filter(Boolean);
  const reason = !dateISO ? 'no-date' : noWrite(meta);
  if (reason) {
    return { saved: false, reason, key, count: rows.length };
  }
  const payload = {
    date: dateISO,
    savedAt: new Date().toISOString(),
    modelVersion: meta.modelVersion || MODEL_VERSION,
    count: rows.length,
    candidates: rows,
  };
  try {
    const { storeJson } = require('../omega-vnext/store');
    await storeJson(key, payload);
    return { saved: true, key, count: rows.length };
  } catch (e) {
    console.error(`[omega-v2] morning board save failed: ${e.message}`);
    return { saved: false, reason: e.message, key, count: rows.length };
  }
}

function historyRow(date, pick) {
  if (!pick) return null;
  const result = pick.result === 'win' || pick.result === 'loss' ? pick.result : null;
  if (!result) return null;
  const pModel = numOrNull(pick.p_model != null ? pick.p_model : pick.pModel);
  const pMkt = numOrNull(pick.fair_sharp_p != null ? pick.fair_sharp_p : pick.pMkt);
  if (pModel == null || pMkt == null) return null;
  return {
    date: String(date),
    sport: pick.sport || null,
    market: pick.market || pick.betType || null,
    pick: pick.pick || pick.side || null,
    pModel,
    pMkt,
    result,
  };
}

/**
 * One scored morning-board side. Both sides are kept. A row with no
 * probability is dropped. `pick` is the side, matching graded history.
 */
function boardHistoryRow(date, cand) {
  if (!cand || typeof cand !== 'object') return null;
  const pModel = numOrNull(cand.pModel != null ? cand.pModel : (cand.modelRawP != null ? cand.modelRawP : cand.p_model));
  const pMkt = numOrNull(cand.pMkt != null ? cand.pMkt : (cand.fair_sharp_p != null ? cand.fair_sharp_p : cand.sharpFairP));
  if (pModel == null || pMkt == null) return null;
  const sport = cand.sport || null;
  const market = cand.market || cand.betType || null;
  const pick = cand.side || cand.pick || null;
  if (!sport || !market || !pick) return null;
  return {
    date: String(date),
    sport,
    market,
    pick: String(pick),
    pModel,
    pMkt,
  };
}

function cardDay(value) {
  const d = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/** Past dates and board bodies. One process re-reads the same blob once. */
const boardStoreCache = {
  dates: undefined,
  boards: new Map(),
};

async function defaultPickDates() {
  if (boardStoreCache.dates !== undefined) return boardStoreCache.dates;
  try {
    const { readJson } = require('../omega-vnext/store');
    const stored = await readJson('picks-dates');
    boardStoreCache.dates = Array.isArray(stored) ? stored : [];
  } catch (_) {
    boardStoreCache.dates = [];
  }
  return boardStoreCache.dates;
}

async function defaultMorningBoard(date) {
  if (boardStoreCache.boards.has(date)) return boardStoreCache.boards.get(date);
  let body = null;
  try {
    const { readJson } = require('../omega-vnext/store');
    body = await readJson(boardKey(date));
  } catch (_) {
    body = null;
  }
  boardStoreCache.boards.set(date, body);
  return body;
}

/**
 * Graded straight rows from stored cards dated before cardDate.
 * Read-only. A missing store returns []. Never includes cardDate or later.
 */
async function loadGradedHistory(cardDate, opts = {}) {
  const card = String(cardDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card)) return [];
  const readPicks = opts.readPicks;
  const readDates = opts.readDates;
  let dates = [];
  try {
    if (readDates) dates = await readDates();
    else {
      const { readJson } = require('../omega-vnext/store');
      const stored = await readJson('picks-dates');
      dates = Array.isArray(stored) ? stored : [];
    }
  } catch (_) {
    return [];
  }
  const prior = dates
    .map((d) => String(d))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < card)
    .sort()
    .slice(-20);
  const rows = [];
  for (const date of prior) {
    let cardBody = null;
    try {
      cardBody = readPicks ? await readPicks(date) : await require('../omega-vnext/store').readPicks(date);
    } catch (_) {
      cardBody = null;
    }
    const stamped = cardBody && cardBody.date ? String(cardBody.date) : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamped) || stamped >= card) continue;
    for (const pick of (cardBody && cardBody.picks) || []) {
      const row = historyRow(stamped, pick);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/**
 * Unselected morning-board rows strictly before cardDate.
 * Same date list as loadGradedHistory: the last 20 card dates before
 * this one. A missing blob is skipped, so a date in that window with no
 * board contributes nothing. Both sides. Read-only. A missing store
 * returns []. The caller races this with a timeout, same as graded history.
 * A board whose own date is on or after cardDate is dropped.
 */
async function loadBoardHistory(cardDate, opts = {}) {
  const card = cardDay(cardDate);
  if (!card) return [];
  const readBoard = opts.readBoard;
  const readDates = opts.readDates;
  let dates = [];
  try {
    if (readDates) dates = await readDates();
    else dates = await defaultPickDates();
  } catch (_) {
    return [];
  }
  const prior = (Array.isArray(dates) ? dates : [])
    .map((d) => cardDay(d))
    .filter((d) => d && d < card)
    .sort()
    .slice(-20);
  const rows = [];
  for (const date of prior) {
    let body = null;
    try {
      body = readBoard ? await readBoard(date) : await defaultMorningBoard(date);
    } catch (_) {
      body = null;
    }
    if (!body || typeof body !== 'object') continue;
    const stamped = cardDay(body.date) || date;
    if (!stamped || stamped >= card) continue;
    const cands = Array.isArray(body.candidates) ? body.candidates : [];
    for (const cand of cands) {
      const row = boardHistoryRow(stamped, cand);
      if (row) rows.push(row);
    }
  }
  return rows;
}

module.exports = {
  boardKey,
  slimCandidate,
  saveMorningBoard,
  loadGradedHistory,
  loadBoardHistory,
  boardHistoryRow,
  historyRow,
  finitePoint,
  quotePoint,
  dkHrLineAgrees,
};
