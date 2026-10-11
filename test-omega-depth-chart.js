'use strict';
/**
 * Daily ESPN depth-chart QB feed. Fixture is a trimmed live Ravens chart
 * from 2026-10-11 (site depthcharts, athletes in rank order). No network.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const depth = require(path.join(root, 'sports/depth_chart'));
const gd = require(path.join(root, 'sports/game_day'));
const nfl = require(path.join(root, 'sports/nfl'));
const ingest = require(path.join(root, 'ingest'));
const late = require(path.join(root, 'late_news'));
const { runWithFetchMemo } = require(path.join(root, 'fetch_memo'));

const RAVENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'test/fixtures/espn-nfl-depthchart-bal.json'), 'utf8'));
const AUBURN = JSON.parse(fs.readFileSync(path.join(__dirname, 'test/fixtures/espn-ncaaf-depthchart-aub.json'), 'utf8'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.25-omega-vnext-price-lock');
assert.strictEqual(config.QB_INJURY.NFL.outMarginPts, 3);
assert.strictEqual(config.QB_INJURY.NFL.outTotalPts, -1.5);
assert.strictEqual(config.QB_INJURY.NCAAF.outMarginPts, 3.5);
assert.strictEqual(config.QB_INJURY.NCAAF.outTotalPts, -2);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function chart(id, abbr, name, qb1, qb2) {
  return {
    timestamp: '2026-10-11T18:42:38Z',
    status: 'success',
    season: { year: 2026, type: 2, name: 'Regular Season' },
    team: { id: String(id), abbreviation: abbr, displayName: name },
    depthchart: [{
      id: '21',
      name: '3WR 1TE',
      positions: {
        qb: {
          position: { id: '8', name: 'Quarterback', displayName: 'Quarterback', abbreviation: 'QB' },
          athletes: [
            { id: qb1.id, displayName: qb1.name },
            qb2 ? { id: qb2.id, displayName: qb2.name } : null,
          ].filter(Boolean),
        },
      },
    }],
  };
}

const BILLS = chart('2', 'BUF', 'Buffalo Bills',
  { id: '3918298', name: 'Josh Allen' },
  { id: '3115293', name: 'Kyle Allen' });

function feedPack(rows) {
  const map = {};
  const teams = [];
  for (const row of rows) {
    map[row.teamId] = row;
    teams.push(row.teamId);
  }
  return { ok: true, map, source: depth.SOURCE, reason: null, teams, fallbackTeams: [], sport: 'NFL' };
}

function adjust(extra) {
  return gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 3,
    modelTotal: 45,
    uncertainty: 0.13,
    home: 'Buffalo Bills',
    away: 'Miami Dolphins',
    restByTeam: {},
    qbByTeam: {},
    ...extra,
  });
}

(async () => {
  const parsed = depth.parseDepthChart(RAVENS, '33');
  assert.strictEqual(parsed.ok, true, parsed.reason);
  assert.strictEqual(parsed.row.teamId, '33');
  assert.strictEqual(parsed.row.abbr, 'BAL');
  assert.deepStrictEqual(parsed.row.qb1, { name: 'Lamar Jackson', athleteId: '3916387' });
  assert.deepStrictEqual(parsed.row.qb2, { name: 'Tyler Huntley', athleteId: '4035671' });
  assert.strictEqual(parsed.row.source, depth.SOURCE);
  assert.strictEqual(parsed.row.fetchedAt, RAVENS.timestamp);
  assert.strictEqual(
    depth.depthChartUrl('NFL', '33'),
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/33/depthcharts',
  );
  assert.strictEqual(
    depth.depthChartUrl('NCAAF', '2'),
    'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/2/depthcharts',
  );

  const noChart = depth.parseDepthChart(AUBURN, '2');
  assert.strictEqual(noChart.ok, false);
  assert.strictEqual(noChart.reason, 'missing-depthchart');
  assert.strictEqual(depth.parseDepthChart(null, '33').reason, 'schema-not-object');
  assert.strictEqual(depth.parseDepthChart({ status: 'success', depthchart: [] }, '33').reason, 'no-qb');
  const mismatched = depth.parseDepthChart(RAVENS, '1');
  assert.strictEqual(mismatched.ok, false);
  assert.strictEqual(mismatched.reason, 'team-id-mismatch');

  let calls = 0;
  const fetched = await depth.fetchDepthCharts({
    sport: 'NFL',
    teamIds: ['33', '33'],
    date: '2026-10-11',
    fetchImpl: async (url) => {
      calls += 1;
      assert.ok(String(url).includes('/football/nfl/teams/33/depthcharts'), String(url));
      return jsonResponse(RAVENS);
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(fetched.ok, true);
  assert.strictEqual(fetched.map['33'].qb1.name, 'Lamar Jackson');
  assert.deepStrictEqual(fetched.teams, ['33']);
  assert.deepStrictEqual(fetched.fallbackTeams, []);

  calls = 0;
  const bad = await depth.fetchDepthCharts({
    sport: 'NFL',
    teamIds: ['33', '1'],
    date: '2026-10-11',
    fetchImpl: async (url) => {
      calls += 1;
      const u = String(url);
      if (u.includes('/teams/33/')) return jsonResponse(RAVENS);
      return jsonResponse({ status: 'success', team: { id: '1', abbreviation: 'ATL' } });
    },
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(bad.ok, true);
  assert.ok(bad.map['33']);
  assert.deepStrictEqual(bad.fallbackTeams, ['1']);
  assert.strictEqual(bad.reason, 'partial');

  calls = 0;
  const thrown = await depth.fetchDepthCharts({
    sport: 'NFL',
    teamIds: ['33'],
    date: '2026-10-11',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('espn down');
    },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(thrown.ok, false);
  assert.deepStrictEqual(thrown.map, {});
  assert.strictEqual(thrown.source, 'fallback');
  assert.ok(/espn down/.test(thrown.reason), thrown.reason);
  assert.deepStrictEqual(thrown.fallbackTeams, ['33']);

  calls = 0;
  const college = await depth.fetchDepthCharts({
    sport: 'NCAAF',
    teamIds: ['2', '333'],
    date: '2026-10-11',
    fetchImpl: async (url) => {
      calls += 1;
      assert.ok(String(url).includes('/college-football/teams/2/depthcharts'), String(url));
      return jsonResponse(AUBURN);
    },
  });
  assert.strictEqual(calls, 1, 'unsupported college chart does not walk the rest of the slate');
  assert.strictEqual(college.ok, false);
  assert.strictEqual(college.reason, 'missing-depthchart');
  assert.deepStrictEqual(college.map, {});
  assert.deepStrictEqual(college.fallbackTeams, ['2', '333']);
  assert.strictEqual(college.source, 'fallback');

  calls = 0;
  const none = await depth.fetchDepthCharts({
    sport: 'NFL',
    teamIds: [],
    fetchImpl: async () => { calls += 1; throw new Error('nope'); },
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(none.reason, 'no-slate-teams');
  const nhl = await depth.fetchDepthCharts({
    sport: 'NHL',
    teamIds: ['1'],
    fetchImpl: async () => { calls += 1; throw new Error('nope'); },
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(nhl.reason, 'unsupported-sport');

  await runWithFetchMemo(async () => {
    let n = 0;
    const impl = async () => {
      n += 1;
      return jsonResponse(RAVENS);
    };
    const a = await depth.fetchDepthCharts({ sport: 'NFL', teamIds: ['33'], date: '2026-10-11', fetchImpl: impl });
    const b = await depth.fetchDepthCharts({ sport: 'NFL', teamIds: ['33'], date: '2026-10-11', fetchImpl: impl });
    assert.strictEqual(n, 1);
    assert.strictEqual(a.map['33'].qb1.athleteId, b.map['33'].qb1.athleteId);
  });

  const billsFeed = feedPack([{
    teamId: '2',
    abbr: 'BUF',
    displayName: 'Buffalo Bills',
    qb1: { name: 'Josh Allen', athleteId: '3918298' },
    qb2: { name: 'Kyle Allen', athleteId: '3115293' },
    source: depth.SOURCE,
    fetchedAt: '2026-10-11T18:42:38Z',
  }]);
  const qb1 = adjust({
    qbByTeam: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Not The Printed Name', athleteId: '3918298' } },
    depthByTeam: billsFeed,
  });
  assert.strictEqual(qb1.startingQbOut, true);
  assert.ok(Math.abs(qb1.gameDay.qbMarginAdj + config.QB_INJURY.NFL.outMarginPts) < 1e-9, qb1.gameDay.qbMarginAdj);
  assert.ok(Math.abs(qb1.gameDay.qbTotalAdj - config.QB_INJURY.NFL.outTotalPts) < 1e-9, qb1.gameDay.qbTotalAdj);
  assert.strictEqual(qb1.gameDay.qbBackupDelta[0].source, 'table');

  const byName = adjust({
    qbByTeam: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh  Allen' } },
    depthByTeam: billsFeed,
  });
  assert.strictEqual(byName.startingQbOut, true);
  assert.ok(byName.modelMargin < 3);

  const qb2 = adjust({
    qbByTeam: {
      'Buffalo Bills': { qbStatus: 'out', qbName: 'Kyle Allen', athleteId: '3115293', depthChartRank: 1 },
    },
    depthByTeam: billsFeed,
  });
  assert.strictEqual(qb2.startingQbOut, false);
  assert.strictEqual(qb2.modelMargin, 3);
  assert.strictEqual(qb2.modelTotal, 45);
  assert.strictEqual(qb2.gameDay.qbMarginAdj, 0);

  const ravensQb2 = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 0,
    modelTotal: 45,
    uncertainty: 0.13,
    home: 'Atlanta Falcons',
    away: 'Baltimore Ravens',
    restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'out', qbName: 'Lamar Jackson', athleteId: '3916387' } },
    depthByTeam: feedPack([{
      teamId: '33',
      abbr: 'BAL',
      displayName: 'Baltimore Ravens',
      qb1: { name: 'Tyler Huntley', athleteId: '4035671' },
      qb2: { name: 'Lamar Jackson', athleteId: '3916387' },
      source: depth.SOURCE,
      fetchedAt: '2026-10-11T18:42:38Z',
    }]),
  });
  assert.strictEqual(ravensQb2.startingQbOut, false, 'named list does not override a chart that lists him QB2');
  assert.strictEqual(ravensQb2.gameDay.qbMarginAdj, 0);

  const named = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 0,
    modelTotal: 52.28,
    uncertainty: 0.18,
    home: 'Atlanta Falcons',
    away: 'Baltimore Ravens',
    restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'out', qbName: 'Lamar Jackson' } },
    depthByTeam: { map: {}, source: 'fallback', teams: [], fallbackTeams: ['33'] },
  });
  assert.strictEqual(named.startingQbOut, true);
  assert.ok(Math.abs(named.gameDay.qbMarginAdj - 4.5) < 1e-9, named.gameDay.qbMarginAdj);
  assert.strictEqual(named.gameDay.qbBackupDelta[0].source, 'named');

  const notNamed = gd.backupQbDelta({ qbStatus: 'out', qbName: 'Tyler Huntley' }, 'NFL', null);
  assert.strictEqual(notNamed, null);

  const cfbQb1 = gd.applyGameDayAdjustments({
    sport: 'NCAAF',
    modelMargin: 6,
    modelTotal: 52,
    uncertainty: 0.2,
    home: 'Auburn Tigers',
    away: 'Alabama Crimson Tide',
    restByTeam: {},
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'out', qbName: 'Payton Thorne' } },
    depthByTeam: {
      map: {
        '2': {
          teamId: '2',
          abbr: 'AUB',
          displayName: 'Auburn Tigers',
          qb1: { name: 'Payton Thorne', athleteId: '100' },
          qb2: { name: 'Backup Tiger', athleteId: '101' },
          source: depth.SOURCE,
          fetchedAt: '2026-10-11T18:41:25Z',
        },
      },
    },
  });
  assert.strictEqual(cfbQb1.startingQbOut, true);
  assert.ok(Math.abs(cfbQb1.gameDay.qbMarginAdj + config.QB_INJURY.NCAAF.outMarginPts) < 1e-9);
  const cfbQb2 = gd.applyGameDayAdjustments({
    sport: 'NCAAF',
    modelMargin: 6,
    modelTotal: 52,
    uncertainty: 0.2,
    home: 'Auburn Tigers',
    away: 'Alabama Crimson Tide',
    restByTeam: {},
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'out', qbName: 'Backup Tiger', depthChartRank: 1 } },
    depthByTeam: cfbQb1 && {
      map: {
        '2': {
          teamId: '2',
          abbr: 'AUB',
          qb1: { name: 'Payton Thorne', athleteId: '100' },
          qb2: { name: 'Backup Tiger', athleteId: '101' },
          source: depth.SOURCE,
          fetchedAt: '2026-10-11T18:41:25Z',
        },
      },
    },
  });
  assert.strictEqual(cfbQb2.startingQbOut, false);
  assert.strictEqual(cfbQb2.modelMargin, 6);

  function synth(home, away) {
    return {
      home_team: home,
      away_team: away,
      commence_time: '2026-10-11T17:00:00Z',
      bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
        key,
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
          { key: 'spreads', outcomes: [
            { name: home, price: -110, point: -3.5 },
            { name: away, price: -110, point: 3.5 },
          ] },
          { key: 'totals', outcomes: [
            { name: 'Over', price: -110, point: 45.5 },
            { name: 'Under', price: -110, point: 45.5 },
          ] },
        ],
      })),
    };
  }
  const event = synth('Buffalo Bills', 'Miami Dolphins');
  const priced = nfl.project({
    oddsEvents: [event],
    standings: {},
    efficiency: {},
    gameDay: {
      qbStatusBySport: { NFL: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh Allen' } } },
      depthCharts: { NFL: billsFeed },
    },
  });
  assert.ok(priced.some((c) => c.startingQbOut === true));
  const bare = nfl.project({
    oddsEvents: [event],
    standings: {},
    efficiency: {},
    gameDay: {
      qbStatusBySport: { NFL: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Josh Allen' } } },
    },
  });
  assert.ok(bare.every((c) => !c.startingQbOut));
  const backupCard = nfl.project({
    oddsEvents: [event],
    standings: {},
    efficiency: {},
    gameDay: {
      qbStatusBySport: { NFL: { 'Buffalo Bills': { qbStatus: 'out', qbName: 'Kyle Allen', depthChartRank: 1 } } },
      depthCharts: { NFL: billsFeed },
    },
  });
  assert.ok(backupCard.every((c) => !c.startingQbOut));

  const withId = late.parseFootballQbMap({
    injuries: [{
      displayName: 'Buffalo Bills',
      injuries: [{
        status: 'Out',
        athlete: { id: '3918298', displayName: 'Josh Allen', position: { abbreviation: 'QB' } },
      }],
    }],
  });
  assert.strictEqual(withId['Buffalo Bills'].athleteId, '3918298');

  const stamp = depth.starterFeedStamp({
    NFL: fetched,
    NCAAF: college,
  });
  assert.strictEqual(stamp.source, depth.SOURCE);
  assert.ok(stamp.teams.includes('NFL:33'));
  assert.ok(stamp.fallbackTeams.includes('NCAAF:2'));
  assert.ok(stamp.fallbackTeams.includes('NCAAF:333'));
  const cardFeed = depth.cardStarterFeed({ gameDay: { starterFeed: stamp } });
  assert.deepStrictEqual(Object.keys(cardFeed).sort(), ['fallbackTeams', 'source', 'teams']);
  assert.strictEqual(cardFeed.source, depth.SOURCE);
  assert.deepStrictEqual(depth.cardStarterFeed({}), {
    source: 'fallback', teams: [], fallbackTeams: [],
  });

  const prevWx = process.env.OMEGA_FB_WEATHER;
  const prevRest = process.env.OMEGA_REST_SCHEDULE_DIR;
  const prevFetch = global.fetch;
  const restDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-rest-'));
  process.env.OMEGA_FB_WEATHER = '0';
  process.env.OMEGA_REST_SCHEDULE_DIR = restDir;
  const urls = [];
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (!u.includes('/depthcharts')) return jsonResponse({ events: [], injuries: [], teams: [] });
    if (u.includes('/football/nfl/teams/33/')) return jsonResponse(RAVENS);
    if (u.includes('/football/nfl/teams/1/')) {
      return jsonResponse(chart('1', 'ATL', 'Atlanta Falcons',
        { id: '4241478', name: 'Michael Penix Jr.' },
        { id: '9', name: 'Backup Falcon' }));
    }
    if (u.includes('/college-football/')) return jsonResponse(AUBURN);
    throw new Error(`unexpected depth url ${u}`);
  };
  try {
    const gameDay = await ingest.loadGameDayContext('2026-10-11', ['NFL', 'NCAAF'], {
      NFL: { games: [{ homeId: '33', awayId: '1', homeTeam: 'Baltimore Ravens', awayTeam: 'Atlanta Falcons' }] },
      NCAAF: { games: [{ homeId: '2', awayId: '333', homeTeam: 'Auburn Tigers', awayTeam: 'Alabama Crimson Tide' }] },
    });
    const depthUrls = urls.filter((u) => u.includes('/depthcharts'));
    assert.deepStrictEqual(depthUrls.sort(), [
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/2/depthcharts',
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/1/depthcharts',
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/33/depthcharts',
    ]);
    assert.strictEqual(gameDay.depthCharts.NFL.map['33'].qb1.name, 'Lamar Jackson');
    assert.strictEqual(gameDay.depthCharts.NFL.map['1'].qb1.name, 'Michael Penix Jr.');
    assert.strictEqual(gameDay.depthCharts.NCAAF.source, 'fallback');
    assert.strictEqual(gameDay.starterFeed.source, depth.SOURCE);
    assert.ok(gameDay.starterFeed.teams.includes('NFL:33'));
    assert.ok(gameDay.starterFeed.teams.includes('NFL:1'));
    assert.ok(gameDay.starterFeed.fallbackTeams.includes('NCAAF:2'));
    assert.ok(gameDay.starterFeed.fallbackTeams.includes('NCAAF:333'));
    assert.ok(!depthUrls.some((u) => u.includes('/teams/99/')));
  } finally {
    global.fetch = prevFetch;
    if (prevWx == null) delete process.env.OMEGA_FB_WEATHER;
    else process.env.OMEGA_FB_WEATHER = prevWx;
    if (prevRest == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
    else process.env.OMEGA_REST_SCHEDULE_DIR = prevRest;
    fs.rmSync(restDir, { recursive: true, force: true });
  }

  const snapPath = path.join(os.tmpdir(), `omega-depth-frozen-${process.pid}.json`);
  const prevSnap = process.env.OMEGA_FROZEN_SNAP;
  fs.writeFileSync(snapPath, JSON.stringify({
    oddsBySport: { NFL: [], NCAAF: [] },
    espnBySport: {},
    standingsBySport: {},
    gameDay: { restByTeam: { NFL: {} }, qbStatusBySport: { NFL: {}, NCAAF: {} } },
    fetchedAt: '2026-10-11T14:00:00.000Z',
  }));
  process.env.OMEGA_FROZEN_SNAP = snapPath;
  const prevFetch2 = global.fetch;
  const frozenUrls = [];
  global.fetch = async (url) => {
    frozenUrls.push(String(url));
    if (String(url).includes('depthcharts')) throw new Error('frozen snap fetched a depth chart');
    return jsonResponse({}, 500);
  };
  try {
    let frozenCalls = 0;
    const blocked = await depth.fetchDepthCharts({
      sport: 'NFL',
      teamIds: ['33', '1'],
      date: '2026-10-11',
      fetchImpl: async () => {
        frozenCalls += 1;
        throw new Error('fetchImpl on frozen snap');
      },
    });
    assert.strictEqual(frozenCalls, 0);
    assert.deepStrictEqual(blocked.map, {});
    assert.strictEqual(blocked.reason, 'frozen-snap-no-depth');
    assert.strictEqual(blocked.source, 'fallback');
    assert.deepStrictEqual(blocked.fallbackTeams, ['33', '1']);

    const emptyRest = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-frozen-rest-'));
    const prevRest2 = process.env.OMEGA_REST_SCHEDULE_DIR;
    process.env.OMEGA_REST_SCHEDULE_DIR = emptyRest;
    try {
      const frozen = await ingest.ingest('2026-10-11');
      assert.strictEqual(frozen.snapshotNote, 'frozen-replay');
      assert.strictEqual(frozen.gameDay.starterFeed.source, 'fallback');
      assert.strictEqual(frozen.gameDay.starterFeed.reason, 'frozen-snap-no-depth');
      assert.deepStrictEqual(frozen.gameDay.starterFeed.teams, []);
      assert.ok(frozenUrls.every((u) => !u.includes('depthcharts')));
    } finally {
      if (prevRest2 == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
      else process.env.OMEGA_REST_SCHEDULE_DIR = prevRest2;
      fs.rmSync(emptyRest, { recursive: true, force: true });
    }

    const storedPath = path.join(os.tmpdir(), `omega-depth-frozen-hit-${process.pid}.json`);
    const row = parsed.row;
    fs.writeFileSync(storedPath, JSON.stringify({
      gameDay: {
        depthCharts: {
          NFL: { map: { '33': row }, source: depth.SOURCE, teams: ['33'], fallbackTeams: [] },
        },
      },
    }));
    process.env.OMEGA_FROZEN_SNAP = storedPath;
    let storedCalls = 0;
    const stored = await depth.fetchDepthCharts({
      sport: 'NFL',
      teamIds: ['33'],
      date: '2026-10-11',
      fetchImpl: async () => {
        storedCalls += 1;
        throw new Error('stored snap must not fetch');
      },
    });
    assert.strictEqual(storedCalls, 0);
    assert.strictEqual(stored.map['33'].qb1.name, 'Lamar Jackson');
    assert.strictEqual(stored.frozen, true);
    fs.unlinkSync(storedPath);
  } finally {
    global.fetch = prevFetch2;
    if (prevSnap == null) delete process.env.OMEGA_FROZEN_SNAP;
    else process.env.OMEGA_FROZEN_SNAP = prevSnap;
    try { delete require.cache[require.resolve(snapPath)]; } catch (e) { /* temp */ }
    fs.unlinkSync(snapPath);
  }

  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('starterFeed: cardStarterFeed(snap)'));

  console.log('PASS test-omega-depth-chart');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
