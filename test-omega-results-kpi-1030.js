#!/usr/bin/env node
// KPI scopes, missing stakes, and pending NCAAF grading. No network.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const grader = require('./netlify/functions/get-results-omega')._test;
const names = require('./netlify/functions/lib/ncaaf-names');
const { gamesFromScoreboard } = require('./netlify/functions/lib/espn-scoreboard');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

function finalGame(sport, away, home, awayScore, homeScore, awayAbbr, homeAbbr) {
  return {
    _sport: sport,
    awayTeam: away,
    homeTeam: home,
    awayAbbr: awayAbbr || '',
    homeAbbr: homeAbbr || '',
    awayScore: awayScore,
    homeScore: homeScore,
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
  };
}

async function main() {
console.log('scopes');
await check('record and ROI for each scope come from the same bets', async () => {
  const games = [
    finalGame('MLB', 'Baltimore Orioles', 'New York Yankees', 4, 7, 'BAL', 'NYY'),
    finalGame('MLB', 'Los Angeles Dodgers', 'San Diego Padres', 5, 2, 'LAD', 'SD'),
    finalGame('MLB', 'New York Mets', 'Atlanta Braves', 6, 1, 'NYM', 'ATL'),
    finalGame('MLB', 'Chicago Cubs', 'Milwaukee Brewers', 1, 8, 'CHC', 'MIL'),
    finalGame('MLB', 'Cincinnati Reds', 'Pittsburgh Pirates', 2, 9, 'CIN', 'PIT'),
  ];
  const day = await grader.gradeDay('2026-09-01', {
    picks: [
      { sport: 'MLB', matchup: 'Baltimore Orioles @ New York Yankees', pick: 'Baltimore Orioles +3', odds: '-110', units: '0.25u' },
      { sport: 'MLB', matchup: 'Los Angeles Dodgers @ San Diego Padres', pick: 'Los Angeles Dodgers ML', odds: '-110', units: '0.5u' },
      { sport: 'MLB', matchup: 'New York Mets @ Atlanta Braves', pick: 'New York Mets ML', odds: '-110', units: '' },
    ],
    parlayLegs: [{
      units: '0.25u',
      combinedOdds: '+264',
      legs: [
        { sport: 'MLB', matchup: 'Chicago Cubs @ Milwaukee Brewers', pick: 'Chicago Cubs ML', odds: '-110' },
        { sport: 'MLB', matchup: 'Cincinnati Reds @ Pittsburgh Pirates', pick: 'Cincinnati Reds ML', odds: '-110' },
      ],
    }],
  }, { games });
  assert.strictEqual(day.straightsOnly.record, '1-0-1');
  assert.strictEqual(day.straightsOnly.bets, 2);
  assert.strictEqual(day.straightsOnly.wagered, 75);
  assert.strictEqual(day.straightsOnly.profit, 69);
  assert.strictEqual(day.straightsOnly.roi, '92.0%');
  assert.strictEqual(day.allIn.record, '1-1-1');
  assert.strictEqual(day.allIn.bets, 3);
  assert.strictEqual(day.allIn.wagered, 113);
  assert.strictEqual(day.allIn.profit, 31);
  assert.strictEqual(day.allIn.roi, '27.4%');
  assert.notStrictEqual(day.straightsOnly.roi, day.allIn.roi);
  // Published day shape (WeBet 10/30): record = straights, money/ROI = all-in.
  assert.strictEqual(day.recordScope, 'straightsOnly');
  assert.strictEqual(day.roiScope, 'allIn');
  assert.strictEqual(day.wins, day.straightsOnly.wins);
  assert.strictEqual(day.losses, day.straightsOnly.losses);
  assert.strictEqual(day.profit, day.allIn.profit);
  // published wagered keeps push stakes (production convention)
  assert.strictEqual(day.wagered, day.allIn.wagered + day.allIn.pushWagered);
  const agg = grader.aggregateDays([day]);
  assert.strictEqual(agg.straight.kpiScope, 'straightsOnly');
  assert.strictEqual(agg.cumulative.recordScope, 'straightsOnly');
  assert.strictEqual(agg.cumulative.roiScope, 'allIn');
  assert.strictEqual(agg.straight.record, agg.straightsOnly.record);
  assert.strictEqual(agg.straight.roi, agg.straightsOnly.roi);
  assert.strictEqual(agg.cumulative.totalProfit, agg.allIn.profit);
  assert.strictEqual(agg.cumulative.totalWagered, agg.allIn.wagered + agg.allIn.pushWagered);
  assert.strictEqual(agg.cumulative.roi, ((agg.cumulative.totalProfit / agg.cumulative.totalWagered) * 100).toFixed(1) + '%');
  assert.strictEqual(agg.cumulative.wins, agg.straightsOnly.wins);
  assert.strictEqual(agg.cumulative.accuracy, agg.straightsOnly.accuracy);
  assert.notStrictEqual(agg.straight.roi, agg.cumulative.roi);
  const roiOf = (scope) => ((scope.profit / scope.wagered) * 100).toFixed(1) + '%';
  assert.strictEqual(agg.straightsOnly.roi, roiOf(agg.straightsOnly));
  assert.strictEqual(agg.allIn.roi, roiOf(agg.allIn));
});

console.log('stakes');
await check('missing stake is not invented as 1u; card stake is used', async () => {
  const games = [
    finalGame('MLB', 'Los Angeles Dodgers', 'San Diego Padres', 5, 2, 'LAD', 'SD'),
    finalGame('MLB', 'New York Mets', 'Atlanta Braves', 6, 1, 'NYM', 'ATL'),
  ];
  const day = await grader.gradeDay('2026-09-02', {
    picks: [
      { sport: 'MLB', matchup: 'Los Angeles Dodgers @ San Diego Padres', pick: 'Los Angeles Dodgers ML', odds: '-110', units: '0.5u' },
      { sport: 'MLB', matchup: 'New York Mets @ Atlanta Braves', pick: 'New York Mets ML', odds: '-110' },
    ],
  }, { games });
  const mets = day.picks.find((p) => /Mets/.test(p.pick));
  assert.strictEqual(mets.result, 'win');
  assert.strictEqual(mets.unitsMissing, true);
  assert.strictEqual(mets.profit, 0);
  assert.strictEqual(day.straightsOnly.record, '1-0-0');
  assert.strictEqual(day.straightsOnly.wagered, 75);
  assert.strictEqual(day.straightsOnly.profit, 69);
  assert.ok(day.flags.some((f) => f.issue === 'units_missing' && /Mets/.test(f.pick)));
  assert.ok(day.unitsMissing.some((f) => /Mets/.test(f.pick) && f.result === 'win'));
  assert.strictEqual(day.allIn.wagered, 75);
  assert.ok(!day.picks.some((p) => p.unitsMissing && p.stakeDollars === 150));
});

await check('parlay uses the ticket stake, not 0.5u or 1u', () => {
  const before = {
    date: '2026-10-13',
    wagered: 300,
    profit: -184,
    parlayResult: 'loss',
    parlayProfit: -75,
    parlayRisk: 75,
    picks: [
      { sport: 'NHL', pick: 'Over 6.5', units: '0.5u', result: 'loss', profit: -75 },
      { sport: 'PARLAY', pick: '3-Team Parlay (Optimized)', units: '0.5u', result: 'loss', profit: -75 },
    ],
  };
  const card = { date: '2026-10-13', parlayLegs: [{ units: '0.25u', combinedOdds: '+576', type: '3-leg-parlay-straight', legs: [{}, {}] }] };
  const next = grader.recomputeParlayFields(before, card);
  const row = next.picks.find((p) => p.sport === 'PARLAY');
  assert.strictEqual(row.units, '0.25u');
  assert.strictEqual(next.parlayRisk, 38);
  assert.strictEqual(next.parlayProfit, -38);
  assert.strictEqual(next.wagered, 263);
  assert.strictEqual(next.profit, -147);
  const same = grader.recomputeParlayFields(before, { parlayLegs: [{ units: '0.5u', legs: [{}, {}] }] });
  assert.strictEqual(same.parlayProfit, -75);
  assert.strictEqual(same.parlayRisk, 75);
});

console.log('dollars');
await check('whole dollars round away from zero', async () => {
  assert.strictEqual(grader.wholeUp(37.5), 38);
  assert.strictEqual(grader.wholeUp(75), 75);
  assert.strictEqual(grader.wholeUpSigned(-37.5), -38);
  assert.strictEqual(grader.wholeUpSigned(-38), -38);
  assert.strictEqual(grader.parseStakeUnits('1.25u'), 1.25);
  assert.strictEqual(grader.parseStakeUnits(''), null);
  assert.strictEqual(grader.parseStakeUnits(0), null);
  assert.strictEqual(grader.parseStakeUnits(null), null);
  const games = [finalGame('NFL', 'Buffalo Bills', 'Miami Dolphins', 10, 24, 'BUF', 'MIA')];
  const day = await grader.gradeDay('2026-09-03', {
    picks: [
      { sport: 'NFL', matchup: 'Buffalo Bills @ Miami Dolphins', pick: 'Buffalo Bills +3.5', odds: '-110', units: '0.25u' },
      { sport: 'NFL', matchup: 'Buffalo Bills @ Miami Dolphins', pick: 'Over 40.5', odds: '-105', units: '1.25u' },
    ],
  }, { games });
  const spread = day.picks.find((p) => /\+3\.5/.test(p.pick));
  const total = day.picks.find((p) => /Over 40\.5/.test(p.pick));
  assert.strictEqual(spread.result, 'loss');
  assert.strictEqual(spread.profit, -38);
  assert.strictEqual(total.result, 'loss');
  assert.strictEqual(total.stakeDollars, 188);
  assert.strictEqual(total.profit, -188);
  assert.strictEqual(day.straightsOnly.profit, -226);
  assert.strictEqual(day.straightsOnly.wagered, 226);
});

console.log('push');
await check('a push stays in the record and out of the ROI denominator', async () => {
  const games = [finalGame('MLB', 'Baltimore Orioles', 'New York Yankees', 4, 7, 'BAL', 'NYY')];
  const day = await grader.gradeDay('2026-09-04', {
    picks: [
      { sport: 'MLB', matchup: 'Baltimore Orioles @ New York Yankees', pick: 'Baltimore Orioles +3', odds: '-110', units: '1u' },
    ],
  }, { games });
  assert.strictEqual(day.picks[0].result, 'push');
  assert.strictEqual(day.straightsOnly.record, '0-0-1');
  assert.strictEqual(day.straightsOnly.bets, 1);
  assert.strictEqual(day.straightsOnly.wagered, 0);
  assert.strictEqual(day.straightsOnly.profit, 0);
  assert.strictEqual(day.straightsOnly.roi, '0%');
  assert.strictEqual(day.allIn.record, day.straightsOnly.record);
});

console.log('ncaaf');
await check('Miami (OH) is not Miami and San Jose keeps its accent', () => {
  assert.strictEqual(names.schoolsEqual('Miami (OH) RedHawks', 'Miami Hurricanes'), false);
  assert.strictEqual(names.schoolsEqual('UMass Minutemen', 'Massachusetts Minutemen'), true);
  assert.strictEqual(names.schoolsEqual('Southern Mississippi Golden Eagles', 'Southern Miss Golden Eagles'), true);
  assert.strictEqual(names.schoolsEqual('McNeese State Cowboys', 'McNeese Cowboys'), true);
  assert.strictEqual(names.schoolsEqual('San Jose State Spartans', 'San José State Spartans'), true);
});

await check('fixture scoreboard settles the four pending NCAAF straights', () => {
  const board = gamesFromScoreboard(JSON.parse(fs.readFileSync(
    path.join(__dirname, 'test/fixtures/espn-ncaaf-pending-1030.json'), 'utf8'
  )));
  assert.ok(board.length >= 4);
  const cases = [
    {
      date: '2026-10-03',
      pick: 'McNeese State Cowboys +53.5',
      matchup: 'McNeese State Cowboys @ LSU Tigers',
      odds: '-110',
      units: '1u',
      result: 'win',
      score: '14-63',
      profit: 137,
    },
    {
      date: '2026-10-06',
      pick: 'Troy Trojans -10',
      matchup: 'Southern Mississippi Golden Eagles @ Troy Trojans',
      odds: '-108',
      units: '1.25u',
      result: 'win',
      score: '34-55',
      profit: 175,
    },
    {
      date: '2026-10-09',
      pick: 'Over 42.5',
      matchup: 'Wyoming Cowboys @ San Jose State Spartans',
      odds: '-105',
      units: '1.25u',
      result: 'loss',
      score: '16-13',
      profit: -188,
    },
    {
      date: '2026-10-10',
      pick: 'UMass Minutemen +6.5',
      matchup: 'Miami (OH) RedHawks @ UMass Minutemen',
      odds: '-110',
      units: '1u',
      result: 'win',
      score: '20-19',
      profit: 137,
    },
  ];
  for (const item of cases) {
    const stored = {
      date: item.date,
      picks: [{ sport: 'NCAAF', matchup: item.matchup, pick: item.pick, odds: item.odds, units: item.units, result: 'pending', profit: 0 }],
      parlayResult: 'loss',
      parlayProfit: -75,
      parlayRisk: 75,
    };
    const card = {
      date: item.date,
      picks: [{ sport: 'NCAAF', matchup: item.matchup, pick: item.pick, odds: item.odds, units: item.units }],
      parlayLegs: [{ units: '0.5u', legs: [{}, {}], combinedOdds: '+500' }],
    };
    const next = grader.replayDay(stored, card, board);
    const row = next.picks.find((p) => p.pick === item.pick);
    assert.strictEqual(row.result, item.result, item.pick);
    assert.strictEqual(row.score, item.score, item.pick);
    assert.strictEqual(row.profit, item.profit, item.pick);
    assert.notStrictEqual(row.result, 'pending', item.pick);
    assert.strictEqual(next.straightsOnly.record, item.result === 'win' ? '1-0-0' : '0-1-0');
    assert.strictEqual(next.straightsOnly.profit, item.profit);
  }
  const umassOnlyDecoy = gamesFromScoreboard({
    events: [{
      competitions: [{
        competitors: [
          { homeAway: 'away', score: '41', team: { displayName: 'Miami Hurricanes', abbreviation: 'MIA' } },
          { homeAway: 'home', score: '13', team: { displayName: 'Clemson Tigers', abbreviation: 'CLEM' } },
        ],
        status: { type: { state: 'post', completed: true, name: 'STATUS_FINAL' } },
      }],
    }],
  });
  const stuck = grader.replayDay({
    date: '2026-10-10',
    picks: [{ sport: 'NCAAF', matchup: 'Miami (OH) RedHawks @ UMass Minutemen', pick: 'UMass Minutemen +6.5', odds: '-110', units: '1u', result: 'pending', profit: 0 }],
  }, null, umassOnlyDecoy);
  assert.strictEqual(stuck.picks[0].result, 'pending');
});

await check('grader source does not default a stake to 1u or call the odds API', () => {
  const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-omega.js'), 'utf8');
  assert.ok(!src.includes('parseFloat(p.units) || 1'));
  assert.ok(!src.includes('parlayRisk || 75'));
  assert.ok(!src.includes('site.api.espn.com'));
  assert.ok(!src.includes('the-odds-api.com'));
  assert.ok(src.includes("roiScope: 'allIn'"));
  assert.ok(src.includes('units_missing'));
});

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nall checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
