'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const lock = require('./netlify/functions/lib/omega-vnext/card_lock');
const { storePicks } = require('./netlify/functions/lib/omega-vnext/store');

const FIXTURE = path.join(__dirname, 'tests/fixtures/card-lock/live-card-2026-11-16-1152.json');
const AFTER = '2026-11-16T16:30:00.000Z';
const BEFORE = '2026-11-16T15:30:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCard(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'tests/fixtures/card-lock', name), 'utf8'));
}

function boom(label) {
  return async () => {
    throw new Error(`should not ${label}`);
  };
}

function memoryStore(seed) {
  const data = new Map();
  for (const [key, value] of Object.entries(seed || {})) {
    data.set(key, clone(value));
  }
  return {
    data,
    async getJSON(key) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return value == null ? value : clone(value);
    },
    async setJSON(key, value) {
      data.set(key, value == null ? value : clone(value));
    },
    async get(key) {
      return this.getJSON(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

test('flag defaults on and off/0/false/no disable', () => {
  assert.strictEqual(lock.cardLockEnabled(undefined), true);
  assert.strictEqual(lock.cardLockEnabled({}), true);
  assert.strictEqual(lock.cardLockEnabled({ OMEGA_CARD_LOCK_11AM: 'on' }), true);
  assert.strictEqual(lock.cardLockEnabled({ OMEGA_CARD_LOCK_11AM: 'yes' }), true);
  for (const off of ['off', '0', 'false', 'no', ' NO ', 'Off']) {
    assert.strictEqual(lock.cardLockEnabled({ OMEGA_CARD_LOCK_11AM: off }), false, off);
  }
});

test('11:00 ET is DST-correct and the instant is inclusive', () => {
  assert.strictEqual(lock.lockTimeUtc('2026-07-15'), '2026-07-15T15:00:00Z');
  assert.strictEqual(lock.lockTimeUtc('2026-03-07'), '2026-03-07T16:00:00Z');
  assert.strictEqual(lock.lockTimeUtc('2026-03-08'), '2026-03-08T15:00:00Z');
  assert.strictEqual(lock.lockTimeUtc('2026-11-01'), '2026-11-01T16:00:00Z');
  assert.strictEqual(lock.lockTimeUtc('2026-11-16'), '2026-11-16T16:00:00Z');
  const instant = lock.lockTimeUtc('2026-11-16');
  assert.strictEqual(lock.isCardLocked('2026-11-16', instant), true);
  assert.strictEqual(lock.isCardLocked('2026-11-16', new Date(Date.parse(instant) - 1)), false);
  assert.strictEqual(lock.isCardLocked('not-a-date', AFTER), false);
  assert.strictEqual(lock.isCardLocked('2026-11-14', '2026-11-16T15:00:00Z'), true);
});

test('before 11:00 ET the write is the same object and does no I/O', async () => {
  const next = { date: '2026-11-16', picks: [{ pick: 'A', odds: '-110' }], parlayLegs: [] };
  const out = await lock.guardCardWrite('2026-11-16', next, {
    now: BEFORE,
    env: {},
    readSnapshot: boom('read snapshot'),
    readCurrent: boom('read current'),
    writeSnapshot: boom('write snapshot'),
  });
  assert.strictEqual(out, next);
});

test('rollback flag, replay, shadow, sim, and dry-run skip the lock', async () => {
  const next = { date: '2026-11-16', picks: [{ pick: 'A', odds: '+200', stakeUsd: 9 }] };
  const deps = {
    now: AFTER,
    readSnapshot: boom('read snapshot'),
    readCurrent: boom('read current'),
    writeSnapshot: boom('write snapshot'),
  };
  for (const env of [
    { OMEGA_CARD_LOCK_11AM: 'off' },
    { OMEGA_CARD_LOCK_11AM: '0' },
    { OMEGA_CARD_LOCK_11AM: 'false' },
    { OMEGA_CARD_LOCK_11AM: 'no' },
    { OMEGA_REPLAY_NO_WRITE: 'on' },
  ]) {
    const out = await lock.guardCardWrite('2026-11-16', next, Object.assign({ env }, deps));
    assert.strictEqual(out, next, JSON.stringify(env));
  }
  for (const extra of [{ dryRun: true }, { shadow: true }, { simMode: true }, { replay: true }]) {
    const out = await lock.guardCardWrite('2026-11-16', next, Object.assign({ env: {}, now: AFTER }, extra, deps));
    assert.strictEqual(out, next, JSON.stringify(extra));
  }
});

test('after 11:00 a swap, drop, add, price change, and stake change revert to the snapshot', async () => {
  const card = loadCard('live-card-2026-11-16-1152.json');
  const snapshot = lock.snapshotFromCard(card);
  const incoming = clone(card);
  incoming.picks = incoming.picks.slice().reverse();
  incoming.picks[0].odds = '+999';
  incoming.picks[0].stakeUsd = 500;
  incoming.picks[0].units = '2u';
  incoming.picks.pop();
  incoming.picks.push({
    pick: 'Added side',
    pickDisplay: 'Added side',
    matchup: 'Nowhere @ Nowhere',
    sport: 'NBA',
    betType: 'Moneyline',
    odds: '-110',
    units: '1u',
    stakeUsd: 150,
    book: 'draftkings',
  });
  incoming.picks[0].result = 'win';
  incoming.picks[0].status = 'graded';
  incoming.picks[0].finalScore = '120-110';
  incoming.picks[0].clv = 0.04;
  incoming.picks[0].closingLine = '-120';
  incoming.picks[0].liveScore = '80-70';
  incoming.picks[0].gradedAt = '2026-11-17T05:00:00Z';
  incoming.picks[0].coreReasoning = 'narration rewritten after the lock';
  const lockedPick = card.picks.find((row) => row.pick === incoming.picks[0].pick);
  const applied = lock.applyCardLock(incoming, snapshot);
  assert.strictEqual(applied.changed, true);
  assert.ok(applied.corrections.some((line) => /odds/.test(line)));
  assert.ok(applied.corrections.some((line) => /stakeUsd/.test(line)));
  assert.ok(applied.corrections.some((line) => /dropped extra/.test(line)));
  assert.ok(applied.corrections.some((line) => /restored missing/.test(line)));
  assert.deepStrictEqual(applied.card.picks.map((row) => row.pick), card.picks.map((row) => row.pick));
  applied.card.picks.forEach((row, index) => {
    assert.strictEqual(row.odds, card.picks[index].odds);
    assert.strictEqual(row.stakeUsd, card.picks[index].stakeUsd);
    assert.strictEqual(row.units, card.picks[index].units);
    assert.strictEqual(row.book, card.picks[index].book);
    assert.strictEqual(row.grade, card.picks[index].grade);
    assert.strictEqual(row.edgePct, card.picks[index].edgePct);
    assert.strictEqual(row.ev, card.picks[index].ev);
    assert.strictEqual(row.confidence, card.picks[index].confidence);
  });
  const graded = applied.card.picks.find((row) => row.pick === lockedPick.pick);
  assert.strictEqual(graded.result, 'win');
  assert.strictEqual(graded.status, 'graded');
  assert.strictEqual(graded.finalScore, '120-110');
  assert.strictEqual(graded.clv, 0.04);
  assert.strictEqual(graded.closingLine, '-120');
  assert.strictEqual(graded.liveScore, '80-70');
  assert.strictEqual(graded.gradedAt, '2026-11-17T05:00:00Z');
  assert.strictEqual(graded.coreReasoning, 'narration rewritten after the lock');
  assert.strictEqual(graded.odds, lockedPick.odds);
  assert.strictEqual(applied.card.cardLock.flag, 'OMEGA_CARD_LOCK_11AM');
  assert.ok(applied.card.cardLock.corrections.length <= 20);
  assert.strictEqual(applied.card.edgeSummary, incoming.edgeSummary);
});

test('parlay legs, price, and stake stay on the snapshot while leg results pass through', () => {
  const card = loadCard('live-card-2026-11-16-1152.json');
  const snapshot = lock.snapshotFromCard(card);
  const incoming = clone(card);
  const ticket = incoming.parlayLegs[0];
  ticket.combinedOdds = '+100';
  ticket.combinedDecimal = 2;
  ticket.stakeUsd = 10;
  ticket.units = '1u';
  ticket.result = 'loss';
  ticket.profit = -38;
  ticket.legs[0].odds = '+150';
  ticket.legs[0].result = 'win';
  ticket.legs[0].clv = 0.02;
  ticket.legs.push({ pick: 'Extra leg', matchup: 'A @ B', sport: 'NBA', betType: 'Total', odds: '-110' });
  const applied = lock.applyCardLock(incoming, snapshot);
  const out = applied.card.parlayLegs[0];
  assert.strictEqual(out.type, '3-leg');
  assert.strictEqual(out.combinedOdds, '+609');
  assert.strictEqual(out.combinedDecimal, 7.0902);
  assert.strictEqual(out.stakeUsd, 38);
  assert.strictEqual(out.units, '0.25u');
  assert.strictEqual(out.result, 'loss');
  assert.strictEqual(out.profit, -38);
  assert.deepStrictEqual(out.legs.map((leg) => leg.pick), card.parlayLegs[0].legs.map((leg) => leg.pick));
  assert.strictEqual(out.legs[0].odds, card.parlayLegs[0].legs[0].odds);
  assert.strictEqual(out.legs[0].result, 'win');
  assert.strictEqual(out.legs[0].clv, 0.02);
  assert.ok(applied.corrections.some((line) => /parlay 1 combinedOdds/.test(line)));
});

test('real cards are idempotent and the 11/16 10:46 strip is restored', async () => {
  for (const name of ['live-card-2026-11-14.json', 'live-card-2026-11-15.json', 'live-card-2026-11-16-1152.json']) {
    const card = loadCard(name);
    const applied = lock.applyCardLock(card, lock.snapshotFromCard(card));
    assert.strictEqual(applied.changed, false, name);
    assert.deepStrictEqual(applied.corrections, [], name);
    assert.deepStrictEqual(applied.card.picks, card.picks, name);
    assert.deepStrictEqual(applied.card.parlayLegs, card.parlayLegs, name);
    assert.strictEqual(applied.card.cardLock.flag, 'OMEGA_CARD_LOCK_11AM');
  }
  const full = loadCard('live-card-2026-11-16-1152.json');
  assert.deepStrictEqual(full.picks.map((row) => ({
    pick: row.pick, odds: row.odds, units: row.units, stakeUsd: row.stakeUsd, book: row.book,
  })), [
    { pick: 'Over 228.5', odds: '-114', units: '0.25u', stakeUsd: 38, book: 'draftkings' },
    { pick: 'UC San Diego Tritons -19.5', odds: '-105', units: '0.25u', stakeUsd: 38, book: 'hardrockbet' },
    { pick: 'Under 232.5', odds: '-107', units: '0.25u', stakeUsd: 38, book: 'draftkings' },
  ]);
  assert.strictEqual(full.parlayLegs[0].type, '3-leg');
  assert.strictEqual(full.parlayLegs[0].combinedOdds, '+609');
  assert.strictEqual(full.parlayLegs[0].stakeUsd, 38);
  const strip = clone(full);
  strip.picks = full.picks.filter((row) => /UC San Diego/.test(row.pick));
  strip.parlayLegs = [];
  let saved = null;
  const restored = await lock.guardCardWrite('2026-11-16', strip, {
    now: AFTER,
    env: {},
    readSnapshot: async () => null,
    readCurrent: async () => full,
    writeSnapshot: async (key, value) => {
      assert.strictEqual(key, 'omega-card-lock/picks-2026-11-16');
      saved = value;
    },
  });
  assert.deepStrictEqual(restored.picks, full.picks);
  assert.deepStrictEqual(restored.parlayLegs, full.parlayLegs);
  assert.strictEqual(saved.picks.length, 3);
  assert.strictEqual(saved.parlayLegs.length, 1);
  assert.notStrictEqual(restored, strip);
});

test('empty current card does not block, and the first non-empty write becomes the snapshot', async () => {
  const next = {
    date: '2026-11-16',
    picks: [{ pick: 'Over 228.5', sport: 'NBA', matchup: 'A @ B', betType: 'Total', odds: '-114', units: '0.25u', stakeUsd: 38 }],
    parlayLegs: [],
  };
  let saved = null;
  const out = await lock.guardCardWrite('2026-11-16', next, {
    now: AFTER,
    env: {},
    readSnapshot: async () => null,
    readCurrent: async () => ({ date: '2026-11-16', picks: [], parlayLegs: [] }),
    writeSnapshot: async (key, value) => { saved = value; },
  });
  assert.strictEqual(out, next);
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'cardLock'));
  assert.strictEqual(saved.picks[0].odds, '-114');

  const swapped = clone(next);
  swapped.picks[0].odds = '+250';
  swapped.picks[0].stakeUsd = 99;
  swapped.picks[0].result = 'loss';
  const locked = await lock.guardCardWrite('2026-11-16', swapped, {
    now: AFTER,
    env: {},
    readSnapshot: async () => saved,
    readCurrent: boom('read current'),
    writeSnapshot: boom('write snapshot'),
  });
  assert.strictEqual(locked.picks[0].odds, '-114');
  assert.strictEqual(locked.picks[0].stakeUsd, 38);
  assert.strictEqual(locked.picks[0].result, 'loss');
});

test('snapshot I/O failure does not block the write', async () => {
  const next = { date: '2026-11-16', picks: [{ pick: 'A', sport: 'NBA', matchup: 'a @ b', betType: 'ML', odds: '-110' }] };
  const allowed = await lock.guardCardWrite('2026-11-16', next, {
    now: AFTER,
    env: {},
    readSnapshot: async () => { throw new Error('snap down'); },
    readCurrent: async () => { throw new Error('current down'); },
    writeSnapshot: async () => { throw new Error('write down'); },
  });
  assert.strictEqual(allowed, next);

  const current = {
    date: '2026-11-16',
    picks: [{ pick: 'A', sport: 'NBA', matchup: 'a @ b', betType: 'ML', odds: '-110', units: '0.25u', stakeUsd: 38 }],
    parlayLegs: [],
  };
  const incoming = clone(current);
  incoming.picks[0].odds = '+300';
  const locked = await lock.guardCardWrite('2026-11-16', incoming, {
    now: AFTER,
    env: {},
    readSnapshot: async () => { throw new Error('snap down'); },
    readCurrent: async () => current,
    writeSnapshot: async () => { throw new Error('write down'); },
  });
  assert.strictEqual(locked.picks[0].odds, '-110');
  assert.notStrictEqual(locked, incoming);
});

test('attached corrections are capped at 20', () => {
  const snapPick = { pick: 'Keep', sport: 'NBA', matchup: 'a @ b', betType: 'ML', odds: '-110' };
  const incoming = {
    date: '2026-11-16',
    picks: [snapPick],
    parlayLegs: [],
  };
  for (let i = 0; i < 25; i += 1) {
    incoming.picks.push({ pick: `Extra ${i}`, sport: 'NBA', matchup: `x @ y ${i}`, betType: 'ML', odds: '-110' });
  }
  const applied = lock.applyCardLock(incoming, { date: '2026-11-16', takenAt: 't', picks: [snapPick], parlayLegs: [] });
  assert.ok(applied.corrections.length > 20);
  assert.strictEqual(applied.card.cardLock.corrections.length, 20);
  assert.strictEqual(applied.changed, true);
});

test('seed refuses to overwrite an existing snapshot unless force', async () => {
  const card = { date: '2026-11-16', picks: [{ pick: 'A', odds: '-110' }], parlayLegs: [] };
  const existing = lock.snapshotFromCard(card);
  let writes = 0;
  await assert.rejects(
    () => lock.seedCardLock('2026-11-16', card, {
      readSnapshot: async () => existing,
      writeSnapshot: async () => { writes += 1; },
    }),
    (err) => err && err.code === 'SNAPSHOT_EXISTS'
  );
  assert.strictEqual(writes, 0);
  const seeded = await lock.seedCardLock('2026-11-16', card, {
    force: true,
    readSnapshot: async () => existing,
    writeSnapshot: async (key, value) => {
      writes += 1;
      assert.strictEqual(key, 'omega-card-lock/picks-2026-11-16');
      assert.strictEqual(value.picks[0].pick, 'A');
    },
  });
  assert.strictEqual(writes, 1);
  assert.strictEqual(seeded.date, '2026-11-16');
});

test('storePicks locks only the live main card', async () => {
  const date = '2026-11-16';
  const key = `picks-${date}`;
  const lockKey = lock.snapshotKey(date);
  const original = {
    date,
    picks: [{ pick: 'Over 228.5', sport: 'NBA', matchup: 'A @ B', betType: 'Total', odds: '-114', units: '0.25u', stakeUsd: 38, grade: 'b' }],
    parlayLegs: [{ type: '3-leg', combinedOdds: '+609', units: '0.25u', stakeUsd: 38, legs: [] }],
    summary: { totalPicks: 1 },
  };
  const earlyMain = memoryStore();
  const earlyV1 = memoryStore();
  const early = clone(original);
  early.picks[0].odds = '+400';
  assert.strictEqual(await storePicks(date, early, {
    force: true,
    now: BEFORE,
    env: {},
    stores: { main: earlyMain, v1: earlyV1 },
  }), true);
  assert.strictEqual(earlyMain.data.get(key).picks[0].odds, '+400');
  assert.ok(!earlyMain.data.has(lockKey));

  const main = memoryStore({ [key]: original });
  const v1 = memoryStore();
  const swapped = clone(original);
  swapped.picks[0].odds = '+400';
  swapped.picks[0].stakeUsd = 200;
  swapped.picks[0].result = 'win';
  swapped.picks[0].clv = 0.03;
  assert.strictEqual(await storePicks(date, swapped, {
    force: true,
    now: AFTER,
    env: {},
    stores: { main, v1 },
  }), true);
  const stored = main.data.get(key);
  assert.strictEqual(stored.picks[0].odds, '-114');
  assert.strictEqual(stored.picks[0].stakeUsd, 38);
  assert.strictEqual(stored.picks[0].result, 'win');
  assert.strictEqual(stored.picks[0].clv, 0.03);
  assert.strictEqual(stored.parlayLegs[0].combinedOdds, '+609');
  assert.ok(main.data.has(lockKey));
  assert.strictEqual(v1.data.get(key).picks[0].odds, '-114');

  const offMain = memoryStore({ [key]: original });
  const offV1 = memoryStore();
  const offCard = clone(original);
  offCard.picks[0].odds = '+400';
  await storePicks(date, offCard, {
    force: true,
    now: AFTER,
    env: { OMEGA_CARD_LOCK_11AM: 'off' },
    stores: { main: offMain, v1: offV1 },
  });
  assert.strictEqual(offMain.data.get(key).picks[0].odds, '+400');
  assert.ok(!offMain.data.has(lockKey));

  const replayMain = memoryStore({ [key]: original });
  const replayV1 = memoryStore();
  const replayCard = clone(original);
  replayCard.picks[0].odds = '+400';
  await storePicks(date, replayCard, {
    force: true,
    now: AFTER,
    env: { OMEGA_REPLAY_NO_WRITE: 'on' },
    stores: { main: replayMain, v1: replayV1 },
  });
  assert.strictEqual(replayMain.data.get(key).picks[0].odds, '+400');
  assert.ok(!replayMain.data.has(lockKey));
  assert.ok(!replayV1.data.has(key));

  const shadowMain = memoryStore();
  const shadowV1 = memoryStore();
  await storePicks(date, clone(original), {
    force: true,
    shadow: true,
    now: AFTER,
    env: {},
    stores: { main: shadowMain, v1: shadowV1 },
  });
  assert.ok(shadowMain.data.has(`omega-shadow/picks-${date}`));
  assert.ok(!shadowMain.data.has(lockKey));
  assert.ok(!shadowMain.data.has(key));
});

test('seed CLI dry-run prints the 11/16 card and does not write', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'tools/omega-v2/seed-card-lock.js'),
    '2026-11-16',
    '--from-file',
    FIXTURE,
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Over 228\.5/);
  assert.match(result.stdout, /UC San Diego Tritons -19\.5/);
  assert.match(result.stdout, /-114/);
  assert.match(result.stdout, /\+609/);
  assert.match(result.stdout, /\$38/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /NETLIFY_AUTH_TOKEN|Bearer /);
  assert.doesNotMatch(result.stdout, /seeded /);
});
