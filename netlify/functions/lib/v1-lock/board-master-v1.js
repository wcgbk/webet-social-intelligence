'use strict';
/**
 * V1 board reconstruction from the odds-master store (read-only).
 * Root cause found 2026-10-18: the pre-reset pipeline suspended the era
 * omega-line-path morning snaps after 2026-10-12 (capture handler returned
 * 'odds-api-window'; schedules commented out) and moved its morning Odds
 * pulls to the odds-master store at 03:00 ET (baseline-0300, 07:01Z) and
 * 10:00 ET (check-1000, 14:01Z). Those blobs genuinely contain the morning
 * lines — per book, per market, including hardrockbet — so V1 rebuilds its
 * stored 10 AM board from check-1000 (falling back to baseline-0300).
 * No lines are synthesized: every number comes from a stored price blob.
 */
const MASTER_STORE = 'odds-master';
function pickTimestamp(index) {
  if (!index) return null;
  if (index.checks && index.checks['1000'] && index.checks['1000'].at) return { at: index.checks['1000'].at, hhmm: '1000', role: 'check-1000' };
  if (index.baseline0300 && index.baseline0300.at) return { at: index.baseline0300.at, hhmm: '0300', role: 'baseline-0300' };
  return null;
}
function applyPrice(row, market, sides) {
  if (!sides) return;
  if (market === 'h2h') {
    if (sides.home && Number.isFinite(sides.home.price)) row.mlHome = sides.home.price;
    if (sides.away && Number.isFinite(sides.away.price)) row.mlAway = sides.away.price;
  } else if (market === 'spreads') {
    if (sides.home) { row.spreadHome = sides.home.line; row.spreadHomeOdds = sides.home.price; }
    if (sides.away) { row.spreadAway = sides.away.line; row.spreadAwayOdds = sides.away.price; }
  } else if (market === 'totals') {
    if (sides.over) { row.total = sides.over.line; row.overOdds = sides.over.price; }
    if (sides.under) { row.underOdds = sides.under.price; if (row.total == null) row.total = sides.under.line; }
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
/** readJson(store,key) injected from store-v1 (REST-backed). */
async function reconstructBoardFromMasterV1(readJson, dateISO) {
  const dateDoc = await readJson(MASTER_STORE, `by-date/${dateISO}`);
  const events = (dateDoc && Array.isArray(dateDoc.events)) ? dateDoc.events : [];
  if (!events.length) return null;
  const games = {};
  let boardAt = null; let boardHHMM = '1000';
  await mapLimit(events, 8, async (ev) => {
    if (!ev || !ev.sport || ev.eventId == null || !ev.homeTeam || !ev.awayTeam) return;
    const index = await readJson(MASTER_STORE, `index/${ev.sport}/${ev.eventId}`);
    const ts = pickTimestamp(index);
    if (!ts) return;
    boardAt = ts.at; boardHHMM = ts.hhmm;
    const row = { mlHome: null, mlAway: null, spreadHome: null, spreadHomeOdds: null, spreadAway: null, spreadAwayOdds: null, total: null, overOdds: null, underOdds: null };
    const markets = ['h2h', 'spreads', 'totals'];
    await Promise.all(markets.map(async (m) => {
      const price = await readJson(MASTER_STORE, `${ev.sport}/${ev.eventId}/hardrockbet/${m}/${ts.at}`);
      if (price && price.sides) applyPrice(row, m, price.sides);
    }));
    // Baseline (03:00 ET) Hard Rock line for Filter 4 line-movement read.
    let openRow = null;
    if (index.baseline0300 && index.baseline0300.at && index.baseline0300.at !== ts.at) {
      openRow = { mlHome: null, mlAway: null, spreadHome: null, spreadHomeOdds: null, spreadAway: null, spreadAwayOdds: null, total: null, overOdds: null, underOdds: null };
      await Promise.all(markets.map(async (m) => {
        const price = await readJson(MASTER_STORE, `${ev.sport}/${ev.eventId}/hardrockbet/${m}/${index.baseline0300.at}`);
        if (price && price.sides) applyPrice(openRow, m, price.sides);
      }));
    }
    const key = `${ev.awayTeam} @ ${ev.homeTeam}`;
    games[key] = { sport: ev.sport, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
      commenceTime: ev.commenceTime || null, books: { hardrockbet: row }, openBooks: openRow ? { hardrockbet: openRow } : null };
  });
  if (!Object.keys(games).length) return null;
  return { date: dateISO, source: 'odds-master', polls: [{ hhmm: boardHHMM, slot: boardHHMM, capturedAt: boardAt, games }] };
}
module.exports = { reconstructBoardFromMasterV1, pickTimestamp, applyPrice, MASTER_STORE };
