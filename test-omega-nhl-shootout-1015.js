'use strict';
// NHL shootout grading, forward-only from 2026-10-15. No network.
// Totals and puck line drop the shootout winner's goal. Moneyline does not.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repo = __dirname;
const rules = require('./netlify/functions/lib/omega-grading-rules');
const board = require('./netlify/functions/lib/espn-scoreboard');
const live = require('./js/live-score');
const results = require('./netlify/functions/get-results-omega')._test;
const clv = require('./netlify/functions/track-clv-omega')._test;
const legacy = require('./netlify/functions/track-clv')._test;

const FROM = '2026-10-15';
const BEFORE = '2026-10-14';

function literal(file, name) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  const re = new RegExp(name + "\\s*=\\s*'([^']+)'");
  const m = re.exec(src);
  assert.ok(m, file + ' missing ' + name);
  return m[1];
}

assert.strictEqual(literal('netlify/functions/lib/omega-grading-rules.js', 'NHL_SHOOTOUT_RULE_FROM'), FROM);
assert.strictEqual(literal('js/live-score.js', 'NHL_SHOOTOUT_RULE_FROM'), FROM);
assert.strictEqual(rules.NHL_SHOOTOUT_RULE_FROM, FROM);
assert.strictEqual(live.NHL_SHOOTOUT_RULE_FROM, FROM);
assert.strictEqual(rules.GRADING_RULES_V2_FROM, '2026-10-07');

for (const pred of [rules.nhlShootoutExcluded, live.nhlShootoutExcluded]) {
  assert.strictEqual(pred(FROM), true);
  assert.strictEqual(pred('2026-10-16'), true);
  assert.strictEqual(pred(BEFORE), false);
  assert.strictEqual(pred('2026-09-22'), false);
  assert.strictEqual(pred(null), false);
  assert.strictEqual(pred(undefined), false);
  assert.strictEqual(pred(''), false);
}

function soStatus(detail, shortDetail, period, extraType) {
  return {
    period: period,
    type: Object.assign({
      state: 'post',
      name: 'STATUS_FINAL',
      completed: true,
      detail: detail,
      shortDetail: shortDetail,
    }, extraType || {}),
  };
}

function competitors(awayScore, homeScore, awayLines, homeLines) {
  return [
    {
      homeAway: 'away',
      score: String(awayScore),
      team: { displayName: 'Florida Panthers', abbreviation: 'FLA', id: '13' },
      linescores: awayLines || [],
    },
    {
      homeAway: 'home',
      score: String(homeScore),
      team: { displayName: 'Carolina Hurricanes', abbreviation: 'CAR', id: '7' },
      linescores: homeLines || [],
    },
  ];
}

function eventFrom(status, awayScore, homeScore, awayLines, homeLines) {
  const sides = competitors(awayScore, homeScore, awayLines, homeLines);
  return {
    id: 'so-1',
    date: '2026-10-15T23:00:00Z',
    competitions: [{ status: status, date: '2026-10-15T23:00:00Z', competitors: sides }],
  };
}

function assertMapped(label, mapped, shootout, winner, awayScore, homeScore) {
  assert.ok(mapped, label + ' mapped');
  assert.strictEqual(mapped.shootout, shootout, label + ' shootout');
  assert.strictEqual(mapped.shootoutWinner, winner, label + ' winner');
  assert.strictEqual(mapped.awayScore, awayScore, label + ' away score stays official');
  assert.strictEqual(mapped.homeScore, homeScore, label + ' home score stays official');
}

const finalSo = eventFrom(soStatus('Final/SO', 'Final/SO', 5), 3, 4);
assertMapped('Final/SO', board.mapEvent(finalSo, 'NHL'), true, 'home', 3, 4);
assert.strictEqual(board.mapEvent(finalSo, 'NHL').detail, 'Final/SO');

const finalSoCaps = eventFrom(soStatus('Final', 'FINAL/SO', 5), 3, 4);
assertMapped('FINAL/SO', board.mapEvent(finalSoCaps, 'NHL'), true, 'home', 3, 4);
assert.strictEqual(board.mapEvent(finalSoCaps, 'NHL').detail, 'FINAL/SO');

