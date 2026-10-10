'use strict';
// Every observed team string resolves to one ESPN id, or is an explicit
// league-scoped non-match. Server and client must agree. Construction
// checks lock ET card dates, a real doubleheader, postponed/suspended
// voids, and the neutral-site road-rest term.
const assert = require('assert');
const fixture = require('./netlify/functions/lib/omega-vnext/sports/data/identity-observed.json');
const id = require('./netlify/functions/lib/omega-vnext/sports/team_identity');
const client = require('./js/omega-team-identity');
const { etCalendarDate, isSameEtDay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { resolveDoubleheader } = require('./js/live-score');
const grader = require('./netlify/functions/get-results-omega');
const rules = require('./netlify/functions/lib/omega-grading-rules');
const circa = require('./netlify/functions/lib/circa-live-grade');
const { NICK_TO_FULL } = require('./netlify/functions/lib/circa-contest-lines');
const { restMarginAdj } = require('./netlify/functions/lib/omega-vnext/sports/game_day');
const { REST_ADJ } = require('./netlify/functions/lib/omega-vnext/config');
const { buildHealthRecord } = require('./netlify/functions/lib/omega-vnext/health');

assert.ok(fixture.mustResolve.length > 1000, fixture.mustResolve.length);
assert.ok(fixture.mustNotResolve.length > 30, fixture.mustNotResolve.length);

const seen = new Map();
for (const row of fixture.mustResolve) {
  assert.ok(row.sport && row.name && row.id, JSON.stringify(row));
  const norm = id.normalizeTeamName(row.name);
  const key = row.sport + '\0' + norm;
  const prev = seen.get(key);
  if (prev && prev !== row.id) {
    assert.fail(`${row.sport} "${row.name}" is ${row.id} and ${prev}`);
  }
  seen.set(key, row.id);
  const serverId = id.resolveTeamId(row.sport, row.name);
  const clientId = client.resolveTeamId(row.sport, row.name);
  assert.strictEqual(serverId, row.id, `${row.sport} ${row.name}`);
  assert.strictEqual(clientId, row.id, `client ${row.sport} ${row.name}`);
  assert.deepStrictEqual(id.collectAmbiguous(row.sport, [row.name]), []);
}

const nullSeen = new Set();
for (const row of fixture.mustNotResolve) {
  const key = row.sport + '\0' + id.normalizeTeamName(row.name);
  assert.ok(!seen.has(key), `${row.sport} "${row.name}" is both required and banned`);
  assert.ok(!nullSeen.has(key), `duplicate null ${row.sport} ${row.name}`);
  nullSeen.add(key);
  assert.strictEqual(id.resolveTeamId(row.sport, row.name), null, `${row.sport} ${row.name}`);
  assert.strictEqual(client.resolveTeamId(row.sport, row.name), null, `client ${row.sport} ${row.name}`);
}

for (const [sport, tokens] of Object.entries(id.AMBIGUOUS_TOKENS)) {
  for (const token of tokens) {
    assert.strictEqual(id.resolveTeamId(sport, token), null, `${sport} ${token}`);
    assert.strictEqual(client.resolveTeamId(sport, token), null, `client ${sport} ${token}`);
  }
  assert.deepStrictEqual(id.collectAmbiguous(sport, tokens), []);
}

// League scope. The same word is a different club, or no club, in another league.
assert.strictEqual(id.resolveTeamId('NFL', 'Washington'), '28');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Washington'), '264');
assert.notStrictEqual(id.resolveTeamId('NFL', 'Washington'), id.resolveTeamId('NCAAF', 'Washington'));
assert.strictEqual(id.resolveTeamId('NCAAF', 'Washington State'), '265');
assert.strictEqual(id.resolveTeamId('NCAAF', 'USC'), '30');
assert.notStrictEqual(id.resolveTeamId('NCAAF', 'USC'), id.resolveTeamId('NCAAF', 'South Carolina Gamecocks'));
assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami'), '2390');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami (OH)'), '193');
assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Miami'), id.resolveTeamId('NCAAF', 'Miami (OH)'));
assert.strictEqual(id.resolveTeamId('MLB', 'Rangers'), '13');
assert.strictEqual(id.resolveTeamId('NHL', 'Rangers'), null);
assert.ok(id.resolveTeamId('NHL', 'New York Rangers'));
assert.notStrictEqual(
  id.resolveTeamId('NHL', 'New York Rangers'),
  id.resolveTeamId('NHL', 'New York Islanders')
);
assert.strictEqual(id.resolveTeamId('NHL', 'Kings'), null);
assert.strictEqual(id.resolveTeamId('NBA', 'LA'), null);
assert.strictEqual(id.resolveTeamId('NHL', 'LA'), id.resolveTeamId('NHL', 'Los Angeles Kings'));
assert.ok(id.resolveTeamId('NHL', 'LA'));
assert.strictEqual(id.resolveTeamId('NCAAF', 'Huskies'), null);
assert.strictEqual(id.resolveTeamId('NCAAF', 'Tigers'), null);
assert.strictEqual(id.resolveTeamId('NCAAF', 'CONN Huskies'), '41');
assert.strictEqual(id.resolveTeamId('NCAAF', 'NIU Huskies'), '2459');
assert.strictEqual(id.resolveTeamId('MLB', 'Yankees'), '10');
assert.strictEqual(id.resolveTeamId('MLB', 'Sox'), null);
assert.strictEqual(id.resolveTeamId('NFL', 'Chiefs'), null);
assert.strictEqual(id.resolveTeamId('NFL', 'Bills'), null);
assert.strictEqual(id.resolveTeamId('NBA', 'New York'), null);
assert.strictEqual(id.resolveTeamId('NBA', 'New York Knicks'), '18');
assert.strictEqual(client.resolveTeamId('MLB', 'Yankees'), '10');
assert.strictEqual(client.resolveTeamId('NCAAF', 'Texas AM'), '245');
assert.strictEqual(client.resolveTeamId('NCAAF', 'Rio Grande Red Storm'), '131239');
assert.strictEqual(client.resolveTeamId('NHL', 'NY Rangers'), '13');

