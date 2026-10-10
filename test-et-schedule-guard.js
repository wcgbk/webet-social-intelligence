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

function wallCounts(ymd) {
  const counts = {};
  const t0 = Date.parse(`${ymd}T03:00:00Z`);
  for (let t = t0; t < t0 + 30 * 3600 * 1000; t += 60000) {
    const parts = et.etParts(new Date(t));
    if (parts.ymd !== ymd) continue;
    counts[parts.et] = (counts[parts.et] || 0) + 1;
  }
  return counts;
}

function expectSlots(from, through) {
  const expected = {};
  const walls = {};
  for (const ymd of etDays(from, through)) walls[ymd] = wallCounts(ymd);
  for (const [name, spec] of Object.entries(et.ET_SCHEDULE)) {
    expected[name] = {};
    for (const ymd of etDays(from, through)) {
      const weekday = et.etParts(new Date(`${ymd}T16:00:00Z`)).weekday;
      if (Array.isArray(spec.days) && spec.days.indexOf(weekday) === -1) continue;
      for (const slot of spec.etTimes) {
        const occur = walls[ymd][slot] || 0;
        const n = spec.dstFold === 'both' ? occur : (occur > 0 ? 1 : 0);
        if (n > 0) expected[name][`${ymd}|${slot}`] = n;
      }
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
      assert.strictEqual(got[key] || 0, want[key], `${name} ${key} during ${from}..${through} ran ${got[key] || 0} want ${want[key]}`);
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

assert.strictEqual(et.ET_SCHEDULE['regrade-circa'].etTimes.length, 24);
assert.ok(et.ET_SCHEDULE['regrade-circa'].etTimes.indexOf('01:40') !== -1);
assert.ok(et.ET_SCHEDULE['regrade-circa'].etTimes.indexOf('02:40') !== -1);
assert.strictEqual(et.ET_SCHEDULE['regrade-circa'].dstFold, 'both');
{
  const fall = simulate('2026-11-01', '2026-11-01');
  assert.strictEqual(fall['regrade-circa']['2026-11-01|01:40'], 2, 'fall-back 01:40 runs both copies');
  assert.strictEqual(fall['regrade-circa']['2026-11-01|02:40'], 1);
  assert.strictEqual(fall['capture-candidate-closes']['2026-11-01|01:00'], 1, 'closes keep the later fold only');
  assert.strictEqual(fall['capture-candidate-closes']['2026-11-01|01:15'], 1);
  assert.strictEqual(fall['capture-candidate-closes']['2026-11-01|01:30'], 1);
  const springDay = simulate('2027-03-14', '2027-03-14');
  assert.strictEqual(springDay['regrade-circa']['2027-03-14|02:40'] || 0, 0, 'spring-forward has no 02:40');
  assert.strictEqual(springDay['regrade-circa']['2027-03-14|01:40'], 1);
  assert.strictEqual(springDay['regrade-circa']['2027-03-14|03:40'], 1);
}
const earlyFold = et.etGuard('regrade-circa', schedulerEvent(), new Date('2026-11-01T05:40:00Z'));
assert.strictEqual(earlyFold.run, true);
assert.strictEqual(earlyFold.reason, 'dst-fold-both');
assert.strictEqual(earlyFold.matched, '01:40');
const laterFold = et.etGuard('regrade-circa', schedulerEvent(), new Date('2026-11-01T06:40:00Z'));
assert.strictEqual(laterFold.run, true);
assert.strictEqual(laterFold.reason, 'et-match');
assert.strictEqual(laterFold.matched, '01:40');
const earlyClose = et.etGuard('capture-candidate-closes', schedulerEvent(), new Date('2026-11-01T05:00:00Z'));
assert.strictEqual(earlyClose.run, false);
assert.strictEqual(earlyClose.reason, 'dst-fold');

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

const pregameSlots = et.ET_SCHEDULE['pregame-check-omega'].etTimes;
assert.strictEqual(pregameSlots.length, 26);
assert.strictEqual(pregameSlots[0], '11:00');
assert.strictEqual(pregameSlots[pregameSlots.length - 1], '23:30');
assert.ok(pregameSlots.indexOf('11:00') !== -1);
assert.ok(pregameSlots.indexOf('23:30') !== -1);
assert.ok(!pregameSlots.some((slot) => slot.endsWith(':40')));
assert.ok(!pregameSlots.some((slot) => slot.endsWith(':15') || slot.endsWith(':45') || slot.endsWith(':10')));
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-10T15:00:00Z')).run, true);
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-10T15:00:00Z')).matched, '11:00');
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-10T14:30:00Z')).run, false);
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-11T03:30:00Z')).run, true);
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-11T03:30:00Z')).matched, '23:30');
assert.strictEqual(et.etGuard('pregame-check-omega', sched, new Date('2026-10-11T03:41:00Z')).run, false);
assert.ok(!pregameSlots.some((slot) => slot.endsWith(':40')));
assert.strictEqual(et.rejectUnlessEtSlot('pregame-check-omega', sched, new Date('2026-10-10T14:30:00Z')).statusCode, 200);

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

    function isoAtEt(ymd, hour, minute) {
      const [y, mo, d] = ymd.split('-').map(Number);
      for (const utcHour of [hour + 4, hour + 5]) {
        const when = new Date(Date.UTC(y, mo - 1, d, utcHour, minute, 0));
        const parts = et.etParts(when);
        if (parts.ymd === ymd && parts.hour === hour && parts.minute === minute) return when.toISOString();
      }
      throw new Error(`cannot place ${ymd} ${hour}:${minute} ET`);
    }

    async function expectRebuild(label, generatedAt) {
      const prior = fetches;
      let reads = 0;
      const res = await triggerOmega.handler(event, {
        now,
        readCard: async () => {
          reads += 1;
          return { generatedAt, picks: [] };
        },
      });
      assert.strictEqual(res.body, 'Omega vNext triggered', label);
      assert.strictEqual(reads, 1, `${label} reads the card`);
      assert.strictEqual(fetches, prior + 1, `${label} force-rebuilds`);
    }

    await expectRebuild('today 02:00 ET', isoAtEt('2026-10-07', 2, 0));
    await expectRebuild('today 07:00 ET', isoAtEt('2026-10-07', 7, 0));

    const skip0931 = await triggerOmega.handler(event, {
      now,
      readCard: async () => ({ generatedAt: isoAtEt('2026-10-07', 9, 31), picks: [] }),
    });
    const body0931 = JSON.parse(skip0931.body);
    assert.strictEqual(skip0931.statusCode, 200);
    assert.strictEqual(body0931.skipped, 'et-guard');
    assert.strictEqual(body0931.reason, 'already-generated');
    assert.strictEqual(body0931.date, '2026-10-07');

    await expectRebuild('yesterday 09:31 ET', isoAtEt('2026-10-06', 9, 31));

    const priorError = fetches;
    let errorReads = 0;
    const errRes = await triggerOmega.handler(event, {
      now,
      readCard: async () => {
        errorReads += 1;
        throw new Error('blob down');
      },
    });
    assert.strictEqual(errRes.body, 'Omega vNext triggered', 'read error still runs');
    assert.strictEqual(errorReads, 1);
    assert.strictEqual(fetches, priorError + 1);

    const priorBypass = fetches;
    let bypassReads = 0;
    const bypass = await triggerOmega.handler({ httpMethod: 'POST', body: '{}' }, {
      now,
      readCard: async () => {
        bypassReads += 1;
        return { generatedAt: isoAtEt('2026-10-07', 9, 31), picks: [] };
      },
    });
    assert.strictEqual(bypass.body, 'Omega vNext triggered', 'non-scheduler bypasses idempotency');
    assert.strictEqual(bypassReads, 0, 'non-scheduler does not read');
    assert.strictEqual(fetches, priorBypass + 1);
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
