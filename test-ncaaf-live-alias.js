'use strict';
// NCAAF live-score matching: odds school names alias to ESPN display names.
// Southern Mississippi (odds) must hit Southern Miss (ESPN) for Troy and USM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function load(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const sandbox = { cachedScores: {}, _calls: [] };
  sandbox.resolveDoubleheader = (matches) => {
    sandbox._calls.push(matches);
    return matches[0] || null;
  };
  sandbox.WeBetLive = { resolveDoubleheader: sandbox.resolveDoubleheader };
  vm.createContext(sandbox);
  const code = names.map(name => extractFunction(src, name)).join('\n');
  vm.runInContext(code, sandbox, { filename: file });
  return sandbox;
}

function callFind(api, pick, games) {
  api._calls = [];
  api.cachedScores = { [pick.sport || 'NCAAF']: games };
  return api.findGame(pick);
}

function troyGame(over) {
  return Object.assign({
    state: 'in', completed: false, statusName: 'In Progress', detail: '1st 12:00',
    awayTeam: 'Southern Miss Golden Eagles', homeTeam: 'Troy Trojans',
    awayAbbr: 'USM', homeAbbr: 'TROY',
    awayScore: 0, homeScore: 10,
    startISO: '2026-10-07T00:00:00Z',
  }, over || {});
}

const names = [
  'normalizeTeam', 'schoolKey', 'ncaafAliasMap', 'canonNcaafTeam',
  'ncaafSchoolKeysMatch', 'teamsMatch', 'ncaafPickedSides',
  'preferExactSchoolGames', 'findGame',
  'gameMatchesPickWindow', 'disambiguateDoubleheader', 'isF5Pick', 'determineResult',
];

const api = load('daily-omega/index.html', names);

const aliasFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts/data/football-team-aliases.json'), 'utf8'));
const map = api.ncaafAliasMap();
const expectedKeys = new Set();
for (const [canon, list] of Object.entries(aliasFile.NCAAF)) {
  for (const alias of list) {
    const key = api.normalizeTeam(alias);
    expectedKeys.add(key);
    assert.strictEqual(map[key], canon, 'map ' + alias);
    assert.strictEqual(api.canonNcaafTeam(alias), canon, 'canon ' + alias);
  }
}
assert.strictEqual(Object.keys(map).length, expectedKeys.size, 'alias map is the full NCAAF section');
assert.strictEqual(api.canonNcaafTeam('Southern Mississippi'), 'Southern Miss Golden Eagles');
assert.strictEqual(api.canonNcaafTeam('Southern Mississippi Golden Eagles'), 'Southern Miss Golden Eagles');
assert.strictEqual(api.canonNcaafTeam('Kentucky Wildcats'), 'Kentucky Wildcats', 'school-only form');
assert.strictEqual(api.canonNcaafTeam('Boise State Broncos'), 'Boise State Broncos', 'school-only form');
assert.strictEqual(api.canonNcaafTeam('Troy Trojans'), 'Troy Trojans', 'unknown name unchanged');
assert.strictEqual(api.canonNcaafTeam('Michigan State Spartans'), 'Michigan State Spartans');
assert.strictEqual(api.canonNcaafTeam('Miami (OH)'), 'Miami (OH) RedHawks');
assert.strictEqual(api.canonNcaafTeam('Miami (OH) RedHawks'), 'Miami (OH) RedHawks');
assert.strictEqual(api.canonNcaafTeam('Kentucky State'), 'Kentucky State Thorobreds');
assert.strictEqual(api.canonNcaafTeam('McNeese State Cowboys'), 'McNeese Cowboys');

const decoy = {
  state: 'in', completed: false, awayTeam: 'Alabama Crimson Tide', homeTeam: 'Georgia Bulldogs',
  awayAbbr: 'ALA', homeAbbr: 'UGA', awayScore: 7, homeScore: 3,
  startISO: '2026-10-07T00:00:00Z',
};
const far = troyGame({ startISO: '2026-10-07T12:00:00Z', awayScore: 99, homeScore: 0 });
const live = troyGame();
const slate = [decoy, far, live];

const straight = {
  sport: 'NCAAF', betType: 'spread',
  pick: 'Troy Trojans -10',
  matchup: 'Southern Mississippi Golden Eagles @ Troy Trojans',
  commenceTime: '2026-10-07T00:00:00Z',
};
const leg = {
  sport: 'NCAAF', betType: 'spread',
  pick: 'Troy Trojans -10',
  matchup: 'Southern Mississippi Golden Eagles @ Troy Trojans',
};

const straightGame = callFind(api, straight, slate);
assert.ok(straightGame, 'straight findGame');
assert.strictEqual(straightGame.awayAbbr, 'USM');
assert.strictEqual(straightGame.homeAbbr, 'TROY');
assert.strictEqual(straightGame.homeScore, 10, 'straight stays inside the 10h window');

