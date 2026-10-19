'use strict';
/** Odds-master 3AM/10AM pull + board reader tests. No network, no blobs. */
const assert = require('assert');
const { planWrites, sidesFor } = require('./netlify/functions/lib/odds-master/pull');
const { outcomesFor, loadMasterBoard } = require('./netlify/functions/lib/odds-master/board');
const ev = { id: 'ev1', sport: 'americanfootball_nfl', home_team: 'Home', away_team: 'Away', commence_time: '2026-10-19T17:00:00Z',
  bookmakers: [
    { key: 'hardrockbet', markets: [{ key: 'spreads', outcomes: [{ name: 'Home', price: -110, point: -3 }, { name: 'Away', price: -110, point: 3 }] }, { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 45 }, { name: 'Under', price: -110, point: 45 }] }, { key: 'h2h', outcomes: [{ name: 'Home', price: -150 }, { name: 'Away', price: 130 }] }] },
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: -155 }, { name: 'Away', price: 135 }] }] },
    { key: 'draftkings', markets: [{ key: 'spreads', outcomes: [{ name: 'Home', price: -105, point: -3.5 }, { name: 'Away', price: -115, point: 3.5 }] }] },
  ] };
const { writes, events, summary } = planWrites({ NFL: [ev] }, '1000', '2026-10-19T14:00:00.000Z', '2026-10-19');
assert.strictEqual(events.length, 1); assert.strictEqual(summary.games, 1);
assert.deepStrictEqual(summary.books.sort(), ['draftkings', 'hardrockbet', 'pinnacle']);
// Every book/market stored + raw + index merge
assert.ok(writes.some(w => w.key === 'NFL/ev1/pinnacle/h2h/2026-10-19T14:00:00.000Z'));
assert.ok(writes.some(w => w.key === 'NFL/ev1/raw/2026-10-19T14:00:00.000Z'));
assert.ok(writes.find(w => w.merge).merge.slot === '1000');
const hrSpread = writes.find(w => w.key.startsWith('NFL/ev1/hardrockbet/spreads')).data.sides;
assert.strictEqual(hrSpread.home.line, -3); assert.strictEqual(hrSpread.away.price, -110);
// Board reader rebuilds all books from stored price blobs
const store = {};
for (const w of writes) if (!w.merge) store[w.key] = w.data;
store['by-date/2026-10-19'] = { date: '2026-10-19', events };
store['index/NFL/ev1'] = { sport: 'NFL', eventId: 'ev1', books: ['hardrockbet', 'pinnacle', 'draftkings'], checks: { '1000': { at: '2026-10-19T14:00:00.000Z' } }, baseline0300: { at: '2026-10-19T07:00:00.000Z' } };
// baseline price blobs (0300) for line-path open
for (const w of writes) if (!w.merge) store[w.key.replace('2026-10-19T14:00:00.000Z', '2026-10-19T07:00:00.000Z')] = w.data;
(async () => {
  const board = await loadMasterBoard('2026-10-19', async (k) => store[k] || null);
  assert.ok(board); assert.strictEqual(board.polls.length, 2);
  assert.deepStrictEqual(board.polls.map(p => p.hhmm), ['0300', '1000']);
  const ev1000 = board.eventsBySport.NFL[0];
  assert.deepStrictEqual(ev1000.bookmakers.map(b => b.key).sort(), ['draftkings', 'hardrockbet', 'pinnacle']);
  const dk = ev1000.bookmakers.find(b => b.key === 'draftkings');
  assert.strictEqual(dk.markets[0].outcomes.find(o => o.name === 'Home').point, -3.5);
  // Omega stored-ingest mode makes no live call shape
  const { fetchOddsMultiSport } = require('./netlify/functions/lib/omega-vnext/ingest');
  const out = await fetchOddsMultiSport('2026-10-19', { storedOddsBySport: board.eventsBySport, storedFetchedAt: board.at1000 });
  assert.strictEqual(out.snapshotNote, 'stored-odds-master-1000');
  assert.strictEqual(out.bySport.NFL.length, 1);
  console.log('test-odds-master: ALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
