'use strict';
// One fixture list through server identity, both graders, and both pages.
// Card dates before IDENTITY_V2_FROM stay on the 182e714 matcher.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const repo = __dirname;
const NEW = '2026-10-07';
const OLD = '2026-10-06';
const server = require('./netlify/functions/lib/omega-vnext/sports/team_identity');
const client = require('./js/omega-team-identity');
const results = require('./netlify/functions/get-results-omega')._test;
const clv = require('./netlify/functions/track-clv-omega')._test;

function same(sport, a, b) {
  assert.strictEqual(server.resolveTeamId(sport, a), client.resolveTeamId(sport, a), sport + ' ' + a);
  if (b == null) {
    assert.strictEqual(server.resolveTeamId(sport, a), null, sport + ' ' + a);
    return;
  }
  assert.strictEqual(server.sameTeam(sport, a, b), true, sport + ' ' + a + ' ~ ' + b);
  assert.strictEqual(client.sameTeam(sport, a, b), true, 'client ' + a);
}

same('NCAAF', 'Southern Miss', 'Southern Mississippi');
same('NCAAF', 'McNeese', 'McNeese State');
same('NCAAF', 'Sam Houston', 'Sam Houston State');
same('NCAAF', 'App State', 'Appalachian State');
same('NCAAF', 'UMass', 'Massachusetts');
same('NCAAF', 'San José State', 'San Jose State');
same('NCAAF', "Hawai'i", 'Hawaii');
same('NCAAF', 'William & Mary', 'William and Mary');
same('NCAAF', 'Houston Christian', 'Houston Baptist');
same('NCAAF', 'Miami (FL)', 'Miami');
same('NCAAF', 'Miami (OH)', 'Miami RedHawks');
same('NCAAF', 'Washington State', 'Washington State Cougars');
same('NCAAF', 'Ohio State', 'Ohio State Buckeyes');
same('NCAAF', 'Missouri State', 'Missouri State Bears');
same('MLB', 'Athletics', "A's");
same('MLB', 'Oakland Athletics', 'Sacramento Athletics');
same('MLB', 'Arizona Diamondbacks', 'Arizona D-backs');
same('MLB', 'D-backs', 'Dbacks');
same('MLB', 'LA Angels', 'Los Angeles Angels of Anaheim');
same('MLB', 'St. Louis Cardinals', 'St Louis Cardinals');
same('NHL', 'Utah Hockey Club', 'Utah Mammoth');
same('NHL', 'Utah HC', 'Utah Mammoth');
same('NHL', 'Montréal Canadiens', 'Montreal Canadiens');
same('NHL', 'St. Louis Blues', 'St Louis Blues');
same('NHL', 'LA Kings', 'Los Angeles Kings');
same('NBA', 'LA Clippers', 'Los Angeles Clippers');
same('NBA', 'L.A. Lakers', 'Los Angeles Lakers');
same('MLB', 'Sox', null);
same('MLB', 'As', "A's");

assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Miami'), server.resolveTeamId('NCAAF', 'Miami (OH)'));
assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Washington'), server.resolveTeamId('NCAAF', 'Washington State'));
assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Ohio'), server.resolveTeamId('NCAAF', 'Ohio State'));
assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Missouri'), server.resolveTeamId('NCAAF', 'Missouri State'));
assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Kansas'), server.resolveTeamId('NCAAF', 'Kansas State'));
assert.notStrictEqual(server.resolveTeamId('MLB', 'Chicago White Sox'), server.resolveTeamId('MLB', 'Boston Red Sox'));
assert.notStrictEqual(server.resolveTeamId('MLB', "A's"), server.resolveTeamId('MLB', 'Houston Astros'));
assert.notStrictEqual(server.resolveTeamId('NBA', 'LA Clippers'), server.resolveTeamId('NBA', 'LA Lakers'));
assert.notStrictEqual(server.resolveTeamId('NCAAF', 'Southern Mississippi'), server.resolveTeamId('NCAAF', 'Southern Jaguars'));

function final(id, sport, away, home, awayScore, homeScore) {
  return {
    id: id,
    eventId: id,
    awayTeam: away,
    homeTeam: home,
    awayId: server.resolveTeamId(sport, away),
    homeId: server.resolveTeamId(sport, home),
    awayAbbr: '',
    homeAbbr: '',
    awayScore: awayScore,
    homeScore: homeScore,
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    startISO: '2026-10-07T23:00:00Z',
  };
}

