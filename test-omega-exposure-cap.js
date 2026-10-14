'use strict';

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const flags = require('./netlify/functions/lib/omega-vnext/gaps_flags');
const select = require('./netlify/functions/lib/omega-vnext/select');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.74-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.74-omega-vnext-price-lock:'));
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);
assert.strictEqual(config.PER_GAME_EXPOSURE_CAP_ENABLED, true);
assert.strictEqual(flags.GAME_EXPOSURE_CAP, 1.75);

const game = 'A @ B';
const ticket = {
  units: '0.5u',
  legs: [{ pick: 'Over 44', matchup: game, commenceTime: '2026-10-13T23:00:00Z' }],
};
const heavy = {
  pick: 'B -3', matchup: game, units: '2u', tier: 'floor', rating: 'aplus',
  qualityGrade: 'aplus', qualityScore: 0.06, commenceTime: '2026-10-13T23:00:00Z',
};
const lean = { ...heavy, pick: 'B +3', tier: 'lean', units: '2u' };

const prev = process.env.OMEGA_GAME_EXPOSURE;
delete process.env.OMEGA_GAME_EXPOSURE;
try {
  assert.strictEqual(flags.gameExposureEnabled(), true);
  const trimmed = select.capSameGameExposure([{ ...heavy }], [ticket]);
  assert.strictEqual(trimmed[0].units, '1.25u');
  assert.strictEqual(ticket.units, '0.5u');
  const kept = select.capSameGameExposure([{ ...lean }], [ticket]);
  assert.strictEqual(kept[0].units, '2u');
  assert.strictEqual(kept[0].tier, 'lean');
} finally {
  if (prev == null) delete process.env.OMEGA_GAME_EXPOSURE;
  else process.env.OMEGA_GAME_EXPOSURE = prev;
}

process.env.OMEGA_GAME_EXPOSURE = '0';
try {
  assert.strictEqual(flags.gameExposureEnabled(), false);
  const off = select.capSameGameExposure([{ ...heavy }], [ticket]);
  assert.strictEqual(off[0].units, '2u');
} finally {
  delete process.env.OMEGA_GAME_EXPOSURE;
}

console.log('test-omega-exposure-cap ok');
