'use strict';

/**
 * v2 pregame cutoff. A leg is out when commenceTime <= asOf + 5 minutes.
 * asOf is opts.pregameAsOfMs for replay, otherwise Date.now().
 * QA removes a started leg and does not block the card.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const AS_OF = Date.parse('2026-10-31T16:06:48Z');
const GRACE = 5 * 60 * 1000;
const STARTED = '2026-10-31T16:00:00Z';

assert.strictEqual(v2.PREGAME_GRACE_MS, GRACE);
assert.strictEqual(v2.pastPregameCutoff(STARTED, AS_OF), true, '16:00 is inside 16:06:48 + 5 min');
assert.strictEqual(v2.pastPregameCutoff(new Date(AS_OF - 2 * 60 * 1000).toISOString(), AS_OF), true);
assert.strictEqual(v2.pastPregameCutoff(new Date(AS_OF + GRACE).toISOString(), AS_OF), true, 'cutoff is inclusive');
assert.strictEqual(v2.pastPregameCutoff(new Date(AS_OF + GRACE + 1).toISOString(), AS_OF), false);
assert.strictEqual(v2.pastPregameCutoff('', AS_OF), false);
assert.strictEqual(v2.pregameClockMs({ pregameAsOfMs: AS_OF }), AS_OF);
assert.ok(Math.abs(v2.pregameClockMs({}) - Date.now()) < 2000);

function candidate(over) {
  return {
    sport: 'NCAAF',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeTeam: 'Kansas City Chiefs',
    pick: 'Kansas City Chiefs ML',
    side: 'Kansas City Chiefs ML',
    market: 'Moneyline',
    odds: '-110',
    book: 'draftkings',
    pModel: 0.62,
    pMkt: 0.52,
    uncertainty: 0.18,
    commenceTime: new Date(AS_OF + 3 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function poolLeg(over) {
  return {
    sport: 'NCAAF',
    matchup: 'A @ B',
    pick: 'B ML',
    market: 'Moneyline',
    odds: -110,
    edge: 0.03,
    edgeNovig: 0.04,
    ev: 0.05,
    qualified: true,
    parlayQualified: true,
    calibration: { pCal: 0.56 },
    gameKey: 'a @ b',
    commenceTime: new Date(AS_OF + 3 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function mentionsStarted(card) {
  const blob = JSON.stringify({
    picks: card.picks,
    parlayLegs: card.parlayLegs,
    parlayPool: card.parlayPool,
  });
  return /Bowling Green|Western Michigan|Over 45"/.test(blob);
}

(async () => {
  const started = candidate({
    matchup: 'Bowling Green @ Western Michigan',
    awayTeam: 'Bowling Green',
    homeTeam: 'Western Michigan',
    pick: 'Over 45',
    side: 'Over 45',
    market: 'Total',
    line: 45,
    commenceTime: STARTED,
  });
  const laterMl = candidate({});
  const laterTotal = candidate({
    matchup: 'Dallas Cowboys @ Philadelphia Eagles',
    awayTeam: 'Dallas Cowboys',
    homeTeam: 'Philadelphia Eagles',
    pick: 'Over 45.5',
    side: 'Over 45.5',
    market: 'Total',
    line: 45.5,
  });
  const card = await v2.buildCard({
    date: '2026-10-31',
    pregameAsOfMs: AS_OF,
    candidates: [started, laterMl, laterTotal],
    history: [],
  });
  assert.strictEqual(mentionsStarted(card), false, 'started game must leave the published card and the parlay pool');
  assert.ok(card.rejections.some((row) => row.reason === 'in-progress-or-started' && /Bowling Green/.test(row.matchup)));
  assert.ok(card.picks.length >= 1);
  assert.ok(card.parlayLegs.length === 1, 'the two later games still make a ticket');
  assert.ok(card.parlayLegs[0].legs.every((leg) => !/Bowling/.test(leg.matchup)));

  const cutoff = new Date(AS_OF + GRACE).toISOString();
  const justAfter = new Date(AS_OF + GRACE + 1).toISOString();
  const boundary = await v2.buildCard({
    date: '2026-10-31',
    pregameAsOfMs: AS_OF,
    candidates: [
      candidate({
        matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B', pick: 'B ML', side: 'B ML', commenceTime: cutoff,
      }),
      candidate({
        matchup: 'C @ D', awayTeam: 'C', homeTeam: 'D', pick: 'D ML', side: 'D ML', commenceTime: justAfter,
      }),
    ],
    history: [],
  });
  assert.ok(boundary.rejections.some((row) => row.reason === 'in-progress-or-started' && row.matchup === 'A @ B'));
  assert.ok(!boundary.rejections.some((row) => row.reason === 'in-progress-or-started' && row.matchup === 'C @ D'));
  assert.ok(boundary.picks.some((pick) => pick.matchup === 'C @ D'));
  assert.ok(!boundary.picks.some((pick) => pick.matchup === 'A @ B'));
  assert.ok(!boundary.parlayPool.some((row) => row.matchup === 'A @ B'));

  const replayAsOf = Date.parse('2026-09-15T13:00:00Z');
  const evening = '2026-09-15T23:05:00Z';
  assert.ok(Date.parse(evening) < Date.now() - GRACE, 'fixture kickoff is already in the past vs wall clock');
  assert.ok(Date.parse(evening) > replayAsOf + GRACE);
  const replay = await v2.buildCard({
    date: '2026-09-15',
    pregameAsOfMs: replayAsOf,
    candidates: [candidate({
      matchup: 'A @ B', awayTeam: 'A', homeTeam: 'B', pick: 'B ML', side: 'B ML', commenceTime: evening,
    })],
    history: [],
  });
  assert.ok(!replay.rejections.some((row) => row.reason === 'in-progress-or-started'));
  assert.strictEqual(replay.picks.length, 1);
  assert.strictEqual(replay.picks[0].commenceTime, evening);

  const live = await v2.buildCard({
    date: '2026-10-31',
    candidates: [
      candidate({
        matchup: 'Old @ Game', awayTeam: 'Old', homeTeam: 'Game', pick: 'Game ML', side: 'Game ML',
        commenceTime: '2020-01-01T00:00:00Z',
      }),
      candidate({
        matchup: 'New @ Game', awayTeam: 'New', homeTeam: 'Game', pick: 'Game ML', side: 'Game ML',
        commenceTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ],
    history: [],
  });
  assert.ok(live.rejections.some((row) => row.reason === 'in-progress-or-started' && row.matchup === 'Old @ Game'));
  assert.ok(!live.picks.some((pick) => pick.matchup === 'Old @ Game'));
  assert.ok(!live.parlayPool.some((row) => row.matchup === 'Old @ Game'));
  assert.ok(live.picks.some((pick) => pick.matchup === 'New @ Game'));

  const future = new Date(AS_OF + 3 * 60 * 60 * 1000).toISOString();
  const bg = poolLeg({
    matchup: 'Bowling Green @ Western Michigan',
    pick: 'Over 45',
    market: 'Total',
    gameKey: 'bowling green @ western michigan',
    commenceTime: STARTED,
  });
  const ml = poolLeg({ matchup: 'A @ B', pick: 'A ML', gameKey: 'a @ b' });
  const total = poolLeg({
    matchup: 'C @ D', pick: 'Over 44', market: 'Total', gameKey: 'c @ d',
  });
  const straights = v2.selectStraights([bg, ml, total], { pregameAsOfMs: AS_OF });
  assert.deepStrictEqual(straights.map((row) => row.pick).sort(), ['A ML', 'Over 44']);
  const ticket = v2.sizeParlay([bg, ml, total], [], { pregameAsOfMs: AS_OF });
  assert.strictEqual(ticket.publish, true);
  assert.strictEqual(ticket.legs.length, 2);
  assert.ok(ticket.legs.every((leg) => !/Bowling/.test(leg.matchup)));

  const dirty = {
    modelVersion: v2.MODEL_VERSION,
    leakageChecked: true,
    picks: [
      {
        sport: 'NCAAF',
        matchup: 'Bowling Green @ Western Michigan',
        pick: 'Over 45',
        market: 'Total',
        odds: '-110',
        units: '1u',
        unitsNum: 1,
        evRaw: 0.05,
        commenceTime: STARTED,
        modelVersion: v2.MODEL_VERSION,
      },
      {
        sport: 'NFL',
        matchup: 'Buffalo Bills @ Kansas City Chiefs',
        pick: 'Kansas City Chiefs ML',
        market: 'Moneyline',
        odds: '-110',
        units: '1u',
        unitsNum: 1,
        evRaw: 0.04,
        commenceTime: future,
        modelVersion: v2.MODEL_VERSION,
      },
    ],
    parlayLegs: [{
      type: '2-leg',
      units: '0.5u',
      unitsNum: 0.5,
      modelVersion: v2.MODEL_VERSION,
      legs: [
        {
          pick: 'Over 45',
          matchup: 'Bowling Green @ Western Michigan',
          market: 'Total',
          odds: '-110',
          edgeNovig: 0.02,
          commenceTime: STARTED,
          modelVersion: v2.MODEL_VERSION,
        },
        {
          pick: 'Kansas City Chiefs ML',
          matchup: 'Buffalo Bills @ Kansas City Chiefs',
          market: 'Moneyline',
          odds: '-110',
          edgeNovig: 0.02,
          commenceTime: future,
          modelVersion: v2.MODEL_VERSION,
        },
      ],
    }],
  };
  assert.deepStrictEqual(v2.validateCard(dirty), [], 'a started leg is not a blocking validation error');
  const fixed = v2.autoCorrectCard(dirty, { pregameAsOfMs: AS_OF });
  assert.ok(!fixed.picks.some((pick) => /Bowling/.test(pick.matchup)));
  assert.ok(fixed.picks.some((pick) => /Kansas City/.test(pick.matchup)));
  assert.strictEqual(fixed.parlayLegs.length, 0);
  assert.ok(fixed.qaNotes.some((note) => /removed started straight/.test(note)));
  assert.ok(fixed.qaNotes.some((note) => /removed started parlay leg/.test(note)));
  assert.deepStrictEqual(v2.validateCard(fixed), [], `QA must not block: ${v2.validateCard(fixed).join('; ')}`);

  console.log('PASS test-omega-v2-pregame');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
