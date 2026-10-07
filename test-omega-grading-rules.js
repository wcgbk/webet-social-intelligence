'use strict';
// Forward-only Omega grading rules (card date >= 2026-10-07).
// No network. History dates are checked against git show 50d3eb9.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const repo = __dirname;
const results = require('./netlify/functions/get-results-omega')._test;
const clv = require('./netlify/functions/track-clv-omega')._test;
const rules = require('./netlify/functions/lib/omega-grading-rules');

assert.strictEqual(rules.GRADING_RULES_V2_FROM, '2026-10-07');
assert.strictEqual(results.GRADING_RULES_V2_FROM, '2026-10-07');
const resultsSrc = fs.readFileSync(path.join(repo, 'netlify/functions/get-results-omega.js'), 'utf8');
assert.ok(resultsSrc.includes("const RESULTS_CACHE_KEY = 'results-omega-cache-v9-ncaaf-state'"));
assert.ok(!resultsSrc.includes('gradingContext'), 'grade day must not keep a module-level card date');
assert.ok(!resultsSrc.includes('mergeGradeOpts'), 'grade opts are not merged from shared state');

const V2 = '2026-10-07';
const PRE = '2026-10-06';
const HOUR = 3600 * 1000;

function opts(dateISO, now) {
  const out = { dateISO: dateISO };
  if (now != null) out.now = now;
  return out;
}

function assertBoth(pick, game, when, expected, label) {
  const r = results.gradePick(pick, game, when);
  const c = clv.gradePick(pick, game, when);
  assert.strictEqual(r, expected, 'get-results ' + label + ' → ' + r);
  assert.strictEqual(c, expected, 'track-clv ' + label + ' → ' + c);
}

function mlbGame(awayRuns, homeRuns, awayN, homeN, extra) {
  const awayLine = Array.from({ length: awayN }, (_, i) => (i === 0 ? awayRuns : 0));
  const homeLine = Array.from({ length: homeN }, (_, i) => (i === 0 ? homeRuns : 0));
  const sum5 = (line) => line.slice(0, 5).reduce((s, n) => s + n, 0);
  return Object.assign({
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    awayTeam: 'Boston Red Sox',
    homeTeam: 'New York Yankees',
    awayAbbr: 'BOS',
    homeAbbr: 'NYY',
    awayScore: awayRuns,
    homeScore: homeRuns,
    awayLine: awayLine,
    homeLine: homeLine,
    awayInnings: awayN,
    homeInnings: homeN,
    awayScoreF5: sum5(awayLine),
    homeScoreF5: sum5(homeLine),
    startISO: '2026-10-07T00:05:00Z',
    _sport: 'MLB',
  }, extra || {});
}

function mlbPick(selection, betType, extra) {
  return Object.assign({
    sport: 'MLB',
    matchup: 'Boston Red Sox @ New York Yankees',
    pick: selection,
    betType: betType,
    odds: '-110',
    units: '1u',
    commenceTime: '2026-10-07T00:05:00Z',
  }, extra || {});
}

// ── 1. NHL Final/SO settles on the ESPN score (shootout winner +1) ──
// FLA@CAR 2026-09-22: 2-2 through OT, ESPN final 2-3. Total 5.
const nhlGame = {
  state: 'post',
  completed: true,
  statusName: 'STATUS_FINAL',
  detail: 'Final/SO',
  awayTeam: 'Florida Panthers',
  homeTeam: 'Carolina Hurricanes',
  awayAbbr: 'FLA',
  homeAbbr: 'CAR',
  awayScore: 2,
  homeScore: 3,
  awayLine: [2, 0, 0, 0, 0],
  homeLine: [1, 1, 0, 0, 1],
  startISO: '2026-09-22T23:00:00Z',
};
function nhlPick(selection, betType) {
  return {
    sport: 'NHL',
    matchup: 'Florida Panthers @ Carolina Hurricanes',
    pick: selection,
    betType: betType,
    odds: '-110',
    units: '1u',
  };
}
for (const dateISO of [PRE, V2, '2026-09-22']) {
  const when = opts(dateISO);
  assertBoth(nhlPick('Over 4.5', 'total'), nhlGame, when, 'win', 'NHL SO Over 4.5 ' + dateISO);
  assertBoth(nhlPick('Under 4.5', 'total'), nhlGame, when, 'loss', 'NHL SO Under 4.5 ' + dateISO);
  assertBoth(nhlPick('Carolina Hurricanes ML', 'moneyline'), nhlGame, when, 'win', 'NHL SO winner ML ' + dateISO);
  assertBoth(nhlPick('Florida Panthers +1.5', 'puck line'), nhlGame, when, 'win', 'NHL SO +1.5 loser ' + dateISO);
}

