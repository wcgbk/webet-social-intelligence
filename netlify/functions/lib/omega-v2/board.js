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

module.exports = {
  boardKey,
  slimCandidate,
  saveMorningBoard,
  loadGradedHistory,
  historyRow,
};