const word = eventFrom(soStatus('Final/Shootout', 'Final/Shootout', 5), 4, 3);
assertMapped('Final/Shootout', board.mapEvent(word, 'NHL'), true, 'away', 4, 3);

const periodOnly = eventFrom(soStatus('Final', 'Final', 5), 3, 4);
assertMapped('NHL period 5', board.mapEvent(periodOnly, 'NHL'), true, 'home', 3, 4);
assertMapped('period 5 without sport', board.mapEvent(periodOnly), false, null, 3, 4);

const lineSo = eventFrom(soStatus('Final', 'Final', 4), 3, 4, null, [
  { value: '1' },
  { value: '1', periodType: 'Shootout' },
]);
assertMapped('linescore Shootout', board.mapEvent(lineSo, 'MLB'), true, 'home', 3, 4);

const abbrSo = eventFrom(soStatus('Final', 'Final', 3), 3, 4, [
  { value: '1', type: { abbreviation: 'SO' } },
], null);
assertMapped('linescore SO abbr', board.mapEvent(abbrSo), true, 'home', 3, 4);

const ot = eventFrom(soStatus('Final/OT', 'Final/OT', 4), 2, 3);
assertMapped('Final/OT', board.mapEvent(ot, 'NHL'), false, null, 2, 3);

const twoOt = eventFrom(soStatus('Final/2OT', 'Final/2OT', 5), 3, 4);
assertMapped('Final/2OT', board.mapEvent(twoOt, 'NHL'), false, null, 3, 4);

const mlb9 = eventFrom(soStatus('Final', 'Final', 9), 3, 2);
assertMapped('MLB period 9', board.mapEvent(mlb9, 'MLB'), false, null, 3, 2);

const mlb10 = eventFrom(soStatus('Final/10', 'Final/10', 10), 4, 3);
assertMapped('MLB Final/10', board.mapEvent(mlb10, 'MLB'), false, null, 4, 3);

const flagged = eventFrom(soStatus('Final', 'Final', 3, { shootout: true }), 1, 2);
assertMapped('type.shootout', board.mapEvent(flagged, 'MLB'), true, 'home', 1, 2);

const detectCases = [finalSo, finalSoCaps, word, periodOnly, lineSo, abbrSo, ot, twoOt, mlb9, mlb10, flagged];
for (const ev of detectCases) {
  const comp = ev.competitions[0];
  const away = comp.competitors[0];
  const home = comp.competitors[1];
  for (const sport of ['NHL', 'MLB', '', undefined]) {
    const a = board.detectNhlShootout(comp.status, away, home, sport);
    const b = live.detectNhlShootout(comp.status, away, home, sport);
    assert.deepStrictEqual(b, a, 'detect parity ' + sport + ' ' + (comp.status.type.detail || ''));
  }
}

function nhlGame(extra) {
  return Object.assign({
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    detail: 'Final/SO',
    period: 5,
    awayTeam: 'Florida Panthers',
    homeTeam: 'Carolina Hurricanes',
    awayAbbr: 'FLA',
    homeAbbr: 'CAR',
    awayScore: 3,
    homeScore: 4,
    sport: 'NHL',
    _sport: 'NHL',
    startISO: '2026-10-15T23:00:00Z',
  }, extra || {});
}

function nhlPick(selection, betType, extra) {
  return Object.assign({
    sport: 'NHL',
    matchup: 'Florida Panthers @ Carolina Hurricanes',
    pick: selection,
    betType: betType,
    odds: '-110',
    units: '1u',
  }, extra || {});
}

function reg(dateISO, pick, game, market) {
  const input = { pick: pick, game: game, awayScore: game.awayScore, homeScore: game.homeScore, market: market };
  if (dateISO !== undefined) input.dateISO = dateISO;
  const server = rules.nhlRegulationScores(input);
  const client = live.nhlRegulationScores(input);
  assert.deepStrictEqual(client, server, 'score parity ' + (pick && pick.pick) + ' ' + dateISO);
  return server;
}

