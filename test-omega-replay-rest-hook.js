'use strict';
// Frozen replay hook loads rest when OMEGA_REST_SCHEDULE_DIR is set.
// Copies this worktree. Does not touch webet-social-intelligence or call Odds API.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = '/workspace/omega-replay-2w/hooks/apply-replay-hooks.js';
const rw = require('/workspace/omega-replay-2w/run-window');
const srcVnext = path.join(__dirname, 'netlify/functions/lib/omega-vnext');

const prev = process.env.OMEGA_REST_SCHEDULE_DIR;
delete process.env.OMEGA_REST_SCHEDULE_DIR;
assert.strictEqual(rw.ensureRestScheduleDir(), rw.DEFAULT_REST_SCHEDULE_DIR);
assert.ok(fs.existsSync(rw.DEFAULT_REST_SCHEDULE_DIR));
process.env.OMEGA_REST_SCHEDULE_DIR = '/tmp/custom-rest-not-used';
assert.strictEqual(rw.ensureRestScheduleDir(), '/tmp/custom-rest-not-used');
if (prev == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
else process.env.OMEGA_REST_SCHEDULE_DIR = prev;

function copyTree(dest) {
  fs.mkdirSync(path.join(dest, 'netlify/functions/lib'), { recursive: true });
  fs.cpSync(srcVnext, path.join(dest, 'netlify/functions/lib/omega-vnext'), { recursive: true });
}

function runHook(dest) {
  return spawnSync(process.execPath, [hook, dest], { encoding: 'utf8' });
}

const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-hook-keep-'));
copyTree(keep);
const kept = runHook(keep);
assert.strictEqual(kept.status, 0, kept.stderr || kept.stdout);
assert.ok(/already loads rest/.test(kept.stdout), kept.stdout);
const keptSrc = fs.readFileSync(path.join(keep, 'netlify/functions/lib/omega-vnext/ingest.js'), 'utf8');
assert.strictEqual(keptSrc.split('if (process.env.OMEGA_FROZEN_SNAP)').length - 1, 1);
assert.ok(keptSrc.includes('scheduleDir()'));
assert.ok(keptSrc.includes('loadFootballRestSchedules'));

function stripFrozen(src) {
  const start = src.indexOf('if (process.env.OMEGA_FROZEN_SNAP)');
  assert.ok(start > 0);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return src.slice(0, start) + src.slice(i);
}

const insert = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-hook-insert-'));
copyTree(insert);
const ingestPath = path.join(insert, 'netlify/functions/lib/omega-vnext/ingest.js');
const stripped = stripFrozen(fs.readFileSync(ingestPath, 'utf8'));
assert.ok(!stripped.includes('OMEGA_FROZEN_SNAP'));
fs.writeFileSync(ingestPath, stripped);
const inserted = runHook(insert);
assert.strictEqual(inserted.status, 0, inserted.stderr || inserted.stdout);
const outSrc = fs.readFileSync(ingestPath, 'utf8');
assert.ok(outSrc.includes('OMEGA_REST_SCHEDULE_DIR'));
assert.ok(outSrc.includes('loadFootballRestSchedules'));
assert.strictEqual(outSrc.split('if (process.env.OMEGA_FROZEN_SNAP)').length - 1, 1);
const check = spawnSync(process.execPath, ['--check', ingestPath], { encoding: 'utf8' });
assert.strictEqual(check.status, 0, check.stderr);

fs.rmSync(keep, { recursive: true, force: true });
fs.rmSync(insert, { recursive: true, force: true });

console.log('PASS test-omega-replay-rest-hook');
