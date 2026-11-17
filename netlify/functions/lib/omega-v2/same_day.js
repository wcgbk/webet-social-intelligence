'use strict';

/**
 * Same ET calendar day as the card date. America/New_York, DST included,
 * via the existing etCalendarDate helper. Flag off returns the input
 * array unchanged. A missing or unparseable commence time is a drop
 * when the flag is on. This module does not pull odds.
 */

const { etCalendarDate } = require('../omega-vnext/odds_math');
const { sameDayOnlyEnabled } = require('./constants');

const CARD_DATE = /^\d{4}-\d{2}-\d{2}$/;

function commenceOf(row) {
  if (row == null) return null;
  if (typeof row === 'string' || typeof row === 'number') return row;
  return row.commenceTime || row.commence_time || null;
}

function sameDayBucket(commence, cardDate) {
  const iso = etCalendarDate(commence);
  if (!iso) return 'missing';
  if (iso === cardDate) return 'same';
  return iso > cardDate ? 'nextDay' : 'prevDay';
}

function cardDateOf(cardDate) {
  const card = String(cardDate || '');
  return CARD_DATE.test(card) ? card : null;
}

/**
 * Keep rows whose commence time falls on cardDate in America/New_York.
 * Flag off, or a missing card date, returns the same array.
 */
function filterSameEtDay(rows, cardDate, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const env = opts && opts.env;
  if (!sameDayOnlyEnabled(env)) {
    return { rows: list, applied: false, bySport: {}, kept: list.length, short: false };
  }
  const card = cardDateOf(cardDate);
  if (!card) {
    return { rows: list, applied: false, bySport: {}, kept: list.length, short: false };
  }
  const bySport = {};
  const kept = [];
  for (const row of list) {
    const sport = String((row && row.sport) || 'UNKNOWN').toUpperCase();
    if (!bySport[sport]) {
      bySport[sport] = { dropped: 0, nextDay: 0, prevDay: 0, missing: 0, kept: 0 };
    }
    const bucket = sameDayBucket(commenceOf(row), card);
    if (bucket === 'same') {
      bySport[sport].kept += 1;
      kept.push(row);
    } else {
      bySport[sport].dropped += 1;
      bySport[sport][bucket] += 1;
    }
  }
  return {
    rows: kept,
    applied: true,
    bySport,
    kept: kept.length,
    short: kept.length < 3,
    cardDate: card,
  };
}

function logSameDayDrops(result, opts) {
  if (!result || !result.applied) return;
  for (const sport of Object.keys(result.bySport).sort()) {
    const row = result.bySport[sport];
    if (!row.dropped) continue;
    console.log(`[same-day] ${sport} dropped=${row.dropped} (nextDay=${row.nextDay} prevDay=${row.prevDay} missing=${row.missing})`);
  }
  if (result.short && !(opts && opts.skipShort)) {
    console.log(`[same-day] short kept=${result.kept} (fewer than 3 same-day candidates)`);
  }
}

function sameDayMeta(result, cardDate) {
  const bySport = {};
  for (const sport of Object.keys((result && result.bySport) || {}).sort()) {
    const row = result.bySport[sport];
    bySport[sport] = {
      dropped: row.dropped,
      nextDay: row.nextDay,
      prevDay: row.prevDay,
      missing: row.missing,
      kept: row.kept,
    };
  }
  return {
    cardDate: String(cardDate || (result && result.cardDate) || ''),
    kept: result ? result.kept : 0,
    short: !!(result && result.short),
    bySport,
  };
}

/** True when the row may stay. Flag off or a bad card date does not drop. */
function sameEtDayRow(row, cardDate, env) {
  if (!sameDayOnlyEnabled(env)) return true;
  const card = cardDateOf(cardDate);
  if (!card) return true;
  return sameDayBucket(commenceOf(row), card) === 'same';
}

/**
 * null when the row is allowed.
 * missing-commenceTime or not-same-et-day when the flag drops it.
 * Flag off returns null so the old slate window is unchanged.
 */
function calendarOffReason(commence, cardDate, env) {
  if (!sameDayOnlyEnabled(env)) return null;
  const card = cardDateOf(cardDate);
  if (!card) return null;
  const bucket = sameDayBucket(commenceOf(commence), card);
  if (bucket === 'same') return null;
  if (bucket === 'missing') return 'missing-commenceTime';
  return 'not-same-et-day';
}

/**
 * Drop off-day events inside a sport → events board.
 * Flag off, or nothing removed, returns the same object.
 */
function filterBoardByEtDay(board, cardDate, opts) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return board;
  if (!sameDayOnlyEnabled(opts && opts.env)) return board;
  const card = cardDateOf(cardDate);
  if (!card) return board;
  let changed = false;
  const out = {};
  for (const key of Object.keys(board)) {
    const events = board[key];
    if (!Array.isArray(events)) {
      out[key] = events;
      continue;
    }
    const filtered = filterSameEtDay(events, card, opts);
    out[key] = filtered.rows;
    if (filtered.rows.length !== events.length) changed = true;
  }
  return changed ? out : board;
}

module.exports = {
  commenceOf,
  sameDayBucket,
  filterSameEtDay,
  logSameDayDrops,
  sameDayMeta,
  sameEtDayRow,
  calendarOffReason,
  filterBoardByEtDay,
};
