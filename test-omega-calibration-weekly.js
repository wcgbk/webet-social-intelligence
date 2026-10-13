'use strict';
/**
 * Weekly calibration review. Report only. No blob writes, no fit, no Odds API.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FIT_ENABLED } = require('./netlify/functions/lib/omega-vnext/walk_forward');
const job = require('./netlify/functions/report-calibration-omega');
const et = require('./netlify/functions/lib/et-schedule');

assert.strictEqual(FIT_ENABLED, false);

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
assert.ok(toml.includes('[functions."report-calibration-omega"]'));
assert.ok(toml.includes('schedule = "15 10,11 * * 0"'));
const selfBlock = toml.split('[functions."self-optimize-omega"]')[1].split('[functions.')[0];
assert.ok(selfBlock.includes('# schedule = "0 9 * * 0"'));
assert.ok(!/^\s*schedule\s*=/m.test(selfBlock));

assert.deepStrictEqual(et.ET_SCHEDULE['report-calibration-omega'], {
  etTimes: ['06:15'],
  days: [0],
});

function scheduler(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify(body || { next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

(async () => {
  const monday = await job.handle(
    scheduler(),
    new Date('2026-10-19T10:15:00Z'),
    { rows: [], dryRun: true, writeJson: async () => { throw new Error('must not write'); } },
  );
  const mondayBody = JSON.parse(monday.body);
  assert.strictEqual(mondayBody.skipped, 'et-guard');

  const writes = [];
  const sunday = await job.handle(
    scheduler({ dryRun: true, date: '2026-10-18' }),
    new Date('2026-10-18T10:15:00Z'),
    {
      rows: [],
      dryRun: true,
      readJson: async () => { throw new Error('must not read'); },
      writeJson: async () => { writes.push('x'); },
      env: { OMEGA_REPLAY_NO_WRITE: '1' },
    },
  );
  const body = JSON.parse(sunday.body);
  assert.strictEqual(body.wrote, false);
  assert.strictEqual(body.reason, 'dry-run');
  assert.strictEqual(body.applied, false);
  assert.strictEqual(body.fitEnabled, false);
  assert.strictEqual(body.displayOnly, true);
  assert.strictEqual(body.asOf, '2026-10-18');
  assert.ok(Array.isArray(body.sports) && body.sports.length >= 4);
  assert.ok(body.sports.every((row) => row.n === 0));
  assert.ok(body.recommendation && /not applied/i.test(body.recommendation.text));
  assert.strictEqual(writes.length, 0);
  assert.ok(/FIT stays off/i.test(body.note));

  const direct = await job.runWeeklyCalibration({
    asOf: '2026-10-18',
    now: new Date('2026-10-18T10:15:00Z'),
    dryRun: true,
    rows: [],
    env: {},
    writeJson: async () => { throw new Error('must not write'); },
  });
  assert.strictEqual(direct.wrote, false);
  assert.strictEqual(direct.report.fitEnabled, false);
  console.log('test-omega-calibration-weekly: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
