'use strict';
/** Board reader over the odds-master 3AM/10AM pulls — the single stored
 *  board both models consume ("use all data pulled", Ben 2026-10-18).
 *  Rebuilds, per sport: (a) Odds-API-shaped events with EVERY stored book
 *  and market for a slot, and (b) line-path game snapshots (0300 open vs
 *  1000 board) in the extractGameBooks shape Omega's annotateLineMoves
 *  expects. Read-only; no Odds API calls. Missing slot/book/market blobs
 *  are skipped, never synthesized. */
const { readJson } = require('./store');
const { extractGameBooks, gameKey } = require('../omega-vnext/line_path');
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
function outcomesFor(market, sides, home, away) {
  if (!sides) return [];
  if (market === 'h2h') {
    const o = [];
    if (sides.away && Number.isFinite(sides.away.price)) o.push({ name: away, price: sides.away.price });
    if (sides.home && Number.isFinite(sides.home.price)) o.push({ name: home, price: sides.home.price });
    return o;
  }
  if (market === 'spreads') {
    const o = [];
    if (sides.away) o.push({ name: away, price: sides.away.price, point: sides.away.line });
    if (sides.home) o.push({ name: home, price: sides.home.price, point: sides.home.line });
    return o.filter(x => Number.isFinite(x.price) && Number.isFinite(x.point));
  }
  const o = [];
  if (sides.over) o.push({ name: 'Over', price: sides.over.price, point: sides.over.line });
  if (sides.under) o.push({ name: 'Under', price: sides.under.price, point: sides.under.line });
  return o.filter(x => Number.isFinite(x.price) && Number.isFinite(x.point));
}
async function loadMasterBoard(dateISO, read = readJson) {
  const dateDoc = await read(`by-date/${dateISO}`);
  const evs = (dateDoc && Array.isArray(dateDoc.events)) ? dateDoc.events : [];
  if (!evs.length) return null;
  const eventsBySport = {}; const games0300 = {}; const games1000 = {};
  let at0300 = null; let at1000 = null; let booksSeen = new Set();
  await mapLimit(evs, 8, async (ev) => {
    if (!ev || !ev.sport || ev.eventId == null || !ev.homeTeam || !ev.awayTeam) return;
    const index = await read(`index/${ev.sport}/${ev.eventId}`);
    if (!index) return;
    const books = Array.isArray(index.books) && index.books.length ? index.books : ['hardrockbet', 'pinnacle', 'draftkings', 'fanduel'];
    const build = async (at) => {
      if (!at) return null;
      const bookmakers = [];
      for (const book of books) {
        const markets = [];
        for (const m of ['h2h', 'spreads', 'totals']) {
          const price = await read(`${ev.sport}/${ev.eventId}/${book}/${m}/${at}`);
          const outcomes = price && price.sides ? outcomesFor(m, price.sides, ev.homeTeam, ev.awayTeam) : [];
          if (outcomes.length) markets.push({ key: m, outcomes });
        }
        if (markets.length) { bookmakers.push({ key: book, markets }); booksSeen.add(book); }
      }
      if (!bookmakers.length) return null;
      return { id: ev.eventId, sport: ev.sport, sport_key: ev.sport, home_team: ev.homeTeam, away_team: ev.awayTeam,
        commence_time: ev.commenceTime || null, bookmakers };
    };
    const a03 = index.baseline0300 && index.baseline0300.at;
    const a10 = index.checks && index.checks['1000'] && index.checks['1000'].at;
    if (a03) at0300 = a03; if (a10) at1000 = a10;
    const [ev1000, ev0300] = await Promise.all([build(a10), build(a03)]);
    if (ev1000) { (eventsBySport[ev.sport] = eventsBySport[ev.sport] || []).push(ev1000);
      games1000[gameKey(ev.awayTeam, ev.homeTeam)] = { sport: ev.sport, ...extractGameBooks(ev1000) }; }
    if (ev0300) { games0300[gameKey(ev.awayTeam, ev.homeTeam)] = { sport: ev.sport, ...extractGameBooks(ev0300) }; }
  });
  if (!Object.keys(eventsBySport).length && !Object.keys(games1000).length) return null;
  return { date: dateISO, eventsBySport, games0300, games1000, at0300, at1000, booksSeen: [...booksSeen],
    polls: [
      ...(Object.keys(games0300).length ? [{ hhmm: '0300', slot: '0300', capturedAt: at0300, games: games0300 }] : []),
      ...(Object.keys(games1000).length ? [{ hhmm: '1000', slot: '1000', capturedAt: at1000, games: games1000 }] : []),
    ] };
}
module.exports = { loadMasterBoard, outcomesFor };
