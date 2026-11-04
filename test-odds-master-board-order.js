'use strict';
/** Stored-board load order. Parallel blob reads must not reorder a slate. */
const assert = require('assert');
const { loadMasterBoard } = require('./netlify/functions/lib/odds-master/board');

const DATE = '2026-11-04';
const BILLS = 'buffalo bills @ kansas city chiefs';
const CELTICS = 'boston celtics @ new york knicks';
const PACKERS = 'green bay packers @ chicago bears';
const LAKERS = 'los angeles lakers @ phoenix suns';

const T = {
  z9_03: '2026-11-04T09:00:00Z', z9_10: '2026-11-04T15:00:00Z',
  m2_03: '2026-11-04T08:00:00Z', m2_10: '2026-11-04T16:00:00Z',
  m1_03: '2026-11-04T07:00:00Z', m1_10: '2026-11-04T14:00:00Z',
  z2_03: '2026-11-04T11:00:00Z', z2_10: '2026-11-04T12:00:00Z',
  m0_03: '2026-11-04T06:00:00Z',
  q7_10: '2026-11-04T13:00:00Z',
};

function h2h(home, away) {
  return { sides: { home: { price: home }, away: { price: away } } };
}

function slateEvent(sport, eventId, away, home, commenceTime) {
  return { sport, eventId, awayTeam: away, homeTeam: home, commenceTime };
}

function indexDoc(sport, eventId, books, a03, a10) {
  const doc = { sport, eventId, books };
  if (a03) doc.baseline0300 = { at: a03 };
  if (a10) doc.checks = { '1000': { at: a10 } };
  return doc;
}

function buildStore() {
  const store = {};
  const events = [
    slateEvent('NFL', 'z9', 'Buffalo Bills', 'Kansas City Chiefs', '2026-11-04T18:00:00Z'),
    slateEvent('NBA', 'm2', 'Boston Celtics', 'New York Knicks', '2026-11-04T17:00:00Z'),
    { sport: 'NFL', eventId: 'bad', awayTeam: 'No Home' },
    slateEvent('NFL', 'm1', 'Green Bay Packers', 'Chicago Bears', '2026-11-04T21:00:00Z'),
    slateEvent('NBA', 'ghost', 'Missing Index', 'Nowhere'),
    slateEvent('NFL', 'z2', 'Buffalo Bills', 'Kansas City Chiefs', '2026-11-04T18:30:00Z'),
    slateEvent('NBA', 'm0', 'Los Angeles Lakers', 'Phoenix Suns', '2026-11-05T02:00:00Z'),
    slateEvent('NFL', 'q7', 'Empty Prices', 'No Books', '2026-11-04T22:00:00Z'),
  ];
  store[`by-date/${DATE}`] = { date: DATE, events };
  store['index/NFL/z9'] = indexDoc('NFL', 'z9', ['pinnacle', 'draftkings'], T.z9_03, T.z9_10);
  store['index/NBA/m2'] = indexDoc('NBA', 'm2', ['fanduel', 'hardrockbet'], T.m2_03, T.m2_10);
  store['index/NFL/m1'] = indexDoc('NFL', 'm1', ['draftkings', 'betmgm', 'fanatics'], T.m1_03, T.m1_10);
  store['index/NFL/z2'] = indexDoc('NFL', 'z2', ['pinnacle'], T.z2_03, T.z2_10);
  store['index/NBA/m0'] = indexDoc('NBA', 'm0', ['betmgm', 'caesars'], T.m0_03, null);
  store['index/NFL/q7'] = indexDoc('NFL', 'q7', ['pinnacle'], null, T.q7_10);

  const put = (sport, id, book, at, home, away) => {
    store[`${sport}/${id}/${book}/h2h/${at}`] = h2h(home, away);
  };
  put('NFL', 'z9', 'pinnacle', T.z9_10, -110, 100);
  put('NFL', 'z9', 'draftkings', T.z9_10, -108, 102);
  put('NFL', 'z9', 'pinnacle', T.z9_03, -105, 105);
  put('NFL', 'z9', 'draftkings', T.z9_03, -104, 106);
  put('NBA', 'm2', 'fanduel', T.m2_10, -130, 110);
  put('NBA', 'm2', 'hardrockbet', T.m2_10, -128, 112);
  put('NBA', 'm2', 'fanduel', T.m2_03, -125, 115);
  put('NBA', 'm2', 'hardrockbet', T.m2_03, -124, 116);
  // 1000 has draftkings+fanatics; 0300 has only betmgm. Union stays book-list order.
  put('NFL', 'm1', 'draftkings', T.m1_10, -115, -105);
  put('NFL', 'm1', 'fanatics', T.m1_10, -112, -108);
  put('NFL', 'm1', 'betmgm', T.m1_03, -118, -102);
  put('NFL', 'z2', 'pinnacle', T.z2_10, -150, 130);
  put('NFL', 'z2', 'pinnacle', T.z2_03, -140, 120);
  put('NBA', 'm0', 'betmgm', T.m0_03, -160, 140);
  put('NBA', 'm0', 'caesars', T.m0_03, -155, 135);
  return store;
}

