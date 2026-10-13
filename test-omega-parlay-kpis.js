'use strict';
// Parlay KPIs use the card stake. A card with no parlay has no parlay row.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const results = require('./netlify/functions/get-results-omega')._test;

function mlbGame(awayRuns, homeRuns) {
  const awayLine = [awayRuns, 0, 0, 0, 0, 0, 0, 0, 0];
  const homeLine = [homeRuns, 0, 0, 0, 0, 0, 0, 0, 0];
  return {
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    awayTeam: 'Boston Red Sox',
    homeTeam: 'New York Yankees',
    awayScore: awayRuns,
    homeScore: homeRuns,
    awayLine,
    homeLine,
    awayInnings: 9,
    homeInnings: 9,
    startISO: '2026-10-12T23:05:00Z',
    _sport: 'MLB',
  };
}

function mlbPick(selection) {
  return {
    sport: 'MLB',
    matchup: 'Boston Red Sox @ New York Yankees',
    pick: selection,
    betType: 'moneyline',
    odds: '-110',
    units: '1u',
    commenceTime: '2026-10-12T23:05:00Z',
  };
}

(async () => {
  const win = mlbPick('New York Yankees ML');
  const lose = mlbPick('Boston Red Sox ML');
  const game = mlbGame(3, 5);
  const leanDay = await results.gradeDay('2026-10-12', {
    picks: [win, lose],
    parlayLegs: [{ units: '0.25u', leanDay: true, legs: [win, lose] }],
  }, { games: [game] });
  const parlay = leanDay.picks.find((p) => p.sport === 'PARLAY');
  assert.ok(parlay);
  assert.strictEqual(parlay.units, '0.25u');
  assert.strictEqual(parlay.result, 'loss');
  assert.strictEqual(leanDay.parlayRisk, 37.5);
  assert.strictEqual(leanDay.parlayProfit, -37.5);
  assert.notStrictEqual(leanDay.parlayRisk, 75);
  const straightWager = leanDay.picks
    .filter((p) => p.sport !== 'PARLAY' && (p.result === 'win' || p.result === 'loss'))
    .reduce((sum, p) => sum + results.wholeUp((parseFloat(p.units) || 1) * 150), 0);
  assert.strictEqual(leanDay.wagered, results.dollars(straightWager + 37.5));

  const byStake = await results.gradeDay('2026-10-12', {
    picks: [win, lose],
    parlayLegs: [{ stake: '0.25u', legs: [win, lose] }],
  }, { games: [game] });
  assert.strictEqual(byStake.parlayRisk, 37.5);

  const byFlag = await results.gradeDay('2026-10-12', {
    picks: [win, lose],
    parlayLegs: [{ leanDay: true, legs: [win, lose] }],
  }, { games: [game] });
  assert.strictEqual(byFlag.parlayRisk, 37.5);
  assert.strictEqual(byFlag.picks.find((p) => p.sport === 'PARLAY').units, '0.25u');

  const half = await results.gradeDay('2026-10-12', {
    picks: [win, lose],
    parlayLegs: [{ units: '0.5u', legs: [win, lose] }],
  }, { games: [game] });
  assert.strictEqual(half.parlayRisk, 75);
  assert.strictEqual(half.picks.find((p) => p.sport === 'PARLAY').units, '0.5u');

  const tie = mlbGame(3, 3);
  const noParlay = await results.gradeDay('2026-10-12', {
    picks: [mlbPick('Boston Red Sox ML'), mlbPick('New York Yankees ML')],
    parlayLegs: [],
  }, { games: [tie] });
  assert.strictEqual(noParlay.parlayResult, 'skip');
  assert.strictEqual(noParlay.parlayProfit, 0);
  assert.strictEqual(noParlay.parlayRisk, 0);
  assert.ok(!noParlay.picks.some((p) => p.sport === 'PARLAY'));
  assert.strictEqual(noParlay.wagered, 0);

  const missing = await results.gradeDay('2026-10-12', {
    picks: [mlbPick('Boston Red Sox ML'), mlbPick('New York Yankees ML')],
  }, { games: [tie] });
  assert.strictEqual(missing.parlayResult, 'skip');
  assert.strictEqual(missing.parlayRisk, 0);
  assert.ok(!missing.picks.some((p) => p.sport === 'PARLAY'));

  const short = await results.gradeDay('2026-10-12', {
    picks: [win, lose],
    parlayLegs: [{ units: '0.5u', legs: [win] }],
  }, { games: [game] });
  assert.strictEqual(short.parlayResult, 'skip');
  assert.ok(!short.picks.some((p) => p.sport === 'PARLAY'));

  const stored = {
    date: '2026-10-12',
    wagered: 375,
    profit: -375,
    parlayResult: 'loss',
    parlayProfit: -75,
    parlayRisk: 75,
    picks: [
      { sport: 'MLB', pick: 'New York Yankees ML', matchup: win.matchup, odds: '-110', units: '1u', result: 'win', profit: 137 },
      { sport: 'MLB', pick: 'Boston Red Sox ML', matchup: lose.matchup, odds: '-110', units: '1u', result: 'loss', profit: -150 },
      { sport: 'PARLAY', pick: '2-Team Parlay', units: '0.5u', result: 'loss', profit: -75 },
    ],
  };
  const card = {
    date: '2026-10-12',
    picks: [win, lose],
    parlayLegs: [{ units: '0.25u', leanDay: true, legs: [win, lose] }],
  };
  const recomputed = results.recomputeParlayFields(stored, card);
  assert.strictEqual(stored.parlayRisk, 75);
  assert.strictEqual(recomputed.parlayRisk, 37.5);
  assert.strictEqual(recomputed.parlayProfit, -37.5);
  assert.strictEqual(recomputed.picks.find((p) => p.sport === 'PARLAY').units, '0.25u');
  assert.strictEqual(recomputed.wagered, 337.5);

  const dropped = results.recomputeParlayFields(stored, { date: '2026-10-12', picks: [win, lose], parlayLegs: [] });
  assert.strictEqual(dropped.parlayResult, 'skip');
  assert.strictEqual(dropped.parlayRisk, 0);
  assert.strictEqual(dropped.wagered, 300);
  assert.ok(!dropped.picks.some((p) => p.sport === 'PARLAY'));
  assert.strictEqual(stored.picks.filter((p) => p.sport === 'PARLAY').length, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-parlay-kpis-'));
  const resultFile = path.join(dir, 'results.json');
  const original = {
    results: [JSON.parse(JSON.stringify(stored))],
    cards: [card, { date: '2026-10-12', picks: [win], parlayLegs: [] }],
  };
  original.cards[1].date = '2026-10-11';
  fs.writeFileSync(resultFile, JSON.stringify(original, null, 2));
  const script = path.join(__dirname, 'tools/omega-recompute-parlay-kpis.js');
  const dry = spawnSync(process.execPath, [script, resultFile], { encoding: 'utf8' });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes('37.5'), dry.stdout);
  assert.ok(dry.stdout.includes('75'), dry.stdout);
  assert.strictEqual(fs.readFileSync(resultFile, 'utf8'), JSON.stringify(original, null, 2));

  const written = spawnSync(process.execPath, [script, resultFile, '--write'], { encoding: 'utf8' });
  assert.strictEqual(written.status, 0, written.stderr);
  const after = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.strictEqual(after.results[0].parlayRisk, 37.5);
  assert.strictEqual(after.cards[0].parlayLegs[0].units, '0.25u');

  const noneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-parlay-none-'));
  fs.writeFileSync(path.join(noneDir, 'day.json'), JSON.stringify(stored));
  fs.writeFileSync(path.join(noneDir, 'card.json'), JSON.stringify({
    date: '2026-10-12', picks: [win, lose], parlayLegs: [],
  }));
  const dryDir = spawnSync(process.execPath, [script, noneDir], { encoding: 'utf8' });
  assert.strictEqual(dryDir.status, 0, dryDir.stderr);
  assert.ok(dryDir.stdout.includes('skip'), dryDir.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(noneDir, 'day.json'), 'utf8')).parlayRisk, 75);
  const writeDir = spawnSync(process.execPath, [script, noneDir, '--write'], { encoding: 'utf8' });
  assert.strictEqual(writeDir.status, 0, writeDir.stderr);
  const dayAfter = JSON.parse(fs.readFileSync(path.join(noneDir, 'day.json'), 'utf8'));
  assert.strictEqual(dayAfter.parlayResult, 'skip');
  assert.strictEqual(dayAfter.parlayRisk, 0);
  assert.ok(!dayAfter.picks.some((p) => p.sport === 'PARLAY'));
  const cardAfter = JSON.parse(fs.readFileSync(path.join(noneDir, 'card.json'), 'utf8'));
  assert.deepStrictEqual(cardAfter.parlayLegs, []);

  // Published 2026-10-13 ticket: units 0.25u, no leanDay, no public tier.
  // A stale results row at 0.5u / $75 recomputes to 0.25u / $37.50.
  // Straight units stay 0.5u. The stored row is not mutated.
  const nhlLeg = (pick, matchup, odds, betType, rating) => ({
    sport: 'NHL', matchup, pick, odds, units: '0.5u', rating, betType,
    commenceTime: '2026-10-14T02:40:00Z',
  });
  const oilers = nhlLeg('Over 6.5', 'Edmonton Oilers @ Los Angeles Kings', '+105', 'Total', 'aminus');
  const canucks = nhlLeg('Over 6.5', 'Vancouver Canucks @ New York Islanders', '+114', 'Total', 'aminus');
  const rangers = nhlLeg('New York Rangers +1.5', 'Tampa Bay Lightning @ New York Rangers', '-185', 'Spread', 'b');
  const card1013 = {
    date: '2026-10-13',
    picks: [oilers, canucks, rangers],
    parlayLegs: [{
      type: '3-leg-parlay-straight',
      units: '0.25u',
      combinedOdds: '+576',
      ev: '3.3%',
      legs: [oilers, canucks, rangers],
    }],
  };
  assert.ok(card1013.picks.every((p) => p.tier == null));
  assert.strictEqual(card1013.parlayLegs[0].leanDay, undefined);
  const graded1013 = await results.gradeDay('2026-10-13', card1013, { games: [] });
  const par1013 = graded1013.picks.find((p) => p.sport === 'PARLAY');
  assert.strictEqual(par1013.units, '0.25u');
  assert.strictEqual(graded1013.parlayRisk, 37.5);
  assert.strictEqual(graded1013.parlayProfit, 0);
  assert.strictEqual(graded1013.parlayResult, 'pending');
  assert.notStrictEqual(graded1013.parlayRisk, 75);
  assert.ok(graded1013.picks.filter((p) => p.sport !== 'PARLAY').every((p) => p.units === '0.5u'));

  const stale1013 = {
    date: '2026-10-13',
    wagered: 0,
    profit: 0,
    parlayResult: 'pending',
    parlayProfit: 0,
    parlayRisk: 75,
    picks: [
      { sport: 'NHL', pick: oilers.pick, matchup: oilers.matchup, odds: '+105', units: '0.5u', result: 'pending', profit: 0 },
      { sport: 'NHL', pick: canucks.pick, matchup: canucks.matchup, odds: '+114', units: '0.5u', result: 'pending', profit: 0 },
      { sport: 'NHL', pick: rangers.pick, matchup: rangers.matchup, odds: '-185', units: '0.5u', result: 'pending', profit: 0 },
      { sport: 'PARLAY', pick: '3-Team Parlay (Optimized)', units: '0.5u', result: 'pending', profit: 0 },
    ],
  };
  const otherDay = {
    date: '2026-10-11',
    parlayResult: 'loss',
    parlayRisk: 75,
    parlayProfit: -75,
    picks: [{ sport: 'PARLAY', units: '0.5u', result: 'loss', profit: -75 }],
  };
  const fixed1013 = results.recomputeParlayFields(stale1013, card1013);
  assert.strictEqual(stale1013.parlayRisk, 75);
  assert.strictEqual(stale1013.picks.find((p) => p.sport === 'PARLAY').units, '0.5u');
  assert.strictEqual(fixed1013.parlayRisk, 37.5);
  assert.strictEqual(fixed1013.parlayProfit, 0);
  assert.strictEqual(fixed1013.picks.find((p) => p.sport === 'PARLAY').units, '0.25u');
  assert.strictEqual(fixed1013.wagered, 0);
  assert.ok(fixed1013.picks.filter((p) => p.sport !== 'PARLAY').every((p) => p.units === '0.5u' && p.result === 'pending'));
  assert.strictEqual(otherDay.parlayRisk, 75);
  assert.strictEqual(otherDay.picks[0].units, '0.5u');

  console.log('PASS test-omega-parlay-kpis');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
