'use strict';
/**
 * F5 / dog special-cases are NOT product logic in omega-vnext.
 * This file now asserts the live cutover + empty-OK gates.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const live = require('./netlify/functions/generate-picks-omega-background');
const { LEAN_PAD, MODEL_VERSION } = require('./netlify/functions/lib/omega-vnext/config');

assert.strictEqual(live.MODEL_VERSION, 'v12.1.0-omega-vnext-linemove');
assert.strictEqual(MODEL_VERSION, live.MODEL_VERSION);
assert.strictEqual(LEAN_PAD, false, 'empty card OK — no lean force-fill');
assert.ok(fs.existsSync(path.join(__dirname, 'archive/generate-picks-omega-legacy-v11.js')));
const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
assert.ok(/omega-vnext/.test(src));
assert.ok(!/Rockies/.test(src), 'no Rockies special cases in live wrapper');
console.log('PASS test-mlb-fade-f5-dogs (v12 cutover assertions)');