function makeRead(store, delayMax) {
  let reads = 0;
  const read = async (key) => {
    reads += 1;
    if (delayMax > 0) {
      const ms = Math.floor(Math.random() * delayMax);
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return store[key] == null ? null : store[key];
  };
  return { read, get reads() { return reads; } };
}

function assertBoard(board) {
  assert.ok(board);
  assert.strictEqual(board.date, DATE);
  assert.deepStrictEqual(Object.keys(board.eventsBySport), ['NFL', 'NBA']);
  assert.deepStrictEqual(board.eventsBySport.NFL.map((ev) => ev.id), ['z9', 'm1', 'z2']);
  assert.deepStrictEqual(board.eventsBySport.NBA.map((ev) => ev.id), ['m2']);
  assert.deepStrictEqual(Object.keys(board.games1000), [BILLS, CELTICS, PACKERS]);
  assert.deepStrictEqual(Object.keys(board.games0300), [BILLS, CELTICS, PACKERS, LAKERS]);
  assert.strictEqual(board.games1000[BILLS].books.pinnacle.mlHome, -150);
  assert.strictEqual(board.games1000[BILLS].books.draftkings, undefined);
  assert.strictEqual(board.games0300[BILLS].books.pinnacle.mlHome, -140);
  assert.deepStrictEqual(board.booksSeen, [
    'pinnacle', 'draftkings', 'fanduel', 'hardrockbet', 'betmgm', 'fanatics', 'caesars',
  ]);
  // Last non-null timestamp in slate order, not the latest clock time.
  assert.strictEqual(board.at0300, T.m0_03);
  assert.strictEqual(board.at1000, T.q7_10);
  assert.deepStrictEqual(board.polls.map((p) => p.hhmm), ['0300', '1000']);
  assert.strictEqual(board.polls[0].capturedAt, T.m0_03);
  assert.strictEqual(board.polls[1].capturedAt, T.q7_10);
  assert.deepStrictEqual(Object.keys(board.polls[0].games), Object.keys(board.games0300));
  assert.deepStrictEqual(Object.keys(board.polls[1].games), Object.keys(board.games1000));
}

async function load(delayMax) {
  const store = buildStore();
  const reader = makeRead(store, delayMax);
  const board = await loadMasterBoard(DATE, reader.read);
  return { board, reads: reader.reads };
}

async function main() {
  const quiet = await load(0);
  assert.strictEqual(quiet.reads, 65);
  assertBoard(quiet.board);
  const quietJson = JSON.stringify(quiet.board);

  const runs = 20;
  for (let i = 0; i < runs; i += 1) {
    const noisy = await load(30);
    assert.strictEqual(noisy.reads, quiet.reads, `run ${i} read count changed`);
    assert.strictEqual(JSON.stringify(noisy.board), quietJson, `run ${i} reordered the board`);
    assertBoard(noisy.board);
  }
  console.log(`test-odds-master-board-order: ALL PASS (${runs} shuffled runs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
