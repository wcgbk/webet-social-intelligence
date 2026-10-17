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

// +300 quarter Kelly hits the 1.5u cap for every positive-EV cover here.
const low = pick({ coverProb: 0.41 });
assert.strictEqual(low.tier, 'floor');
assert.strictEqual(low.rating, 'a');
assert.strictEqual(low.units, '1.5u');

const mid = pick({ coverProb: 0.45 });
assert.strictEqual(mid.units, '1.5u');

const clear = pick({ coverProb: 0.55 });
assert.strictEqual(clear.rating, 'a');
assert.strictEqual(clear.units, '1.5u');

const lean = pick({ coverProb: 0.30, tier: 'lean', edgePct: 0.02, ev: 0.02 });
assert.strictEqual(lean.tier, 'lean');
assert.strictEqual(select.quarterKellyUnits(0.30, 300), 1.5);
assert.strictEqual(lean.units, '0.5u');

const dead = pick({ coverProb: 0.20, edgePct: 0.0, ev: -0.2 });
assert.strictEqual(dead.units, '0u');

console.log('test-omega-cover-cap ok');
