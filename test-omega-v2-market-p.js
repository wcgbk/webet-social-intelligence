'use strict';

/**
 * Force-top3 bet probability is the sharp no-vig price minus the longshot
 * penalty. Prices shorter than -300 fill only when the in-band card is short.
 * Flag off keeps the calibrated probability and the unsplit rank.
 */

const assert = require('assert');
const {
  annotateCandidate, selectForcedTop3, smoothedNovigStats, forcedBetProb, kellyGrowth,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, recheckPrices } = require('./netlify/functions/lib/omega-v2/guards');
const { letterFromPrintedEdge } = require('./netlify/functions/lib/omega-v2/letter');
const {
  marketPEnabled, favCapEnabled, FAV_CAP_AMERICAN, forceTop3Enabled, longshotAdjEnabled,
} = require('./netlify/functions/lib/omega-v2/constants');

const AS_OF = Date.parse('2026-11-03T16:00:00Z');
const COMMENCE = '2026-11-04T00:00:00Z';
const PREGAME = { pregameAsOfMs: AS_OF };

const saved = {
  force: process.env.OMEGA_V2_FORCE_TOP3,
  adj: process.env.OMEGA_V2_LONGSHOT_ADJ,
  market: process.env.OMEGA_V2_MARKET_P,
  fav: process.env.OMEGA_V2_FAV_CAP,
};

function restore() {
  const put = (key, val) => {
    if (val == null) delete process.env[key];
    else process.env[key] = val;
  };
  put('OMEGA_V2_FORCE_TOP3', saved.force);
  put('OMEGA_V2_LONGSHOT_ADJ', saved.adj);
  put('OMEGA_V2_MARKET_P', saved.market);
  put('OMEGA_V2_FAV_CAP', saved.fav);
}

