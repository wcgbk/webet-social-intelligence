'use strict';

/**
 * 10:30 AM ET price lock.
 *
 * The 2026-10-10 card was generated at 15:55Z (11:55 AM ET). Live generate
 * called the Odds API current board because no snapshot time was passed, so
 * the published lines were the late board (Over 40.5, Sacramento State +9.5,
 * UMass +6.5) instead of the morning snapshot (Over 38.5 / 39.5,
 * Sacramento State +8.5). The morning capture slots stop at 9:15 so they do
 * not race generate; they are steam history, not the price.
 *
 * Selection uses every input available at 10:30 AM America/New_York.
 * A live card always requests that historical odds snapshot. DraftKings is
 * the execution book (selection_pass). A later generate must not refetch
 * the live board. An explicit historicalSnapshot (replay) is left alone.
 * The publish cron stays on its existing schedule. This timestamp is the
 * odds snapshot, not the cron.
 */

function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  return asUTC - date.getTime();
}

/** Local clock on `dateISO` in America/New_York, as a UTC ISO string. */
function etLocalToUtcISO(dateISO, hour, minute) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${dateISO}`);
  const [y, mo, day] = d.split('-').map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(new Date(asIfUtc), 'America/New_York');
  let utc = asIfUtc - offset1;
  const offset2 = tzOffsetMs(new Date(utc), 'America/New_York');
  if (offset2 !== offset1) utc = asIfUtc - offset2;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function priceLockTimestamp(dateISO) {
  return etLocalToUtcISO(dateISO, 10, 30);
}

/**
 * Odds `date=` the generator prices from.
 * Replay (`opts.historicalSnapshot`) wins. Otherwise the 10:30 ET lock.
 * Null only when the date is not a card day; ingest then stays on the live URL.
 */
function resolveGenerateOddsSnapshot(dateISO, opts = {}) {
  if (opts && opts.historicalSnapshot) return opts.historicalSnapshot;
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) return null;
  return priceLockTimestamp(dateISO);
}

module.exports = {
  etLocalToUtcISO,
  priceLockTimestamp,
  resolveGenerateOddsSnapshot,
};