const legGame = callFind(api, leg, [decoy, live]);
assert.ok(legGame, 'parlay leg findGame');
assert.strictEqual(legGame.awayTeam, 'Southern Miss Golden Eagles');
assert.strictEqual(legGame.homeTeam, 'Troy Trojans');

const troySides = api.ncaafPickedSides(
  'Troy Trojans', live.awayTeam, live.awayAbbr, live.homeTeam, live.homeAbbr, 'NCAAF'
);
assert.strictEqual(troySides.pickedHome, true);
assert.strictEqual(troySides.pickedAway, false);

const usmPick = {
  sport: 'NCAAF', betType: 'spread',
  pick: 'Southern Mississippi Golden Eagles -3',
  matchup: 'Southern Mississippi Golden Eagles @ Troy Trojans',
  commenceTime: '2026-10-07T00:00:00Z',
};
const usmGame = callFind(api, usmPick, slate);
assert.ok(usmGame, 'USM findGame');
assert.strictEqual(usmGame.awayAbbr, 'USM');
const usmSides = api.ncaafPickedSides(
  'Southern Mississippi Golden Eagles', usmGame.awayTeam, usmGame.awayAbbr, usmGame.homeTeam, usmGame.homeAbbr, 'NCAAF'
);
assert.strictEqual(usmSides.pickedAway, true, 'Southern Mississippi resolves to the away side');
assert.strictEqual(usmSides.pickedHome, false);

const projected = api.determineResult(straight, live);
assert.strictEqual(projected.status, 'live', 'Troy -10 at 10-0 is on the push line');
assert.strictEqual(projected.isLive, true);

const miamiOh = api.ncaafPickedSides(
  'Miami (OH) RedHawks', 'Miami Hurricanes', 'MIA', 'Miami (OH) RedHawks', 'MOH', 'NCAAF'
);
assert.strictEqual(miamiOh.pickedHome, true);
assert.strictEqual(miamiOh.pickedAway, false);

const mcPick = {
  sport: 'NCAAF', betType: 'spread',
  pick: 'McNeese State Cowboys +53.5',
  matchup: 'McNeese State Cowboys @ LSU Tigers',
};
const mcGame = {
  state: 'post', completed: true, statusName: 'Final',
  awayTeam: 'McNeese Cowboys', homeTeam: 'LSU Tigers',
  awayAbbr: 'MCN', homeAbbr: 'LSU', awayScore: 14, homeScore: 63,
};
assert.strictEqual(api.determineResult(mcPick, mcGame).status, 'win');

const wrong = {
  state: 'post', completed: true, awayTeam: 'Michigan Wolverines', homeTeam: 'Iowa Hawkeyes',
  awayAbbr: 'MICH', homeAbbr: 'IOWA', awayScore: 10, homeScore: 30,
};
const right = {
  state: 'post', completed: true, awayTeam: 'Michigan State Spartans', homeTeam: 'Iowa Hawkeyes',
  awayAbbr: 'MSU', homeAbbr: 'IOWA', awayScore: 30, homeScore: 10,
};
const msu = callFind(api, {
  sport: 'NCAAF', betType: 'spread',
  pick: 'Michigan State Spartans -3',
  matchup: 'Michigan State Spartans @ Iowa Hawkeyes',
}, [wrong, right]);
assert.ok(msu);
assert.strictEqual(msu.awayTeam, 'Michigan State Spartans');
assert.strictEqual(api._calls[0].length, 1, 'State-suffix lookalike stays dropped');

const nflA = {
  state: 'post', awayTeam: 'Dallas Cowboys', homeTeam: 'New York Giants',
  awayAbbr: 'DAL', homeAbbr: 'NYG', awayScore: 17, homeScore: 14,
};
const nflB = {
  state: 'post', awayTeam: 'Dallas Cowboys', homeTeam: 'New York Giants',
  awayAbbr: 'DAL', homeAbbr: 'NYG', awayScore: 20, homeScore: 24,
};
callFind(api, {
  sport: 'NFL', pick: 'Dallas Cowboys -3', matchup: 'Dallas Cowboys @ New York Giants',
}, [nflA, nflB]);
assert.strictEqual(api._calls[0].length, 2, 'non-NCAAF matching is unchanged');

const exactOnly = callFind(api, {
  sport: 'NCAAF', betType: 'spread',
  pick: 'Troy Trojans -10',
  matchup: 'Not In The Alias Table @ Troy Trojans',
  commenceTime: '2026-10-07T00:00:00Z',
}, [decoy, live]);
assert.ok(exactOnly, 'unique exact display name is accepted');
assert.strictEqual(exactOnly.homeAbbr, 'TROY');

console.log('ok daily-omega NCAAF live alias');
