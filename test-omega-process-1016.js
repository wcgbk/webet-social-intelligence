'use strict';
// Card identity and the additive 2-leg / 3-leg grade split.
// aggregateDays keeps the keys frozen at git 50d3eb9.
const assert = require('assert');
const { checkCardIdentity } = require('./netlify/functions/lib/omega-vnext/card_identity');
const results = require('./netlify/functions/get-results-omega')._test;

function straight(extra) {
  return {
    sport: extra.sport,
    matchup: extra.matchup,
    awayTeam: extra.awayTeam,
    homeTeam: extra.homeTeam,
    pick: extra.pick,
    odds: extra.odds,
    coverProb: extra.coverProb,
    edge: extra.edge,
    ev: extra.ev,
  };
}

const penguins = straight({
  sport: 'NHL',
  matchup: 'Pittsburgh Penguins @ Colorado Avalanche',
  awayTeam: 'Pittsburgh Penguins',
  homeTeam: 'Colorado Avalanche',
  pick: 'Penguins +1.5',
  odds: '-142',
  coverProb: '63.4%',
  edge: '4.7%',
  ev: '8.0%',
});
const tulane = straight({
  sport: 'NCAAF',
  matchup: 'Memphis @ Tulane',
  awayTeam: 'Memphis',
  homeTeam: 'Tulane',
  pick: 'Tulane ML',
  odds: '+220',
  coverProb: '32.8%',
  edge: '1.6%',
  ev: '5.0%',
});

function twoTeamTicket(legs, ev) {
  return {
    type: '2-leg-parlay',
    qualifying: true,
    units: '0.5u',
    combinedOdds: '+445',
    combinedProb: '20.8%',
    ev: ev == null ? '13.4%' : ev,
    legs,
  };
}

const friday = {
  picks: [penguins, tulane],
  parlayLegs: [twoTeamTicket([
    { ...penguins },
    { ...tulane },
  ])],
};
const before = JSON.stringify(friday);
const fridayId = checkCardIdentity(friday);
assert.strictEqual(fridayId.ok, true, fridayId.issues.join('; '));
assert.strictEqual(JSON.stringify(friday), before, 'identity must not change the card');

const drifted = {
  picks: [{ ...penguins, ev: '8.1%' }, tulane],
  parlayLegs: [twoTeamTicket([{ ...penguins, ev: '8.0%' }, { ...tulane }])],
};
const driftedId = checkCardIdentity(drifted);
assert.strictEqual(driftedId.ok, false);
assert.ok(driftedId.issues.some((line) => /EV 8\.1%/.test(line)));

const noParlay = { picks: [penguins, tulane], parlayLegs: [] };
const noParlayId = checkCardIdentity(noParlay);
assert.strictEqual(noParlayId.ok, false);
assert.ok(noParlayId.issues.some((line) => /no parlay/.test(line)));

const oneStraight = {
  picks: [penguins],
  parlayLegs: [twoTeamTicket([{ ...penguins }, { ...tulane }])],
};
assert.strictEqual(checkCardIdentity(oneStraight).ok, false);

const sameGame = {
  picks: [
    penguins,
    { ...penguins, pick: 'Penguins ML', odds: '+165', coverProb: '45.0%', edge: '7.2%', ev: '19.2%' },
  ],
  parlayLegs: [twoTeamTicket([
    { ...penguins },
    { ...penguins, pick: 'Penguins ML', odds: '+165', coverProb: '45.0%', ev: '19.2%' },
  ])],
};
assert.ok(checkCardIdentity(sameGame).issues.some((line) => /same-game/.test(line)));

const third = straight({
  sport: 'NHL',
  matchup: 'Boston Bruins @ Anaheim Ducks',
  awayTeam: 'Boston Bruins',
  homeTeam: 'Anaheim Ducks',
  pick: 'Bruins ML',
  odds: '-118',
  coverProb: '56.0%',
  edge: '1.9%',
  ev: '3.5%',
});
const threeNoTicket = { picks: [penguins, tulane, third], parlayLegs: [] };
assert.strictEqual(checkCardIdentity(threeNoTicket).ok, true, 'three straights may have no parlay');
const threeShortcut = {
  picks: [penguins, tulane, third],
  parlayLegs: [twoTeamTicket([{ ...penguins }, { ...tulane }])],
};
assert.ok(checkCardIdentity(threeShortcut).issues.some((line) => /2-leg/.test(line)));

