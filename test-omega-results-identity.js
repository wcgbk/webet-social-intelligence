'use strict';
// Omega results grader: id fallback only when the school-key matcher misses.
// Already-matched games stay on the old path. Alias pairs use resolveTeamId.
const assert = require('assert');
const api = require('./netlify/functions/get-results-omega')._test;

assert.ok(api && typeof api.findGame === 'function', 'test export');
assert.ok(typeof api.gradePick === 'function');
assert.ok(typeof api.gradeParlay === 'function');
assert.ok(typeof api.withLegCommenceTime === 'function');

function game(awayTeam, homeTeam, awayScore, homeScore, extra) {
  return Object.assign({
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    awayTeam,
    homeTeam,
    awayScore,
    homeScore,
    awayAbbr: '',
    homeAbbr: '',
    startISO: '2026-10-07T00:00:00Z',
  }, extra || {});
}

function pick(matchup, selection, extra) {
  return Object.assign({
    sport: 'NCAAF',
    betType: 'spread',
    matchup,
    pick: selection,
    odds: '-110',
    units: '1u',
  }, extra || {});
}

function grade(selection, matchup, g, extra) {
  const p = pick(matchup, selection, extra);
  const found = api.findGame(p, Array.isArray(g) ? g : [g]);
  return { found, result: api.gradePick(p, found) };
}

const troyMatchup = 'Southern Mississippi Golden Eagles @ Troy Trojans';

function troyBoard(awayScore, homeScore) {
  return [game('Southern Miss Golden Eagles', 'Troy Trojans', awayScore, homeScore, {
    awayAbbr: 'USM',
    homeAbbr: 'TROY',
    awayId: '2572',
    homeId: '2653',
  })];
}

// 10-31 Troy -10 wins; 10-20 pushes; 14-20 loses. Southern Miss +10 is the other side.
const troyFinals = [
  [10, 31, 'win', 'loss'],
  [10, 20, 'push', 'push'],
  [14, 20, 'loss', 'win'],
];
for (const [awayScore, homeScore, troyResult, usmResult] of troyFinals) {
  const board = troyBoard(awayScore, homeScore);
  const label = awayScore + '-' + homeScore;
  const troy = grade('Troy Trojans -10', troyMatchup, board);
  assert.ok(troy.found, 'Troy straight matches ' + label);
  assert.strictEqual(troy.found.awayTeam, 'Southern Miss Golden Eagles');
  assert.strictEqual(troy.found.homeTeam, 'Troy Trojans');
  assert.strictEqual(troy.result, troyResult, 'Troy -10 ' + label);

  const usm = grade('Southern Mississippi Golden Eagles +10', troyMatchup, board);
  assert.ok(usm.found, 'Southern Miss side matches ' + label);
  assert.strictEqual(usm.result, usmResult, 'Southern Miss +10 ' + label);
  const sides = api.ncaafPickedSides(
    'Southern Mississippi Golden Eagles',
    usm.found.awayTeam, usm.found.awayAbbr,
    usm.found.homeTeam, usm.found.homeAbbr,
    'NCAAF'
  );
  assert.strictEqual(sides.pickedAway, true, 'USM is the away side ' + label);
  assert.strictEqual(sides.pickedHome, false);
}

// Parlay leg has no commenceTime. It must inherit the straight and grade the same final.
{
  const board = troyBoard(10, 31);
  const straight = pick(troyMatchup, 'Troy Trojans -10', { commenceTime: '2026-10-07T00:00:00Z' });
  const leg = pick(troyMatchup, 'Troy Trojans -10', { odds: '-110' });
  delete leg.commenceTime;
  const eleg = api.withLegCommenceTime(leg, [straight]);
  assert.strictEqual(eleg.commenceTime, straight.commenceTime);
  const found = api.findGame(eleg, board);
  assert.ok(found, 'Troy parlay leg matches');
  assert.strictEqual(api.gradePick(eleg, found), 'win');
  const ticket = api.gradeParlay([
    { result: api.gradePick(eleg, found), odds: eleg.odds },
    { result: 'win', odds: '-110' },
  ], 75);
  assert.strictEqual(ticket.result, 'win');
  assert.ok(ticket.profit > 0);
}

