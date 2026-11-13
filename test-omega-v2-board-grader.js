'use strict';

/**
 * Independent graded-board job. Market skill off still grades. A complete
 * cache is not fetched again. A date that is not final is not stored.
 * OMEGA_V2_BOARD_GRADER=off does no work. No network.
 */

const assert = require('assert');
const { cacheIsComplete } = require('./netlify/functions/lib/omega-v2/market_skill');
const {
  boardGraderEnabled,
  runBoardGrader,
  GRADER_BUDGET_MS,
  priorBoardDates,
} = require('./netlify/functions/lib/omega-v2/board_grader');

const NOW = '2026-11-13T15:00:00Z';
const CARD = '2026-11-13';

function candidate(side, commence) {
  return {
    sport: 'NBA',
    market: 'Moneyline',
    side,
    matchup: `${side} @ Home Team`,
    homeTeam: 'Home Team',
    awayTeam: side,
    pMkt: 0.46,
    pCalRaw: 0.62,
    commenceTime: commence,
  };
}

function finals(side, grade) {
  return [{ side, grade }];
}

async function withLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map((part) => String(part)).join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

const savedSkill = process.env.OMEGA_V2_MARKET_SKILL;
const savedGrader = process.env.OMEGA_V2_BOARD_GRADER;
const savedPair = process.env.OMEGA_V2_PAIR_FIX;
const savedNoWrite = process.env.OMEGA_REPLAY_NO_WRITE;

function restoreEnv() {
  if (savedSkill == null) delete process.env.OMEGA_V2_MARKET_SKILL;
  else process.env.OMEGA_V2_MARKET_SKILL = savedSkill;
  if (savedGrader == null) delete process.env.OMEGA_V2_BOARD_GRADER;
  else process.env.OMEGA_V2_BOARD_GRADER = savedGrader;
  if (savedPair == null) delete process.env.OMEGA_V2_PAIR_FIX;
  else process.env.OMEGA_V2_PAIR_FIX = savedPair;
  if (savedNoWrite == null) delete process.env.OMEGA_REPLAY_NO_WRITE;
  else process.env.OMEGA_REPLAY_NO_WRITE = savedNoWrite;
}

