'use strict';

// Men's college basketball grading. The 2026-11-15 fixture is the public
// groups=50 scoreboard. Flag off keeps the old empty NCAAM fetch (pending).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ncaamGradeEnabled } = require('./netlify/functions/lib/default_on_flag');
const { ESPN_ENDPOINTS, scoreboardUrls, gamesFromScoreboard } = require('./netlify/functions/lib/espn-scoreboard');
const { ncaamTeamsMatch, canonicalSchool } = require('./netlify/functions/lib/ncaam-names');
const omega = require('./netlify/functions/get-results-omega');
const v1 = require('./netlify/functions/get-results-omega-v1');
const alpha = require('./netlify/functions/get-results-alpha');
const clv = require('./netlify/functions/track-clv-omega');

const FIXTURE = path.join(__dirname, 'test/fixtures/espn-ncaam-2026-11-15.json');
const DATE = '2026-11-15';
const MATCHUP = 'Quinnipiac Bobcats @ Central Connecticut St Blue Devils';

function withFlag(value, fn) {
  const prev = process.env.OMEGA_NCAAM_GRADE;
  if (value == null) delete process.env.OMEGA_NCAAM_GRADE;
  else process.env.OMEGA_NCAAM_GRADE = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.OMEGA_NCAAM_GRADE;
    else process.env.OMEGA_NCAAM_GRADE = prev;
  }
}

async function withFlagAsync(value, fn) {
  const prev = process.env.OMEGA_NCAAM_GRADE;
  if (value == null) delete process.env.OMEGA_NCAAM_GRADE;
  else process.env.OMEGA_NCAAM_GRADE = value;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.OMEGA_NCAAM_GRADE;
    else process.env.OMEGA_NCAAM_GRADE = prev;
  }
}

function pick(over) {
  return {
    sport: 'NCAAM',
    matchup: MATCHUP,
    odds: '+185',
    units: '1u',
    commenceTime: '2026-11-15T17:00:00Z',
    ...over,
  };
}

function finalGame(over) {
  return {
    awayScore: 0,
    homeScore: 0,
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    startISO: '2026-11-15T20:00Z',
    _sport: 'NCAAM',
    ...over,
  };
}

