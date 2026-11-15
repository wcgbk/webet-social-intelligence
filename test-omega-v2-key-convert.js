'use strict';

const assert = require('assert');
const {
  convertCoverProb, pushAwareEv, pushProb, conversionAllowed,
} = require('./netlify/functions/lib/omega-v2/key_convert');

function shift(over) {
  return convertCoverProb(over);
}

const up = shift({ sport: 'NFL', market: 'Spread', p: 0.50, fromPoint: 3, toPoint: 3.5, side: 'spread' });
assert.ok(up);
assert.ok(Math.abs(up.p - 0.545) < 1e-12, up.p);
assert.strictEqual(up.q, 0);

const down = shift({ sport: 'NFL', market: 'Spread', p: 0.545, fromPoint: 3.5, toPoint: 3, side: 'spread' });
assert.ok(Math.abs(down.p - 0.50) < 1e-12, down.p);
assert.strictEqual(down.q, 0.090);

const jets = shift({ sport: 'NFL', market: 'Spread', p: 0.52, fromPoint: 8.5, toPoint: 8, side: 'spread' });
assert.ok(Math.abs(jets.p - (0.52 - 0.0075)) < 1e-12, jets.p);
assert.strictEqual(jets.q, pushProb('NFL', 'Spread', 8));

const twoSteps = shift({ sport: 'NFL', market: 'Spread', p: 0.40, fromPoint: 2.5, toPoint: 3.5, side: 'spread' });
assert.ok(Math.abs(twoSteps.p - 0.49) < 1e-12, twoSteps.p);

assert.strictEqual(shift({ sport: 'NFL', market: 'Spread', p: 0.5, fromPoint: 3, toPoint: 5, side: 'spread' }), null);
const oneAndHalf = shift({ sport: 'NFL', market: 'Spread', p: 0.5, fromPoint: 3, toPoint: 4.5, side: 'spread' });
assert.ok(oneAndHalf && oneAndHalf.distance === 1.5);

assert.strictEqual(shift({ sport: 'NHL', market: 'Spread', p: 0.5, fromPoint: 1.5, toPoint: 1.5, side: 'spread' }).p, 0.5);
assert.strictEqual(shift({ sport: 'NHL', market: 'Spread', p: 0.5, fromPoint: 1.5, toPoint: 2, side: 'spread' }), null);
assert.strictEqual(conversionAllowed('MLB', 'Total'), false);

const nba = shift({ sport: 'NBA', market: 'Spread', p: 0.50, fromPoint: -4.5, toPoint: -4, side: 'spread' });
assert.ok(Math.abs(nba.p - 0.515) < 1e-12, nba.p);

const ncaaf = shift({ sport: 'NCAAF', market: 'Spread', p: 0.50, fromPoint: 3, toPoint: 3.5, side: 'spread' });
assert.ok(Math.abs(ncaaf.p - 0.53) < 1e-12, ncaaf.p);

const over = shift({ sport: 'NFL', market: 'Total', p: 0.50, fromPoint: 44, toPoint: 44.5, side: 'over' });
assert.ok(Math.abs(over.p - (0.50 - 0.0125)) < 1e-12, over.p);

const same = shift({ sport: 'NFL', market: 'Spread', p: 0.51, fromPoint: -3.5, toPoint: -3.5, side: 'spread' });
assert.strictEqual(same.p, 0.51);
assert.strictEqual(same.q, 0);

const dec = 1 + 100 / 110;
const plain = 0.54 * dec - 1;
assert.strictEqual(pushAwareEv(0.54, dec, 0), plain);
const pushed = pushAwareEv(0.54, dec, 0.09);
assert.ok(Math.abs(pushed - (1 - 0.09) * plain) < 1e-12);
assert.ok(pushed > 0 && pushed < plain);

console.log('PASS key convert');
