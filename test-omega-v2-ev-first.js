'use strict';

/**
 * OMEGA_V2_EV_FIRST. +EV is pBet * decimal - 1, not a stored row.ev.
 * Flag on: in-band +EV, out-of-band +EV (favCapFill), in-band EV<=0,
 * out-of-band EV<=0. Sharp-fair rows stay ahead of stored-fair fallbacks
 * inside each of those classes, the same pack order as a2b6bb1.
 * Flag off is the in-band-first fill. Default is off (HOLD 2026-11-15).
 * OMEGA_V2_EV_FIRST_CAPPED is pinned off here so this file keeps the
 * EV_FIRST pack order after that flag's default shipped on.
 */

const assert = require('assert');
const {
  annotateCandidate, selectForcedTop3, orderForcedPool, kellyGrowth,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, toParlay } = require('./netlify/functions/lib/omega-v2/guards');
const { americanToImplied, americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { evFirstEnabled, EV_FIRST_DEFAULT_ON } = require('./netlify/functions/lib/omega-v2/constants');
const { rerankCard } = require('./netlify/functions/lib/omega-vnext/rerank');

const AS_OF = Date.parse('2026-11-15T15:05:00Z');
const COMMENCE = '2026-11-15T23:00:00Z';
const PREGAME = { pregameAsOfMs: AS_OF };
const FAIR = americanToImplied(-110);
// 110/210 * 210/110 is 1 in real math and a hair over 1 in IEEE, which would
// look like +EV. Step down until the price EV is not positive.
function notPositiveProb(odds) {
  const dec = americanToDecimal(odds);
  let p = americanToImplied(odds);
  while (p * dec - 1 > 0) p = Math.nextDown(p);
  return p;
}
const ZERO_P = notPositiveProb(-110);

const saved = {
  force: process.env.OMEGA_V2_FORCE_TOP3,
  market: process.env.OMEGA_V2_MARKET_P,
  adj: process.env.OMEGA_V2_LONGSHOT_ADJ,
  fav: process.env.OMEGA_V2_FAV_CAP,
  evFirst: process.env.OMEGA_V2_EV_FIRST,
  capped: process.env.OMEGA_V2_EV_FIRST_CAPPED,
};

function restore() {
  const put = (key, val) => {
    if (val == null) delete process.env[key];
    else process.env[key] = val;
  };
  put('OMEGA_V2_FORCE_TOP3', saved.force);
  put('OMEGA_V2_MARKET_P', saved.market);
  put('OMEGA_V2_LONGSHOT_ADJ', saved.adj);
  put('OMEGA_V2_FAV_CAP', saved.fav);
  put('OMEGA_V2_EV_FIRST', saved.evFirst);
  put('OMEGA_V2_EV_FIRST_CAPPED', saved.capped);
}

function putFlag(on) {
  process.env.OMEGA_V2_EV_FIRST = on ? 'on' : 'off';
}

function row(spec) {
  const ann = annotateCandidate({
    sport: spec.sport || 'NCAAF',
    matchup: spec.matchup,
    pick: spec.pick,
    market: spec.market || 'Spread',
    line: spec.line != null ? spec.line : 3.5,
    odds: spec.odds,
    book: 'draftkings',
    gameKey: spec.gameKey || String(spec.matchup || '').toLowerCase(),
    commenceTime: COMMENCE,
    calibration: {
      pCal: spec.pMkt,
      pMkt: spec.pMkt,
      pModel: spec.pMkt,
      method: 'board',
    },
  }, { forceTop3: true, pregameAsOfMs: AS_OF });
  assert.strictEqual(ann.qualified, true, `${spec.pick} ${ann.rejectReason} ev=${ann.ev}`);
  if (spec.noSharpFair) ann.noSharpFair = true;
  return ann;
}

function names(list) {
  return (list || []).map((item) => item.pick);
}

function manual(spec) {
  const decimal = americanToDecimal(spec.odds);
  return {
    sport: 'NBA',
    matchup: spec.matchup,
    pick: spec.pick,
    market: 'Moneyline',
    odds: spec.odds,
    decimal,
    book: 'draftkings',
    gameKey: String(spec.matchup).toLowerCase(),
    commenceTime: COMMENCE,
    qualified: true,
    pBet: spec.pBet,
    ev: spec.ev,
    edge: spec.pBet - americanToImplied(spec.odds),
    calibration: { pCal: spec.pBet, pMkt: spec.pBet, pModel: spec.pBet },
  };
}

process.env.OMEGA_V2_FORCE_TOP3 = '1';
process.env.OMEGA_V2_MARKET_P = '1';
process.env.OMEGA_V2_FAV_CAP = '1';
process.env.OMEGA_V2_LONGSHOT_ADJ = 'off';
process.env.OMEGA_V2_EV_FIRST_CAPPED = 'off';

assert.strictEqual(EV_FIRST_DEFAULT_ON, false);
delete process.env.OMEGA_V2_EV_FIRST;
assert.strictEqual(evFirstEnabled(), false);
assert.strictEqual(evFirstEnabled({}), false);
process.env.OMEGA_V2_EV_FIRST = '';
assert.strictEqual(evFirstEnabled(), false);
process.env.OMEGA_V2_EV_FIRST = '   ';
assert.strictEqual(evFirstEnabled(), false);
process.env.OMEGA_V2_EV_FIRST = 'off';
assert.strictEqual(evFirstEnabled(), false);
process.env.OMEGA_V2_EV_FIRST = '0';
assert.strictEqual(evFirstEnabled(), false);
process.env.OMEGA_V2_EV_FIRST = 'false';
assert.strictEqual(evFirstEnabled(), false);
process.env.OMEGA_V2_EV_FIRST = 'on';
assert.strictEqual(evFirstEnabled(), true);
process.env.OMEGA_V2_EV_FIRST = '1';
assert.strictEqual(evFirstEnabled(), true);
process.env.OMEGA_V2_EV_FIRST = 'true';
assert.strictEqual(evFirstEnabled(), true);
process.env.OMEGA_V2_EV_FIRST = 'yes';
assert.strictEqual(evFirstEnabled(), true);
process.env.OMEGA_V2_EV_FIRST = 'no';
assert.strictEqual(evFirstEnabled(), false);
assert.strictEqual(evFirstEnabled({ OMEGA_V2_EV_FIRST: 'off' }), false);
assert.strictEqual(evFirstEnabled({ OMEGA_V2_EV_FIRST: 'on' }), true);

const plusHigh = row({
  matchup: 'High Away @ High Home', pick: 'Plus High', odds: -110, pMkt: 0.60,
});
const plusMid = row({
  matchup: 'Mid Away @ Mid Home', pick: 'Plus Mid', odds: -110, pMkt: 0.56,
});
const plusLow = row({
  matchup: 'Low Away @ Low Home', pick: 'Plus Low', odds: -110, pMkt: 0.55,
});
const zero = row({
  matchup: 'New Hampshire @ Zero Home', pick: 'Zero Fill', odds: -110, line: 22.5, pMkt: ZERO_P,
});
const negFill = row({
  matchup: 'Neg Away @ Neg Home', pick: 'Neg Fill', odds: -110, pMkt: 0.48,
});
const heavyPos = row({
  matchup: 'Heavy Away @ Heavy Home', pick: 'Heavy Plus', odds: -450, pMkt: 0.85,
});
const heavyNeg = row({
  matchup: 'Short Away @ Short Home', pick: 'Heavy Neg', odds: -310, pMkt: 0.72,
});
const sharpPlus = row({
  matchup: 'Sharp Away @ Sharp Home', pick: 'Sharp Plus', odds: -110, pMkt: 0.58,
});
const fallPlus = row({
  matchup: 'Fall Away @ Fall Home', pick: 'Fall Plus', odds: -110, pMkt: 0.59, noSharpFair: true,
});

assert.ok(plusHigh.ev > plusMid.ev && plusMid.ev > plusLow.ev && plusLow.ev > 0);
assert.ok(Math.abs(zero.ev) < 1e-12, `zero ev ${zero.ev}`);
assert.ok(negFill.ev < 0, negFill.ev);
assert.ok(heavyPos.ev > 0, heavyPos.ev);
assert.ok(heavyNeg.ev < 0, heavyNeg.ev);
assert.ok(heavyPos.odds < -300 && heavyNeg.odds < -300);
assert.ok(fallPlus.ev > 0 && fallPlus.noSharpFair === true);
assert.ok(kellyGrowth(plusHigh.pBet, plusHigh.decimal) > kellyGrowth(plusMid.pBet, plusMid.decimal));
assert.ok(!(zero.pBet * zero.decimal - 1 > 0), 'fair price is not +EV');
assert.ok(!(kellyGrowth(zero.pBet, zero.decimal) > 0));
assert.ok(kellyGrowth(heavyPos.pBet, heavyPos.decimal) > 0);
assert.ok(kellyGrowth(negFill.pBet, negFill.decimal) == null && negFill.ev < 0);

const mixed = [zero, heavyNeg, plusMid, heavyPos, negFill, plusHigh];

putFlag(true);
const onCard = selectForcedTop3(mixed, PREGAME);
assert.deepStrictEqual(names(onCard), ['Plus High', 'Plus Mid', 'Heavy Plus']);
assert.strictEqual(onCard[2].favCapFill, true);
assert.ok(onCard.slice(0, 2).every((item) => item.favCapFill !== true));
assert.ok(!onCard.some((item) => item.pick === 'Zero Fill' || item.pick === 'Neg Fill' || item.pick === 'Heavy Neg'));
const onOrder = orderForcedPool(mixed, PREGAME);
assert.deepStrictEqual(names(onOrder), [
  'Plus High', 'Plus Mid', 'Heavy Plus', 'Zero Fill', 'Neg Fill', 'Heavy Neg',
]);

const sizedOn = sizeForcedStraights(onCard);
assert.notStrictEqual(sizedOn[2].filler, true);
assert.ok(sizedOn[2].units >= 0.25);
assert.ok(sizedOn.slice(0, 2).every((item) => item.filler !== true && item.units > 0.25));
const heavyAlone = sizeForcedStraights([heavyPos]);
assert.ok(heavyAlone[0].units > 0.25, `solo -450 stake ${heavyAlone[0].units}`);
assert.notStrictEqual(heavyAlone[0].filler, true);
const parlayOn = buildForcedParlay(sizedOn);
assert.strictEqual(parlayOn.publish, true, parlayOn.skipReason);
assert.strictEqual(parlayOn.legs.length, 3);
assert.deepStrictEqual(parlayOn.legs.map((leg) => leg.pick), names(sizedOn));

const negSized = sizeForcedStraights([negFill]);
assert.strictEqual(negSized[0].units, 0.25);
assert.strictEqual(negSized[0].filler, true);
const zeroSized = sizeForcedStraights([zero]);
assert.strictEqual(zeroSized[0].units, 0.25);
assert.notStrictEqual(zeroSized[0].filler, true);

putFlag(false);
const offCard = selectForcedTop3(mixed, PREGAME);
assert.deepStrictEqual(names(offCard), ['Plus High', 'Plus Mid', 'Zero Fill']);
assert.ok(offCard.every((item) => item.favCapFill !== true));
assert.ok(!offCard.some((item) => item.pick === 'Heavy Plus'));
const offOrder = orderForcedPool(mixed, PREGAME);
assert.deepStrictEqual(names(offOrder), [
  'Plus High', 'Plus Mid', 'Zero Fill', 'Neg Fill', 'Heavy Plus', 'Heavy Neg',
]);

// Three in-band +EV rows keep every -300-or-shorter favorite off.
putFlag(true);
const full = selectForcedTop3([plusLow, heavyPos, plusHigh, plusMid], PREGAME);
assert.deepStrictEqual(names(full), ['Plus High', 'Plus Mid', 'Plus Low']);
assert.ok(full.every((item) => item.favCapFill !== true));
assert.deepStrictEqual(names(orderForcedPool([plusLow, heavyPos, plusHigh, plusMid], PREGAME)), [
  'Plus High', 'Plus Mid', 'Plus Low', 'Heavy Plus',
]);

// No positive price EV anywhere: same order as the flag-off fill, fallbacks included.
const inHigh = row({ matchup: 'A1 @ H1', pick: 'In High', odds: -110, pMkt: 0.50 });
const inMid = row({ matchup: 'A2 @ H2', pick: 'In Mid', odds: -110, pMkt: 0.48 });
const near = row({ matchup: 'A3 @ H3', pick: 'Near Heavy', odds: -350, pMkt: 0.74 });
const far = row({ matchup: 'A4 @ H4', pick: 'Far Heavy', odds: -800, pMkt: 0.86 });
const fallIn = row({
  matchup: 'A5 @ H5', pick: 'Fall In', odds: -110, pMkt: 0.47, noSharpFair: true,
});
const fallOut = row({
  matchup: 'A6 @ H6', pick: 'Fall Out', odds: -400, pMkt: 0.75, noSharpFair: true,
});
assert.ok([inHigh, inMid, near, far, fallIn, fallOut].every((item) => !(item.ev > 0)));
const dead = [fallOut, far, fallIn, inMid, near, inHigh];
// Blend ranks the out-of-band fill by price EV. Far Heavy is less negative than Near Heavy.
const deadExpect = ['In High', 'In Mid', 'Far Heavy', 'Near Heavy', 'Fall In', 'Fall Out'];
putFlag(true);
assert.deepStrictEqual(names(orderForcedPool(dead, PREGAME)), deadExpect);
assert.deepStrictEqual(names(selectForcedTop3(dead, PREGAME)), ['In High', 'In Mid', 'Far Heavy']);
assert.strictEqual(selectForcedTop3(dead, PREGAME)[2].favCapFill, true);
putFlag(false);
assert.deepStrictEqual(names(orderForcedPool(dead, PREGAME)), deadExpect);
assert.deepStrictEqual(names(selectForcedTop3(dead, PREGAME)), ['In High', 'In Mid', 'Far Heavy']);

// Stored-fair +EV still waits for sharp +EV in both bands. A -EV sharp does not jump the +EV favorite.
putFlag(true);
const classed = [fallPlus, zero, heavyPos, sharpPlus];
assert.deepStrictEqual(names(selectForcedTop3(classed, PREGAME)), ['Sharp Plus', 'Heavy Plus', 'Fall Plus']);
assert.strictEqual(selectForcedTop3(classed, PREGAME)[1].favCapFill, true);
assert.strictEqual(selectForcedTop3(classed, PREGAME)[2].noSharpFair, true);
assert.deepStrictEqual(names(orderForcedPool(classed, PREGAME)), [
  'Sharp Plus', 'Heavy Plus', 'Fall Plus', 'Zero Fill',
]);

// Cap off stays the unsplit growth rank whether the flag is on or off.
process.env.OMEGA_V2_FAV_CAP = 'off';
putFlag(true);
const uncappedOn = names(selectForcedTop3(mixed, PREGAME));
putFlag(false);
const uncappedOff = names(selectForcedTop3(mixed, PREGAME));
assert.deepStrictEqual(uncappedOn, uncappedOff);
process.env.OMEGA_V2_FAV_CAP = '1';

// row.ev and pBet can disagree. The tier follows price EV at pBet.
const printedPlus = manual({
  matchup: 'P Away @ P Home', pick: 'Printed Plus', odds: -110, pBet: ZERO_P, ev: 0.20,
});
const truePlus = manual({
  matchup: 'T Away @ T Home', pick: 'True Plus', odds: -110, pBet: 0.60, ev: -0.01,
});
const otherPlus = manual({
  matchup: 'O Away @ O Home', pick: 'Other Plus', odds: -105, pBet: 0.57, ev: 0.02,
});
const heavyLie = manual({
  matchup: 'L Away @ L Home', pick: 'Heavy Lie', odds: -450, pBet: 0.86, ev: -0.05,
});
assert.ok(printedPlus.ev > 0 && !(kellyGrowth(printedPlus.pBet, printedPlus.decimal) > 0));
assert.ok(truePlus.ev <= 0 && kellyGrowth(truePlus.pBet, truePlus.decimal) > 0);
assert.ok(heavyLie.ev <= 0 && kellyGrowth(heavyLie.pBet, heavyLie.decimal) > 0);
const lied = [printedPlus, heavyLie, truePlus, otherPlus];
const gTrue = kellyGrowth(truePlus.pBet, truePlus.decimal);
const gOther = kellyGrowth(otherPlus.pBet, otherPlus.decimal);
const trueFirst = gTrue >= gOther
  ? ['True Plus', 'Other Plus', 'Heavy Lie']
  : ['Other Plus', 'True Plus', 'Heavy Lie'];
putFlag(true);
const lieCard = selectForcedTop3(lied, PREGAME);
assert.deepStrictEqual(names(lieCard), trueFirst);
assert.strictEqual(lieCard[2].favCapFill, true);
assert.ok(lieCard[2].ev <= 0, 'stored ev stays negative; the tier did not read it');
putFlag(false);
const lieOff = selectForcedTop3(lied, PREGAME);
assert.deepStrictEqual(names(lieOff), trueFirst.slice(0, 2).concat('Printed Plus'));
assert.ok(lieOff.every((item) => item.favCapFill !== true));
assert.ok(!lieOff.some((item) => item.pick === 'Heavy Lie'));

// Same game still contributes one straight. The in-band +EV keeps the game.
const twinIn = row({
  matchup: 'Twin Away @ Twin Home', pick: 'Twin In', odds: -110, pMkt: 0.58,
  gameKey: 'twin away @ twin home',
});
const twinOut = row({
  matchup: 'Twin Away @ Twin Home', pick: 'Twin Out', odds: -450, pMkt: 0.85,
  gameKey: 'twin away @ twin home',
});
putFlag(true);
const twins = selectForcedTop3([twinOut, zero, twinIn, plusHigh], PREGAME);
assert.deepStrictEqual(names(twins), ['Plus High', 'Twin In', 'Zero Fill']);
assert.ok(!twins.some((item) => item.pick === 'Twin Out'));

(async () => {
  putFlag(false);
  const published = sizeForcedStraights(selectForcedTop3([plusHigh, plusMid, zero, heavyPos], PREGAME));
  assert.deepStrictEqual(names(published), ['Plus High', 'Plus Mid', 'Zero Fill']);
  const picks = published.map((leg) => toPick(leg));
  const ticket = buildForcedParlay(published);
  const card = {
    date: '2026-11-15',
    engine: 'omega-v2',
    modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
    selectionRule: 'force-top3',
    pipeline: 'omega-v2',
    parlaySource: 'top3-straights',
    picks,
    parlayLegs: toParlay(ticket, published.length),
    summary: { totalPicks: 3, totalStraightBets: 3 },
    edgeSummary: 'keep-me',
    rankedPool: [plusHigh, plusMid, zero, heavyPos],
  };
  const replaced = await rerankCard({
    card,
    now: new Date(AS_OF),
    env: {
      OMEGA_V2_EV_FIRST: 'on',
      OMEGA_V2_EV_FIRST_CAPPED: 'off',
      OMEGA_V2_FAV_CAP: 'on',
      OMEGA_V2_MARKET_P: 'off',
      OMEGA_V2_LONGSHOT_ADJ: 'off',
    },
    runNews: async () => ({
      actions: [{
        action: 'drop',
        code: 'postponed',
        pick: 'Zero Fill',
        matchup: 'New Hampshire @ Zero Home',
        reason: 'Game postponed',
      }],
      dropped: 1,
      errors: [],
      checks: [{ matched: true }],
    }),
  });
  assert.strictEqual(replaced.changed, true, replaced.reason);
  assert.deepStrictEqual(replaced.card.picks.map((item) => item.pick), [
    'Plus High', 'Plus Mid', 'Heavy Plus',
  ]);
  assert.deepStrictEqual(
    replaced.card.parlayLegs[0].legs.map((leg) => leg.pick),
    replaced.card.picks.map((item) => item.pick),
  );
  assert.notStrictEqual(replaced.card.picks[2].filler, true);
  restore();
  console.log('PASS test-omega-v2-ev-first');
})().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