// Home/away printed backwards still pairs on ids. The string matcher misses this alias.
{
  const swapped = grade(
    'Troy Trojans -10',
    'Troy Trojans @ Southern Mississippi Golden Eagles',
    troyBoard(10, 31)
  );
  assert.ok(swapped.found, 'swapped matchup still finds USM @ Troy');
  assert.strictEqual(swapped.found.homeAbbr, 'TROY');
  assert.strictEqual(swapped.result, 'win');
}

const aliasPairs = [
  ['Appalachian State Mountaineers @ Georgia Southern Eagles', 'Appalachian State Mountaineers +3', 'App State Mountaineers', 'Georgia Southern Eagles'],
  ['UMass Minutemen @ Buffalo Bulls', 'UMass Minutemen +3', 'Massachusetts Minutemen', 'Buffalo Bulls'],
  ['San Jose State Spartans @ Hawaii Rainbow Warriors', 'San Jose State Spartans +2.5', 'San José State Spartans', 'Hawai\'i Rainbow Warriors'],
  ['Houston Baptist Huskies @ Lamar Cardinals', 'Houston Baptist Huskies +7', 'Houston Christian Huskies', 'Lamar Cardinals'],
  ['William and Mary Tribe @ Richmond Spiders', 'William and Mary Tribe +3', 'William & Mary Tribe', 'Richmond Spiders'],
];
for (const [matchup, selection, espnAway, espnHome] of aliasPairs) {
  const decoy = game('Alabama Crimson Tide', 'Georgia Bulldogs', 7, 24);
  const real = game(espnAway, espnHome, 17, 31);
  const row = grade(selection, matchup, [decoy, real]);
  assert.ok(row.found, 'alias match ' + matchup);
  assert.strictEqual(row.found.awayTeam, espnAway, matchup);
  assert.strictEqual(row.found.homeTeam, espnHome, matchup);
  // Away +points: 17 + spread vs 31. +3 and +2.5 lose; +7 pushes none of these (17+7=24 < 31 loss).
  assert.strictEqual(row.result, 'loss', selection + ' grades the away side');
}

// McNeese State still covers against ESPN "McNeese" on the existing school-key path.
{
  const g = game('McNeese Cowboys', 'LSU Tigers', 14, 63, { awayAbbr: 'MCN', homeAbbr: 'LSU' });
  const row = grade('McNeese State Cowboys +53.5', 'McNeese State Cowboys @ LSU Tigers', g);
  assert.ok(row.found);
  assert.strictEqual(row.found.awayTeam, 'McNeese Cowboys');
  assert.strictEqual(row.result, 'win');
  assert.strictEqual(api.teamsMatch('McNeese State Cowboys', 'McNeese Cowboys', '', 'NCAAF'), true);
}

// Both the school and its lookalike are on the board. Grade the named side only.
{
  const board = [
    game('Michigan Wolverines', 'Iowa Hawkeyes', 10, 30),
    game('Michigan State Spartans', 'Iowa Hawkeyes', 30, 10),
    game('Miami Hurricanes', 'Duke Blue Devils', 31, 10, { awayId: '2390', homeId: '150' }),
    game('Miami (OH) RedHawks', 'Duke Blue Devils', 10, 31, { awayId: '193', homeId: '150' }),
    game('Washington Huskies', 'Oregon Ducks', 24, 20, { awayId: '264', homeId: '2483' }),
    game('Washington State Cougars', 'Oregon Ducks', 10, 38, { awayId: '265', homeId: '2483' }),
    game('Ohio State Buckeyes', 'Penn State Nittany Lions', 27, 10),
    game('Ohio Bobcats', 'Penn State Nittany Lions', 10, 27),
  ];
  const cases = [
    ['Michigan Wolverines @ Iowa Hawkeyes', 'Michigan Wolverines -3', 'Michigan Wolverines', 'loss'],
    ['Michigan State Spartans @ Iowa Hawkeyes', 'Michigan State Spartans -3', 'Michigan State Spartans', 'win'],
    ['Miami Hurricanes @ Duke Blue Devils', 'Miami Hurricanes -3', 'Miami Hurricanes', 'win'],
    ['Miami (FL) @ Duke Blue Devils', 'Miami (FL) -3', 'Miami Hurricanes', 'win'],
    ['Miami (OH) RedHawks @ Duke Blue Devils', 'Miami (OH) RedHawks -3', 'Miami (OH) RedHawks', 'loss'],
    ['Washington Huskies @ Oregon Ducks', 'Washington Huskies -3', 'Washington Huskies', 'win'],
    ['Washington State Cougars @ Oregon Ducks', 'Washington State Cougars -3', 'Washington State Cougars', 'loss'],
    ['Ohio State Buckeyes @ Penn State Nittany Lions', 'Ohio State Buckeyes -3', 'Ohio State Buckeyes', 'win'],
    ['Ohio Bobcats @ Penn State Nittany Lions', 'Ohio Bobcats -3', 'Ohio Bobcats', 'loss'],
  ];
  for (const [matchup, selection, awayTeam, result] of cases) {
    const row = grade(selection, matchup, board);
    assert.ok(row.found, matchup);
    assert.strictEqual(row.found.awayTeam, awayTeam, selection + ' must not cross-match');
    assert.strictEqual(row.result, result, selection);
  }
}