const so = nhlGame();
const over = nhlPick('Over 6.5', 'total');
const on = reg(FROM, over, so, 'total');
assert.strictEqual(on.applied, true);
assert.strictEqual(on.winner, 'home');
assert.strictEqual(on.awayScore, 3);
assert.strictEqual(on.homeScore, 3);
const off = reg(BEFORE, over, so, 'total');
assert.strictEqual(off.applied, false);
assert.strictEqual(off.awayScore, 3);
assert.strictEqual(off.homeScore, 4);
const undated = reg(null, over, so, 'total');
assert.strictEqual(undated.applied, false);
assert.deepStrictEqual(reg(undefined, Object.assign({ date: FROM }, over), so, 'total'), on);
assert.deepStrictEqual(reg(null, Object.assign({ date: FROM }, over), so, 'total'), off);
assert.strictEqual(reg(FROM, nhlPick('Carolina Hurricanes ML', 'moneyline'), so, 'moneyline').applied, false);
assert.strictEqual(reg(FROM, nhlPick('Over 6.5', 'total', { source: 'f5' }), so, 'total').applied, false);

const plain = nhlGame({ detail: 'Final', period: 3, awayScore: 2, homeScore: 4 });
assert.strictEqual(reg(FROM, nhlPick('Over 5.5', 'total'), plain, 'total').applied, false);
const otGame = nhlGame({ detail: 'Final/OT', period: 4, awayScore: 2, homeScore: 3 });
assert.strictEqual(reg(FROM, nhlPick('Over 4.5', 'total'), otGame, 'total').applied, false);
const two = nhlGame({ detail: 'Final/2OT', period: 5, awayScore: 3, homeScore: 4 });
assert.strictEqual(reg(FROM, nhlPick('Over 6.5', 'total'), two, 'total').applied, false);
const tied = nhlGame({ awayScore: 3, homeScore: 3 });
const tiedReg = reg(FROM, over, tied, 'total');
assert.strictEqual(tiedReg.applied, false);
assert.strictEqual(tiedReg.awayScore, 3);
assert.strictEqual(tiedReg.homeScore, 3);
const periodGame = nhlGame({ detail: 'Final', shortDetail: '', period: 5 });
assert.strictEqual(reg(FROM, over, periodGame, 'total').applied, true);

function gradeAll(pick, game, when) {
  const opts = when === undefined ? undefined : { dateISO: when };
  const r = results.gradePick(pick, game, opts);
  const c = clv.gradePick(pick, game, opts);
  const l = legacy.gradePick(pick, game, opts);
  assert.strictEqual(c, r, 'clv ' + pick.pick + ' ' + when + ' → ' + c);
  assert.strictEqual(l, r, 'legacy ' + pick.pick + ' ' + when + ' → ' + l);
  return r;
}

const NEW_GRADES = [
  ['Over 6.5', 'total', 'loss'],
  ['Under 6.5', 'total', 'win'],
  ['Over 6', 'total', 'push'],
  ['Under 6', 'total', 'push'],
  ['Carolina Hurricanes -1.5', 'puck line', 'loss'],
  ['Florida Panthers +1.5', 'puck line', 'win'],
  ['Carolina Hurricanes -1.0', 'puck line', 'loss'],
  ['Florida Panthers +1.0', 'puck line', 'win'],
  ['Carolina Hurricanes ML', 'moneyline', 'win'],
  ['Florida Panthers ML', 'moneyline', 'loss'],
];
const OLD_GRADES = [
  ['Over 6.5', 'total', 'win'],
  ['Under 6.5', 'total', 'loss'],
  ['Over 6', 'total', 'win'],
  ['Under 6', 'total', 'loss'],
  ['Carolina Hurricanes -1.5', 'puck line', 'loss'],
  ['Florida Panthers +1.5', 'puck line', 'win'],
  ['Carolina Hurricanes -1.0', 'puck line', 'push'],
  ['Florida Panthers +1.0', 'puck line', 'push'],
  ['Carolina Hurricanes ML', 'moneyline', 'win'],
  ['Florida Panthers ML', 'moneyline', 'loss'],
];

