'use strict';
// Capture-done marker and the 10:05 wait. Injected blobs. No network, no real sleep.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runPinnacleLineCapture } = require('./netlify/functions/lib/omega-vnext/capture_runner');
const moves = require('./netlify/functions/lib/omega-vnext/pinnacle_line_move');
const gate = require('./netlify/functions/lib/omega-vnext/capture_gate');
const { canonicalBlobKey } = require('./netlify/functions/lib/omega-vnext/blob_key');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');

const DATE = '2026-10-15';

function memoryStore() {
  const blobs = new Map();
  const writes = [];
  return {
    blobs,
    writes,
    async read(key) {
      if (!blobs.has(key)) return null;
      return JSON.parse(JSON.stringify(blobs.get(key)));
    },
    async write(key, data) {
      writes.push(key);
      blobs.set(key, JSON.parse(JSON.stringify(data)));
    },
  };
}

function captureOpts(store, extra) {
  return Object.assign({
    dateISO: DATE,
    apiKey: 'test-key',
    labels: [],
    env: { OMEGA_REPLAY_NO_WRITE: '0' },
    now: new Date('2026-10-15T14:02:00Z'),
    read: store.read,
    write: store.write,
    fetchImpl() { throw new Error('odds pull'); },
    fetchBookOdds() { throw new Error('odds pull'); },
  }, extra);
}

function marker(store, slot) {
  return store.blobs.get(moves.captureDoneKey(DATE, slot));
}

