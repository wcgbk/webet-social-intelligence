'use strict';

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { noVigTwoWay, deVigMarket, americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.56-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.56-omega-vnext-price-lock:'));
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);

function proportional(a1, a2) {
  const i1 = americanToImplied(a1);
  const i2 = americanToImplied(a2);
  const s = i1 + i2;
  return { p1: i1 / s, p2: i2 / s };
}

for (const pair of [[-110, -110], [-250, 210], [-250, -110], [210, -120], [-108, -112]]) {
  const got = noVigTwoWay(pair[0], pair[1]);
  const want = proportional(pair[0], pair[1]);
  assert.strictEqual(got.method, undefined, String(pair));
  assert.strictEqual(got.p1, want.p1);
  assert.strictEqual(got.p2, want.p2);
}

const heavy = noVigTwoWay(-400, 320);
const base = proportional(-400, 320);
assert.strictEqual(heavy.method, 'power');
assert.ok(Math.abs(heavy.p1 + heavy.p2 - 1) < 1e-9);
assert.ok(Math.abs(heavy.p1 - base.p1) > 1e-6);
assert.ok(heavy.p1 > base.p1);

const oneSide = noVigTwoWay(-251, -110);
assert.strictEqual(oneSide.method, 'power');
assert.ok(Math.abs(oneSide.p1 + oneSide.p2 - 1) < 1e-9);

const market = deVigMarket([
  { side: 'home', american: -400 },
  { side: 'away', american: 320 },
]);
assert.strictEqual(market[0].fairP, heavy.p1);
assert.strictEqual(market[1].fairP, heavy.p2);

const inside = deVigMarket([
  { side: 'home', american: -110 },
  { side: 'away', american: -110 },
]);
assert.strictEqual(inside[0].fairP, 0.5);
assert.strictEqual(inside[1].fairP, 0.5);

console.log('test-omega-power-devig ok');
