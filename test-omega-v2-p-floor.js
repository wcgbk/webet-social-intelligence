'use strict';

/**
 * OMEGA_V2_P_FLOOR. Default on.
 * After the longshot trim, a bet probability is clamped to [0.01, 0.99].
 * off / 0 / false / no keeps [0.001, 0.999]. A blank value stays on.
 * Non-finite stays null. The same clamp covers forcedBetProb, the blend
 * pin, blendProb, and the post-trim move shrink.
 */

const assert = require('assert');
const { blendProb } = require('./netlify/functions/lib/omega-v2/blend');
const {
  pFloorEnabled, P_FLOOR_LO, P_FLOOR_HI, clampWinProb,
} = require('./netlify/functions/lib/omega-v2/constants');
const {
  annotateCandidate, forcedBetProb, smoothedNovigStats,
} = require('./netlify/functions/lib/omega-v2/select');

const AS_OF = Date.parse('2026-11-16T15:00:00Z');
const COMMENCE = '2026-11-17T00:00:00Z';

function baseEnv(over) {
  return {
    OMEGA_V2_FORCE_TOP3: 'on',
    OMEGA_V2_MARKET_P: 'on',
    OMEGA_V2_LONGSHOT_ADJ: 'on',
    OMEGA_V2_BLEND_P: 'on',
    OMEGA_V2_BLEND_TRIM: 'on',
    OMEGA_V2_P_FLOOR: 'on',
    ...(over || {}),
  };
}

