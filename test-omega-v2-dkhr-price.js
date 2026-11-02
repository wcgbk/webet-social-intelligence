'use strict';

/**
 * v2 bet-price integrity. A published straight or parlay leg is a DraftKings
 * or Hard Rock number. A parlay leg also needs positive EV at that number.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');

const DATE = '2026-10-31';
const PREGAME = Date.parse('2026-10-31T16:00:00Z');
const DK_HR = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

function pModelFor(pCal, pMkt, k = 0.70) {
  return (pCal - k * pMkt) / (1 - k);
}

function row(over) {
  return {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeTeam: 'Kansas City Chiefs',
    side: 'Over 5.5',
    pick: 'Over 5.5',
    market: 'Total',
    line: 5.5,
    odds: -146,
    book: 'onexbet',
    bestDkHr: null,
    pMkt: 0.55,
    pModel: pModelFor(0.63, 0.55),
    uncertainty: 0.18,
    commenceTime: '2026-10-31T23:00:00Z',
    ...over,
  };
}

function leg(matchup, pick, edgeNovig, pCal, odds) {
  return {
    sport: 'NFL',
    matchup,
    pick,
    market: 'Moneyline',
    odds,
    edgeNovig,
    parlayQualified: true,
    calibration: { pCal },
  };
}

function h2h(key, price) {
  return {
    key,
    markets: [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price }] }],
  };
}

function quoteLeg(book) {
  return {
    pick: 'Kansas City Chiefs ML',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    market: 'Moneyline',
    book,
    line: null,
  };
}

(async () => {
  assert.strictEqual(v2.MODEL_VERSION, 'omega-v2-sharp-2026-11-01-dkhr');

  const onex = row({
    bestDkHr: { book: 'hardrockbet_oh', american: -150 },
  });
  const adapted = v2.fromOmegaCandidate({
    ...onex,
    oddsStr: '-146',
    modelRawP: onex.pModel,
    fair_sharp_p: onex.pMkt,
  });
  assert.strictEqual(adapted.bestDkHr.american, -150);
  assert.strictEqual(adapted.book, 'onexbet');
  const repriced = await v2.buildCard({ date: DATE, pregameAsOfMs: PREGAME, candidates: [adapted], history: [] });
  assert.strictEqual(repriced.picks.length, 1, 'DK/HR price with edge is a straight');
  assert.strictEqual(repriced.picks[0].book, 'hardrockbet');
  assert.strictEqual(repriced.picks[0].odds, '-150');
  assert.strictEqual(repriced.picks[0].line, 5.5);
  assert.ok(!repriced.picks.some((pick) => String(pick.odds) === '-146' || pick.book === 'onexbet'));
  assert.ok(!repriced.rejections.some((r) => r.reason === 'no-dk-hr-price'));
  assert.ok(repriced.parlayPool.every((legRow) => String(legRow.odds) !== '-146'));

  const alias = v2.normalizeCandidate(row({
    matchup: 'Dallas Cowboys @ Philadelphia Eagles',
    pick: 'Dallas Cowboys ML',
    side: 'Dallas Cowboys ML',
    market: 'Moneyline',
    line: null,
    odds: -115,
    book: 'hardrock',
    bestDkHr: null,
  }));
  assert.strictEqual(alias.noDkHr, false);
  assert.strictEqual(alias.book, 'hardrockbet');
  assert.strictEqual(alias.odds, -115);
  assert.strictEqual(alias.line, null);

  const bare = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [
      row({ bestDkHr: null, pModel: 0.8, pMkt: 0.5 }),
      row({
        matchup: 'Green Bay Packers @ Chicago Bears',
        awayTeam: 'Green Bay Packers',
        homeTeam: 'Chicago Bears',
        pick: 'Green Bay Packers ML',
        side: 'Green Bay Packers ML',
        market: 'Moneyline',
        line: null,
        odds: -110,
        book: 'draftkings',
        bestDkHr: { book: 'draftkings', american: -110 },
        pMkt: 0.52,
        pModel: pModelFor(0.60, 0.52),
      }),
    ],
    history: [],
  });
  assert.ok(bare.rejections.some((r) => r.reason === 'no-dk-hr-price' && r.book === 'onexbet'));
  assert.ok(!bare.picks.some((pick) => /over 5\.5/i.test(pick.pick)));
  assert.ok(!bare.parlayPool.some((legRow) => /over 5\.5/i.test(legRow.pick)));
  assert.ok((bare.parlayLegs[0] ? bare.parlayLegs[0].legs : []).every((legRow) => legRow.book !== 'onexbet'));
  assert.ok(bare.picks.some((pick) => pick.book === 'draftkings'));

  const shopped = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [row({
      matchup: 'Dallas Cowboys @ Philadelphia Eagles',
      awayTeam: 'Dallas Cowboys',
      homeTeam: 'Philadelphia Eagles',
      pick: 'Dallas Cowboys ML',
      side: 'Dallas Cowboys ML',
      market: 'Moneyline',
      line: null,
      book: 'betmgm',
      odds: -105,
      bestDkHr: { book: 'draftkings', american: -120 },
      pMkt: 0.50,
      pModel: pModelFor(0.58, 0.50),
    })],
    history: [],
  });
  assert.strictEqual(shopped.picks.length, 1);
  assert.strictEqual(shopped.picks[0].book, 'draftkings');
  assert.strictEqual(shopped.picks[0].odds, '-120');
  assert.ok(shopped.picks[0].odds !== '-105');

  const dec110 = americanToDecimal(-110);
  const bad = leg('A @ B', 'A ML', 0.08, 0.50, -110);
  const goodA = leg('C @ D', 'C ML', 0.04, 0.60, -110);
  const goodB = leg('E @ F', 'E ML', 0.03, 0.58, -110);
  assert.ok(0.50 * dec110 - 1 < 0, 'the no-EV leg is below 1.0 at the bet price');
  assert.ok(bad.edgeNovig > 0);
  const joint = v2.scoreLegs([bad, goodA, goodB]);
  assert.ok(joint && joint.ev > 0, 'three legs would clear joint EV if the no-EV leg stayed');
  const ticket = v2.chooseTicket([bad, goodA, goodB]);
  assert.ok(ticket);
  assert.strictEqual(ticket.legs.length, 2);
  assert.ok(ticket.legs.every((legRow) => legRow.pick !== 'A ML'));
  assert.ok(ticket.legs.every((legRow) => (legRow.calibration.pCal * dec110 - 1) > 0));

  const badCardLeg = row({
    matchup: 'A @ B',
    awayTeam: 'A',
    homeTeam: 'B',
    pick: 'A ML',
    side: 'A ML',
    market: 'Moneyline',
    line: null,
    odds: -110,
    book: 'draftkings',
    bestDkHr: { book: 'draftkings', american: -110 },
    pMkt: 0.48,
    pModel: pModelFor(0.51, 0.48),
  });
  const goodCard = (name, pCal, pMkt) => row({
    matchup: `${name} Away @ ${name} Home`,
    awayTeam: `${name} Away`,
    homeTeam: `${name} Home`,
    pick: `${name} Home ML`,
    side: `${name} Home ML`,
    market: 'Moneyline',
    line: null,
    odds: -110,
    book: 'draftkings',
    bestDkHr: { book: 'draftkings', american: -110 },
    pMkt,
    pModel: pModelFor(pCal, pMkt),
  });
  const fallen = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [badCardLeg, goodCard('C', 0.60, 0.52), goodCard('E', 0.58, 0.52)],
    history: [],
  });
  assert.strictEqual(fallen.parlayLegs.length, 1);
  assert.strictEqual(fallen.parlayLegs[0].legs.length, 2);
  assert.ok(fallen.parlayLegs[0].legs.every((legRow) => legRow.pick !== 'A ML'));
  assert.ok(fallen.parlayLegs[0].legs.every((legRow) => DK_HR.has(legRow.book)));
  for (const legRow of fallen.parlayLegs[0].legs) {
    const ev = legRow.pCal * americanToDecimal(legRow.odds) - 1;
    assert.ok(ev > 0, `${legRow.pick} ev ${ev}`);
  }
  const evSkip = fallen.rejections.find((r) => r.reason === 'leg-ev-not-positive');
  assert.ok(evSkip, 'leg-ev-not-positive is in rejections');
  assert.strictEqual(evSkip.side, 'A ML');
  assert.ok(!fallen.parlayPool.some((legRow) => legRow.pick === 'A ML'));
  assert.ok(fallen.picks.length >= 1, 'straights still publish when a parlay leg is dropped');

  const straightOnly = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    candidates: [badCardLeg, goodCard('C', 0.60, 0.52)],
    history: [],
  });
  assert.strictEqual(straightOnly.parlayLegs.length, 0);
  assert.ok(straightOnly.picks.some((pick) => pick.pick === 'C Home ML'));
  assert.strictEqual(straightOnly.pass, false);
  assert.ok(straightOnly.rejections.some((r) => r.reason === 'leg-ev-not-positive' && r.side === 'A ML'));

  const full = v2.recheckFromCachedBoard({
    americanfootball_nfl: [{
      home_team: 'Kansas City Chiefs',
      away_team: 'Buffalo Bills',
      bookmakers: [
        h2h('pinnacle', -102),
        h2h('fanduel', -108),
        h2h('betmgm', -109),
        h2h('onexbet', -100),
        h2h('draftkings', -115),
        h2h('hardrockbet', -112),
        h2h('hardrock', -118),
        h2h('hardrockbet_oh', -111),
      ],
    }],
  });
  const hrFirst = await full(quoteLeg('hardrockbet'));
  assert.strictEqual(hrFirst.book, 'hardrockbet');
  assert.strictEqual(hrFirst.american, -112);
  const dkFirst = await full(quoteLeg('draftkings'));
  assert.strictEqual(dkFirst.book, 'draftkings');
  assert.strictEqual(dkFirst.american, -115);
  const mgm = await full(quoteLeg('betmgm'));
  assert.strictEqual(mgm.book, 'draftkings');
  assert.notStrictEqual(mgm.book, 'betmgm');
  const pin = await full(quoteLeg('pinnacle'));
  assert.strictEqual(pin.book, 'draftkings');
  const aliasBook = await full(quoteLeg('hardrock'));
  assert.strictEqual(aliasBook.book, 'hardrock');
  assert.strictEqual(aliasBook.american, -118);
  const oh = await full(quoteLeg('hardrockbet_oh'));
  assert.strictEqual(oh.book, 'hardrockbet_oh');
  for (const book of ['pinnacle', 'fanduel', 'betmgm', 'onexbet', 'bovada', 'draftkings', 'hardrockbet', 'hardrock']) {
    const quote = await full(quoteLeg(book));
    assert.ok(quote, book);
    assert.ok(DK_HR.has(String(quote.book).toLowerCase()), `${book} rechecked to ${quote.book}`);
  }

  const offshore = v2.recheckFromCachedBoard({
    americanfootball_nfl: [{
      home_team: 'Kansas City Chiefs',
      away_team: 'Buffalo Bills',
      bookmakers: [
        h2h('pinnacle', -102),
        h2h('fanduel', -108),
        h2h('betmgm', -109),
        h2h('onexbet', -100),
      ],
    }],
  });
  for (const book of ['pinnacle', 'fanduel', 'betmgm', 'onexbet']) {
    assert.strictEqual(await offshore(quoteLeg(book)), null, `${book} must not reprice a leg`);
  }

  console.log('PASS test-omega-v2-dkhr-price');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