// ── 3. MLB short games + stale postponements ──
const short3 = mlbGame(1, 0, 3, 3);
const half5 = mlbGame(1, 3, 5, 4); // visitors batted 5, home batted 4, home leads
const half5Trail = mlbGame(4, 2, 5, 4); // 4.5 but home does not lead
const inn6few = mlbGame(2, 1, 6, 6); // 3 runs
const inn6many = mlbGame(4, 2, 6, 6); // 6 runs
const full9 = mlbGame(2, 1, 9, 9);
const half9 = mlbGame(2, 4, 9, 8); // 8.5, home leads, regulation
const f5short = mlbGame(2, 1, 4, 4);
const noLines = {
  state: 'post', completed: true, statusName: 'STATUS_FINAL',
  awayTeam: 'Boston Red Sox', homeTeam: 'New York Yankees',
  awayAbbr: 'BOS', homeAbbr: 'NYY',
  awayScore: 5, homeScore: 2,
  awayLine: [], homeLine: [],
  awayInnings: 0, homeInnings: 0,
  startISO: '2026-10-07T00:05:00Z',
  _sport: 'MLB',
};

const v2When = opts(V2);
const preWhen = opts(PRE);

// 3 innings, 1-0. ML / run line / a total the score has not cleared are voids.
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), short3, v2When, 'push', '3-inn ML');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), short3, v2When, 'push', '3-inn RL');
assertBoth(mlbPick('Under 6.5', 'total'), short3, v2When, 'push', '3-inn Under');
assertBoth(mlbPick('Over 6.5', 'total'), short3, v2When, 'push', '3-inn Over under the line');
// Already past the number: Over wins, Under loses, even though the game is short.
assertBoth(mlbPick('Over 0.5', 'total'), short3, v2When, 'win', '3-inn Over already decided');
assertBoth(mlbPick('Under 0.5', 'total'), short3, v2When, 'loss', '3-inn Under already decided');

// 4.5, home leading: ML grades, totals only if already over the line, run line voids.
assertBoth(mlbPick('New York Yankees ML', 'moneyline'), half5, v2When, 'win', '4.5 ML home');
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), half5, v2When, 'loss', '4.5 ML away');
assertBoth(mlbPick('Under 8.5', 'total'), half5, v2When, 'push', '4.5 total under line');
assertBoth(mlbPick('Over 3.5', 'total'), half5, v2When, 'win', '4.5 Over past the line');
assertBoth(mlbPick('Over 8.5', 'total'), half5, v2When, 'push', '4.5 Over not yet past');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), half5, v2When, 'push', '4.5 RL');
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), half5Trail, v2When, 'push', '4.5 home trailing is not official');

// 6 innings: ML official, full-game total/run line still short of 9.
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), inn6few, v2When, 'win', '6-inn ML');
assertBoth(mlbPick('Under 7.5', 'total'), inn6few, v2When, 'push', '6-inn Under 7.5 at 3 runs');
assertBoth(mlbPick('Over 4.5', 'total'), inn6many, v2When, 'win', '6-inn Over 4.5 at 6 runs');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), inn6many, v2When, 'push', '6-inn RL');

// 9 and 8.5 (home ahead) grade as a full game.
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), full9, v2When, 'win', '9-inn ML');
assertBoth(mlbPick('Under 7.5', 'total'), full9, v2When, 'win', '9-inn Under');
assertBoth(mlbPick('Over 7.5', 'total'), full9, v2When, 'loss', '9-inn Over');
assertBoth(mlbPick('Boston Red Sox -1.5', 'spread'), full9, v2When, 'loss', '9-inn RL');
assertBoth(mlbPick('New York Yankees ML', 'moneyline'), half9, v2When, 'win', '8.5 ML');
assertBoth(mlbPick('Under 7.5', 'total'), half9, v2When, 'win', '8.5 Under has action');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), half9, v2When, 'win', '8.5 RL has action');

// F5: a 4-inning final voids. 4.5 with home ahead grades on that score.
assertBoth(mlbPick('Boston Red Sox F5', 'f5'), f5short, v2When, 'push', 'F5 4-inn final');
assertBoth(mlbPick('Over 2.5 F5', 'f5 total'), f5short, v2When, 'push', 'F5 total 4-inn final');
assertBoth(mlbPick('New York Yankees F5', 'f5'), half5, v2When, 'win', 'F5 4.5 home ML');
assertBoth(mlbPick('Over 3.5 F5', 'f5 total'), half5, v2When, 'win', 'F5 4.5 total');
assertBoth(mlbPick('Under 3.5 F5', 'f5 total'), half5, v2When, 'loss', 'F5 4.5 under');
// In progress and short stays pending (not a void).
const liveShort = mlbGame(1, 0, 3, 3, { state: 'in', completed: false, statusName: 'STATUS_IN_PROGRESS' });
assertBoth(mlbPick('Over 2.5 F5', 'f5 total'), liveShort, v2When, 'pending', 'F5 live short stays pending');

// Missing linescores: do not invent a void.
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), noLines, v2When, 'win', 'no linescore ML');
assertBoth(mlbPick('Under 6.5', 'total'), noLines, v2When, 'loss', 'no linescore Under');
assertBoth(mlbPick('Over 6.5', 'total'), noLines, v2When, 'win', 'no linescore Over');
assertBoth(mlbPick('Boston Red Sox F5', 'f5'), noLines, v2When, 'pending', 'no linescore F5 stays pending');

