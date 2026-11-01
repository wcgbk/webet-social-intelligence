'use strict';
/**
 * Omega card chain stays on the same America/New_York wall clock all year.
 * Netlify crons are UTC, so each job lists the EDT hour and the EST hour.
 * rejectUnlessEtSlot lets exactly one copy through. No network, no blobs.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ET_SCHEDULE,
  activeTomlSchedules,
  etParts,
  rejectUnlessEtSlot,
  utcHoursForEt,
} = require('./netlify/functions/lib/et-schedule');

const EXPECTED = {
  'capture-odds-3am': '03:00',
  'capture-odds-10am': '10:00',
  'trigger-picks-omega': '10:15',
  'verify-picks-omega': '10:45',
  'trigger-picks-omega-v1': '10:45',
  'capture-omega-pm-observer': '10:50',
};

const NAMES = Object.keys(EXPECTED);
const DAYS = ['2026-10-30', '2026-11-02'];

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
const schedules = activeTomlSchedules(toml).filter((row) => NAMES.includes(row.functionName));
assert.strictEqual(schedules.length, NAMES.length, 'one active cron per chain function');
const cronByName = Object.fromEntries(schedules.map((row) => [row.functionName, row.cron]));

function schedulerEvent(nextRun) {
  return { body: JSON.stringify({ next_run: nextRun }) };
}

for (const name of NAMES) {
  const hhmm = EXPECTED[name];
  const spec = ET_SCHEDULE[name];
  assert.ok(spec, `${name} is in ET_SCHEDULE`);
  assert.deepStrictEqual(spec.etTimes, [hhmm], `${name} ET wall time`);

  const { minute, hours } = utcHoursForEt(hhmm);
  assert.strictEqual(
    cronByName[name],
    `${minute} ${hours.join(',')} * * *`,
    `${name} cron is the EDT/EST pair`
  );

  for (const day of DAYS) {
    const [year, month, date] = day.split('-').map(Number);
    const fires = hours.map((utcHour) => {
      const now = new Date(Date.UTC(year, month - 1, date, utcHour, minute, 0));
      const skip = rejectUnlessEtSlot(name, schedulerEvent(now.toISOString()), now);
      return { utcHour, now, skip, et: etParts(now).et };
    });
    const passed = fires.filter((fire) => fire.skip == null);
    assert.strictEqual(passed.length, 1, `${name} ${day} passes once`);
    assert.strictEqual(passed[0].et, hhmm, `${name} ${day} passes at ${hhmm} ET`);
    const rejected = fires.filter((fire) => fire.skip != null);
    assert.strictEqual(rejected.length, 1, `${name} ${day} rejects the other copy`);
    assert.notStrictEqual(rejected[0].et, hhmm);
    const body = JSON.parse(rejected[0].skip.body);
    assert.strictEqual(rejected[0].skip.statusCode, 200);
    assert.strictEqual(body.skipped, 'et-guard');
    assert.strictEqual(body.function, name);
    assert.strictEqual(body.reason, 'outside-et-slot');
  }

  for (const day of DAYS) {
    const [year, month, date] = day.split('-').map(Number);
    const { minute, hours } = utcHoursForEt(hhmm);
    for (const utcHour of hours) {
      const now = new Date(Date.UTC(year, month - 1, date, utcHour, minute, 0));
      assert.strictEqual(rejectUnlessEtSlot(name, {}, now), null, `${name} empty event`);
      assert.strictEqual(
        rejectUnlessEtSlot(name, { httpMethod: 'POST', body: '{}' }, now),
        null,
        `${name} manual HTTP`
      );
      assert.strictEqual(
        rejectUnlessEtSlot(name, { body: JSON.stringify({ next_run: '' }) }, now),
        null,
        `${name} blank next_run`
      );
    }
  }

  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions', `${name}.js`), 'utf8');
  assert.ok(src.includes("require('./lib/et-schedule')"), `${name} requires et-schedule`);
  const handlerAt = src.indexOf('exports.handler');
  assert.ok(handlerAt >= 0, `${name} handler`);
  const handlerSrc = src.slice(handlerAt);
  const call = `rejectUnlessEtSlot('${name}', event, new Date())`;
  const callAt = handlerSrc.indexOf(call);
  const awaitAt = handlerSrc.search(/\bawait\b/);
  assert.ok(callAt >= 0, `${name} calls rejectUnlessEtSlot with its own name`);
  assert.ok(awaitAt === -1 || callAt < awaitAt, `${name} guard is before the first await`);
}

console.log('test-omega-dst-schedule: ALL PASS');
