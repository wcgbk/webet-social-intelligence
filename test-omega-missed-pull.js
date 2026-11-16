'use strict';

/**
 * Missed 3:00 pull monitor. Local fixtures only: no Odds API, no writes.
 * The 2026-11-16 0300 board is the live capture from that morning.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { handleMissedPull, missedPullKey } = require('./netlify/functions/monitor-omega-missed-pull');

const DATE = '2026-11-16';
const BOARD_PATH = path.join(__dirname, 'fixtures/odds-master-pull-2026-11-16-0300.json');
const BOARD = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
// 3:15 AM ET on 2026-11-16 (EST, UTC-5).
const NOW_315 = new Date('2026-11-16T08:15:00.000Z');
const NOW_0400 = new Date('2026-11-16T09:00:00.000Z');

async function run(qs, deps) {
  return handleMissedPull(
    { queryStringParameters: qs || {} },
    {},
    Object.assign({ now: NOW_315, webhookUrl: '' }, deps || {}),
  );
}

function bodyOf(res) {
  return JSON.parse(res.body);
}

async function main() {
  assert.strictEqual(BOARD.date, DATE);
  assert.strictEqual(BOARD.slot, '0300');
  assert.ok(Array.isArray(BOARD.errors) && BOARD.errors.length === 0);
  assert.strictEqual(missedPullKey(DATE), `omega-ops/missed-pull-${DATE}`);

  const writes = [];
  const live = await run(
    { date: DATE, dryRun: '1' },
    {
      dryRun: true,
      readOddsMasterPull: async (dateISO, slot) => {
        assert.strictEqual(dateISO, DATE);
        assert.strictEqual(slot, '0300');
        return BOARD;
      },
      writeJson: async (key, data) => { writes.push({ key, data }); },
    },
  );
  const liveBody = bodyOf(live);
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(liveBody.ok, true);
  assert.strictEqual(liveBody.report.severity, 'ok');
  assert.strictEqual(liveBody.report.code, 'ok');
  assert.strictEqual(liveBody.report.board, true);
  assert.strictEqual(liveBody.report.date, DATE);
  assert.strictEqual(liveBody.report.gameCount, BOARD.games);
  assert.strictEqual(writes.length, 0, 'dryRun must not persist a report');

  const missingWrites = [];
  const missing = await run(
    { date: DATE, dryRun: '1' },
    {
      dryRun: true,
      sportsForCard: () => ['NBA', 'NFL', 'NHL'],
      readOddsMasterPull: async () => null,
      writeJson: async (key, data) => { missingWrites.push({ key, data }); },
    },
  );
  const missingBody = bodyOf(missing);
  assert.strictEqual(missing.statusCode, 200);
  assert.strictEqual(missingBody.ok, false);
  assert.strictEqual(missingBody.report.severity, 'alert');
  assert.strictEqual(missingBody.report.code, 'missed-0300-pull');
  assert.strictEqual(missingBody.report.board, false);
  assert.strictEqual(missingWrites.length, 0, 'dryRun must not persist a report');

  const persist = [];
  const stored = await run(
    { date: DATE },
    {
      readOddsMasterPull: async () => BOARD,
      writeJson: async (key, data) => { persist.push({ key, data }); },
    },
  );
  const storedBody = bodyOf(stored);
  assert.strictEqual(storedBody.ok, true);
  assert.strictEqual(persist.length, 1);
  assert.strictEqual(persist[0].key, missedPullKey(DATE));
  assert.strictEqual(persist[0].data.code, 'ok');

  const skip = await handleMissedPull(
    {
      body: JSON.stringify({ next_run: '2026-11-16T13:15:00.000Z' }),
      queryStringParameters: { date: DATE },
    },
    {},
    {
      now: NOW_0400,
      webhookUrl: '',
      readOddsMasterPull: async () => { throw new Error('et-guard should skip before the read'); },
    },
  );
  const skipBody = bodyOf(skip);
  assert.strictEqual(skip.statusCode, 200);
  assert.strictEqual(skipBody.skipped, 'et-guard');
  assert.strictEqual(skipBody.reason, 'outside-et-slot');

  const slotRunWrites = [];
  const slotRun = await handleMissedPull(
    {
      body: JSON.stringify({ next_run: '2026-11-16T08:15:00.000Z' }),
      queryStringParameters: { date: DATE, dryRun: '1' },
    },
    {},
    {
      now: NOW_315,
      dryRun: true,
      webhookUrl: '',
      readOddsMasterPull: async () => BOARD,
      writeJson: async (key, data) => { slotRunWrites.push({ key, data }); },
    },
  );
  const slotBody = bodyOf(slotRun);
  assert.strictEqual(slotBody.ok, true);
  assert.strictEqual(slotBody.report.code, 'ok');
  assert.strictEqual(slotRunWrites.length, 0);

  console.log('test-omega-missed-pull: ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
