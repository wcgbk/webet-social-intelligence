'use strict';
/**
 * v12.3.41: yesterday's pregame closes, 3:00 baseline, 10:00 early line.
 * Context only. The published card is not written.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const cache = require(path.join(root, 'odds_snapshot_cache'));
const master = require(path.join(root, 'odds_master'));
const lines = require(path.join(root, 'pinnacle_line_move'));
const { runPinnacleLineCapture } = require(path.join(root, 'capture_runner'));
const { selectStraights, toPickObject } = require(path.join(root, 'select'));
const { applyGates } = require(path.join(root, 'gates'));
const cand = require(path.join(root, 'clv_candidates'));
const track = require('./netlify/functions/track-clv-omega')._test;

const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';
const DATE = '2026-10-12';
const DAY = '2026-10-12T20:00:00Z';
const YDAY = '2026-10-11T20:00:00Z';
const YDAY_LATE = '2026-10-11T23:30:00Z';
const AT3 = '2026-10-12T07:00:00.000Z';
const AT10 = '2026-10-12T14:00:00.000Z';

function boardEvent(id, book, prices, commence = DAY) {
  const src = prices || {};
  const home = src.home != null ? src.home : -110;
  const away = src.away != null ? src.away : -110;
  const homePoint = src.homePoint != null ? src.homePoint : -3;
  const awayPoint = src.awayPoint != null ? src.awayPoint : 3;
  const total = src.total != null ? src.total : 47.5;
  return {
    id,
    commence_time: commence,
    home_team: HOME,
    away_team: AWAY,
    bookmakers: [{
      key: book,
      markets: [
        { key: 'h2h', outcomes: [{ name: HOME, price: home }, { name: AWAY, price: away }] },
        { key: 'spreads', outcomes: [{ name: HOME, price: home, point: homePoint }, { name: AWAY, price: away, point: awayPoint }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: total }, { name: 'Under', price: -110, point: total }] },
      ],
    }],
  };
}

function responder(body, remaining) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const want = String(name || '').toLowerCase();
        if (want === 'x-requests-remaining') return remaining == null ? null : String(remaining);
        if (want === 'x-requests-last') return '3';
        return null;
      },
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function makeFetch(decide) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const out = decide(u, calls);
    return responder(out.body, out.remaining);
  };
  fn.calls = calls;
  return fn;
}

function memoryStore() {
  const blobs = new Map();
  const writes = [];
  return {
    blobs,
    writes,
    async read(key) {
      if (!blobs.has(key)) return null;
      return JSON.parse(JSON.stringify(blobs.get(key)));
    },
    async write(key, data) {
      writes.push(key);
      blobs.set(key, JSON.parse(JSON.stringify(data)));
    },
  };
}

function runnerOpts(store, extra) {
  return Object.assign({
    dateISO: DATE,
    apiKey: 'test-key-1234',
    labels: ['NFL'],
    env: { OMEGA_REPLAY_NO_WRITE: '0' },
    now: new Date(AT3),
    read: store.read,
    write: store.write,
    skipExternalCloses: true,
    mode: 'check',
    etSlot: '0300',
  }, extra);
}

function oddsCalls(calls) {
  return calls.filter((u) => u.pathname.endsWith('/odds') && !u.pathname.includes('/historical/'));
}

function histCalls(calls) {
  return calls.filter((u) => u.pathname.includes('/historical/'));
}

function gameRow(eventId, commenceTime) {
  return {
    sport: 'NFL',
    eventId,
    commenceTime,
    homeTeam: HOME,
    awayTeam: AWAY,
  };
}

function liveBoard(u) {
  const book = u.searchParams.get('bookmakers') || 'pinnacle';
  return { body: [boardEvent('evToday', book)], remaining: 50000 };
}

function histPayload(ids, commence, timestamp) {
  return {
    timestamp: timestamp == null ? commence : timestamp,
    previous_timestamp: null,
    next_timestamp: null,
    data: ids.map((id) => boardEvent(id, 'pinnacle', { home: -130, away: 110 }, commence)),
  };
}

function quoteMap(id, prices, at, commence = DAY) {
  return lines.quotesFromEvent(boardEvent(id, 'pinnacle', prices, commence), 'NFL', { at, book: 'pinnacle' }, 'pinnacle');
}

function priceKeys(store, eventId) {
  return [...store.blobs.keys()].filter((key) => key.startsWith(`NFL/${eventId}/pinnacle/`));
}

(async () => {
  cache.resetKnownRequestsRemainingForTests();
  cache.clearMemoryForTests();
  try {
    assert.strictEqual(config.MODEL_VERSION, 'v12.3.66-omega-vnext-price-lock');
    assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.66-omega-vnext-price-lock:'));
    assert.ok(String(config.MODEL_NOTES).includes('v12.3.40-omega-vnext-price-lock:'));
    assert.ok(String(config.MODEL_NOTES).includes('No historical odds call.'));
    assert.strictEqual(config.PINNACLE_LINE_MOVE.historicalCreditsPerPull, 30);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.earlyReuseMs, 5 * 60 * 1000);
    assert.strictEqual(master.historicalCreditsPerPull(), 30);
    assert.strictEqual(master.HISTORICAL_CREDITS_PER_PULL, 30);

    const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
    const block = toml.split('[functions."capture-omega-pinnacle-lines"]')[1].split('\n[')[0];
    assert.ok(block.includes('schedule = "0 7,8,14,15 * * *"'));
    assert.ok(!/picks-\{date\}|storePicks/.test(block));

    assert.strictEqual(master.isPreviousEtDay('2026-03-08T04:30:00Z', '2026-03-08'), true);
    assert.strictEqual(master.commenceEtDate('2026-03-08T04:30:00Z'), '2026-03-07');
    assert.strictEqual(master.isPreviousEtDay('2026-03-08T05:30:00Z', '2026-03-08'), false);
    assert.strictEqual(master.commenceEtDate('2026-03-08T05:30:00Z'), '2026-03-08');
    assert.strictEqual(master.isPreviousEtDay('2026-03-07T04:00:00Z', '2026-03-08'), false);
    assert.strictEqual(master.commenceEtDate('2026-03-07T04:00:00Z'), '2026-03-06');
    assert.strictEqual(master.isPreviousEtDay('2026-11-01T05:30:00Z', '2026-11-02'), true);
    assert.strictEqual(master.isPreviousEtDay('2026-11-01T06:30:00Z', '2026-11-02'), true);
    assert.strictEqual(master.commenceEtDate('2026-11-01T05:30:00Z'), '2026-11-01');
    assert.strictEqual(master.commenceEtDate('2026-11-01T06:30:00Z'), '2026-11-01');
    assert.strictEqual(master.isPreviousEtDay('2026-11-02T04:30:00Z', '2026-11-02'), true);
    assert.strictEqual(master.isPreviousEtDay('2026-11-02T05:30:00Z', '2026-11-02'), false);
    assert.strictEqual(master.commenceEtDate('2026-11-02T05:30:00Z'), '2026-11-02');

    const spring = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        return { body: histPayload(['spring'], date, date), remaining: 50000 };
      }
      return liveBoard(u);
    });
    const springOut = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      dateISO: '2026-03-08',
      now: new Date('2026-03-08T07:00:00Z'),
      fetchImpl: spring,
      yesterdayGames: [
        gameRow('spring', '2026-03-08T04:30:00Z'),
        gameRow('today-est', '2026-03-08T05:30:00Z'),
        gameRow('older', '2026-03-07T04:00:00Z'),
      ],
    }));
    assert.strictEqual(histCalls(spring.calls).length, 1);
    assert.strictEqual(histCalls(spring.calls)[0].searchParams.get('date'), '2026-03-08T04:30:00Z');
    assert.strictEqual(springOut.historicalPulls, 1);
    assert.strictEqual(springOut.historicalCredits, 30);

    const fall = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        return { body: histPayload([date], date, date), remaining: 50000 };
      }
      return liveBoard(u);
    });
    await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      dateISO: '2026-11-02',
      now: new Date('2026-11-02T08:00:00Z'),
      fetchImpl: fall,
      yesterdayGames: [
        gameRow('before-fold', '2026-11-01T05:30:00Z'),
        gameRow('after-fold', '2026-11-01T06:30:00Z'),
        gameRow('late', '2026-11-02T04:30:00Z'),
        gameRow('next-morning', '2026-11-02T05:30:00Z'),
      ],
    }));
    const fallDates = histCalls(fall.calls).map((u) => u.searchParams.get('date')).sort();
    assert.deepStrictEqual(fallDates, [
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z',
      '2026-11-02T04:30:00Z',
    ]);

    const lateSnap = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        const after = new Date(Date.parse(date) + 1000).toISOString();
        return { body: histPayload(['evLate'], date, after), remaining: 50000 };
      }
      return liveBoard(u);
    });
    const lateStore = memoryStore();
    const lateOut = await runPinnacleLineCapture(runnerOpts(lateStore, {
      fetchImpl: lateSnap,
      yesterdayGames: [gameRow('evLate', YDAY)],
    }));
    assert.strictEqual(histCalls(lateSnap.calls).length, 1);
    assert.ok(Date.parse(histCalls(lateSnap.calls)[0].searchParams.get('date')) <= Date.parse(YDAY));
    assert.strictEqual(lateOut.closesRejected, 1);
    assert.strictEqual(lateOut.closesStored, 0);
    assert.strictEqual(await master.hasStoredClose('NFL', 'evLate', { read: lateStore.read }), false);

    const onTime = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        return { body: histPayload(['evOn'], date, date), remaining: 50000 };
      }
      return liveBoard(u);
    });
    const onStore = memoryStore();
    const onOut = await runPinnacleLineCapture(runnerOpts(onStore, {
      fetchImpl: onTime,
      yesterdayGames: [gameRow('evOn', YDAY)],
    }));
    assert.strictEqual(onOut.closesStored, 1);
    assert.strictEqual(onOut.closesRejected, 0);
    const onIdx = await master.readIndex('NFL', 'evOn', { read: onStore.read });
    assert.ok(onIdx && onIdx.close);
    assert.ok(master.snapshotAtOrBefore(onIdx.close.snapshotAt, YDAY));
    assert.ok(onStore.writes.some((key) => key === master.priceKey('NFL', 'evOn', 'pinnacle', 'h2h', YDAY)));

    const shared = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        return { body: histPayload(['evA', 'evB'], date, date), remaining: 50000 };
      }
      return liveBoard(u);
    });
    const sharedOut = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      fetchImpl: shared,
      yesterdayGames: [gameRow('evA', YDAY), gameRow('evB', YDAY)],
    }));
    assert.strictEqual(histCalls(shared.calls).length, 1);
    assert.strictEqual(histCalls(shared.calls)[0].searchParams.get('bookmakers'), 'pinnacle');
    assert.strictEqual(histCalls(shared.calls)[0].searchParams.get('regions'), 'eu');
    assert.strictEqual(histCalls(shared.calls)[0].searchParams.get('markets'), 'h2h,spreads,totals');
    assert.ok(Date.parse(histCalls(shared.calls)[0].searchParams.get('date')) <= Date.parse(YDAY));
    assert.strictEqual(sharedOut.closesStored, 2);
    assert.strictEqual(sharedOut.historicalPulls, 1);
    assert.strictEqual(sharedOut.historicalCreditsPerPull, 30);
    assert.strictEqual(oddsCalls(shared.calls).length, 2);

    const seeded = memoryStore();
    const seedQuotes = quoteMap('evSkip', { home: -125, away: 105 }, YDAY, YDAY);
    const seed = await master.storeQuotes({
      sport: 'NFL',
      eventId: 'evSkip',
      book: 'pinnacle',
      role: 'close',
      timestamp: YDAY,
      quotes: seedQuotes,
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: YDAY,
      snapshotAt: YDAY,
      source: 'historical',
    }, { read: seeded.read, write: seeded.write, env: { OMEGA_REPLAY_NO_WRITE: '0' } });
    assert.strictEqual(seed.wrote, true);
    const skipFetch = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) throw new Error('stored close was re-pulled');
      return liveBoard(u);
    });
    const skipped = await runPinnacleLineCapture(runnerOpts(seeded, {
      fetchImpl: skipFetch,
      yesterdayGames: [gameRow('evSkip', YDAY)],
    }));
    assert.strictEqual(histCalls(skipFetch.calls).length, 0);
    assert.strictEqual(skipped.closesSkipped, 1);
    assert.strictEqual(skipped.historicalPulls, 0);
    assert.strictEqual(oddsCalls(skipFetch.calls).length, 2);

    const candFetch = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) throw new Error('candidate close was re-pulled');
      return liveBoard(u);
    });
    const candSkip = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      fetchImpl: candFetch,
      skipExternalCloses: false,
      readCandidateCloses: async () => [{
        eventId: 'evCand',
        sport: 'NFL',
        homeTeam: HOME,
        awayTeam: AWAY,
        commenceTime: YDAY,
        closeNoVig: 0.54,
      }],
      yesterdayGames: [gameRow('evCand', YDAY)],
    }));
    assert.strictEqual(histCalls(candFetch.calls).length, 0);
    assert.strictEqual(candSkip.closesSkipped, 1);

    const freshStore = memoryStore();
    const freshFetch = makeFetch((u) => liveBoard(u));
    const fresh = await runPinnacleLineCapture(runnerOpts(freshStore, { fetchImpl: freshFetch }));
    assert.strictEqual(oddsCalls(freshFetch.calls).length, 2);
    assert.strictEqual(histCalls(freshFetch.calls).length, 0);
    assert.strictEqual(fresh.opensFilled, 1);
    assert.strictEqual(fresh.baselines, 1);
    assert.strictEqual(fresh.historicalPulls, 0);
    const freshDoc = freshStore.blobs.get(lines.eventKey('NFL', 'evToday'));
    assert.strictEqual(freshDoc.open.at, AT3);
    const freshIdx = await master.readIndex('NFL', 'evToday', { read: freshStore.read });
    assert.strictEqual(freshIdx.open.at, AT3);
    assert.strictEqual(freshIdx.baseline0300.at, AT3);
    assert.ok(freshIdx.prices[Object.keys(freshIdx.prices)[0]].roles.includes('open'));
    assert.ok(freshIdx.prices[Object.keys(freshIdx.prices)[0]].roles.includes('baseline-0300'));
    assert.strictEqual(priceKeys(freshStore, 'evToday').length, 3);

    const priorAt = '2026-10-12T02:00:00.000Z';
    const priorStore = memoryStore();
    await lines.storeOpen('NFL', 'evToday', {
      at: priorAt,
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: DAY,
      date: DATE,
      quotes: quoteMap('evToday', { home: -115, away: -105 }, priorAt),
    }, { read: priorStore.read, write: priorStore.write, env: { OMEGA_REPLAY_NO_WRITE: '0' } });
    const priorFetch = makeFetch((u) => liveBoard(u));
    const prior = await runPinnacleLineCapture(runnerOpts(priorStore, { fetchImpl: priorFetch }));
    assert.strictEqual(oddsCalls(priorFetch.calls).length, 2);
    assert.strictEqual(histCalls(priorFetch.calls).length, 0);
    assert.strictEqual(prior.opensFilled, 0);
    assert.strictEqual(prior.baselines, 1);
    assert.strictEqual(priorStore.blobs.get(lines.eventKey('NFL', 'evToday')).open.at, priorAt);
    const priorIdx = await master.readIndex('NFL', 'evToday', { read: priorStore.read });
    assert.strictEqual(priorIdx.open.at, priorAt);
    assert.strictEqual(priorIdx.baseline0300.at, AT3);

    cache.clearMemoryForTests();
    cache.resetKnownRequestsRemainingForTests();
    const now10 = new Date(AT10);
    const earlyBody = [boardEvent('ev10', 'pinnacle', { home: -140, away: 120 })];
    const earlyDk = [boardEvent('ev10', 'draftkings', { home: -135, away: 115 })];
    cache.rememberLivePull({
      sport: 'americanfootball_nfl',
      markets: 'h2h,spreads,totals',
      regions: 'eu',
      bookmakers: 'pinnacle',
      body: earlyBody,
      fetchedAt: new Date(now10.getTime() - 2 * 60 * 1000).toISOString(),
    });
    cache.rememberLivePull({
      sport: 'americanfootball_nfl',
      markets: 'h2h,spreads,totals',
      regions: 'eu',
      bookmakers: 'draftkings',
      body: earlyDk,
      fetchedAt: new Date(now10.getTime() - 2 * 60 * 1000).toISOString(),
    });
    const reuseFetch = makeFetch(() => { throw new Error('10:00 reused a pull younger than 5 minutes'); });
    const reused = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      etSlot: '1000',
      now: now10,
      fetchImpl: reuseFetch,
    }));
    assert.strictEqual(reuseFetch.calls.length, 0);
    assert.strictEqual(reused.cacheHits, 2);
    assert.ok(reused.wrote);

    cache.clearMemoryForTests();
    cache.rememberLivePull({
      sport: 'americanfootball_nfl',
      markets: 'h2h,spreads,totals',
      regions: 'eu',
      bookmakers: 'pinnacle',
      body: earlyBody,
      fetchedAt: new Date(now10.getTime() - 6 * 60 * 1000).toISOString(),
    });
    cache.rememberLivePull({
      sport: 'americanfootball_nfl',
      markets: 'h2h,spreads,totals',
      regions: 'eu',
      bookmakers: 'draftkings',
      body: earlyDk,
      fetchedAt: new Date(now10.getTime() - 6 * 60 * 1000).toISOString(),
    });
    const staleFetch = makeFetch((u) => liveBoard(u));
    await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      etSlot: '1000',
      now: now10,
      fetchImpl: staleFetch,
    }));
    assert.strictEqual(oddsCalls(staleFetch.calls).length, 2);
    assert.strictEqual(histCalls(staleFetch.calls).length, 0);

    const openQuotes = quoteMap('evDir', { home: -110, away: -110 }, '2026-10-12T02:00:00Z');
    const baseQuotes = quoteMap('evDir', { home: -150, away: 130 }, AT3);
    const laterQuotes = quoteMap('evDir', { home: -110, away: -110 }, AT10);
    const summary = lines.summarizeDoc({
      sport: 'NFL',
      eventId: 'evDir',
      date: DATE,
      homeTeam: HOME,
      awayTeam: AWAY,
      open: { at: '2026-10-12T02:00:00.000Z', quotes: openQuotes },
      checks: [
        { slot: '0300', at: AT3, books: { pinnacle: baseQuotes, draftkings: baseQuotes } },
        { slot: '1000', at: AT10, books: { pinnacle: laterQuotes, draftkings: laterQuotes } },
      ],
    }, { dateISO: DATE });
    const ml = summary.find((row) => row.market === 'Moneyline');
    assert.ok(ml);
    assert.strictEqual(ml.directionFrom, 'baseline-0300');
    assert.strictEqual(ml.netDirection, 'away');
    assert.ok(ml.baseline);
    assert.notStrictEqual(ml.netDirection, 'flat');

    const dupStore = memoryStore();
    const dupOpts = { read: dupStore.read, write: dupStore.write, env: { OMEGA_REPLAY_NO_WRITE: '0' } };
    const firstPrice = await master.storeQuotes({
      sport: 'NFL',
      eventId: 'evDup',
      book: 'pinnacle',
      role: 'open',
      timestamp: AT3,
      quotes: quoteMap('evDup', {}, AT3),
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: DAY,
      source: 'live',
    }, dupOpts);
    const secondPrice = await master.storeQuotes({
      sport: 'NFL',
      eventId: 'evDup',
      book: 'pinnacle',
      role: 'baseline-0300',
      timestamp: AT3,
      quotes: quoteMap('evDup', {}, AT3),
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: DAY,
      source: 'live',
    }, dupOpts);
    assert.strictEqual(firstPrice.wrote, true);
    assert.strictEqual(secondPrice.wrote, false);
    assert.strictEqual(secondPrice.reason, 'duplicate');
    assert.strictEqual(priceKeys(dupStore, 'evDup').length, 3);
    const dupIdx = await master.readIndex('NFL', 'evDup', dupOpts);
    const token = Object.keys(dupIdx.prices)[0];
    assert.ok(dupIdx.prices[token].roles.includes('open'));
    assert.ok(dupIdx.prices[token].roles.includes('baseline-0300'));
    assert.ok(!dupStore.writes.some((key) => key.startsWith('picks-') || key === 'latest-date' || key === 'picks-dates'));

    cache.resetKnownRequestsRemainingForTests();
    const floorFetch = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        const n = histCalls(floorFetch.calls).length;
        return { body: histPayload(['h' + n], date, date), remaining: n === 1 ? 48999 : 50000 };
      }
      return { body: [boardEvent('evFloor', u.searchParams.get('bookmakers') || 'pinnacle')], remaining: 50000 };
    });
    const floor = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      fetchImpl: floorFetch,
      yesterdayGames: [gameRow('h1', YDAY), gameRow('h2', YDAY_LATE)],
    }));
    assert.strictEqual(oddsCalls(floorFetch.calls).length, 2);
    assert.strictEqual(histCalls(floorFetch.calls).length, 2);
    assert.strictEqual(floor.stoppedForCredits, false);
    assert.strictEqual(floor.historicalPulls, 2);
    assert.strictEqual(floor.requestsRemaining, 50000);

    const dryStore = memoryStore();
    const dryFetch = makeFetch((u) => {
      if (u.pathname.includes('/historical/')) {
        const date = u.searchParams.get('date');
        return { body: histPayload(['evDry'], date, date), remaining: 50000 };
      }
      return liveBoard(u);
    });
    const dry = await runPinnacleLineCapture(runnerOpts(dryStore, {
      dryRun: true,
      fetchImpl: dryFetch,
      yesterdayGames: [gameRow('evDry', YDAY)],
    }));
    assert.strictEqual(dryStore.writes.length, 0);
    assert.strictEqual(dry.wrote, false);
    assert.ok(dry.reason === 'dryRun' || dry.opensFilled >= 0);

    cache.resetKnownRequestsRemainingForTests();
    const replayStore = memoryStore();
    await runPinnacleLineCapture(runnerOpts(replayStore, {
      env: { OMEGA_REPLAY_NO_WRITE: '1' },
      fetchImpl: makeFetch((u) => {
        if (u.pathname.includes('/historical/')) {
          const date = u.searchParams.get('date');
          return { body: histPayload(['evReplay'], date, date), remaining: 50000 };
        }
        return liveBoard(u);
      }),
      yesterdayGames: [gameRow('evReplay', YDAY)],
    }));
    assert.strictEqual(replayStore.writes.length, 0);

    function row(id, edge, extra) {
      return Object.assign({
        sport: 'NFL',
        eventId: id,
        homeTeam: `Home ${id}`,
        awayTeam: `Away ${id}`,
        market: 'Moneyline',
        side: `Home ${id}`,
        matchup: `Away ${id} @ Home ${id}`,
        odds: -110,
        coverProb: 0.56,
        ev: 0.05,
        edgePct: edge,
        liquid: true,
        commenceTime: DAY,
        uncertainty: 0.1,
        book: 'draftkings',
        lineMove: { oddsMoveCents: -5, steamToward: false, steamAgainst: false },
      }, extra);
    }
    const pool = [row('a', 0.04), row('b', 0.05)];
    const withContext = pool.map((c) => Object.assign({}, c, {
      lineMoveContext: { netDirection: 'away', directionFrom: 'baseline-0300', steam: true, windowMinutes: 15 },
    }));
    const gateOpts = { cardDate: DATE, asOf: '2026-10-12T14:00:00Z' };
    const gated = applyGates(pool, gateOpts);
    const gatedCtx = applyGates(withContext, gateOpts);
    assert.strictEqual(gated.rejected.length, 0, JSON.stringify(gated.rejected.map((r) => r.rejectReason)));
    assert.strictEqual(gatedCtx.rejected.length, 0, JSON.stringify(gatedCtx.rejected.map((r) => r.rejectReason)));
    const picks = selectStraights(gated.yesPool).map((c) => toPickObject(c, { modelVersion: config.MODEL_VERSION }));
    const picksCtx = selectStraights(gatedCtx.yesPool).map((c) => toPickObject(c, { modelVersion: config.MODEL_VERSION }));
    assert.deepStrictEqual(picksCtx.map((p) => p.pick), picks.map((p) => p.pick));
    assert.deepStrictEqual(picksCtx.map((p) => p.odds), picks.map((p) => p.odds));
    assert.deepStrictEqual(picksCtx.map((p) => p.units), picks.map((p) => p.units));
    assert.deepStrictEqual(picksCtx, picks);
    assert.ok(picks.every((p) => !Object.prototype.hasOwnProperty.call(p, 'lineMoveContext')));
    assert.deepStrictEqual(pool[0].lineMove, { oddsMoveCents: -5, steamToward: false, steamAgainst: false });
    assert.deepStrictEqual(withContext[0].lineMove, pool[0].lineMove);

    const clvStore = memoryStore();
    const clvOpts = { read: clvStore.read, write: clvStore.write, env: { OMEGA_REPLAY_NO_WRITE: '0' } };
    await master.storeQuotes({
      sport: 'NFL',
      eventId: 'evClv',
      book: 'pinnacle',
      role: 'close',
      timestamp: YDAY,
      quotes: quoteMap('evClv', { home: -150, away: 130 }, YDAY, YDAY),
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: YDAY,
      snapshotAt: YDAY,
      source: 'historical',
    }, clvOpts);
    let bulkCalls = 0;
    const closed = await cand.captureCandidateCloses({
      dateISO: '2026-10-11',
      nowMs: Date.parse('2026-10-12T16:00:00Z'),
      sides: [{
        sport: 'NFL',
        sportKey: 'americanfootball_nfl',
        eventId: 'evClv',
        matchup: `${AWAY} @ ${HOME}`,
        homeTeam: HOME,
        awayTeam: AWAY,
        market: 'Moneyline',
        side: HOME,
        odds: -110,
        commenceTime: YDAY,
        qualityScore: 1,
      }],
      existing: { sides: [] },
      fetchBulk: async () => { bulkCalls += 1; throw new Error('odds-master close was re-pulled'); },
      extractClose: track.extractClose,
      pickSideInfo: track.pickSideInfo,
      findMatchingGame: track.findMatchingGame,
      oddsMasterOpts: clvOpts,
      store: { async setJSON() {}, async get() { return null; } },
    });
    assert.strictEqual(bulkCalls, 0);
    assert.strictEqual(closed.plan.decisions[0].action, 'odds-master-close');
    assert.strictEqual(closed.plan.decisions[0].credits, 0);
    assert.strictEqual(closed.credits.extraCredits, 0);
    const filled = closed.payload.sides[0];
    assert.strictEqual(typeof filled.clv, 'number');
    assert.ok(Number.isFinite(filled.clv));
    assert.notStrictEqual(filled.clv, 0);
    assert.strictEqual(filled.captureMinsToCommence, 0);
    assert.strictEqual(filled.closeSnapshotAt, YDAY);

    console.log('test-omega-closes-baseline ok');
  } finally {
    cache.resetKnownRequestsRemainingForTests();
    cache.clearMemoryForTests();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
