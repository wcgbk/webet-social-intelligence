'use strict';

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const { fuzzyTeam, powerFromStandings } = require(path.join(root, 'sports/_common'));
const epa = require(path.join(root, 'sports/epa'));
const cfb = require(path.join(root, 'sports/cfb'));
const nfl = require(path.join(root, 'sports/nfl'));
const mlb = require(path.join(root, 'sports/mlb'));
const nhl = require(path.join(root, 'sports/nhl'));
const gd = require(path.join(root, 'sports/game_day'));
const ingest = require(path.join(root, 'ingest'));
const { applyGates, gateReason } = require(path.join(root, 'gates'));
const id = require(path.join(root, 'sports/team_identity'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.17-omega-vnext-cal-a');

const seeds = ingest.loadEfficiencySeeds();
const nflSeedFile = require(path.join(root, 'sports/data/nfl-epa-seed.json'));
const cfbSeedFile = require(path.join(root, 'sports/data/cfb-epa-seed.json'));
const nflIds = require(path.join(root, 'sports/data/nfl-team-ids.json'));

function synth(home, away, opts = {}) {
  const total = opts.total != null ? opts.total : 45.5;
  const spread = opts.spread != null ? opts.spread : -3.5;
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-10T23:10:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ] },
      ],
    })),
  };
}

function byMarket(cands, market) {
  const row = cands.find((c) => c.market === market);
  assert.ok(row, `missing ${market}`);
  return row;
}

// Kentucky is in the seed. It must take Kentucky's row, never Kansas State's.
{
  const ky = id.resolveTeamId('NCAAF', 'Kentucky Wildcats');
  const ks = id.resolveTeamId('NCAAF', 'Kansas State Wildcats');
  assert.ok(ky && ks && ky !== ks);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Kentucky'), ky);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Wildcats'), null);
  const kyRow = epa.lookupEpa('Kentucky Wildcats', seeds.NCAAF, 'NCAAF');
  const ksRow = epa.lookupEpa('Kansas State Wildcats', seeds.NCAAF, 'NCAAF');
  assert.strictEqual(kyRow.offEpa, seeds.NCAAF['Kentucky Wildcats'].offEpa);
  assert.notStrictEqual(kyRow.offEpa, ksRow.offEpa);
  const onlyKsu = { 'Kansas State Wildcats': seeds.NCAAF['Kansas State Wildcats'] };
  assert.strictEqual(epa.lookupEpa('Kentucky Wildcats', onlyKsu, 'NCAAF'), null);
  assert.strictEqual(epa.lookupEpa('Wildcats', seeds.NCAAF, 'NCAAF'), null);
}

{
  const ks = id.resolveTeamId('NCAAF', 'Kansas State Wildcats');
  for (const name of ['Northwestern Wildcats', 'Arizona Wildcats', 'Villanova Wildcats', 'Davidson Wildcats']) {
    const own = id.resolveTeamId('NCAAF', name);
    assert.ok(own, name);
    assert.notStrictEqual(own, ks, name);
  }
  assert.strictEqual(epa.lookupEpa('Northwestern Wildcats', seeds.NCAAF, 'NCAAF'), null);
  assert.strictEqual(epa.lookupEpa('Villanova Wildcats', seeds.NCAAF, 'NCAAF'), null);
  assert.strictEqual(epa.lookupEpa('Davidson Wildcats', seeds.NCAAF, 'NCAAF'), null);
  assert.strictEqual(
    epa.lookupEpa('Arizona Wildcats', seeds.NCAAF, 'NCAAF').offEpa,
    seeds.NCAAF['Arizona Wildcats'].offEpa
  );
}

{
  const mcneese = id.resolveTeamId('NCAAF', 'McNeese');
  assert.ok(mcneese);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'McNeese State Cowboys'), mcneese);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'McNeese Cowboys'), mcneese);
  assert.strictEqual(epa.lookupEpa('McNeese State Cowboys', seeds.NCAAF, 'NCAAF'), null);
}

{
  const army = id.resolveTeamId('NCAAF', 'Army Black Knights');
  const ucf = id.resolveTeamId('NCAAF', 'UCF Knights');
  assert.ok(army && ucf && army !== ucf);
  assert.strictEqual(epa.lookupEpa('Army Black Knights', seeds.NCAAF, 'NCAAF'), null);
  assert.strictEqual(epa.lookupEpa('Army', seeds.NCAAF, 'NCAAF'), null);
  assert.ok(epa.lookupEpa('UCF Knights', seeds.NCAAF, 'NCAAF'));
}