// One side's line only, or a line that does not add up to the score, is missing
// data. Grade the final score (the pre-v2 result). Do not void.
const homeLineEmpty = mlbGame(5, 2, 9, 0, { awayInnings: 3, homeInnings: 3 });
assert.strictEqual(homeLineEmpty.awayLine.length, 9);
assert.strictEqual(homeLineEmpty.homeLine.length, 0);
assert.strictEqual(rules.inningCounts(homeLineEmpty).has, false);
assert.strictEqual(rules.mlbSnapshot(mlbPick('Boston Red Sox ML', 'moneyline'), homeLineEmpty, v2When), null);
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), homeLineEmpty, v2When, 'win', 'away 9 / home empty does not void');
assertBoth(mlbPick('Under 6.5', 'total'), homeLineEmpty, v2When, 'loss', 'away 9 / home empty total uses the score');

const sumMismatch = mlbGame(5, 2, 3, 3);
sumMismatch.awayLine = [1, 0, 0];
sumMismatch.homeLine = [0, 1, 0];
assert.notStrictEqual(sumMismatch.awayLine.reduce((s, n) => s + n, 0), sumMismatch.awayScore);
assert.notStrictEqual(sumMismatch.homeLine.reduce((s, n) => s + n, 0), sumMismatch.homeScore);
assert.strictEqual(rules.inningCounts(sumMismatch).has, false);
assert.strictEqual(rules.mlbSnapshot(mlbPick('Boston Red Sox ML', 'moneyline'), sumMismatch, v2When), null);
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), sumMismatch, v2When, 'win', 'linescore sum mismatch does not void');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), sumMismatch, v2When, 'loss', 'linescore sum mismatch run line uses the score');

// ESPN omits the bottom of the 9th when the home team is already ahead.
const espn98 = mlbGame(3, 5, 9, 8);
espn98.awayLine = [0, 1, 0, 0, 2, 0, 0, 0, 0];
espn98.homeLine = [0, 0, 2, 0, 0, 3, 0, 0];
assert.strictEqual(espn98.awayLine.reduce((s, n) => s + n, 0), espn98.awayScore);
assert.strictEqual(espn98.homeLine.reduce((s, n) => s + n, 0), espn98.homeScore);
const snap98 = rules.mlbSnapshot(mlbPick('New York Yankees ML', 'moneyline'), espn98, v2When);
assert.ok(snap98, '9/8 home lead is a real linescore');
assert.strictEqual(snap98.fullOfficial, true, '9/8 home lead is a full game');
assert.strictEqual(snap98.mlOfficial, true);
assertBoth(mlbPick('New York Yankees ML', 'moneyline'), espn98, v2When, 'win', '9/8 home lead ML');
assertBoth(mlbPick('Under 8.5', 'total'), espn98, v2When, 'win', '9/8 home lead total has action');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), espn98, v2When, 'win', '9/8 home lead run line has action');

// Track-clv shape: inning counts, no lines. Both counts must be > 0 even when
// the F5 sums are absent. A one-sided count does not void.
function inningsOnly(awayScore, homeScore, awayN, homeN, extra) {
  return Object.assign({
    state: 'post', completed: true, statusName: 'STATUS_FINAL',
    awayTeam: 'Boston Red Sox', homeTeam: 'New York Yankees',
    awayAbbr: 'BOS', homeAbbr: 'NYY',
    awayScore: awayScore, homeScore: homeScore,
    awayInnings: awayN, homeInnings: homeN,
    startISO: '2026-10-07T00:05:00Z',
    _sport: 'MLB',
  }, extra || {});
}
const clvShort = inningsOnly(1, 0, 3, 3);
assert.strictEqual(rules.inningCounts(clvShort).has, true);
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), clvShort, v2When, 'push', 'track-clv 3 innings voids without F5 sums');
const clvOneSide = inningsOnly(5, 2, 9, 0);
assert.strictEqual(rules.mlbSnapshot(mlbPick('Boston Red Sox ML', 'moneyline'), clvOneSide, v2When), null);
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), clvOneSide, v2When, 'win', 'track-clv one-sided innings do not void');
const clv98 = inningsOnly(3, 5, 9, 8);
const clvSnap98 = rules.mlbSnapshot(mlbPick('New York Yankees ML', 'moneyline'), clv98, v2When);
assert.strictEqual(clvSnap98 && clvSnap98.fullOfficial, true);
assertBoth(mlbPick('Under 8.5', 'total'), clv98, v2When, 'win', 'track-clv 9/8 total has action');

// No opts: same call shape as 50d3eb9. A short final is a real result.
assert.strictEqual(results.gradePick(mlbPick('Boston Red Sox ML', 'moneyline'), short3), 'win', 'no opts ML');
assert.strictEqual(results.gradePick(mlbPick('Under 6.5', 'total'), short3), 'win', 'no opts total');
assert.strictEqual(clv.gradePick(mlbPick('Boston Red Sox ML', 'moneyline'), short3), 'win', 'clv no opts ML');

