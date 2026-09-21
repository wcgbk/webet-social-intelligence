'use strict';

/**
 * Omega live card date resolution (get-picks-omega).
 *
 * Live (no ?date=): newest store date with real picks, upper-bounded by tomorrow ET
 * so Mon evening can pre-publish Tue without serving far-future sims.
 *
 * Sticky: if the preferred date is missing or empty (noPlays), keep serving the
 * most recent prior day that has picks — never blank the page at midnight before
 * the morning cron. Explicit ?date= uses the same sticky unless forceEmpty=1.
 */

function todayET(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function tomorrowET(now = new Date()) {
  // Derive from todayET string so DST / zone edges stay calendar-day correct.
  const today = todayET(now);
  const [y, m, d] = today.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  utcNoon.setUTCDate(utcNoon.getUTCDate() + 1);
  const yy = utcNoon.getUTCFullYear();
  const mm = String(utcNoon.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utcNoon.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function hasRealPicks(data) {
  return !!(data && Array.isArray(data.picks) && data.picks.length > 0);
}

/** Unique sorted ascending ISO dates from mixed inputs. */
function normalizeDateList(...lists) {
  const set = new Set();
  for (const list of lists) {
    if (!list) continue;
    const arr = Array.isArray(list) ? list : [list];
    for (const raw of arr) {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (isISODate(s)) set.add(s);
    }
  }
  return [...set].sort();
}

/**
 * Live try order: newest first among dates ≤ upperBound (default tomorrow ET).
 * Always includes today/tomorrow as probe keys even if the index is stale.
 */
function liveTryDates(knownDates, { now = new Date(), upperBound } = {}) {
  const cap = upperBound || tomorrowET(now);
  const today = todayET(now);
  const tomorrow = tomorrowET(now);
  const pool = normalizeDateList(knownDates, today, tomorrow)
    .filter((d) => d <= cap);
  return pool.slice().reverse();
}

/**
 * Explicit ?date= try order: requested first, then prior days newest-first.
 * Does not jump forward past the requested date.
 */
function stickyTryDates(knownDates, requestedDate) {
  if (!isISODate(requestedDate)) return [];
  const priors = normalizeDateList(knownDates)
    .filter((d) => d < requestedDate)
    .reverse();
  return [requestedDate, ...priors];
}

/**
 * Walk tryDates; return first payload with real picks.
 * If none, return { dateKey, picksData } for the first key that was loaded
 * (even if empty), or null if nothing loaded.
 */
async function resolveCard(tryDates, loadPicks, { requirePicks = true } = {}) {
  let firstLoaded = null;
  for (const dateKey of tryDates) {
    let picksData = null;
    try {
      picksData = await loadPicks(dateKey);
    } catch (_) {
      picksData = null;
    }
    if (picksData == null) continue;
    if (!firstLoaded) firstLoaded = { dateKey, picksData };
    if (!requirePicks || hasRealPicks(picksData)) {
      return { dateKey, picksData, sticky: firstLoaded.dateKey !== dateKey || tryDates[0] !== dateKey };
    }
  }
  return firstLoaded
    ? { ...firstLoaded, sticky: tryDates[0] !== firstLoaded.dateKey }
    : null;
}

module.exports = {
  todayET,
  tomorrowET,
  isISODate,
  hasRealPicks,
  normalizeDateList,
  liveTryDates,
  stickyTryDates,
  resolveCard,
};