for (const row of NEW_GRADES) {
  assert.strictEqual(gradeAll(nhlPick(row[0], row[1]), so, FROM), row[2], 'new ' + row[0]);
}
for (const when of [BEFORE, '2026-09-22', null]) {
  for (const row of OLD_GRADES) {
    assert.strictEqual(gradeAll(nhlPick(row[0], row[1]), so, when), row[2], 'old ' + when + ' ' + row[0]);
  }
}
for (const row of OLD_GRADES) {
  const pick = nhlPick(row[0], row[1]);
  assert.strictEqual(results.gradePick(pick, so), row[2], 'results no opts ' + row[0]);
  assert.strictEqual(legacy.gradePick(pick, so), row[2], 'legacy no opts ' + row[0]);
  assert.strictEqual(clv.gradePick(pick, so), row[2], 'clv no opts ' + row[0]);
}
const datedPick = nhlPick('Over 6.5', 'total', { date: FROM });
assert.strictEqual(results.gradePick(datedPick, so), 'win', 'results ignores pick.date without opts');
assert.strictEqual(legacy.gradePick(datedPick, so), 'win', 'legacy ignores pick.date without opts');
assert.strictEqual(clv.gradePick(datedPick, so), 'loss', 'clv-omega keeps its pick.date fallback');
assert.strictEqual(clv.gradePick(datedPick, so, { dateISO: BEFORE }), 'win', 'opts date beats pick.date');

assert.strictEqual(gradeAll(nhlPick('Over 5.5', 'total'), plain, FROM), 'win', 'regulation total');
assert.strictEqual(gradeAll(nhlPick('Carolina Hurricanes -1.5', 'puck line'), plain, FROM), 'win', 'regulation -1.5');
assert.strictEqual(gradeAll(nhlPick('Over 4.5', 'total'), otGame, FROM), 'win', 'OT goal counts');
assert.strictEqual(gradeAll(nhlPick('Over 6.5', 'total'), two, FROM), 'win', '2OT is not a shootout');
assert.strictEqual(gradeAll(nhlPick('Over 6.5', 'total'), nhlGame({ detail: 'FINAL/SO' }), FROM), 'loss', 'FINAL/SO detail');
assert.strictEqual(gradeAll(nhlPick('Over 6', 'total'), tied, FROM), 'push', 'tied SO score is not reduced');

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

function loadPage(file, names, extra) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  const sandbox = Object.assign({ WeBetLive: live, picksData: null, PICKS_DATA: null }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(src, name)).join('\n'), sandbox, { filename: file });
  return sandbox;
}

const pageNames = [
  'normalizeTeam', 'schoolKey', 'ncaafAliasMap', 'canonNcaafTeam', 'ncaafSchoolKeysMatch',
  'teamsMatch', 'ncaafPickedSides', 'isF5Pick', 'determineResult', 'mapEspnEvent',
];
const page = loadPage('daily-omega/index.html', pageNames);
const bare = loadPage('daily-omega/index.html', pageNames, { WeBetLive: undefined });

function pageGrade(api, selection, betType, game, dateISO) {
  const pick = nhlPick(selection, betType);
  if (dateISO) pick.date = dateISO;
  return api.determineResult(pick, game).status;
}

assert.strictEqual(pageGrade(page, 'Over 6.5', 'total', so, FROM), 'loss');
assert.strictEqual(pageGrade(page, 'Under 6.5', 'total', so, FROM), 'win');
assert.strictEqual(pageGrade(page, 'Over 6', 'total', so, FROM), 'push');
assert.strictEqual(pageGrade(page, 'Carolina Hurricanes -1.5', 'puck line', so, FROM), 'loss');
assert.strictEqual(pageGrade(page, 'Florida Panthers +1.5', 'puck line', so, FROM), 'win');
assert.strictEqual(pageGrade(page, 'Carolina Hurricanes -1.0', 'puck line', so, FROM), 'loss');
assert.strictEqual(pageGrade(page, 'Carolina Hurricanes ML', 'moneyline', so, FROM), 'win');
assert.strictEqual(pageGrade(page, 'Over 6.5', 'total', so, BEFORE), 'win');
assert.strictEqual(pageGrade(page, 'Over 6.5', 'total', so, null), 'win');
assert.strictEqual(pageGrade(bare, 'Over 6.5', 'total', so, FROM), 'win', 'extract without WeBetLive stays on the ESPN final');
page.picksData = { date: FROM };
assert.strictEqual(pageGrade(page, 'Over 6.5', 'total', so, null), 'loss', 'card date on picksData');
page.picksData = { date: BEFORE };
assert.strictEqual(pageGrade(page, 'Over 6.5', 'total', so, null), 'win');
assert.strictEqual(pageGrade(page, 'Over 5.5', 'total', plain, FROM), 'win');
assert.strictEqual(pageGrade(page, 'Over 4.5', 'total', otGame, FROM), 'win');

