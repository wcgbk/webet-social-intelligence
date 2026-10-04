'use strict';
// NCAAF school keys that differ only by a trailing "state" grade together.
// Rivalries (Michigan State vs Michigan) keep the exact schoolKey, or stay pending.
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

function game(awayTeam, homeTeam, awayScore, homeScore) {
  return {
    state: 'post', completed: true, statusName: 'Final',
    awayTeam, homeTeam, awayScore, homeScore, awayAbbr: '', homeAbbr: '',
  };
}

function resultOf(api, pick, g) {
  if (typeof api.gradePick === 'function') return api.gradePick(pick, g);
  const r = api.determineResult(pick, g);
  if (r.status === 'scheduled') return 'pending';
  return r.status;
}

function assertMatcher(api, label) {
  assert.strictEqual(api.teamsMatch('McNeese State Cowboys', 'McNeese Cowboys', '', 'NCAAF'), true, label + ' McNeese State matches McNeese');
  assert.strictEqual(api.teamsMatch('McNeese State Cowboys', 'LSU Tigers', '', 'NCAAF'), false, label + ' McNeese State does not match LSU');
  assert.strictEqual(api.teamsMatch('Auburn Tigers', 'LSU Tigers', '', 'NCAAF'), false, label + ' NCAAF does not match on mascot');
  assert.strictEqual(api.teamsMatch('Dallas Cowboys', 'XXX Cowboys', '', 'NFL'), true, label + ' non-NCAAF nickname match stays');
  assert.strictEqual(api.teamsMatch('Michigan State Spartans', 'Michigan Wolverines', '', 'NCAAF'), true, label + ' State suffix matches the base school');
  assert.strictEqual(api.teamsMatch('Ohio State Buckeyes', 'Ohio Bobcats', '', 'NCAAF'), true, label);
  // Two-word mascots stay on the school key ("arizona state sun", "penn state nittany"),
  // so those keys do not differ only by "state" and must not match the base school.
  assert.strictEqual(api.teamsMatch('Arizona State Sun Devils', 'Arizona Wildcats', '', 'NCAAF'), false, label);
  assert.strictEqual(api.teamsMatch('Penn State Nittany Lions', 'Penn Quakers', '', 'NCAAF'), false, label);

  const mcneese = game('McNeese Cowboys', 'LSU Tigers', 14, 63);
  const mcPick = {
    sport: 'NCAAF', betType: 'spread',
    pick: 'McNeese State Cowboys +53.5',
    matchup: 'McNeese State Cowboys @ LSU Tigers',
  };
  assert.strictEqual(resultOf(api, mcPick, mcneese), 'win', label + ' McNeese +53.5 covers 14-63');
  if (typeof api.determineResult === 'function') {
    const card = api.determineResult(mcPick, mcneese);
    assert.strictEqual(card.status, 'win', label + ' card is a win, not gray/scheduled');
    assert.strictEqual(card.label, 'Win');
  }

  // State score 30, base score 10. +3 wins only on the State side. -3 loses only on the base side.
  const rivalries = [
    ['Michigan State Spartans', 'Michigan Wolverines', 'Michigan Wolverines', 'Michigan State Spartans'],
    ['Ohio State Buckeyes', 'Ohio Bobcats', 'Ohio State Buckeyes', 'Ohio Bobcats'],
    ['Arizona State Sun Devils', 'Arizona Wildcats', 'Arizona Wildcats', 'Arizona State Sun Devils'],
    ['Penn State Nittany Lions', 'Penn Quakers', 'Penn State Nittany Lions', 'Penn Quakers'],
  ];
  for (const [stateName, baseName, away, home] of rivalries) {
    const g = game(away, home, away === stateName ? 30 : 10, home === stateName ? 30 : 10);
    const matchup = away + ' @ ' + home;
    const stateGrade = resultOf(api, { sport: 'NCAAF', betType: 'spread', pick: stateName + ' +3', matchup }, g);
    const baseGrade = resultOf(api, { sport: 'NCAAF', betType: 'spread', pick: baseName + ' -3', matchup }, g);
    assert.strictEqual(stateGrade, 'win', label + ' ' + stateName + ' grades the State side of ' + matchup);
    assert.strictEqual(baseGrade, 'loss', label + ' ' + baseName + ' grades that side, not State, in ' + matchup);
  }

  const ambiguous = game('Acme Owls', 'Acme Eagles', 30, 0);
  const ambPick = { sport: 'NCAAF', betType: 'spread', pick: 'Acme State Pilots +3', matchup: 'Acme Owls @ Acme Eagles' };
  assert.strictEqual(resultOf(api, ambPick, ambiguous), 'pending', label + ' ambiguous State suffix stays pending');
  if (typeof api.determineResult === 'function') {
    const card = api.determineResult(ambPick, ambiguous);
    assert.strictEqual(card.status, 'scheduled', label + ' ambiguous card stays scheduled');
  }
}

