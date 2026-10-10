'use strict';
/**
 * NCAAF/NFL EPA and standings rows resolve by ESPN id.
 * An explicit alias is consulted only when the main lookup misses.
 * A mascot collision with a different resolved school is not a miss
 * and does not log exact_only. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const id = require(path.join(root, 'sports/team_identity'));
const epa = require(path.join(root, 'sports/epa'));
const ingest = require(path.join(root, 'ingest'));
const ncaafIds = require(path.join(root, 'sports/data/ncaaf-team-ids.json'));
const nflIds = require(path.join(root, 'sports/data/nfl-team-ids.json'));

const seeds = ingest.loadEfficiencySeeds();

assert.strictEqual(id.resolveTeamId('NCAAF', 'Texas AM'), '245');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Texas AM Aggies'), '245');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Texas A&M University'), '245');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Texas A&M Aggies'), '245');
assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Texas AM'), id.resolveTeamId('NCAAF', 'Texas Longhorns'));
assert.strictEqual(id.resolveTeamId('NCAAF', 'OK State'), '197');
assert.strictEqual(id.resolveTeamId('NCAAF', 'OSU Cowboys'), '197');
assert.notStrictEqual(id.resolveTeamId('NCAAF', 'OK State'), id.resolveTeamId('NCAAF', 'Oklahoma Sooners'));
assert.strictEqual(id.resolveTeamId('NCAAF', 'NIU Huskies'), '2459');
assert.strictEqual(id.resolveTeamId('NCAAF', 'Northern Illinois Huskies'), '2459');
assert.strictEqual(id.resolveTeamId('NCAAF', 'CONN Huskies'), '41');
assert.strictEqual(id.resolveTeamId('NCAAF', 'UConn Huskies'), '41');
assert.strictEqual(id.resolveTeamId('NFL', 'Texas AM'), null);
assert.strictEqual(id.resolveTeamId('NFL', 'OK State'), null);

// Alias key binds without an espnId stamp. A different Aggies row does not.
{
  const aliased = { 'Texas AM Aggies': { offEpa: 0.11, defEpa: 0.07 } };
  assert.strictEqual(id.rowByIdentity('NCAAF', aliased, 'Texas A&M Aggies').offEpa, 0.11);
  assert.strictEqual(epa.lookupEpa('Texas A&M Aggies', aliased, 'NCAAF').offEpa, 0.11);
  const other = { 'Utah State Aggies': { offEpa: 0.2, defEpa: 0.2 } };
  assert.strictEqual(epa.lookupEpa('Texas A&M Aggies', other, 'NCAAF'), null);
  assert.strictEqual(id.modelRow('NCAAF', other, 'Texas A&M Aggies'), null);
}

// Numeric ESPN id key, and a stamped espnId on a key that does not resolve.
{
  const byId = { '245': { offEpa: 0.08, defEpa: 0.04 } };
  assert.strictEqual(id.rowByIdentity('NCAAF', byId, 'Texas A&M Aggies').offEpa, 0.08);
  const stamped = { 'Aggie Club': { offEpa: 0.03, defEpa: 0.02, espnId: '245' } };
  assert.strictEqual(id.rowByIdentity('NCAAF', stamped, 'Texas A&M Aggies').offEpa, 0.03);
  assert.deepStrictEqual(id.unresolvedKeys('NCAAF', stamped), ['Aggie Club']);
  const conflict = { 'Utah State Aggies': { offEpa: 0.01, defEpa: 0.01, espnId: '245' } };
  assert.strictEqual(id.rowByIdentity('NCAAF', conflict, 'Texas A&M Aggies').offEpa, 0.01);
  assert.strictEqual(id.rowByIdentity('NCAAF', conflict, 'Utah State Aggies'), null);
}

// Seeded schools resolve. Schools with no seed row stay null, not a mascot twin.
{
  assert.ok(epa.lookupEpa('Texas A&M Aggies', seeds.NCAAF, 'NCAAF'));
  assert.ok(epa.lookupEpa('Michigan State Spartans', seeds.NCAAF, 'NCAAF'));
  assert.strictEqual(seeds.NCAAF['Texas A&M Aggies'].espnId, '245');
  assert.strictEqual(seeds.NCAAF['Michigan State Spartans'].espnId, '127');
  for (const name of [
    'Oklahoma State Cowboys',
    'Ball State Cardinals',
    'Houston Cougars',
    'UConn Huskies',
    'Northern Illinois Huskies',
  ]) {
    assert.ok(id.resolveTeamId('NCAAF', name), name);
    assert.strictEqual(epa.lookupEpa(name, seeds.NCAAF, 'NCAAF'), null, name);
  }
  assert.notStrictEqual(
    epa.lookupEpa('Louisville Cardinals', seeds.NCAAF, 'NCAAF'),
    null
  );
  assert.strictEqual(epa.lookupEpa('Ball State Cardinals', seeds.NCAAF, 'NCAAF'), null);
}

function assertClean(sport, table, expectTeams) {
  const rep = id.footballResolutionReport(sport, table);
  assert.strictEqual(rep.teams, expectTeams, sport);
  assert.strictEqual(rep.idMisses.length, 0, JSON.stringify(rep.idMisses));
  assert.strictEqual(rep.rowMisses.length, 0, JSON.stringify(rep.rowMisses));
  assert.deepStrictEqual(rep.unresolvedKeys, []);
  return rep;
}

const ncaafEpa = assertClean('NCAAF', seeds.NCAAF, 138);
const nflEpa = assertClean('NFL', seeds.NFL, 32);
assert.strictEqual(ncaafEpa.fuzzyStillLogged.length, 0);
assert.strictEqual(nflEpa.fuzzyStillLogged.length, 0);
assert.ok(ncaafEpa.fuzzyCrossSchool.length > 0);
console.log(
  `resolution NCAAF teams=${ncaafEpa.teams} idMiss=0 rowMiss=0 fuzzyCross=${ncaafEpa.fuzzyCrossSchool.length} fuzzyLogged=${ncaafEpa.fuzzyStillLogged.length}`
);
console.log(
  `resolution NFL teams=${nflEpa.teams} idMiss=0 rowMiss=0 fuzzyCross=${nflEpa.fuzzyCrossSchool.length} fuzzyLogged=${nflEpa.fuzzyStillLogged.length}`
);

{
  const standings = {};
  for (const rec of Object.values(ncaafIds.teams)) {
    if (rec && rec.division === 'fbs' && rec.displayName) {
      standings[rec.displayName] = { pf: 100, pa: 100, wins: 3, losses: 2 };
    }
  }
  const rep = assertClean('NCAAF', standings, 138);
  assert.strictEqual(rep.fuzzyCrossSchool.length, 0);
}
{
  const standings = {};
  for (const rec of Object.values(nflIds.teams)) {
    if (rec && rec.displayName) standings[rec.displayName] = { pf: 100, pa: 80, wins: 3, losses: 2 };
  }
  assertClean('NFL', standings, 32);
}

// Cross-school mascot hits do not log. An unresolved fuzzy key still does.
{
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    for (const hit of ncaafEpa.fuzzyCrossSchool) {
      assert.strictEqual(id.modelRow('NCAAF', seeds.NCAAF, hit.name), null, hit.name);
    }
    const rest = {
      'Utah State Aggies': { playedYesterday: true },
      'Wyoming Cowboys': { playedYesterday: true },
      'San José State Spartans': { playedYesterday: true },
      'Louisville Cardinals': { playedYesterday: true },
      'Washington State Cougars': { playedYesterday: true },
      'Washington Huskies': { playedYesterday: true },
    };
    for (const name of [
      'Texas A&M Aggies',
      'Oklahoma State Cowboys',
      'Michigan State Spartans',
      'Ball State Cardinals',
      'Houston Cougars',
      'UConn Huskies',
      'Northern Illinois Huskies',
    ]) {
      assert.strictEqual(id.modelRow('NCAAF', rest, name), null, name);
    }
    id.modelRow('NFL', { 'Not Chiefs': { playedYesterday: true } }, 'Kansas City Chiefs');
  } finally {
    console.warn = orig;
  }
  assert.ok(!warns.some((w) => /exact_only refused fuzzy sport=NCAAF/.test(w)), warns.join('\n'));
  assert.ok(warns.some((w) => /exact_only refused fuzzy sport=NFL name=Kansas City Chiefs/.test(w)));
}

console.log('test-omega-ncaaf-epa-resolve: ok');
