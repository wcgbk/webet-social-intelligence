'use strict';

/**
 * Mispaired alt-spread rows stay out of the market-skill grade and the
 * board-bias fit. OMEGA_V2_PAIR_FIX=off keeps them, and keeps the old
 * graded-cache key.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const { americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');

const ENV = 'OMEGA_V2_PAIR_FIX';
const saved = process.env[ENV];
const savedWrite = process.env.OMEGA_REPLAY_NO_WRITE;

function nhl(extra) {
  return {
    sport: 'NHL',
    market: 'Spread',
    side: extra.side || 'Detroit Red Wings -1.5',
    matchup: 'Detroit Red Wings @ St. Louis Blues',
    pCalRaw: 0.42,
    ...extra,
  };
}

function gradeAll(cands) {
  return v2.gradeBoardCandidates(
    cands,
    { NHL: [{ id: 'g' }], NBA: [{ id: 'g' }] },
    () => 'win',
    () => ({ id: 'g' }),
  );
}

function biasRow(extra) {
  return {
    date: '2026-10-20',
    sport: 'NBA',
    market: 'Spread',
    pick: 'Away +3.5',
    pModel: 0.62,
    pMkt: 0.55,
    ...extra,
  };
}

async function main() {
  delete process.env[ENV];
  assert.strictEqual(v2.PAIR_SANITY_PP, 0.08);
  assert.strictEqual(v2.gradedBoardKey('2026-11-10'), 'omega-v2/board-graded/2026-11-10');
  assert.strictEqual(v2.gradedBoardKeyV2('2026-11-10'), 'omega-v2/board-graded-v2/2026-11-10');

  const implied110 = americanToImplied('-110');
  const cands = [
    nhl({ side: 'mis', odds: '+215', pMkt: 0.506, pCalRaw: 0.41 }),
    nhl({ side: 'ok', odds: '-110', pMkt: 0.52, pCalRaw: 0.48 }),
    nhl({ side: 'long', odds: '+1000', pMkt: 0.5, pCalRaw: 0.2 }),
    nhl({ side: 'fav', odds: '-1000', pMkt: 0.5, pCalRaw: 0.31 }),
    nhl({ side: 'free', pMkt: 0.5, pCalRaw: 0.6 }),
    nhl({ side: 'edge', odds: '+900', pMkt: 0.5, pCalRaw: 0.25 }),
    nhl({ side: 'tie', odds: '-110', pMkt: implied110 + 0.08, pCalRaw: 0.33 }),
    nhl({ side: 'over', odds: '-110', pMkt: implied110 + 0.08 + 1e-4, pCalRaw: 0.34 }),
  ];
  const graded = gradeAll(cands);
  assert.strictEqual(graded.droppedMispaired, 2);
  const pcals = graded.rows.map((row) => row.pCal).sort();
  assert.deepStrictEqual(pcals, [0.2, 0.25, 0.31, 0.33, 0.48, 0.6]);
  assert.ok(!graded.rows.some((row) => row.pCal === 0.41), 'mispaired row is skipped');
  assert.ok(!graded.rows.some((row) => row.pCal === 0.34), 'gap just over 8pp is skipped');

  process.env[ENV] = 'off';
  const off = gradeAll(cands);
  assert.strictEqual(off.droppedMispaired, 0);
  assert.strictEqual(off.rows.length, cands.length, 'flag off keeps every graded row');
  delete process.env[ENV];

  const bad = {
    sport: 'NHL', market: 'Spread', side: 'Detroit Red Wings -1.5',
    pModel: 0.55, pMkt: 0.506, odds: '+215',
  };
  const good = {
    sport: 'NHL', market: 'Spread', side: 'Road +1.5',
    pModel: 0.55, pMkt: 0.52, odds: '-110',
  };
  const long = {
    sport: 'NHL', market: 'Spread', side: 'Dog +1.5',
    pModel: 0.2, pMkt: 0.5, odds: '+1000',
  };
  const free = {
    sport: 'NHL', market: 'Spread', side: 'No odds',
    pModel: 0.55, pMkt: 0.5,
  };
  assert.strictEqual(v2.boardHistoryRow('2026-11-01', bad), null);
  assert.ok(v2.boardHistoryRow('2026-11-01', good));
  assert.ok(v2.boardHistoryRow('2026-11-01', long));
  assert.ok(v2.boardHistoryRow('2026-11-01', free));
  process.env[ENV] = 'off';
  assert.ok(v2.boardHistoryRow('2026-11-01', bad), 'flag off keeps the mispaired board row');
  delete process.env[ENV];

  const goodBoard = [];
  for (let i = 0; i < 40; i += 1) goodBoard.push(biasRow({ pick: `Away +${i}` }));
  const withBad = goodBoard.concat([biasRow({
    pick: 'Det -1.5', pMkt: 0.506, odds: '+215',
  })]);
  const onFit = v2.fitWalkForward([], '2026-11-11', { boardRows: withBad });
  assert.strictEqual(onFit.biasN['NBA|Spread'], 40, 'odds-bearing mispaired row is not in the board fit');
  process.env[ENV] = 'off';
  const offFit = v2.fitWalkForward([], '2026-11-11', { boardRows: withBad });
  assert.strictEqual(offFit.biasN['NBA|Spread'], 41, 'flag off keeps the row in the board fit');
  delete process.env[ENV];

  const store = new Map();
  store.set(v2.gradedBoardKey('2026-11-09'), {
    date: '2026-11-09',
    complete: true,
    rows: [{ sport: 'NHL', market: 'Spread', y: 1, pMkt: 0.506, pCal: 0.41 }],
  });
  store.set(v2.gradedBoardKey('2026-11-10'), {
    date: '2026-11-10',
    complete: true,
    rows: [{ sport: 'NHL', market: 'Spread', y: 0, pMkt: 0.51, pCal: 0.45 }],
  });
  const reads = [];
  delete process.env.OMEGA_REPLAY_NO_WRITE;
  const migrated = await v2.loadMarketSkillRows('2026-11-11', {
    budgetMs: 5000,
    now: '2026-11-11T16:00:00Z',
    readDates: async () => ['2026-11-09', '2026-11-10', '2026-11-11'],
    readStored: async (key) => store.get(key) || null,
    writeStored: async (key, body) => { store.set(key, body); },
    readBoard: async (date) => {
      reads.push(date);
      return {
        date,
        candidates: [
          nhl({ side: 'mis', odds: '+215', pMkt: 0.506, pCalRaw: 0.41 }),
          nhl({ side: 'ok', odds: '-110', pMkt: 0.52, pCalRaw: 0.48 }),
        ],
      };
    },
    fetchScores: async () => [{ id: 'g' }],
    gradePick: () => 'win',
    findGame: () => ({ id: 'g' }),
  });
  assert.deepStrictEqual(reads, ['2026-11-09'], 'only the oldest legacy date is regraded');
  assert.ok(!migrated.some((row) => row.date === '2026-11-09' && row.pCal === 0.41));
  assert.ok(migrated.some((row) => row.date === '2026-11-09' && row.pCal === 0.48));
  assert.ok(migrated.some((row) => row.date === '2026-11-10' && row.pCal === 0.45), 'old cache rows stay until that date is regraded');
  const written = store.get(v2.gradedBoardKeyV2('2026-11-09'));
  assert.ok(written && written.droppedMispaired === 1);
  assert.ok(!store.has(v2.gradedBoardKeyV2('2026-11-10')));
  assert.strictEqual(v2.gradedBoardKey('2026-11-09'), 'omega-v2/board-graded/2026-11-09');

  reads.length = 0;
  const stalled = await v2.loadMarketSkillRows('2026-11-12', {
    budgetMs: 0,
    now: '2026-11-12T16:00:00Z',
    readDates: async () => ['2026-11-10'],
    readStored: async (key) => store.get(key) || null,
    writeStored: async () => { throw new Error('should not write'); },
    readBoard: async () => { throw new Error('should not read a board'); },
    fetchScores: async () => { throw new Error('should not fetch scores'); },
  });
  assert.deepStrictEqual(reads, []);
  assert.strictEqual(stalled.length, 1);
  assert.strictEqual(stalled[0].pCal, 0.45, 'a spent budget keeps the old rows');

  const poison = new Map();
  poison.set(v2.gradedBoardKey('2026-11-08'), {
    date: '2026-11-08',
    complete: true,
    rows: [{ sport: 'NCAAM', market: 'Spread', y: 1, pMkt: 0.52, pCal: 0.48 }],
  });
  const poisonWrites = [];
  const kept = await v2.loadMarketSkillRows('2026-11-11', {
    budgetMs: 5000,
    now: '2026-11-11T16:00:00Z',
    readDates: async () => ['2026-11-08'],
    readStored: async (key) => poison.get(key) || null,
    writeStored: async (key, body) => { poisonWrites.push(key); poison.set(key, body); },
    readBoard: async () => ({
      date: '2026-11-08',
      candidates: [nhl({ side: 'ok', odds: '-110', pMkt: 0.52, pCalRaw: 0.48 })],
    }),
    fetchScores: async () => [],
    gradePick: () => 'win',
    findGame: () => ({ id: 'g' }),
  });
  assert.deepStrictEqual(poisonWrites, [], 'an empty scoreboard does not write a v2 cache');
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].pCal, 0.48, 'an empty scoreboard keeps the legacy rows');

  console.log('PASS pair sanity guard');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  if (saved == null) delete process.env[ENV];
  else process.env[ENV] = saved;
  if (savedWrite == null) delete process.env.OMEGA_REPLAY_NO_WRITE;
  else process.env.OMEGA_REPLAY_NO_WRITE = savedWrite;
});