const mappedPage = page.mapEspnEvent(finalSo, 'NHL');
assert.strictEqual(mappedPage.shootout, true);
assert.strictEqual(mappedPage.shootoutWinner, 'home');
assert.strictEqual(mappedPage.awayScore, 3);
assert.strictEqual(mappedPage.homeScore, 4);
assert.strictEqual(mappedPage.detail, 'Final/SO');
assert.strictEqual(page.mapEspnEvent(ot, 'NHL').shootout, false);
assert.strictEqual(page.mapEspnEvent(twoOt, 'NHL').shootout, false);
assert.strictEqual(bare.mapEspnEvent(finalSo, 'NHL').shootout, false);

const dash = loadPage('alpha/dashboard/index.html', ['norm', 'getResult']);
function dashGrade(selection, betType, game, dateISO, homeTeam) {
  const pick = nhlPick(selection, betType, { homeTeam: homeTeam || game.homeTeam, date: dateISO || undefined });
  return dash.getResult(pick, game).status;
}
assert.strictEqual(dashGrade('Over 6.5', 'total', so, FROM), 'loss');
assert.strictEqual(dashGrade('Under 6.5', 'total', so, FROM), 'win');
assert.strictEqual(dashGrade('Over 6', 'total', so, FROM), 'push');
assert.strictEqual(dashGrade('Carolina Hurricanes -1.5', 'puck line', so, FROM), 'loss');
assert.strictEqual(dashGrade('Florida Panthers +1.5', 'puck line', so, FROM), 'win');
assert.strictEqual(dashGrade('Carolina Hurricanes -1.0', 'puck line', so, FROM), 'loss');
assert.strictEqual(dashGrade('Over 6.5', 'total', so, BEFORE), 'win');
assert.strictEqual(dashGrade('Over 4.5', 'total', otGame, FROM), 'win');
dash.PICKS_DATA = { date: FROM };
assert.strictEqual(dashGrade('Over 6.5', 'total', so, null), 'loss');

for (const file of [
  'daily-omega/index.html',
  'alpha/index.html',
  'nfl/index.html',
  'cfb/index.html',
  'alpha/dashboard/index.html',
]) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  assert.ok(src.includes('nhlRegulationScores'), file + ' grades with the shared helper');
  assert.ok(src.includes('detectNhlShootout'), file + ' stores the shootout flag');
}
for (const file of ['netlify/functions/track-clv.js', 'netlify/functions/track-clv-omega.js', 'netlify/functions/get-results-omega.js']) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  assert.ok(src.includes('nhlRegulationScores'), file);
}

function mlbGame() {
  return {
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    detail: 'Final',
    period: 9,
    awayTeam: 'Boston Red Sox',
    homeTeam: 'New York Yankees',
    awayAbbr: 'BOS',
    homeAbbr: 'NYY',
    awayScore: 5,
    homeScore: 2,
    sport: 'MLB',
    _sport: 'MLB',
    startISO: '2026-10-15T23:10:00Z',
  };
}

function card() {
  return {
    picks: [
      nhlPick('Carolina Hurricanes ML', 'moneyline'),
      {
        sport: 'MLB',
        matchup: 'Boston Red Sox @ New York Yankees',
        pick: 'Boston Red Sox ML',
        betType: 'moneyline',
        odds: '-110',
        units: '1u',
      },
      {
        sport: 'MLB',
        matchup: 'Boston Red Sox @ New York Yankees',
        pick: 'Under 9.5',
        betType: 'total',
        odds: '-110',
        units: '1u',
      },
    ],
    parlayLegs: [{
      units: '0.5u',
      legs: [
        nhlPick('Over 6.5', 'total'),
        {
          sport: 'MLB',
          matchup: 'Boston Red Sox @ New York Yankees',
          pick: 'Boston Red Sox ML',
          betType: 'moneyline',
          odds: '-110',
        },
        {
          sport: 'MLB',
          matchup: 'Boston Red Sox @ New York Yankees',
          pick: 'Under 9.5',
          betType: 'total',
          odds: '-110',
        },
      ],
    }],
  };
}

const games = [nhlGame(), mlbGame()];

