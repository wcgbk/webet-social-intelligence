'use strict';
// CLV-ETDATE-LOCALE. 23:30 ET must stay on that ET calendar date when the
// process zone is America/Los_Angeles or UTC.
const assert = require('assert');
const { spawnSync } = require('child_process');

const script = `
const assert = require('assert');
const { etDate } = require('./netlify/functions/track-clv-omega')._test;
// 23:30 ET on 2026-10-09 (EDT, UTC-4) is 2026-10-10T03:30:00Z.
assert.strictEqual(etDate('2026-10-10T03:30:00Z'), '2026-10-09');
// 00:30 ET on 2026-10-10 is 2026-10-10T04:30:00Z.
assert.strictEqual(etDate('2026-10-10T04:30:00Z'), '2026-10-10');
assert.strictEqual(etDate('not-a-date'), null);
console.log('ok ' + process.env.TZ);
`;

for (const tz of ['America/Los_Angeles', 'UTC']) {
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    process.exit(run.status || 1);
  }
  assert.ok(run.stdout.indexOf('ok ' + tz) !== -1, tz);
}

console.log('test-omega-et-date: ok');
