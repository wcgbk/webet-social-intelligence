'use strict';
// 10:05 ET card build, 3:00/10:00 capture, 3:15 missed-pull. Offline.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const et = require('./netlify/functions/lib/et-schedule');
const gate = require('./netlify/functions/lib/omega-vnext/capture_gate');

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
const active = et.activeTomlSchedules(toml);
const cronOf = (name) => {
  const row = active.find((item) => item.functionName === name);
  assert.ok(row, `${name} schedule`);
  return row.cron;
};

function scheduler(iso) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: iso }),
  };
}

function assertFire(name, iso, slot) {
  const when = new Date(iso);
  assert.strictEqual(et.cronMatches(cronOf(name), when), true, `${name} cron ${iso}`);
  const guard = et.etGuard(name, scheduler(iso), when);
  assert.strictEqual(guard.run, true, `${name} ${iso} et=${guard.et}`);
  assert.strictEqual(guard.matched, slot, `${name} ${iso}`);
}

function assertCronSkippedByGuard(name, iso) {
  const when = new Date(iso);
  assert.strictEqual(et.cronMatches(cronOf(name), when), true, `${name} cron should fire ${iso}`);
  const guard = et.etGuard(name, scheduler(iso), when);
  assert.strictEqual(guard.run, false, `${name} ${iso} et=${guard.et} must not run`);
}

assert.strictEqual(cronOf('trigger-picks-omega'), '5 14,15 * * *');
assert.strictEqual(cronOf('capture-omega-pinnacle-lines'), '0 7,8,14,15 * * *');
assert.strictEqual(cronOf('monitor-omega-missed-pull'), '15 7,8 * * *');
assert.deepStrictEqual(et.ET_SCHEDULE['trigger-picks-omega'].etTimes, ['10:05']);
assert.deepStrictEqual(et.ET_SCHEDULE['capture-omega-pinnacle-lines'].etTimes, ['03:00', '10:00']);
assert.deepStrictEqual(et.ET_SCHEDULE['monitor-omega-missed-pull'].etTimes, ['03:15']);

// EDT (2026-10-14, UTC-4). The 15:05 UTC copy is 11:05 ET, outside ±10 min.
assert.strictEqual(et.etParts(new Date('2026-10-14T14:05:00Z')).et, '10:05');
assert.strictEqual(et.etParts(new Date('2026-10-14T15:05:00Z')).et, '11:05');
assertFire('trigger-picks-omega', '2026-10-14T14:05:00Z', '10:05');
assertCronSkippedByGuard('trigger-picks-omega', '2026-10-14T15:05:00Z');
assert.strictEqual(et.cronMatches(cronOf('trigger-picks-omega'), new Date('2026-10-14T14:00:00Z')), false);
assert.strictEqual(et.cronMatches(cronOf('trigger-picks-omega'), new Date('2026-10-14T14:15:00Z')), false);

assertFire('capture-omega-pinnacle-lines', '2026-10-14T07:00:00Z', '03:00');
assertFire('capture-omega-pinnacle-lines', '2026-10-14T14:00:00Z', '10:00');
assertCronSkippedByGuard('capture-omega-pinnacle-lines', '2026-10-14T08:00:00Z');
assertCronSkippedByGuard('capture-omega-pinnacle-lines', '2026-10-14T15:00:00Z');

assertFire('monitor-omega-missed-pull', '2026-10-14T07:15:00Z', '03:15');
assertCronSkippedByGuard('monitor-omega-missed-pull', '2026-10-14T08:15:00Z');

// EST after 2026-11-01 (UTC-5). Trigger fires only at 15:05 UTC.
assert.strictEqual(et.etParts(new Date('2026-11-03T14:05:00Z')).et, '09:05');
assert.strictEqual(et.etParts(new Date('2026-11-03T15:05:00Z')).et, '10:05');
assertCronSkippedByGuard('trigger-picks-omega', '2026-11-03T14:05:00Z');
assertFire('trigger-picks-omega', '2026-11-03T15:05:00Z', '10:05');
assertFire('trigger-picks-omega', '2026-11-01T15:05:00Z', '10:05');
assertCronSkippedByGuard('trigger-picks-omega', '2026-11-01T14:05:00Z');

assertFire('capture-omega-pinnacle-lines', '2026-11-03T08:00:00Z', '03:00');
assertFire('capture-omega-pinnacle-lines', '2026-11-03T15:00:00Z', '10:00');
assertCronSkippedByGuard('capture-omega-pinnacle-lines', '2026-11-03T07:00:00Z');
assertCronSkippedByGuard('capture-omega-pinnacle-lines', '2026-11-03T14:00:00Z');

assertFire('monitor-omega-missed-pull', '2026-11-03T08:15:00Z', '03:15');
assertCronSkippedByGuard('monitor-omega-missed-pull', '2026-11-03T07:15:00Z');

function wallMin(name) {
  const slot = et.ET_SCHEDULE[name].etTimes[0];
  const [h, m] = slot.split(':').map(Number);
  return h * 60 + m;
}

const build = wallMin('trigger-picks-omega');
const rerank = wallMin('rerank-picks-omega');
const verify = wallMin('verify-picks-omega');
const narrate = wallMin('narrate-card-omega');
const post = wallMin('post-card-omega');
assert.ok(build < rerank, 'build before rerank');
assert.ok(rerank < verify, 'rerank before verify');
assert.ok(verify < narrate, 'verify before narrate');
assert.ok(narrate < post, 'narrate before post');
assert.strictEqual(et.ET_SCHEDULE['capture-omega-pm-observer'].etTimes[0], '10:15');
assert.strictEqual(et.ET_SCHEDULE['monitor-omega-snapshot-coverage'].etTimes[0], '10:20');
assert.ok(wallMin('capture-omega-pm-observer') > build);
assert.ok(wallMin('monitor-omega-snapshot-coverage') > build);
assert.strictEqual(cronOf('rerank-picks-omega'), '15 14,15 * * *');
assert.strictEqual(cronOf('verify-picks-omega'), '30 14,15 * * *');
assert.strictEqual(cronOf('narrate-card-omega'), '45 14,15 * * *');
assert.strictEqual(cronOf('post-card-omega'), '0 15,16 * * *');
assert.strictEqual(cronOf('capture-omega-pm-observer'), '15 14,15 * * *');
assert.strictEqual(cronOf('monitor-omega-snapshot-coverage'), '20 14,15 * * *');

const gapMs = (rerank - build) * 60 * 1000;
assert.strictEqual(gate.DEFAULT_MAX_WAIT_MS, 240000);
assert.ok(gate.DEFAULT_MAX_WAIT_MS + 60000 < 10 * 60 * 1000, 'max wait plus 60s slack is under 10 min');
assert.ok(gate.DEFAULT_MAX_WAIT_MS + 60000 < gapMs, 'wait budget finishes before the 10:15 rerank');

const triggerSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/trigger-picks-omega.js'), 'utf8');
assert.ok(triggerSrc.includes('10:05'));
assert.ok(!/^\/\/ Scheduled — 9:30/m.test(triggerSrc));

console.log('PASS test-omega-pipeline-1015-schedule');
