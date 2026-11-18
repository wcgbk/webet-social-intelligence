#!/usr/bin/env node
// CLV is kept only for an exact line or a documented point adjustment.
'use strict';

const assert = require('assert');
const fs = require('fs');
const { applyToRecord, enforceLineMatch } = require('./netlify/functions/lib/clv-line-adj');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name);
    console.error(err && err.stack ? err.stack : err);
  }
}

function rec(over) {
  return Object.assign({
    clv: 0.04,
    clvCents: 4,
    beatClosing: true,
    closingLine: 1.5,
    betLine: -1.5,
  }, over);
}

check('exact spread line keeps CLV', () => {
  const out = enforceLineMatch(rec({ closingLine: -1.5, betLine: -1.5, clvMethod: 'same-line' }), {
    market: 'Spread', betLine: -1.5, closeLine: -1.5,
  }, {});
  assert.strictEqual(out.clv, 0.04);
  assert.strictEqual(out.clvReason, undefined);
});

check('opposite spread is a line mismatch', () => {
  const blind = rec({ clvMethod: undefined });
  delete blind.clvMethod;
  const out = enforceLineMatch(blind, { market: 'Spread', betLine: -1.5, closeLine: 1.5 }, {});
  assert.strictEqual(out.clv, null);
  assert.strictEqual(out.clvCents, null);
  assert.strictEqual(out.beatClosing, null);
  assert.strictEqual(out.clvReason, 'line-mismatch');
});

check('line-adj off still nulls a mismatched line when this flag is on', () => {
  const base = rec({ closingLine: 1.5 });
  const off = applyToRecord(base, {
    sport: 'NHL', market: 'Spread', betLine: -1.5, closeLine: 1.5, betOdds: -110,
  }, { OMEGA_CLV_LINE_ADJ: 'off' });
  assert.strictEqual(off, base);
  const out = enforceLineMatch(off, { market: 'Spread', betLine: -1.5, closeLine: 1.5 }, {});
  assert.strictEqual(out.clv, null);
  assert.strictEqual(out.clvReason, 'line-mismatch');
});

check('documented converted and alt-line adjustments stay', () => {
  const converted = enforceLineMatch(rec({
    clv: 0.01, clvCents: 1, beatClosing: true, clvMethod: 'converted', betLine: -3, closingLine: -2.5,
  }), { market: 'Spread', betLine: -3, closeLine: -2.5 }, {});
  assert.strictEqual(converted.clv, 0.01);
  assert.strictEqual(converted.clvMethod, 'converted');
  const alt = enforceLineMatch(rec({
    clv: 0.02, clvMethod: 'alt-line', betLine: 45.5, closingLine: 46,
  }), { market: 'Total', betLine: 45.5, closeLine: 46 }, {});
  assert.strictEqual(alt.clv, 0.02);
});

check('a side flip is not kept as an adjustment', () => {
  const flipped = applyToRecord(rec({ clv: 0.2, closingLine: 1.5 }), {
    sport: 'NHL', market: 'Spread', betLine: -1.5, closeLine: 1.5, betOdds: -110,
  }, {});
  assert.strictEqual(flipped.clv, null);
  assert.strictEqual(flipped.clvMethod, 'side-flip');
  const out = enforceLineMatch(flipped, { market: 'Spread', betLine: -1.5, closeLine: 1.5 }, {});
  assert.strictEqual(out.clv, null);
  assert.strictEqual(out.clvMethod, 'side-flip');
  assert.strictEqual(out.clvReason, 'line-mismatch');
});

check('flag off leaves the mismatched CLV', () => {
  const base = rec();
  const out = enforceLineMatch(base, { market: 'Spread', betLine: -1.5, closeLine: 1.5 }, { OMEGA_CLV_LINE_MATCH: 'off' });
  assert.strictEqual(out, base);
  assert.strictEqual(out.clv, 0.04);
});

check('moneyline with no line is unchanged', () => {
  const base = rec({ betLine: null, closingLine: null, clv: 0.03 });
  const out = enforceLineMatch(base, { market: 'Moneyline', betLine: null, closeLine: null }, {});
  assert.strictEqual(out.clv, 0.03);
});

check('tracker applies the check after the line adjustment', () => {
  const src = fs.readFileSync('netlify/functions/track-clv-omega.js', 'utf8');
  const adj = src.indexOf('rec = applyToRecord(rec, lineExtra, env);');
  const match = src.indexOf('rec = enforceLineMatch(rec, lineExtra, env);');
  assert.ok(adj > 0 && match > adj);
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('clv line match ok');
