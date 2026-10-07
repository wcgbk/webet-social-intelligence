'use strict';
// DST cron coverage and ET guard. No network. Fetch is stubbed around the one handler call.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const et = require('./netlify/functions/lib/et-schedule');
const triggerOmega = require('./netlify/functions/trigger-picks-omega');

const root = __dirname;
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const active = et.activeTomlSchedules(toml);
const activeByName = {};
for (const row of active) activeByName[row.functionName] = row.cron;

function readCronFromSource(name) {
  const src = fs.readFileSync(path.join(root, 'netlify/functions', `${name}.js`), 'utf8');
  const found = src.match(/schedule:\s*'([^']+)'/);
  assert.ok(found, `${name} exports.config schedule`);
  return found[1];
}

const crons = {};
for (const name of Object.keys(et.ET_SCHEDULE)) {
  if (name === 'admin-auto-draft') {
    assert.ok(!activeByName[name], 'admin-auto-draft toml schedule stays paused');
    crons[name] = readCronFromSource(name);
  } else {
    assert.ok(activeByName[name], `${name} missing active toml schedule`);
    crons[name] = activeByName[name];
  }
  const parsed = et.parseCron(crons[name]);
  for (const slot of et.ET_SCHEDULE[name].etTimes) {
    const want = et.utcHoursForEt(slot);
    assert.ok(parsed.minute.has(want.minute), `${name} ${slot} minute ${want.minute} not in ${crons[name]}`);
    for (const hour of want.hours) {
      assert.ok(parsed.hour.has(hour), `${name} ${slot} UTC hour ${hour} not in ${crons[name]}`);
    }
  }
}

for (const row of active) {
  assert.ok(et.ET_SCHEDULE[row.functionName], `active schedule ${row.functionName} is not in the ET table`);
}

assert.ok(et.SCHEDULE_NA.some((row) => row.functionName === 'admin-queue-process' && row.et === 'N/A'));
assert.ok(!et.ET_SCHEDULE['admin-queue-process']);
assert.strictEqual(readCronFromSource('admin-queue-process'), '*/15 * * * *');
assert.ok(!activeByName['admin-queue-process']);