// Same fixtures before the gate grade the old way.
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), short3, preWhen, 'win', 'pre-gate 3-inn ML');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), short3, preWhen, 'loss', 'pre-gate 3-inn RL');
assertBoth(mlbPick('Under 6.5', 'total'), short3, preWhen, 'win', 'pre-gate 3-inn Under');
assertBoth(mlbPick('Over 6.5', 'total'), short3, preWhen, 'loss', 'pre-gate 3-inn Over');
assertBoth(mlbPick('Under 8.5', 'total'), half5, preWhen, 'win', 'pre-gate 4.5 Under grades');
assertBoth(mlbPick('New York Yankees -1.5', 'spread'), half5, preWhen, 'win', 'pre-gate 4.5 RL grades');
assertBoth(mlbPick('Under 7.5', 'total'), inn6few, preWhen, 'win', 'pre-gate 6-inn Under grades');
assertBoth(mlbPick('Boston Red Sox F5', 'f5'), f5short, preWhen, 'pending', 'pre-gate F5 4-inn stays pending');
assertBoth(mlbPick('Under 7.5', 'total'), full9, preWhen, 'win', 'pre-gate 9-inn Under');

// Postponement cutoff. "now" is injected.
const startISO = '2026-10-07T17:00:00Z';
const startMs = Date.parse(startISO);
const preGame = {
  state: 'pre',
  statusName: 'STATUS_SCHEDULED',
  completed: false,
  awayTeam: 'Boston Red Sox',
  homeTeam: 'New York Yankees',
  awayAbbr: 'BOS',
  homeAbbr: 'NYY',
  awayScore: 0,
  homeScore: 0,
  startISO: startISO,
  _sport: 'MLB',
};
const underPick = mlbPick('Under 6.5', 'total', { commenceTime: startISO });
assertBoth(underPick, preGame, opts(V2, startMs + 30 * HOUR), 'push', 'pre 30h past start');
assertBoth(underPick, preGame, opts(V2, startMs + 2 * HOUR), 'pending', 'pre 2h past start');
assertBoth(underPick, preGame, opts(PRE, startMs + 30 * HOUR), 'pending', 'pre-gate stale pre stays pending');

// Rescheduled more than 24h after the ticket commenceTime.
const moved = mlbGame(5, 2, 9, 9, { startISO: new Date(startMs + 30 * HOUR).toISOString() });
const movedPick = mlbPick('Boston Red Sox ML', 'moneyline', { commenceTime: startISO });
assertBoth(movedPick, moved, opts(V2, startMs + 2 * HOUR), 'push', 'rescheduled +30h voids');
assertBoth(movedPick, moved, opts(PRE, startMs + 2 * HOUR), 'win', 'pre-gate reschedule still grades');

// Existing postponed/canceled rule is not date-gated.
const ppdGame = mlbGame(0, 0, 0, 0, {
  state: 'post', completed: false, statusName: 'STATUS_POSTPONED',
  awayLine: [], homeLine: [], awayInnings: 0, homeInnings: 0,
});
const cxlGame = mlbGame(0, 0, 0, 0, {
  state: 'post', completed: false, statusName: 'STATUS_CANCELED',
  awayLine: [], homeLine: [], awayInnings: 0, homeInnings: 0,
});
assertBoth(mlbPick('Under 6.5', 'total'), ppdGame, v2When, 'push', 'postponed v2');
assertBoth(mlbPick('Under 6.5', 'total'), ppdGame, preWhen, 'push', 'postponed pre-gate');
assertBoth(mlbPick('Boston Red Sox ML', 'moneyline'), cxlGame, preWhen, 'push', 'canceled pre-gate');

// ── 4. All-push parlay is not wagered from the gate forward ──
async function twoPushDay(dateISO) {
  const game = mlbGame(3, 3, 9, 9);
  const picksData = {
    picks: [
      mlbPick('Boston Red Sox ML', 'moneyline'),
      mlbPick('New York Yankees ML', 'moneyline'),
    ],
  };
  return results.gradeDay(dateISO, picksData, { games: [game] });
}