const mlbTable = {
  'New York Yankees': { id: 'NYY' },
  'Boston Red Sox': { id: 'BOS' },
  'Chicago White Sox': { id: 'CWS' },
};
assert.strictEqual(id.rowByIdentityOrFuzzy('MLB', mlbTable, 'Yankees').id, 'NYY');
assert.strictEqual(id.rowByIdentityOrFuzzy('MLB', mlbTable, 'Red Sox').id, 'BOS');
assert.strictEqual(id.rowByIdentityOrFuzzy('MLB', mlbTable, 'Sox'), null);

// Circa sheet nicknames are an explicit NFL table. The token itself is not
// an ESPN id. The full name is.
const nickIds = new Map();
for (const [nick, full] of Object.entries(NICK_TO_FULL)) {
  const fullId = id.resolveTeamId('NFL', full);
  assert.ok(fullId, full);
  assert.strictEqual(id.resolveTeamId('NFL', nick), null, nick);
  const prev = nickIds.get(nick.toLowerCase());
  if (prev) assert.strictEqual(prev, fullId, nick);
  nickIds.set(nick.toLowerCase(), fullId);
}
assert.strictEqual(circa.teamsMatch('Steelers', 'Pittsburgh Steelers', 'PIT'), true);
assert.strictEqual(circa.teamsMatch('New York Giants', 'New York Jets', 'NYJ'), false);
assert.strictEqual(circa.teamsMatch('Dallas Cowboys', 'Dallas Cowboys', 'DAL'), true);

// 2026-10-09T00:00Z is still 2026-10-08 in America/New_York (EDT, UTC-4).
assert.strictEqual(etCalendarDate('2026-10-09T00:00:00Z'), '2026-10-08');
assert.strictEqual(isSameEtDay('2026-10-09T03:59:00Z', '2026-10-08'), true);
assert.strictEqual(isSameEtDay('2026-10-09T04:00:00Z', '2026-10-08'), false);

const nightcap = resolveDoubleheader(
  [
    { id: '394e1e2b849c5b4eaf2b5984eaa74b79', startISO: '2026-09-22T17:06:00Z', state: 'post' },
    { id: '574050c10d1acc2da7baf72384eeaa11', startISO: '2026-09-22T23:06:00Z', state: 'pre' },
  ],
  { commenceTime: '2026-09-22T23:06:00Z' },
  Date.parse('2026-09-22T22:00:00Z')
);
assert.strictEqual(nightcap.id, '574050c10d1acc2da7baf72384eeaa11');

const ppd = grader._test.gradePick(
  { pick: 'Over 8.5', sport: 'MLB', betType: 'total' },
  { state: 'post', completed: false, statusName: 'STATUS_POSTPONED', awayScore: 0, homeScore: 0, id: '401817035' }
);
assert.strictEqual(ppd, 'push');
const suspended = grader._test.gradePick(
  { pick: 'Over 8.5', sport: 'MLB', betType: 'total' },
  { state: 'post', completed: true, statusName: 'STATUS_SUSPENDED', awayScore: 2, homeScore: 0 }
);
assert.strictEqual(suspended, 'push');
assert.strictEqual(
  rules.isPpdScore({}, { state: 'post', completed: true, statusName: 'STATUS_SUSPENDED' }, {}),
  true
);
assert.strictEqual(
  rules.isPpdScore({}, { state: 'post', completed: true, statusName: 'STATUS_FINAL' }, {}),
  false
);
const circaSusp = circa.gradeAts(
  { pick: 'Steelers -3.5' },
  {
    state: 'post', completed: true, statusName: 'STATUS_SUSPENDED',
    awayScore: 0, homeScore: 10, awayTeam: 'Cleveland Browns', homeTeam: 'Pittsburgh Steelers',
  }
);
assert.strictEqual(circaSusp.result, 'push');

const openRest = restMarginAdj('NFL', 'normal', 'short', {});
const neutralRest = restMarginAdj('NFL', 'normal', 'short', { neutralSite: true });
assert.ok(Math.abs((openRest - neutralRest) - REST_ADJ.NFL.roadShort) < 1e-9);

const health = buildHealthRecord({
  dateISO: '2026-10-08',
  snap: {
    espnBySport: {
      MLB: { games: [{ homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', homeAbbr: 'NYY', awayAbbr: 'BOS' }] },
    },
    oddsBySport: { MLB: [{ home_team: 'Sox', away_team: 'Yankees' }] },
    standingsBySport: {},
    mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } },
  },
  rawBySport: { MLB: 1 },
  candidates: [],
  yesPool: [],
  oddsErrors: [],
});
const codes = health.alerts.map((a) => a.sport + ':' + a.code);
assert.ok(codes.includes('MLB:unresolved_names'), codes.join(','));
assert.ok(!codes.includes('MLB:ambiguous_names'), codes.join(','));
assert.ok(health.bySport.MLB.unresolved.includes('Sox'));
assert.ok(!health.bySport.MLB.unresolved.includes('Yankees'));
assert.ok(!health.bySport.MLB.unresolved.includes('NYY'));
assert.deepStrictEqual(health.bySport.MLB.ambiguous, []);

console.log(`identity exhaustive ok resolve=${fixture.mustResolve.length} null=${fixture.mustNotResolve.length}`);
