'use strict';

/**
 * replay.js must price bets from stored DraftKings or Hard Rock quotes,
 * or say so when those quotes are absent. A silent 0 is a failure.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { replayStatusLines } = require('./tools/omega-v2/replay');

const root = __dirname;
const PLACEABLE = new Set(['draftkings', 'hardrockbet']);

const none = replayStatusLines({ quotedRows: 0, candidateRows: 4, status: 'insufficient' });
assert.deepStrictEqual(none, ['no stored DK/HR quotes']);
const some = replayStatusLines({
  quotedRows: 2,
  candidateRows: 4,
  sufficient: false,
  primaryReplay: 'tools/omega-v2/replay-bp1104.js',
});
assert.ok(some[0].includes('stored DK/HR quotes: 2 of 4'));
assert.ok(!some.join('\n').includes('no stored DK/HR quotes'));

const run = spawnSync(process.execPath, [path.join(root, 'tools/omega-v2/replay.js')], {
  cwd: root,
  encoding: 'utf8',
  timeout: 300000,
});
const stdout = run.stdout || '';
const stderr = run.stderr || '';
if (run.status !== 0) {
  console.error(stdout.slice(-4000));
  console.error(stderr.slice(-4000));
  throw new Error(`replay.js exited ${run.status}`);
}

const noQuotes = stdout.includes('no stored DK/HR quotes');
const jsonAt = stdout.indexOf('{');
assert.ok(jsonAt >= 0, 'replay.js did not print a JSON summary');
const summary = JSON.parse(stdout.slice(jsonAt));
const quoted = summary && summary.dkhr && summary.dkhr.quotedRows;
const bets = summary && summary.v2 && summary.v2.bets;
const md = fs.readFileSync(path.join(root, 'REPLAY-V2.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'tools/omega-v2/README.md'), 'utf8');

assert.ok(!/\bAlpha\b/.test(readme), 'readme uses a product name');
assert.ok(!/\bOmega\b/.test(readme), 'readme uses a product name');
assert.ok(readme.includes('tools/omega-v2/replay-bp1104.js'));
assert.ok(readme.includes('no stored DK/HR quotes'));

if (noQuotes) {
  assert.strictEqual(quoted, 0, 'status says no quotes while quotedRows is set');
  assert.strictEqual(summary.dkhr.status, 'no stored DK/HR quotes');
  assert.ok(md.includes('no stored DK/HR quotes'));
} else {
  assert.ok(quoted > 0, 'missing stored DK/HR quote count');
  assert.ok(bets > 0, 'silent 0');
  assert.strictEqual(summary.dkhr.realQuotes, true);
  assert.ok(md.includes('tools/omega-v2/replay-bp1104.js'));
  assert.ok(md.includes(`${quoted} of ${summary.dkhr.candidateRows}`));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'REPLAY-V2.json'), 'utf8'));
  const straights = (report.v2Bets || []).filter((bet) => bet.kind === 'straight');
  assert.ok(straights.length > 0, 'no straight bets from stored quotes');
  for (const bet of straights) {
    assert.ok(PLACEABLE.has(bet.book), `straight book ${bet.book}`);
    assert.ok(bet.dkHrSource, 'straight is missing its quote source');
  }
}

console.log(`PASS replay dkhr gate quotes=${quoted} bets=${bets} status=${noQuotes ? 'no stored DK/HR quotes' : summary.dkhr.status}`);
