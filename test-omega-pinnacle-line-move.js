'use strict';
/**
 * Pinnacle line log. Free /events discovery, one open per event id,
 * 3:00 / 10:00 ET checks, both-book steam. Context only.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const memo = require(path.join(root, 'fetch_memo'));
const cache = require(path.join(root, 'odds_snapshot_cache'));
const et = require('./netlify/functions/lib/et-schedule');
const lines = require('./netlify/functions/capture-omega-pinnacle-lines');
const { toPickObject } = require(path.join(root, 'select'));
const {
  runPinnacleLineCapture, pinnacleOddsUrl, draftkingsOddsUrl, pinnacleEventsUrl,
} = require(path.join(root, 'capture_runner'));
const {
  quotesFromEvent, quotesFromEvents, detectMoves, confirmSteam, centsBetween,
  probPtsBetween, applyLineMoveContext, readPinnacleLineMoves, eventKey, CHECK_SLOTS,
} = require(path.join(root, 'pinnacle_line_move'));

const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';
const DAY = '2026-10-12T20:00:00Z';
const NEXT = '2026-10-13T20:00:00Z';
const DATE = '2026-10-12';

function boardEvent(id, book, prices, commence = DAY) {
  const src = prices || {};
  const home = src.home != null ? src.home : -110;
  const away = src.away != null ? src.away : -110;
  const homePoint = src.homePoint != null ? src.homePoint : -3;
  const awayPoint = src.awayPoint != null ? src.awayPoint : 3;
  const total = src.total != null ? src.total : 47.5;
  const over = src.over != null ? src.over : -110;
  const under = src.under != null ? src.under : -110;
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
        { key: 'totals', outcomes: [{ name: 'Over', price: over, point: total }, { name: 'Under', price: under, point: total }] },
      ],
    }],
  };
}

function listedEvent(id, commence = DAY) {
  return { id, commence_time: commence, home_team: HOME, away_team: AWAY };
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
        if (want === 'content-type') return 'application/json';
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
    const out = decide(u, calls.length);
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
    now: new Date('2026-10-12T15:00:00Z'),
    read: store.read,
    write: store.write,
  }, extra);
}

function oddsCalls(calls) {
  return calls.filter((u) => u.pathname.endsWith('/odds'));
}

function eventCalls(calls) {
  return calls.filter((u) => u.pathname.endsWith('/events'));
}

function sideMove(doc, market, side, book) {
  return (doc.moves || []).find((m) => m.market === market && m.side === side && m.book === book);
}

function synthetic(partial) {
  return Object.assign({
    sport: 'NFL',
    eventId: 'ev1',
    book: 'pinnacle',
    market: 'Spread',
    side: 'home',
    cents: 0,
    probPts: 0,
    pointChange: 0,
    fromSlot: null,
    toSlot: null,
    at: '2026-10-12T13:00:00Z',
  }, partial);
}

function scheduler(now) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
    now,
  };
}

(async () => {
  cache.resetKnownRequestsRemainingForTests();
  try {
    assert.strictEqual(config.MODEL_VERSION, 'v12.3.51-omega-vnext-price-lock');
    assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.51-omega-vnext-price-lock:'));
    assert.strictEqual(config.STEAM_WINDOW_MIN, 15);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.creditFloor, 49000);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.steamProbPts, 3);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.steamLinePoints, 0.5);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.windowMinutes, 15);
    assert.strictEqual(config.PINNACLE_LINE_MOVE.secondaryBookmakers, 'draftkings');
    assert.strictEqual(memo.PINNACLE_CREDIT_FLOOR, 49000);
    assert.deepStrictEqual(CHECK_SLOTS, ['0300', '1000']);

    const eventsUrl = new URL(pinnacleEventsUrl('americanfootball_nfl', 'test-key-1234'));
    assert.strictEqual(eventsUrl.pathname, '/v4/sports/americanfootball_nfl/events');
    assert.strictEqual(eventsUrl.searchParams.get('markets'), null);
    assert.strictEqual(eventsUrl.searchParams.get('regions'), null);
    assert.strictEqual(eventsUrl.searchParams.get('bookmakers'), null);
    assert.strictEqual(eventsUrl.searchParams.get('date'), null);
    assert.ok(!eventsUrl.href.includes('historical'));
    const pinUrl = new URL(pinnacleOddsUrl('americanfootball_nfl', 'test-key-1234'));
    assert.strictEqual(pinUrl.pathname, '/v4/sports/americanfootball_nfl/odds');
    assert.strictEqual(pinUrl.searchParams.get('regions'), 'eu');
    assert.strictEqual(pinUrl.searchParams.get('bookmakers'), 'pinnacle');
    assert.strictEqual(pinUrl.searchParams.get('markets'), 'h2h,spreads,totals');
    assert.strictEqual(pinUrl.searchParams.get('date'), null);
    assert.ok(!pinUrl.href.includes('historical'));
    const dkUrl = new URL(draftkingsOddsUrl('americanfootball_nfl', 'test-key-1234'));
    assert.strictEqual(dkUrl.searchParams.get('bookmakers'), 'draftkings');
    assert.strictEqual(dkUrl.searchParams.get('regions'), 'eu');
    assert.strictEqual(dkUrl.searchParams.get('date'), null);

    const openQuotes = quotesFromEvent(boardEvent('ev1', 'pinnacle'), 'NFL', { at: '2026-10-12T02:00:00Z' }, 'pinnacle');
    const movedQuotes = quotesFromEvent(
      boardEvent('ev1', 'pinnacle', { home: -120, away: 100, homePoint: -3.5, awayPoint: 3.5 }),
      'NFL',
      { at: '2026-10-12T07:00:00Z' },
      'pinnacle',
    );
    assert.strictEqual(detectMoves({}, openQuotes, { at: '2026-10-12T02:00:00Z' }).length, 0);
    const sized = detectMoves(openQuotes, movedQuotes, { at: '2026-10-12T07:00:00Z', fromSlot: 'open', toSlot: '0300' });
    const spreadHome = sized.find((m) => m.market === 'Spread' && m.side === 'home');
    const openHome = Object.values(openQuotes).find((q) => q.market === 'Spread' && q.side === 'home');
    const nextHome = Object.values(movedQuotes).find((q) => q.market === 'Spread' && q.side === 'home');
    assert.strictEqual(spreadHome.side, 'home');
    assert.strictEqual(spreadHome.cents, -10);
    assert.strictEqual(spreadHome.cents, centsBetween(-110, -120));
    assert.strictEqual(spreadHome.pointChange, -0.5);
    assert.strictEqual(spreadHome.probPts, probPtsBetween(openHome.noVig, nextHome.noVig));
    assert.ok(Math.abs(spreadHome.probPts) < 3);
    assert.strictEqual(spreadHome.at, '2026-10-12T07:00:00Z');
    assert.deepStrictEqual(
      quotesFromEvents(
        [boardEvent('off', 'pinnacle', {}, NEXT)],
        'NFL',
        { at: '2026-10-12T07:00:00Z', dateISO: DATE },
        'pinnacle',
      ),
      {},
    );

    const longGap = {
      fromSlot: '0300',
      toSlot: '1000',
      fromAt: '2026-10-12T07:00:00Z',
      toAt: '2026-10-12T14:00:00.000Z',
    };
    const bothProb = confirmSteam(synthetic({ probPts: 3.1 }), synthetic({ book: 'draftkings', probPts: 3.1 }), longGap);
    assert.ok(bothProb);
    assert.strictEqual(bothProb.windowMinutes, 15);
    assert.strictEqual(bothProb.reason, 'prob');
    assert.strictEqual(bothProb.direction, 'up');
    assert.strictEqual(confirmSteam(synthetic({ probPts: 2 }), synthetic({ book: 'draftkings', probPts: 2 }), longGap), null);
    assert.strictEqual(confirmSteam(synthetic({ probPts: 4 }), null, longGap), null);
    assert.strictEqual(confirmSteam(synthetic({ probPts: 4 }), synthetic({ book: 'draftkings', probPts: -4 }), longGap), null);
    const bothLine = confirmSteam(
      synthetic({ pointChange: -0.5, market: 'Spread' }),
      synthetic({ book: 'draftkings', pointChange: -0.5, market: 'Spread' }),
      longGap,
    );
    assert.ok(bothLine);
    assert.strictEqual(bothLine.windowMinutes, 15);
    assert.ok(bothLine.reason.includes('line'));
    assert.strictEqual(confirmSteam(
      synthetic({ pointChange: -0.5 }),
      synthetic({ book: 'draftkings', pointChange: 0.5 }),
      longGap,
    ), null);
    assert.strictEqual(confirmSteam(
      synthetic({ market: 'Moneyline', pointChange: 0.5, probPts: 0 }),
      synthetic({ book: 'draftkings', market: 'Moneyline', pointChange: 0.5, probPts: 0 }),
      longGap,
    ), null);
    assert.strictEqual(confirmSteam(
      synthetic({ probPts: 3, pointChange: 0 }),
      synthetic({ book: 'draftkings', probPts: 0, pointChange: -0.5 }),
      longGap,
    ), null);
    const dense = confirmSteam(
      synthetic({ probPts: 3, at: '2026-10-12T13:10:00Z' }),
      synthetic({ book: 'draftkings', probPts: 3, at: '2026-10-12T13:10:00Z' }),
      { fromAt: '2026-10-12T13:00:00Z', toAt: '2026-10-12T13:10:00Z' },
    );
    assert.ok(dense);
    assert.strictEqual(dense.windowMinutes, 15);
    const edge = confirmSteam(
      synthetic({ probPts: 3, at: '2026-10-12T13:15:00Z' }),
      synthetic({ book: 'draftkings', probPts: 3, at: '2026-10-12T13:15:00Z' }),
      { fromAt: '2026-10-12T13:00:00Z', toAt: '2026-10-12T13:15:00Z' },
    );
    assert.ok(edge);
    assert.strictEqual(edge.windowMinutes, 15);
    assert.strictEqual(confirmSteam(
      synthetic({ probPts: 5, at: '2026-10-12T13:20:00Z' }),
      synthetic({ book: 'draftkings', probPts: 5, at: '2026-10-12T13:20:00Z' }),
      { fromAt: '2026-10-12T13:00:00Z', toAt: '2026-10-12T13:20:00Z' },
    ), null);

    const store = memoryStore();
    let listed = [listedEvent('ev1'), listedEvent('ev2', NEXT)];
    let phase = 'open';
    const fetchImpl = makeFetch((u) => {
      const book = u.searchParams.get('bookmakers') || 'pinnacle';
      if (u.pathname.endsWith('/events')) return { body: listed.slice(), remaining: 50000 };
      if (phase === 'open') {
        return {
          body: listed.map((row) => boardEvent(row.id, 'pinnacle', {}, row.commence_time)),
          remaining: 50000,
        };
      }
      if (phase === '0300') {
        if (book === 'pinnacle') {
          return {
            body: [boardEvent('ev1', 'pinnacle', { home: -120, away: 100, homePoint: -3.5, awayPoint: 3.5 })],
            remaining: 50000,
          };
        }
        return { body: [boardEvent('ev1', 'draftkings')], remaining: 50000 };
      }
      const jumped = { home: -150, away: 130, homePoint: -3.5, awayPoint: 3.5 };
      return { body: [boardEvent('ev1', book, jumped)], remaining: 50000 };
    });

    const first = await runPinnacleLineCapture(runnerOpts(store, { mode: 'open', fetchImpl }));
    assert.strictEqual(eventCalls(fetchImpl.calls).length, 1);
    assert.strictEqual(oddsCalls(fetchImpl.calls).length, 1);
    assert.strictEqual(oddsCalls(fetchImpl.calls)[0].searchParams.get('bookmakers'), 'pinnacle');
    assert.strictEqual(first.pulls, 1);
    assert.strictEqual(first.wrote, true);
    const openAt = store.blobs.get(eventKey('NFL', 'ev1')).open.at;
    const openAt2 = store.blobs.get(eventKey('NFL', 'ev2')).open.at;
    assert.ok(openAt);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev2')).date, '2026-10-13');
    const writesAfterOpen = store.writes.length;
    assert.ok(store.writes.every((key) => key.startsWith('NFL/') || key.startsWith('date/')));
    assert.ok(!store.writes.some((key) => key.startsWith('picks-') || key === 'latest-date' || key === 'picks-dates'));

    const second = await runPinnacleLineCapture(runnerOpts(store, { mode: 'open', fetchImpl }));
    assert.strictEqual(oddsCalls(fetchImpl.calls).length, 1);
    assert.strictEqual(eventCalls(fetchImpl.calls).length, 2);
    assert.strictEqual(second.pulls, 0);
    assert.strictEqual(second.wrote, false);
    assert.strictEqual(store.writes.length, writesAfterOpen);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev1')).open.at, openAt);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev2')).open.at, openAt2);

    listed = listed.concat([listedEvent('ev3')]);
    phase = 'open';
    const third = await runPinnacleLineCapture(runnerOpts(store, { mode: 'open', fetchImpl }));
    assert.strictEqual(third.pulls, 1);
    assert.strictEqual(oddsCalls(fetchImpl.calls).length, 2);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev1')).open.at, openAt);
    assert.ok(store.blobs.get(eventKey('NFL', 'ev3')).open);
    const today = await readPinnacleLineMoves(DATE, { read: store.read });
    assert.ok(today.events.some((row) => row.eventId === 'ev1'));
    assert.ok(!today.events.some((row) => row.eventId === 'ev2'));

    phase = '0300';
    const at3 = await runPinnacleLineCapture(runnerOpts(store, {
      mode: 'check',
      etSlot: '0300',
      now: new Date('2026-10-12T07:00:00Z'),
      fetchImpl,
    }));
    assert.strictEqual(at3.pulls, 2);
    const books3 = oddsCalls(fetchImpl.calls).slice(-2).map((u) => u.searchParams.get('bookmakers')).sort();
    assert.deepStrictEqual(books3, ['draftkings', 'pinnacle']);
    assert.ok(fetchImpl.calls.every((u) => u.searchParams.get('date') == null && !u.href.includes('historical')));
    const after3 = store.blobs.get(eventKey('NFL', 'ev1'));
    const logged = sideMove(after3, 'Spread', 'home', 'pinnacle');
    assert.strictEqual(logged.fromSlot, 'open');
    assert.strictEqual(logged.toSlot, '0300');
    assert.strictEqual(logged.side, 'home');
    assert.strictEqual(logged.cents, -10);
    assert.strictEqual(logged.pointChange, -0.5);
    assert.ok(logged.probPts != null && Math.abs(logged.probPts) < 3);
    assert.strictEqual(logged.at, '2026-10-12T07:00:00.000Z');
    assert.strictEqual(after3.steams.length, 0);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev1')).open.at, openAt);
    const movesAfter3 = after3.moves.length;

    phase = '1000';
    const at10 = await runPinnacleLineCapture(runnerOpts(store, {
      mode: 'check',
      etSlot: '1000',
      now: new Date('2026-10-12T14:00:00Z'),
      fetchImpl,
    }));
    assert.ok(at10.steamCount >= 1);
    const after10 = store.blobs.get(eventKey('NFL', 'ev1'));
    const steam = after10.steams.find((row) => row.market === 'Spread' && row.side === 'home');
    assert.ok(steam);
    assert.strictEqual(steam.windowMinutes, 15);
    assert.strictEqual(steam.fromSlot, '0300');
    assert.strictEqual(steam.toSlot, '1000');
    assert.ok(steam.pinnacle && steam.draftkings);
    assert.ok(steam.pinnacle.probPts >= 3);
    assert.ok(steam.draftkings.probPts >= 3);
    assert.ok(after10.moves.length > movesAfter3);
    const tenMove = after10.moves.find((m) => m.toSlot === '1000' && m.market === 'Spread' && m.side === 'home' && m.book === 'pinnacle');
    assert.strictEqual(tenMove.fromSlot, '0300');
    assert.ok(tenMove.probPts >= 3);
    assert.strictEqual(tenMove.at, '2026-10-12T14:00:00.000Z');

    const steamsBeforeDup = after10.steams.length;
    const movesBeforeDup = after10.moves.length;
    const dup = await runPinnacleLineCapture(runnerOpts(store, {
      mode: 'check',
      etSlot: '1000',
      now: new Date('2026-10-12T14:00:00Z'),
      fetchImpl,
    }));
    assert.strictEqual(dup.wrote, false);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev1')).moves.length, movesBeforeDup);
    assert.strictEqual(store.blobs.get(eventKey('NFL', 'ev1')).steams.length, steamsBeforeDup);

    phase = '1030';
    const at1030 = await runPinnacleLineCapture(runnerOpts(store, {
      mode: 'check',
      etSlot: '1030',
      now: new Date('2026-10-12T14:30:00Z'),
      fetchImpl,
    }));
    assert.strictEqual(at1030.skipped, 'slot');
    assert.strictEqual(at1030.pulls, 0);
    const slate = await readPinnacleLineMoves(DATE, { read: store.read });
    const games = slate.events.find((row) => row.eventId === 'ev1');
    assert.ok(!games.checks.some((row) => row.slot === '1030'));
    assert.ok(games.checks.some((row) => row.slot === '1000'));
    assert.strictEqual(games.open.at, openAt);

    const candidate = {
      sport: 'NFL',
      eventId: 'ev1',
      homeTeam: HOME,
      awayTeam: AWAY,
      market: 'Spread',
      side: HOME,
      matchup: `${AWAY} @ ${HOME}`,
      odds: -110,
      coverProb: 0.55,
      line: -3,
      lineMove: { oddsMoveCents: -5, steamToward: true, steamAgainst: false },
    };
    const pick = toPickObject(candidate, { modelVersion: config.MODEL_VERSION });
    const picks = [pick];
    const parlayLegs = [{ leg: 1, lineMove: candidate.lineMove }];
    const audit = { configHash: 'hash-1', modelVersion: config.MODEL_VERSION };
    const beforePicks = JSON.stringify(picks);
    const beforeLegs = JSON.stringify(parlayLegs);
    const beforeAudit = JSON.stringify(audit);
    const withDoc = applyLineMoveContext({
      picks,
      parlayLegs,
      candidates: [candidate],
      audit,
      doc: slate,
      dateISO: DATE,
    });
    assert.strictEqual(withDoc.picks, picks);
    assert.strictEqual(withDoc.parlayLegs, parlayLegs);
    assert.strictEqual(JSON.stringify(withDoc.picks), beforePicks);
    assert.strictEqual(JSON.stringify(withDoc.parlayLegs), beforeLegs);
    assert.strictEqual(candidate.lineMove.oddsMoveCents, -5);
    assert.notStrictEqual(withDoc.candidates[0], candidate);
    assert.notStrictEqual(withDoc.candidates[0].lineMove, candidate.lineMove);
    assert.strictEqual(withDoc.candidates[0].lineMove.eventId, 'ev1');
    assert.strictEqual(withDoc.candidates[0].lineMove.windowMinutes, 15);
    assert.strictEqual(withDoc.candidates[0].lineMoveContext.windowMinutes, 15);
    assert.ok(withDoc.candidates[0].lineMove.steams.some((row) => row.windowMinutes === 15));
    assert.strictEqual(withDoc.audit.configHash, 'hash-1');
    assert.ok(withDoc.audit.lineMove);
    assert.strictEqual(JSON.stringify(audit), beforeAudit);
    const without = applyLineMoveContext({
      picks, parlayLegs, candidates: [candidate], audit, doc: null, dateISO: DATE,
    });
    assert.strictEqual(without.audit, audit);
    assert.strictEqual(without.picks, picks);
    assert.strictEqual(without.candidates[0], candidate);
    assert.strictEqual(JSON.stringify(without.picks), beforePicks);
    assert.ok(!Object.prototype.hasOwnProperty.call(without.audit, 'lineMove'));

    cache.resetKnownRequestsRemainingForTests();
    const floorLogs = [];
    const origLog = console.log;
    console.log = (...args) => { floorLogs.push(args.map((part) => String(part)).join(' ')); };
    try {
      const floorStore = memoryStore();
      const floorFetch = makeFetch((u) => {
        const sport = u.pathname.includes('baseball') ? 'MLB' : 'NFL';
        const book = u.searchParams.get('bookmakers') || 'pinnacle';
        const remaining = floorFetch.calls.length === 1 ? 48999 : 50000;
        return { body: [boardEvent('evFloor', book, {}, DAY)], remaining, sport };
      });
      const stopped = await runPinnacleLineCapture(runnerOpts(floorStore, {
        mode: 'check',
        etSlot: '0300',
        labels: ['MLB', 'NFL'],
        now: new Date('2026-10-12T07:00:00Z'),
        fetchImpl: floorFetch,
      }));
      assert.strictEqual(stopped.pulls, 4);
      assert.strictEqual(stopped.stoppedForCredits, false);
      assert.strictEqual(oddsCalls(floorFetch.calls).length, 4);
      assert.ok(floorLogs.some((line) => line.includes('x-requests-remaining=48999')));
      assert.ok(!floorLogs.some((line) => line.includes('credit floor stop')));

      cache.resetKnownRequestsRemainingForTests();
      const okFetch = makeFetch((u) => {
        const book = u.searchParams.get('bookmakers') || 'pinnacle';
        return { body: [boardEvent('evOk', book)], remaining: 49000 };
      });
      const allowed = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
        mode: 'check',
        etSlot: '1000',
        labels: ['MLB', 'NFL'],
        now: new Date('2026-10-12T14:00:00Z'),
        fetchImpl: okFetch,
      }));
      assert.strictEqual(allowed.stoppedForCredits, false);
      assert.strictEqual(allowed.pulls, 4);

      cache.clearMemoryForTests();
      cache.noteKnownRequestsRemaining(48999);
      const blockedFetch = makeFetch(() => ({ body: [boardEvent('evX', 'pinnacle')], remaining: 50000 }));
      const blocked = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
        mode: 'check',
        etSlot: '1000',
        labels: ['MLB', 'NFL'],
        now: new Date('2026-10-12T14:00:00Z'),
        fetchImpl: blockedFetch,
      }));
      assert.strictEqual(blocked.pulls, 4);
      assert.strictEqual(oddsCalls(blockedFetch.calls).length, 4);
      assert.strictEqual(blocked.stoppedForCredits, false);

      cache.resetKnownRequestsRemainingForTests();
      cache.noteKnownRequestsRemaining(48999);
      const openBlockedFetch = makeFetch((u) => {
        if (u.pathname.endsWith('/events')) return { body: [listedEvent('evNew')], remaining: null };
        return { body: [boardEvent('evNew', 'pinnacle')], remaining: 50000 };
      });
      const openBlocked = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
        mode: 'open',
        fetchImpl: openBlockedFetch,
      }));
      assert.strictEqual(openBlocked.eventPolls, 1);
      assert.strictEqual(openBlocked.pulls, 0);
      assert.strictEqual(oddsCalls(openBlockedFetch.calls).length, 0);
      assert.strictEqual(eventCalls(openBlockedFetch.calls).length, 1);

      cache.resetKnownRequestsRemainingForTests();
      const headerFetch = makeFetch((u) => {
        if (u.pathname.endsWith('/events')) return { body: [listedEvent('evHdr')], remaining: 48999 };
        return { body: [boardEvent('evHdr', 'pinnacle')], remaining: 50000 };
      });
      const headerStop = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
        mode: 'open',
        fetchImpl: headerFetch,
      }));
      assert.strictEqual(headerStop.eventPolls, 1);
      assert.strictEqual(headerStop.pulls, 0);
      assert.ok(floorLogs.some((line) => line.includes('x-requests-remaining=48999')));
    } finally {
      console.log = origLog;
      cache.resetKnownRequestsRemainingForTests();
    }

    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-pin-cache-'));
    const prevCache = process.env.ODDS_SNAPSHOT_CACHE_DIR;
    process.env.ODDS_SNAPSHOT_CACHE_DIR = cacheDir;
    cache.clearMemoryForTests();
    cache.resetKnownRequestsRemainingForTests();
    try {
      const cacheFetch = makeFetch((u) => {
        const book = u.searchParams.get('bookmakers') || 'pinnacle';
        return { body: [boardEvent('evCache', book)], remaining: 50000 };
      });
      const cacheStore = memoryStore();
      const opts = {
        mode: 'check',
        etSlot: '0300',
        now: new Date('2026-10-12T07:00:00Z'),
        fetchImpl: cacheFetch,
      };
      const cold = await runPinnacleLineCapture(runnerOpts(cacheStore, opts));
      assert.strictEqual(cold.pulls, 2);
      assert.strictEqual(cacheFetch.calls.length, 2);
      cache.clearMemoryForTests();
      const warm = await runPinnacleLineCapture(runnerOpts(cacheStore, opts));
      assert.strictEqual(cacheFetch.calls.length, 2);
      assert.ok(warm.cacheHits >= 2);
    } finally {
      if (prevCache == null) delete process.env.ODDS_SNAPSHOT_CACHE_DIR;
      else process.env.ODDS_SNAPSHOT_CACHE_DIR = prevCache;
      cache.clearMemoryForTests();
      cache.resetKnownRequestsRemainingForTests();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    const dryFetch = makeFetch(() => ({ body: [boardEvent('evDry', 'pinnacle')], remaining: 50000 }));
    const dryEvents = makeFetch((u) => {
      if (u.pathname.endsWith('/events')) return { body: [listedEvent('evDry')], remaining: 50000 };
      return { body: [boardEvent('evDry', 'pinnacle')], remaining: 50000 };
    });
    const dry = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      mode: 'open',
      dryRun: true,
      fetchImpl: dryEvents,
      write() { throw new Error('dry-run wrote'); },
    }));
    assert.strictEqual(dry.wrote, false);
    assert.strictEqual(dry.reason, 'dryRun');
    assert.strictEqual(dry.pulls, 1);
    const replay = await runPinnacleLineCapture(runnerOpts(memoryStore(), {
      mode: 'check',
      etSlot: '0300',
      now: new Date('2026-10-12T07:00:00Z'),
      fetchImpl: dryFetch,
      env: { OMEGA_REPLAY_NO_WRITE: '1' },
      write() { throw new Error('replay wrote'); },
    }));
    assert.strictEqual(replay.wrote, false);
    assert.strictEqual(replay.reason, 'OMEGA_REPLAY_NO_WRITE');

    const sched = (unused) => ({
      httpMethod: 'POST',
      headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
      body: JSON.stringify({ next_run: '2099-01-01T00:00:00.000Z' }),
    });
    void sched;
    void scheduler;
    const off = await lines.handleCapture(sched(), 'capture-omega-pinnacle-lines', {
      now: new Date('2026-10-12T11:00:00Z'),
      apiKey: 'test-key-1234',
      fetchImpl() { throw new Error('off-slot fetched'); },
    });
    assert.strictEqual(JSON.parse(off.body).skipped, 'et-guard');

    async function slotBody(iso, name) {
      const calls = [];
      const fetchSlot = async (url) => {
        const u = new URL(url);
        calls.push(u);
        const book = u.searchParams.get('bookmakers') || 'pinnacle';
        const body = u.pathname.endsWith('/events')
          ? [listedEvent('evSlot')]
          : [boardEvent('evSlot', book)];
        return responder(body, 50000);
      };
      const slotStore = memoryStore();
      const res = await lines.handleCapture(sched(), name, {
        now: new Date(iso),
        apiKey: 'test-key-1234',
        labels: ['NFL'],
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        fetchImpl: fetchSlot,
        read: slotStore.read,
        write: slotStore.write,
      });
      return { body: JSON.parse(res.body), calls };
    }
    const edt3 = await slotBody('2026-10-12T07:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(edt3.body.etSlot, '0300');
    assert.strictEqual(edt3.body.mode, 'check');
    assert.strictEqual(eventCalls(edt3.calls).length, 0);
    assert.strictEqual(oddsCalls(edt3.calls).length, 2);
    const edt9 = await slotBody('2026-10-12T13:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(edt9.body.skipped, 'et-guard');
    assert.strictEqual(edt9.calls.length, 0);
    const edt10 = await slotBody('2026-10-12T14:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(edt10.body.etSlot, '1000');
    assert.strictEqual(oddsCalls(edt10.calls).length, 2);
    const edt1030 = await slotBody('2026-10-12T14:30:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(edt1030.body.skipped, 'et-guard');
    assert.strictEqual(edt1030.calls.length, 0);
    const est3 = await slotBody('2027-01-15T08:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(est3.body.etSlot, '0300');
    const est9 = await slotBody('2027-01-15T14:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(est9.body.skipped, 'et-guard');
    assert.strictEqual(est9.calls.length, 0);
    const est10 = await slotBody('2027-01-15T15:00:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(est10.body.etSlot, '1000');
    const est1030 = await slotBody('2027-01-15T15:30:00Z', 'capture-omega-pinnacle-lines');
    assert.strictEqual(est1030.body.skipped, 'et-guard');
    assert.strictEqual(est1030.calls.length, 0);
    const estOff = await lines.handleCapture(sched(), 'capture-omega-pinnacle-lines', {
      now: new Date('2027-01-15T07:00:00Z'),
      fetchImpl() { throw new Error('est off-slot fetched'); },
    });
    assert.strictEqual(JSON.parse(estOff.body).skipped, 'et-guard');
    const openSlot = await slotBody('2026-10-12T16:00:00Z', 'capture-omega-pinnacle-open');
    assert.strictEqual(openSlot.body.skipped, 'odds-api-window');
    assert.strictEqual(openSlot.calls.length, 0);

    assert.deepStrictEqual(et.ET_SCHEDULE['capture-omega-pinnacle-lines'].etTimes, ['03:00', '10:00']);
    assert.ok(!et.ET_SCHEDULE['capture-omega-pinnacle-open']);
    assert.ok(!et.ET_SCHEDULE['capture-omega-pinnacle-lines-open']);
    assert.ok(!et.ET_SCHEDULE['capture-omega-lines']);
    assert.ok(!et.ET_SCHEDULE['capture-omega-lines-late']);
    assert.ok(!et.ET_SCHEDULE['capture-candidate-closes']);
    const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
    const active = et.activeTomlSchedules(toml);
    const cronOf = (name) => active.find((row) => row.functionName === name).cron;
    const linesCron = et.parseCron(cronOf('capture-omega-pinnacle-lines'));
    for (const slot of ['03:00', '10:00']) {
      const want = et.utcHoursForEt(slot);
      assert.ok(linesCron.minute.has(want.minute), slot);
      for (const hour of want.hours) assert.ok(linesCron.hour.has(hour), `${slot} ${hour}`);
    }
    for (const name of ['capture-omega-pinnacle-open', 'capture-omega-lines', 'capture-omega-lines-late', 'capture-candidate-closes']) {
      assert.ok(!active.some((row) => row.functionName === name), name);
    }
    assert.ok(!toml.includes('capture-omega-pinnacle-lines-open'));

    const guard3 = et.etGuard('capture-omega-pinnacle-lines', sched(), new Date('2026-10-12T07:00:00Z'));
    assert.strictEqual(guard3.run, true);
    assert.strictEqual(guard3.matched, '03:00');
    const guardSkip = et.etGuard('capture-omega-pinnacle-lines', sched(), new Date('2026-10-12T11:00:00Z'));
    assert.strictEqual(guardSkip.run, false);
    const guardEst = et.etGuard('capture-omega-pinnacle-lines', sched(), new Date('2027-01-15T15:30:00Z'));
    assert.strictEqual(guardEst.run, false);
    assert.strictEqual(guardEst.matched, null);

    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const applyAt = indexSrc.indexOf('applyLineMoveContext({');
    assert.ok(applyAt > indexSrc.indexOf('toPickObject('));
    assert.ok(!indexSrc.slice(applyAt).includes('toPickObject('));
    assert.ok(indexSrc.includes('lineMoveContext'));
    assert.ok(!/pools\[i\]\.lineMove\s*=/.test(indexSrc));
    const captureSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-omega-pinnacle-lines.js'), 'utf8');
    const openSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-omega-pinnacle-open.js'), 'utf8');
    assert.ok(!captureSrc.includes('storePicks'));
    assert.ok(!captureSrc.includes('picks-dates'));
    assert.ok(!captureSrc.includes('latest-date'));
    assert.ok(!openSrc.includes('storePicks'));
    assert.strictEqual(lines.handler.length <= 2, true);
    const openHandler = require('./netlify/functions/capture-omega-pinnacle-open');
    assert.ok(openHandler.handler.length <= 2);

    console.log('test-omega-pinnacle-line-move ok');
  } finally {
    cache.resetKnownRequestsRemainingForTests();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
