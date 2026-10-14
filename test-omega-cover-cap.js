'use strict';

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const select = require('./netlify/functions/lib/omega-vnext/select');

assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.4.0-webetai-pure:'));
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);

function pick(extra) {
  return select.toPickObject({
    sport: 'NFL',
    matchup: 'A @ B',
    homeTeam: 'B',
    awayTeam: 'A',
    side: 'A +3',
    market: 'Spread',
    odds: 300,
    ev: 0.08,
    edgePct: 0.04,
    uncertainty: 0.12,
    line: 3,
    ...extra,
  }, { perPickCap: 3.5 });
}

const low = pick({ coverProb: 0.41 });
assert.strictEqual(low.tier, 'floor');
assert.strictEqual(low.rating, 'a');
assert.strictEqual(low.units, '1u');

const mid = pick({ coverProb: 0.45 });
assert.strictEqual(mid.units, '1u');

const clear = pick({ coverProb: 0.55 });
assert.strictEqual(clear.rating, 'a');
assert.strictEqual(clear.units, '1u');

const lean = pick({ coverProb: 0.30, tier: 'lean', edgePct: 0.02, ev: 0.02 });
assert.strictEqual(lean.tier, 'lean');
assert.strictEqual(lean.units, '0.5u');

console.log('test-omega-cover-cap ok');