const CASES = [
  {
    name: 'white-sox-ml',
    sport: 'MLB',
    matchup: 'Boston Red Sox @ Chicago White Sox',
    pick: 'Chicago White Sox ML',
    betType: 'moneyline',
    games: [final('sox-game', 'MLB', 'Boston Red Sox', 'Chicago White Sox', 5, 2)],
    eventId: 'sox-game',
    side: 'home',
    result: 'loss',
  },
  {
    name: 'white-sox-at-cubs',
    sport: 'MLB',
    matchup: 'Chicago White Sox @ Chicago Cubs',
    pick: 'Chicago White Sox ML',
    betType: 'moneyline',
    games: [
      final('bos-chc', 'MLB', 'Boston Red Sox', 'Chicago Cubs', 8, 2),
      final('chw-chc', 'MLB', 'Chicago White Sox', 'Chicago Cubs', 2, 4),
    ],
    eventId: 'chw-chc',
    side: 'away',
    result: 'loss',
  },
  {
    name: 'white-sox-not-red-sox',
    sport: 'MLB',
    matchup: 'Chicago White Sox @ Chicago Cubs',
    pick: 'Chicago White Sox ML',
    betType: 'moneyline',
    games: [final('bos-only', 'MLB', 'Boston Red Sox', 'Chicago Cubs', 8, 2)],
    eventId: null,
    side: null,
    result: 'pending',
  },
  {
    name: 'southern-miss',
    sport: 'NCAAF',
    matchup: 'Southern Mississippi @ Troy Trojans',
    pick: 'Southern Mississippi ML',
    betType: 'moneyline',
    games: [
      final('jags', 'NCAAF', 'Southern Jaguars', 'Troy Trojans', 40, 10),
      final('usm', 'NCAAF', 'Southern Miss Golden Eagles', 'Troy Trojans', 10, 31),
    ],
    eventId: 'usm',
    side: 'away',
    result: 'loss',
  },
  {
    name: 'miami-split',
    sport: 'NCAAF',
    matchup: 'Miami (OH) @ Ohio Bobcats',
    pick: 'Miami RedHawks ML',
    betType: 'moneyline',
    games: [
      final('mia-fl', 'NCAAF', 'Miami Hurricanes', 'Florida State Seminoles', 21, 14),
      final('mia-oh', 'NCAAF', 'Miami (OH) RedHawks', 'Ohio Bobcats', 10, 24),
    ],
    eventId: 'mia-oh',
    side: 'away',
    result: 'loss',
  },
  {
    name: 'utah-mammoth',
    sport: 'NHL',
    matchup: 'Utah Hockey Club @ Colorado Avalanche',
    pick: 'Utah Mammoth ML',
    betType: 'moneyline',
    games: [final('utah', 'NHL', 'Utah Mammoth', 'Colorado Avalanche', 2, 4)],
    eventId: 'utah',
    side: 'away',
    result: 'loss',
  },
  {
    name: 'clippers-lakers',
    sport: 'NBA',
    matchup: 'LA Clippers @ Los Angeles Lakers',
    pick: 'L.A. Clippers ML',
    betType: 'moneyline',
    games: [final('lac', 'NBA', 'LA Clippers', 'Los Angeles Lakers', 100, 110)],
    eventId: 'lac',
    side: 'away',
    result: 'loss',
  },
];

function pickOf(row) {
  return { sport: row.sport, matchup: row.matchup, pick: row.pick, betType: row.betType, odds: '-110', units: '1u' };
}

function eventId(game) {
  if (!game) return null;
  return game.id || game.eventId || null;
}

function sideOf(sport, pickText, game) {
  if (!game) return null;
  const team = String(pickText).replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const by = server.matchSides(sport, team, game.awayTeam, game.homeTeam, game.awayId, game.homeId);
  if (!by.decided) return null;
  if (by.pickedAway) return 'away';
  if (by.pickedHome) return 'home';
  return null;
}

function mlResult(side, game) {
  if (!game || !side) return 'pending';
  const ps = side === 'away' ? game.awayScore : game.homeScore;
  const os = side === 'away' ? game.homeScore : game.awayScore;
  if (ps === os) return 'push';
  return ps > os ? 'win' : 'loss';
}