function raw(over) {
  return {
    sport: 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: 'Moneyline',
    odds: over.odds,
    book: 'draftkings',
    gameKey: String(over.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    calibration: over.calibration,
  };
}

function annotate(over) {
  return annotateCandidate(raw(over), PREGAME);
}

function band(name, i, odds, pMkt, pCal) {
  const model = pCal == null ? pMkt : pCal;
  return annotate({
    matchup: `Away ${i} @ Home ${i}`,
    pick: name,
    odds,
    calibration: { pCal: model, pMkt, pModel: model },
  });
}

async function main() {
  process.env.OMEGA_V2_FORCE_TOP3 = '1';
  process.env.OMEGA_V2_MARKET_P = '1';
  process.env.OMEGA_V2_FAV_CAP = '1';
  delete process.env.OMEGA_V2_LONGSHOT_ADJ;
  assert.strictEqual(forceTop3Enabled(), true);
  assert.strictEqual(marketPEnabled(), true);
  assert.strictEqual(favCapEnabled(), true);
  assert.strictEqual(longshotAdjEnabled(), true);
  assert.strictEqual(FAV_CAP_AMERICAN, -300);

  const dog = annotate({
    matchup: 'Dog Away @ Dog Home',
    pick: 'Dog Away',
    odds: 300,
    calibration: { pCal: 0.30, pMkt: 0.25, pModel: 0.30 },
  });
  const penalty = smoothedNovigStats(0.25).penalty;
  assert.ok(penalty > 0);
  assert.strictEqual(dog.rejectReason, null, dog.rejectReason);
  assert.ok(Math.abs(dog.pBet - (0.25 - penalty)) < 1e-12, `pBet ${dog.pBet}`);
  assert.ok(Math.abs(dog.edgeNovig - 0.05) < 1e-12);
  assert.strictEqual(dog.pModelCal, 0.30);
  assert.ok(Math.abs(forcedBetProb(0.30, 0.25) - dog.pBet) < 1e-12);

  const tiny = annotate({
    matchup: 'Tiny Away @ Tiny Home',
    pick: 'Tiny Dog',
    odds: 4900,
    calibration: { pCal: 0.04, pMkt: 0.02, pModel: 0.04 },
  });
  assert.strictEqual(tiny.rejectReason, null, tiny.rejectReason);
  assert.strictEqual(tiny.pBet, 0.001);
  assert.strictEqual(tiny.pModelCal, 0.04);

  process.env.OMEGA_V2_MARKET_P = 'off';
  assert.strictEqual(marketPEnabled(), false);
  const dogOff = annotate({
    matchup: 'Dog Away @ Dog Home',
    pick: 'Dog Away',
    odds: 300,
    calibration: { pCal: 0.30, pMkt: 0.25, pModel: 0.30 },
  });
  assert.strictEqual(dogOff.rejectReason, null, dogOff.rejectReason);
  assert.ok(Math.abs(dogOff.pBet - (0.30 - penalty)) < 1e-12, `off pBet ${dogOff.pBet}`);
  assert.ok(Math.abs(dogOff.edgeNovig - dog.edgeNovig) < 1e-12);
  assert.strictEqual(dogOff.pModelCal, 0.30);
  process.env.OMEGA_V2_MARKET_P = '0';
  assert.strictEqual(marketPEnabled(), false);
  process.env.OMEGA_V2_MARKET_P = 'false';
  assert.strictEqual(marketPEnabled(), false);
  delete process.env.OMEGA_V2_MARKET_P;
  assert.strictEqual(marketPEnabled(), true, 'market probability defaults on');
  process.env.OMEGA_V2_MARKET_P = '1';

  const priced = annotate({
    matchup: 'Price Away @ Price Home',
    pick: 'Price Home',
    odds: 100,
    calibration: { pCal: 0.60, pMkt: 0.55, pModel: 0.60 },
  });
  assert.strictEqual(priced.rejectReason, null, priced.rejectReason);
  assert.strictEqual(priced.pBet, 0.55);
  assert.strictEqual(priced.pModelCal, 0.60);
  assert.ok(Math.abs(priced.edgeNovig - 0.05) < 1e-12);
  assert.ok(Math.abs(priced.edge - 0.05) < 1e-12);
  assert.strictEqual(letterFromPrintedEdge(priced.edge), 'aplus');
  const sized = sizeForcedStraights([priced])[0];
  assert.strictEqual(sized.units, 2);
  assert.strictEqual(sized.stakeUsd, 300);
  const pick = toPick(sized);
  assert.strictEqual(pick.winProbability, '55.0%');
  assert.strictEqual(pick.coverProb, '55.0%');
  assert.strictEqual(pick.edgePct, '5.0%');
  assert.strictEqual(pick.ev, '10.0%');
  assert.strictEqual(pick.rating, 'aplus');
  assert.strictEqual(pick.grade, 'aplus');
  assert.strictEqual(pick.units, '2u');
  assert.strictEqual(pick.stakeUsd, 300);
  assert.strictEqual(pick.pCal, 0.60);
  assert.strictEqual(pick.pModelCal, 0.60);
  assert.ok(Math.abs(pick.pBet - 0.55) < 1e-12);
  const second = annotate({
    matchup: 'Other Away @ Other Home',
    pick: 'Other Home',
    odds: 100,
    calibration: { pCal: 0.62, pMkt: 0.55, pModel: 0.62 },
  });
  assert.strictEqual(second.pBet, 0.55);
  const ticket = buildForcedParlay(sizeForcedStraights([priced, second]));
  assert.strictEqual(ticket.publish, true);
  assert.ok(Math.abs(ticket.pJoint - (0.55 * 0.55)) < 1e-12, `pJoint ${ticket.pJoint}`);

  const in1 = band('In One', 1, -110, 0.55);
  const in2 = band('In Two', 2, -120, 0.56);
  const in3 = band('In Three', 3, 100, 0.52);
  const heavy = band('Heavy Six', 4, -600, 0.90);
  for (const row of [in1, in2, in3, heavy]) {
    assert.strictEqual(row.rejectReason, null, `${row.pick} ${row.rejectReason}`);
  }
  assert.ok(kellyGrowth(heavy.pBet, heavy.decimal) > kellyGrowth(in1.pBet, in1.decimal));
  const capped = selectForcedTop3([heavy, in1, in2, in3], PREGAME);
  assert.deepStrictEqual(capped.map((row) => row.pick).sort(), ['In One', 'In Three', 'In Two']);
  assert.ok(capped.every((row) => row.favCapFill !== true));

  process.env.OMEGA_V2_FAV_CAP = 'off';
  const uncapped = selectForcedTop3([heavy, in1, in2, in3], PREGAME);
  assert.strictEqual(uncapped[0].pick, 'Heavy Six');
  assert.ok(uncapped.every((row) => row.favCapFill !== true));
  process.env.OMEGA_V2_FAV_CAP = '0';
  assert.strictEqual(favCapEnabled(), false);
  process.env.OMEGA_V2_FAV_CAP = 'false';
  assert.strictEqual(favCapEnabled(), false);
  delete process.env.OMEGA_V2_FAV_CAP;
  assert.strictEqual(favCapEnabled(), true, 'favorite cap defaults on');
  process.env.OMEGA_V2_FAV_CAP = '1';

  const near = band('Near Fill', 5, -350, 0.80);
  const far = band('Far Fill', 6, -800, 0.92);
  assert.strictEqual(near.rejectReason, null, near.rejectReason);
  assert.strictEqual(far.rejectReason, null, far.rejectReason);
  assert.ok(near.ev > 0 && far.ev > 0);
  assert.ok(kellyGrowth(far.pBet, far.decimal) > kellyGrowth(near.pBet, near.decimal));
  const filled = selectForcedTop3([in1, in2, far, near], PREGAME);
  assert.strictEqual(filled.length, 3);
  const nearRow = filled.find((row) => row.pick === 'Near Fill');
  assert.ok(nearRow && nearRow.favCapFill === true);
  assert.ok(!filled.some((row) => row.pick === 'Far Fill'));
  assert.ok(filled.filter((row) => row.pick !== 'Near Fill').every((row) => row.favCapFill !== true));

  const negNear = band('Neg Near', 7, -310, 0.72);
  const posFar = band('Pos Far', 8, -900, 0.93);
  assert.strictEqual(negNear.rejectReason, null, negNear.rejectReason);
  assert.strictEqual(posFar.rejectReason, null, posFar.rejectReason);
  assert.ok(!(negNear.ev > 0));
  assert.ok(posFar.ev > 0);
  assert.ok(Math.abs(negNear.odds) < Math.abs(posFar.odds));
  const evFirst = selectForcedTop3([in1, in2, negNear, posFar], PREGAME);
  const posRow = evFirst.find((row) => row.pick === 'Pos Far');
  assert.ok(posRow && posRow.favCapFill === true);
  assert.ok(!evFirst.some((row) => row.pick === 'Neg Near'));

  const onCap = band('On Cap', 9, -300, 0.78);
  const justOut = band('Just Out', 10, -301, 0.82);
  assert.strictEqual(onCap.rejectReason, null, onCap.rejectReason);
  assert.strictEqual(justOut.rejectReason, null, justOut.rejectReason);
  const boundary = selectForcedTop3([onCap, justOut, in1, in2, in3], PREGAME);
  assert.ok(boundary.some((row) => row.pick === 'On Cap' && row.favCapFill !== true));
  assert.ok(!boundary.some((row) => row.pick === 'Just Out'));

  const mover = annotate({
    matchup: 'Move Away @ Move Home',
    pick: 'Mover',
    odds: -290,
    calibration: { pCal: 0.80, pMkt: 0.80, pModel: 0.80 },
  });
  assert.strictEqual(mover.rejectReason, null, mover.rejectReason);
  assert.ok(kellyGrowth(mover.pBet, mover.decimal) > kellyGrowth(in1.pBet, in1.decimal));
  const before = selectForcedTop3([mover, in1, in2, in3], PREGAME);
  assert.ok(before.some((row) => row.pick === 'Mover' && row.favCapFill !== true));
  const checked = await recheckPrices([mover, in1, in2, in3], async (leg) => {
    if (leg.pick !== 'Mover') return null;
    return { american: -305, book: 'draftkings' };
  });
  assert.strictEqual(checked.dropped.length, 0, JSON.stringify(checked.dropped));
  const moved = checked.kept.find((row) => row.pick === 'Mover');
  assert.ok(moved);
  assert.strictEqual(moved.odds, -305);
  assert.strictEqual(moved.qualified, true);
  assert.ok(Math.abs(moved.pBet - 0.80) < 1e-12);
  const after = selectForcedTop3(checked.kept, PREGAME);
  assert.ok(!after.some((row) => row.pick === 'Mover'), after.map((row) => row.pick).join(','));
  assert.strictEqual(after.length, 3);
  assert.ok(after.every((row) => row.favCapFill !== true));

  const short = await recheckPrices([mover, in1, in2], async (leg) => {
    if (leg.pick !== 'Mover') return null;
    return { american: -305, book: 'draftkings' };
  });
  const filledMove = selectForcedTop3(short.kept, PREGAME);
  const fill = filledMove.find((row) => row.pick === 'Mover');
  assert.ok(fill && fill.favCapFill === true, filledMove.map((row) => `${row.pick}:${row.odds}`).join(','));
}

main().then(() => {
  restore();
  console.log('PASS test-omega-v2-market-p');
}).catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
