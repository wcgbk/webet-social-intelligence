'use strict';
// Page 1 / page 9: one unit is $150 on a $10,000 bankroll (1.5%).
// gradeDayBody prices dollar profit at that unit. No behavior change.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { summaryStakeDisplay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { gradeDayBody } = require('./netlify/functions/get-results-omega')._test;

assert.strictEqual(config.UNIT_DOLLARS, 150);
assert.strictEqual(config.UNIT_DOLLARS / 10000, 0.015);

function wholeUp(n) {
  return Math.ceil((n || 0) - 1e-9);
}

function finalGame(awayScore, homeScore) {
  return {
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    awayTeam: 'Boston Red Sox',
    homeTeam: 'New York Yankees',
    awayAbbr: 'BOS',
    homeAbbr: 'NYY',
    awayScore: awayScore,
    homeScore: homeScore,
    awayInnings: 9,
    homeInnings: 9,
    startISO: '2026-10-07T23:05:00Z',
    _sport: 'MLB',
  };
}

function mlPick(selection, units, odds) {
  return {
    sport: 'MLB',
    matchup: 'Boston Red Sox @ New York Yankees',
    pick: selection,
    betType: 'moneyline',
    odds: odds,
    units: units,
    commenceTime: '2026-10-07T23:05:00Z',
  };
}

async function grade(pick) {
  return gradeDayBody('2026-10-07', { picks: [pick] }, { games: [finalGame(5, 2)] });
}

async function main() {
  const unit = config.UNIT_DOLLARS;

  const loss = await grade(mlPick('New York Yankees ML', '1u', '-110'));
  assert.strictEqual(loss.picks[0].result, 'loss');
  assert.strictEqual(loss.picks.length, 1, 'one straight does not invent a parlay row');
  assert.strictEqual(loss.picks[0].profit, -unit);
  assert.strictEqual(loss.profit, -unit);
  assert.strictEqual(loss.wagered, unit);

  const two = await grade(mlPick('New York Yankees ML', '2u', '+100'));
  assert.strictEqual(two.picks[0].result, 'loss');
  assert.strictEqual(two.picks[0].profit, -2 * unit);
  assert.strictEqual(two.profit, -2 * unit);
  assert.strictEqual(two.wagered, 2 * unit);

  const even = await grade(mlPick('Boston Red Sox ML', '1u', '+100'));
  assert.strictEqual(even.picks[0].result, 'win');
  assert.strictEqual(even.picks[0].profit, unit);
  assert.strictEqual(even.profit, unit);

  const juice = await grade(mlPick('Boston Red Sox ML', '1u', '-110'));
  const expectedWin = wholeUp(unit * (100 / 110));
  assert.strictEqual(expectedWin, 137);
  assert.strictEqual(juice.picks[0].result, 'win');
  assert.strictEqual(juice.picks[0].profit, expectedWin);
  assert.strictEqual(juice.profit, expectedWin);
  assert.strictEqual(juice.wagered, unit);

  // Summary display only. 0.5u straights and a 0.25u parlay each ceil to 1u at $150.
  // The stake fields themselves stay fractional.
  const straight = { units: '0.5u' };
  const ticket = { units: '0.25u', type: '3-leg-parlay-labeled', qualifying: true };
  const shown = summaryStakeDisplay([straight, { units: '0.5u' }, { units: '0.5u' }], [ticket]);
  assert.strictEqual(shown.totalUnits, '1.75u');
  assert.strictEqual(shown.totalDollars, 263);
  assert.strictEqual(straight.units, '0.5u');
  assert.strictEqual(ticket.units, '0.25u');
  const marker = summaryStakeDisplay(
    [{ units: '1.25u' }],
    [{ units: '0.25u', qualifying: false, type: 'no-qualifying-parlay' }]
  );
  assert.strictEqual(marker.totalUnits, '1.25u');
  assert.strictEqual(marker.totalDollars, 188);
  assert.strictEqual(summaryStakeDisplay([{ units: '1u' }], []).totalUnits, '1u');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