// Identity must not attach a lookalike when the string matcher also misses.
{
  const board = [
    game('Miami (OH) RedHawks', 'Ohio Bobcats', 24, 17),
    game('Washington State Cougars', 'Stanford Cardinal', 21, 14),
    game('Michigan State Spartans', 'Ohio State Buckeyes', 17, 28),
    game('Ohio Bobcats', 'Kent State Golden Flashes', 31, 14),
  ];
  const misses = [
    ['Miami Hurricanes @ Duke Blue Devils', 'Miami Hurricanes -7'],
    ['Miami (FL) @ Duke Blue Devils', 'Miami (FL) -7'],
    ['Washington Huskies @ Oregon Ducks', 'Washington Huskies -3'],
    ['Michigan Wolverines @ Iowa Hawkeyes', 'Michigan Wolverines -3'],
    ['Ohio State Buckeyes @ Penn State Nittany Lions', 'Ohio State Buckeyes -7'],
  ];
  for (const [matchup, selection] of misses) {
    const row = grade(selection, matchup, board);
    assert.strictEqual(row.found, null, 'no cross-match ' + matchup);
    assert.strictEqual(row.result, 'pending', matchup);
  }
}

// Two id hits and no clear commenceTime: do not guess. A 6h gap with a kick time does.
{
  const day = game('Southern Miss Golden Eagles', 'Troy Trojans', 10, 31, {
    startISO: '2026-10-06T16:00:00Z', awayAbbr: 'USM', homeAbbr: 'TROY',
  });
  const night = game('Southern Miss Golden Eagles', 'Troy Trojans', 14, 20, {
    startISO: '2026-10-06T22:00:00Z', awayAbbr: 'USM', homeAbbr: 'TROY',
  });
  const open = grade('Troy Trojans -10', troyMatchup, [day, night]);
  assert.strictEqual(open.found, null, 'ambiguous id pair stays unmatched');
  assert.strictEqual(open.result, 'pending');

  const close = game('Southern Miss Golden Eagles', 'Troy Trojans', 3, 40, {
    startISO: '2026-10-06T17:00:00Z', awayAbbr: 'USM', homeAbbr: 'TROY',
  });
  const tight = grade('Troy Trojans -10', troyMatchup, [day, close], {
    commenceTime: '2026-10-06T17:00:00Z',
  });
  assert.strictEqual(tight.found, null, 'kicks inside 75 minutes are still ambiguous');

  const nightPick = grade('Troy Trojans -10', troyMatchup, [day, night], {
    commenceTime: '2026-10-06T22:00:00Z',
  });
  assert.ok(nightPick.found, 'commenceTime selects the night cap');
  assert.strictEqual(nightPick.found.startISO, night.startISO);
  assert.strictEqual(nightPick.result, 'loss');

  const sameId = grade('Troy Trojans -10', 'Southern Mississippi Golden Eagles @ Southern Mississippi Golden Eagles', [day]);
  assert.strictEqual(sameId.found, null, 'both sides resolving to one id is not a game');

  const unknown = grade('Troy Trojans -10', 'Not A Real School Owls @ Troy Trojans', [day]);
  assert.strictEqual(unknown.found, null, 'unresolved side does not guess');
}

console.log('ok omega results identity');
