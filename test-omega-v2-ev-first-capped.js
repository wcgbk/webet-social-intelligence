'use strict';

/**
 * OMEGA_V2_EV_FIRST_CAPPED. With the -300 cap on, every in-band row
 * ranks ahead of every out-of-band row. In-band order is +EV sharp,
 * +EV stored-fair, EV<=0 sharp, EV<=0 stored-fair. +EV is
 * pBet * decimal - 1. Out-of-band rows keep favCapFill order and fill
 * a slot only when fewer than 3 in-band candidates remain.
 * CAPPED wins over OMEGA_V2_EV_FIRST. Cap off is a no-op.
 * Default is off until a replay clears the ship rule.
 */

const assert = require('assert');
const {
  annotateCandidate, selectForcedTop3, orderForcedPool, kellyGrowth,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { americanToImplied, americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const {
  evFirstCappedEnabled, EV_FIRST_CAPPED_DEFAULT_ON,
} = require('./netlify/functions/lib/omega-v2/constants');

const AS_OF = Date.parse('2026-11-15T15:05:00Z');
const COMMENCE = '2026-11-15T23:00:00Z';
const PREGAME = { pregameAsOfMs: AS_OF };

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

function flags(spec) {
  process.env.OMEGA_V2_EV_FIRST_CAPPED = spec.capped == null ? 'off' : spec.capped;
  process.env.OMEGA_V2_EV_FIRST = spec.evFirst == null ? 'off' : spec.evFirst;
  process.env.OMEGA_V2_FAV_CAP = spec.cap == null ? '1' : spec.cap;
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

function priceEv(item) {
  return item.pBet * item.decimal - 1;
}

process.env.OMEGA_V2_FORCE_TOP3 = '1';
process.env.OMEGA_V2_MARKET_P = '1';
process.env.OMEGA_V2_FAV_CAP = '1';
process.env.OMEGA_V2_LONGSHOT_ADJ = 'off';

try {
  assert.strictEqual(EV_FIRST_CAPPED_DEFAULT_ON, false);
  delete process.env.OMEGA_V2_EV_FIRST_CAPPED;
  assert.strictEqual(evFirstCappedEnabled(), EV_FIRST_CAPPED_DEFAULT_ON);
  assert.strictEqual(evFirstCappedEnabled({}), EV_FIRST_CAPPED_DEFAULT_ON);
  assert.strictEqual(evFirstCappedEnabled({ OMEGA_V2_EV_FIRST_CAPPED: undefined }), EV_FIRST_CAPPED_DEFAULT_ON);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = '';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = '   ';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'off';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = '0';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'false';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'no';
  assert.strictEqual(evFirstCappedEnabled(), false);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'on';
  assert.strictEqual(evFirstCappedEnabled(), true);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = '1';
  assert.strictEqual(evFirstCappedEnabled(), true);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'true';
  assert.strictEqual(evFirstCappedEnabled(), true);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'yes';
  assert.strictEqual(evFirstCappedEnabled(), true);
  process.env.OMEGA_V2_EV_FIRST_CAPPED = ' YES ';
  assert.strictEqual(evFirstCappedEnabled(), true);
  assert.strictEqual(evFirstCappedEnabled({ OMEGA_V2_EV_FIRST_CAPPED: 'off' }), false);
  assert.strictEqual(evFirstCappedEnabled({ OMEGA_V2_EV_FIRST_CAPPED: '' }), false);
  assert.strictEqual(evFirstCappedEnabled({ OMEGA_V2_EV_FIRST_CAPPED: 'on' }), true);

  const plusHigh = row({
    matchup: 'High Away @ High Home', pick: 'Plus High', odds: -110, pMkt: 0.60,
  });
  const sharpPlus = row({
    matchup: 'Sharp Away @ Sharp Home', pick: 'Sharp Plus', odds: -110, pMkt: 0.58,
  });
  const fallPlus = row({
    matchup: 'Fall Away @ Fall Home', pick: 'Fall Plus', odds: -110, pMkt: 0.59, noSharpFair: true,
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
  const farHeavy = row({
    matchup: 'Far Away @ Far Home', pick: 'Far Heavy', odds: -800, pMkt: 0.92,
  });
  const fallOut = row({
    matchup: 'Out Away @ Out Home', pick: 'Fall Out', odds: -400, pMkt: 0.85, noSharpFair: true,
  });

  assert.ok(priceEv(plusHigh) > priceEv(sharpPlus) && priceEv(sharpPlus) > 0);
  assert.ok(priceEv(fallPlus) > priceEv(sharpPlus) && fallPlus.noSharpFair === true);
  assert.ok(!(priceEv(zero) > 0), 'fair price is not +EV');
  assert.ok(!(priceEv(negFill) > 0) && priceEv(negFill) < priceEv(zero));
  assert.ok(priceEv(heavyPos) > 0 && priceEv(farHeavy) > 0 && priceEv(fallOut) > 0);
  assert.ok(heavyPos.odds < -300 && farHeavy.odds < -300 && fallOut.odds < -300);
  assert.ok(kellyGrowth(plusHigh.pBet, plusHigh.decimal) > kellyGrowth(sharpPlus.pBet, sharpPlus.decimal));
  assert.ok(kellyGrowth(fallPlus.pBet, fallPlus.decimal) > kellyGrowth(sharpPlus.pBet, sharpPlus.decimal));
  assert.ok(Math.abs(heavyPos.odds) < Math.abs(farHeavy.odds));

  // >=3 in-band rows, including an EV<=0 filler. The out-of-band +EV row
  // stays off the card. Within in-band, growth order holds inside +EV sharp,
  // and the +EV stored-fair row waits until those sharp rows are placed.
  const blocked = [zero, heavyPos, sharpPlus, fallPlus, plusHigh];
  const blockedOrder = ['Plus High', 'Sharp Plus', 'Fall Plus', 'Zero Fill', 'Heavy Plus'];
  flags({ capped: 'on', evFirst: 'off' });
  assert.deepStrictEqual(names(orderForcedPool(blocked, PREGAME)), blockedOrder);
  const blockedCard = selectForcedTop3(blocked, PREGAME);
  assert.deepStrictEqual(names(blockedCard), ['Plus High', 'Sharp Plus', 'Fall Plus']);
  assert.ok(blockedCard.every((item) => item.favCapFill !== true));
  assert.ok(!blockedCard.some((item) => item.pick === 'Heavy Plus' || item.pick === 'Zero Fill'));

  // CAPPED ignores EV_FIRST. EV_FIRST alone would publish the -450.
  flags({ capped: 'on', evFirst: 'on' });
  assert.deepStrictEqual(names(selectForcedTop3(blocked, PREGAME)), ['Plus High', 'Sharp Plus', 'Fall Plus']);
  assert.deepStrictEqual(names(orderForcedPool(blocked, PREGAME)), blockedOrder);
  flags({ capped: 'off', evFirst: 'on' });
  const evFirstCard = selectForcedTop3(blocked, PREGAME);
  assert.deepStrictEqual(names(evFirstCard), ['Plus High', 'Sharp Plus', 'Heavy Plus']);
  assert.strictEqual(evFirstCard[2].favCapFill, true);
  flags({ capped: 'off', evFirst: 'off' });
  assert.deepStrictEqual(names(orderForcedPool(blocked, PREGAME)), [
    'Plus High', 'Sharp Plus', 'Zero Fill', 'Heavy Plus', 'Fall Plus',
  ]);
  assert.deepStrictEqual(names(selectForcedTop3(blocked, PREGAME)), ['Plus High', 'Sharp Plus', 'Zero Fill']);

  // In-band +EV stored-fair outranks an in-band EV<=0 sharp. The out-of-band
  // +EV row still does not take that sharp filler's slot.
  const ranked = [negFill, heavyPos, zero, fallPlus, sharpPlus];
  const rankedOrder = ['Sharp Plus', 'Fall Plus', 'Zero Fill', 'Neg Fill', 'Heavy Plus'];
  flags({ capped: 'on', evFirst: 'on' });
  assert.deepStrictEqual(names(orderForcedPool(ranked, PREGAME)), rankedOrder);
  const rankedCard = selectForcedTop3(ranked, PREGAME);
  assert.deepStrictEqual(names(rankedCard), ['Sharp Plus', 'Fall Plus', 'Zero Fill']);
  assert.strictEqual(rankedCard[1].noSharpFair, true);
  assert.ok(rankedCard.every((item) => item.favCapFill !== true));
  assert.ok(!rankedCard.some((item) => item.pick === 'Heavy Plus'));
  assert.ok(priceEv(rankedCard[1]) > 0 && !(priceEv(rankedCard[2]) > 0));

  // Only two in-band rows: the out-of-band pack fills the third slot, in the
  // existing favCapFill order (sharp before stored-fair, closer to -300 first).
  const short = [fallOut, farHeavy, zero, heavyPos, plusHigh];
  const shortOrder = ['Plus High', 'Zero Fill', 'Heavy Plus', 'Far Heavy', 'Fall Out'];
  flags({ capped: 'on', evFirst: 'off' });
  assert.deepStrictEqual(names(orderForcedPool(short, PREGAME)), shortOrder);
  const shortCard = selectForcedTop3(short, PREGAME);
  assert.deepStrictEqual(names(shortCard), ['Plus High', 'Zero Fill', 'Heavy Plus']);
  assert.strictEqual(shortCard[2].favCapFill, true);
  assert.ok(shortCard.slice(0, 2).every((item) => item.favCapFill !== true));
  assert.ok(!shortCard.some((item) => item.pick === 'Far Heavy' || item.pick === 'Fall Out'));
  flags({ capped: 'on', evFirst: 'on' });
  assert.deepStrictEqual(names(selectForcedTop3(short, PREGAME)), ['Plus High', 'Zero Fill', 'Heavy Plus']);
  const sized = sizeForcedStraights(shortCard);
  const ticket = buildForcedParlay(sized);
  assert.strictEqual(ticket.publish, true, ticket.skipReason);
  assert.strictEqual(ticket.legs.length, 3);
  assert.deepStrictEqual(ticket.legs.map((leg) => leg.pick), names(sized));

  // Same game still contributes one straight. Two unique in-band games leave
  // the third slot to a different game's out-of-band row. The in-band side
  // keeps the shared game, ahead of that out-of-band +EV row.
  const twinIn = row({
    matchup: 'Twin Away @ Twin Home', pick: 'Twin In', odds: -110, pMkt: ZERO_P,
    gameKey: 'twin away @ twin home',
  });
  const twinOut = row({
    matchup: 'Twin Away @ Twin Home', pick: 'Twin Out', odds: -450, pMkt: 0.85,
    gameKey: 'twin away @ twin home',
  });
  flags({ capped: 'on', evFirst: 'on' });
  const twins = selectForcedTop3([twinOut, twinIn, plusHigh, heavyPos], PREGAME);
  assert.deepStrictEqual(names(twins), ['Plus High', 'Twin In', 'Heavy Plus']);
  assert.strictEqual(twins[2].favCapFill, true);
  assert.ok(twins.slice(0, 2).every((item) => item.favCapFill !== true));
  assert.ok(!twins.some((item) => item.pick === 'Twin Out'));

  // Cap off is the unsplit rank whether CAPPED and EV_FIRST are on or off.
  flags({ capped: 'on', evFirst: 'on', cap: 'off' });
  const uncappedOn = names(selectForcedTop3(blocked, PREGAME));
  const uncappedOrderOn = names(orderForcedPool(blocked, PREGAME));
  flags({ capped: 'off', evFirst: 'off', cap: 'off' });
  assert.deepStrictEqual(uncappedOn, names(selectForcedTop3(blocked, PREGAME)));
  assert.deepStrictEqual(uncappedOrderOn, names(orderForcedPool(blocked, PREGAME)));
  assert.ok(!selectForcedTop3(blocked, PREGAME).some((item) => item.favCapFill === true));

  // opts.env wins over process.env, including CAPPED over EV_FIRST.
  flags({ capped: 'off', evFirst: 'off', cap: '1' });
  const fromOpts = selectForcedTop3(ranked, {
    pregameAsOfMs: AS_OF,
    env: {
      OMEGA_V2_EV_FIRST_CAPPED: 'on',
      OMEGA_V2_EV_FIRST: 'on',
      OMEGA_V2_FAV_CAP: 'on',
    },
  });
  assert.deepStrictEqual(names(fromOpts), ['Sharp Plus', 'Fall Plus', 'Zero Fill']);
  assert.ok(fromOpts.every((item) => item.favCapFill !== true));

  console.log('PASS test-omega-v2-ev-first-capped');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  restore();
}