(async () => {
  const preDay = await twoPushDay(PRE);
  const v2Day = await twoPushDay(V2);
  assert.strictEqual(preDay.parlayResult, 'push');
  assert.strictEqual(v2Day.parlayResult, 'push');
  const preRow = preDay.picks.find((p) => p.sport === 'PARLAY');
  const v2Row = v2Day.picks.find((p) => p.sport === 'PARLAY');
  assert.ok(preRow && v2Row, 'parlay row stays visible');
  assert.strictEqual(preRow.result, 'push');
  assert.strictEqual(v2Row.result, 'push');
  assert.strictEqual(preDay.wagered, preDay.parlayRisk, 'pre-gate all-push parlay still counts');
  assert.ok(preDay.parlayRisk > 0);
  assert.strictEqual(v2Day.wagered, 0, 'v2 all-push parlay adds no day wager');
  assert.strictEqual(v2Day.profit, 0);

  const aggPre = results.aggregateDays([preDay]);
  const aggV2 = results.aggregateDays([v2Day]);
  assert.strictEqual(aggPre.parlay.totalWagered, preDay.parlayRisk);
  assert.strictEqual(aggV2.parlay.totalWagered, 0);
  assert.strictEqual(aggV2.cumulative.totalWagered, 0);
  assert.strictEqual(aggPre.cumulative.totalWagered, preDay.parlayRisk);

  // Stale pre prints PPD. A 2h-early game stays pending with no score.
  const staleDay = await results.gradeDay(V2, { picks: [underPick] }, {
    games: [preGame],
    now: startMs + 30 * HOUR,
  });
  assert.strictEqual(staleDay.picks[0].result, 'push');
  assert.strictEqual(staleDay.picks[0].score, 'PPD');
  const freshDay = await results.gradeDay(V2, { picks: [underPick] }, {
    games: [preGame],
    now: startMs + 2 * HOUR,
  });
  assert.strictEqual(freshDay.picks[0].result, 'pending');
  assert.notStrictEqual(freshDay.picks[0].score, 'PPD');

  const ppdDay = await results.gradeDay(PRE, { picks: [mlbPick('Under 6.5', 'total')] }, { games: [ppdGame] });
  assert.strictEqual(ppdDay.picks[0].result, 'push');
  assert.strictEqual(ppdDay.picks[0].score, 'PPD');

  // ── 2. track-clv settles NFL/NCAAF only from the gate forward ──
  const troyPick = {
    sport: 'NCAAF',
    betType: 'spread',
    matchup: 'Southern Mississippi Golden Eagles @ Troy Trojans',
    pick: 'Troy Trojans -10',
    odds: '-110',
    units: '1u',
    commenceTime: '2026-10-07T00:00:00Z',
  };
  function troyBoard(awayScore, homeScore) {
    return [{
      state: 'post', completed: true, statusName: 'STATUS_FINAL',
      awayTeam: 'Southern Miss Golden Eagles', homeTeam: 'Troy Trojans',
      awayAbbr: 'USM', homeAbbr: 'TROY',
      awayId: '2572', homeId: '2653',
      awayScore: awayScore, homeScore: homeScore,
      startISO: '2026-10-07T00:00:00Z',
    }];
  }
  const troyWinBoard = troyBoard(10, 31);
  const troyLossBoard = troyBoard(24, 27);
  assert.strictEqual(clv.footballGraderOn(V2, 'NCAAF'), true);
  assert.strictEqual(clv.footballGraderOn(PRE, 'NCAAF'), false);
  assert.strictEqual(clv.footballGraderOn(V2, 'MLB'), false);
  assert.strictEqual(clv.footballGraderOn(V2, 'NFL'), true);

  // Pre-gate fetch still has no football endpoint, so the pick stays unsettled.
  assert.deepStrictEqual(await clv.fetchESPNScores(PRE, 'NCAAF'), []);
  assert.deepStrictEqual(await clv.fetchESPNScores(PRE, 'NFL'), []);
  assert.strictEqual(
    clv.gradePick(troyPick, clv.findGameForGrading(troyPick, [], PRE), opts(PRE)),
    'pending'
  );
  const pendingPicks = { picks: [{ ...troyPick, result: 'pending' }] };
  const pendingN = await clv.settleResultsForDate(PRE, pendingPicks, { skipWrite: true });
  assert.strictEqual(pendingN, 0);
  assert.strictEqual(pendingPicks.picks[0].result, 'pending');

  // Gate date uses get-results findGame (identity), including Step 4's grade call.
  const foundWin = clv.findGameForGrading(troyPick, troyWinBoard, V2);
  assert.strictEqual(foundWin, results.findGame(troyPick, troyWinBoard));
  assert.strictEqual(foundWin.awayTeam, 'Southern Miss Golden Eagles');
  assert.strictEqual(clv.gradePick(troyPick, foundWin, opts(V2)), 'win', 'Troy -10 covers 10-31');
  const foundLoss = clv.findGameForGrading(troyPick, troyLossBoard, V2);
  assert.strictEqual(clv.gradePick(troyPick, foundLoss, opts(V2)), 'loss', 'Troy -10 misses 24-27');

  const settleWin = { picks: [{ ...troyPick }] };
  const nWin = await clv.settleResultsForDate(V2, settleWin, {
    skipWrite: true,
    gamesBySport: { NCAAF: troyWinBoard },
  });
  assert.strictEqual(nWin, 1);
  assert.strictEqual(settleWin.picks[0].result, 'win');
  assert.strictEqual(settleWin.picks[0].finalScore, '10-31');

  // Step 4 grades the CLV row with the same date.
  const clvRow = {
    sport: 'NCAAF', betType: 'spread',
    matchup: troyPick.matchup, pick: troyPick.pick,
    pickTimeOdds: '-110', units: '1u', commenceTime: troyPick.commenceTime,
  };
  const step4Game = clv.findGameForGrading(clvRow, troyLossBoard, V2);
  assert.strictEqual(clv.gradePick(clvRow, step4Game, opts(V2)), 'loss');

  const nflPick = {
    sport: 'NFL', betType: 'spread',
    matchup: 'Los Angeles Rams @ Seattle Seahawks',
    pick: 'Seattle Seahawks -3',
    odds: '-110', units: '1u',
    commenceTime: '2026-10-07T00:20:00Z',
  };
  const nflBoard = [{
    state: 'post', completed: true, statusName: 'STATUS_FINAL',
    awayTeam: 'Los Angeles Rams', homeTeam: 'Seattle Seahawks',
    awayAbbr: 'LAR', homeAbbr: 'SEA',
    awayId: '14', homeId: '26',
    awayScore: 14, homeScore: 24,
    startISO: '2026-10-07T00:20:00Z',
  }];
  const nflGame = clv.findGameForGrading(nflPick, nflBoard, V2);
  assert.ok(nflGame, 'NFL fixture found');
  assert.strictEqual(nflGame, results.findGame(nflPick, nflBoard));
  assert.strictEqual(clv.gradePick(nflPick, nflGame, opts(V2)), 'win', 'Seattle -3 covers 14-24');
  const nflSettle = { picks: [{ ...nflPick }] };
  const nNfl = await clv.settleResultsForDate('2026-10-08', nflSettle, {
    skipWrite: true,
    gamesBySport: { NFL: nflBoard },
  });
  assert.strictEqual(nNfl, 1);
  assert.strictEqual(nflSettle.picks[0].result, 'win');

  // MLB matching stays on the track-clv path.
  const mlbSpread = mlbPick('New York Yankees -1.5', 'spread');
  const yankees = [full9];
  assert.strictEqual(
    clv.findGameForGrading(mlbSpread, yankees, V2),
    clv.findGameForGrading(mlbSpread, yankees, PRE)
  );
  assert.strictEqual(clv.gradePick(mlbSpread, full9, opts(V2)), 'loss');
  assert.strictEqual(clv.gradePick(mlbSpread, full9, opts(PRE)), 'loss');

  // ── 5. Card page: postponed / canceled before any score grade ──
  const page = loadCard(['normalizeTeam', 'schoolKey', 'ncaafAliasMap', 'canonNcaafTeam', 'ncaafSchoolKeysMatch', 'teamsMatch', 'ncaafPickedSides', 'isF5Pick', 'determineResult', 'mapEspnEvent']);
  const soPick = (selection, betType) => ({ sport: 'NHL', pick: selection, betType: betType, matchup: nhlPick(selection, betType).matchup });
  assert.strictEqual(page.determineResult(soPick('Over 4.5', 'total'), nhlGame).status, 'win');
  assert.strictEqual(page.determineResult(soPick('Under 4.5', 'total'), nhlGame).status, 'loss');
  assert.strictEqual(page.determineResult(soPick('Carolina Hurricanes ML', 'moneyline'), nhlGame).status, 'win');
  assert.strictEqual(page.determineResult(soPick('Florida Panthers +1.5', 'puck line'), nhlGame).status, 'win');

  const ppdEvent = {
    date: '2026-10-07T23:00:00Z',
    competitions: [{
      status: { type: { state: 'post', name: 'STATUS_POSTPONED', completed: false, shortDetail: 'Postponed' }, period: 0 },
      competitors: [
        { homeAway: 'away', score: '0', team: { displayName: 'Boston Red Sox', abbreviation: 'BOS' }, linescores: [] },
        { homeAway: 'home', score: '0', team: { displayName: 'New York Yankees', abbreviation: 'NYY' }, linescores: [] },
      ],
    }],
  };
  const mappedPpd = page.mapEspnEvent(ppdEvent, 'MLB');
  assert.strictEqual(mappedPpd.completed, false);
  assert.strictEqual(mappedPpd.statusName, 'STATUS_POSTPONED');
  const ppdCard = page.determineResult(mlbPick('Under 6.5', 'total'), mappedPpd);
  assert.strictEqual(ppdCard.status, 'push');
  assert.ok(ppdCard.label === 'Postponed' || ppdCard.label === 'PPD');

  const cxlCard = page.determineResult(mlbPick('Under 6.5', 'total'), {
    state: 'post', completed: false, statusName: 'STATUS_CANCELED',
    awayTeam: 'Boston Red Sox', homeTeam: 'New York Yankees',
    awayScore: 0, homeScore: 0,
  });
  assert.strictEqual(cxlCard.status, 'push');

  const finalCard = page.determineResult(mlbPick('Under 6.5', 'total'), {
    state: 'post', completed: true, statusName: 'STATUS_FINAL',
    awayTeam: 'Boston Red Sox', homeTeam: 'New York Yankees',
    awayAbbr: 'BOS', homeAbbr: 'NYY',
    awayScore: 2, homeScore: 3,
  });
  assert.strictEqual(finalCard.status, 'win', 'normal final Under is unchanged');
  assert.strictEqual(finalCard.label, 'Win');

  // ── History identity: 2026-09-22..2026-10-06 matches 50d3eb9 ──
  const old = loadOldGraders();
  try {
    const oldGrade = old.results._test.gradePick;
    const oldFind = old.clv._test.findGameForGrading;
    const oldClvGrade = old.clv._test.gradePick;
    const oldAgg = extractAggregate(old.src);

    // Parallel gradeDay calls must not share a card date. The games provider
    // yields until both dates are inside it, which is the window the old
    // module-level context leaked across.
    const raceGame = mlbGame(1, 0, 3, 3);
    const raceStraight = [
      mlbPick('Boston Red Sox ML', 'moneyline'),
      mlbPick('Under 6.5', 'total'),
    ];
    const raceLegs = [
      mlbPick('Boston Red Sox ML', 'moneyline'),
      mlbPick('Under 6.5', 'total'),
    ];
    const raceCard = { picks: raceStraight, parlayLegs: [{ legs: raceLegs }] };
    let raceArrived = 0;
    let openRace;
    const raceGate = new Promise((resolve) => { openRace = resolve; });
    let bareDuringRace = null;
    function racingBoard() {
      raceArrived += 1;
      if (raceArrived === 2) {
        bareDuringRace = results.gradePick(mlbPick('Boston Red Sox ML', 'moneyline'), raceGame);
        openRace();
      }
      return Promise.race([
        raceGate,
        new Promise((_, reject) => setTimeout(() => reject(new Error('gradeDay calls did not overlap')), 2000)),
      ]).then(() => new Promise((resolve) => setImmediate(() => resolve([raceGame]))));
    }
    const [day05, day07] = await Promise.all([
      results.gradeDay('2026-10-05', raceCard, { games: racingBoard, now: startMs }),
      results.gradeDay('2026-10-07', raceCard, { games: () => racingBoard(), now: startMs }),
    ]);
    assert.strictEqual(raceArrived, 2, 'both dates awaited the games provider');
    assert.strictEqual(bareDuringRace, oldGrade(mlbPick('Boston Red Sox ML', 'moneyline'), raceGame), 'no opts during gradeDay matches 50d3eb9');
    for (const graded of day05.picks.filter((p) => p.sport !== 'PARLAY')) {
      const src = raceStraight.find((p) => p.pick === graded.pick);
      assert.strictEqual(graded.result, oldGrade(src, raceGame), 'concurrent 10-05 ' + graded.pick);
    }
    const oldLegInput = raceLegs.map((leg) => ({ result: oldGrade(leg, raceGame), odds: leg.odds || '-110' }));
    assert.strictEqual(
      day05.parlayResult,
      results.gradeParlay(oldLegInput, day05.parlayRisk).result,
      'concurrent 10-05 parlay matches 50d3eb9 leg grades'
    );
    assert.strictEqual(day05.picks.find((p) => p.pick === 'Boston Red Sox ML').result, 'win');
    assert.strictEqual(day07.picks.find((p) => p.pick === 'Boston Red Sox ML').result, 'push', 'concurrent 10-07 ML voids');
    assert.strictEqual(day07.picks.find((p) => p.pick === 'Under 6.5').result, 'push', 'concurrent 10-07 total voids');
    assert.strictEqual(day07.parlayResult, 'push', 'concurrent 10-07 parlay legs void');

    const historyGames = [
      ['short3', short3],
      ['half5', half5],
      ['inn6', inn6few],
      ['full9', full9],
      ['half9', half9],
      ['f5short', f5short],
      ['noLines', noLines],
      ['ppd', ppdGame],
      ['pre', preGame],
    ];
    const historyPicks = [
      mlbPick('Boston Red Sox ML', 'moneyline'),
      mlbPick('New York Yankees -1.5', 'spread'),
      mlbPick('Under 6.5', 'total'),
      mlbPick('Over 6.5', 'total'),
      mlbPick('Over 0.5', 'total'),
      mlbPick('Boston Red Sox F5', 'f5'),
      mlbPick('Under 7.5', 'total'),
      underPick,
    ];
    const dates = [];
    for (let t = Date.parse('2026-09-22T12:00:00Z'); t <= Date.parse('2026-10-06T12:00:00Z'); t += 24 * HOUR) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    assert.strictEqual(dates[0], '2026-09-22');
    assert.strictEqual(dates[dates.length - 1], '2026-10-06');
    assert.strictEqual(dates.length, 15);

    const staleNow = startMs + 30 * HOUR;
    for (const dateISO of dates) {
      for (const [name, game] of historyGames) {
        for (const pick of historyPicks) {
          const label = dateISO + ' ' + name + ' ' + pick.pick;
          const oldResult = oldGrade(pick, game);
          assert.strictEqual(results.gradePick(pick, game, opts(dateISO, staleNow)), oldResult, 'results ' + label);
          assert.strictEqual(clv.gradePick(pick, game, opts(dateISO, staleNow)), oldClvGrade(pick, game), 'clv ' + label);
        }
      }
      const emptyNcaaf = await clv.fetchESPNScores(dateISO, 'NCAAF');
      const emptyNfl = await clv.fetchESPNScores(dateISO, 'NFL');
      assert.deepStrictEqual(emptyNcaaf, await old.clv._test.fetchESPNScores(dateISO, 'NCAAF'), 'ncaaf fetch ' + dateISO);
      assert.deepStrictEqual(emptyNfl, await old.clv._test.fetchESPNScores(dateISO, 'NFL'), 'nfl fetch ' + dateISO);
      const oldTroy = oldFind(troyPick, troyWinBoard);
      const newTroy = clv.findGameForGrading(troyPick, troyWinBoard, dateISO);
      assert.strictEqual(oldClvGrade(troyPick, oldTroy), clv.gradePick(troyPick, newTroy, opts(dateISO)), 'troy ' + dateISO);
      const oldNfl = oldFind(nflPick, nflBoard);
      const newNfl = clv.findGameForGrading(nflPick, nflBoard, dateISO);
      assert.strictEqual(oldClvGrade(nflPick, oldNfl), clv.gradePick(nflPick, newNfl, opts(dateISO)), 'nfl ' + dateISO);

      const day = await results.gradeDay(dateISO, {
        picks: [
          mlbPick('Boston Red Sox ML', 'moneyline'),
          mlbPick('Under 6.5', 'total'),
        ],
      }, { games: [short3], now: staleNow });
      for (const graded of day.picks.filter((p) => p.sport !== 'PARLAY')) {
        const srcPick = day.picks.indexOf(graded) === 0
          ? mlbPick('Boston Red Sox ML', 'moneyline')
          : mlbPick('Under 6.5', 'total');
        assert.strictEqual(graded.result, oldGrade(srcPick, short3), 'gradeDay ' + dateISO + ' ' + graded.pick);
      }
    }

    const legacyPush = {
      date: '2026-08-15',
      wins: 0, losses: 0, pushes: 2, pending: 0,
      wagered: 75, profit: 0,
      parlayResult: 'push', parlayProfit: 0, parlayRisk: 75,
      picks: [
        { sport: 'MLB', units: '1u', result: 'push', profit: 0 },
        { sport: 'MLB', units: '1u', result: 'push', profit: 0 },
      ],
    };
    const historyDays = [legacyPush].concat(dates.map((date) => ({
      date: date,
      wins: 1, losses: 0, pushes: 0, pending: 0,
      wagered: 225, profit: 100,
      parlayResult: 'push', parlayProfit: 0, parlayRisk: 75,
      picks: [{ sport: 'MLB', units: '1u', result: 'win', profit: 100 }],
    })));
    const newAgg = results.aggregateDays(historyDays);
    const prevAgg = oldAgg(historyDays);
    // old aggregateDays runs in a vm, so its objects have a different prototype.
    // Compare the JSON values.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(newAgg)), JSON.parse(JSON.stringify(prevAgg)));

    // The gate date is the first one that drops the all-push parlay stake.
    const gated = historyDays.concat([{
      date: V2,
      wins: 0, losses: 0, pushes: 2, pending: 0,
      wagered: 0, profit: 0,
      parlayResult: 'push', parlayProfit: 0, parlayRisk: 75,
      picks: [],
    }]);
    assert.strictEqual(results.aggregateDays(gated).parlay.totalWagered, oldAgg(historyDays).parlay.totalWagered);
    assert.ok(oldAgg(gated).parlay.totalWagered > results.aggregateDays(gated).parlay.totalWagered);

    console.log('ok test-omega-grading-rules');
  } finally {
    old.cleanup();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function extractFunction(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('missing function ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  let quote = null;
  let escape = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unclosed comment in ' + name);
      i = end + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function loadCard(names) {
  const src = fs.readFileSync(path.join(repo, 'daily-omega/index.html'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(src, name)).join('\n'), sandbox, { filename: 'daily-omega/index.html' });
  return sandbox;
}

function loadOldGraders() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-grade-old-'));
  const rels = [
    'netlify/functions/get-results-omega.js',
    'netlify/functions/track-clv-omega.js',
  ];
  let src = '';
  for (const rel of rels) {
    const body = execSync('git show 50d3eb9:' + rel, { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (rel.endsWith('get-results-omega.js')) src = body;
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  fs.symlinkSync(path.join(repo, 'netlify/functions/lib'), path.join(tmp, 'netlify/functions/lib'));
  fs.symlinkSync(path.join(repo, 'js'), path.join(tmp, 'js'));
  return {
    src: src,
    results: require(path.join(tmp, 'netlify/functions/get-results-omega.js')),
    clv: require(path.join(tmp, 'netlify/functions/track-clv-omega.js')),
    cleanup: () => {
      fs.unlinkSync(path.join(tmp, 'netlify/functions/lib'));
      fs.unlinkSync(path.join(tmp, 'js'));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function extractAggregate(src) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    [extractFunction(src, 'wholeUp'), extractFunction(src, 'pct'), extractFunction(src, 'aggregateDays')].join('\n'),
    sandbox
  );
  return sandbox.aggregateDays;
}
