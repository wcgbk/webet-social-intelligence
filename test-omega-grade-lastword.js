'use strict';
/**
 * GRADE-LASTWORD. From IDENTITY_V2_FROM, NFL/MLB/NHL match resolved team ids
 * before any last word. Two different ids never match. A name that does not
 * resolve may still use the last word. Earlier dates keep the last-word
 * matcher. History 09-22..10-08 must be 0 diffs or this test fails.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const repo = __dirname;
const grader = require('./netlify/functions/get-results-omega');
const { resolveTeamId } = require('./netlify/functions/lib/omega-vnext/sports/team_identity');
const t = grader._test;

const V2 = '2026-10-07';
const PRE = '2026-10-06';
// Dated identity-v2: different ids never share a last word.
assert.strictEqual(t.teamsMatch('Chicago White Sox', 'Boston Red Sox', 'BOS', 'MLB', V2), false);
assert.strictEqual(t.teamsMatch('Chicago White Sox', 'Chicago White Sox', 'CWS', 'MLB', V2), true);
// Undated and pre-cutoff stay on the last-word matcher.
assert.strictEqual(t.teamsMatch('Chicago White Sox', 'Boston Red Sox', 'BOS', 'MLB'), true);
assert.strictEqual(t.teamsMatch('Chicago White Sox', 'Boston Red Sox', 'BOS', 'MLB', PRE), true);
assert.strictEqual(t.teamsMatch('New York Giants', 'San Francisco Giants', 'SF', 'NFL', V2), true, 'unresolved NFL name may still share a last word');
assert.strictEqual(t.teamsMatch('Foo Zebras', 'Bar Zebras', '', 'NFL', V2), true);
assert.strictEqual(t.teamsMatch('Foo Zebras', 'Bar Zebras', '', 'MLB', V2), true);
assert.strictEqual(t.teamsMatch('Foo Zebras', 'Bar Lions', '', 'NHL', V2), false);
assert.strictEqual(t.teamsMatch('McNeese State Cowboys', 'McNeese Cowboys', '', 'NCAAF', V2), true);
assert.strictEqual(t.teamsMatch('Foo Zebras', 'Bar Zebras', '', 'NCAAF', V2), false);

const bos = resolveTeamId('MLB', 'Boston Red Sox');
const cws = resolveTeamId('MLB', 'Chicago White Sox');
const cle = resolveTeamId('MLB', 'Cleveland Guardians');
assert.ok(bos && cws && cle && bos !== cws);

function mlbGame(away, home, awayId, homeId, start) {
  return {
    awayTeam: away,
    homeTeam: home,
    awayAbbr: awayId === bos ? 'BOS' : 'CWS',
    homeAbbr: 'CLE',
    awayId,
    homeId,
    awayScore: 4,
    homeScore: 2,
    state: 'post',
    statusName: 'STATUS_FINAL',
    completed: true,
    startISO: start,
  };
}

const wrong = mlbGame('Boston Red Sox', 'Cleveland Guardians', bos, cle, '2026-09-22T23:10:00Z');
const right = mlbGame('Chicago White Sox', 'Cleveland Guardians', cws, cle, '2026-09-22T23:40:00Z');
const soxPick = {
  sport: 'MLB',
  matchup: 'Chicago White Sox @ Cleveland Guardians',
  pick: 'Chicago White Sox ML',
  betType: 'Moneyline',
  odds: '-120',
  commenceTime: '2026-09-22T23:40:00Z',
};

assert.strictEqual(t.findGame(soxPick, [wrong], '2026-10-08'), null, 'no last-word grab on identity-v2');
assert.ok(t.findGame(soxPick, [wrong], '2026-09-22'), 'pre-cutoff last-word still finds the other Sox club');
const hit = t.findGame(soxPick, [wrong, right], '2026-10-08');
assert.strictEqual(hit && hit.awayId, cws, 'id pair wins on identity-v2');
assert.strictEqual(t.gradePick(soxPick, hit, { dateISO: '2026-10-08' }), 'win');
assert.strictEqual(t.gradePick(soxPick, null, { dateISO: '2026-10-08' }), 'pending');
// One matchup side does not resolve. The side that does must not last-word onto the other club.
const mysteryPick = {
  sport: 'MLB',
  matchup: 'Chicago White Sox @ Mystery FC',
  pick: 'Chicago White Sox ML',
  betType: 'Moneyline',
  odds: '-120',
};
const mysteryGame = mlbGame('Boston Red Sox', 'Mystery FC', bos, '', '2026-10-08T23:10:00Z');
mysteryGame.homeAbbr = 'MFC';
mysteryGame.homeId = '';
assert.strictEqual(t.findGame(mysteryPick, [mysteryGame], '2026-10-08'), null, 'resolved side blocks the other Sox');
assert.ok(t.findGame(mysteryPick, [mysteryGame], '2026-09-22'), 'pre-cutoff may still last-word that side');

const zebra = {
  awayTeam: 'Foo Zebras',
  homeTeam: 'Bar Lions',
  awayAbbr: 'FZE',
  homeAbbr: 'BLI',
  awayId: '',
  homeId: '',
  awayScore: 3,
  homeScore: 1,
  state: 'post',
  statusName: 'STATUS_FINAL',
  completed: true,
  startISO: '2026-09-23T00:00:00Z',
};
const zebraPick = {
  sport: 'NFL',
  matchup: 'Foo Zebras @ Bar Lions',
  pick: 'Foo Zebras ML',
  betType: 'Moneyline',
  odds: '-110',
  commenceTime: '2026-09-23T00:00:00Z',
};
for (const date of ['2026-09-22', '2026-10-08']) {
  const hit = t.findGame(zebraPick, [zebra], date);
  assert.strictEqual(hit, zebra, `unresolved last word still matches on ${date}`);
  assert.strictEqual(t.gradePick(zebraPick, hit, { dateISO: date }), 'win');
}

// ── History: old HEAD grader vs this file, public cards 09-22..10-08 ──
function extractSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function loadMapEvent() {
  const src = fs.readFileSync(path.join(repo, 'netlify/functions/lib/espn-scoreboard.js'), 'utf8');
  return new Function(extractSource(src, 'espnTeamId') + '\n' + extractSource(src, 'mapEvent') + '\nreturn mapEvent;')();
}

function loadOld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-lastword-'));
  const body = execSync('git show HEAD:netlify/functions/get-results-omega.js', {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const destDir = path.join(tmp, 'netlify/functions');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'get-results-omega.js'), body);
  fs.symlinkSync(path.join(repo, 'netlify/functions/lib'), path.join(destDir, 'lib'));
  fs.symlinkSync(path.join(repo, 'js'), path.join(tmp, 'js'));
  return require(path.join(destDir, 'get-results-omega.js'));
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function gameKey(g) {
  if (!g) return null;
  return [g.awayTeam || '', g.homeTeam || '', g.startISO || '', g.awayScore, g.homeScore, g.state || ''].join('|');
}

const mapEvent = loadMapEvent();
const old = loadOld();
const boardCache = new Map();

function filesFor(sport, date) {
  const subs = sport === 'NCAAF' ? ['ncaaf-80', 'ncaaf-90'] : [sport.toLowerCase()];
  const roots = [
    '/workspace/omega-replay-2w/inputs/_espn',
    '/workspace/omega-replay-2w/inputs/_espn-finals',
  ];
  const out = [];
  for (const root of roots) {
    for (const sub of subs) {
      const file = path.join(root, sub, date + '.json');
      if (fs.existsSync(file)) out.push(file);
    }
  }
  return out;
}

function gamesFor(sport, date) {
  const key = sport + '|' + date;
  if (boardCache.has(key)) return boardCache.get(key);
  const rank = (g) => (g.state === 'post' ? 3 : g.state === 'in' ? 2 : 1);
  const map = new Map();
  for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
    for (const file of filesFor(sport, d)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const ev of data.events || []) {
        const g = mapEvent(ev);
        if (!g) continue;
        const k = (g.awayAbbr || g.awayTeam || '') + '|' + (g.homeAbbr || g.homeTeam || '') + '|' + (g.startISO || '');
        const prev = map.get(k);
        if (!prev || rank(g) > rank(prev)) map.set(k, g);
      }
    }
  }
  const games = [...map.values()];
  boardCache.set(key, games);
  return games;
}

function snapshot(api, pick, games, date, straights) {
  const p = api._test.withLegCommenceTime(pick, straights);
  const game = api._test.findGame(p, games, date);
  const result = api._test.gradePick(p, game, { dateISO: date });
  return { result, key: gameKey(game) };
}

const diffs = [];
let checked = 0;
const start = new Date('2026-09-22T12:00:00Z');
const end = new Date('2026-10-08T12:00:00Z');
for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10);
  const cardPath = `/workspace/omega-replay-2w/inputs/${date}/card.json`;
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  const straights = (card.picks || []).slice(0, 3);
  const legs = (card.parlayLegs && card.parlayLegs[0] && card.parlayLegs[0].legs) || [];
  const items = straights.map((p, i) => ({ kind: 'straight', i, pick: p }))
    .concat(legs.map((p, i) => ({ kind: 'leg', i, pick: p })));
  for (const item of items) {
    const sport = item.pick.sport;
    if (!sport) continue;
    const games = gamesFor(sport, date);
    const a = snapshot(old, item.pick, games, date, straights);
    const b = snapshot(grader, item.pick, games, date, straights);
    checked += 1;
    if (a.result !== b.result || a.key !== b.key) {
      diffs.push({
        date,
        kind: item.kind,
        i: item.i,
        sport,
        matchup: item.pick.matchup,
        pick: item.pick.pick,
        old: a,
        next: b,
      });
    }
  }
}

if (diffs.length) {
  console.log('GRADE-LASTWORD history diffs: ' + diffs.length);
  for (const row of diffs) console.log(JSON.stringify(row));
  process.exit(1);
}
console.log('test-omega-grade-lastword: ok history diffs: 0 checked ' + checked);
