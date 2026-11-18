#!/usr/bin/env node
// OMEGA_CLV_LATEST_SAVED is off unless explicitly on. It reads saved rows only.
'use strict';

const assert = require('assert');
const { clvLatestSavedEnabled } = require('./netlify/functions/lib/default_on_flag');
const { chooseClose, latestSavedCutoffMs } = require('./netlify/functions/lib/clv-true-close');
const track = require('./netlify/functions/track-clv-omega')._test;

const api = {
  teamsMatch: track.teamsMatch,
  stripLine: track.stripLine,
  impliedProbability: track.impliedProbability,
};

function pair(side, opp, sidePrice, oppPrice, stamp, point) {
  const base = { book: 'pinnacle', line_type: 'closing', snapshot_ts: stamp, source: 'saved-board' };
  if (point == null) {
    return [
      Object.assign({ market: 'h2h', side, price: sidePrice }, base),
      Object.assign({ market: 'h2h', side: opp, price: oppPrice }, base),
    ];
  }
  return [
    Object.assign({ market: 'spreads', side, price: sidePrice, point }, base),
    Object.assign({ market: 'spreads', side: opp, price: oppPrice, point: -point }, base),
  ];
}

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

const ccsuGame = {
  game_id: 'ccsu',
  home_team: 'Central Connecticut St Blue Devils',
  away_team: 'Quinnipiac Bobcats',
  commence_time: '2026-11-15T18:00:00Z',
};
const ccsuPick = { pick: 'Central Connecticut St Blue Devils', market: 'Moneyline', betType: 'Moneyline' };
const ccsuSide = track.pickSideInfo(ccsuPick);
const ccsuRows = pair(
  'Central Connecticut St Blue Devils',
  'Quinnipiac Bobcats',
  155,
  -183,
  '2026-11-15T17:28:38Z'
);

check('flag stays off unless explicitly on', () => {
  assert.strictEqual(clvLatestSavedEnabled({}), false);
  assert.strictEqual(clvLatestSavedEnabled({ OMEGA_CLV_LATEST_SAVED: '' }), false);
  assert.strictEqual(clvLatestSavedEnabled({ OMEGA_CLV_LATEST_SAVED: 'off' }), false);
  assert.strictEqual(clvLatestSavedEnabled({ OMEGA_CLV_LATEST_SAVED: 'on' }), true);
});

check('10:20 ET cutoff is after the 10 AM pull', () => {
  assert.strictEqual(new Date(latestSavedCutoffMs(Date.parse('2026-11-15T18:00:00Z'))).toISOString(), '2026-11-15T15:20:00.000Z');
  assert.strictEqual(new Date(latestSavedCutoffMs(Date.parse('2026-11-17T03:00:00Z'))).toISOString(), '2026-11-16T15:20:00.000Z');
});

check('flag off ignores a saved line outside the close window', () => {
  const out = chooseClose(ccsuRows, ccsuPick, ccsuGame, ccsuSide, null, api, {});
  assert.strictEqual(out.close, null);
  assert.strictEqual(out.reason, 'no pinnacle closing snapshot in the close window');
  assert.strictEqual(out.latestSaved, undefined);
});

check('flag on uses the latest saved Pinnacle price before commence', () => {
  const later = pair(
    'Central Connecticut St Blue Devils',
    'Quinnipiac Bobcats',
    160,
    -190,
    '2026-11-15T17:40:00Z'
  );
  const out = chooseClose(ccsuRows.concat(later), ccsuPick, ccsuGame, ccsuSide, null, api, { OMEGA_CLV_LATEST_SAVED: 'on' });
  assert.ok(out.close);
  assert.strictEqual(out.close.sideOdds, 160);
  assert.strictEqual(out.close.oppOdds, -190);
  assert.strictEqual(out.latestSaved, '2026-11-15T17:40:00Z');
  assert.strictEqual(out.reason, null);
});

check('a 10 AM line alone is not a later saved close', () => {
  const game = {
    game_id: 'ucsd',
    home_team: 'UC San Diego Tritons',
    away_team: 'Texas Southern Tigers',
    commence_time: '2026-11-17T03:00:00Z',
  };
  const pick = { pick: 'UC San Diego Tritons -19.5', market: 'Spread', betType: 'Spread' };
  const side = track.pickSideInfo(pick);
  const rows = pair('UC San Diego Tritons', 'Texas Southern Tigers', -115, -103, '2026-11-16T15:00:45Z', -19.5);
  const out = chooseClose(rows, pick, game, side, -19.5, api, { OMEGA_CLV_LATEST_SAVED: 'on' });
  assert.strictEqual(out.close, null);
  assert.strictEqual(out.latestSaved, 'none');
});

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('clv latest saved ok');