const threeLeg = {
  picks: [penguins, tulane, third],
  parlayLegs: [{
    type: '3-leg-parlay',
    qualifying: true,
    legs: [{ ...penguins }, { ...tulane }, { ...third }],
  }],
};
assert.strictEqual(checkCardIdentity(threeLeg).ok, true, checkCardIdentity(threeLeg).issues.join('; '));

const negativePair = {
  picks: [
    { ...penguins, coverProb: null, edge: null, ev: '-1.0%' },
    { ...tulane, coverProb: null, edge: null, ev: '-2.0%' },
  ],
  parlayLegs: [],
};
assert.strictEqual(checkCardIdentity(negativePair).ok, true);

const oldRow = { picks: [{ sport: 'NFL', matchup: 'A @ B', pick: 'A ML', odds: '-110' }] };
assert.strictEqual(checkCardIdentity(oldRow).ok, true, 'a row with no printed win rate is not failed');

const days = [
  { date: '2026-10-16', parlayResult: 'win', parlayProfit: 334, parlayRisk: 75, parlayLegs: 2, picks: [] },
  { date: '2026-10-15', parlayResult: 'loss', parlayProfit: -75, parlayRisk: 75, parlayLegs: 3, picks: [] },
  { date: '2026-10-14', parlayResult: 'pending', parlayProfit: 0, parlayRisk: 75, parlayLegs: 2, picks: [] },
  { date: '2026-10-13', parlayResult: 'loss', parlayProfit: -75, parlayRisk: 75, picks: [{ sport: 'PARLAY', pick: 'Parlay' }] },
  { date: '2026-10-08', parlayResult: 'push', parlayProfit: 0, parlayRisk: 75, parlayLegs: 3, picks: [] },
  { date: '2026-10-06', parlayResult: 'push', parlayProfit: 0, parlayRisk: 75, parlayLegs: 3, picks: [] },
  { date: '2026-10-12', parlayResult: 'skip', parlayProfit: 0, parlayRisk: 0, parlayLegs: 0, picks: [] },
];
const splits = results.parlaySplits(days);
assert.strictEqual(splits['2'].wins, 1);
assert.strictEqual(splits['2'].pending, 1);
assert.strictEqual(splits['2'].totalWagered, 75);
assert.strictEqual(splits['2'].totalProfit, 334);
assert.strictEqual(splits['3'].losses, 1);
assert.strictEqual(splits['3'].pushes, 2);
assert.strictEqual(splits['3'].totalWagered, 150, 'v2 push is free; the pre-v2 push still counts');
assert.strictEqual(splits.unsplit.losses, 1);
assert.strictEqual(splits.unsplit.totalWagered, 75);
const agg = results.aggregateDays(days);
assert.deepStrictEqual(Object.keys(agg).sort(), ['cumulative', 'parlay', 'straight']);
const bucketWager = splits['2'].totalWagered + splits['3'].totalWagered + splits.unsplit.totalWagered;
assert.strictEqual(bucketWager, agg.parlay.totalWagered);
assert.strictEqual(splits['2'].wins + splits['3'].wins, agg.parlay.wins);
assert.strictEqual(splits['3'].losses + splits.unsplit.losses, agg.parlay.losses);

async function gradeShape() {
  const day = await results.gradeDay('2026-10-16', {
    picks: [
      { sport: 'NHL', matchup: 'Pittsburgh Penguins @ Colorado Avalanche', pick: 'Penguins +1.5', odds: '-142', units: '1u' },
      { sport: 'NCAAF', matchup: 'Memphis @ Tulane', pick: 'Tulane ML', odds: '+220', units: '0.5u' },
    ],
    parlayLegs: [twoTeamTicket([
      { sport: 'NHL', matchup: 'Pittsburgh Penguins @ Colorado Avalanche', pick: 'Penguins +1.5', odds: '-142' },
      { sport: 'NCAAF', matchup: 'Memphis @ Tulane', pick: 'Tulane ML', odds: '+220' },
    ])],
  }, { games: [] });
  assert.strictEqual(day.parlayLegs, 2);
  assert.strictEqual(day.parlayResult, 'pending');
  const none = results.recomputeParlayFields(day, { picks: day.picks, parlayLegs: [] });
  assert.strictEqual(none.parlayLegs, 0);
  assert.strictEqual(day.parlayLegs, 2, 'recompute must not mutate the stored day');
}

gradeShape().then(() => {
  console.log('ok card identity and parlay splits');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