{
  const wmu = id.resolveTeamId('NCAAF', 'Western Michigan Broncos');
  const boise = id.resolveTeamId('NCAAF', 'Boise State Broncos');
  assert.ok(wmu && boise && wmu !== boise);
  const home = 'Western Michigan Broncos';
  const away = 'Boise State Broncos';
  const standings = {
    [home]: { pf: 30, pa: 40, wins: 1, losses: 2 },
    [away]: { pf: 120, pa: 40, wins: 3, losses: 0 },
  };
  assert.strictEqual(epa.lookupEpa(home, seeds.NCAAF, 'NCAAF'), null);
  assert.ok(epa.lookupEpa(away, seeds.NCAAF, 'NCAAF'));
  const proj = epa.footballProjection({
    sport: 'NCAAF', home, away, standings, efficiency: seeds.NCAAF,
  });
  assert.strictEqual(proj.unknownTeam, false);
  assert.strictEqual(proj.usedEpa, true);
  assert.strictEqual(proj.methods.family, 'cfb-epa-v1');
  const hPow = powerFromStandings(standings[home], 'NCAAF');
  const aPow = powerFromStandings(standings[away], 'NCAAF');
  assert.ok(Math.abs(hPow - aPow) > 1);
  assert.ok(Math.abs(proj.modelMargin - ((hPow - aPow) + config.HFA.NCAAF)) > 0.5);
}

{
  const gs = id.resolveTeamId('NCAAF', 'Georgia State Panthers');
  assert.ok(gs);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Georgia State'), gs);
  assert.notStrictEqual(gs, id.resolveTeamId('NCAAF', 'Georgia Bulldogs'));
  assert.notStrictEqual(gs, id.resolveTeamId('NCAAF', 'Georgia'));
  assert.notStrictEqual(gs, id.resolveTeamId('NCAAF', 'Pittsburgh Panthers'));
  assert.notStrictEqual(gs, id.resolveTeamId('NCAAF', 'Pitt'));
  assert.strictEqual(epa.lookupEpa('Georgia State Panthers', seeds.NCAAF, 'NCAAF'), null);
  assert.ok(epa.lookupEpa('Georgia Bulldogs', seeds.NCAAF, 'NCAAF'));
  const rest = gd.lookupRest('Georgia State Panthers', {
    'Georgia Bulldogs': { playedYesterday: true, tag: 'uga' },
    'Pittsburgh Panthers': { playedYesterday: true, tag: 'pitt' },
  }, 'NCAAF');
  assert.strictEqual(rest, null);
}

{
  const unlv = id.resolveTeamId('NCAAF', 'UNLV Rebels');
  const ole = id.resolveTeamId('NCAAF', 'Ole Miss Rebels');
  assert.ok(unlv && ole && unlv !== ole);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'UNLV'), unlv);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Ole Miss'), ole);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Mississippi'), ole);
  assert.strictEqual(epa.lookupEpa('UNLV Rebels', seeds.NCAAF, 'NCAAF'), null);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Rebels'), null);
}

{
  const fl = id.resolveTeamId('NCAAF', 'Miami Hurricanes');
  const oh = id.resolveTeamId('NCAAF', 'Miami (OH) RedHawks');
  assert.ok(fl && oh && fl !== oh);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami'), fl);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami (FL)'), fl);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami (OH)'), oh);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Miami OH'), oh);
  assert.strictEqual(epa.lookupEpa('Miami (OH) RedHawks', seeds.NCAAF, 'NCAAF'), null);
  assert.ok(epa.lookupEpa('Miami Hurricanes', seeds.NCAAF, 'NCAAF'));
  const standings = {
    'Miami Hurricanes': { tag: 'fl' },
    'Miami (OH) RedHawks': { tag: 'oh' },
  };
  assert.strictEqual(id.rowByIdentity('NCAAF', standings, 'Miami').tag, 'fl');
  assert.strictEqual(id.rowByIdentity('NCAAF', standings, 'Miami (OH)').tag, 'oh');
}

{
  assert.notStrictEqual(
    id.resolveTeamId('NCAAF', 'Central Arkansas Bears'),
    id.resolveTeamId('NCAAF', 'Baylor Bears')
  );
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Bears'), null);
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Hawaii Rainbow Warriors'), id.resolveTeamId('NCAAF', "Hawai'i Rainbow Warriors"));
  assert.strictEqual(id.resolveTeamId('NCAAF', 'San Jose State Spartans'), id.resolveTeamId('NCAAF', 'San José State Spartans'));
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Appalachian State'), id.resolveTeamId('NCAAF', 'App State Mountaineers'));
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Southern Mississippi'), id.resolveTeamId('NCAAF', 'Southern Miss Golden Eagles'));
  assert.strictEqual(id.resolveTeamId('NCAAF', 'UConn'), id.resolveTeamId('NCAAF', 'Connecticut Huskies'));
  assert.strictEqual(id.resolveTeamId('NCAAF', 'Louisiana-Monroe'), id.resolveTeamId('NCAAF', 'UL Monroe Warhawks'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Louisiana-Monroe'), id.resolveTeamId('NCAAF', 'Louisiana'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Kansas'), id.resolveTeamId('NCAAF', 'Kansas State'));
  assert.notStrictEqual(id.resolveTeamId('NCAAF', 'Washington'), id.resolveTeamId('NCAAF', 'Washington State'));
}