function row(over) {
  return {
    sport: over.sport || 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: over.market || 'Moneyline',
    odds: over.odds,
    book: 'draftkings',
    gameKey: String(over.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    calibration: over.calibration,
  };
}

function annotate(over, env) {
  return annotateCandidate(row(over), {
    pregameAsOfMs: AS_OF,
    forceTop3: true,
    env,
  });
}

function close(a, b, label) {
  assert.ok(Math.abs(a - b) < 1e-12, `${label}: ${a} vs ${b}`);
}

function main() {
  assert.strictEqual(P_FLOOR_LO, 0.01);
  assert.strictEqual(P_FLOOR_HI, 0.99);
  assert.strictEqual(pFloorEnabled({}), true);
  assert.strictEqual(pFloorEnabled({ OMEGA_V2_P_FLOOR: '' }), true);
  for (const off of ['off', '0', 'false', 'no']) {
    assert.strictEqual(pFloorEnabled({ OMEGA_V2_P_FLOOR: off }), false, off);
  }
  assert.strictEqual(pFloorEnabled({ OMEGA_V2_P_FLOOR: 'on' }), true);

  const penalty = smoothedNovigStats(0.02).penalty;
  assert.ok(penalty > 0.02, `penalty ${penalty} should exceed p 0.02`);
  const onEnv = baseEnv();
  const offEnv = baseEnv({ OMEGA_V2_P_FLOOR: 'off' });
  const blendOff = baseEnv({ OMEGA_V2_BLEND_P: 'off' });
  const blendAndFloorOff = baseEnv({ OMEGA_V2_BLEND_P: 'off', OMEGA_V2_P_FLOOR: 'off' });

  assert.strictEqual(forcedBetProb(0.04, 0.02, { env: onEnv }), 0.01);
  assert.strictEqual(forcedBetProb(0.04, 0.02, { env: offEnv }), 0.001);
  assert.strictEqual(forcedBetProb(0.995, 0.995, { env: onEnv }), 0.99);
  assert.strictEqual(forcedBetProb(0.995, 0.995, { env: offEnv }), 0.995);
  const normal = 0.55;
  assert.strictEqual(smoothedNovigStats(normal).penalty, 0);
  assert.strictEqual(forcedBetProb(0.60, normal, { env: onEnv }), normal);
  assert.strictEqual(forcedBetProb(0.60, normal, { env: offEnv }), normal);
  // Market p is the base. A non-finite fair, after the trim, stays null.
  assert.strictEqual(forcedBetProb(0.5, NaN, { env: onEnv }), null);
  assert.strictEqual(forcedBetProb(0.5, Infinity, { env: offEnv }), null);
  assert.strictEqual(clampWinProb(Infinity, onEnv), null);
  assert.strictEqual(clampWinProb(null, offEnv), null);
  assert.strictEqual(clampWinProb(undefined, onEnv), null);

  const tinyOn = annotate({
    matchup: 'Tiny Away @ Tiny Home',
    pick: 'Tiny Dog',
    odds: 4900,
    calibration: { pCal: 0.04, pMkt: 0.02, pModel: 0.04 },
  }, onEnv);
  const tinyOff = annotate({
    matchup: 'Tiny Away @ Tiny Home',
    pick: 'Tiny Dog',
    odds: 4900,
    calibration: { pCal: 0.04, pMkt: 0.02, pModel: 0.04 },
  }, offEnv);
  assert.strictEqual(tinyOn.pBet, 0.01);
  assert.strictEqual(tinyOn.pBlend, 0.01);
  assert.strictEqual(tinyOff.pBet, 0.001);
  assert.strictEqual(tinyOff.pBlend, 0.001);

  const highOn = annotate({
    matchup: 'High Away @ High Home',
    pick: 'High Home',
    odds: -19900,
    calibration: { pCal: 0.995, pMkt: 0.995, pModel: 0.995 },
  }, onEnv);
  const highOff = annotate({
    matchup: 'High Away @ High Home',
    pick: 'High Home',
    odds: -19900,
    calibration: { pCal: 0.995, pMkt: 0.995, pModel: 0.995 },
  }, offEnv);
  assert.strictEqual(highOn.pBet, 0.99);
  assert.strictEqual(highOn.pBlend, 0.99);
  assert.strictEqual(highOff.pBet, 0.995);
  assert.strictEqual(highOff.pBlend, 0.995);

  const midOn = annotate({
    matchup: 'Mid Away @ Mid Home',
    pick: 'Mid Home',
    odds: -110,
    calibration: { pCal: 0.55, pMkt: 0.55, pModel: 0.55 },
  }, onEnv);
  const midOff = annotate({
    matchup: 'Mid Away @ Mid Home',
    pick: 'Mid Home',
    odds: -110,
    calibration: { pCal: 0.55, pMkt: 0.55, pModel: 0.55 },
  }, offEnv);
  close(midOn.pBet, 0.55, 'normal on');
  close(midOff.pBet, 0.55, 'normal off');
  assert.strictEqual(midOn.pBet, midOff.pBet);

  const forcedOn = annotate({
    matchup: 'Tiny Away @ Tiny Home',
    pick: 'Tiny Dog',
    odds: 4900,
    calibration: { pCal: 0.04, pMkt: 0.02, pModel: 0.04 },
  }, blendOff);
  const forcedOff = annotate({
    matchup: 'Tiny Away @ Tiny Home',
    pick: 'Tiny Dog',
    odds: 4900,
    calibration: { pCal: 0.04, pMkt: 0.02, pModel: 0.04 },
  }, blendAndFloorOff);
  assert.strictEqual(forcedOn.blendApplied, undefined);
  assert.strictEqual(forcedOn.pBet, 0.01);
  assert.strictEqual(forcedOff.pBet, 0.001);

  // unitProb drops a non-(0,1) pin. 0.005 is inside (0,1) and under the floor.
  assert.strictEqual(blendProb(0.005, null, 0, onEnv), 0.01);
  assert.strictEqual(blendProb(0.005, null, 0, offEnv), 0.005);
  assert.strictEqual(blendProb(0.995, 0.995, 0, onEnv), 0.99);
  assert.strictEqual(blendProb(0.995, 0.995, 0, offEnv), 0.995);
  assert.strictEqual(blendProb(0.55, 0.55, 0, onEnv), 0.55);
  assert.strictEqual(blendProb(0.55, 0.62, 1, onEnv), 0.62);
  assert.strictEqual(blendProb(0.9995, null, 0, onEnv), 0.99);
  assert.strictEqual(blendProb(0.9995, null, 0, offEnv), 0.999);
  assert.strictEqual(blendProb(0.4, 0.999, 1, onEnv), 0.99);
  assert.strictEqual(blendProb(NaN, 0.5, 0.2, onEnv), null);
  assert.strictEqual(blendProb(0.4, Infinity, 0.5, onEnv), null);

  console.log('PASS p floor');
}

main();