function extractFunction(src, name) {
  const re = new RegExp('function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('missing function ' + name);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function loadPage(file, names, extra) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  const sandbox = Object.assign({
    cachedScores: {},
    picksData: { date: NEW },
    PICKSDATA: { date: NEW },
    OmegaTeamIdentity: client,
    WeBetLive: require('./js/live-score'),
    console: console,
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(src, name)).join('\n'), sandbox, { filename: file });
  return sandbox;
}

const dailyNames = [
  'normalizeTeam', 'schoolKey', 'ncaafAliasMap', 'canonNcaafTeam', 'ncaafSchoolKeysMatch',
  'teamsMatch', 'ncaafPickedSides', 'preferExactSchoolGames', 'cardIdentityOn', 'findGameByIdentity',
  'findGame', 'gameMatchesPickWindow', 'disambiguateDoubleheader', 'isF5Pick', 'determineResult',
];
const castNames = ['normTeam', 'lastWord', 'schoolKey', 'cardIdentityOn', 'sideId', 'teamsMatch', 'pickSide'];
const daily = loadPage('daily-omega/index.html', dailyNames);
const cast = loadPage('gamecast/index.html', castNames);

function dailyGrade(row, date) {
  daily.picksData = { date: date };
  daily.cachedScores = { [row.sport]: row.games };
  const pick = pickOf(row);
  const game = daily.findGame(pick);
  let result = 'pending';
  let side = null;
  if (game) {
    const team = row.pick.replace(/ML$/i, '').trim();
    const sides = daily.ncaafPickedSides(team, game.awayTeam, game.awayAbbr, game.homeTeam, game.homeAbbr, row.sport, game.awayId, game.homeId);
    if (sides.pickedAway) side = 'away';
    else if (sides.pickedHome) side = 'home';
    const card = daily.determineResult(pick, game);
    result = card.status === 'win' || card.status === 'loss' || card.status === 'push' ? card.status : 'pending';
  }
  return { eventId: eventId(game), side, result };
}

function castGrade(row, date) {
  cast.PICKSDATA = { date: date };
  const parts = row.matchup.split(/\s+(?:@|vs\.?|at)\s+/i).map(s => s.trim()).filter(Boolean);
  const hits = row.games.filter((g) => cast.teamsMatch(parts, g.awayTeam, g.homeTeam, {
    sport: row.sport, awayId: g.awayId, homeId: g.homeId, date: date,
  }));
  const game = hits[0] || null;
  const side = game ? cast.pickSide(row.pick.replace(/ML$/i, '').trim(), game.awayTeam, game.homeTeam, row.sport, game.awayId, game.homeId) : null;
  return { eventId: eventId(game), side, result: mlResult(side, game) };
}

for (const row of CASES) {
  for (const g of row.games) {
    assert.ok(g.awayId && g.homeId, row.name + ' ids ' + g.awayTeam + ' / ' + g.homeTeam);
  }
  const pick = pickOf(row);
  const found = results.findGame(pick, row.games, NEW);
  const graded = results.gradePick(pick, found, { dateISO: NEW });
  const clvFound = clv.findGameForGrading(pick, row.games, NEW);
  const clvGraded = clv.gradePick(pick, clvFound, { dateISO: NEW });
  const page = dailyGrade(row, NEW);
  const board = castGrade(row, NEW);
  const side = sideOf(row.sport, row.pick, found);
  assert.strictEqual(eventId(found), row.eventId, 'results ' + row.name);
  assert.strictEqual(eventId(clvFound), row.eventId, 'clv ' + row.name);
  assert.strictEqual(page.eventId, row.eventId, 'page ' + row.name);
  assert.strictEqual(board.eventId, row.eventId, 'gamecast ' + row.name);
  assert.strictEqual(side, row.side, 'side ' + row.name);
  assert.strictEqual(page.side, row.side, 'page side ' + row.name);
  assert.strictEqual(board.side, row.side, 'gamecast side ' + row.name);
  assert.strictEqual(graded, row.result, 'grade ' + row.name);
  assert.strictEqual(clvGraded, row.result, 'clv grade ' + row.name);
  assert.strictEqual(page.result, row.result, 'page grade ' + row.name);
  assert.strictEqual(board.result, row.result, 'gamecast grade ' + row.name);
  if (row.name === 'white-sox-ml') assert.strictEqual(graded, 'loss');
}