{
  const logs = [];
  const orig = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  let cands;
  try {
    cands = cfb.project({
      oddsEvents: [synth('Not A Real University', 'Ohio State Buckeyes', { total: 51.5, spread: -6.5 })],
      standings: { 'Ohio State Buckeyes': { pf: 40, pa: 18, wins: 3, losses: 0 } },
      efficiency: seeds.NCAAF,
    });
  } finally {
    console.warn = orig;
  }
  assert.ok(cands.length >= 6);
  assert.ok(cands.every((c) => c.unknownTeam === true));
  assert.ok(logs.some((line) => line.includes('unknown_team') && line.includes('Not A Real University')));
  const { yesPool, rejected } = applyGates(cands, { cardDate: '2026-10-10' });
  assert.strictEqual(yesPool.length, 0);
  assert.strictEqual(rejected.length, cands.length);
  assert.ok(rejected.every((r) => r.rejectReason === 'unknown_team'));
  const poisoned = { ...cands[0], odds: undefined, ev: 5, coverProb: 0.99, edgePct: 0.5, liquid: true };
  assert.strictEqual(gateReason(poisoned, { cardDate: '2026-10-10' }), 'unknown_team');
  const unmatched = id.listUnresolved('NCAAF', ['Not A Real University', 'Ohio State Buckeyes', 'Not A Real University']);
  assert.deepStrictEqual(unmatched, ['Not A Real University']);
}

{
  const nflNames = Object.keys(nflSeedFile).filter((k) => !k.startsWith('_'));
  assert.strictEqual(nflNames.length, 32);
  assert.strictEqual(Object.keys(nflIds.teams).length, 32);
  for (const name of nflNames) {
    assert.ok(id.resolveTeamId('NFL', name), name);
  }
  for (const team of Object.values(nflIds.teams)) {
    assert.strictEqual(id.resolveTeamId('NFL', team.displayName), String(team.espnId));
    for (const oddsName of team.oddsNames || []) {
      assert.strictEqual(id.resolveTeamId('NFL', oddsName), String(team.espnId), oddsName);
    }
  }
  assert.strictEqual(id.resolveTeamId('NFL', 'Chiefs'), null);
  assert.strictEqual(id.resolveTeamId('NFL', 'Bills'), null);
}

{
  assert.deepStrictEqual(id.unresolvedKeys('NFL', nflSeedFile), []);
  assert.deepStrictEqual(id.unresolvedKeys('NCAAF', cfbSeedFile), []);
  assert.deepStrictEqual(id.unresolvedKeys('NFL', seeds.NFL), []);
  assert.deepStrictEqual(id.unresolvedKeys('NCAAF', seeds.NCAAF), []);
}