function espnPayload(kind) {
  if (kind === 'nhl') {
    return {
      events: [{
        date: '2026-10-15T23:00:00Z',
        competitions: [{
          date: '2026-10-15T23:00:00Z',
          status: soStatus('Final/SO', 'FINAL/SO', 5),
          competitors: competitors(3, 4, [], [{ value: '1', periodType: 'Shootout' }]),
        }],
      }],
    };
  }
  return {
    events: [{
      date: '2026-10-15T23:10:00Z',
      competitions: [{
        status: soStatus('Final', 'Final', 9),
        competitors: competitors(3, 2),
      }],
    }],
  };
}

async function main() {
  for (const dateISO of [FROM, BEFORE]) {
    const day = await results.gradeDay(dateISO, card(), { games: games });
    const straight = day.picks.filter((p) => p.sport !== 'PARLAY');
    const parlay = day.picks.find((p) => p.sport === 'PARLAY');
    assert.strictEqual(straight.length, 3, dateISO);
    assert.strictEqual(straight[0].result, 'win', dateISO + ' moneyline');
    assert.strictEqual(straight[0].score, '3-4', 'score bar string stays the ESPN final');
    assert.strictEqual(straight[0].units, '1u');
    assert.strictEqual(straight[1].result, 'win');
    assert.strictEqual(straight[2].result, 'win');
    assert.strictEqual(day.parlayRisk, 75, dateISO + ' 0.5u risk');
    assert.ok(parlay, 'parlay row');
    assert.strictEqual(parlay.units, '0.5u');
    if (dateISO === FROM) {
      assert.strictEqual(day.parlayResult, 'loss');
      assert.strictEqual(day.parlayProfit, -75);
      assert.strictEqual(parlay.result, 'loss');
    } else {
      const three = results.gradeParlay([
        { result: 'win', odds: '-110' },
        { result: 'win', odds: '-110' },
        { result: 'win', odds: '-110' },
      ], 75);
      assert.strictEqual(three.result, 'win');
      assert.strictEqual(day.parlayResult, 'win');
      assert.strictEqual(day.parlayProfit, three.profit);
      assert.strictEqual(parlay.profit, three.profit);
    }
  }

  const prev = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    const kind = u.indexOf('hockey') >= 0 ? 'nhl' : 'mlb';
    return { ok: true, status: 200, json: async () => espnPayload(kind) };
  };
  try {
    const nhlBoard = await clv.fetchESPNScores(FROM, 'NHL');
    assert.strictEqual(nhlBoard.length, 1);
    assert.strictEqual(nhlBoard[0].awayScore, 3);
    assert.strictEqual(nhlBoard[0].homeScore, 4);
    assert.strictEqual(nhlBoard[0].shootout, true);
    assert.strictEqual(nhlBoard[0].shootoutWinner, 'home');
    assert.strictEqual(nhlBoard[0].detail, 'FINAL/SO');
    const settled = clv.gradePick(nhlPick('Over 6.5', 'total'), nhlBoard[0], { dateISO: FROM });
    assert.strictEqual(settled, 'loss');
    assert.strictEqual(clv.gradePick(nhlPick('Carolina Hurricanes ML', 'moneyline'), nhlBoard[0], { dateISO: FROM }), 'win');
    const mlbBoard = await clv.fetchESPNScores(FROM, 'MLB');
    assert.strictEqual(mlbBoard[0].shootout, false);
    assert.strictEqual(mlbBoard[0].awayScore, 3);
    const legacyNhl = await legacy.fetchESPNScores(FROM, 'NHL');
    assert.strictEqual(legacyNhl[0].shootout, true);
    assert.strictEqual(legacyNhl[0].shootoutWinner, 'home');
    assert.strictEqual(legacyNhl[0].awayScore, 3);
    assert.strictEqual(legacyNhl[0].homeScore, 4);
    assert.strictEqual(legacy.gradePick(nhlPick('Under 6.5', 'total'), legacyNhl[0], { dateISO: FROM }), 'win');
    const legacyMlb = await legacy.fetchESPNScores(FROM, 'MLB');
    assert.strictEqual(legacyMlb[0].shootout, false);
    assert.strictEqual(legacyMlb[0].period, 9);
  } finally {
    global.fetch = prev;
  }

  console.log('ok test-omega-nhl-shootout-1015');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
