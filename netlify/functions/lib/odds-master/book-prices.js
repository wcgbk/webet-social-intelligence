'use strict';
/** Upsert a 3 AM or 10 AM odds-master board into clv.book_prices.
 *  Same row builder the daily mirror uses. No Odds API call.
 *  OMEGA_PULL_BOOK_PRICES defaults on. =off skips the upsert.
 *  The pull slot is stamped on every row. Hour inference is not used,
 *  so a 9 AM ET cron misfire still lands in slot 1000. */
const { readJson } = require('./store');
const { pullBookPricesEnabled } = require('../default_on_flag');
const { buildBookPriceRows, filterBookPriceRows, upsert } = require('../supa-mirror');

function isSameEtDay(iso, dateISO) {
  if (!iso || !dateISO) return false;
  try {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === dateISO;
  } catch (_) {
    return false;
  }
}

function rawInputs(dateISO, at, eventsBySport) {
  const raw = [];
  for (const [label, evs] of Object.entries(eventsBySport || {})) {
    for (const ev of evs || []) {
      if (!ev || ev.id == null || ev.id === '' || !ev.home_team || !ev.away_team) continue;
      if (!isSameEtDay(ev.commence_time, dateISO)) continue;
      raw.push({
        event: {
          sport: label,
          eventId: ev.id,
          homeTeam: ev.home_team,
          awayTeam: ev.away_team,
          commenceTime: ev.commence_time || null,
        },
        ts: at,
        body: ev,
      });
    }
  }
  return raw;
}

async function upsertPulledBookPrices({ dateISO, slot, at, eventsBySport, env, fetchImpl }) {
  if (!pullBookPricesEnabled(env)) return { skipped: 'flag-off' };
  if (!at || !['0300', '1000'].includes(String(slot || ''))) return { upserted: 0, skipped: 'bad-slot' };
  let rows = buildBookPriceRows(dateISO, [], { raw: rawInputs(dateISO, at, eventsBySport) });
  for (const row of rows) row.slot = slot;
  rows = filterBookPriceRows(rows, env);
  if (!rows.length) return { upserted: 0 };
  const n = await upsert('book_prices', rows, env, fetchImpl);
  return { upserted: n };
}

function slotStamp(index, slot) {
  if (!index) return null;
  if (slot === '0300') return index.baseline0300 && index.baseline0300.at;
  if (slot === '1000') return index.checks && index.checks['1000'] && index.checks['1000'].at;
  return null;
}

/** Saved board for one slot. Reads pulls, by-date, the index stamp, and raw/{stamp}. */
async function loadSlotEvents(dateISO, slot, read) {
  const readFn = read || readJson;
  const pull = await readFn(`pulls/${dateISO}/${slot}`);
  const dateDoc = await readFn(`by-date/${dateISO}`);
  const eventsBySport = {};
  let at = pull && pull.at ? pull.at : null;
  for (const ev of (dateDoc && dateDoc.events) || []) {
    if (!ev || !ev.sport || ev.eventId == null) continue;
    const index = await readFn(`index/${ev.sport}/${ev.eventId}`);
    const stamp = slotStamp(index, slot);
    if (!stamp) continue;
    const body = await readFn(`${ev.sport}/${ev.eventId}/raw/${stamp}`);
    if (!body || !Array.isArray(body.bookmakers)) continue;
    const event = Object.assign({}, body, {
      id: body.id != null && body.id !== '' ? body.id : ev.eventId,
      home_team: body.home_team || ev.homeTeam,
      away_team: body.away_team || ev.awayTeam,
      commence_time: body.commence_time || ev.commenceTime || null,
    });
    if (!eventsBySport[ev.sport]) eventsBySport[ev.sport] = [];
    eventsBySport[ev.sport].push(event);
    if (!at) at = stamp;
  }
  return { dateISO, slot, at, eventsBySport };
}

module.exports = { upsertPulledBookPrices, loadSlotEvents, isSameEtDay };