{
  const mlbRatings = {
    'Boston Red Sox': { id: 'BOS' },
    'New York Yankees': { id: 'NYY' },
    'Chicago White Sox': { id: 'CWS' },
  };
  assert.strictEqual(fuzzyTeam('Yankees', mlbRatings).id, 'NYY');
  assert.strictEqual(fuzzyTeam('Red Sox', mlbRatings).id, 'BOS');
  assert.strictEqual(fuzzyTeam('Sox', mlbRatings).id, 'BOS');
  assert.strictEqual(fuzzyTeam('Chicago White Sox', mlbRatings).id, 'CWS');
  assert.strictEqual(fuzzyTeam('New York Yankees', mlbRatings).id, 'NYY');

  const nhlRatings = {
    'Colorado Avalanche': { id: 'COL' },
    'Dallas Stars': { id: 'DAL' },
    'Vegas Golden Knights': { id: 'VGK' },
  };
  assert.strictEqual(fuzzyTeam('Avalanche', nhlRatings).id, 'COL');
  assert.strictEqual(fuzzyTeam('Stars', nhlRatings).id, 'DAL');
  assert.strictEqual(fuzzyTeam('Golden Knights', nhlRatings).id, 'VGK');
  assert.strictEqual(fuzzyTeam('Vegas Golden Knights', nhlRatings).id, 'VGK');

  const mlbStandings = {
    'New York Yankees': { pf: 800, pa: 600, wins: 90, losses: 60 },
    'Boston Red Sox': { pf: 700, pa: 700, wins: 80, losses: 70 },
  };
  const mlbFull = mlb.project({
    oddsEvents: [synth('New York Yankees', 'Boston Red Sox', { total: 8.5, spread: -1.5 })],
    standings: mlbStandings,
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  });
  const mlbMascot = mlb.project({
    oddsEvents: [synth('Yankees', 'Red Sox', { total: 8.5, spread: -1.5 })],
    standings: mlbStandings,
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  });
  assert.strictEqual(
    byMarket(mlbFull, 'Spread').modelProjection,
    byMarket(mlbMascot, 'Spread').modelProjection
  );
  assert.strictEqual(byMarket(mlbFull, 'Moneyline').projMethod, byMarket(mlbMascot, 'Moneyline').projMethod);

  const nhlStandings = {
    'Colorado Avalanche': { pf: 3.4, pa: 2.6, wins: 40, losses: 20, otLosses: 5 },
    'Dallas Stars': { pf: 3.1, pa: 2.9, wins: 35, losses: 25, otLosses: 4 },
  };
  const nhlFull = nhl.project({
    oddsEvents: [synth('Colorado Avalanche', 'Dallas Stars', { total: 6, spread: -1.5 })],
    standings: nhlStandings,
  });
  const nhlMascot = nhl.project({
    oddsEvents: [synth('Avalanche', 'Stars', { total: 6, spread: -1.5 })],
    standings: nhlStandings,
  });
  // Bare mascots are not NHL identity. They must not inherit Colorado or Dallas.
  assert.ok(nhlFull.every((c) => !c.unknownTeam));
  assert.ok(nhlMascot.every((c) => c.unknownTeam === true));
  assert.notStrictEqual(
    byMarket(nhlFull, 'Spread').modelProjection,
    byMarket(nhlMascot, 'Spread').modelProjection
  );
  const nhlGated = applyGates(nhlMascot, { cardDate: '2026-10-10' });
  assert.strictEqual(nhlGated.yesPool.length, 0);
  assert.ok(nhlGated.rejected.every((r) => r.rejectReason === 'unknown_team'));

  const yankeesRest = gd.lookupRest('Yankees', { 'New York Yankees': { playedYesterday: true } }, 'MLB');
  assert.strictEqual(yankeesRest.playedYesterday, true);
}

(async () => {
  let writes = 0;
  const dry = await id.persistUnmatchedReport({
    dryRun: true,
    dateISO: '2026-10-05',
    report: { count: 1, bySport: { NFL: [], NCAAF: ['Not A Real University'] } },
    store: async () => { writes += 1; },
  });
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(dry.key, 'omega-unmatched-2026-10-05');
  assert.strictEqual(writes, 0);
  const live = await id.persistUnmatchedReport({
    dryRun: false,
    dateISO: '2026-10-05',
    report: { count: 0, bySport: { NFL: [], NCAAF: [] } },
    store: async (key, data) => {
      writes += 1;
      assert.strictEqual(key, 'omega-unmatched-2026-10-05');
      assert.strictEqual(data.count, 0);
    },
  });
  assert.strictEqual(live.wrote, true);
  assert.strictEqual(writes, 1);

  const pub = publicPicksPayload({
    model: config.MODEL_VERSION,
    teamIdentity: { unmatched: { NCAAF: ['Not A Real University'] }, unmatchedCount: 1 },
    rejections: [{ reason: 'unknown_team' }],
    candidateTable: [{ rank: 1 }],
    picks: [{
      pick: 'Ohio State Buckeyes -3.5',
      sport: 'NCAAF',
      matchup: 'Not A Real University @ Ohio State Buckeyes',
      odds: '-110',
      unknownTeam: true,
      unknownNames: ['Not A Real University'],
    }],
    parlayLegs: [],
  });
  assert.strictEqual(pub.teamIdentity, undefined);
  assert.strictEqual(pub.rejections.length, 0);
  assert.strictEqual(pub.candidateTable, undefined);
  assert.strictEqual(pub.picks[0].unknownTeam, undefined);
  assert.strictEqual(pub.picks[0].unknownNames, undefined);
  assert.strictEqual(pub.picks[0].pick, 'Ohio State Buckeyes -3.5');
  assert.strictEqual(pub.model, 'v12.3.17-omega-vnext-cal-a');

  const nflStraight = nfl.project({
    oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills')],
    standings: {},
    efficiency: seeds.NFL,
  });
  assert.ok(nflStraight.every((c) => !c.unknownTeam));
  assert.ok(/nfl-epa-v1/.test(byMarket(nflStraight, 'Moneyline').projMethod));

  console.log('PASS test-omega-team-identity');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
