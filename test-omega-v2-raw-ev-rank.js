#!/usr/bin/env node
// OMEGA_V2_RAW_EV_RANK. +210 at pMkt 0.334 is +EV before the longshot haircut
// and -EV after it. Flag on ranks that raw EV ahead of a smaller +125.
// Flag off keeps the penalized price-EV pack. Stakes stay on pBet.
'use strict';

const assert = require('assert');
const { annotateCandidate, selectForcedTop3 } = require('./netlify/functions/lib/omega-v2/select');
const { rawEvRankEnabled, RAW_EV_RANK_DEFAULT_ON } = require('./netlify/functions/lib/omega-v2/constants');

const AS_OF = Date.parse('2026-11-21T15:05:00Z');
const COMMENCE = '2026-11-21T23:00:00Z';

function baseEnv(over) {
  return Object.assign({
    OMEGA_V2_FORCE_TOP3: 'on',
    OMEGA_V2_BLEND_P: 'on',
    OMEGA_V2_BLEND_TRIM: 'on',
    OMEGA_V2_MARKET_P: 'on',
    OMEGA_V2_LONGSHOT_ADJ: 'on',
    OMEGA_V2_EV_FIRST: 'off',
    OMEGA_V2_EV_FIRST_CAPPED: 'on',
    OMEGA_V2_FAV_CAP: 'on',
    OMEGA_V2_P_FLOOR: 'on',
  }, over);
}

function row(spec, env) {
  return annotateCandidate({
    sport: 'NCAAM',
    matchup: spec.matchup,
    pick: spec.pick,
    market: 'Moneyline',
    odds: spec.odds,
    book: 'hardrockbet',
    gameKey: spec.matchup.toLowerCase(),
    commenceTime: COMMENCE,
    calibration: {
      pCal: spec.pMkt,
      pMkt: spec.pMkt,
      pModel: spec.pMkt,
      method: 'board',
    },
  }, { env, pregameAsOfMs: AS_OF, cardDate: '2026-11-21' });
}

function card(env) {
  const peter = row({
    matchup: "Stony Brook Seawolves @ Saint Peter's Peacocks",
    pick: "Saint Peter's Peacocks",
    odds: 210,
    pMkt: 0.33358479442589123,
  }, env);
  const wichita = row({
    matchup: 'New Mexico Lobos @ Wichita State Shockers',
    pick: 'Wichita State Shockers',
    odds: 125,
    pMkt: 0.4503385496755094,
  }, env);
  assert.strictEqual(peter.qualified, true, peter.rejectReason);
  assert.strictEqual(wichita.qualified, true, wichita.rejectReason);
  assert.ok(peter.ev < 0, `penalized EV should be negative, got ${peter.ev}`);
  assert.ok(wichita.ev > 0, `Wichita price EV should stay positive, got ${wichita.ev}`);
  const rawPeter = peter.pPinnacle * peter.decimal - 1;
  const rawWichita = wichita.pPinnacle * wichita.decimal - 1;
  assert.ok(rawPeter > rawWichita, `raw EV ${rawPeter} should beat ${rawWichita}`);
  assert.ok(Math.abs(rawPeter - 0.03411) < 0.001, rawPeter);
  const picks = selectForcedTop3([peter, wichita], {
    pregameAsOfMs: AS_OF,
    cardDate: '2026-11-21',
    env,
  });
  return picks.map((item) => item.pick);
}

assert.strictEqual(RAW_EV_RANK_DEFAULT_ON, false);
assert.strictEqual(rawEvRankEnabled({}), false);
assert.strictEqual(rawEvRankEnabled({ OMEGA_V2_RAW_EV_RANK: 'off' }), false);
assert.strictEqual(rawEvRankEnabled({ OMEGA_V2_RAW_EV_RANK: 'on' }), true);
assert.strictEqual(rawEvRankEnabled({ OMEGA_V2_RAW_EV_RANK: '' }), false);

const off = card(baseEnv({ OMEGA_V2_RAW_EV_RANK: 'off' }));
assert.deepStrictEqual(off, ['Wichita State Shockers', "Saint Peter's Peacocks"]);

const on = card(baseEnv({ OMEGA_V2_RAW_EV_RANK: 'on' }));
assert.deepStrictEqual(on, ["Saint Peter's Peacocks", 'Wichita State Shockers']);

console.log('test-omega-v2-raw-ev-rank: ALL PASS');
