'use strict';

/**
 * OMEGA_V2_BLEND_P. Default on.
 * off / 0 / false / no keeps the trimmed Pinnacle probability, the Kelly
 * rank, and the edge letter. NCAAM weight is 0. C is confidence 45 and 0.25u.
 */

const assert = require('assert');
const { logit, logistic, blendProb, modelProbForBlend } = require('./netlify/functions/lib/omega-v2/blend');
const {
  blendPEnabled, blendWeightFor, blendTrimEnabled, BLEND_W, BLEND_W_CAP,
} = require('./netlify/functions/lib/omega-v2/constants');
const {
  annotateCandidate, selectForcedTop3, forcedBetProb,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights, quarterKellyFromDecimal } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick } = require('./netlify/functions/lib/omega-v2/guards');
const { letterFromEv, letterFromPrintedEdge, confidenceForLetter } = require('./netlify/functions/lib/omega-v2/letter');
const { ratingToConfidence } = require('./netlify/functions/lib/omega-vnext/odds_math');
const lock = require('./netlify/functions/lib/omega-vnext/card_lock');
const { fetchOddsMultiSport } = require('./netlify/functions/lib/omega-vnext/ingest');

const AS_OF = Date.parse('2026-11-16T15:00:00Z');
const COMMENCE = '2026-11-17T00:00:00Z';

function baseEnv(over) {
  return {
    OMEGA_V2_FORCE_TOP3: 'on',
    OMEGA_V2_MARKET_P: 'on',
    OMEGA_V2_LONGSHOT_ADJ: 'on',
    OMEGA_V2_BLEND_P: 'on',
    OMEGA_V2_BLEND_TRIM: 'on',
    ...(over || {}),
  };
}

function opts(env) {
  return { pregameAsOfMs: AS_OF, forceTop3: true, env };
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
  return annotateCandidate(row(over), opts(env || baseEnv()));
}

function close(a, b, label) {
  assert.ok(Math.abs(a - b) < 1e-12, `${label}: ${a} vs ${b}`);
}

