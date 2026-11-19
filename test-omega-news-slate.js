'use strict';

/**
 * OMEGA_NEWS_SLATE logs one per-game ESPN slate. Default on. Not a pick input.
 * Offline fixtures only. No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { newsSlateEnabled, newsSnapshotEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const { captureNewsSnapshot, newsBlobKey, NEWS_SNAPSHOT_STORE } = require('./netlify/functions/lib/omega-vnext/news_snapshot');
const {
  SLATE_BUDGET_MS,
  SLATE_CONCURRENCY,
  scoreboardUrlFor,
  newsSlateKey,
  lineupFromSummary,
  captureNewsSlate,
} = require('./netlify/functions/lib/omega-vnext/news_slate');
const { handle: captureHandle } = require('./netlify/functions/capture-news-slate-background');
const { handle: gradeHandle } = require('./netlify/functions/grade-boards-omega-background');

const DATE = '2026-11-19';
const NOW = '2026-11-19T15:00:00.000Z';
const KEY = '2026-11-19/games/1000-ET';
const LONG = 'x'.repeat(300);

function memoryBlobs() {
  const rows = new Map();
  return {
    rows,
    async setJSON(key, value) {
      rows.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function event(id, home, away, extra) {
  const homeComp = Object.assign({
    homeAway: 'home',
    team: { id: home.id, displayName: home.name },
  }, (extra && extra.home) || {});
  const awayComp = Object.assign({
    homeAway: 'away',
    team: { id: away.id, displayName: away.name },
  }, (extra && extra.away) || {});
  return {
    id,
    date: '2026-11-19T00:30:00.000Z',
    competitions: [{ competitors: [homeComp, awayComp] }],
  };
}

const BOARDS = {
  NBA: { events: [
    event('nba1', { id: '29', name: 'Memphis Grizzlies' }, { id: '9', name: 'Golden State Warriors' }),
    event('nba2', { id: '2', name: 'Boston Celtics' }, { id: '20', name: 'Philadelphia 76ers' }),
  ] },
  NHL: { events: [
    event('nhl1', { id: '21', name: 'Florida Panthers' }, { id: '10', name: 'Toronto Maple Leafs' }, {
      home: {
        probables: [{
          name: 'probableStartingGoalie',
          athlete: { displayName: 'Sergei Bobrovsky', position: 'G' },
          status: { type: 'confirmed', name: 'Confirmed' },
        }],
      },
      away: {
        probables: [{
          name: 'probableStartingGoalie',
          athlete: { displayName: 'Anthony Stolarz', position: 'G' },
          status: { type: 'expected', name: 'Expected' },
        }, {
          name: 'probableStartingSkater',
          athlete: { displayName: 'Auston Matthews', position: 'C' },
          status: { type: 'expected', name: 'Expected' },
        }],
      },
    }),
  ] },
  NCAAM: { events: [
    event('ncaam1', { id: '150', name: 'Duke Blue Devils' }, { id: '153', name: 'North Carolina Tar Heels' }),
  ] },
  NFL: { events: [
    event('nfl1', { id: '34', name: 'Houston Texans' }, { id: '11', name: 'Indianapolis Colts' }),
  ] },
  NCAAF: { events: [
    event('ncaaf1', { id: '218', name: 'Temple Owls' }, { id: '242', name: 'Rice Owls' }),
  ] },
};

const LEAGUES = {
  NBA: { injuries: [{
    id: '29',
    displayName: 'Memphis Grizzlies',
    injuries: [{
      status: 'Day-To-Day',
      shortComment: LONG,
      athlete: { displayName: 'Ja Morant', position: { abbreviation: 'PG' } },
    }],
  }] },
  NHL: { injuries: [] },
  NCAAM: { injuries: [] },
  NFL: { injuries: [
    {
      id: '34',
      displayName: 'Houston Texans',
      injuries: [{
        status: 'Out',
        shortComment: 'A receiver is out.',
        athlete: { displayName: 'Nico Collins', position: { abbreviation: 'WR' } },
      }],
    },
    {
      id: '11',
      displayName: 'Indianapolis Colts',
      injuries: [{
        status: 'Out',
        shortComment: 'Backup quarterback is out.',
        athlete: { displayName: 'Sam Ehlinger', position: { abbreviation: 'QB' } },
      }],
    },
  ] },
  NCAAF: { injuries: [] },
};

const SUMMARIES = {
  nba1: {
    injuries: [{
      team: { id: '29', displayName: 'Memphis Grizzlies' },
      injuries: [{
        status: 'Day-To-Day',
        athlete: { displayName: 'Ja Morant', position: { abbreviation: 'PG' } },
      }],
    }, {
      team: { id: '9', displayName: 'Golden State Warriors' },
      injuries: [],
    }],
  },
  nhl1: {
    goalies: {
      homeTeam: { athletes: [{ displayName: 'Someone Else' }] },
      awayTeam: { athletes: [{ displayName: 'Someone Else' }] },
    },
  },
  ncaam1: {
    rosters: [{
      homeAway: 'home',
      roster: [{ athlete: { displayName: 'Bench Player', position: { abbreviation: 'G' } } }],
    }],
  },
  nfl1: {
    injuries: [{
      team: { id: '34', displayName: 'Houston Texans' },
      injuries: [{
        status: 'Questionable',
        shortComment: 'Stroud (knee) is questionable.',
        athlete: { displayName: 'C.J. Stroud', position: { abbreviation: 'QB' } },
      }, {
        status: 'Out',
        shortComment: 'A receiver is out.',
        athlete: { displayName: 'Nico Collins', position: { abbreviation: 'WR' } },
      }],
    }],
    rosters: [{
      homeAway: 'home',
      team: { id: '34', displayName: 'Houston Texans' },
      roster: [
        { starter: true, athlete: { displayName: 'C.J. Stroud', position: { abbreviation: 'QB' } } },
        { starter: false, athlete: { displayName: 'Davis Mills', position: { abbreviation: 'QB' } } },
      ],
    }],
  },
  ncaaf1: {
    rosters: [
      {
        homeAway: 'home',
        team: { id: '218' },
        roster: [{ starter: true, athlete: { displayName: 'Temple QB', position: { abbreviation: 'QB' } } }],
      },
      {
        homeAway: 'away',
        team: { id: '242' },
        roster: [{ starter: true, athlete: { displayName: 'Rice QB', position: { abbreviation: 'QB' } } }],
      },
    ],
  },
};

const DEPTH = {
  '11': {
    depthchart: [{
      name: 'Offense',
      positions: { qb: { athletes: [{ displayName: 'Anthony Richardson' }, { displayName: 'Joe Flacco' }] } },
    }],
  },
};

function bodyFor(url) {
  const u = String(url);
  if (u.includes('/summary?event=')) {
    const id = u.split('event=')[1];
    if (id === 'nba2') return null;
    return SUMMARIES[id] || {};
  }
  if (u.includes('/depthcharts')) {
    const id = u.split('/teams/')[1].split('/')[0];
    return DEPTH[id] || { depthchart: [] };
  }
  if (u.includes('/scoreboard?')) {
    if (u.includes('/basketball/nba/')) return BOARDS.NBA;
    if (u.includes('/hockey/nhl/')) return BOARDS.NHL;
    if (u.includes('/mens-college-basketball/')) return BOARDS.NCAAM;
    if (u.includes('/football/nfl/')) return BOARDS.NFL;
    if (u.includes('/college-football/')) return BOARDS.NCAAF;
  }
  if (u.endsWith('/injuries')) {
    if (u.includes('/basketball/nba/')) return LEAGUES.NBA;
    if (u.includes('/hockey/nhl/')) return LEAGUES.NHL;
    if (u.includes('/mens-college-basketball/')) return LEAGUES.NCAAM;
    if (u.includes('/football/nfl/')) return LEAGUES.NFL;
    if (u.includes('/college-football/')) return LEAGUES.NCAAF;
  }
  return null;
}

function fakeFetch(calls, extra) {
  return (url) => {
    calls.push(String(url));
    if (extra) {
      const replaced = extra(url, calls);
      if (replaced) return replaced;
    }
    const body = bodyFor(url);
    if (!body) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => body });
  };
}

function baseOpts(overrides) {
  return Object.assign({
    env: { OMEGA_NEWS_SLATE: 'on' },
    dateISO: DATE,
    now: NOW,
    noWrite: true,
    timeoutMs: 5000,
    budgetMs: SLATE_BUDGET_MS,
    concurrency: SLATE_CONCURRENCY,
  }, overrides || {});
}

async function main() {
  assert.strictEqual(SLATE_BUDGET_MS, 60000);
  assert.strictEqual(SLATE_CONCURRENCY, 6);
  assert.strictEqual(newsSlateKey(DATE, NOW), KEY);
  assert.strictEqual(newsSlateEnabled({}), true);
  assert.strictEqual(newsSlateEnabled({ OMEGA_NEWS_SLATE: undefined }), true);
  for (const on of ['on', '1', 'true', 'yes', 'ON']) {
    assert.strictEqual(newsSlateEnabled({ OMEGA_NEWS_SLATE: on }), true, on);
  }
  for (const off of ['off', '0', 'false', '', '  ', 'no']) {
    assert.strictEqual(newsSlateEnabled({ OMEGA_NEWS_SLATE: off }), false, JSON.stringify(off));
  }
  assert.strictEqual(newsSlateEnabled({ OMEGA_NEWS_SNAPSHOT: 'off' }), true);
  assert.strictEqual(newsSnapshotEnabled({ OMEGA_NEWS_SLATE: 'off' }), true);

  const ncaamUrl = scoreboardUrlFor('NCAAM', DATE);
  const ncaafUrl = scoreboardUrlFor('NCAAF', DATE);
  assert.ok(ncaamUrl.includes('groups=50') && ncaamUrl.includes('limit=400'), ncaamUrl);
  assert.ok(ncaafUrl.includes('groups=80') && ncaafUrl.includes('limit=300'), ncaafUrl);
  assert.ok(!ncaafUrl.includes('groups=50'));
  assert.ok(!scoreboardUrlFor('NBA', DATE).includes('groups='));
  assert.ok(!scoreboardUrlFor('NHL', DATE).includes('groups='));
  assert.ok(!scoreboardUrlFor('NFL', DATE).includes('groups='));

  const emptyLineup = lineupFromSummary({
    rosters: [{ homeAway: 'home', roster: [{ athlete: { displayName: 'Only Bench', position: { abbreviation: 'G' } } }] }],
  }, { teams: { home: { name: 'Duke Blue Devils', id: '150' }, away: { name: 'North Carolina Tar Heels', id: '153' } } });
  assert.strictEqual(emptyLineup, null);

  const calls = [];
  const captured = await captureNewsSlate(baseOpts({ fetchImpl: fakeFetch(calls) }));
  assert.strictEqual(captured.skipped, 'no-write');
  assert.strictEqual(captured.key, KEY);
  const doc = captured.doc;
  assert.strictEqual(doc.date, DATE);
  assert.strictEqual(doc.fetchedAt, NOW);
  assert.strictEqual(doc.games.length, 6);
  assert.ok(calls.some((url) => url.includes('mens-college-basketball/scoreboard') && url.includes('groups=50') && url.includes('limit=400')));
  assert.ok(calls.some((url) => url.includes('college-football/scoreboard') && url.includes('groups=80')));
  assert.ok(calls.filter((url) => url.includes('/hockey/nhl/scoreboard')).length === 1);
  assert.ok(!calls.some((url) => /the-odds-api|api\.the-odds-api|odds-api\.com/i.test(url)));

  const nba = doc.games.find((game) => game.gameId === 'nba1');
  assert.strictEqual(nba.sport, 'NBA');
  assert.strictEqual(nba.commence, '2026-11-19T00:30:00.000Z');
  assert.strictEqual(nba.teams.home.name, 'Memphis Grizzlies');
  assert.strictEqual(nba.teams.home.id, '29');
  assert.strictEqual(nba.teams.away.name, 'Golden State Warriors');
  assert.ok(nba.sourceUrl.includes('summary?event=nba1'));
  assert.deepStrictEqual(Object.keys(nba.injuries.home[0]).sort(), ['comment', 'player', 'pos', 'status']);
  assert.strictEqual(nba.injuries.home[0].player, 'Ja Morant');
  assert.strictEqual(nba.injuries.home[0].pos, 'PG');
  assert.strictEqual(nba.injuries.home[0].status, 'Day-To-Day');
  assert.strictEqual(nba.injuries.home[0].comment.length, 240);
  assert.strictEqual(nba.injuries.away.length, 0);
  assert.strictEqual(nba.lineup, null);
  assert.strictEqual(nba.goalies, null);
  assert.strictEqual(nba.qb, null);

  const nbaMiss = doc.games.find((game) => game.gameId === 'nba2');
  assert.ok(nbaMiss);
  assert.ok(nbaMiss.sourceUrl.includes('/scoreboard?'));
  assert.ok(doc.failures.some((row) => row.gameId === 'nba2' && row.error === 'http'));

  const nhl = doc.games.find((game) => game.gameId === 'nhl1');
  assert.deepStrictEqual(nhl.goalies.home, [{ player: 'Sergei Bobrovsky', pos: 'G', status: 'confirmed', comment: '' }]);
  assert.strictEqual(nhl.goalies.away[0].player, 'Anthony Stolarz');
  assert.strictEqual(nhl.goalies.away[0].status, 'expected');
  assert.ok(!JSON.stringify(nhl.goalies).includes('Matthews'));
  assert.ok(!JSON.stringify(nhl.goalies).includes('Someone Else'));
  assert.strictEqual(nhl.lineup, null);

  const ncaam = doc.games.find((game) => game.gameId === 'ncaam1');
  assert.deepStrictEqual(ncaam.injuries, { home: [], away: [] });
  assert.strictEqual(ncaam.lineup, null);
  assert.strictEqual(ncaam.goalies, null);
  assert.strictEqual(ncaam.qb, null);

  const nfl = doc.games.find((game) => game.gameId === 'nfl1');
  assert.deepStrictEqual(nfl.lineup.home.map((item) => item.player), ['C.J. Stroud']);
  assert.strictEqual(nfl.lineup.home[0].pos, 'QB');
  assert.strictEqual(nfl.lineup.home[0].status, 'starter');
  assert.ok(!nfl.lineup.home.some((item) => item.player === 'Davis Mills'));
  assert.ok(nfl.qb.home.some((item) => item.player === 'C.J. Stroud' && item.status === 'Questionable'));
  assert.ok(nfl.qb.away.some((item) => item.player === 'Sam Ehlinger' && item.status === 'Out'));
  assert.ok(nfl.qb.away.some((item) => item.player === 'Anthony Richardson' && item.status === 'starter'));
  assert.ok(!nfl.qb.away.some((item) => item.player === 'Joe Flacco'));
  assert.ok(calls.some((url) => url.includes('/football/nfl/teams/11/depthcharts')));
  assert.ok(!calls.some((url) => url.includes('/football/nfl/teams/34/depthcharts')));

  const ncaaf = doc.games.find((game) => game.gameId === 'ncaaf1');
  assert.strictEqual(ncaaf.lineup.home[0].player, 'Temple QB');
  assert.strictEqual(ncaaf.lineup.away[0].player, 'Rice QB');
  assert.ok(ncaaf.qb.home.some((item) => item.player === 'Temple QB' && item.pos === 'QB'));
  assert.ok(ncaaf.qb.away.some((item) => item.player === 'Rice QB'));
  assert.ok(!calls.some((url) => url.includes('/college-football/teams/') && url.includes('depthcharts')));

  assert.strictEqual(doc.counts.games, 6);
  assert.strictEqual(doc.counts.bySport.NBA.games, 2);
  assert.strictEqual(doc.counts.bySport.NHL.games, 1);
  assert.strictEqual(doc.counts.bySport.NHL.goalies, 2);
  assert.strictEqual(doc.counts.bySport.NCAAM.games, 1);
  assert.strictEqual(doc.counts.bySport.NCAAM.lineups, 0);
  assert.strictEqual(doc.counts.bySport.NFL.lineups, 1);
  assert.strictEqual(doc.counts.bySport.NFL.qbs, 3);
  assert.strictEqual(doc.counts.bySport.NCAAF.lineups, 1);
  assert.ok(doc.counts.injuryRows >= 3);

  const quiet = [];
  const skipped = await captureNewsSlate(baseOpts({
    env: { OMEGA_NEWS_SLATE: 'off' },
    fetchImpl: () => { quiet.push('x'); return Promise.resolve({ ok: true, json: async () => ({}) }); },
  }));
  assert.strictEqual(skipped.skipped, 'flag-off');
  assert.strictEqual(quiet.length, 0);
  const replaySkip = await captureNewsSlate(baseOpts({
    replay: true,
    fetchImpl: () => { quiet.push('y'); return Promise.resolve({ ok: true, json: async () => ({}) }); },
  }));
  assert.strictEqual(replaySkip.skipped, 'replay');
  assert.strictEqual(quiet.length, 0);

  const budgetCalls = [];
  const budget = await captureNewsSlate(baseOpts({
    budgetMs: 0,
    nowMs: () => 5000,
    fetchImpl: () => { budgetCalls.push('z'); return Promise.resolve({ ok: true, json: async () => ({}) }); },
  }));
  assert.strictEqual(budgetCalls.length, 0);
  assert.strictEqual(budget.doc.games.length, 0);
  assert.ok(budget.doc.failures.length >= 5);
  assert.ok(budget.doc.failures.every((row) => row.error === 'budget'));

  let clock = 0;
  const stopped = [];
  const partial = await captureNewsSlate(baseOpts({
    budgetMs: 4000,
    concurrency: 1,
    nowMs: () => clock,
    fetchImpl: (url) => {
      stopped.push(String(url));
      if (stopped.length >= 10) clock = 999999;
      const body = bodyFor(url);
      if (!body) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => body });
    },
  }));
  assert.ok(stopped.every((url) => !url.includes('/summary?')));
  assert.strictEqual(stopped.length, 10);
  assert.ok(partial.doc.games.length >= 5);
  assert.ok(partial.doc.failures.some((row) => row.error === 'budget' && row.url.includes('/summary?')));
  assert.ok(partial.doc.games.every((game) => game.lineup == null));

  let active = 0;
  let maxActive = 0;
  await captureNewsSlate(baseOpts({
    concurrency: 2,
    fetchImpl: async (url) => {
      active += 1;
      if (active > maxActive) maxActive = active;
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      const body = bodyFor(url);
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => body };
    },
  }));
  assert.ok(maxActive <= 2, `in flight ${maxActive}`);
  assert.ok(maxActive >= 2, `pool did not fill (${maxActive})`);

  const timed = await captureNewsSlate(baseOpts({
    timeoutMs: 40,
    budgetMs: 5000,
    concurrency: 6,
    fetchImpl: () => new Promise(() => {}),
  }));
  assert.strictEqual(timed.doc.games.length, 0);
  assert.ok(timed.doc.failures.length >= 5);
  assert.ok(timed.doc.failures.every((row) => row.error === 'timeout' || row.error === 'budget'));
  assert.ok(timed.doc.failures.some((row) => row.error === 'timeout'));

  const store = memoryBlobs();
  store.rows.set(newsBlobKey(DATE, NOW), { sentinel: true });
  const sdk = await captureNewsSlate(baseOpts({
    noWrite: false,
    fetchImpl: fakeFetch([]),
    store,
    blobFetch: () => { throw new Error('rest should not run'); },
  }));
  assert.strictEqual(sdk.wrote, true);
  assert.strictEqual(sdk.path, 'sdk');
  assert.strictEqual(sdk.key, KEY);
  assert.strictEqual(store.rows.get(KEY).games.length, 6);
  assert.deepStrictEqual(store.rows.get(newsBlobKey(DATE, NOW)), { sentinel: true });
  assert.strictEqual(NEWS_SNAPSHOT_STORE, 'omega-news-snapshots');

  const snapStore = memoryBlobs();
  const snapCalls = [];
  const snapFetch = (url) => {
    snapCalls.push(String(url));
    if (String(url).includes('/basketball/nba/injuries')) {
      return Promise.resolve({ ok: true, json: async () => ({ injuries: [] }) });
    }
    if (String(url).includes('statistics/byathlete')) {
      return Promise.resolve({ ok: true, json: async () => ({ players: [] }) });
    }
    if (String(url).includes('/hockey/nhl/scoreboard')) {
      return Promise.resolve({ ok: true, json: async () => ({ events: [] }) });
    }
    if (String(url).includes('/football/nfl/injuries')) {
      return Promise.resolve({ ok: true, json: async () => ({ injuries: [] }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
  const snap = await captureNewsSnapshot({
    env: { OMEGA_NEWS_SNAPSHOT: 'on' },
    dateISO: DATE,
    now: NOW,
    candidates: [],
    fetchImpl: snapFetch,
    store: snapStore,
    timeoutMs: 5000,
  });
  assert.strictEqual(snap.wrote, true);
  assert.strictEqual(snap.key, newsBlobKey(DATE, NOW));
  assert.ok(snapStore.rows.has(newsBlobKey(DATE, NOW)));
  assert.ok(!snapStore.rows.has(KEY));

  const prevToken = process.env.NETLIFY_AUTH_TOKEN;
  process.env.NETLIFY_AUTH_TOKEN = 'offline-slate-token';
  try {
    let restPuts = 0;
    const rest = await captureNewsSlate(baseOpts({
      noWrite: false,
      fetchImpl: fakeFetch([]),
      store: { setJSON() { throw new Error('sdk down'); } },
      blobFetch: (url) => {
        restPuts += 1;
        assert.ok(String(url).includes('/omega-news-snapshots/'));
        assert.ok(String(url).includes('/games/'));
        assert.ok(!String(url).includes('%2F'));
        return Promise.resolve({ ok: true, status: 200 });
      },
    }));
    assert.strictEqual(rest.wrote, true);
    assert.strictEqual(rest.path, 'rest');
    assert.strictEqual(restPuts, 1);

    const failed = await captureNewsSlate(baseOpts({
      noWrite: false,
      fetchImpl: fakeFetch([]),
      store: { setJSON() { throw new Error('sdk down'); } },
      blobFetch: () => Promise.resolve({ ok: false, status: 500 }),
    }));
    assert.strictEqual(failed.wrote, false);
    assert.strictEqual(failed.path, 'failed');
    assert.strictEqual(failed.error, 'soft-fail');
    assert.ok(failed.doc.games.length === 6);
  } finally {
    if (prevToken == null) delete process.env.NETLIFY_AUTH_TOKEN;
    else process.env.NETLIFY_AUTH_TOKEN = prevToken;
  }

  const secret = 'unit-slate-secret';
  const env = { PICKS_SECRET_KEY: secret, OMEGA_NEWS_SLATE: 'on' };
  const denied = await captureHandle(
    { headers: { authorization: 'Bearer wrong-value' }, queryStringParameters: { date: DATE } },
    { env, captureNewsSlate: async () => { throw new Error('should not run'); } },
  );
  assert.strictEqual(denied.statusCode, 401);
  assert.ok(!String(denied.body).includes(secret));

  const lines = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  let seen = null;
  try {
    const authed = await captureHandle({
      headers: { 'X-Picks-Secret': secret },
      queryStringParameters: { date: DATE },
    }, {
      env,
      now: new Date(NOW),
      captureNewsSlate: async (opts) => {
        seen = opts;
        return { wrote: true, key: KEY, doc: { counts: { games: 4, injuryRows: 3, goalies: 1, qbs: 1, lineups: 1 }, failures: [{ error: 'http' }] } };
      },
    });
    const bearer = await captureHandle({
      headers: { Authorization: `Bearer ${secret}` },
      queryStringParameters: {},
    }, {
      env,
      now: new Date(NOW),
      captureNewsSlate: async (opts) => ({ wrote: false, skipped: 'no-write', key: KEY, doc: { counts: {}, failures: [] }, date: opts.dateISO }),
    });
    const query = await captureHandle({
      headers: {},
      queryStringParameters: { key: secret, date: DATE },
    }, {
      env,
      captureNewsSlate: async () => ({ wrote: true, key: KEY, doc: { counts: {}, failures: [] } }),
    });
    const badDate = await captureHandle({
      headers: { 'x-picks-secret': secret },
      queryStringParameters: { date: 'today' },
    }, { env, captureNewsSlate: async () => { throw new Error('should not run'); } });
    const flagOff = await captureHandle({
      headers: { 'x-picks-secret': secret },
      queryStringParameters: { date: DATE },
    }, {
      env: { PICKS_SECRET_KEY: secret, OMEGA_NEWS_SLATE: 'off' },
      captureNewsSlate: async () => { throw new Error('should not run'); },
    });
    assert.strictEqual(authed.statusCode, 200);
    const authBody = JSON.parse(authed.body);
    assert.strictEqual(authBody.wrote, true);
    assert.strictEqual(authBody.counts.games, 4);
    assert.strictEqual(authBody.failures, 1);
    assert.strictEqual(seen.dateISO, DATE);
    assert.strictEqual(seen.budgetMs, 60000);
    assert.strictEqual(bearer.statusCode, 200);
    assert.strictEqual(JSON.parse(bearer.body).date, DATE);
    assert.strictEqual(query.statusCode, 200);
    assert.strictEqual(badDate.statusCode, 400);
    assert.strictEqual(flagOff.statusCode, 200);
    assert.strictEqual(JSON.parse(flagOff.body).skipped, 'flag-off');
  } finally {
    console.log = log;
    console.warn = warn;
  }
  assert.ok(!lines.join('\n').includes(secret));

  const summary = { ok: true, datesGraded: 2, rows: 9, marker: 'keep' };
  let slateArgs = null;
  const graded = await gradeHandle({}, {
    env: { OMEGA_NEWS_SLATE: 'on', OMEGA_V2_BOARD_GRADER: 'on' },
    now: new Date(NOW),
    run: async () => summary,
    captureNewsSlate: async (opts) => { slateArgs = opts; return { wrote: true }; },
  });
  assert.strictEqual(graded.statusCode, 200);
  assert.strictEqual(graded.body, JSON.stringify(summary));
  assert.strictEqual(slateArgs.budgetMs, 60000);
  assert.strictEqual(slateArgs.dateISO, DATE);
  assert.strictEqual(slateArgs.timeoutMs, 5000);

  const threw = await gradeHandle({}, {
    env: { OMEGA_NEWS_SLATE: 'on' },
    run: async () => summary,
    captureNewsSlate: async () => { throw new Error('slate down'); },
  });
  assert.strictEqual(threw.statusCode, 200);
  assert.strictEqual(threw.body, JSON.stringify(summary));

  let called = false;
  const offGrade = await gradeHandle({}, {
    env: { OMEGA_NEWS_SLATE: 'off' },
    run: async () => summary,
    captureNewsSlate: async () => { called = true; },
  });
  assert.strictEqual(offGrade.body, JSON.stringify(summary));
  assert.strictEqual(called, false);

  let afterFail = false;
  const graderBoom = await gradeHandle({}, {
    env: { OMEGA_NEWS_SLATE: 'on' },
    run: async () => { throw new Error('grader boom'); },
    captureNewsSlate: async () => { afterFail = true; return { wrote: false }; },
  });
  assert.strictEqual(graderBoom.statusCode, 500);
  assert.strictEqual(JSON.parse(graderBoom.body).error, 'grader boom');
  assert.strictEqual(afterFail, true);

  const gen = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  const storeAt = gen.lastIndexOf('await storePicks(');
  const slateAt = gen.indexOf('await captureNewsSlate({');
  assert.ok(storeAt > 0 && slateAt > storeAt, 'slate runs after the card write');
  assert.ok(gen.includes('if (!replayLike && !dryRun && newsSlateEnabled())'));
  assert.ok(!/picksData\.newsSlate|publishInput\.newsSlate/.test(gen));
  const replaySrc = fs.readFileSync(path.join(__dirname, 'tools/omega-v2/replay-sharp.js'), 'utf8');
  assert.ok(replaySrc.includes("'OMEGA_NEWS_SLATE'"));
  assert.ok(!/captureNewsSlate|news_slate/.test(replaySrc));
  const slateSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/news_slate.js'), 'utf8');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(slateSrc));
  const manualSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-news-slate-background.js'), 'utf8');
  assert.ok(!/console\.(log|warn|error)/.test(manualSrc));
  assert.ok(!/^\s*schedule\s*=/m.test(manualSrc));
  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  assert.ok(!toml.includes('capture-news-slate'));
  const gradeSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/grade-boards-omega-background.js'), 'utf8');
  assert.ok(gradeSrc.indexOf('JSON.stringify(summary)') < gradeSrc.indexOf('await captureSlateAfterGrade'));
  assert.ok(gradeSrc.includes('budgetMs: SLATE_BUDGET_MS'));

  console.log('PASS news slate');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
