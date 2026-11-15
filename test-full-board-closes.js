'use strict';

/**
 * Full-board closing capture and candidate true-close CLV.
 * Fetch, blobs, and the odds-master index are fakes. No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cap = require('./netlify/functions/capture-pick-closes');
const FB = require('./netlify/functions/lib/full-board-closes');
const S = require('./netlify/functions/lib/clv-supabase');
const { noVigTwoWay, americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
const {
  upgradeCandidateTrueCloses,
  upgradeDatesFromStore,
  applyTrueClose,
  summarizeCandidateTrueClose,
  closeSourceLabel,
} = require('./netlify/functions/lib/clv-true-close');

const API_KEY = 'odds-key-do-not-leak';
const NOW = new Date('2026-11-14T23:55:00Z');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests/fixtures/full-board-closes/candidate-close.json'), 'utf8'));

function roundTo(n, places) {
  return Number(n.toFixed(places));
}

function memBlobs(data) {
  const store = new Map(Object.entries(data || {}));
  return {
    writes: [],
    async get(s, k) {
      const v = store.get(`${s}:${k}`);
      return v === undefined ? null : v;
    },
    async set(s, k, v) {
      this.writes.push([s, k]);
      store.set(`${s}:${k}`, v);
    },
    dump(prefix) {
      const out = {};
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out[k] = v;
      }
      return out;
    },
  };
}

function hdr(map) {
  const lower = {};
  for (const [k, v] of Object.entries(map || {})) lower[String(k).toLowerCase()] = String(v);
  return { get: (name) => (name && lower[String(name).toLowerCase()] != null ? lower[String(name).toLowerCase()] : null) };
}

function oddsEvent(id, commence, home, away) {
  return {
    id,
    commence_time: commence,
    home_team: home,
    away_team: away,
    bookmakers: [
      {
        key: 'pinnacle',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] },
          { key: 'spreads', outcomes: [{ name: home, price: -110, point: -3.5 }, { name: away, price: -110, point: 3.5 }] },
          { key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 45.5 }, { name: 'Under', price: -115, point: 45.5 }] },
        ],
      },
      {
        key: 'draftkings',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'spreads', outcomes: [{ name: home, price: -108, point: -3.5 }, { name: away, price: -112, point: 3.5 }] },
        ],
      },
      {
        key: 'hardrockbet',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: -148 }, { name: away, price: 128 }] },
        ],
      },
      {
        key: 'hardrockbet_fl',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: -145 }, { name: away, price: 125 }] },
        ],
      },
      {
        key: 'hardrockbet_oh',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'spreads', outcomes: [{ name: home, price: -110, point: -3 }, { name: away, price: -110, point: 3 }] },
        ],
      },
      {
        key: 'fanduel',
        last_update: '2026-11-14T23:54:00Z',
        markets: [
          { key: 'h2h', outcomes: [{ name: home, price: -140 }, { name: away, price: 120 }] },
        ],
      },
    ],
  };
}

function boardDoc(events) {
  return { events };
}

function slate() {
  return {
    'by-date/2026-11-14': boardDoc([
      { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
      { sport: 'NBA', eventId: 'nba-2', homeTeam: 'Miami Heat', awayTeam: 'Charlotte Hornets', commenceTime: '2026-11-15T00:02:00Z' },
      { sport: 'NHL', eventId: 'nhl-1', homeTeam: 'Rangers', awayTeam: 'Devils', commenceTime: '2026-11-15T00:01:00Z' },
      { sport: 'NCAAM', eventId: 'ncaam-1', homeTeam: 'Duke Blue Devils', awayTeam: 'Wake Forest', commenceTime: '2026-11-14T23:57:00Z' },
      { sport: 'NFL', eventId: 'nfl-late', homeTeam: 'Late Home', awayTeam: 'Late Away', commenceTime: '2026-11-15T00:10:00Z' },
      { sport: 'MLB', eventId: 'mlb-1', homeTeam: 'Yankees', awayTeam: 'Red Sox', commenceTime: '2026-11-15T00:00:00Z' },
    ]),
    'by-date/2026-11-13': boardDoc([
      { sport: 'NCAAF', eventId: 'ncaaf-1', homeTeam: 'Alabama', awayTeam: 'Auburn', commenceTime: '2026-11-15T00:00:30.000Z' },
      { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
    ]),
  };
}

function oddsBySport() {
  const home = {
    'nba-1': ['Boston Bruins', 'Toronto Maple Leafs', '2026-11-15T00:00:00Z'],
    'nba-2': ['Miami Heat', 'Charlotte Hornets', '2026-11-15T00:02:00Z'],
    'nhl-1': ['Rangers', 'Devils', '2026-11-15T00:01:00Z'],
    'ncaam-1': ['Duke Blue Devils', 'Wake Forest', '2026-11-14T23:57:00Z'],
    'ncaaf-1': ['Alabama', 'Auburn', '2026-11-15T00:00:30Z'],
  };
  const byKey = {
    basketball_nba: ['nba-1', 'nba-2'],
    icehockey_nhl: ['nhl-1'],
    basketball_ncaab: ['ncaam-1'],
    americanfootball_ncaaf: ['ncaaf-1'],
  };
  const bodies = {};
  for (const [key, ids] of Object.entries(byKey)) {
    bodies[key] = ids.map((id) => oddsEvent(id, home[id][2], home[id][0], home[id][1]));
  }
  return bodies;
}

function env(extra) {
  return Object.assign({
    ODDS_API_KEY: API_KEY,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    NETLIFY_AUTH_TOKEN: 'netlify-token',
  }, extra || {});
}

function installFetch(bodies, headersFor) {
  const calls = [];
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('the-odds-api.com')) {
      calls.push(u);
      assert.ok(!u.includes('netlify-token'), 'auth token leaked onto the odds URL');
      const sportKey = u.split('/sports/')[1].split('/odds')[0];
      const body = (bodies && bodies[sportKey]) || [];
      const last = headersFor ? headersFor(u) : '3';
      const raw = JSON.stringify(body);
      return {
        ok: true,
        status: 200,
        headers: hdr({
          'x-requests-last': last,
          'x-requests-remaining': '400',
          'x-requests-used': '50',
        }),
        text: async () => raw,
        json: async () => JSON.parse(raw),
      };
    }
    posts.push({ url: u, body: opts.body, headers: opts.headers });
    return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
  };
  return { calls, posts, fetchImpl };
}

async function run(opts) {
  const blobs = opts.blobs || memBlobs(opts.seed || {});
  const readerLog = [];
  const readBoard = async (key) => {
    readerLog.push(key);
    if (opts.readBoard) return opts.readBoard(key);
    const boards = opts.boards || slate();
    return boards[key] || null;
  };
  const net = opts.net || installFetch(opts.bodies || oddsBySport(), opts.headersFor);
  const res = await cap.handle({}, opts.now || NOW, {
    env: env(opts.env),
    blobs,
    fetch: net.fetchImpl,
    readBoard: opts.noBoard ? undefined : readBoard,
  });
  const body = JSON.parse(res.body);
  return { res, body, blobs, net, readerLog };
}

function oddsCalls(net) {
  return net.calls.filter((u) => u.includes('the-odds-api.com'));
}

function params(url) {
  return new URL(url).searchParams;
}

(async () => {
  assert.strictEqual(FB.fullBoardEnabled({}), true);
  assert.strictEqual(FB.fullBoardEnabled({ OMEGA_FULL_BOARD_CLOSES: 'off' }), false);
  assert.strictEqual(FB.fullBoardEnabled({ OMEGA_FULL_BOARD_CLOSES: '0' }), false);
  assert.strictEqual(FB.fullBoardEnabled({ OMEGA_FULL_BOARD_CLOSES: 'false' }), false);
  assert.strictEqual(cap.DAILY_CAP, 100);
  const capSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-pick-closes.js'), 'utf8');
  assert.ok(!capSrc.includes('CLOSE_CAPTURE_DAILY_CAP'));
  assert.ok(capSrc.includes('const DAILY_CAP = 100'));

  const edgeNow = NOW;
  const grouped = FB.dueBoardEvents([
    { sport: 'NBA', eventId: 'in-min', commenceTime: '2026-11-14T23:57:00Z' },
    { sport: 'NBA', eventId: 'in-max', commenceTime: '2026-11-15T00:03:00Z' },
    { sport: 'NBA', eventId: 'too-soon', commenceTime: '2026-11-14T23:56:59Z' },
    { sport: 'NBA', eventId: 'too-late', commenceTime: '2026-11-15T00:03:01Z' },
    { sport: 'MLB', eventId: 'mlb', commenceTime: '2026-11-15T00:00:00Z' },
    { sport: 'nba', eventId: 'lower', commenceTime: '2026-11-15T00:00:00Z' },
    { sport: 'NFL', eventId: 'dup', commenceTime: '2026-11-15T00:00:00Z' },
    { sport: 'NFL', eventId: 'dup', commenceTime: '2026-11-15T00:00:00.000Z' },
  ], edgeNow, cap.WINDOW_MIN, cap.WINDOW_MAX);
  assert.deepStrictEqual(grouped.map((ev) => ev.eventId), ['in-min', 'in-max', 'lower', 'dup']);
  assert.ok(grouped.every((ev) => ev.sport === ev.sport.toUpperCase()));
  const bySport = FB.groupBySport(grouped);
  assert.strictEqual(bySport.get('NBA').length, 3);
  assert.strictEqual(bySport.get('NFL').length, 1);
  assert.strictEqual(bySport.has('MLB'), false);
  const nbaBounds = FB.commenceBounds(bySport.get('NBA'));
  assert.strictEqual(nbaBounds.from, '2026-11-14T23:56:00Z');
  assert.strictEqual(nbaBounds.to, '2026-11-15T00:04:00Z');

  const first = await run({});
  assert.strictEqual(first.body.ok, true);
  assert.deepStrictEqual(first.readerLog, ['by-date/2026-11-14', 'by-date/2026-11-13']);
  const calls = oddsCalls(first.net);
  assert.strictEqual(calls.length, 4, calls.join('\n'));
  const sports = calls.map((u) => u.split('/sports/')[1].split('/odds')[0]);
  assert.deepStrictEqual(sports.slice().sort(), [
    'americanfootball_ncaaf',
    'basketball_nba',
    'basketball_ncaab',
    'icehockey_nhl',
  ]);
  assert.strictEqual(calls.filter((u) => u.includes('basketball_nba')).length, 1);
  assert.ok(!calls.some((u) => u.includes('baseball_mlb')));
  assert.ok(!calls.some((u) => u.includes('americanfootball_nfl')));

  const nbaUrl = calls.find((u) => u.includes('basketball_nba'));
  const nbaQs = params(nbaUrl);
  assert.strictEqual(nbaQs.get('regions'), 'us');
  assert.strictEqual(nbaQs.get('markets'), 'h2h,spreads,totals');
  assert.strictEqual(nbaQs.get('bookmakers'), 'pinnacle,draftkings,hardrockbet,hardrockbet_fl,hardrockbet_oh');
  assert.strictEqual(nbaQs.get('oddsFormat'), 'american');
  assert.strictEqual(nbaQs.get('dateFormat'), 'iso');
  assert.strictEqual(nbaQs.get('commenceTimeFrom'), '2026-11-14T23:59:00Z');
  assert.strictEqual(nbaQs.get('commenceTimeTo'), '2026-11-15T00:03:00Z');
  assert.strictEqual(nbaQs.get('apiKey'), API_KEY);

  const ncaamUrl = calls.find((u) => u.includes('basketball_ncaab'));
  assert.strictEqual(params(ncaamUrl).get('commenceTimeFrom'), '2026-11-14T23:56:00Z');
  assert.strictEqual(params(ncaamUrl).get('commenceTimeTo'), '2026-11-14T23:58:00Z');
  const ncaafUrl = calls.find((u) => u.includes('americanfootball_ncaaf'));
  assert.strictEqual(params(ncaafUrl).get('commenceTimeFrom'), '2026-11-14T23:59:30Z');
  assert.strictEqual(params(ncaafUrl).get('commenceTimeTo'), '2026-11-15T00:01:30Z');

  assert.strictEqual(first.body.fullBoard.enabled, true);
  assert.strictEqual(first.body.fullBoard.calls, 4);
  assert.strictEqual(first.body.fullBoard.events, 5);
  assert.strictEqual(first.body.fullBoard.skippedDone, 0);
  assert.strictEqual(first.body.fullBoard.budgetBlocked, 0);
  assert.deepStrictEqual(first.body.fullBoard.dueSports.slice().sort(), ['NBA', 'NCAAF', 'NCAAM', 'NHL']);

  const snapPosts = first.net.posts.filter((p) => p.url.includes('/odds_snapshots'));
  assert.ok(snapPosts.length >= 1);
  const snapRows = snapPosts.flatMap((p) => JSON.parse(p.body));
  assert.ok(snapRows.length > 0);
  assert.ok(snapRows.every((row) => row.line_type === 'closing'));
  assert.ok(snapRows.every((row) => row.source === 'oddsapi-live:capture-all-closes'));
  assert.ok(snapRows.some((row) => row.book === 'hardrockbet_fl'));
  assert.ok(snapRows.some((row) => row.book === 'hardrockbet_oh'));
  assert.ok(snapRows.some((row) => row.book === 'pinnacle' && row.market === 'totals'));
  assert.ok(!snapRows.some((row) => row.book === 'fanduel'));
  const gamePost = first.net.posts.find((p) => p.url.includes('/games'));
  assert.ok(gamePost.url.includes('on_conflict=game_id'));
  assert.ok(snapPosts[0].url.includes('on_conflict='));

  const rawKeys = Object.keys(first.blobs.dump('clv-close-capture:raw/'));
  assert.strictEqual(rawKeys.length, 4);
  for (const key of rawKeys) {
    assert.match(key, /^clv-close-capture:raw\/2026-11-14\/(NBA|NHL|NCAAM|NCAAF)\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.json$/);
    const doc = first.blobs.dump()[key];
    assert.strictEqual(doc.meta.url.includes(API_KEY), false);
    assert.strictEqual(new URL(doc.meta.url).searchParams.get('apiKey'), null);
    assert.ok(doc.meta.fetchedAt);
    assert.ok(Array.isArray(doc.meta.eventIds) && doc.meta.eventIds.length >= 1);
    assert.strictEqual(doc.meta.headers['x-requests-last'], '3');
    assert.strictEqual(doc.meta.headers['x-requests-remaining'], '400');
    assert.strictEqual(doc.meta.headers['x-requests-used'], '50');
    const sportKey = S.ODDS_SPORT_KEYS[doc.meta.sport];
    assert.deepStrictEqual(doc.body, oddsBySport()[sportKey]);
  }
  const credits = first.blobs.dump()['clv-close-capture:credits/2026-11-14'];
  assert.strictEqual(credits.used, 12);
  assert.strictEqual(credits.usedActual, 12);
  assert.strictEqual(credits.calls.length, 4);
  for (const call of credits.calls) {
    assert.strictEqual(call.path, 'full-board');
    assert.strictEqual(call.estCost, 3);
    assert.strictEqual(call.actualCost, 3);
    assert.ok(call.at && call.sport && call.nEvents >= 1);
    assert.strictEqual(call.used, credits.calls.indexOf(call) * 3 + 3);
    assert.ok(call.remaining != null);
    assert.strictEqual(JSON.stringify(call).includes(API_KEY), false);
  }
  const stored = JSON.stringify(first.blobs.dump('clv-close-capture:'));
  assert.strictEqual(stored.includes(API_KEY), false);
  assert.strictEqual(JSON.stringify(first.body).includes(API_KEY), false);
  assert.ok(first.blobs.dump()['clv-close-capture:done-ev/NBA/nba-1']);
  assert.ok(first.blobs.dump()['clv-close-capture:done-ev/NBA/nba-2']);
  assert.ok(first.blobs.dump()['clv-close-capture:done/NBA/2026-11-15T00:00:00Z/h2h']);
  assert.ok(first.blobs.dump()['clv-close-capture:done/NBA/2026-11-15T00:00:00Z/spreads']);
  assert.ok(first.blobs.dump()['clv-close-capture:done/NBA/2026-11-15T00:00:00Z/totals']);
  const firstDoneKeys = first.blobs.writes
    .filter((pair) => pair[1].startsWith('done/') || pair[1].startsWith('done-ev/'))
    .map((pair) => pair[1]);
  assert.strictEqual(firstDoneKeys.length, new Set(firstDoneKeys).size, 'each done key is written once per call');

  const clusterKick = '2026-11-15T00:00:00Z';
  const cluster = await run({
    boards: {
      'by-date/2026-11-14': boardDoc([
        { sport: 'NCAAM', eventId: 'ncaam-a', homeTeam: 'Duke Blue Devils', awayTeam: 'Wake Forest', commenceTime: clusterKick },
        { sport: 'NCAAM', eventId: 'ncaam-b', homeTeam: 'North Carolina Tar Heels', awayTeam: 'NC State', commenceTime: clusterKick },
      ]),
      'by-date/2026-11-13': boardDoc([]),
    },
    bodies: {
      basketball_ncaab: [
        oddsEvent('ncaam-a', clusterKick, 'Duke Blue Devils', 'Wake Forest'),
        oddsEvent('ncaam-b', clusterKick, 'North Carolina Tar Heels', 'NC State'),
      ],
    },
  });
  const clusterDoneKeys = cluster.blobs.writes
    .filter((pair) => pair[1].startsWith('done/') || pair[1].startsWith('done-ev/'))
    .map((pair) => pair[1]);
  assert.deepStrictEqual(clusterDoneKeys.slice().sort(), [
    'done-ev/NCAAM/ncaam-a',
    'done-ev/NCAAM/ncaam-b',
    `done/NCAAM/${clusterKick}/h2h`,
    `done/NCAAM/${clusterKick}/spreads`,
    `done/NCAAM/${clusterKick}/totals`,
  ]);
  const clusterDump = cluster.blobs.dump();
  const clusterMarket = clusterDump[`clv-close-capture:done/NCAAM/${clusterKick}/h2h`];
  assert.strictEqual(clusterMarket.at, NOW.toISOString());
  assert.strictEqual(clusterMarket.via, 'full-board');
  assert.strictEqual(clusterMarket.events, 2);
  assert.ok(clusterMarket.posted && clusterMarket.posted.games === 2);
  assert.deepStrictEqual(clusterDump[`clv-close-capture:done/NCAAM/${clusterKick}/spreads`], clusterMarket);
  assert.deepStrictEqual(clusterDump[`clv-close-capture:done/NCAAM/${clusterKick}/totals`], clusterMarket);
  assert.deepStrictEqual(clusterDump['clv-close-capture:done-ev/NCAAM/ncaam-a'], {
    at: NOW.toISOString(), commenceTime: clusterKick,
  });
  assert.deepStrictEqual(clusterDump['clv-close-capture:done-ev/NCAAM/ncaam-b'], {
    at: NOW.toISOString(), commenceTime: clusterKick,
  });

  const second = await run({ blobs: first.blobs });
  assert.strictEqual(oddsCalls(second.net).length, 0);
  assert.strictEqual(second.body.fullBoard.calls, 0);
  assert.strictEqual(second.body.fullBoard.skippedDone, 5);
  assert.deepStrictEqual(second.body.fullBoard.dueSports, []);

  const partialBoards = slate();
  partialBoards['by-date/2026-11-14'] = boardDoc([
    { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
    { sport: 'NBA', eventId: 'nba-2', homeTeam: 'Miami Heat', awayTeam: 'Charlotte Hornets', commenceTime: '2026-11-15T00:02:00Z' },
    { sport: 'NHL', eventId: 'nhl-1', homeTeam: 'Rangers', awayTeam: 'Devils', commenceTime: '2026-11-15T00:01:00Z' },
  ]);
  partialBoards['by-date/2026-11-13'] = boardDoc([]);
  const seeded = memBlobs({
    'clv-close-capture:done-ev/NBA/nba-1': { at: 'x' },
    'clv-close-capture:done-ev/NBA/nba-2': { at: 'x' },
  });
  const onlyNhl = await run({ blobs: seeded, boards: partialBoards });
  assert.deepStrictEqual(oddsCalls(onlyNhl.net).map((u) => u.split('/sports/')[1].split('/')[0]), ['icehockey_nhl']);
  assert.strictEqual(onlyNhl.body.fullBoard.skippedDone, 2);
  assert.deepStrictEqual(onlyNhl.body.fullBoard.dueSports, ['NHL']);

  const card = {
    picks: [
      {
        sport: 'NBA', matchup: 'Toronto Maple Leafs @ Boston Bruins', pick: 'Boston Bruins -3.5',
        betType: 'Spread', commenceTime: '2026-11-15T00:00:00Z',
      },
      {
        sport: 'NFL', matchup: 'Away @ Home Not On Board', pick: 'Home -2.5',
        betType: 'Spread', commenceTime: '2026-11-15T00:01:00Z',
      },
    ],
  };
  const dedupe = await run({
    seed: { 'edge-picks-omega:picks-2026-11-14': card },
    boards: {
      'by-date/2026-11-14': boardDoc([
        { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
      ]),
      'by-date/2026-11-13': boardDoc([]),
    },
  });
  const dedupeCalls = oddsCalls(dedupe.net);
  assert.strictEqual(dedupeCalls.length, 2);
  assert.strictEqual(dedupeCalls.filter((u) => u.includes('basketball_nba')).length, 1);
  assert.strictEqual(params(dedupeCalls.find((u) => u.includes('basketball_nba'))).get('markets'), 'h2h,spreads,totals');
  const nflCall = dedupeCalls.find((u) => u.includes('americanfootball_nfl'));
  assert.ok(nflCall);
  assert.strictEqual(params(nflCall).get('markets'), 'spreads');
  assert.strictEqual(params(nflCall).get('bookmakers'), 'pinnacle,draftkings');
  assert.strictEqual(params(nflCall).get('regions'), 'us');
  assert.strictEqual(params(nflCall).get('dateFormat'), null);
  assert.strictEqual(dedupe.body.results.find((row) => row.sport === 'NBA').skipped, 'full-board');
  const again = await run({
    blobs: dedupe.blobs,
    boards: {
      'by-date/2026-11-14': boardDoc([
        { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
      ]),
      'by-date/2026-11-13': boardDoc([]),
    },
  });
  assert.strictEqual(oddsCalls(again.net).length, 0);
  assert.strictEqual(again.body.results.find((row) => row.sport === 'NBA').skipped, 'done');

  const tightCard = {
    picks: [
      {
        sport: 'NBA', matchup: 'Toronto Maple Leafs @ Boston Bruins', pick: 'Boston Bruins -3.5',
        betType: 'Spread', commenceTime: '2026-11-15T00:00:00Z',
      },
      {
        sport: 'NFL', matchup: 'Away @ Home Not On Board', pick: 'Over 44.5',
        betType: 'Total', commenceTime: '2026-11-15T00:01:00Z',
      },
    ],
  };
  const tightBoards = {
    'by-date/2026-11-14': boardDoc([
      { sport: 'NBA', eventId: 'nba-1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-11-15T00:00:00Z' },
      { sport: 'NHL', eventId: 'nhl-1', homeTeam: 'Rangers', awayTeam: 'Devils', commenceTime: '2026-11-15T00:01:00Z' },
    ]),
    'by-date/2026-11-13': boardDoc([]),
  };
  const tight = await run({
    seed: {
      'edge-picks-omega:picks-2026-11-14': tightCard,
      'clv-close-capture:credits/2026-11-14': { date: '2026-11-14', used: 98, usedActual: 98, calls: [] },
    },
    boards: tightBoards,
    headersFor: () => '1',
  });
  const tightCalls = oddsCalls(tight.net);
  assert.strictEqual(tightCalls.length, 2);
  assert.ok(tightCalls.every((u) => params(u).get('bookmakers') === 'pinnacle,draftkings'));
  assert.ok(!tightCalls.some((u) => u.includes('icehockey_nhl')));
  assert.ok(tight.body.fullBoard.budgetBlocked >= 1);
  assert.strictEqual(tight.body.fullBoard.calls, 0);
  const tightCredits = tight.blobs.dump()['clv-close-capture:credits/2026-11-14'];
  assert.strictEqual(tightCredits.used, 100);
  assert.strictEqual(tightCredits.usedActual, 100);
  assert.ok(tightCredits.calls.every((call) => call.path === 'card-leg' && call.estCost === 1 && call.actualCost === 1));

  const capped = await run({
    seed: {
      'edge-picks-omega:picks-2026-11-14': tightCard,
      'clv-close-capture:credits/2026-11-14': { date: '2026-11-14', used: 100, calls: [] },
    },
    boards: tightBoards,
  });
  assert.strictEqual(oddsCalls(capped.net).length, 0);
  assert.ok(capped.body.results.every((row) => row.skipped === 'cap'));
  assert.strictEqual(capped.body.creditsToday, 100);

  const actualHeavy = await run({
    boards: tightBoards,
    headersFor: () => '98',
    seed: { 'clv-close-capture:credits/2026-11-14': { date: '2026-11-14', used: 0, usedActual: 0, calls: [] } },
  });
  assert.strictEqual(oddsCalls(actualHeavy.net).length, 1);
  assert.strictEqual(actualHeavy.body.fullBoard.calls, 1);
  assert.strictEqual(actualHeavy.body.fullBoard.budgetBlocked, 1);
  const heavyCredits = actualHeavy.blobs.dump()['clv-close-capture:credits/2026-11-14'];
  assert.strictEqual(heavyCredits.used, 3);
  assert.strictEqual(heavyCredits.usedActual, 98);
  assert.ok(FB.spentCredits(heavyCredits) + FB.COST > cap.DAILY_CAP);

  const offBodies = oddsBySport();
  const off = await run({
    env: { OMEGA_FULL_BOARD_CLOSES: 'off' },
    seed: { 'edge-picks-omega:picks-2026-11-14': card },
    readBoard: () => { throw new Error('board read while flag off'); },
  });
  assert.strictEqual(off.readerLog.length, 0);
  const offCalls = oddsCalls(off.net);
  assert.strictEqual(offCalls.length, 2);
  assert.ok(offCalls.every((u) => params(u).get('bookmakers') === 'pinnacle,draftkings'));
  assert.ok(offCalls.every((u) => params(u).get('regions') === 'us'));
  assert.ok(!offCalls.some((u) => String(params(u).get('markets')).includes(',')));
  assert.strictEqual(off.body.fullBoard.enabled, false);
  assert.strictEqual(off.body.fullBoard.calls, 0);
  const nbaLeg = card.picks[0];
  const ct = new Date(nbaLeg.commenceTime).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const from = new Date(new Date(ct).getTime() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const to = new Date(new Date(ct).getTime() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expected = new URLSearchParams({
    apiKey: API_KEY, regions: 'us', markets: 'spreads', bookmakers: 'pinnacle,draftkings',
    oddsFormat: 'american', commenceTimeFrom: from, commenceTimeTo: to,
  });
  const expectedUrl = `https://api.the-odds-api.com/v4/sports/${S.ODDS_SPORT_KEYS.NBA}/odds?${expected}`;
  assert.strictEqual(offCalls.find((u) => u.includes('basketball_nba')), expectedUrl);
  assert.strictEqual(offBodies.basketball_nba.length, 2);

  const urls = [];
  const supa = async (url) => {
    const u = String(url);
    urls.push(u);
    assert.ok(!u.includes('the-odds-api.com'));
    if (u.includes('/odds_snapshots')) {
      assert.ok(u.includes('pinnacle'));
      assert.ok(u.includes('closing'));
      assert.ok(!u.includes('source=eq'));
      return { ok: true, status: 200, json: async () => FIX.snapshots };
    }
    if (u.includes('/games')) return { ok: true, status: 200, json: async () => FIX.games };
    throw new Error(`unexpected ${u}`);
  };
  const doc = {
    date: '2026-11-14',
    kept: 'yes',
    avgCLV: 0.1,
    candidates: JSON.parse(JSON.stringify(FIX.candidates)),
  };
  const beforeRows = JSON.parse(JSON.stringify(doc.candidates));
  const report = await upgradeCandidateTrueCloses(doc, { SUPABASE_SERVICE_ROLE_KEY: 'service-role' }, supa);
  assert.strictEqual(report.upgraded, 3);
  assert.strictEqual(doc.kept, 'yes');
  assert.strictEqual(doc.avgCLV, 0.1);
  doc.candidates.forEach((row, i) => {
    const prev = beforeRows[i];
    const { trueClose, ...rest } = row;
    assert.deepStrictEqual(rest, prev);
    if (prev.rowKey === 'nhl-miss') assert.strictEqual(trueClose, undefined);
  });

  function expectClose(row, sidePrice, oppPrice, source) {
    const fair = noVigTwoWay(sidePrice, oppPrice);
    const betImplied = roundTo(americanToImplied(row.betPrice), 6);
    const closeNoVig = roundTo(fair.p1, 6);
    const clvPp = roundTo((closeNoVig - betImplied) * 100, 2);
    const proportional = americanToImplied(sidePrice) / (americanToImplied(sidePrice) + americanToImplied(oppPrice));
    if (Math.abs(closeNoVig - proportional) > 1e-6) {
      assert.notStrictEqual(closeNoVig, roundTo(proportional, 6));
    }
    assert.deepStrictEqual(row.trueClose, {
      closeNoVig,
      clvPp,
      beatClose: clvPp > 0,
      closeTs: row.trueClose.closeTs,
      source,
    });
    assert.strictEqual(row.trueClose.closeNoVig, closeNoVig);
    assert.strictEqual(row.trueClose.clvPp, clvPp);
  }
  const ncaam = doc.candidates.find((row) => row.rowKey === 'ncaam-spread');
  const nbaTot = doc.candidates.find((row) => row.rowKey === 'nba-total');
  const nbaMl = doc.candidates.find((row) => row.rowKey === 'nba-ml');
  expectClose(ncaam, -105, -115, 'supabase:capture-all-closes');
  assert.strictEqual(ncaam.trueClose.closeTs, '2026-11-13T23:55:00Z');
  expectClose(nbaTot, -110, -110, 'supabase:capture-pick-closes');
  expectClose(nbaMl, -130, 110, 'supabase:capture-all-closes');
  assert.strictEqual(nbaTot.trueClose.closeNoVig, roundTo(noVigTwoWay(-110, -110).p1, 6));

  const scored = doc.candidates.filter((row) => row.trueClose && row.trueClose.clvPp != null);
  const pps = scored.map((row) => row.trueClose.clvPp);
  const mean = pps.reduce((sum, v) => sum + v, 0) / pps.length;
  const beats = scored.filter((row) => row.trueClose.beatClose).length;
  const ss = pps.reduce((sum, v) => sum + ((v - mean) ** 2), 0);
  const se = Math.sqrt((ss / (pps.length - 1)) / pps.length);
  const summary = summarizeCandidateTrueClose(doc.candidates);
  assert.deepStrictEqual(doc.candidateTrueCloseBySport, summary);
  assert.strictEqual(summary.NCAAM.n, 1);
  assert.strictEqual(summary.NCAAM.se, null);
  assert.strictEqual(summary.NBA.n, 2);
  assert.ok(summary.NBA.se != null);
  assert.strictEqual(summary.NHL, undefined);
  assert.strictEqual(summary.overall.n, 3);
  assert.strictEqual(summary.overall.meanClvPp, roundTo(mean, 2));
  assert.strictEqual(summary.overall.beatRate, roundTo(beats / pps.length, 4));
  assert.strictEqual(summary.overall.se, roundTo(se, 4));
  assert.deepStrictEqual(Object.keys(summary.overall).sort(), ['beatRate', 'meanClvPp', 'n', 'se']);

  const offDoc = { candidates: JSON.parse(JSON.stringify(FIX.candidates)) };
  let offFetches = 0;
  const offReport = await upgradeCandidateTrueCloses(offDoc, { OMEGA_CLV_TRUE_CLOSE: 'off' }, async () => { offFetches += 1; throw new Error('fetch'); });
  assert.strictEqual(offReport.skipped, 'flag-off');
  assert.strictEqual(offFetches, 0);
  assert.strictEqual(offDoc.candidateTrueCloseBySport, undefined);
  assert.ok(offDoc.candidates.every((row) => row.trueClose == null));

  const ledger = {
    date: '2026-11-14',
    picks: [{
      pick: 'Duke Blue Devils +3.5',
      matchup: 'Duke Blue Devils @ North Carolina Tar Heels',
      sport: 'NCAAM',
      betType: 'Spread',
      line: 3.5,
      commenceTime: '2026-11-14T00:00:00Z',
      captureMinsToCommence: 90,
      pickTimeNoVig: 0.5,
      closingOdds: '-110',
      closingNoVig: 0.5,
      clv: 0,
      clvCents: 0,
      beatClosing: false,
      closeSnapshotAt: '2026-11-13T20:00:00Z',
      result: 'pending',
      profit: 0,
      units: '1u',
    }],
  };
  const ledgerReport = await applyTrueClose(ledger, { picks: [], parlayLegs: [] }, {
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    OMEGA_V2_PICK_CLV: 'off',
  }, supa);
  assert.strictEqual(ledgerReport.upgraded, 1);
  const fair = noVigTwoWay(-105, -115);
  assert.strictEqual(ledger.picks[0].closingNoVig, roundTo(fair.p1, 4));
  assert.strictEqual(ledger.picks[0].closeSource, 'supabase:capture-all-closes');
  assert.strictEqual(ledger.picks[0].result, 'pending');
  assert.strictEqual(closeSourceLabel('oddsapi-live:capture-pick-closes'), 'supabase:capture-pick-closes');
  assert.strictEqual(closeSourceLabel(undefined), 'supabase:capture-pick-closes');

  const storedDoc = {
    date: '2026-11-14',
    marker: 'keep',
    picks: [],
    candidates: JSON.parse(JSON.stringify(FIX.candidates)),
  };
  const memory = new Map();
  const dates = await upgradeDatesFromStore(['2026-11-14'], {
    env: { SUPABASE_SERVICE_ROLE_KEY: 'service-role', OMEGA_V2_PICK_CLV: 'off' },
    fetchImpl: supa,
    readClv: async () => JSON.parse(JSON.stringify(storedDoc)),
    readPicks: async () => ({ picks: [], parlayLegs: [] }),
    writeClv: async (date, data) => { memory.set(date, data); },
  });
  assert.strictEqual(dates[0].changed, true);
  assert.strictEqual(dates[0].wrote, true);
  assert.ok(dates[0].candidateTrueClose.upgraded >= 3);
  const written = memory.get('2026-11-14');
  assert.strictEqual(written.marker, 'keep');
  assert.strictEqual(written.candidates.length, FIX.candidates.length);
  assert.ok(written.candidateTrueCloseBySport.overall.n >= 3);
  assert.strictEqual(written.candidates.find((row) => row.rowKey === 'nhl-miss').trueClose, undefined);
  assert.strictEqual(written.candidates.find((row) => row.rowKey === 'ncaam-spread').closeSource, 'track-clv');

  console.log('PASS test-full-board-closes');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
