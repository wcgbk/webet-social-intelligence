#!/usr/bin/env node
'use strict';
// 3 AM close copies the last saved Pinnacle price onto each card pick.
// OMEGA_SAVED_PICK_CLOSE=off keeps the old name match and archive-only reader.
const assert = require('assert');
const C = require('./netlify/functions/lib/closes-3am');
const track = require('./netlify/functions/track-clv-omega');

const OFF = { OMEGA_SAVED_PICK_CLOSE: 'off' };
const ON = {};
const TIP = '2026-11-17T23:00:00Z';
const AT10 = '2026-11-17T15:00:00Z';

function pinnacleEvent(id, home, away, markets) {
  return {
    id,
    home_team: home,
    away_team: away,
    commence_time: TIP,
    bookmakers: [{ key: 'pinnacle', markets }],
  };
}

function totals(line, overPrice, underPrice) {
  return {
    key: 'totals',
    outcomes: [
      { name: 'Over', price: overPrice, point: line },
      { name: 'Under', price: underPrice, point: line },
    ],
  };
}

const shsu = pinnacleEvent('shsu', 'Wyoming Cowboys', 'Sam Houston State Bearkats', [totals(149.5, -108, -112)]);
const siue = pinnacleEvent('siue', 'North Dakota Fighting Hawks', 'SIU Edwardsville Cougars', [{
  key: 'h2h',
  outcomes: [
    { name: 'North Dakota Fighting Hawks', price: -180 },
    { name: 'SIU Edwardsville Cougars', price: 155 },
  ],
}]);
const akron = pinnacleEvent('akron', 'Bucknell Bison', 'Akron Zips', [{
  key: 'spreads',
  outcomes: [
    { name: 'Bucknell Bison', price: -110, point: 14.5 },
    { name: 'Akron Zips', price: -110, point: -14.5 },
  ],
}]);

function board(master, sport, eventId, event) {
  master[`index/${sport}/${eventId}`] = {
    sport,
    eventId,
    checks: { '1000': { at: AT10 } },
  };
  master[`${sport}/${eventId}/raw/${AT10}`] = event;
}

function masterFor() {
  const master = {};
  board(master, 'NCAAM', 'shsu', shsu);
  board(master, 'NCAAM', 'siue', siue);
  board(master, 'NCAAM', 'akron', akron);
  master['by-date/2026-11-17'] = {
    date: '2026-11-17',
    events: [
      { sport: 'NCAAM', eventId: 'shsu', homeTeam: 'Wyoming Cowboys', awayTeam: 'Sam Houston State Bearkats', commenceTime: TIP },
      { sport: 'NCAAM', eventId: 'siue', homeTeam: 'North Dakota Fighting Hawks', awayTeam: 'SIU Edwardsville Cougars', commenceTime: TIP },
      { sport: 'NCAAM', eventId: 'akron', homeTeam: 'Bucknell Bison', awayTeam: 'Akron Zips', commenceTime: TIP },
    ],
  };
  return master;
}

function readMaster(master) {
  return async (key) => (Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null);
}

const card = {
  picks: [
    { sport: 'NCAAM', matchup: 'Sam Houston St @ Wyoming', pick: 'Over 149.5', betType: 'Total', commenceTime: TIP, odds: -105 },
    { sport: 'NCAAM', matchup: 'SIU-Edwardsville @ North Dakota', pick: 'SIU-Edwardsville ML', betType: 'Moneyline', commenceTime: TIP, odds: 140 },
    { sport: 'NCAAM', matchup: 'Akron @ Bucknell', pick: 'Akron -14.5', betType: 'Spread', commenceTime: TIP, odds: -110 },
  ],
};

const slate = [
  { sport: 'NCAAM', eventId: 'shsu', awayTeam: 'Sam Houston State Bearkats', homeTeam: 'Wyoming Cowboys', commenceTime: TIP },
  { sport: 'NCAAM', eventId: 'siue', awayTeam: 'SIU Edwardsville Cougars', homeTeam: 'North Dakota Fighting Hawks', commenceTime: TIP },
  { sport: 'NCAAM', eventId: 'akron', awayTeam: 'Akron Zips', homeTeam: 'Bucknell Bison', commenceTime: TIP },
];

function pickRow(run, text) {
  return run.picks.find((row) => row.pick === text);
}