function callFind(api, pick, games) {
  api._calls = [];
  if (api.findGame.length >= 2) return api.findGame(pick, games);
  api.cachedScores = { [pick.sport || 'NCAAF']: games };
  return api.findGame(pick);
}

function assertFindGame(api, label) {
  const wrong = game('Michigan Wolverines', 'Iowa Hawkeyes', 10, 30);
  const right = game('Michigan State Spartans', 'Iowa Hawkeyes', 30, 10);
  const pick = {
    sport: 'NCAAF', betType: 'spread',
    pick: 'Michigan State Spartans -3',
    matchup: 'Michigan State Spartans @ Iowa Hawkeyes',
  };
  const found = callFind(api, pick, [wrong, right]);
  assert.ok(found, label + ' findGame returns a game');
  assert.strictEqual(found.awayTeam, 'Michigan State Spartans', label + ' does not grade Michigan for a Michigan State pick');
  assert.strictEqual(api._calls[0].length, 1, label + ' drops the State-suffix lookalike game');

  const opener = game('McNeese Cowboys', 'LSU Tigers', 14, 63);
  const night = game('McNeese Cowboys', 'LSU Tigers', 7, 40);
  opener.startISO = '2026-10-03T16:00:00Z';
  night.startISO = '2026-10-03T23:00:00Z';
  callFind(api, {
    sport: 'NCAAF', pick: 'McNeese State Cowboys +53.5',
    matchup: 'McNeese State Cowboys @ LSU Tigers',
    commenceTime: '2026-10-03T23:00:00Z',
  }, [opener, night]);
  assert.strictEqual(api._calls[0].length, 2, label + ' exact-tied doubleheader still reaches the time resolver');

  const nflA = game('Dallas Cowboys', 'New York Giants', 17, 14);
  const nflB = game('Dallas Cowboys', 'New York Giants', 20, 24);
  callFind(api, {
    sport: 'NFL', pick: 'Dallas Cowboys -3', matchup: 'Dallas Cowboys @ New York Giants',
  }, [nflA, nflB]);
  assert.strictEqual(api._calls[0].length, 2, label + ' non-NCAAF matching is unchanged');
}

const sharedNames = [
  'normalizeTeam', 'schoolKey', 'ncaafSchoolKeysMatch', 'teamsMatch', 'ncaafPickedSides',
  'preferExactSchoolGames', 'findGame',
];
const jsNames = sharedNames.concat(['gradePick']);
const htmlNames = sharedNames.concat(['gameMatchesPickWindow', 'disambiguateDoubleheader', 'isF5Pick', 'determineResult']);

const impls = [
  ['netlify/functions/get-results-omega.js', jsNames.concat(['disambiguateDoubleheader'])],
  ['netlify/functions/get-results-alpha.js', jsNames],
  ['daily-omega/index.html', htmlNames],
  ['alpha/index.html', htmlNames],
];

for (const [file, names] of impls) {
  const api = load(file, names);
  assertMatcher(api, file);
  assertFindGame(api, file);
  console.log('ok ' + file);
}

const omegaSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/get-results-omega.js'), 'utf8');
assert.ok(omegaSrc.includes("const RESULTS_CACHE_KEY = 'results-omega-cache-v9-ncaaf-state'"));
assert.ok(!omegaSrc.includes('results-omega-cache-v8-allver'));

console.log('all ncaaf state-suffix checks passed');