function loadOldGraders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-id-old-'));
  const fnDir = path.join(dir, 'netlify/functions');
  fs.mkdirSync(fnDir, { recursive: true });
  for (const file of ['get-results-omega.js', 'track-clv-omega.js']) {
    const src = execSync('git show 182e714:netlify/functions/' + file, { cwd: repo, encoding: 'utf8' });
    fs.writeFileSync(path.join(fnDir, file), src);
  }
  fs.symlinkSync(path.join(repo, 'netlify/functions/lib'), path.join(fnDir, 'lib'));
  fs.symlinkSync(path.join(repo, 'js'), path.join(dir, 'js'));
  return {
    results: require(path.join(fnDir, 'get-results-omega.js'))._test,
    clv: require(path.join(fnDir, 'track-clv-omega.js'))._test,
    dailySrc: execSync('git show 182e714:daily-omega/index.html', { cwd: repo, encoding: 'utf8' }),
    castSrc: execSync('git show 182e714:gamecast/index.html', { cwd: repo, encoding: 'utf8' }),
  };
}

const old = loadOldGraders();
const oldDaily = loadPage('daily-omega/index.html', dailyNames);
// Rebuild old page from the 182e714 source. The helper reads the worktree file,
// so load the historical source directly.
function loadSrc(src, names, filename) {
  const sandbox = {
    cachedScores: {},
    picksData: { date: OLD },
    PICKSDATA: { date: OLD },
    WeBetLive: require('./js/live-score'),
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(src, name)).join('\n'), sandbox, { filename: filename });
  return sandbox;
}
const oldPage = loadSrc(old.dailySrc, [
  'normalizeTeam', 'schoolKey', 'ncaafAliasMap', 'canonNcaafTeam', 'ncaafSchoolKeysMatch',
  'teamsMatch', 'ncaafPickedSides', 'preferExactSchoolGames', 'findGame',
  'gameMatchesPickWindow', 'disambiguateDoubleheader', 'isF5Pick', 'determineResult',
], 'daily-old');
const oldCast = loadSrc(old.castSrc, ['normTeam', 'lastWord', 'schoolKey', 'teamsMatch'], 'cast-old');

for (const row of CASES) {
  const pick = pickOf(row);
  const oldFound = old.results.findGame(pick, row.games);
  const oldGrade = old.results.gradePick(pick, oldFound, { dateISO: OLD });
  const newFound = results.findGame(pick, row.games, OLD);
  const newGrade = results.gradePick(pick, newFound, { dateISO: OLD });
  assert.strictEqual(eventId(newFound), eventId(oldFound), 'results event ' + row.name + ' pre-cutoff');
  assert.strictEqual(newGrade, oldGrade, 'results grade ' + row.name + ' pre-cutoff');
  const oldClvGame = old.clv.findGameForGrading(pick, row.games, OLD);
  const newClvGame = clv.findGameForGrading(pick, row.games, OLD);
  assert.strictEqual(eventId(newClvGame), eventId(oldClvGame), 'clv event ' + row.name + ' pre-cutoff');
  assert.strictEqual(
    clv.gradePick(pick, newClvGame, { dateISO: OLD }),
    old.clv.gradePick(pick, oldClvGame, { dateISO: OLD }),
    'clv grade ' + row.name + ' pre-cutoff'
  );
  oldPage.picksData = { date: OLD };
  oldPage.cachedScores = { [row.sport]: row.games };
  daily.picksData = { date: OLD };
  daily.cachedScores = { [row.sport]: row.games };
  const oldGame = oldPage.findGame(pick);
  const newGame = daily.findGame(pick);
  assert.strictEqual(eventId(newGame), eventId(oldGame), 'page event ' + row.name + ' pre-cutoff');
  const oldCard = oldGame ? oldPage.determineResult(pick, oldGame).status : 'pending';
  const newCard = newGame ? daily.determineResult(pick, newGame).status : 'pending';
  assert.strictEqual(newCard, oldCard, 'page grade ' + row.name + ' pre-cutoff');
  const parts = row.matchup.split(/\s+(?:@|vs\.?|at)\s+/i).map(s => s.trim());
  for (const g of row.games) {
    const ctx = { sport: row.sport, awayId: g.awayId, homeId: g.homeId, date: OLD };
    assert.strictEqual(
      cast.teamsMatch(parts, g.awayTeam, g.homeTeam, ctx),
      oldCast.teamsMatch(parts.map(p => oldCast.normTeam(p)), g.awayTeam, g.homeTeam),
      'gamecast ' + row.name + ' ' + g.id
    );
  }
}

console.log('ok test-omega-identity-cross-surface');