const board = gamesFromScoreboard(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  .map((g) => ({ ...g, _sport: 'NCAAM' }));

const ccsu = board.find((g) => g.homeAbbr === 'CCSU' && g.awayAbbr === 'QUIN');
assert.ok(ccsu, 'fixture has Quinnipiac at Central Connecticut');
assert.strictEqual(ccsu.homeTeam, 'Central Connecticut Blue Devils');
assert.strictEqual(ccsu.awayTeam, 'Quinnipiac Bobcats');
assert.strictEqual(ccsu.homeScore, 72);
assert.strictEqual(ccsu.awayScore, 67);
assert.strictEqual(ccsu.state, 'post');
assert.strictEqual(ccsu.completed, true);
assert.strictEqual(ccsu.startISO, '2026-11-15T17:00Z');
assert.ok(board.length > 6, 'groups=50 fixture is more than the featured slate');

assert.strictEqual(ncaamGradeEnabled({}), true);
assert.strictEqual(ncaamGradeEnabled({ OMEGA_NCAAM_GRADE: '' }), true);
assert.strictEqual(ncaamGradeEnabled({ OMEGA_NCAAM_GRADE: 'on' }), true);
assert.strictEqual(ncaamGradeEnabled({ OMEGA_NCAAM_GRADE: 'off' }), false);
assert.strictEqual(ncaamGradeEnabled({ OMEGA_NCAAM_GRADE: '0' }), false);
assert.strictEqual(ncaamGradeEnabled({ OMEGA_NCAAM_GRADE: 'false' }), false);

assert.strictEqual(ESPN_ENDPOINTS.NCAAM, 'basketball/mens-college-basketball');
assert.strictEqual(ESPN_ENDPOINTS.NCAAB, 'basketball/mens-college-basketball');
assert.strictEqual(canonicalSchool('Central Connecticut St'), 'central connecticut');
assert.strictEqual(canonicalSchool('Central Connecticut St Blue Devils'), 'central connecticut');
assert.strictEqual(canonicalSchool('Central Connecticut Blue Devils'), 'central connecticut');
assert.strictEqual(canonicalSchool('San José State Spartans'), canonicalSchool('San Jose St Spartans'));
assert.notStrictEqual(canonicalSchool('Kansas'), canonicalSchool('Kansas State'));
assert.notStrictEqual(canonicalSchool('Kansas Jayhawks'), canonicalSchool('Kansas State Wildcats'));
assert.notStrictEqual(canonicalSchool('Miami'), canonicalSchool('Miami (OH)'));
assert.notStrictEqual(canonicalSchool('Miami Hurricanes'), canonicalSchool('Miami (OH) RedHawks'));
assert.strictEqual(canonicalSchool('Miami (OH) RedHawks'), canonicalSchool('Miami Ohio RedHawks'));
assert.notStrictEqual(canonicalSchool('North Carolina'), canonicalSchool('North Carolina State'));
assert.strictEqual(canonicalSchool('North Carolina St Wolfpack'), canonicalSchool('North Carolina State Wolfpack'));
assert.strictEqual(canonicalSchool('Michigan St Spartans'), canonicalSchool('Michigan State Spartans'));
assert.notStrictEqual(canonicalSchool('Michigan'), canonicalSchool('Michigan State'));

assert.strictEqual(ncaamTeamsMatch('Central Connecticut St', 'Central Connecticut', 'CCSU'), true);
assert.strictEqual(ncaamTeamsMatch('Central Connecticut St Blue Devils', 'Central Connecticut Blue Devils', 'CCSU'), true);
assert.strictEqual(ncaamTeamsMatch('Kansas', 'Kansas State', 'KSU'), false);
assert.strictEqual(ncaamTeamsMatch('Kansas Jayhawks', 'Kansas State Wildcats', 'KSU'), false);
assert.strictEqual(ncaamTeamsMatch('Miami', 'Miami (OH)', 'MOH'), false);
assert.strictEqual(ncaamTeamsMatch('Miami Hurricanes', 'Miami (OH) RedHawks', 'MOH'), false);
assert.strictEqual(ncaamTeamsMatch('Duke Blue Devils', 'Central Connecticut Blue Devils', 'CCSU'), false);
assert.strictEqual(ncaamTeamsMatch('Quinnipiac Bobcats', 'Texas State Bobcats', 'TXST'), false);
assert.strictEqual(ncaamTeamsMatch('Quinnipiac Bobcats', 'Montana State Bobcats', 'MTST'), false);

function assertGrader(label, api) {
  const ml = pick({ pick: 'Central Connecticut St Blue Devils ML', betType: 'moneyline' });
  const spread = pick({ pick: 'Central Connecticut St Blue Devils -3.5', betType: 'spread', odds: '-110' });
  const spreadLoss = pick({ pick: 'Quinnipiac Bobcats +3.5', betType: 'spread', odds: '-110' });
  const total = pick({ pick: 'Over 135.5', betType: 'total', odds: '-110' });
  const under = pick({ pick: 'Under 135.5', betType: 'total', odds: '-110' });
  const found = api.findGame(ml, board);
  assert.ok(found, label + ' finds the CCSU game');
  assert.strictEqual(found.homeAbbr, 'CCSU', label);
  assert.strictEqual(found.awayAbbr, 'QUIN', label);
  assert.strictEqual(api.gradePick(ml, found), 'win', label + ' ML');
  assert.strictEqual(api.gradePick(spread, found), 'win', label + ' spread');
  assert.strictEqual(api.gradePick(spreadLoss, found), 'loss', label + ' dog spread');
  assert.strictEqual(api.gradePick(total, found), 'win', label + ' total');
  assert.strictEqual(api.gradePick(under, found), 'loss', label + ' under');

  const ksuOnly = [finalGame({
    awayTeam: 'Kansas State Wildcats',
    awayAbbr: 'KSU',
    awayScore: 50,
    homeTeam: 'Iowa State Cyclones',
    homeAbbr: 'ISU',
    homeScore: 80,
  })];
  const kansasPick = {
    sport: 'NCAAM',
    matchup: 'Kansas Jayhawks @ Iowa State Cyclones',
    pick: 'Kansas Jayhawks ML',
    betType: 'moneyline',
  };
  assert.strictEqual(api.findGame(kansasPick, ksuOnly), null, label + ' does not grade Kansas as Kansas State');
  assert.strictEqual(api.teamsMatch('Kansas', 'Kansas State Wildcats', 'KSU', 'NCAAM'), false, label);
  assert.strictEqual(api.teamsMatch('Miami Hurricanes', 'Miami (OH) RedHawks', 'MOH', 'NCAAM'), false, label);
  assert.strictEqual(api.teamsMatch('Central Connecticut St Blue Devils', 'Central Connecticut Blue Devils', 'CCSU', 'NCAAM'), true, label);

  const sameGame = [finalGame({
    awayTeam: 'Kansas Jayhawks',
    awayAbbr: 'KU',
    awayScore: 80,
    homeTeam: 'Kansas State Wildcats',
    homeAbbr: 'KSU',
    homeScore: 70,
  })];
  const ku = {
    sport: 'NCAAM',
    matchup: 'Kansas Jayhawks @ Kansas State Wildcats',
    pick: 'Kansas Jayhawks ML',
    betType: 'moneyline',
  };
  const kuGame = api.findGame(ku, sameGame);
  assert.ok(kuGame, label + ' finds Kansas at Kansas State');
  assert.strictEqual(api.gradePick(ku, kuGame), 'win', label + ' Kansas side');
  assert.strictEqual(api.teamsMatch('Kansas', kuGame.homeTeam, kuGame.homeAbbr, 'NCAAM'), false, label);
  assert.strictEqual(api.teamsMatch('Kansas', kuGame.awayTeam, kuGame.awayAbbr, 'NCAAM'), true, label);
}

assertGrader('omega', omega._test);
assertGrader('v1', v1._test);
assertGrader('alpha', alpha._test);

const clvMl = pick({ pick: 'Central Connecticut St Blue Devils ML', betType: 'moneyline' });
const clvGame = clv._test.findGameForGrading(clvMl, board);
assert.ok(clvGame && clvGame.homeAbbr === 'CCSU' && clvGame.awayAbbr === 'QUIN');
assert.strictEqual(clv._test.gradePick(clvMl, clvGame), 'win');
assert.strictEqual(clv._test.gradePick(pick({ pick: 'Central Connecticut St Blue Devils -3.5', betType: 'spread' }), clvGame), 'win');
assert.strictEqual(clv._test.gradePick(pick({ pick: 'Over 135.5', betType: 'total' }), clvGame), 'win');
assert.strictEqual(clv._test.findGameForGrading({
  sport: 'NCAAM',
  matchup: 'Miami Hurricanes @ Duke Blue Devils',
  pick: 'Miami Hurricanes ML',
}, [finalGame({
  awayTeam: 'Miami (OH) RedHawks',
  awayAbbr: 'MOH',
  awayScore: 77,
  homeTeam: 'Ohio Bobcats',
  homeAbbr: 'OHIO',
  homeScore: 70,
})]), null);

withFlag('on', () => {
  for (const sport of ['NCAAM', 'NCAAB']) {
    const urls = scoreboardUrls(sport, DATE);
    assert.ok(urls.length >= 6, sport + ' fetches adjacent days, grouped and plain');
    assert.ok(urls.every((u) => u.includes('/basketball/mens-college-basketball/scoreboard')));
    for (const ymd of ['20261114', '20261115', '20261116']) {
      const day = urls.filter((u) => u.includes('dates=' + ymd));
      assert.ok(day.some((u) => u.includes('groups=50') && u.includes('limit=400')), sport + ' ' + ymd);
      assert.ok(day.some((u) => !u.includes('groups=')), sport + ' plain ' + ymd);
    }
  }
  const ncaaf = scoreboardUrls('NCAAF', DATE);
  assert.ok(ncaaf.some((u) => u.includes('groups=80') && u.includes('limit=300')));
  assert.ok(ncaaf.some((u) => u.includes('groups=90') && u.includes('limit=300')));
  assert.ok(ncaaf.every((u) => !u.includes('groups=50')));
  const nfl = scoreboardUrls('NFL', DATE);
  assert.ok(nfl.every((u) => u.includes('/football/nfl/') && !u.includes('groups=')));
});

withFlag('off', () => {
  assert.deepStrictEqual(scoreboardUrls('NCAAM', DATE), []);
  const ncaab = scoreboardUrls('NCAAB', DATE);
  assert.ok(ncaab.length >= 3);
  assert.ok(ncaab.every((u) => u.includes('/basketball/mens-college-basketball/scoreboard') && !u.includes('groups=')));
  assert.ok(ncaab.some((u) => u.includes('dates=20261115')));
  // Old substring and mascot-last-word match is restored for this sport key.
  assert.strictEqual(omega._test.teamsMatch('Kansas', 'Kansas State Wildcats', 'KSU', 'NCAAM'), true);
  assert.strictEqual(omega._test.teamsMatch('Duke Blue Devils', 'Central Connecticut Blue Devils', '', 'NCAAM'), true);
  assert.strictEqual(omega._test.teamsMatch('Central Connecticut St Blue Devils', 'Central Connecticut Blue Devils', '', 'NCAAM'), true);
});

async function main() {
  await withFlagAsync('on', async () => {
    const day = await omega._test.gradeDay(DATE, {
      picks: [
        pick({ pick: 'Central Connecticut St Blue Devils ML', betType: 'moneyline' }),
        pick({ pick: 'Central Connecticut St Blue Devils -3.5', betType: 'spread', odds: '-110' }),
        pick({ pick: 'Over 135.5', betType: 'total', odds: '-110' }),
      ],
    }, { games: board });
    const rows = (day.picks || []).filter((p) => p.sport !== 'PARLAY');
    assert.deepStrictEqual(rows.map((p) => p.result), ['win', 'win', 'win']);
  });

  await withFlagAsync('off', async () => {
    const empty = await clv._test.fetchESPNScores(DATE, 'NCAAM');
    assert.deepStrictEqual(empty, []);
    const day = await omega._test.gradeDay(DATE, {
      picks: [pick({ pick: 'Central Connecticut St Blue Devils ML', betType: 'moneyline' })],
    });
    assert.strictEqual(day.picks[0].result, 'pending');
    assert.strictEqual(day.picks[0].pick, 'Central Connecticut St Blue Devils ML');
  });

  console.log('PASS ncaam grade');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