async function main() {
  const pin = 0.4;
  const model = 0.62;
  const w = 0.25;
  const z = ((1 - w) * logit(pin)) + (w * logit(model));
  close(blendProb(pin, model, w), logistic(z), 'logit blend');
  close(blendProb(pin, model, 0), pin, 'w=0 is p_pin');
  close(blendProb(pin, model, 1), model, 'w=1 is p_model');
  assert.strictEqual(logit(0), null);
  assert.strictEqual(logit(1), null);
  assert.strictEqual(blendProb(0.4, null, 0.2), null);

  assert.strictEqual(blendPEnabled({}), true);
  assert.strictEqual(blendPEnabled({ OMEGA_V2_BLEND_P: '' }), true);
  for (const off of ['off', '0', 'false', 'no']) {
    assert.strictEqual(blendPEnabled({ OMEGA_V2_BLEND_P: off }), false, off);
  }
  assert.strictEqual(BLEND_W.NFL, 0);
  assert.strictEqual(BLEND_W.NHL, 0);
  assert.strictEqual(BLEND_W.NCAAF, 0);
  assert.strictEqual(BLEND_W.NBA, 0);
  assert.strictEqual(BLEND_W.NCAAM, 0);
  assert.strictEqual(BLEND_W.MLB, 0.05);
  assert.ok(BLEND_W_CAP <= 0.35);
  assert.strictEqual(blendWeightFor('NBA', {}), 0);
  assert.strictEqual(blendWeightFor('MLB', {}), 0.05);
  assert.strictEqual(blendWeightFor('NBA', { OMEGA_V2_BLEND_W_NBA: '0.2' }), 0.2);
  assert.strictEqual(blendWeightFor('NBA', { OMEGA_V2_BLEND_W_NBA: '0.9' }), 0.35);
  assert.strictEqual(blendWeightFor('NBA', { OMEGA_V2_BLEND_W_NBA: '0' }), 0);
  assert.strictEqual(blendWeightFor('NCAAM', {}), 0);
  assert.strictEqual(blendWeightFor('NCAAB', { OMEGA_V2_BLEND_W_NCAAM: '0.35' }), 0);
  assert.strictEqual(blendWeightFor('ncaam', { OMEGA_V2_BLEND_W_NCAAM: '0.2' }), 0);
  assert.strictEqual(blendTrimEnabled({}), true);
  assert.strictEqual(blendTrimEnabled({ OMEGA_V2_BLEND_TRIM: 'off' }), false);

  const ncaam = annotate({
    sport: 'NCAAM',
    matchup: 'Duke @ Kansas',
    pick: 'Duke ML',
    odds: -110,
    calibration: { pCal: 0.61, pMkt: 0.54, pModel: 0.7 },
  }, baseEnv({ OMEGA_V2_BLEND_W_NCAAM: '0.35' }));
  assert.strictEqual(ncaam.blendW, 0);
  assert.strictEqual(ncaam.pModelBlend, null);
  assert.strictEqual(modelProbForBlend(row({
    sport: 'NCAAM',
    matchup: 'Duke @ Kansas',
    pick: 'Duke ML',
    odds: -110,
    calibration: { pCal: 0.61, pMkt: 0.54, pModel: 0.7 },
  }), 0.54), null);
  close(ncaam.pBet, forcedBetProb(0.61, 0.54, { env: baseEnv() }), 'NCAAM p stays the trimmed fair');

  const blended = annotate({
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    pick: 'Buffalo Bills ML',
    odds: 100,
    calibration: { pCal: 0.62, pMkt: 0.55, pModel: 0.7 },
  }, baseEnv({ OMEGA_V2_BLEND_W_NFL: '0.25' }));
  const trimmed = forcedBetProb(0.62, 0.55, { env: baseEnv() });
  close(blended.pBet, blendProb(trimmed, 0.62, 0.25), 'NFL env weight');
  assert.strictEqual(blended.blendW, 0.25);
  close(blended.pPinnacle, 0.55, 'pinnacle fair before the trim');
  close(blended.breakeven, blended.implied, 'breakeven');
  close(blended.edge, blended.pBet - blended.breakeven, 'edge');
  close(blended.ev, (blended.pBet * blended.decimal) - 1, 'ev');
  const same = annotate({
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    pick: 'Buffalo Bills ML',
    odds: 100,
    calibration: { pCal: 0.55, pMkt: 0.55, pModel: 0.55 },
  }, baseEnv({ OMEGA_V2_BLEND_W_NFL: '0.25' }));
  assert.strictEqual(same.blendW, 0, 'model equal to the market does not blend');
  close(same.pBet, trimmed, 'equal model keeps p_pin');

  assert.strictEqual(letterFromEv(0.03), 'a');
  assert.strictEqual(letterFromEv(0.029), 'b');
  assert.strictEqual(letterFromEv(0.01), 'b');
  assert.strictEqual(letterFromEv(0.009), 'c');
  assert.strictEqual(letterFromEv(-0.04), 'c');
  assert.strictEqual(letterFromEv('3.0%'), 'a');
  assert.strictEqual(letterFromEv('1.0%'), 'b');
  assert.strictEqual(letterFromEv('0.9%'), 'c');
  assert.strictEqual(ratingToConfidence('a'), 82);
  assert.strictEqual(ratingToConfidence('b'), 60);
  assert.strictEqual(ratingToConfidence('c'), 60);
  assert.strictEqual(confidenceForLetter('a'), 82);
  assert.strictEqual(confidenceForLetter('b'), 60);
  assert.strictEqual(confidenceForLetter('c'), 45);
  assert.strictEqual(letterFromPrintedEdge(0.05), 'aplus');

  const priced = annotate({
    matchup: 'Price Away @ Price Home',
    pick: 'Price Home',
    odds: 100,
    calibration: { pCal: 0.6, pMkt: 0.55, pModel: 0.6 },
  });
  close(priced.ev, 0.1, 'priced ev');
  const sizedA = sizeForcedStraights([priced])[0];
  const kellyA = quarterKellyFromDecimal(priced.pBet, priced.decimal, 2, { floorToQuarter: true });
  assert.strictEqual(sizedA.units, Math.min(2, kellyA.units));
  assert.strictEqual(sizedA.units, 2);
  assert.strictEqual(sizedA.stakeUsd, 300);
  const pickA = toPick(sizedA);
  assert.strictEqual(pickA.rating, 'a');
  assert.strictEqual(pickA.grade, 'a');
  assert.strictEqual(pickA.confidence, 82);
  assert.strictEqual(pickA.winProbability, '55.0%');
  assert.strictEqual(pickA.ev, '10.0%');
  close(pickA.pBlend, priced.pBet, 'card pBlend');
  assert.strictEqual(pickA.pModel, 0.6);
  assert.strictEqual(pickA.stakeUsd, 300);

  const lean = annotate({
    matchup: 'Lean Away @ Lean Home',
    pick: 'Lean Home',
    odds: 100,
    calibration: { pCal: 0.504, pMkt: 0.504, pModel: 0.504 },
  });
  assert.ok(lean.ev < 0.01 && lean.ev > 0, lean.ev);
  const sizedC = sizeForcedStraights([lean])[0];
  assert.strictEqual(letterFromEv(lean.ev), 'c');
  assert.strictEqual(sizedC.units, 0.25);
  assert.strictEqual(sizedC.stakeUsd, 38);
  const pickC = toPick(sizedC);
  assert.strictEqual(pickC.rating, 'c');
  assert.strictEqual(pickC.confidence, 45);
  assert.strictEqual(pickC.units, '0.25u');

  const neg = [0, 1, 2, 3].map((i) => annotate({
    matchup: `Neg Away ${i} @ Neg Home ${i}`,
    pick: `Neg Away ${i} ML`,
    odds: -110,
    calibration: { pCal: 0.48, pMkt: 0.48, pModel: 0.48 },
  }));
  assert.ok(neg.every((item) => item.qualified && item.ev < 0));
  const top = selectForcedTop3(neg, opts(baseEnv()));
  assert.strictEqual(top.length, 3);
  const ticket = buildForcedParlay(sizeForcedStraights(top));
  assert.strictEqual(ticket.publish, true);
  assert.strictEqual(ticket.legs.length, 3);
  assert.ok(ticket.units >= 0.25 && ticket.units <= 1);
  assert.deepStrictEqual(ticket.legs.map((leg) => leg.pick).sort(), top.map((leg) => leg.pick).sort());

  const offEnv = baseEnv({ OMEGA_V2_BLEND_P: 'off' });
  const sample = {
    matchup: 'Off Away @ Off Home',
    pick: 'Off Home',
    odds: -110,
    calibration: { pCal: 0.62, pMkt: 0.58, pModel: 0.7 },
  };
  const offA = annotate(sample, offEnv);
  const offB = annotate(sample, offEnv);
  assert.strictEqual(offA.blendApplied, undefined);
  assert.strictEqual(offA.pBlend, undefined);
  close(offA.pBet, forcedBetProb(0.62, 0.58, { env: offEnv }), 'flag off pBet');
  assert.deepStrictEqual(
    { pBet: offA.pBet, edge: offA.edge, ev: offA.ev, rejectReason: offA.rejectReason },
    { pBet: offB.pBet, edge: offB.edge, ev: offB.ev, rejectReason: offB.rejectReason },
  );
  const offPick = toPick(sizeForcedStraights([offA])[0]);
  assert.strictEqual(offPick.blendApplied, undefined);
  assert.strictEqual(offPick.pBlend, undefined);
  assert.strictEqual(offPick.pPinnacle, undefined);
  assert.strictEqual(offPick.rating, 'aplus');
  assert.strictEqual(letterFromPrintedEdge(offA.edge), 'aplus');
  const onSame = annotate(sample, baseEnv());
  close(onSame.pBet, offA.pBet, 'fitted NFL weight 0 leaves p unchanged');
  assert.strictEqual(onSame.blendApplied, true);
  assert.notStrictEqual(toPick(sizeForcedStraights([onSame])[0]).rating, offPick.rating);

  const dog = {
    sport: 'NBA',
    matchup: 'Dog Away @ Dog Home',
    pick: 'Dog Away',
    market: 'Moneyline',
    odds: 200,
    book: 'draftkings',
    gameKey: 'dog away @ dog home',
    commenceTime: COMMENCE,
    calibration: { pCal: 0.4, pMkt: 0.4, pModel: 0.4 },
  };
  const fav = {
    sport: 'NBA',
    matchup: 'Fav Away @ Fav Home',
    pick: 'Fav Home',
    market: 'Moneyline',
    odds: -150,
    book: 'draftkings',
    gameKey: 'fav away @ fav home',
    commenceTime: COMMENCE,
    calibration: { pCal: 0.675, pMkt: 0.675, pModel: 0.675 },
  };
  const offOrder = selectForcedTop3(
    [annotateCandidate(dog, opts(offEnv)), annotateCandidate(fav, opts(offEnv))],
    opts(offEnv),
  ).map((item) => item.pick);
  const onOrder = selectForcedTop3(
    [annotateCandidate(dog, opts(baseEnv())), annotateCandidate(fav, opts(baseEnv()))],
    opts(baseEnv()),
  ).map((item) => item.pick);
  assert.deepStrictEqual(offOrder, ['Fav Home', 'Dog Away']);
  assert.deepStrictEqual(onOrder, ['Dog Away', 'Fav Home']);

  const now = Date.parse('2026-11-16T17:00:00Z');
  const fresh = {
    date: '2026-11-16',
    picks: [{
      pick: 'Over 220.5', sport: 'NBA', matchup: 'A @ B', betType: 'Total',
      odds: '-110', units: '0.25u', stakeUsd: 38,
    }],
    parlayLegs: [],
  };
  const oldSnap = {
    date: '2026-11-16',
    picks: [{
      pick: 'Old Side', sport: 'NBA', matchup: 'A @ B', betType: 'Total',
      odds: '-120', units: '0.25u', stakeUsd: 38,
    }],
    parlayLegs: [],
  };
  let deleted = null;
  let written = null;
  const passed = await lock.guardCardWrite('2026-11-16', fresh, {
    now,
    env: {},
    readSnapshot: async (key) => {
      if (key === lock.regenOnceKey('2026-11-16')) {
        return { allow: true, expiresAt: new Date(now + 20 * 60 * 1000).toISOString(), reason: 'blend regen' };
      }
      return oldSnap;
    },
    deleteSnapshot: async (key) => { deleted = key; },
    writeSnapshot: async (key, value) => { written = { key, value }; },
    readCurrent: async () => { throw new Error('current should stay unread'); },
  });
  assert.strictEqual(passed, fresh);
  assert.strictEqual(deleted, 'omega-card-lock/regen-once-2026-11-16');
  assert.strictEqual(written.key, 'omega-card-lock/picks-2026-11-16');
  assert.strictEqual(written.value.picks[0].pick, 'Over 220.5');
  const blocked = await lock.guardCardWrite('2026-11-16', fresh, {
    now,
    env: {},
    readSnapshot: async () => written.value,
    deleteSnapshot: async () => { throw new Error('no blob'); },
    writeSnapshot: async () => { throw new Error('no write'); },
    readCurrent: async () => { throw new Error('unread'); },
  });
  assert.strictEqual(blocked.picks[0].pick, 'Over 220.5');
  assert.notStrictEqual(blocked, fresh);

  const tooLong = await lock.guardCardWrite('2026-11-16', {
    date: '2026-11-16',
    picks: [{ pick: 'Late', sport: 'NBA', matchup: 'A @ B', betType: 'ML', odds: '+200', units: '1u' }],
    parlayLegs: [],
  }, {
    now,
    env: {},
    readSnapshot: async (key) => {
      if (key === lock.regenOnceKey('2026-11-16')) {
        return { allow: true, expiresAt: new Date(now + 31 * 60 * 1000).toISOString(), reason: 'too long' };
      }
      return oldSnap;
    },
    deleteSnapshot: async () => { throw new Error('must not delete'); },
    writeSnapshot: async () => { throw new Error('must not write'); },
  });
  assert.strictEqual(tooLong.picks[0].odds, '-120');

  const odds = await fetchOddsMultiSport('2026-11-16', { storedBoardOnly: true });
  assert.strictEqual(odds.snapshotNote, 'stored-board-only-missing');
  assert.deepStrictEqual(odds.bySport, {});
  const kept = await fetchOddsMultiSport('2026-11-16', {
    storedBoardOnly: true,
    storedOddsBySport: { NBA: [{ id: 'g1' }] },
  });
  assert.strictEqual(kept.snapshotNote, 'stored-odds-master-1000');
  assert.strictEqual(kept.bySport.NBA.length, 1);

  console.log('PASS test-omega-v2-blend-p');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
