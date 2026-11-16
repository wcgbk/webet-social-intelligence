'use strict';

/**
 * OMEGA_NFL_QB_ADJ restores the pre-2026-10-18 QB_MARGIN_SCALE of 1.
 * Flag off stays 0, which is the lock. v2 bet probability does not use
 * this scale while OMEGA_V2_MARKET_P is on. Late-news backupQbDelta does
 * not read the scale.
 */

const assert = require('assert');
const gd = require('./netlify/functions/lib/omega-vnext/sports/game_day');
const { qbMarginScale, QB_MARGIN_SCALE, QB_MARGIN_SCALE_ON } = require('./netlify/functions/lib/omega-vnext/config');
const { forcedBetProb } = require('./netlify/functions/lib/omega-v2/select');

const saved = process.env.OMEGA_NFL_QB_ADJ;

function restore() {
  if (saved == null) delete process.env.OMEGA_NFL_QB_ADJ;
  else process.env.OMEGA_NFL_QB_ADJ = saved;
}

function set(value) {
  if (value == null) delete process.env.OMEGA_NFL_QB_ADJ;
  else process.env.OMEGA_NFL_QB_ADJ = value;
}

delete process.env.OMEGA_NFL_QB_ADJ;
assert.strictEqual(QB_MARGIN_SCALE, 0, 'exported constant stays the lock value');
assert.strictEqual(QB_MARGIN_SCALE_ON, 1, 'historical scale is 1');
assert.strictEqual(qbMarginScale(), 0);
assert.strictEqual(qbMarginScale({}), 0);
for (const off of ['', '  ', 'off', '0', 'false']) {
  assert.strictEqual(qbMarginScale({ OMEGA_NFL_QB_ADJ: off }), 0, `off ${JSON.stringify(off)}`);
}
for (const on of ['on', '1', 'true', 'yes']) {
  assert.strictEqual(qbMarginScale({ OMEGA_NFL_QB_ADJ: on }), 1, `on ${on}`);
}
assert.strictEqual(qbMarginScale({ OMEGA_NFL_QB_ADJ: 'no' }), 0);

set(null);
const locked = gd.qbSoftAdjust('NFL', { qbStatus: 'out', qbName: 'A' }, null);
assert.strictEqual(locked.marginAdj, 0);
assert.strictEqual(locked.totalAdj, 0);
assert.strictEqual(locked.uncBump, 0);
assert.ok(locked.note && /QB/.test(locked.note), 'status note survives at scale 0');

set('on');
const homeOut = gd.qbSoftAdjust('NFL', { qbStatus: 'out', qbName: 'A' }, null);
assert.strictEqual(homeOut.marginAdj, -3);
assert.strictEqual(homeOut.totalAdj, -1.5);
assert.ok(Math.abs(homeOut.uncBump - 0.04) < 1e-9);

const awayOut = gd.qbSoftAdjust('NFL', null, { qbStatus: 'out', qbName: 'B' });
assert.strictEqual(awayOut.marginAdj, 3);
assert.strictEqual(awayOut.totalAdj, -1.5);

const doubtful = gd.qbSoftAdjust('NFL', { qbStatus: 'doubtful', qbName: 'C' }, null);
assert.ok(Math.abs(doubtful.marginAdj - (-3 * 0.75)) < 1e-9, `doubtful margin ${doubtful.marginAdj}`);
assert.ok(Math.abs(doubtful.totalAdj - (-1.5 * 0.75)) < 1e-9, `doubtful total ${doubtful.totalAdj}`);

const cfb = gd.qbSoftAdjust('NCAAF', { qbStatus: 'out', qbName: 'D' }, null);
assert.strictEqual(cfb.marginAdj, -3.5);
assert.strictEqual(cfb.totalAdj, -2);

const qOn = gd.qbSoftAdjust('NFL', { qbStatus: 'questionable', qbName: 'E' }, null);
assert.strictEqual(qOn.marginAdj, 0);
assert.ok(Math.abs(qOn.uncBump - 0.025) < 1e-9);

set('off');
const backOff = gd.qbSoftAdjust('NFL', { qbStatus: 'out', qbName: 'A' }, null);
assert.strictEqual(backOff.marginAdj, 0);
assert.strictEqual(backOff.totalAdj, 0);
assert.strictEqual(backOff.uncBump, 0);
const qOff = gd.qbSoftAdjust('NFL', { qbStatus: 'questionable', qbName: 'E' }, null);
assert.strictEqual(qOff.uncBump, 0);
assert.ok(qOff.note);

const ctx = { force: true };
set('off');
const deltaOff = gd.backupQbDelta({ qbStatus: 'out', qbName: 'Someone' }, 'NFL', null, ctx);
set('on');
const deltaOn = gd.backupQbDelta({ qbStatus: 'out', qbName: 'Someone' }, 'NFL', null, ctx);
assert.deepStrictEqual(deltaOn, deltaOff, 'late-news backupQbDelta ignores the scale');
assert.strictEqual(deltaOn.marginPts, 3);
assert.strictEqual(deltaOn.totalPts, -1.5);

const pBet = forcedBetProb(0.62, 0.55, {
  env: { OMEGA_V2_MARKET_P: 'on', OMEGA_V2_LONGSHOT_ADJ: 'off', OMEGA_NFL_QB_ADJ: 'on' },
});
assert.strictEqual(pBet, 0.55, 'v2 p stays the market price when MARKET_P is on');

set('on');
const moved = gd.applyGameDayAdjustments({
  sport: 'NFL',
  modelMargin: 3,
  modelTotal: 45,
  uncertainty: 0.13,
  home: 'Buffalo Bills',
  away: 'Miami Dolphins',
  restByTeam: {},
  qbByTeam: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh Allen' } },
  hfaBase: 2.4,
});
assert.ok(Math.abs(moved.modelMargin - 0) < 1e-9, `home out moves margin by -3: ${moved.modelMargin}`);
assert.ok(Math.abs(moved.modelTotal - 43.5) < 1e-9, `total ${moved.modelTotal}`);
set('off');
const still = gd.applyGameDayAdjustments({
  sport: 'NFL',
  modelMargin: 3,
  modelTotal: 45,
  uncertainty: 0.13,
  home: 'Buffalo Bills',
  away: 'Miami Dolphins',
  restByTeam: {},
  qbByTeam: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh Allen' } },
  hfaBase: 2.4,
});
assert.ok(Math.abs(still.modelMargin - 3) < 1e-9);
assert.ok(Math.abs(still.modelTotal - 45) < 1e-9);

restore();
console.log('PASS nfl qb margin scale');
