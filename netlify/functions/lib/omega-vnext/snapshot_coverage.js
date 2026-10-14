'use strict';

/**
 * Morning snapshot coverage. The 3:00 and 10:00 ET pulls are the only Odds
 * API checks. A 6:00 ET row is not either of those. This module does not
 * pull odds and does not grade a pick.
 */

const { etParts } = require('../et-schedule');

const SLOT_0300 = 3 * 60;
const SLOT_1000 = 10 * 60;
const SLOT_0600 = 6 * 60;
const WINDOW_MIN = 10;

function minutesOf(parts) {
  return parts.hour * 60 + parts.minute;
}

function near(mins, slot) {
  const raw = Math.abs(mins - slot);
  return Math.min(raw, 1440 - raw) <= WINDOW_MIN;
}

/**
 * Count distinct games whose snapshot_ts falls in the ET windows.
 * rows: { snapshot_ts, sport, game_id, line_type }
 */
function morningWindowCoverage(rows, dateISO) {
  const seen = new Set();
  const out = { date: dateISO, at0300: 0, at0600: 0, at1000: 0 };
  for (const row of rows || []) {
    if (!row || !row.snapshot_ts) continue;
    const when = new Date(row.snapshot_ts);
    if (Number.isNaN(when.getTime())) continue;
    const parts = etParts(when);
    if (dateISO && parts.ymd !== dateISO) continue;
    const id = `${row.sport || ''}|${row.game_id || ''}|${row.line_type || ''}|${parts.et}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const mins = minutesOf(parts);
    if (near(mins, SLOT_0300)) out.at0300 += 1;
    if (near(mins, SLOT_0600)) out.at0600 += 1;
    if (near(mins, SLOT_1000)) out.at1000 += 1;
  }
  out.missing0300 = out.at0300 === 0;
  out.missing1000 = out.at1000 === 0;
  return out;
}

function slotsOf(doc) {
  const slots = new Set();
  for (const check of (doc && doc.checks) || []) {
    if (check && check.slot) slots.add(String(check.slot));
  }
  return slots;
}

/**
 * Event docs from omega-pinnacle-line-moves. A game counts only when both
 * the 0300 and 1000 checks are on the doc.
 */
function assessSnapshotCoverage(dateISO, events, extra) {
  const docs = Array.isArray(events) ? events.filter(Boolean) : [];
  const missing = [];
  const bySport = {};
  for (const doc of docs) {
    const sport = doc.sport || 'UNK';
    if (!bySport[sport]) bySport[sport] = { games: 0, missing0300: 0, missing1000: 0 };
    bySport[sport].games += 1;
    const slots = slotsOf(doc);
    const has0300 = slots.has('0300');
    const has1000 = slots.has('1000');
    if (!has0300) bySport[sport].missing0300 += 1;
    if (!has1000) bySport[sport].missing1000 += 1;
    if (!has0300 || !has1000) {
      missing.push({
        sport,
        eventId: doc.eventId == null ? null : String(doc.eventId),
        has0300,
        has1000,
      });
    }
  }
  const masterGames = extra && Number.isFinite(extra.masterGames) ? extra.masterGames : null;
  const indexShort = masterGames != null && masterGames > docs.length;
  const windows = extra && extra.windows ? extra.windows : null;
  const ok = docs.length > 0
    && missing.length === 0
    && !indexShort
    && !(windows && (windows.missing0300 || windows.missing1000));
  return {
    date: dateISO,
    games: docs.length,
    masterGames,
    indexShort,
    missing0300: missing.filter((row) => !row.has0300).length,
    missing1000: missing.filter((row) => !row.has1000).length,
    missing,
    bySport,
    windows,
    ok,
  };
}

module.exports = {
  morningWindowCoverage,
  assessSnapshotCoverage,
};
