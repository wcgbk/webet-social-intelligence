'use strict';
/**
 * Standings name collision. pointsFor / pointsAgainst / winPercent match
 * the exact stat name on the overall slice. avgPointsFor is only the
 * per-game pair. Order of those columns does not matter.
 * Captured ESPN tables: NFL, NCAAF, and NHL rows stay identical to the
 * old first-match finder. MLB rows take the season sums and the real
 * winPercent; power stays on the per-game differential.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ingest = require('./netlify/functions/lib/omega-vnext/ingest');
const { powerFromStandings } = require('./netlify/functions/lib/omega-vnext/sports/_common');

function legacyNumbers(stats) {
  const winPct = stats.find(s => s.name === 'winPercent' || s.name === 'avgPointsFor');
  const pf = stats.find(s => /pointsFor|avgPointsFor|runsFor/i.test(s.name || ''));
  const pa = stats.find(s => /pointsAgainst|avgPointsAgainst|runsAgainst/i.test(s.name || ''));
  const wins = stats.find(s => s.name === 'wins');
  const losses = stats.find(s => s.name === 'losses');
  return {
    winPct: winPct ? Number(winPct.value) : null,
    pf: pf ? Number(pf.value) : null,
    pa: pa ? Number(pa.value) : null,
    wins: wins ? Number(wins.value) : null,
    losses: losses ? Number(losses.value) : null,
  };
}

function legacyRatings(entries, label) {
  const ratings = {};
  for (const e of entries) {
    const team = (e.team && (e.team.displayName || e.team.name)) || '';
    if (!team) continue;
    const stats = e.stats || [];
    ratings[team] = legacyNumbers(stats);
    if (label === 'NHL') ingest.applyNhlStandingStats(ratings[team], stats);
    else if (label === 'NFL' || label === 'NCAAF') ingest.applyFootballStandingExtras(ratings[team], stats);
    else if (label === 'NBA') ingest.applyNbaStandingExtras(ratings[team], stats);
  }
  return ratings;
}

function row(stats, label) {
  return ingest.ratingsFromStandingsEntries(
    [{ team: { displayName: 'Sample' }, stats }],
    label || 'MLB'
  ).Sample;
}

const overall = [
  { name: 'pointsFor', type: 'pointsfor', value: 739 },
  { name: 'pointsAgainst', type: 'pointsagainst', value: 601 },
  { name: 'winPercent', type: 'winpercent', value: 0.57763976 },
  { name: 'wins', type: 'wins', value: 93 },
  { name: 'losses', type: 'losses', value: 68 },
];
const avgs = [
  { name: 'avgPointsFor', type: 'avgpointsfor', value: 4.590062 },
  { name: 'avgPointsAgainst', type: 'avgpointsagainst', value: 3.7329192 },
];
const home = [
  { name: 'pointsFor', type: 'homerecord_pointsfor', value: 400 },
  { name: 'pointsAgainst', type: 'homerecord_pointsagainst', value: 280 },
  { name: 'winPercent', type: 'homerecord_winpercent', value: 0.9 },
  { name: 'wins', type: 'homerecord_wins', value: 46 },
  { name: 'losses', type: 'homerecord_losses', value: 34 },
  { name: 'avgPointsFor', type: 'homerecord_avgpointsfor', value: 9.5 },
  { name: 'avgPointsAgainst', type: 'homerecord_avgpointsagainst', value: 6.5 },
];

const avgFirst = row([...avgs, ...home, ...overall]);
const pointsFirst = row([...overall, ...home, ...avgs]);
assert.deepStrictEqual(avgFirst, pointsFirst);
assert.strictEqual(avgFirst.pf, 739);
assert.strictEqual(avgFirst.pa, 601);
assert.strictEqual(avgFirst.winPct, 0.57763976);
assert.strictEqual(avgFirst.wins, 93);
assert.strictEqual(avgFirst.losses, 68);
assert.ok(avgFirst.avgPointsFor == null, 'avgPointsFor is not the season pf');

assert.strictEqual(row([
  { name: 'runsFor', type: 'runsfor', value: 80 },
  { name: 'runsAgainst', type: 'runsagainst', value: 70 },
  { name: 'avgPointsFor', type: 'avgpointsfor', value: 4.2 },
  { name: 'avgPointsAgainst', type: 'avgpointsagainst', value: 3.8 },
]).pf, 80, 'runsFor is the fallback when pointsFor is absent');
assert.strictEqual(row([
  { name: 'runsFor', type: 'runsfor', value: 80 },
  { name: 'pointsFor', type: 'pointsfor', value: 739 },
  { name: 'pointsAgainst', type: 'pointsagainst', value: 601 },
  { name: 'runsAgainst', type: 'runsagainst', value: 70 },
]).pf, 739, 'pointsFor beats runsFor');

const homeOnly = row([
  { name: 'pointsFor', type: 'homerecord_pointsfor', value: 400 },
  { name: 'pointsAgainst', type: 'homerecord_pointsagainst', value: 280 },
  { name: 'winPercent', type: 'homerecord_winpercent', value: 0.9 },
  { name: 'avgPointsFor', type: 'avgpointsfor', value: 4.5 },
]);
assert.strictEqual(homeOnly.pf, null, 'no fallback to a home slice');
assert.strictEqual(homeOnly.pa, null);
assert.strictEqual(homeOnly.winPct, null);
assert.notStrictEqual(homeOnly.pf, 4.5);

const football = row([
  { name: 'avgPointsFor', type: 'avgpointsfor', value: 29.5 },
  { name: 'pointsFor', type: 'homerecord_pointsfor', value: 80 },
  { name: 'pointsFor', type: 'pointsfor', value: 118 },
  { name: 'avgPointsAgainst', type: 'avgpointsagainst', value: 19.25 },
  { name: 'pointsAgainst', type: 'pointsagainst', value: 77 },
  { name: 'wins', type: 'wins', value: 4 },
  { name: 'losses', type: 'losses', value: 0 },
  { name: 'gamesPlayed', type: 'gamesplayed', value: 4 },
], 'NFL');
assert.strictEqual(football.pf, 118);
assert.strictEqual(football.pa, 77);
assert.strictEqual(football.avgPointsFor, 29.5);
assert.strictEqual(football.avgPointsAgainst, 19.25);
assert.strictEqual(football.gamesPlayed, 4);

const homeAvgOnly = row([
  { name: 'pointsFor', type: 'pointsfor', value: 118 },
  { name: 'pointsAgainst', type: 'pointsagainst', value: 77 },
  { name: 'avgPointsFor', type: 'homerecord_avgpointsfor', value: 40 },
  { name: 'avgPointsAgainst', type: 'homerecord_avgpointsagainst', value: 10 },
  { name: 'wins', type: 'wins', value: 4 },
  { name: 'losses', type: 'losses', value: 0 },
], 'NFL');
assert.strictEqual(homeAvgOnly.pf, 118);
assert.strictEqual(homeAvgOnly.avgPointsFor, undefined);

// Captured ESPN tables. Same shape the live standings endpoint returns.
const dir = '/workspace/omega-replay-2w/inputs/_espn/standings';
for (const label of ['NFL', 'NCAAF', 'NHL']) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, `${label.toLowerCase()}.json`), 'utf8'));
  const entries = ingest.collectStandingsEntries(data);
  const next = ingest.ratingsFromStandingsEntries(entries, label);
  const prev = legacyRatings(entries, label);
  assert.deepStrictEqual(next, prev, `${label} rows must match the previous finder`);
  assert.ok(Object.keys(next).length >= (label === 'NCAAF' ? 100 : 30), label);
}

{
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'mlb.json'), 'utf8'));
  const entries = ingest.collectStandingsEntries(data);
  const next = ingest.ratingsFromStandingsEntries(entries, 'MLB');
  const prev = legacyRatings(entries, 'MLB');
  assert.strictEqual(Object.keys(next).length, 30);
  const yankees = next['New York Yankees'];
  assert.strictEqual(yankees.pf, 739);
  assert.strictEqual(yankees.pa, 601);
  assert.strictEqual(yankees.winPct, 0.57763976);
  assert.notStrictEqual(yankees.pf, prev['New York Yankees'].pf);
  assert.ok(prev['New York Yankees'].winPct > 1, 'old finder bound winPct to avgPointsFor');
  let maxDelta = 0;
  let worst = null;
  for (const name of Object.keys(next)) {
    const a = powerFromStandings(prev[name], 'MLB');
    const b = powerFromStandings(next[name], 'MLB');
    const d = Math.abs(a - b);
    if (d > maxDelta) {
      maxDelta = d;
      worst = name;
    }
    assert.strictEqual(next[name].pf, entries.find(e => e.team.displayName === name).stats.find(s => s.name === 'pointsFor' && !ingest.isSplitStat(s)).value);
  }
  assert.ok(maxDelta < 1e-4, `MLB power moved ${maxDelta} on ${worst}`);
}

console.log('test-omega-standings-names: ok');