async function main() {
  // The suite sets OMEGA_REPLAY_NO_WRITE=1 so a test cannot write a blob.
  // These fakes are an in-memory cache. Clearing the flag lets the write
  // path run so a final date is stored and a live date is not.
  delete process.env.OMEGA_REPLAY_NO_WRITE;
  process.env.OMEGA_V2_MARKET_SKILL = 'off';
  delete process.env.OMEGA_V2_BOARD_GRADER;
  assert.strictEqual(boardGraderEnabled(), true, 'grader defaults on');
  assert.strictEqual(boardGraderEnabled({ OMEGA_V2_BOARD_GRADER: 'off' }), false);
  assert.strictEqual(boardGraderEnabled({ OMEGA_V2_BOARD_GRADER: '0' }), false);
  assert.strictEqual(boardGraderEnabled({ OMEGA_V2_BOARD_GRADER: 'false' }), false);
  assert.strictEqual(boardGraderEnabled({ OMEGA_V2_BOARD_GRADER: 'on' }), true);
  assert.ok(GRADER_BUDGET_MS >= 3 * 60 * 1000, 'budget is several minutes');
  assert.deepStrictEqual(
    priorBoardDates(['2026-11-13', '2026-11-12', 'nope', '2026-11-11'], CARD),
    ['2026-11-11', '2026-11-12'],
    'today and bad dates are not graded'
  );

  const store = new Map();
  store.set('2026-11-10', {
    date: '2026-11-10',
    complete: true,
    rows: [{ sport: 'NBA', market: 'Moneyline', y: 1, pMkt: 0.5, pCal: 0.6 }],
  });
  const boards = {
    '2026-11-11': {
      date: '2026-11-11',
      candidates: [candidate('Alpha', '2026-11-11T00:00:00Z')],
    },
    '2026-11-12': {
      date: '2026-11-12',
      candidates: [candidate('Beta', '2026-11-13T02:00:00Z')],
    },
    '2026-11-13': {
      date: '2026-11-13',
      candidates: [candidate('Today', '2026-11-13T23:00:00Z')],
    },
  };
  const games = {
    '2026-11-11': finals('Alpha', 'win'),
    '2026-11-12': finals('Beta', 'pending'),
    '2026-11-13': finals('Today', 'win'),
  };
  const fetched = [];
  const written = [];
  let boardReads = [];
  const fakes = {
    now: NOW,
    budgetMs: 5000,
    readDates: async () => ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
    readCache: async (date) => store.get(date) || null,
    writeCache: async (date, body) => { written.push(date); store.set(date, body); },
    readBoard: async (date) => { boardReads.push(date); return boards[date]; },
    fetchScores: async (date) => { fetched.push(date); return games[date] || []; },
    gradePick: (_pick, game) => (game && game.grade) || 'pending',
    findGame: (pick, list) => (list || []).find((game) => game.side === pick.pick) || null,
  };

  const first = await withLog(() => runBoardGrader(fakes));
  assert.strictEqual(process.env.OMEGA_V2_MARKET_SKILL, 'off');
  assert.strictEqual(first.result.cardDate, CARD);
  assert.strictEqual(first.result.datesGraded, 1, 'only the final missing date is graded');
  assert.strictEqual(first.result.rows, 1);
  assert.strictEqual(first.result.skipped, 1, 'the complete cache is skipped');
  assert.strictEqual(first.result.byDate['2026-11-11'], 1);
  assert.strictEqual(first.result.byDate['2026-11-12'], 0, 'a live slate adds no rows');
  assert.strictEqual(first.result.byDate['2026-11-13'], undefined, 'today is not graded');
  assert.deepStrictEqual(fetched.slice().sort(), ['2026-11-11', '2026-11-12']);
  assert.ok(!fetched.includes('2026-11-10'), 'complete cache is not re-fetched');
  assert.ok(!boardReads.includes('2026-11-10'));
  assert.deepStrictEqual(written, ['2026-11-11']);
  assert.strictEqual(cacheIsComplete(store.get('2026-11-11')), true);
  assert.ok(!store.has('2026-11-12'), 'incomplete date is not cached');
  assert.ok(!store.has('2026-11-13'));
  assert.ok(first.lines.some((line) => line === '[grade-boards-omega] datesGraded=1 rows=1 skipped=1'));

  fetched.length = 0;
  written.length = 0;
  boardReads = [];
  const second = await runBoardGrader(fakes);
  assert.strictEqual(second.datesGraded, 0, 'second run does not regrade the cached date');
  assert.strictEqual(second.rows, 0);
  assert.strictEqual(second.skipped, 2, 'complete dates are skipped');
  assert.deepStrictEqual(fetched, ['2026-11-12'], 'only the still-open date is fetched');
  assert.deepStrictEqual(written, []);
  assert.ok(!store.has('2026-11-12'));

  let touched = 0;
  const killed = await withLog(() => runBoardGrader({
    env: { OMEGA_V2_BOARD_GRADER: 'off', OMEGA_V2_MARKET_SKILL: 'off' },
    now: NOW,
    readDates: async () => { touched += 1; return ['2026-11-11']; },
    readBoard: async () => { touched += 1; return boards['2026-11-11']; },
    fetchScores: async () => { touched += 1; return games['2026-11-11']; },
    readCache: async () => { touched += 1; return null; },
    writeCache: async () => { touched += 1; },
  }));
  assert.strictEqual(touched, 0, 'kill switch does no IO');
  assert.strictEqual(killed.result.killSwitch, true);
  assert.strictEqual(killed.result.datesGraded, 0);
  assert.strictEqual(killed.result.rows, 0);
  assert.strictEqual(killed.result.skipped, 0);
  assert.ok(killed.lines.some((line) => line === '[grade-boards-omega] datesGraded=0 rows=0 skipped=0 kill-switch=off'));

  process.env.OMEGA_V2_BOARD_GRADER = 'off';
  const killedEnv = await runBoardGrader({
    now: NOW,
    readDates: async () => { touched += 1; return ['2026-11-11']; },
    fetchScores: async () => { touched += 1; return []; },
  });
  assert.strictEqual(killedEnv.killSwitch, true);
  assert.strictEqual(touched, 0, 'process env kill switch does no IO');
  delete process.env.OMEGA_V2_BOARD_GRADER;

  const seen = [];
  const storedKeys = [];
  const hooked = await runBoardGrader({
    env: { OMEGA_V2_PAIR_FIX: 'on', OMEGA_V2_BOARD_GRADER: 'on' },
    now: NOW,
    readDates: async () => ['2026-11-11', '2026-11-13'],
    readStored: async (key) => { storedKeys.push(key); return null; },
    loadRows: async (card, loadOpts) => {
      seen.push({ card, loadOpts });
      return [{ date: '2026-11-11', sport: 'NBA', y: 1, pMkt: 0.46, pCal: 0.62 }];
    },
  });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].card, CARD);
  assert.strictEqual(seen[0].loadOpts.budgetMs, GRADER_BUDGET_MS);
  assert.strictEqual(seen[0].loadOpts.readCache, undefined, 'production path leaves the pair-fix cache keys alone');
  assert.strictEqual(seen[0].loadOpts.writeCache, undefined);
  assert.ok(storedKeys.includes('omega-v2/board-graded-v2/2026-11-11'));
  assert.strictEqual(hooked.datesGraded, 1);
  assert.strictEqual(hooked.rows, 1);
  assert.strictEqual(hooked.byDate['2026-11-11'], 1);

  storedKeys.length = 0;
  await runBoardGrader({
    env: { OMEGA_V2_PAIR_FIX: 'off' },
    now: NOW,
    readDates: async () => ['2026-11-11'],
    readStored: async (key) => { storedKeys.push(key); return null; },
    loadRows: async () => [],
  });
  assert.ok(storedKeys.includes('omega-v2/board-graded/2026-11-11'));
  assert.ok(!storedKeys.some((key) => key.includes('board-graded-v2')), 'pair fix off reads the legacy key');

  const legacy = new Map();
  await runBoardGrader({
    env: { OMEGA_V2_PAIR_FIX: 'on' },
    now: NOW,
    readDates: async () => ['2026-11-09', '2026-11-10'],
    readStored: async (key) => {
      if (key === 'omega-v2/board-graded/2026-11-09') {
        return { date: '2026-11-09', complete: true, rows: [{ sport: 'NBA', y: 1, pMkt: 0.5, pCal: 0.6 }] };
      }
      if (key === 'omega-v2/board-graded-v2/2026-11-10') {
        return { date: '2026-11-10', complete: true, rows: [{ sport: 'NBA', y: 1, pMkt: 0.5, pCal: 0.6 }] };
      }
      return null;
    },
    loadRows: async () => {
      legacy.set('called', true);
      return [{ date: '2026-11-09', sport: 'NBA', y: 1, pMkt: 0.5, pCal: 0.6 }];
    },
  });
  assert.strictEqual(legacy.get('called'), true);
  const kept = await runBoardGrader({
    env: { OMEGA_V2_PAIR_FIX: 'on' },
    now: NOW,
    readDates: async () => ['2026-11-10'],
    readStored: async (key) => {
      if (key === 'omega-v2/board-graded-v2/2026-11-10') {
        return { complete: true, rows: [{ sport: 'NBA', y: 1, pMkt: 0.5, pCal: 0.6 }] };
      }
      throw new Error(`unexpected read ${key}`);
    },
    loadRows: async () => [{ date: '2026-11-10', sport: 'NBA', y: 1, pMkt: 0.5, pCal: 0.6 }],
  });
  assert.strictEqual(kept.skipped, 1, 'a complete v2 cache is skipped');
  assert.strictEqual(kept.datesGraded, 0);
  assert.strictEqual(kept.rows, 0);

  console.log('test-omega-v2-board-grader: ALL PASS');
}

main().then(() => {
  restoreEnv();
}).catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