function nextDay(ymd) {
  const parts = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function etDays(from, through) {
  const days = [];
  for (let date = from; date <= through; date = nextDay(date)) days.push(date);
  return days;
}

function schedulerEvent(nextRun) {
  return {
    httpMethod: 'POST',
    headers: {
      'x-nf-event': 'schedule',
      'user-agent': 'Netlify Clockwork',
    },
    body: JSON.stringify({ next_run: nextRun || '2099-01-01T00:00:00.000Z' }),
  };
}

function simulate(from, through) {
  const runs = {};
  for (const name of Object.keys(et.ET_SCHEDULE)) runs[name] = {};
  const event = schedulerEvent();
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${nextDay(nextDay(through))}T00:00:00Z`);
  for (let t = start; t < end; t += 60000) {
    const when = new Date(t);
    for (const name of Object.keys(et.ET_SCHEDULE)) {
      if (!et.cronMatches(crons[name], when)) continue;
      const guard = et.etGuard(name, event, when);
      if (!guard.run) continue;
      if (guard.ymd < from || guard.ymd > through) continue;
      assert.strictEqual(guard.et, guard.matched, `${name} ${when.toISOString()} fired at ${guard.et}`);
      const key = `${guard.ymd}|${guard.matched}`;
      runs[name][key] = (runs[name][key] || 0) + 1;
    }
  }
  return runs;
}

function expectSlots(from, through) {
  const expected = {};
  for (const [name, spec] of Object.entries(et.ET_SCHEDULE)) {
    expected[name] = {};
    for (const ymd of etDays(from, through)) {
      const weekday = et.etParts(new Date(`${ymd}T16:00:00Z`)).weekday;
      if (Array.isArray(spec.days) && spec.days.indexOf(weekday) === -1) continue;
      for (const slot of spec.etTimes) expected[name][`${ymd}|${slot}`] = 1;
    }
  }
  return expected;
}

function assertWindow(from, through) {
  const runs = simulate(from, through);
  const expected = expectSlots(from, through);
  for (const name of Object.keys(expected)) {
    const got = runs[name];
    const want = expected[name];
    for (const key of Object.keys(want)) {
      assert.strictEqual(got[key] || 0, 1, `${name} ${key} during ${from}..${through} ran ${got[key] || 0}`);
    }
    for (const key of Object.keys(got)) {
      assert.ok(Object.prototype.hasOwnProperty.call(want, key), `${name} unexpected run ${key} during ${from}..${through}`);
    }
    for (const ymd of etDays(from, through)) {
      const omega = got[`${ymd}|09:30`] || 0;
      const verify = name === 'verify-picks-omega' ? (got[`${ymd}|10:30`] || 0) : null;
      if (name === 'trigger-picks-omega') assert.strictEqual(omega, 1, `${ymd} omega runs`);
      if (name === 'verify-picks-omega') assert.strictEqual(verify, 1, `${ymd} verify runs`);
    }
  }
}

assertWindow('2026-10-25', '2026-11-08');
assertWindow('2027-03-07', '2027-03-21');

const sched = schedulerEvent('2026-10-07T13:30:00.000Z');
const at0930 = new Date('2026-10-07T13:30:00Z');
const match = et.etGuard('trigger-picks-omega', sched, at0930);
assert.strictEqual(match.scheduler, true);
assert.strictEqual(match.run, true);
assert.strictEqual(match.matched, '09:30');
assert.strictEqual(match.ymd, '2026-10-07');

const manual = et.etGuard('trigger-picks-omega', { httpMethod: 'POST', body: '{}' }, new Date('2026-10-07T18:00:00Z'));
assert.strictEqual(manual.scheduler, false);
assert.strictEqual(manual.run, true);
assert.strictEqual(manual.reason, 'not-scheduler');
assert.strictEqual(et.rejectUnlessEtSlot('trigger-picks-omega', { httpMethod: 'GET' }, new Date('2026-11-01T02:00:00Z')), null);

const wrongHour = et.etGuard('trigger-picks-omega', sched, new Date('2026-10-07T14:30:00Z'));
assert.strictEqual(wrongHour.run, false);
assert.strictEqual(wrongHour.reason, 'outside-et-slot');
const skipped = et.rejectUnlessEtSlot('verify-picks-omega', sched, at0930);
assert.strictEqual(JSON.parse(skipped.body).skipped, 'et-guard');
assert.strictEqual(et.rejectUnlessEtSlot('verify-picks-omega', sched, new Date('2026-10-07T14:30:00Z')), null);

assert.strictEqual(et.etGuard('trigger-picks-omega', sched, new Date('2026-11-01T13:30:00Z')).run, false);
assert.strictEqual(et.etGuard('trigger-picks-omega', sched, new Date('2026-11-01T14:30:00Z')).matched, '09:30');
assert.strictEqual(et.etGuard('trigger-picks-omega', sched, new Date('2027-03-14T13:30:00Z')).matched, '09:30');
assert.strictEqual(et.etGuard('trigger-picks-omega', sched, new Date('2027-03-14T14:30:00Z')).run, false);

const evening = et.etGuard('capture-omega-walkforward-evening', sched, new Date('2026-11-02T00:45:00Z'));
assert.strictEqual(evening.run, true);
assert.strictEqual(evening.ymd, '2026-11-01');
assert.strictEqual(evening.matched, '19:45');
assert.strictEqual(et.etGuard('capture-omega-walkforward-evening', sched, new Date('2026-11-01T23:45:00Z')).run, false);

const clv = et.etGuard('trigger-clv', sched, new Date('2026-11-02T00:00:00Z'));
assert.strictEqual(clv.run, true);
assert.strictEqual(clv.ymd, '2026-11-01');
assert.strictEqual(clv.matched, '19:00');

const tue = et.etGuard('trigger-picks-circa', sched, new Date('2026-10-06T17:15:00Z'));
assert.strictEqual(tue.run, false);
assert.strictEqual(tue.reason, 'outside-et-weekday');
const wed = et.etGuard('trigger-picks-circa', sched, new Date('2026-10-07T17:15:00Z'));
assert.strictEqual(wed.run, true);
assert.strictEqual(wed.matched, '13:15');

assert.strictEqual(et.etGuard('self-optimize', sched, new Date('2026-11-01T10:00:00Z')).matched, '05:00');
assert.strictEqual(et.etGuard('self-optimize', sched, new Date('2026-11-02T10:00:00Z')).reason, 'outside-et-weekday');

async function idempotency() {
  const now = new Date('2026-10-07T13:30:00Z');
  const event = schedulerEvent(now.toISOString());
  const card = { generatedAt: '2026-10-07T13:40:00Z', picks: [] };
  let fetches = 0;
  const prev = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    return { status: 200 };
  };
  try {
    const first = await triggerOmega.handler(event, { now, readCard: async () => card });
    const second = await triggerOmega.handler(event, { now, readCard: async () => card });
    for (const res of [first, second]) {
      const body = JSON.parse(res.body);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(body.skipped, 'et-guard');
      assert.strictEqual(body.function, 'trigger-picks-omega');
      assert.strictEqual(body.reason, 'already-generated');
      assert.strictEqual(body.date, '2026-10-07');
    }
    assert.strictEqual(fetches, 0, 'existing card must not regenerate');

    const missing = await et.morningCardIdempotency(event, now, async () => null);
    assert.strictEqual(missing.skip, false);
    const stale = await et.morningCardIdempotency(event, now, async () => ({ generatedAt: '2026-10-06T13:40:00Z' }));
    assert.strictEqual(stale.skip, false);
    const blown = await et.morningCardIdempotency(event, now, async () => { throw new Error('blob down'); });
    assert.strictEqual(blown.skip, false);
    assert.strictEqual(blown.readError, true);

    let manualReads = 0;
    const manualRes = await triggerOmega.handler({ httpMethod: 'POST', body: '{}' }, {
      now,
      readCard: async () => { manualReads += 1; return card; },
    });
    assert.strictEqual(manualRes.body, 'Omega vNext triggered');
    assert.strictEqual(manualReads, 0);
    assert.strictEqual(fetches, 1);

    const before = fetches;
    let wrongReads = 0;
    const wrong = await triggerOmega.handler(schedulerEvent('2026-10-07T14:30:00Z'), {
      now: new Date('2026-10-07T14:30:00Z'),
      readCard: async () => { wrongReads += 1; return null; },
    });
    assert.strictEqual(JSON.parse(wrong.body).reason, 'outside-et-slot');
    assert.strictEqual(wrongReads, 0);
    assert.strictEqual(fetches, before);
  } finally {
    global.fetch = prev;
  }
}

idempotency().then(() => {
  console.log('PASS test-et-schedule-guard');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
