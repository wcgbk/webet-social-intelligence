'use strict';

/**
 * Placeable DK/HR number, and a parlay that is the product of independent legs.
 * No network. An empty card is a published card.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const DATE = '2026-10-20';

function strong(matchup, pick, market, over) {
  return {
    sport: 'NFL',
    matchup,
    pick,
    market,
    odds: '-110',
    book: 'draftkings',
    pModel: 0.68,
    pMkt: 0.50,
    uncertainty: 0.18,
    commenceTime: FUTURE,
    line: market === 'Total' ? 45.5 : (market === 'Spread' ? -3.5 : null),
    homeTeam: over && over.homeTeam,
    awayTeam: over && over.awayTeam,
    ...over,
  };
}

function assertQuarter(units, cap) {
  assert.ok(units >= 0.25 && units <= cap, `units ${units}`);
  assert.ok(Math.abs(units * 4 - Math.round(units * 4)) < 1e-9, `not a 0.25 step: ${units}`);
}

function stakeOf(units) {
  return Math.ceil(units * 150 - 1e-9);
}

function legEv(leg) {
  return leg.pCal * americanToDecimal(leg.odds) - 1;
}

(async () => {
  const mlTotal = v2.pairRule(
    { matchup: 'A @ B', pick: 'A ML', market: 'Moneyline', homeTeam: 'B', awayTeam: 'A' },
    { matchup: 'A @ B', pick: 'Over 45.5', market: 'Total', line: 45.5, homeTeam: 'B', awayTeam: 'A' },
  );
  assert.strictEqual(mlTotal.ok, false);
  assert.strictEqual(mlTotal.reason, 'same-game');

  const spreadTotal = v2.pairRule(
    { matchup: 'A @ B', pick: 'A -3.5', market: 'Spread', line: -3.5, homeTeam: 'B', awayTeam: 'A' },
    { matchup: 'A @ B', pick: 'Over 45.5', market: 'Total', line: 45.5, homeTeam: 'B', awayTeam: 'A' },
  );
  assert.strictEqual(spreadTotal.reason, 'same-game');

  const sameTeam = v2.pairRule(
    {
      matchup: 'Kansas City Chiefs @ Buffalo Bills',
      pick: 'Kansas City Chiefs ML',
      market: 'Moneyline',
      homeTeam: 'Buffalo Bills',
      awayTeam: 'Kansas City Chiefs',
    },
    {
      matchup: 'Las Vegas Raiders @ Kansas City Chiefs',
      pick: 'Over 47.5',
      market: 'Total',
      line: 47.5,
      homeTeam: 'Kansas City Chiefs',
      awayTeam: 'Las Vegas Raiders',
    },
  );
  assert.strictEqual(sameTeam.ok, false);
  assert.strictEqual(sameTeam.reason, 'same-team');

  const cross = v2.pairRule(
    { matchup: 'A @ B', pick: 'A ML', market: 'Moneyline', homeTeam: 'B', awayTeam: 'A' },
    { matchup: 'C @ D', pick: 'Over 45.5', market: 'Total', line: 45.5, homeTeam: 'D', awayTeam: 'C' },
  );
  assert.strictEqual(cross.ok, true);
  assert.strictEqual(cross.phi, 0);

  const emptyClubs = v2.pairRule(
    { matchup: 'A @ B', pick: 'Over 40', market: 'Total', line: 40 },
    { matchup: 'C @ D', pick: 'Over 50', market: 'Total', line: 50 },
  );
  assert.strictEqual(emptyClubs.ok, true, 'a total with no club names is not a same-team pair');

  const scored = v2.scoreLegs([
    { matchup: 'A @ B', pick: 'A ML', market: 'Moneyline', odds: -110, homeTeam: 'B', awayTeam: 'A', calibration: { pCal: 0.55 } },
    { matchup: 'C @ D', pick: 'Over 45.5', market: 'Total', odds: -110, line: 45.5, homeTeam: 'D', awayTeam: 'C', calibration: { pCal: 0.60 } },
  ]);
  assert.ok(scored);
  assert.ok(Math.abs(scored.pJoint - 0.55 * 0.60) < 1e-12);
  assert.strictEqual(scored.prob, scored.pJoint);
  assert.strictEqual(scored.factor, 1);
  assert.strictEqual(v2.scoreLegs([
    { matchup: 'A @ B', pick: 'A ML', market: 'Moneyline', odds: -110, homeTeam: 'B', awayTeam: 'A', calibration: { pCal: 0.55 } },
    { matchup: 'A @ B', pick: 'Over 45.5', market: 'Total', odds: -110, line: 45.5, homeTeam: 'B', awayTeam: 'A', calibration: { pCal: 0.60 } },
  ]), null);

  const borrowed = v2.quotedLeg({
    odds: -110,
    line: -3.5,
    book: 'draftkings',
    bestDkHr: { american: -105, book: 'draftkings', point: -2.5 },
  });
  assert.strictEqual(borrowed, null);
  const offshore = v2.quotedLeg({
    odds: 200,
    line: null,
    book: 'draftkings',
    bestDkHr: { american: 250, book: 'pinnacle' },
  });
  assert.strictEqual(offshore, null);
  const unbooked = v2.quotedLeg({ odds: -110, line: null, book: '', pick: 'A ML' });
  assert.ok(unbooked);
  assert.strictEqual(unbooked.odds, -110);

  const open = v2.annotateCandidate({
    odds: -110,
    calibration: { pCal: 0.60, pMkt: 0.50, pShrink: 0.60 },
  });
  assert.strictEqual(open.qualified, true, open.rejectReason);
  const offBook = v2.annotateCandidate({
    odds: 200,
    book: 'pinnacle',
    calibration: { pCal: 0.60, pMkt: 0.50, pShrink: 0.60 },
  });
  assert.strictEqual(offBook.qualified, false);
  assert.strictEqual(offBook.parlayQualified, false);
  assert.strictEqual(offBook.rejectReason, 'no-dk-hr-price');
  const wrongNumber = v2.annotateCandidate({
    odds: -105,
    line: -3.5,
    book: 'draftkings',
    bestDkHr: { american: -105, book: 'draftkings', line: -2.5 },
    calibration: { pCal: 0.60, pMkt: 0.50, pShrink: 0.60 },
  });
  assert.strictEqual(wrongNumber.qualified, false);
  assert.strictEqual(wrongNumber.rejectReason, 'dk-hr-line-mismatch');

  const empty = await v2.buildCard({ date: DATE, candidates: [], history: [] });
  assert.strictEqual(empty.pass, true);
  assert.strictEqual(empty.picks.length, 0);
  assert.strictEqual(empty.parlayLegs.length, 0);

  const one = await v2.buildCard({
    date: DATE,
    candidates: [strong('A @ B', 'A ML', 'Moneyline', { awayTeam: 'A', homeTeam: 'B' })],
    history: [],
  });
  assert.strictEqual(one.picks.length, 1, 'a short card is not filled');
  assert.strictEqual(one.parlayLegs.length, 0);
  assert.strictEqual(one.pass, false);

  const sameGame = await v2.buildCard({
    date: DATE,
    candidates: [
      strong('Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline', {
        awayTeam: 'Buffalo Bills', homeTeam: 'Kansas City Chiefs', line: null,
      }),
      strong('Buffalo Bills @ Kansas City Chiefs', 'Over 45.5', 'Total', {
        awayTeam: 'Buffalo Bills', homeTeam: 'Kansas City Chiefs', line: 45.5,
      }),
    ],
    history: [],
  });
  assert.strictEqual(sameGame.parlayLegs.length, 0, 'same-game ML+total is not a ticket');
  assert.strictEqual(sameGame.picks.length, 1);
  assert.strictEqual(sameGame.pass, false);

  const twoClubs = await v2.buildCard({
    date: DATE,
    candidates: [
      strong('Kansas City Chiefs @ Buffalo Bills', 'Kansas City Chiefs ML', 'Moneyline', {
        awayTeam: 'Kansas City Chiefs', homeTeam: 'Buffalo Bills', line: null,
      }),
      strong('Las Vegas Raiders @ Kansas City Chiefs', 'Over 47.5', 'Total', {
        awayTeam: 'Las Vegas Raiders', homeTeam: 'Kansas City Chiefs', line: 47.5,
      }),
    ],
    history: [],
  });
  assert.strictEqual(twoClubs.parlayLegs.length, 0, 'same club across games is not a ticket');
  assert.ok(twoClubs.picks.length >= 1);

  const ticket = await v2.buildCard({
    date: DATE,
    candidates: [
      strong('Buffalo Bills @ Kansas City Chiefs', 'Buffalo Bills ML', 'Moneyline', {
        awayTeam: 'Buffalo Bills', homeTeam: 'Kansas City Chiefs', line: null,
      }),
      strong('Dallas Cowboys @ Philadelphia Eagles', 'Over 45.5', 'Total', {
        awayTeam: 'Dallas Cowboys', homeTeam: 'Philadelphia Eagles', line: 45.5,
      }),
    ],
    history: [],
  });
  assert.strictEqual(ticket.parlayLegs.length, 1);
  const parlay = ticket.parlayLegs[0];
  assert.strictEqual(parlay.legs.length, 2);
  assert.strictEqual(Number(parlay.correlationFactor), 1);
  const product = parlay.legs.reduce((p, leg) => p * leg.pCal, 1);
  assert.ok(Math.abs(parlay.pJoint - product) < 1e-9, `${parlay.pJoint} vs ${product}`);
  assertQuarter(parlay.unitsNum, 1);
  assert.strictEqual(parlay.stakeUsd, stakeOf(parlay.unitsNum));
  for (const leg of parlay.legs) {
    assert.ok(leg.book === 'draftkings' || leg.book === 'hardrockbet', leg.book);
    assert.ok(legEv(leg) > 0, `${leg.pick} ${legEv(leg)}`);
  }
  assert.ok(!/alpha|omega/i.test(parlay.correlationNote || ''));

  const mismatch = await v2.buildCard({
    date: DATE,
    candidates: [strong('A @ B', 'A -3.5', 'Spread', {
      awayTeam: 'A',
      homeTeam: 'B',
      line: -3.5,
      odds: '-110',
      bestDkHr: { american: -105, book: 'draftkings', point: -2.5 },
    })],
    history: [],
  });
  assert.strictEqual(mismatch.picks.length, 0);
  assert.strictEqual(mismatch.parlayLegs.length, 0);
  assert.strictEqual(mismatch.pass, true);
  assert.ok(mismatch.rejections.some((row) => row.reason === 'dk-hr-line-mismatch'));
  assert.ok(!JSON.stringify(mismatch.picks).includes('-105'));
  assert.ok(!JSON.stringify(mismatch.parlayLegs).includes('-105'));

  const moved = await v2.buildCard({
    date: DATE,
    candidates: [strong('A @ B', 'A -3.5', 'Spread', { awayTeam: 'A', homeTeam: 'B', line: -3.5 })],
    history: [],
    recheck: async () => ({ american: -110, line: -2.5, book: 'draftkings' }),
  });
  assert.ok(!moved.picks.some((pick) => pick.pick === 'A -3.5'));
  assert.ok(moved.rejections.some((row) => row.reason === 'dk-hr-line-mismatch'));

  const repriced = await v2.buildCard({
    date: DATE,
    candidates: [strong('A @ B', 'A ML', 'Moneyline', { awayTeam: 'A', homeTeam: 'B', line: null })],
    history: [],
    recheck: async () => ({ american: -115, line: null, book: 'draftkings' }),
  });
  assert.strictEqual(repriced.picks.length, 1);
  assert.strictEqual(repriced.picks[0].odds, '-115');
  assert.strictEqual(repriced.picks[0].book, 'draftkings');
  assertQuarter(repriced.picks[0].unitsNum, 2);
  assert.strictEqual(repriced.picks[0].stakeUsd, stakeOf(repriced.picks[0].unitsNum));
  assert.ok(repriced.picks[0].pCal * americanToDecimal(-115) - 1 > 0);

  const ignored = await v2.buildCard({
    date: DATE,
    candidates: [strong('C @ D', 'C ML', 'Moneyline', { awayTeam: 'C', homeTeam: 'D', line: null })],
    history: [],
    recheck: async () => ({ american: 150, line: null, book: 'pinnacle' }),
  });
  assert.strictEqual(ignored.picks.length, 1);
  assert.strictEqual(ignored.picks[0].odds, '-110');
  assert.strictEqual(ignored.picks[0].book, 'draftkings');

  const capped = v2.sizeParlay([
    {
      sport: 'NFL', matchup: 'A @ B', pick: 'A ML', market: 'Moneyline', odds: 200,
      book: 'draftkings', edgeNovig: 0.2, parlayQualified: true, calibration: { pCal: 0.70 },
      homeTeam: 'B', awayTeam: 'A',
    },
    {
      sport: 'NFL', matchup: 'C @ D', pick: 'C ML', market: 'Moneyline', odds: 200,
      book: 'draftkings', edgeNovig: 0.2, parlayQualified: true, calibration: { pCal: 0.70 },
      homeTeam: 'D', awayTeam: 'C',
    },
  ], []);
  assert.strictEqual(capped.publish, true);
  assert.strictEqual(capped.units, 1);
  assert.strictEqual(capped.stakeUsd, 150);
  assert.ok(Math.abs(capped.pJoint - 0.49) < 1e-12);

  const exact = v2.recheckFromCachedBoard({
    americanfootball_nfl: [{
      home_team: 'Kansas City Chiefs',
      away_team: 'Buffalo Bills',
      bookmakers: [{
        key: 'draftkings',
        markets: [{
          key: 'spreads',
          outcomes: [
            { name: 'Buffalo Bills', price: -108, point: -3.5 },
            { name: 'Buffalo Bills', price: -110, point: -3 },
          ],
        }],
      }],
    }],
  });
  const onNumber = await exact({
    pick: 'Buffalo Bills -3.5',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    market: 'Spread',
    line: -3.5,
    book: 'draftkings',
  });
  assert.strictEqual(onNumber.american, -108);
  assert.strictEqual(onNumber.line, -3.5);
  const offNumber = await exact({
    pick: 'Buffalo Bills -4',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    market: 'Spread',
    line: -4,
    book: 'draftkings',
  });
  assert.strictEqual(offNumber, null);

  const corrected = v2.autoCorrectCard({
    modelVersion: v2.MODEL_VERSION,
    leakageChecked: true,
    picks: [],
    parlayLegs: [{
      type: '2-leg',
      units: '0.25u',
      unitsNum: 0.25,
      stakeUsd: 38,
      modelVersion: v2.MODEL_VERSION,
      legs: [
        {
          pick: 'A ML', matchup: 'A @ B', market: 'Moneyline', odds: '-110', book: 'draftkings',
          edgePct: '4.0%', homeTeam: 'B', awayTeam: 'A', modelVersion: v2.MODEL_VERSION,
        },
        {
          pick: 'Over 45.5', matchup: 'A @ B', market: 'Total', odds: '-110', line: 45.5, book: 'draftkings',
          edgePct: '4.0%', homeTeam: 'B', awayTeam: 'A', modelVersion: v2.MODEL_VERSION,
        },
      ],
    }],
  }, { pregameAsOfMs: Date.parse(FUTURE) - 60 * 60 * 1000 });
  assert.strictEqual(corrected.parlayLegs.length, 0);
  assert.strictEqual(corrected.pass, true);
  assert.ok((corrected.qaNotes || []).some((note) => /same-game/.test(note)));

  console.log('PASS test-omega-v2-place-parlay');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
