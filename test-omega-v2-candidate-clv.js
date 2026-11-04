'use strict';

/**
 * Scored-candidate close fields. No sockets.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.fetch = async () => {
  throw new Error('network blocked');
};

const clv = require('./netlify/functions/lib/omega-v2/candidate_clv');
const { noVigTwoWay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { gameKey } = require('./netlify/functions/lib/omega-vnext/line_path');

const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';
const HOME2 = 'Miami Dolphins';
const AWAY2 = 'New England Patriots';
const COMMENCE = '2026-11-01T18:00:00Z';
const BET_AT = '2026-11-01T15:00:00Z';

function bookRow(partial) {
  return {
    spreadHome: null, spreadHomeOdds: null, spreadAway: null, spreadAwayOdds: null,
    total: null, overOdds: null, underOdds: null,
    mlHome: null, mlAway: null,
    ...partial,
  };
}

function game(home, away, commence, books) {
  return { homeTeam: home, awayTeam: away, commenceTime: commence, books };
}

function put(map, home, away, commence, books) {
  map[gameKey(away, home)] = game(home, away, commence, books);
}

function fair(side, opp) {
  return Number(noVigTwoWay(side, opp).p1.toFixed(6));
}

function find(rows, side) {
  const hit = rows.find((row) => String(row.side).includes(side));
  assert.ok(hit, `missing ${side}`);
  return hit;
}

function testEveryCandidateAndClvMath() {
  const morning = {};
  put(morning, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 130, mlHome: -150 }),
    draftkings: bookRow({ mlAway: 125, mlHome: -145 }),
  });
  put(morning, HOME2, AWAY2, COMMENCE, {
    pinnacle: bookRow({ mlAway: 110, mlHome: -130 }),
    draftkings: bookRow({ mlAway: 105, mlHome: -125 }),
  });
  const close = {};
  put(close, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
  });
  put(close, HOME2, AWAY2, COMMENCE, {
    pinnacle: bookRow({ mlAway: 120, mlHome: -140 }),
    draftkings: bookRow({ mlAway: 115, mlHome: -135 }),
  });
  const snaps = [
    { source: 'odds-master-1000', capturedAt: '2026-11-01T14:00:00Z', role: 'board', games: morning },
    { source: 'track-clv', capturedAt: COMMENCE, role: 'close', games: close },
  ];
  const bills = {
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: `${AWAY} ML`, market: 'Moneyline',
    odds: '+120', book: 'draftkings', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
    openPrint: { odds: '+110', book: 'draftkings' },
    pMkt: 0.99,
  };
  const chiefs = {
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: HOME, market: 'Moneyline',
    odds: -145, book: 'draftkings', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  };
  const fins = {
    sport: 'NFL', matchup: `${AWAY2} @ ${HOME2}`, side: HOME2, market: 'ML',
    odds: -125, book: 'hardrock', homeTeam: HOME2, awayTeam: AWAY2, commenceTime: COMMENCE,
  };
  const rows = clv.gradeScoredCandidates([bills, chiefs, fins], {
    snapshots: snaps,
    published: [bills],
    betAt: BET_AT,
  });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows.filter((row) => row.published).length, 1);

  const away = find(rows, AWAY);
  assert.strictEqual(away.published, true);
  assert.strictEqual(away.openPrice, 110);
  assert.strictEqual(away.openBook, 'draftkings');
  assert.strictEqual(away.betPrice, 120);
  assert.strictEqual(away.betBook, 'draftkings');
  assert.strictEqual(away.market, 'ml');
  const betFair = fair(130, -150);
  const closeFair = fair(140, -160);
  assert.strictEqual(away.pinnacleFairBet, betFair);
  assert.strictEqual(away.pinnacleFairClose, closeFair);
  assert.notStrictEqual(away.pinnacleFairBet, 0.99);
  const delta = Number((closeFair - betFair).toFixed(6));
  assert.strictEqual(away.clvProbDelta, delta);
  assert.strictEqual(away.clvPct, Number((delta * 100).toFixed(4)));
  assert.strictEqual(away.closePrice, 135);
  assert.strictEqual(away.closeBook, 'draftkings');
  assert.strictEqual(away.closeSource, 'track-clv');
  assert.strictEqual(away.pMkt, undefined);
  assert.ok(clv.hasCloseClv(away));

  const home = find(rows, HOME);
  assert.strictEqual(home.published, false);
  assert.strictEqual(home.pinnacleFairBet, fair(-150, 130));
  assert.strictEqual(home.pinnacleFairClose, fair(-160, 140));
  assert.strictEqual(home.closeSource, 'track-clv');

  const other = find(rows, HOME2);
  assert.strictEqual(other.published, false);
  assert.strictEqual(other.betBook, 'hardrockbet');
  assert.strictEqual(other.closeBook, 'draftkings');
  assert.ok(clv.hasCloseClv(other));
  assert.strictEqual(clv.rowKey(bills), clv.rowKey({
    sport: 'nfl', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'ML',
  }));
}

function testMorningBoardIsNotAClose() {
  const games = {};
  put(games, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 130, mlHome: -150 }),
    draftkings: bookRow({ mlAway: 125, mlHome: -145 }),
  });
  const rows = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
    odds: -110, book: 'draftkings', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  }], {
    snapshots: [{ source: 'odds-master-1000', capturedAt: '2026-11-01T14:00:00Z', role: 'board', games }],
    betAt: BET_AT,
  });
  assert.strictEqual(rows[0].closeSource, null);
  assert.strictEqual(rows[0].closePrice, null);
  assert.strictEqual(rows[0].pinnacleFairClose, null);
  assert.strictEqual(rows[0].clvProbDelta, null);
  assert.strictEqual(rows[0].pinnacleFairBet, fair(130, -150));
  assert.strictEqual(rows[0].betPrice, -110);
}

function testNearKickBoardAndWindowEdges() {
  const games = {};
  put(games, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
  });
  const cand = {
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
    odds: 120, book: 'draftkings', pinnacleFairBet: fair(130, -150),
    homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  };
  const near = clv.gradeScoredCandidates([cand], {
    snapshots: [{ source: 'odds-master-1000', capturedAt: '2026-11-01T17:50:00Z', role: 'board', games }],
  });
  assert.strictEqual(near[0].closeSource, 'odds-master-1000');
  assert.strictEqual(near[0].closePrice, 135);

  const late = clv.gradeScoredCandidates([cand], {
    snapshots: [{ source: 'odds-master-1000', capturedAt: '2026-11-01T18:04:00Z', role: 'board', games }],
  });
  assert.strictEqual(late[0].closeSource, null);

  const before = {};
  const after = {};
  put(before, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 111, mlHome: -130 }),
  });
  put(after, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 150, mlHome: -170 }),
    draftkings: bookRow({ mlAway: 222, mlHome: -250 }),
  });
  const prefer = clv.gradeScoredCandidates([cand], {
    snapshots: [
      { source: 'line-snap-0915', capturedAt: '2026-11-01T18:01:00Z', role: 'board', games: after },
      { source: 'line-snap-0900', capturedAt: '2026-11-01T17:59:00Z', role: 'board', games: before },
    ],
  });
  assert.strictEqual(prefer[0].closeSource, 'line-snap-0900');
  assert.strictEqual(prefer[0].closePrice, 111);
}

function testHardRockAliasAndMissingPinnacle() {
  const games = {};
  put(games, HOME, AWAY, COMMENCE, {
    hardrock: bookRow({ mlAway: 150, mlHome: -170 }),
  });
  const rows = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
    odds: 140, book: 'hardrockbet', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
    pMkt: 0.42, fair_sharp_p: 0.41,
  }], {
    snapshots: [{ source: 'line-snap-1000', capturedAt: COMMENCE, role: 'board', games }],
  });
  assert.strictEqual(rows[0].closeBook, 'hardrockbet');
  assert.strictEqual(rows[0].closePrice, 150);
  assert.strictEqual(rows[0].closeSource, 'line-snap-1000');
  assert.strictEqual(rows[0].pinnacleFairBet, null);
  assert.strictEqual(rows[0].pinnacleFairClose, null);
  assert.strictEqual(rows[0].clvProbDelta, null);
  assert.strictEqual(rows[0].fair_sharp_p, undefined);
}

function testBetBookPrefersHardRockWhenBothPosted() {
  const games = {};
  put(games, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
    hardrockbet: bookRow({ mlAway: 150, mlHome: -170 }),
  });
  const rows = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
    odds: 145, book: 'hardrock', pinnacleFairBet: 0.4,
    homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  }], {
    snapshots: [{ source: 'track-clv', capturedAt: COMMENCE, role: 'close', games }],
  });
  assert.strictEqual(rows[0].closeBook, 'hardrockbet');
  assert.strictEqual(rows[0].closePrice, 150);
  assert.strictEqual(rows[0].betBook, 'hardrockbet');
}

function testMovedSpreadDoesNotThrow() {
  const morning = {};
  const close = {};
  put(morning, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ spreadHome: -3, spreadHomeOdds: -110, spreadAway: 3, spreadAwayOdds: -110 }),
    draftkings: bookRow({ spreadHome: -3, spreadHomeOdds: -108, spreadAway: 3, spreadAwayOdds: -112 }),
  });
  put(close, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ spreadHome: -3.5, spreadHomeOdds: -115, spreadAway: 3.5, spreadAwayOdds: -105 }),
    draftkings: bookRow({ spreadHome: -3.5, spreadHomeOdds: -108, spreadAway: 3.5, spreadAwayOdds: -112 }),
  });
  const rows = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: `${HOME} -3`, market: 'Spread',
    line: -3, odds: -108, book: 'draftkings', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  }], {
    snapshots: [
      { source: 'odds-master-1000', capturedAt: '2026-11-01T14:00:00Z', role: 'board', games: morning },
      { source: 'track-clv', capturedAt: COMMENCE, role: 'close', games: close },
    ],
    betAt: BET_AT,
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].pinnacleFairBet, fair(-110, -110));
  assert.strictEqual(rows[0].pinnacleFairClose, null);
  assert.strictEqual(rows[0].closePrice, null);
  assert.strictEqual(rows[0].closeSource, null);
  assert.strictEqual(rows[0].clvProbDelta, null);
}

function testOtherGameTimestampIsNotThisClose() {
  const early = {};
  const late = {};
  put(early, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
  });
  put(late, HOME2, AWAY2, '2026-11-01T23:30:00Z', {
    pinnacle: bookRow({ mlAway: 120, mlHome: -140 }),
    draftkings: bookRow({ mlAway: 115, mlHome: -135 }),
  });
  const cache = new Map();
  cache.set('americanfootball_nfl|2026-11-01T18:00:00Z', [{
    home_team: HOME, away_team: AWAY, commence_time: COMMENCE,
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: AWAY, price: 140 }, { name: HOME, price: -160 }] }] },
      { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: AWAY, price: 135 }, { name: HOME, price: -155 }] }] },
    ],
  }]);
  const snaps = clv.snapshotsFromBulkCache(cache, '2026-11-01T17:40:00Z').concat([
    { source: 'track-clv', capturedAt: '2026-11-01T23:30:00Z', role: 'close', games: late },
  ]);
  // The 18:00 slate pull is a close for the 18:00 game only.
  void early;
  const rows = clv.gradeScoredCandidates([
    {
      sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
      odds: 120, book: 'draftkings', pinnacleFairBet: fair(130, -150),
      homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
    },
    {
      sport: 'NFL', matchup: `${AWAY2} @ ${HOME2}`, side: AWAY2, market: 'Moneyline',
      odds: 105, book: 'draftkings', pinnacleFairBet: fair(110, -130),
      homeTeam: HOME2, awayTeam: AWAY2, commenceTime: '2026-11-01T23:30:00Z',
    },
  ], { snapshots: snaps });
  assert.strictEqual(rows[0].closeSource, 'track-clv');
  assert.strictEqual(rows[0].closePrice, 135);
  assert.strictEqual(rows[0].pinnacleFairClose, fair(140, -160));
  assert.strictEqual(rows[1].closeSource, 'track-clv');
  assert.strictEqual(rows[1].closePrice, 115);
  const missed = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY2} @ ${HOME2}`, side: AWAY2, market: 'Moneyline',
    odds: 105, book: 'draftkings', homeTeam: HOME2, awayTeam: AWAY2,
    commenceTime: '2026-11-01T23:30:00Z',
  }], { snapshots: clv.snapshotsFromBulkCache(cache, '2026-11-01T17:40:00Z') });
  assert.strictEqual(missed[0].closeSource, null);
}

function testContextLabelsAndAccentKey() {
  const games = {};
  put(games, 'Boston Bruins', 'Montreal Canadiens', '2026-11-03T00:00:00Z', {
    pinnacle: bookRow({ mlAway: 130, mlHome: -150 }),
  });
  const polls = [{ hhmm: '1000', capturedAt: '2026-11-02T14:00:00Z', games }];
  const master = { games1000: games, at1000: '2026-11-02T14:00:00Z', polls };
  const same = clv.snapshotsFromContext({ masterBoard: master, linePathMeta: { path: { polls } } });
  assert.deepStrictEqual(same.map((snap) => snap.source), ['odds-master-1000']);
  const other = clv.snapshotsFromContext({
    masterBoard: master,
    linePathMeta: { path: { polls: [{ hhmm: '0600', capturedAt: '2026-11-02T10:00:00Z', games }] } },
  });
  assert.ok(other.some((snap) => snap.source === 'odds-master-1000'));
  assert.ok(other.some((snap) => snap.source === 'line-snap-0600'));
  const keyA = clv.rowKey({
    sport: 'NHL', matchup: 'Montréal Canadiens @ Boston Bruins', side: 'Montréal Canadiens ML', market: 'Moneyline',
  });
  const keyB = clv.rowKey({
    sport: 'NHL', matchup: 'Montreal Canadiens @ Boston Bruins', side: 'Montreal Canadiens', market: 'ML',
  });
  assert.strictEqual(keyA, keyB);
}

function testOpenFromEarliestBoard() {
  const early = {};
  const late = {};
  put(early, HOME, AWAY, COMMENCE, { draftkings: bookRow({ mlAway: 100, mlHome: -120 }) });
  put(late, HOME, AWAY, COMMENCE, { draftkings: bookRow({ mlAway: 115, mlHome: -135 }) });
  const rows = clv.gradeScoredCandidates([{
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
    homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
  }], {
    snapshots: [
      { source: 'odds-master-1000', capturedAt: '2026-11-01T14:00:00Z', role: 'board', games: late },
      { source: 'odds-master-0300', capturedAt: '2026-11-01T07:00:00Z', role: 'board', games: early },
    ],
    betAt: BET_AT,
  });
  assert.strictEqual(rows[0].openPrice, 100);
  assert.strictEqual(rows[0].openBook, 'draftkings');
  assert.strictEqual(rows[0].betPrice, 115);
  assert.strictEqual(rows[0].closeSource, null);
}

function testExplicitFairKeptAndBadRowDoesNotThrow() {
  const rows = clv.gradeScoredCandidates([
    null,
    {
      sport: 'NBA', matchup: 'A @ B', side: 'A', market: 'Moneyline',
      pinnacleFairBet: 0.41, pMkt: 0.99,
    },
  ], { snapshots: [] });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].pinnacleFairBet, 0.41);
  assert.notStrictEqual(rows[1].pinnacleFairBet, 0.99);
}

function testCapAndStableOrder() {
  const many = [];
  for (let i = 0; i < 300; i++) {
    many.push({
      sport: 'NBA', matchup: `A${i} @ B${i}`, side: `A${i}`, market: 'Moneyline', odds: -110, book: 'draftkings',
    });
  }
  const graded = clv.gradeScoredCandidates(many, { snapshots: [] });
  const bounded = clv.boundCandidates(graded, graded.length);
  assert.strictEqual(graded.length, 300);
  assert.strictEqual(bounded.storedCount, 240);
  assert.strictEqual(bounded.capped, true);
  const stable = clv.boundCandidates([
    { rowKey: 'b', sport: 'NFL' },
    { rowKey: 'a', sport: 'NFL' },
  ], 2);
  assert.strictEqual(stable.capped, false);
  assert.strictEqual(stable.rows[0].rowKey, 'b');

  const fat = [];
  for (let i = 0; i < 5; i++) {
    fat.push({
      rowKey: `c${i}`, sport: 'NFL', closeSource: 'track-clv', closePrice: -110,
      pinnacleFairClose: 0.5, clvProbDelta: 0.01, closeBook: 'draftkings',
    });
  }
  for (let i = 0; i < 8; i++) {
    fat.push({ rowKey: `n${i}`, sport: 'NFL', matchup: 'm'.repeat(30000), closeSource: null });
  }
  const packed = clv.boundCandidates(fat, fat.length);
  assert.strictEqual(packed.capped, true);
  assert.ok(JSON.stringify(packed.rows).length <= clv.MAX_JSON_BYTES);
  for (let i = 0; i < 5; i++) assert.ok(packed.rows.some((row) => row.rowKey === `c${i}`));
}

function testMergeKeepsBetAndPriorClose() {
  const prev = [{
    rowKey: 'nfl|a @ b|ml|a|',
    sport: 'NFL',
    openPrice: -105,
    openBook: 'draftkings',
    betPrice: -110,
    betBook: 'draftkings',
    pinnacleFairBet: 0.4,
    pinnacleFairClose: 0.42,
    closePrice: -110,
    closeBook: 'draftkings',
    clvProbDelta: 0.02,
    clvPct: 2,
    closeSource: 'track-clv',
    published: false,
  }];
  const kept = clv.mergeCandidateRows(prev, [{
    rowKey: prev[0].rowKey,
    pinnacleFairBet: null,
    openPrice: null,
    betPrice: null,
    closeSource: null,
    closePrice: null,
    pinnacleFairClose: null,
    clvProbDelta: null,
    clvPct: null,
    published: true,
  }]);
  assert.strictEqual(kept[0].pinnacleFairBet, 0.4);
  assert.strictEqual(kept[0].openPrice, -105);
  assert.strictEqual(kept[0].closeSource, 'track-clv');
  assert.strictEqual(kept[0].closePrice, -110);
  assert.strictEqual(kept[0].published, true);
  const replaced = clv.mergeCandidateRows(prev, [{
    rowKey: prev[0].rowKey,
    closeSource: 'track-clv-live',
    closePrice: -120,
    closeBook: 'hardrockbet',
    pinnacleFairClose: 0.45,
    clvProbDelta: 0.05,
    clvPct: 5,
    pinnacleFairBet: 0.4,
  }]);
  assert.strictEqual(replaced[0].closeSource, 'track-clv-live');
  assert.strictEqual(replaced[0].closePrice, -120);
}

async function testSeedNeverThrowsAndPreservesPicks() {
  const cand = {
    sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline', odds: -110, book: 'draftkings',
  };
  let writes = 0;
  const dry = await clv.seedCandidateClv({
    dryRun: true,
    dateISO: '2026-11-01',
    candidates: [cand],
    writeJson: async () => { writes += 1; },
  });
  assert.strictEqual(dry.saved, false);
  assert.strictEqual(writes, 0);
  for (const flag of ['shadow', 'simMode', 'replayLike']) {
    const skipped = await clv.seedCandidateClv({
      [flag]: true,
      dateISO: '2026-11-01',
      candidates: [cand],
      writeJson: async () => { writes += 1; },
    });
    assert.strictEqual(skipped.saved, false);
  }
  assert.strictEqual(writes, 0);

  const prev = { picks: [{ pick: 'Keep' }], avgCLV: 0.02, bySport: { NFL: { count: 1, clvSum: 0.02, beat: 1 } } };
  let written = null;
  const saved = await clv.seedCandidateClv({
    dateISO: '2026-11-01',
    candidates: [cand],
    readJson: async () => prev,
    writeJson: async (key, data) => { written = { key, data }; },
  });
  assert.strictEqual(saved.saved, true);
  assert.strictEqual(written.key, 'clv-2026-11-01');
  assert.deepStrictEqual(written.data.picks, prev.picks);
  assert.strictEqual(written.data.avgCLV, 0.02);
  assert.deepStrictEqual(written.data.bySport, prev.bySport);
  assert.strictEqual(written.data.candidates.length, 1);
  assert.ok(written.data.candidateClv);

  let afterThrow = null;
  const readFailed = await clv.seedCandidateClv({
    dateISO: '2026-11-02',
    candidates: [cand],
    readJson: async () => { throw new Error('blob down'); },
    writeJson: async (key, data) => { afterThrow = data; },
  });
  assert.strictEqual(readFailed.saved, true);
  assert.deepStrictEqual(afterThrow.picks, []);
  assert.strictEqual(afterThrow.candidates.length, 1);

  const writeFailed = await clv.seedCandidateClv({
    dateISO: '2026-11-03',
    candidates: [cand],
    readJson: async () => prev,
    writeJson: async () => { throw new Error('disk full'); },
  });
  assert.strictEqual(writeFailed.saved, false);
  assert.strictEqual(writeFailed.reason, 'write-failed');

  const capped = await clv.seedCandidateClv({
    dateISO: '2026-11-01',
    candidates: Array.from({ length: 300 }, (_, i) => ({
      sport: 'NHL', matchup: `A${i} @ B${i}`, side: `A${i}`, market: 'Moneyline', odds: -110, book: 'draftkings',
    })),
    readJson: async () => ({ picks: [{ pick: 'Keep' }], avgCLV: 1 }),
    writeJson: async (key, data) => { written = data; },
  });
  assert.strictEqual(capped.saved, true);
  assert.strictEqual(capped.capped, true);
  assert.strictEqual(written.candidates.length, 240);
  assert.strictEqual(written.picks[0].pick, 'Keep');
  assert.strictEqual(written.avgCLV, 1);
}

async function testAttachLeavesPickKpis() {
  const games = {};
  put(games, HOME, AWAY, COMMENCE, {
    pinnacle: bookRow({ mlAway: 140, mlHome: -160 }),
    draftkings: bookRow({ mlAway: 135, mlHome: -155 }),
  });
  const clvData = {
    picks: [{ pick: 'Keep', clv: 0.01 }],
    avgCLV: 0.01,
    totalTracked: 1,
    bySport: { NFL: { count: 1, clvSum: 0.01, beat: 1 } },
  };
  await clv.attachCandidateCloses(clvData, {
    dateISO: '2026-11-01',
    candidates: [
      {
        sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline',
        odds: 120, book: 'draftkings', pinnacleFairBet: fair(130, -150),
        homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
      },
      {
        sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: HOME, market: 'Moneyline',
        odds: -145, book: 'draftkings', homeTeam: HOME, awayTeam: AWAY, commenceTime: COMMENCE,
      },
    ],
    published: [{ sport: 'NFL', matchup: `${AWAY} @ ${HOME}`, side: AWAY, market: 'Moneyline' }],
    snapshots: [{ source: 'track-clv', capturedAt: COMMENCE, role: 'close', games }],
    picksData: { picks: [{ pick: 'Keep' }] },
  });
  assert.strictEqual(clvData.avgCLV, 0.01);
  assert.strictEqual(clvData.totalTracked, 1);
  assert.strictEqual(clvData.bySport.NFL.count, 1);
  assert.strictEqual(clvData.picks.length, 1);
  assert.strictEqual(clvData.candidates.length, 2);
  assert.ok(clvData.candidates.some((row) => row.published && clv.hasCloseClv(row)));
  assert.ok(clvData.candidates.some((row) => !row.published));

  const frozen = Object.freeze({ picks: [{ pick: 'A' }], avgCLV: 0.2 });
  const returned = await clv.attachCandidateCloses(frozen, {
    candidates: [{ sport: 'NFL', matchup: 'A @ B', side: 'A', market: 'Moneyline', odds: -110 }],
    snapshots: [],
    existingCandidates: [{ rowKey: 'keep', closeSource: 'track-clv', closePrice: -110, pinnacleFairClose: 0.4, clvProbDelta: 0.01 }],
  });
  assert.strictEqual(returned, frozen);
  assert.strictEqual(frozen.avgCLV, 0.2);
}

function testSourceHasNoRemoteOddsCall() {
  const file = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-v2/candidate_clv.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(file), 'candidate clv must not call fetch');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(file));
  const index = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  assert.ok(index.includes('seedCandidateClv'));
  assert.ok(index.includes('seed skipped'));
  const tracker = fs.readFileSync(path.join(__dirname, 'netlify/functions/track-clv-omega.js'), 'utf8');
  assert.ok(tracker.includes('attachCandidateCloses'));
  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  assert.ok(!toml.includes('candidate_clv'));
}

(async () => {
  testEveryCandidateAndClvMath();
  testMorningBoardIsNotAClose();
  testNearKickBoardAndWindowEdges();
  testHardRockAliasAndMissingPinnacle();
  testBetBookPrefersHardRockWhenBothPosted();
  testMovedSpreadDoesNotThrow();
  testOtherGameTimestampIsNotThisClose();
  testContextLabelsAndAccentKey();
  testOpenFromEarliestBoard();
  testExplicitFairKeptAndBadRowDoesNotThrow();
  testCapAndStableOrder();
  testMergeKeepsBetAndPriorClose();
  await testSeedNeverThrowsAndPreservesPicks();
  await testAttachLeavesPickKpis();
  testSourceHasNoRemoteOddsCall();
  console.log('PASS candidate-clv');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
