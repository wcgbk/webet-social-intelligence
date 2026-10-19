'use strict';
/** The ONLY paid Odds API pulls in the daily system (Ben, 2026-10-18:
 *  "Only pulls needed are 3am and 10am and use all data pulled.").
 *  Slot 0300 = baseline/opening read; slot 1000 = board/decision read.
 *  One request per sport per pull: regions us,us2,eu, markets
 *  h2h,spreads,totals, American odds — the API returns every book in
 *  those regions, and EVERY book/market/outcome is stored (per-book
 *  price blobs + the raw event), so no slice is dropped at write time.
 *  Expected cost by the Odds API credit formula (markets x regions per
 *  request): 3 x 3 = 9 credits per sport, 6 sports = ~54 credits per
 *  pull, ~108/day. Stated, not measured — no live pull was fired to
 *  write this code. Games stored are the pull date's ET slate. */
const { readJson, writeJson } = require('./store');
const SPORTS = [
  ['NFL', 'americanfootball_nfl'], ['NCAAF', 'americanfootball_ncaaf'],
  ['NHL', 'icehockey_nhl'], ['NBA', 'basketball_nba'],
  ['NCAAM', 'basketball_ncaab'], ['MLB', 'baseball_mlb'],
];
const REGIONS = 'us,us2,eu';
const MARKETS = 'h2h,spreads,totals';
function etDateISO(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function isSameEtDay(iso, dateISO) {
  if (!iso) return false;
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === dateISO; } catch (_) { return false; }
}
function sidesFor(market, outcomes, home, away) {
  const sides = {};
  for (const o of outcomes || []) {
    const rec = { price: Number(o.price) };
    if (o.point != null) rec.line = Number(o.point);
    if (market === 'totals') {
      if (/^over$/i.test(o.name)) sides.over = rec;
      else if (/^under$/i.test(o.name)) sides.under = rec;
    } else if (o.name === home) sides.home = rec;
    else if (o.name === away) sides.away = rec;
  }
  return sides;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
/** Pure transform (testable, no network): Odds API events -> write ops. */
function planWrites(eventsBySport, slot, at, dateISO) {
  const writes = []; const events = []; const summary = { sports: {}, books: new Set(), games: 0 };
  for (const [label, evs] of Object.entries(eventsBySport || {})) {
    summary.sports[label] = 0;
    for (const ev of evs || []) {
      if (!ev || !ev.id || !ev.home_team || !ev.away_team) continue;
      if (!isSameEtDay(ev.commence_time, dateISO)) continue;
      summary.games++; summary.sports[label]++;
      events.push({ sport: label, eventId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time || null });
      const books = [];
      for (const bk of ev.bookmakers || []) {
        if (!bk || !bk.key) continue;
        books.push(bk.key); summary.books.add(bk.key);
        for (const m of bk.markets || []) {
          if (!MARKETS.split(',').includes(m.key)) continue;
          writes.push({ key: `${label}/${ev.id}/${bk.key}/${m.key}/${at}`,
            data: { sport: label, eventId: ev.id, book: bk.key, market: m.key, at, sides: sidesFor(m.key, m.outcomes, ev.home_team, ev.away_team) } });
        }
      }
      writes.push({ key: `${label}/${ev.id}/raw/${at}`, data: ev });
      writes.push({ key: `index/${label}/${ev.id}`, merge: { sport: label, eventId: ev.id, homeTeam: ev.home_team, awayTeam: ev.away_team, commenceTime: ev.commence_time || null, books, slot, at } });
    }
  }
  summary.books = [...summary.books];
  return { writes, events, summary };
}
async function runOddsMasterPull(opts = {}) {
  const slot = String(opts.slot || '');
  if (!['0300', '1000'].includes(slot)) throw new Error(`odds-master pull: slot must be 0300 or 1000, got ${slot}`);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateISO = opts.dateISO || etDateISO(now);
  const at = now.toISOString();
  const apiKey = opts.apiKey || process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY missing');
  const fetchImpl = opts.fetchImpl || fetch;
  const eventsBySport = {};
  const errors = [];
  for (const [label, key] of SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${key}/odds?regions=${REGIONS}&markets=${MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) throw new Error(`Odds ${key} HTTP ${resp.status}`);
      eventsBySport[label] = await resp.json();
    } catch (e) { errors.push(`${label}: ${e.message}`); eventsBySport[label] = []; }
  }
  const { writes, events, summary } = planWrites(eventsBySport, slot, at, dateISO);
  const read = opts.read || readJson; const write = opts.write || writeJson;
  // Index merges first (read-modify-write), then price/raw blobs.
  await mapLimit(writes.filter(w => w.merge), 8, async (w) => {
    const prev = (await read(w.key)) || {};
    const next = { ...prev, sport: w.merge.sport, eventId: w.merge.eventId, homeTeam: w.merge.homeTeam, awayTeam: w.merge.awayTeam, commenceTime: w.merge.commenceTime,
      books: [...new Set([...(prev.books || []), ...w.merge.books])] };
    if (slot === '0300') next.baseline0300 = { at };
    else next.checks = { ...(prev.checks || {}), '1000': { at } };
    await write(w.key, next);
  });
  await mapLimit(writes.filter(w => !w.merge), 8, async (w) => { await write(w.key, w.data); });
  const prevDate = (await read(`by-date/${dateISO}`)) || { date: dateISO, events: [] };
  const byId = new Map((prevDate.events || []).map(e => [String(e.eventId), e]));
  for (const e of events) byId.set(String(e.eventId), e);
  await write(`by-date/${dateISO}`, { date: dateISO, events: [...byId.values()], updatedAt: at });
  const pullDoc = { date: dateISO, slot, at, games: summary.games, sports: summary.sports, books: summary.books, errors };
  await write(`pulls/${dateISO}/${slot}`, pullDoc);
  return pullDoc;
}
module.exports = { runOddsMasterPull, planWrites, sidesFor, SPORTS, REGIONS, MARKETS };
