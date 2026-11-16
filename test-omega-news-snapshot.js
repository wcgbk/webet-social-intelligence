'use strict';

/**
 * OMEGA_NEWS_SNAPSHOT logs a compact ESPN snapshot. Default on.
 * Offline: fake fetch and an in-memory blob store. The snapshot is not a pick input.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { newsSnapshotEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const {
  NBA_INJURY_URL,
  NBA_RATES_URL,
  nhlScoreboardUrl,
  fetchNbaInjuryReport,
  fetchNhlGoalieReport,
  bindNewsShare,
  clearNewsShare,
} = require('./netlify/functions/lib/omega-vnext/status_pull');
const {
  NFL_INJURY_URL,
  NEWS_SNAPSHOT_STORE,
  newsBlobKey,
  captureNewsSnapshot,
} = require('./netlify/functions/lib/omega-vnext/news_snapshot');

const NOW = '2026-11-15T15:00:00.000Z';
const DATE = '2026-11-15';
const KEY = '2026-11-15/1000-ET';

const NBA_INJURIES = {
  injuries: [{
    displayName: 'Philadelphia 76ers',
    injuries: [
      {
        status: 'Day-To-Day',
        shortComment: 'Embiid (knee) is day to day.',
        date: '2026-11-15T12:00Z',
        athlete: { displayName: 'Joel Embiid', position: { abbreviation: 'C' } },
      },
      {
        status: 'Out',
        shortComment: 'Maxey is out.',
        date: '2026-11-14T12:00Z',
        athlete: { displayName: 'Tyrese Maxey' },
      },
    ],
  }],
};

const NBA_RATES = {
  players: [
    { team: 'Philadelphia 76ers', name: 'Joel Embiid', mpg: 36, ppg: 30 },
  ],
};

const NHL_BOARD = {
  events: [{
    competitions: [{
      competitors: [
        {
          homeAway: 'home',
          team: { displayName: 'Philadelphia Flyers' },
          probables: [{
            name: 'probableStartingGoalie',
            athlete: { displayName: 'Dan Vladar', position: 'G' },
            status: { id: '102', name: 'Confirmed', type: 'confirmed' },
          }],
        },
        {
          homeAway: 'away',
          team: { displayName: 'Edmonton Oilers' },
          probables: [{
            name: 'probableStartingGoalie',
            athlete: { displayName: 'Stuart Skinner', position: 'G' },
            status: { id: '101', name: 'Expected', type: 'expected' },
          }, {
            name: 'probableStartingSkater',
            athlete: { displayName: 'Connor McDavid', position: 'C' },
            status: { id: '1', name: 'Expected', type: 'expected' },
          }],
        },
      ],
    }],
  }],
};

const NFL_INJURIES = {
  injuries: [{
    displayName: 'Kansas City Chiefs',
    injuries: [
      {
        status: 'Questionable',
        shortComment: 'Mahomes (ankle) is questionable.',
        date: '2026-11-15T08:00Z',
        athlete: { displayName: 'Patrick Mahomes', position: { abbreviation: 'QB' } },
      },
      {
        status: 'Out',
        shortComment: 'A receiver is out.',
        date: '2026-11-15T08:00Z',
        athlete: { displayName: 'Not A QB', position: { abbreviation: 'WR' } },
      },
    ],
  }],
};

const CANDIDATES = [
  {
    sport: 'NBA',
    matchup: 'Boston Celtics @ Philadelphia 76ers',
    homeTeam: 'Philadelphia 76ers',
    awayTeam: 'Boston Celtics',
    commenceTime: '2026-11-15T23:30:00Z',
    side: 'Philadelphia 76ers ML',
  },
  {
    sport: 'NBA',
    matchup: 'Boston Celtics @ Philadelphia 76ers',
    homeTeam: 'Philadelphia 76ers',
    awayTeam: 'Boston Celtics',
    side: 'Over 220.5',
  },
  {
    sport: 'NHL',
    matchup: 'Edmonton Oilers @ Philadelphia Flyers',
    homeTeam: 'Philadelphia Flyers',
    awayTeam: 'Edmonton Oilers',
    eventId: 'nhl-1',
    commenceTime: '2026-11-15T23:00:00Z',
  },
];

const ODDS = {
  NBA: [{ id: 'odds-76ers', home_team: 'Philadelphia 76ers', away_team: 'Boston Celtics' }],
};

const NCAAF = {
  'Ohio State Buckeyes': { team: 'Ohio State Buckeyes', qbStatus: 'questionable', qbName: 'Will Howard' },
};

function memoryBlobs() {
  const rows = new Map();
  return {
    rows,
    async setJSON(key, value) {
      rows.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function bodiesFor(url) {
  const u = String(url);
  if (u === NBA_INJURY_URL) return NBA_INJURIES;
  if (u === NBA_RATES_URL) return NBA_RATES;
  if (u === nhlScoreboardUrl(DATE)) return NHL_BOARD;
  if (u === NFL_INJURY_URL) return NFL_INJURIES;
  return null;
}

function fakeFetch(calls, extra) {
  return (url) => {
    calls.push(String(url));
    if (extra) {
      const replaced = extra(url);
      if (replaced) return replaced;
    }
    const body = bodiesFor(url);
    if (!body) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => body });
  };
}

function countUrl(calls, part) {
  return calls.filter((url) => url.includes(part)).length;
}

function cardFixture() {
  return {
    date: DATE,
    picks: [{ pick: 'Philadelphia 76ers ML', odds: '-110', units: '1.0' }],
    edgeSummary: 'Sunday, November 15, 2026: top 3 plays by expected growth.',
    insights: '',
  };
}

async function main() {
  clearNewsShare();
  assert.strictEqual(NEWS_SNAPSHOT_STORE, 'omega-news-snapshots');
  assert.strictEqual(newsBlobKey(DATE, NOW), KEY);

  assert.strictEqual(newsSnapshotEnabled({}), true, 'unset defaults on');
  assert.strictEqual(newsSnapshotEnabled({ OMEGA_NEWS_SNAPSHOT: undefined }), true);
  for (const on of ['on', '1', 'true', 'yes', 'ON', ' Yes ']) {
    assert.strictEqual(newsSnapshotEnabled({ OMEGA_NEWS_SNAPSHOT: on }), true, `on ${JSON.stringify(on)}`);
  }
  for (const off of ['off', '0', 'false', '', '  ', 'no']) {
    assert.strictEqual(newsSnapshotEnabled({ OMEGA_NEWS_SNAPSHOT: off }), false, `off ${JSON.stringify(off)}`);
  }

  const card = cardFixture();
  const before = JSON.parse(JSON.stringify(card));
  const calls = [];
  const store = memoryBlobs();
  const written = await captureNewsSnapshot({
    env: {},
    dateISO: DATE,
    now: NOW,
    card,
    candidates: CANDIDATES,
    oddsBySport: ODDS,
    ncaafQb: NCAAF,
    fetchImpl: fakeFetch(calls),
    store,
    timeoutMs: 5000,
  });
  assert.strictEqual(written.wrote, true);
  assert.strictEqual(written.key, KEY);
  assert.deepStrictEqual(card, before, 'a written snapshot does not change the card');
  assert.strictEqual(store.rows.size, 1);
  const doc = store.rows.get(KEY);
  assert.strictEqual(doc.fetchedAt, NOW);
  assert.strictEqual(doc.date, DATE);
  assert.strictEqual(doc.games.length, 2);
  assert.deepStrictEqual(doc.games[0], {
    sport: 'NBA',
    matchup: 'Boston Celtics @ Philadelphia 76ers',
    gameId: 'odds-76ers',
    homeTeam: 'Philadelphia 76ers',
    awayTeam: 'Boston Celtics',
    commenceTime: '2026-11-15T23:30:00Z',
  });
  assert.strictEqual(doc.games[1].gameId, 'nhl-1');
  assert.strictEqual(doc.games[1].matchup, 'Edmonton Oilers @ Philadelphia Flyers');
  assert.deepStrictEqual(doc.nba.injuries, [
    {
      team: 'Philadelphia 76ers',
      athlete: 'Joel Embiid',
      status: 'Day-To-Day',
      shortComment: 'Embiid (knee) is day to day.',
      date: '2026-11-15T12:00Z',
    },
    {
      team: 'Philadelphia 76ers',
      athlete: 'Tyrese Maxey',
      status: 'Out',
      shortComment: 'Maxey is out.',
      date: '2026-11-14T12:00Z',
    },
  ]);
  assert.deepStrictEqual(doc.nba.rates, [
    { team: 'Philadelphia 76ers', athlete: 'Joel Embiid', mpg: 36, ppg: 30 },
  ]);
  assert.strictEqual(doc.nba.error, undefined);
  assert.strictEqual(doc.nba.ratesError, undefined);
  assert.deepStrictEqual(doc.nhl.probables, [
    {
      team: 'Philadelphia Flyers',
      goalie: 'Dan Vladar',
      status: { type: 'confirmed', name: 'Confirmed', id: '102' },
    },
    {
      team: 'Edmonton Oilers',
      goalie: 'Stuart Skinner',
      status: { type: 'expected', name: 'Expected', id: '101' },
    },
  ]);
  assert.deepStrictEqual(doc.nflQb, [{
    team: 'Kansas City Chiefs',
    athlete: 'Patrick Mahomes',
    status: 'Questionable',
    shortComment: 'Mahomes (ankle) is questionable.',
    date: '2026-11-15T08:00Z',
  }]);
  assert.deepStrictEqual(doc.ncaafQb, [
    { team: 'Ohio State Buckeyes', athlete: 'Will Howard', status: 'questionable' },
  ]);
  assert.strictEqual(countUrl(calls, 'basketball/nba/injuries'), 1);
  assert.strictEqual(countUrl(calls, 'byathlete'), 1);
  assert.strictEqual(countUrl(calls, 'hockey/nhl/scoreboard'), 1);
  assert.strictEqual(countUrl(calls, 'football/nfl/injuries'), 1);

  const failedCard = cardFixture();
  const failedBefore = JSON.parse(JSON.stringify(failedCard));
  const failStore = memoryBlobs();
  const failed = await Promise.race([
    captureNewsSnapshot({
      env: { OMEGA_NEWS_SNAPSHOT: 'on' },
      dateISO: DATE,
      now: NOW,
      card: failedCard,
      candidates: CANDIDATES.slice(0, 1),
      fetchImpl: () => { throw new Error('espn down'); },
      store: failStore,
      timeoutMs: 50,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot blocked')), 400)),
  ]);
  assert.strictEqual(failed.wrote, true);
  assert.deepStrictEqual(failedCard, failedBefore, 'fetch failure leaves the card unchanged');
  const failDoc = failStore.rows.get(KEY);
  assert.strictEqual(failDoc.nba.error, 'soft-fail');
  assert.strictEqual(failDoc.nba.rates, null);
  assert.strictEqual(failDoc.nba.ratesError, 'soft-fail');
  assert.strictEqual(failDoc.nhl.error, 'soft-fail');
  assert.strictEqual(failDoc.nflQbError, 'soft-fail');
  assert.deepStrictEqual(failDoc.nba.injuries, []);
  assert.deepStrictEqual(failDoc.nflQb, []);
  assert.strictEqual(failDoc.ncaafQb, 'unavailable');
  assert.strictEqual(failDoc.games[0].matchup, 'Boston Celtics @ Philadelphia 76ers');

  const hungCard = cardFixture();
  const hungBefore = JSON.parse(JSON.stringify(hungCard));
  const hung = await Promise.race([
    captureNewsSnapshot({
      env: {},
      dateISO: DATE,
      now: NOW,
      card: hungCard,
      candidates: [],
      fetchImpl: () => new Promise(() => {}),
      store: memoryBlobs(),
      timeoutMs: 40,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot blocked')), 400)),
  ]);
  assert.strictEqual(hung.wrote, true);
  assert.deepStrictEqual(hungCard, hungBefore);
  assert.strictEqual(hung.error, undefined);

  const blobDown = await captureNewsSnapshot({
    env: {},
    dateISO: DATE,
    now: NOW,
    candidates: [],
    fetchImpl: () => { throw new Error('espn down'); },
    store: {
      setJSON() { throw new Error('blob down'); },
    },
    timeoutMs: 40,
  });
  assert.strictEqual(blobDown.wrote, false);
  assert.strictEqual(blobDown.error, 'soft-fail');

  let offFetches = 0;
  let offWrites = 0;
  const offCard = cardFixture();
  const offBefore = JSON.parse(JSON.stringify(offCard));
  for (const off of ['off', '0', 'false', '']) {
    const skipped = await captureNewsSnapshot({
      env: { OMEGA_NEWS_SNAPSHOT: off },
      dateISO: DATE,
      now: NOW,
      card: offCard,
      candidates: CANDIDATES,
      fetchImpl: () => { offFetches += 1; throw new Error('should not fetch'); },
      store: {
        setJSON() { offWrites += 1; throw new Error('should not write'); },
      },
    });
    assert.strictEqual(skipped.skipped, 'flag-off', `flag ${JSON.stringify(off)}`);
    assert.strictEqual(skipped.wrote, false);
  }
  assert.strictEqual(offFetches, 0, 'flag off does not fetch');
  assert.strictEqual(offWrites, 0, 'flag off does not write');
  assert.deepStrictEqual(offCard, offBefore);

  let replayFetches = 0;
  const replaySkip = await captureNewsSnapshot({
    env: {},
    replay: true,
    dateISO: DATE,
    fetchImpl: () => { replayFetches += 1; throw new Error('replay net'); },
    store: { setJSON() { throw new Error('replay write'); } },
  });
  assert.strictEqual(replaySkip.skipped, 'replay');
  assert.strictEqual(replayFetches, 0);
  const replayLikeSkip = await captureNewsSnapshot({
    env: { OMEGA_NEWS_SNAPSHOT: 'on' },
    replayLike: true,
    dateISO: DATE,
    fetchImpl: () => { replayFetches += 1; throw new Error('replay net'); },
    store: { setJSON() { throw new Error('replay write'); } },
  });
  assert.strictEqual(replayLikeSkip.skipped, 'replay');
  assert.strictEqual(replayFetches, 0);

  clearNewsShare();
  bindNewsShare({});
  const sharedCalls = [];
  const sharedFetch = fakeFetch(sharedCalls);
  await fetchNbaInjuryReport({ timeoutMs: 5000, now: NOW, fetchImpl: sharedFetch });
  await fetchNhlGoalieReport({ timeoutMs: 5000, dateISO: DATE, now: NOW, fetchImpl: sharedFetch });
  const sharedStore = memoryBlobs();
  const sharedWrite = await captureNewsSnapshot({
    env: {},
    dateISO: DATE,
    now: NOW,
    candidates: CANDIDATES,
    oddsBySport: ODDS,
    ncaafQb: NCAAF,
    fetchImpl: sharedFetch,
    store: sharedStore,
    timeoutMs: 5000,
  });
  assert.strictEqual(sharedWrite.wrote, true);
  assert.strictEqual(countUrl(sharedCalls, 'basketball/nba/injuries'), 1, 'nba injuries fetched once');
  assert.strictEqual(countUrl(sharedCalls, 'byathlete'), 1, 'nba rates fetched once');
  assert.strictEqual(countUrl(sharedCalls, 'hockey/nhl/scoreboard'), 1, 'nhl scoreboard fetched once');
  assert.strictEqual(countUrl(sharedCalls, 'football/nfl/injuries'), 1, 'nfl qb list fetched once');
  assert.strictEqual(sharedStore.rows.get(KEY).nba.injuries.length, 2);
  assert.strictEqual(sharedStore.rows.get(KEY).nhl.probables.length, 2);

  clearNewsShare();
  bindNewsShare({});
  const reverseCalls = [];
  const reverseFetch = fakeFetch(reverseCalls);
  await captureNewsSnapshot({
    env: {},
    dateISO: DATE,
    now: NOW,
    candidates: CANDIDATES,
    fetchImpl: reverseFetch,
    store: memoryBlobs(),
    timeoutMs: 5000,
  });
  const afterSnap = reverseCalls.length;
  await fetchNbaInjuryReport({ timeoutMs: 5000, now: NOW, fetchImpl: reverseFetch });
  await fetchNhlGoalieReport({ timeoutMs: 5000, dateISO: DATE, now: NOW, fetchImpl: reverseFetch });
  assert.strictEqual(reverseCalls.length, afterSnap, 'veto reuses the snapshot bodies');

  clearNewsShare();
  bindNewsShare({});
  const failCalls = [];
  const failingFetch = () => {
    failCalls.push('fail');
    throw new Error('espn down');
  };
  await fetchNbaInjuryReport({ timeoutMs: 40, now: NOW, fetchImpl: failingFetch });
  await fetchNhlGoalieReport({ timeoutMs: 40, dateISO: DATE, now: NOW, fetchImpl: failingFetch });
  const afterFail = failCalls.length;
  await captureNewsSnapshot({
    env: {},
    dateISO: DATE,
    now: NOW,
    candidates: [],
    fetchImpl: (url) => {
      failCalls.push(String(url));
      throw new Error('second pull');
    },
    store: memoryBlobs(),
    timeoutMs: 40,
  });
  const extra = failCalls.slice(afterFail);
  assert.ok(extra.every((url) => url.includes('football/nfl/injuries')), `refetch ${extra.join(',')}`);
  assert.strictEqual(extra.length, 1);

  const gen = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/index.js'), 'utf8');
  assert.ok(gen.includes('if (!replayLike && newsSnapshotEnabled())'), 'replay and flag off skip the log');
  assert.ok(gen.includes('captureNewsSnapshot({'), 'generate stores the snapshot');
  assert.ok(gen.includes('fetchNbaInjuryReport({ timeoutMs: 5000 })'));
  assert.ok(gen.includes('fetchNhlGoalieReport({ timeoutMs: 5000, dateISO })'));
  assert.ok(!/publishInput\.newsSnapshot|picksData\.newsSnapshot/.test(gen), 'snapshot is not a card field');
  const replaySrc = fs.readFileSync(path.join(__dirname, 'tools/omega-v2/replay-sharp.js'), 'utf8');
  assert.ok(replaySrc.includes("'OMEGA_NEWS_SNAPSHOT'"));
  assert.ok(!/captureNewsSnapshot|news_snapshot|site\.api\.espn/.test(replaySrc), 'replay does not fetch');
  const snapSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/news_snapshot.js'), 'utf8');
  assert.ok(!/the-odds-api|api\.the-odds-api|odds-api\.com/i.test(snapSrc));

  clearNewsShare();
  console.log('PASS news snapshot');
}

main().catch((err) => {
  clearNewsShare();
  console.error(err);
  process.exit(1);
});