(async () => {
  const key = moves.captureDoneKey(DATE, '1000');
  assert.strictEqual(key, 'capture-done/2026-10-15/1000');
  assert.strictEqual(canonicalBlobKey(key), 'capture-done/2026-10-15/1000');
  assert.ok(canonicalBlobKey(key).indexOf('%2F') === -1);

  const at10 = memoryStore();
  const ten = await runPinnacleLineCapture(captureOpts(at10, {
    mode: 'check',
    etSlot: '1000',
  }));
  assert.strictEqual(ten.ok, true);
  assert.strictEqual(ten.gameCount, 0);
  const tenDoc = marker(at10, '1000');
  assert.ok(tenDoc, '1000 marker');
  assert.strictEqual(tenDoc.schema, moves.CAPTURE_DONE_SCHEMA);
  assert.strictEqual(tenDoc.date, DATE);
  assert.strictEqual(tenDoc.slot, '1000');
  assert.strictEqual(tenDoc.ok, true);
  assert.strictEqual(tenDoc.gameCount, 0);
  assert.deepStrictEqual(tenDoc.sports, []);
  assert.strictEqual(tenDoc.pulls, 0);
  assert.strictEqual(tenDoc.completedAt, '2026-10-15T14:02:00.000Z');
  assert.ok(!Object.prototype.hasOwnProperty.call(tenDoc, 'closesStored'));

  const at3 = memoryStore();
  const three = await runPinnacleLineCapture(captureOpts(at3, {
    mode: 'check',
    etSlot: '0300',
    now: new Date('2026-10-15T07:02:00Z'),
  }));
  assert.strictEqual(three.gameCount, 0);
  const threeDoc = marker(at3, '0300');
  assert.ok(threeDoc, '0300 marker');
  assert.strictEqual(threeDoc.ok, true);
  assert.strictEqual(threeDoc.gameCount, 0);
  assert.strictEqual(threeDoc.closesStored, 0);
  assert.strictEqual(threeDoc.slot, '0300');

  const dry = memoryStore();
  let dryWrites = 0;
  await runPinnacleLineCapture(captureOpts(dry, {
    mode: 'check',
    etSlot: '1000',
    dryRun: true,
    write() { dryWrites += 1; throw new Error('dry-run wrote'); },
  }));
  assert.strictEqual(dryWrites, 0);
  assert.strictEqual(marker(dry, '1000'), undefined);

  const replay = memoryStore();
  let replayWrites = 0;
  await runPinnacleLineCapture(captureOpts(replay, {
    mode: 'check',
    etSlot: '0300',
    now: new Date('2026-10-15T07:02:00Z'),
    env: { OMEGA_REPLAY_NO_WRITE: '1' },
    write() { replayWrites += 1; throw new Error('replay wrote'); },
  }));
  assert.strictEqual(replayWrites, 0);

  const broken = memoryStore();
  const errors = [];
  const prevErr = console.error;
  console.error = (line) => { errors.push(String(line)); };
  let body;
  try {
    body = await runPinnacleLineCapture(captureOpts(broken, {
      mode: 'check',
      etSlot: '0300',
      now: new Date('2026-10-15T07:02:00Z'),
      labels: ['NFL'],
      fetchBookOdds() { throw new Error('sport down'); },
    }));
  } finally {
    console.error = prevErr;
  }
  assert.strictEqual(body.ok, true);
  const bad = marker(broken, '0300');
  assert.ok(bad);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.closesStored, 0);
  assert.ok(bad.sports.some((row) => row === 'NFL:err'));

  const soft = memoryStore();
  const softErr = [];
  console.error = (line) => { softErr.push(String(line)); };
  let softBody;
  try {
    softBody = await runPinnacleLineCapture(captureOpts(soft, {
      mode: 'check',
      etSlot: '1000',
      write() { throw new Error('marker down'); },
    }));
  } finally {
    console.error = prevErr;
  }
  assert.strictEqual(softBody.ok, true);
  assert.ok(softErr.some((line) => line.includes('capture-done-write-failed')));

  const openStore = memoryStore();
  await runPinnacleLineCapture(captureOpts(openStore, {
    mode: 'open',
    labels: [],
  }));
  assert.strictEqual(openStore.writes.length, 0);

  const eventKey = 'date/2026-10-15/event/NFL/e1';
  const blobs = {
    'date/2026-10-15': {
      schema: moves.SCHEMA,
      date: DATE,
      events: [{ sport: 'NFL', eventId: 'e1' }],
    },
    [eventKey]: { schema: moves.SCHEMA, marker: true, sport: 'NFL', eventId: 'e1', date: DATE },
    'NFL/e1': {
      schema: moves.SCHEMA,
      sport: 'NFL',
      eventId: 'e1',
      checks: [{ slot: '1000', at: '2026-10-15T14:00:00.000Z' }],
    },
    [key]: {
      schema: moves.CAPTURE_DONE_SCHEMA,
      sport: 'NFL',
      eventId: '1000',
      date: DATE,
      slot: '1000',
      completedAt: '2026-10-15T14:02:00.000Z',
      ok: true,
    },
  };
  const prefixes = [];
  const listed = await moves.readPinnacleLineMoves(DATE, {
    read: async (k) => (blobs[k] ? JSON.parse(JSON.stringify(blobs[k])) : null),
    list: async (prefix) => {
      prefixes.push(prefix);
      return Object.keys(blobs).filter((item) => item.startsWith(prefix));
    },
  });
  assert.deepStrictEqual(prefixes, [`date/${DATE}/event/`]);
  assert.strictEqual(listed.events.length, 1);
  assert.strictEqual(listed.events[0].eventId, 'e1');
  assert.ok(!JSON.stringify(listed).includes('capture-done'));
  assert.ok(!JSON.stringify(listed).includes('completedAt'));

  const hostile = await moves.readPinnacleLineMoves(DATE, {
    read: async (k) => {
      if (k === `date/${DATE}`) return { schema: moves.SCHEMA, events: [{ sport: 'NFL', eventId: 'e1' }] };
      if (k === 'NFL/e1') return blobs[key];
      return null;
    },
    list: async () => [key, eventKey],
  });
  assert.strictEqual(hostile, null);

  const clock = (start) => {
    let t = start;
    return {
      now: () => t,
      sleep: async (ms) => { t += ms; },
    };
  };

  const sports = () => ['NFL'];
  let movesReads = 0;
  const immediate = clock(Date.parse('2026-10-15T14:05:00Z'));
  let slept = 0;
  const ready = await gate.waitForCapture(DATE, '1000', {
    read: async () => blobs[key],
    readPinnacleLineMoves: async () => { movesReads += 1; return null; },
    sportsForCard: sports,
    now: immediate.now,
    sleep: async (ms) => { slept += ms; await immediate.sleep(ms); },
    maxWaitMs: 240000,
    pollMs: 15000,
  });
  assert.strictEqual(ready.reason, 'marker');
  assert.strictEqual(ready.ready, true);
  assert.strictEqual(ready.polls, 1);
  assert.strictEqual(ready.waitedMs, 0);
  assert.strictEqual(slept, 0);
  assert.strictEqual(movesReads, 0);

  const notOk = await gate.waitForCapture(DATE, '1000', {
    read: async () => ({ schema: moves.CAPTURE_DONE_SCHEMA, date: DATE, slot: '1000', ok: false, sports: ['NFL:err'] }),
    readPinnacleLineMoves: async () => { throw new Error('kept waiting'); },
    sportsForCard: sports,
    now: () => Date.parse('2026-10-15T14:05:00Z'),
    sleep: async () => { throw new Error('slept after not-ok'); },
  });
  assert.strictEqual(notOk.reason, 'marker-not-ok');
  assert.strictEqual(notOk.ready, true);
  assert.strictEqual(notOk.polls, 1);

  const later = clock(0);
  let pollsSeen = 0;
  const after = await gate.waitForCapture(DATE, '1000', {
    read: async () => {
      pollsSeen += 1;
      if (pollsSeen >= 3) {
        return { schema: moves.CAPTURE_DONE_SCHEMA, date: DATE, slot: '1000', ok: true, completedAt: 'x' };
      }
      return null;
    },
    readPinnacleLineMoves: async () => null,
    sportsForCard: sports,
    now: later.now,
    sleep: later.sleep,
    maxWaitMs: 240000,
    pollMs: 15000,
  });
  assert.strictEqual(after.reason, 'marker');
  assert.strictEqual(after.polls, 3);
  assert.strictEqual(after.waitedMs, 30000);
  assert.strictEqual(after.ready, true);

  const oldBoard = {
    events: [{
      sport: 'NFL',
      eventId: 'e1',
      checks: [{ slot: '1000', at: '2026-10-15T14:00:00.000Z' }],
    }],
  };
  const present = await gate.waitForCapture(DATE, '1000', {
    read: async () => null,
    readPinnacleLineMoves: async () => oldBoard,
    sportsForCard: sports,
    now: () => Date.parse('2026-10-15T14:05:00.000Z'),
    sleep: async () => { throw new Error('slept on settled board'); },
    maxWaitMs: 0,
  });
  assert.strictEqual(present.reason, 'data-present');
  assert.strictEqual(present.ready, true);
  assert.strictEqual(present.polls, 1);

  const freshAt = new Date(Date.parse('2026-10-15T14:05:00Z') - 60000).toISOString();
  const boundary = await gate.waitForCapture(DATE, '1000', {
    read: async () => null,
    readPinnacleLineMoves: async () => ({
      events: [{ sport: 'NFL', eventId: 'e1', checks: [{ slot: '1000', at: freshAt }] }],
    }),
    sportsForCard: sports,
    now: () => Date.parse('2026-10-15T14:05:00Z'),
    sleep: async () => {},
    maxWaitMs: 0,
    pollMs: 15000,
  });
  assert.strictEqual(boundary.reason, 'timeout');
  assert.strictEqual(boundary.ready, false);

  const timed = clock(0);
  const alertLines = [];
  console.error = (line) => { alertLines.push(String(line)); };
  let timedOut;
  try {
    timedOut = await gate.waitForCapture(DATE, '1000', {
      read: async () => null,
      readPinnacleLineMoves: async () => null,
      sportsForCard: sports,
      now: timed.now,
      sleep: timed.sleep,
      maxWaitMs: 30000,
      pollMs: 15000,
    });
  } finally {
    console.error = prevErr;
  }
  assert.strictEqual(timedOut.reason, 'timeout');
  assert.strictEqual(timedOut.ready, false);
  assert.strictEqual(timedOut.polls, 3);
  assert.strictEqual(timedOut.waitedMs, 30000);
  assert.ok(alertLines.some((line) => line.includes('capture-1000-not-finished')));

  let readCalls = 0;
  const empty = await gate.waitForCapture(DATE, '1000', {
    read: async () => { readCalls += 1; return null; },
    sportsForCard: () => [],
    sleep: async () => { throw new Error('slept with no sports'); },
  });
  assert.strictEqual(empty.reason, 'no-sports-today');
  assert.strictEqual(empty.ready, true);
  assert.strictEqual(empty.polls, 0);
  assert.strictEqual(readCalls, 0);

  async function boom() { throw new Error('waited'); }
  const skipped = [
    { scheduled: false },
    { scheduled: true, dryRun: true },
    { scheduled: true, replay: true },
    { scheduled: true, historicalSnapshot: '2026-10-15T14:00:00Z' },
    { scheduled: true, shadow: true },
    { scheduled: true, simMode: true },
  ];
  for (const opts of skipped) {
    const result = await gate.awaitLiveCaptureGate(Object.assign({ dateISO: DATE, read: boom }, opts));
    assert.strictEqual(result, null, JSON.stringify(opts));
  }
  const live = await gate.awaitLiveCaptureGate({
    scheduled: true,
    dateISO: DATE,
    sportsForCard: () => [],
    read: boom,
  });
  assert.strictEqual(live.reason, 'no-sports-today');
  assert.strictEqual(live.ready, true);

  const indexSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  const genAt = indexSrc.indexOf('async function generateOmegaVnext');
  const gen = indexSrc.slice(genAt);
  const gateAt = gen.indexOf('await awaitLiveCaptureGate(');
  const ingestAt = gen.indexOf('await ingest(');
  assert.ok(gateAt > 0 && gateAt < ingestAt);
  assert.ok(gen.includes('scheduled: opts.scheduled === true'));
  assert.ok(gen.includes('picksData.health.captureGate = captureGate'));
  assert.ok(gen.includes('healthRecord.captureGate = captureGate'));
  assert.ok(gen.includes('Object.assign({}, captureHealth, { captureGate })'));
  const bg = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
  assert.ok(bg.includes('scheduled,'));
  assert.ok(bg.includes("body.scheduled === true"));

  const pub = publicPicksPayload({
    picks: [{ pick: 'Chiefs', sport: 'NFL', odds: '-110' }],
    health: { status: 'ok', captureGate: { ready: false, reason: 'timeout' } },
    captureGate: { ready: false, reason: 'timeout' },
    captureHealth: { ok: true },
  });
  assert.strictEqual(pub.health, undefined);
  assert.strictEqual(pub.captureGate, undefined);
  assert.strictEqual(pub.captureHealth.ok, true);
  assert.strictEqual(pub.captureHealth.captureGate, undefined);

  console.log('PASS test-omega-capture-gate-1015');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
