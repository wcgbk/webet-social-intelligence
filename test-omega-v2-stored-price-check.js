'use strict';

/**
 * The pre-publish quote check is the stored 10:00 board.
 * Drop reasons and priceRecheck stay. The card also records priceCheck.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const FETCHED = '2026-11-15T15:00:00Z';

function row() {
  return {
    sport: 'NFL',
    matchup: 'Alpha @ Beta',
    pick: 'Alpha ML',
    market: 'Moneyline',
    odds: -110,
    line: null,
    book: 'draftkings',
    commenceTime: FUTURE,
    calibration: { pCal: 0.58, pMkt: 0.52, pModel: 0.58, method: 'board' },
  };
}

function board(price) {
  return {
    NFL: [{
      home_team: 'Beta',
      away_team: 'Alpha',
      bookmakers: [{
        key: 'draftkings',
        markets: [{
          key: 'h2h',
          outcomes: [
            { name: 'Alpha ML', price },
            { name: 'Beta ML', price: -110 },
          ],
        }],
      }],
    }],
  };
}

function strong() {
  return {
    sport: 'NFL',
    matchup: 'Alpha @ Beta',
    pick: 'Alpha ML',
    market: 'Moneyline',
    odds: '-110',
    book: 'draftkings',
    pModel: 0.68,
    pMkt: 0.50,
    uncertainty: 0.18,
    commenceTime: FUTURE,
    result: 'win',
    line: null,
  };
}

(async () => {
  const same = v2.recheckFromCachedBoard(board(-110), { boardFetchedAt: FETCHED });
  assert.deepStrictEqual(same.priceCheck, {
    type: 'stored-1000-consistency',
    boardFetchedAt: FETCHED,
  });
  const quoted = await same({
    pick: 'Alpha ML', matchup: 'Alpha @ Beta', market: 'Moneyline', book: 'draftkings', line: null,
  });
  assert.strictEqual(quoted.american, -110);
  assert.strictEqual(quoted.book, 'draftkings');

  const held = await v2.recheckPrices([row()], same);
  assert.strictEqual(held.checked, true);
  assert.strictEqual(held.dropped.length, 0);
  assert.strictEqual(held.kept.length, 1);
  assert.strictEqual(held.kept[0].odds, -110);

  const worse = v2.recheckFromCachedBoard(board(-180), { boardFetchedAt: FETCHED });
  const moved = await v2.recheckPrices([row()], worse);
  assert.strictEqual(moved.dropped.length, 1);
  assert.strictEqual(moved.dropped[0].reason, 'price-recheck');
  assert.strictEqual(moved.kept.length, 0);

  const spread = { ...row(), market: 'Spread', line: 3.5, pick: 'Alpha +3.5' };
  const mismatch = await v2.recheckPrices([spread], async () => ({
    american: -110, line: 4.5, book: 'draftkings',
  }));
  assert.strictEqual(mismatch.dropped.length, 1);
  assert.strictEqual(mismatch.dropped[0].reason, 'dk-hr-line-mismatch');

  const saved = process.env.OMEGA_V2_FORCE_TOP3;
  process.env.OMEGA_V2_FORCE_TOP3 = 'off';
  const logs = [];
  const orig = console.log;
  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
    orig.apply(console, args);
  };
  let card;
  let droppedCard;
  let bare;
  try {
    card = await v2.buildCard({
      date: '2026-11-15',
      dateFormatted: 'Sunday, November 15, 2026',
      candidates: [strong()],
      history: [],
      recheck: same,
    });
    droppedCard = await v2.buildCard({
      date: '2026-11-15',
      candidates: [strong()],
      history: [],
      recheck: worse,
    });
    bare = await v2.buildCard({
      date: '2026-11-15',
      candidates: [strong()],
      history: [],
    });
  } finally {
    console.log = orig;
    if (saved == null) delete process.env.OMEGA_V2_FORCE_TOP3;
    else process.env.OMEGA_V2_FORCE_TOP3 = saved;
  }

  assert.deepStrictEqual(card.priceRecheck, { checked: true, dropped: 0 });
  assert.deepStrictEqual(card.priceCheck, {
    type: 'stored-1000-consistency',
    boardFetchedAt: FETCHED,
    checked: true,
    mismatches: 0,
  });
  assert.ok(card.picks.length >= 1, 'same stored price keeps the straight');
  assert.ok(logs.some((line) => line === `[omega-v2] stored-1000 consistency check checked=true mismatches=0 boardFetchedAt=${FETCHED}`));
  assert.ok(logs.every((line) => !/fresh|live recheck|live pull/i.test(line)));

  assert.strictEqual(droppedCard.priceRecheck.checked, true);
  assert.ok(droppedCard.priceRecheck.dropped >= 1);
  assert.strictEqual(droppedCard.priceCheck.mismatches, droppedCard.priceRecheck.dropped);
  assert.strictEqual(droppedCard.priceCheck.type, 'stored-1000-consistency');
  assert.ok(droppedCard.rejections.some((r) => r.reason === 'price-recheck'));
  assert.ok(!droppedCard.picks.some((p) => p.pick === 'Alpha ML'));

  assert.deepStrictEqual(bare.priceRecheck, { checked: false, dropped: 0 });
  assert.deepStrictEqual(bare.priceCheck, {
    type: 'not-run',
    boardFetchedAt: null,
    checked: false,
    mismatches: 0,
  });

  console.log('PASS test-omega-v2-stored-price-check');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