async function main() {
  const probe = { sport: 'NCAAM', awayTeam: 'Sam Houston St', homeTeam: 'Wyoming', commenceTime: TIP };
  const listed = { sport: 'NCAAM', eventId: 'shsu', awayTeam: 'Sam Houston State Bearkats', homeTeam: 'Wyoming Cowboys', commenceTime: TIP };
  assert.strictEqual(C.sameGame(probe, listed, ON), true);
  // "Sam Houston St" is already a substring of "Sam Houston State …". The hyphenated
  // school is the name the old matcher drops.
  const siueProbe = { sport: 'NCAAM', awayTeam: 'SIU-Edwardsville', homeTeam: 'North Dakota', commenceTime: TIP };
  const siueListed = { sport: 'NCAAM', eventId: 'siue', awayTeam: 'SIU Edwardsville Cougars', homeTeam: 'North Dakota Fighting Hawks', commenceTime: TIP };
  assert.strictEqual(C.sameGame(siueProbe, siueListed, ON), true);
  assert.strictEqual(C.sameGame(siueProbe, siueListed, OFF), false);
  assert.strictEqual(C.pairMatch('SIU-Edwardsville', 'SIU Edwardsville Cougars', 'NCAAM', ON), true);
  assert.strictEqual(C.pairMatch('SIU-Edwardsville', 'SIU Edwardsville Cougars', 'NCAAM', OFF), false);
  assert.strictEqual(C.pairMatch('Akron', 'Akron Zips', 'NCAAM', OFF), true);
  assert.strictEqual(C.pairMatch('Patriots', 'Chiefs', 'NFL', ON), false);

  const exact = C.quoteFromEvent(shsu, { sport: 'NCAAM', pick: 'Over 149.5', betType: 'Total' }, ON);
  assert.strictEqual(exact.status, 'closed');
  assert.strictEqual(exact.closingOdds, -108);
  assert.strictEqual(exact.closingLine, 149.5);
  assert.strictEqual(exact.oppOdds, -112);
  assert.strictEqual(exact.closeFallback, null);
  assert.strictEqual(exact.anchor, 'pinnacle');

  const moved = pinnacleEvent('shsu', 'Wyoming Cowboys', 'Sam Houston State Bearkats', [totals(150.5, -110, -110)]);
  const posted = C.quoteFromEvent(moved, { sport: 'NCAAM', pick: 'Over 149.5', betType: 'Total' }, ON);
  assert.strictEqual(posted.closingOdds, -110);
  assert.strictEqual(posted.closingLine, 150.5);
  assert.strictEqual(posted.closeFallback, 'posted-line');

  const ml = C.quoteFromEvent(siue, { sport: 'NCAAM', pick: 'SIU-Edwardsville ML', betType: 'Moneyline' }, ON);
  assert.strictEqual(ml.closingOdds, 155);
  assert.strictEqual(ml.closingLine, null);
  assert.strictEqual(ml.oppOdds, -180);

  const spread = C.quoteFromEvent(akron, { sport: 'NCAAM', pick: 'Akron -14.5', betType: 'Spread' }, ON);
  assert.strictEqual(spread.closingOdds, -110);
  assert.strictEqual(spread.closingLine, -14.5);
  assert.strictEqual(spread.oppOdds, -110);
  assert.strictEqual(spread.closeFallback, null);

  const master = masterFor();
  let fetches = 0;
  const savedRun = await C.runCloses({
    now: new Date('2026-11-18T08:00:00Z'),
    env: ON,
    date: '2026-11-17',
    slateEvents: slate,
    card,
    readMaster: readMaster(master),
    writeRows: async () => ({ games: 1, odds_snapshots: 1, requests: 0 }),
    fetch: async () => { fetches += 1; throw new Error('odds api must not be called'); },
  });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(savedRun.mode, 'saved-board');
  const over = pickRow(savedRun, 'Over 149.5');
  const mlRow = pickRow(savedRun, 'SIU-Edwardsville ML');
  const akronRow = pickRow(savedRun, 'Akron -14.5');
  assert.strictEqual(over.closingOdds, -108);
  assert.strictEqual(over.closingLine, 149.5);
  assert.strictEqual(over.closeSlot, '1000');
  assert.strictEqual(over.closeSnapshotAt, AT10);
  assert.strictEqual(over.anchor, 'pinnacle');
  assert.strictEqual(over.eventId, 'shsu');
  assert.strictEqual(mlRow.closingOdds, 155);
  assert.strictEqual(mlRow.closingLine, null);
  assert.strictEqual(akronRow.closingOdds, -110);
  assert.strictEqual(akronRow.closingLine, -14.5);
  assert.strictEqual(akronRow.closeFallback, null);

  const offRun = await C.runCloses({
    now: new Date('2026-11-18T08:00:00Z'),
    env: OFF,
    date: '2026-11-17',
    slateEvents: slate,
    card,
    readMaster: readMaster(master),
    writeRows: async () => ({ games: 1, odds_snapshots: 1, requests: 0 }),
    fetch: async () => { throw new Error('odds api must not be called'); },
  });
  assert.strictEqual(pickRow(offRun, 'Over 149.5').closingOdds, undefined);
  assert.strictEqual(pickRow(offRun, 'SIU-Edwardsville ML').closingOdds, undefined);
  assert.strictEqual(pickRow(offRun, 'Akron -14.5').closingOdds, undefined);
  assert.strictEqual(pickRow(offRun, 'Over 149.5').eventId, 'shsu');
  assert.notStrictEqual(pickRow(offRun, 'SIU-Edwardsville ML').eventId, 'siue');

  const stored = await C.loadStoredEventsForSport('basketball_ncaab', {
    date: '2026-11-17',
    readMaster: readMaster(master),
    env: ON,
  });
  assert.strictEqual(stored.length, 3);
  assert.ok(stored.some((event) => event.id === 'shsu' && event.bookmakers[0].key === 'pinnacle'));
  const storedOff = await C.loadStoredEventsForSport('basketball_ncaab', {
    date: '2026-11-17',
    readMaster: readMaster(master),
    env: OFF,
  });
  assert.strictEqual(storedOff.length, 0);

  const archive = new Map();
  const archiveBlobs = {
    async get(store, key) { return archive.get(`${store}:${key}`) || null; },
    async set(store, key, value) { archive.set(`${store}:${key}`, value); },
    async list(store, prefix) {
      const head = `${store}:${prefix}`;
      return [...archive.keys()].filter((key) => key.startsWith(head)).map((key) => key.slice(`${store}:`.length));
    },
  };
  await archiveBlobs.set('clv-close-capture', 'raw/2026-11-15/NHL/late.json', {
    meta: { timestamp: '2026-11-16T02:09:00Z' },
    body: { data: [pinnacleEvent('nhl-1', 'Vancouver Canucks', 'Seattle Kraken', [totals(6.5, -110, -110)])] },
  });
  const nhl = await C.loadStoredEventsForSport('icehockey_nhl', {
    date: '2026-11-15',
    blobs: archiveBlobs,
    readMaster: async () => null,
    env: ON,
  });
  assert.strictEqual(nhl.length, 1);
  assert.strictEqual(nhl[0].id, 'nhl-1');

  const found = track._test.findMatchingGame(card.picks[0], [shsu], ON);
  assert.strictEqual(found && found.id, 'shsu');
  assert.strictEqual(track._test.findMatchingGame(card.picks[0], [shsu], OFF), null);
  assert.strictEqual(track._test.findMatchingGame(card.picks[1], [siue], ON).id, 'siue');
  assert.strictEqual(track._test.findMatchingGame(card.picks[2], [akron], ON).id, 'akron');
  const nfl = {
    id: 'nfl-1',
    home_team: 'Detroit Lions',
    away_team: 'New England Patriots',
    bookmakers: [],
  };
  const nflPick = { sport: 'NFL', matchup: 'New England Patriots @ Detroit Lions', pick: 'Detroit Lions -3.5' };
  assert.strictEqual(track._test.findMatchingGame(nflPick, [nfl], ON).id, 'nfl-1');

  const side = track._test.pickSideInfo(card.picks[0]);
  const close = track._test.extractClose(shsu, side, card.picks[0], ON);
  assert.strictEqual(close.sideOdds, -108);
  assert.strictEqual(close.closingLine, 149.5);
  assert.strictEqual(close.oppOdds, -112);
  assert.strictEqual(close.closeFallback, undefined);
  const movedClose = track._test.extractClose(moved, side, card.picks[0], ON);
  assert.strictEqual(movedClose.closingLine, 150.5);
  assert.strictEqual(movedClose.closeFallback, 'posted-line');
  const mlSide = track._test.pickSideInfo(card.picks[1]);
  const mlClose = track._test.extractClose(siue, mlSide, card.picks[1], ON);
  assert.strictEqual(mlClose.sideOdds, 155);
  assert.strictEqual(mlClose.oppOdds, -180);
  const spSide = track._test.pickSideInfo(card.picks[2]);
  const spClose = track._test.extractClose(akron, spSide, card.picks[2], ON);
  assert.strictEqual(spClose.sideOdds, -110);
  assert.strictEqual(spClose.closingLine, -14.5);

  console.log('test-omega-saved-pick-close: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
