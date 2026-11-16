'use strict';

/**
 * 3 AM historical closes. Fixtures only. No Odds API, no production blobs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const C = require('./netlify/functions/lib/closes-3am');
const FB = require('./netlify/functions/lib/full-board-closes');
const cap = require('./netlify/functions/capture-pick-closes');
const pull3 = require('./netlify/functions/capture-odds-3am');
const bg = require('./netlify/functions/capture-closes-3am-background');
const track = require('./netlify/functions/track-clv-omega');

function memBlobs(seed) {
  const data = new Map();
  for (const [key, value] of Object.entries(seed || {})) data.set(key, value);
  return {
    data,
    async get(store, key) {
      const id = `${store}:${key}`;
      return data.has(id) ? data.get(id) : null;
    },
    async set(store, key, value) {
      data.set(`${store}:${key}`, JSON.parse(JSON.stringify(value)));
      return true;
    },
    async list() { return []; },
  };
}

function headers(map) {
  return { get(name) { return map[String(name).toLowerCase()] || null; } };
}

function oddsResponse(body, extra) {
  const raw = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: headers(Object.assign({
      'x-requests-last': '60',
      'x-requests-remaining': '50000',
    }, extra || {})),
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

function event(id, home, away, commence, books) {
  return {
    id,
    sport_key: 'basketball_nba',
    commence_time: commence,
    home_team: home,
    away_team: away,
    bookmakers: books || [pinnacleBook(home, away)],
  };
}

function pinnacleBook(home, away, market) {
  const key = market || 'h2h';
  const outcomes = key === 'h2h'
    ? [{ name: home, price: -150 }, { name: away, price: 130 }]
    : [{ name: home, price: -110, point: -3.5 }, { name: away, price: -110, point: 3.5 }];
  return {
    key: 'pinnacle',
    last_update: '2026-11-15T17:59:00Z',
    markets: [{ key, last_update: '2026-11-15T17:59:00Z', outcomes }],
  };
}

function wrapped(events, timestamp) {
  return { data: events, timestamp: timestamp || '2026-11-15T17:59:00Z', previous_timestamp: '2026-11-15T17:54:00Z' };
}

(async () => {
  assert.strictEqual(C.EST_COST, 60);
  assert.strictEqual(C.REGION_EQUIVALENTS, 2);
  assert.strictEqual(C.DEFAULT_CAP, 3675);
  assert.strictEqual(C.RESERVE_FLOOR, 10000);
  assert.strictEqual(C.BOOKS.length, 14);
  assert.ok(C.BOOKS.includes('pinnacle'));
  assert.ok(C.BOOKS.includes('williamhill_us'));
  assert.ok(C.BOOKS.includes('hardrockbet_fl'));
  assert.strictEqual(C.closesAt3amEnabled({}), true);
  assert.strictEqual(C.closesAt3amEnabled({ OMEGA_CLOSES_AT_3AM: 'off' }), false);
  assert.strictEqual(C.dateAllowed('2026-11-15', '2026-11-16'), true);
  assert.strictEqual(C.dateAllowed('2026-11-09', '2026-11-16'), true);
  assert.strictEqual(C.dateAllowed('2026-11-08', '2026-11-16'), false);
  assert.strictEqual(C.dateAllowed('2026-11-16', '2026-11-16'), false);

  const same = C.planBuckets([
    { sport: 'NBA', commenceTime: '2026-11-15T18:00:00Z', roles: new Set(['board']), picks: [] },
    { sport: 'NBA', commenceTime: '2026-11-15T18:10:00Z', roles: new Set(['board']), picks: [] },
    { sport: 'NBA', commenceTime: '2026-11-15T18:10:01Z', roles: new Set(['board']), picks: [] },
    { sport: 'NHL', commenceTime: '2026-11-15T18:00:00Z', roles: new Set(['board']), picks: [] },
  ]);
  const nba = same.filter((bucket) => bucket.sport === 'NBA');
  const nhl = same.filter((bucket) => bucket.sport === 'NHL');
  assert.strictEqual(nba.length, 2, '10-minute bucket splits after the window');
  assert.strictEqual(nhl.length, 1, 'sports do not share a call');
  assert.strictEqual(nba[0].games.length, 2);
  assert.strictEqual(nba[0].snapshotAt, '2026-11-15T17:59:00Z');
  assert.strictEqual(nba[0].fallbackAt, '2026-11-15T17:45:00Z');
  assert.strictEqual(nba[0].from, '2026-11-15T17:30:00Z');
  assert.strictEqual(nba[0].to, '2026-11-15T18:40:00Z');
  assert.strictEqual(nba[1].snapshotAt, '2026-11-15T18:09:01Z');
  assert.strictEqual(nba[1].fallbackAt, '2026-11-15T17:55:01Z');
  assert.strictEqual(nba[1].from, '2026-11-15T17:40:01Z');
  assert.strictEqual(nba[1].to, '2026-11-15T18:40:01Z');

  const ordered = C.planBuckets([
    { sport: 'NBA', commenceTime: '2026-11-15T18:00:00Z', roles: new Set(['board']), picks: [] },
    { sport: 'NHL', commenceTime: '2026-11-15T23:00:00Z', roles: new Set(['card']), picks: [] },
    { sport: 'NFL', commenceTime: '2026-11-15T20:00:00Z', roles: new Set(['candidate']), picks: [] },
  ]);
  assert.deepStrictEqual(ordered.map((bucket) => bucket.sport), ['NHL', 'NFL', 'NBA']);
  assert.strictEqual(ordered[0].priority, 0);

  const unpacked = C.unwrapHistorical(wrapped([{ id: 'e1' }], '2026-11-15T17:59:00Z'));
  assert.strictEqual(unpacked.events.length, 1);
  assert.strictEqual(unpacked.events[0].id, 'e1');
  assert.strictEqual(unpacked.timestamp, '2026-11-15T17:59:00Z');
  assert.strictEqual(unpacked.previous_timestamp, '2026-11-15T17:54:00Z');
  assert.strictEqual(C.unwrapHistorical([{ id: 'raw' }]).events[0].id, 'raw');

  const siblingEvents = [
    event('keep', 'Celtics', 'Knicks', '2026-11-15T18:00:00Z'),
  ];
  const missingPick = {
    kind: 'card', sport: 'NBA', matchup: 'Heat @ Magic', pick: 'Magic ML', market: 'h2h',
    eventId: 'gone', homeTeam: 'Magic', awayTeam: 'Heat', commenceTime: '2026-11-15T18:05:00Z',
  };
  const keptPick = {
    kind: 'card', sport: 'NBA', matchup: 'Knicks @ Celtics', pick: 'Celtics ML', market: 'h2h',
    eventId: 'keep', homeTeam: 'Celtics', awayTeam: 'Knicks', commenceTime: '2026-11-15T18:00:00Z',
  };
  assert.strictEqual(C.assessPick(missingPick, siblingEvents).reason, 'not-in-historical-snapshot');
  assert.strictEqual(C.assessPick(keptPick, siblingEvents).status, 'closed');
  const unpriced = event('gone', 'Magic', 'Heat', '2026-11-15T18:05:00Z', [{
    key: 'fanduel',
    markets: [{ key: 'h2h', outcomes: [{ name: 'Magic', price: -120 }, { name: 'Heat', price: 100 }] }],
  }]);
  assert.strictEqual(C.assessPick(missingPick, [unpriced]).reason, 'pinnacle-not-priced');

  const vegas = {
    id: 'van-vgk',
    sport_key: 'icehockey_nhl',
    commence_time: '2026-11-16T02:10:00Z',
    home_team: 'Vegas Golden Knights',
    away_team: 'Vancouver Canucks',
    bookmakers: [{
      key: 'pinnacle',
      last_update: '2026-11-16T02:09:00Z',
      markets: [
        { key: 'spreads', last_update: '2026-11-16T02:09:00Z', outcomes: [
          { name: 'Vancouver Canucks', price: -123, point: 2.5 },
          { name: 'Vegas Golden Knights', price: 110, point: -2.5 },
        ] },
        { key: 'h2h', last_update: '2026-11-16T02:09:00Z', outcomes: [
          { name: 'Vancouver Canucks', price: 130 },
          { name: 'Vegas Golden Knights', price: -150 },
        ] },
        { key: 'totals', last_update: '2026-11-16T02:09:00Z', outcomes: [
          { name: 'Over', price: -110, point: 6 },
          { name: 'Under', price: -110, point: 6 },
        ] },
      ],
    }],
  };
  function cardLeg(market, betType, pick) {
    return {
      kind: 'card', sport: 'NHL', matchup: 'Vancouver Canucks @ Vegas Golden Knights',
      pick, market, betType, eventId: 'van-vgk',
      homeTeam: 'Vegas Golden Knights', awayTeam: 'Vancouver Canucks',
      commenceTime: '2026-11-16T02:10:00Z',
    };
  }
  const spreadCard = cardLeg('Spread', 'Spread', 'Vancouver Canucks +2.5');
  assert.strictEqual(C.assessPick(spreadCard, [vegas]).status, 'closed');
  assert.strictEqual(C.assessPick(spreadCard, [vegas]).market, 'spreads');
  assert.strictEqual(C.assessPick(cardLeg('Moneyline', 'Moneyline', 'Vancouver Canucks ML'), [vegas]).status, 'closed');
  assert.strictEqual(C.assessPick(cardLeg('Total', 'Total', 'Over 6'), [vegas]).status, 'closed');
  assert.strictEqual(C.assessPick(cardLeg(undefined, 'Spread', 'Vancouver Canucks +2.5'), [vegas]).market, 'spreads');
  assert.strictEqual(C.assessPick(cardLeg('ML', 'Moneyline', 'Vegas Golden Knights ML'), [vegas]).market, 'h2h');
  assert.strictEqual(C.assessPick(cardLeg('Total', undefined, 'Under 6'), [vegas]).status, 'closed');
  const spreadsOnly = JSON.parse(JSON.stringify(vegas));
  spreadsOnly.bookmakers[0].markets = spreadsOnly.bookmakers[0].markets.filter((row) => row.key === 'spreads');
  assert.strictEqual(C.assessPick(cardLeg('Moneyline', 'Moneyline', 'Vancouver Canucks ML'), [spreadsOnly]).reason, 'pinnacle-not-priced');
  assert.strictEqual(C.pickMarket({ market: 'Spread', pick: 'Vancouver Canucks +2.5' }), 'spreads');
  assert.strictEqual(C.pickMarket({ betType: 'Total', pick: 'Over 6' }), 'totals');
  assert.strictEqual(C.pickMarket({ betType: 'Moneyline', market: 'Moneyline', pick: 'Vancouver Canucks ML' }), 'h2h');

  assert.strictEqual(C.reserveBlocks('10050', 60), true);
  assert.strictEqual(C.reserveBlocks('10060', 60), false);
  assert.strictEqual(C.reserveBlocks(null, 60), false);

  const slate = [
    { sport: 'NBA', eventId: 'keep', homeTeam: 'Celtics', awayTeam: 'Knicks', commenceTime: '2026-11-15T18:00:00Z' },
    { sport: 'NBA', eventId: 'gone', homeTeam: 'Magic', awayTeam: 'Heat', commenceTime: '2026-11-15T18:05:00Z' },
    { sport: 'NHL', eventId: 'nhl1', homeTeam: 'Bruins', awayTeam: 'Rangers', commenceTime: '2026-11-15T23:00:00Z' },
  ];
  const card = {
    picks: [
      { sport: 'NBA', eventId: 'gone', matchup: 'Heat @ Magic', pick: 'Magic ML', betType: 'Moneyline', commenceTime: '2026-11-15T18:05:00Z' },
      { sport: 'NHL', eventId: 'nhl1', matchup: 'Rangers @ Bruins', pick: 'Bruins ML', betType: 'Moneyline', commenceTime: '2026-11-15T23:00:00Z' },
    ],
  };
  const calls = [];
  const rows = [];
  const blobs = memBlobs({
    'clv-close-capture:credits/2026-11-16': { date: '2026-11-16', used: 5, calls: [{ path: 'full-board', estCost: 3 }] },
  });
  const env = { ODDS_API_KEY: 'test-key', OMEGA_CLOSES_3AM_CAP: '1000' };
  const first = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: slate.concat([
      { sport: 'NFL', eventId: 'nfl1', homeTeam: 'Bears', awayTeam: 'Lions', commenceTime: '2026-11-15T17:00:00Z' },
    ]),
    card,
    blobs,
    requestsRemaining: 50000,
    writeRows: async (built) => {
      rows.push(built);
      return { games: built.games.length, odds_snapshots: built.snaps.length, requests: 1 };
    },
    storeClose: async () => ({ wrote: true }),
    fetch: async (url) => {
      calls.push(String(url));
      assert.ok(String(url).includes('apiKey=test-key'));
      assert.ok(String(url).includes('/historical/sports/'));
      const sportKey = String(url).split('/sports/')[1].split('/odds')[0];
      if (sportKey === 'icehockey_nhl') {
        return oddsResponse(wrapped([
          event('nhl1', 'Bruins', 'Rangers', '2026-11-15T23:00:00Z'),
        ], '2026-11-15T22:59:00Z'));
      }
      return oddsResponse(wrapped(siblingEvents, '2026-11-15T17:59:00Z'));
    },
  });
  assert.strictEqual(calls.length, 4);
  assert.ok(calls[0].includes('icehockey_nhl') || calls[0].includes('basketball_nba'));
  assert.ok(calls[2].includes('americanfootball_nfl'), 'board bucket is after card buckets');
  const nhlUrl = calls.find((url) => url.includes('icehockey_nhl'));
  assert.ok(nhlUrl.includes('date=2026-11-15T22%3A59%3A00Z') || nhlUrl.includes('date=2026-11-15T22:59:00Z'));
  const nhlQs = new URL(nhlUrl).searchParams;
  assert.strictEqual(nhlQs.get('commenceTimeFrom'), '2026-11-15T22:30:00Z');
  assert.strictEqual(nhlQs.get('commenceTimeTo'), '2026-11-15T23:30:00Z');
  const nbaFallbackUrl = calls[3];
  assert.ok(nbaFallbackUrl.includes('basketball_nba'));
  assert.ok(nbaFallbackUrl.includes('date=2026-11-15T17%3A45%3A00Z') || nbaFallbackUrl.includes('date=2026-11-15T17:45:00Z'));
  const nhlPick = first.picks.find((row) => row.eventId === 'nhl1' || row.pick === 'Bruins ML');
  const nbaPick = first.picks.find((row) => row.pick === 'Magic ML');
  assert.strictEqual(nhlPick.status, 'closed');
  assert.strictEqual(nhlPick.closeLeadMin, 1);
  assert.strictEqual(nhlPick.market, 'h2h');
  assert.strictEqual(nbaPick.status, 'no-close');
  assert.strictEqual(nbaPick.reason, 'not-in-historical-snapshot');
  assert.ok(rows.length >= 1);
  const snaps = rows.flatMap((built) => built.snaps);
  assert.ok(snaps.every((row) => row.line_type === 'closing'));
  assert.ok(snaps.some((row) => row.book === 'pinnacle' && row.market === 'h2h'));
  assert.ok(snaps.every((row) => row.source === C.SOURCE));
  const credits = blobs.data.get('clv-close-capture:credits/2026-11-16');
  assert.strictEqual(credits.used, 5, 'historical spend does not inflate the old cap counter');
  assert.ok(credits.calls.some((call) => call.path === 'closes-3am-historical' && call.estCost === 60));
  assert.ok(credits.calls.some((call) => call.path === 'closes-3am-historical' && call.fallback === true));
  assert.ok(blobs.data.has('clv-close-capture:done-bucket/NBA/2026-11-15T17:59:00Z'));
  assert.ok(blobs.data.has('clv-close-capture:done-bucket/NBA/2026-11-15T17:45:00Z'));
  const summary = blobs.data.get('clv-close-capture:closes-3am/2026-11-15');
  assert.ok(summary && summary.picks.some((row) => row.reason === 'not-in-historical-snapshot'));
  const archiveKeys = [...blobs.data.keys()].filter((key) => key.includes(':raw/'));
  assert.ok(archiveKeys.length >= 1);
  const archive = blobs.data.get(archiveKeys[0]);
  assert.ok(archive.meta.url && !archive.meta.url.includes('apiKey'));
  assert.ok(archive.meta.snapshot || archive.meta.timestamp);

  const againCalls = [];
  const again = await C.runCloses({
    now: new Date('2026-11-16T08:05:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: slate,
    card,
    blobs,
    requestsRemaining: 50000,
    fetch: async (url) => { againCalls.push(String(url)); return oddsResponse(wrapped([])); },
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
  });
  assert.strictEqual(againCalls.length, 0, 'idempotent re-run makes no call');
  assert.ok(again.skippedDone >= 2);
  assert.strictEqual(again.picks.find((row) => row.pick === 'Magic ML').reason, 'not-in-historical-snapshot');

  const retryCalls = [];
  await C.runCloses({
    now: new Date('2026-11-16T08:06:00Z'),
    env,
    date: '2026-11-15',
    onlyMissing: true,
    slateEvents: slate,
    card,
    blobs,
    requestsRemaining: 50000,
    fetch: async (url) => { retryCalls.push(String(url)); return oddsResponse(wrapped([])); },
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
  });
  assert.strictEqual(retryCalls.length, 0, 'terminal no-close is not fetched again');

  const capCalls = [];
  const capped = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env: { ODDS_API_KEY: 'test-key', OMEGA_CLOSES_3AM_CAP: '60' },
    date: '2026-11-15',
    slateEvents: [
      { sport: 'NBA', eventId: 'keep', homeTeam: 'Celtics', awayTeam: 'Knicks', commenceTime: '2026-11-15T18:00:00Z' },
      { sport: 'NHL', eventId: 'nhl1', homeTeam: 'Bruins', awayTeam: 'Rangers', commenceTime: '2026-11-15T23:00:00Z' },
    ],
    card: { picks: card.picks.slice(1) },
    blobs: memBlobs({}),
    requestsRemaining: 50000,
    fetch: async (url) => {
      capCalls.push(String(url));
      return oddsResponse(wrapped([event('nhl1', 'Bruins', 'Rangers', '2026-11-15T23:00:00Z')]));
    },
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
  });
  assert.strictEqual(capCalls.length, 1);
  assert.ok(capCalls[0].includes('icehockey_nhl'));
  assert.ok(capped.skippedCap >= 1);

  const reserveCalls = [];
  const reserved = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: slate.slice(2),
    card: { picks: card.picks.slice(1) },
    blobs: memBlobs({}),
    requestsRemaining: 10050,
    fetch: async (url) => { reserveCalls.push(String(url)); return oddsResponse(wrapped([])); },
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
  });
  assert.strictEqual(reserveCalls.length, 0);
  assert.strictEqual(reserved.reserveGuard, true);
  assert.strictEqual(reserved.ok, false);
  assert.strictEqual(reserved.picks.find((row) => row.pick === 'Bruins ML').reason, 'reserve-guard');

  const thrown = [];
  const boardOk = await pull3.handle({}, {
    env: { OMEGA_CLOSES_AT_3AM: 'on', URL: 'https://example.test', PICKS_SECRET_KEY: 'secret' },
    runOddsMasterPull: async () => ({ slot: '0300', sports: 6 }),
    fetch: async () => { thrown.push('fetch'); throw new Error('background down'); },
  });
  assert.strictEqual(boardOk.statusCode, 200);
  const boardBody = JSON.parse(boardOk.body);
  assert.strictEqual(boardBody.ok, true);
  assert.strictEqual(boardBody.sports, 6);
  assert.strictEqual(boardBody.closesFired, false);
  assert.strictEqual(thrown.length, 1);

  const boardFail = await pull3.handle({}, {
    env: { OMEGA_CLOSES_AT_3AM: 'on', URL: 'https://example.test' },
    runOddsMasterPull: async () => { throw new Error('pull broke'); },
    fetch: async () => ({ status: 202, ok: true }),
  });
  assert.strictEqual(boardFail.statusCode, 500);
  assert.strictEqual(JSON.parse(boardFail.body).closesFired, true);

  const quiet = [];
  const flagOff = await pull3.handle({}, {
    env: { OMEGA_CLOSES_AT_3AM: 'off' },
    runOddsMasterPull: async () => ({ slot: '0300' }),
    fetch: async () => { quiet.push('fetch'); return { status: 202, ok: true }; },
  });
  assert.strictEqual(flagOff.statusCode, 200);
  assert.strictEqual(quiet.length, 0);

  const noopFetch = [];
  const skipped = await cap.handle({}, new Date(), {
    env: {},
    fetch: async () => { noopFetch.push('odds'); return { ok: true, json: async () => [] }; },
  });
  assert.strictEqual(skipped.statusCode, 200);
  assert.strictEqual(JSON.parse(skipped.body).skipped, 'closes-at-3am');
  assert.strictEqual(noopFetch.length, 0);
  const loud = await cap.handle({}, new Date(), {
    env: { OMEGA_CLOSES_AT_3AM: 'off', SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't' },
    fetch: async () => { throw new Error('should not need a successful odds call'); },
  });
  assert.strictEqual(loud.statusCode, 500);
  assert.match(JSON.parse(loud.body).error, /ODDS_API_KEY/);

  const handlerSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-odds-3am.js'), 'utf8');
  const handlerAt = handlerSrc.indexOf('exports.handler');
  const slice = handlerSrc.slice(handlerAt);
  const callAt = slice.indexOf("rejectUnlessEtSlot('capture-odds-3am', event, new Date())");
  const awaitAt = slice.search(/\bawait\b/);
  assert.ok(callAt >= 0);
  assert.ok(awaitAt === -1 || callAt < awaitAt);

  assert.strictEqual(track._test.ODDS_SPORTS_MAP.NCAAM, 'basketball_ncaab');
  assert.strictEqual(track._test.ESPN_ENDPOINTS.NCAAB, 'basketball/mens-college-basketball');
  assert.strictEqual(track._test.ESPN_ENDPOINTS.NCAAM, undefined);
  assert.strictEqual(track._test.SHARP_BOOKS[0], 'pinnacle');
  const { closeSourceLabel } = require('./netlify/functions/lib/clv-true-close');
  assert.strictEqual(closeSourceLabel(C.SOURCE), 'supabase:capture-closes-3am');
  assert.strictEqual(closeSourceLabel('oddsapi-live:capture-all-closes'), 'supabase:capture-all-closes');

  const savedKey = process.env.ODDS_API_KEY;
  const savedFetch = global.fetch;
  const oddsUrls = [];
  process.env.ODDS_API_KEY = 'test-key';
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('the-odds-api.com')) oddsUrls.push(href);
    return { ok: true, status: 200, json: async () => ({ events: [] }) };
  };
  const memory = {
    data: {
      'picks-2026-11-15': {
        picks: [{
          sport: 'NCAAM',
          pick: 'Duke Blue Devils ML',
          matchup: 'North Carolina Tar Heels @ Duke Blue Devils',
          betType: 'Moneyline',
          odds: '-140',
          units: 1,
          commenceTime: '2026-11-15T23:00:00Z',
          result: 'win',
          profit: 1,
        }],
      },
    },
    writes: [],
    async get(key) { return this.data[key] ? JSON.parse(JSON.stringify(this.data[key])) : null; },
    async setJSON(key, value) {
      this.writes.push(key);
      this.data[key] = JSON.parse(JSON.stringify(value));
    },
  };
  try {
    const stored = await track.handle({
      httpMethod: 'POST',
      body: JSON.stringify({ date: '2026-11-15', storedCloses: true }),
    }, {
      now: '2026-11-16T12:00:00Z',
      env: { OMEGA_CLOSES_AT_3AM: 'on', OMEGA_CLV_TRUE_CLOSE: 'off', OMEGA_NCAAM_GRADE: 'off' },
      fetch: async (url) => {
        const href = String(url);
        if (href.includes('the-odds-api.com')) oddsUrls.push(href);
        return { ok: false, status: 500, json: async () => ({}) };
      },
      store: memory,
      storedEventsBySport: {
        basketball_ncaab: [{
          id: 'duke-1',
          home_team: 'Duke Blue Devils',
          away_team: 'North Carolina Tar Heels',
          commence_time: '2026-11-15T23:00:00Z',
          bookmakers: [{
            key: 'pinnacle',
            markets: [{ key: 'h2h', outcomes: [
              { name: 'Duke Blue Devils', price: -150 },
              { name: 'North Carolina Tar Heels', price: 130 },
            ] }],
          }, {
            key: 'fanduel',
            markets: [{ key: 'h2h', outcomes: [
              { name: 'Duke Blue Devils', price: -145 },
              { name: 'North Carolina Tar Heels', price: 122 },
            ] }],
          }],
        }],
      },
    });
    assert.strictEqual(stored.statusCode, 200);
    assert.strictEqual(oddsUrls.length, 0, 'stored mode makes no Odds API call');
    const clv = memory.data['clv-2026-11-15'];
    assert.ok(clv && clv.picks && clv.picks[0]);
    assert.ok(!String(clv.picks[0].error || '').includes('Sport not mapped'));
    assert.strictEqual(clv.picks[0].anchorBook, 'pinnacle');
    assert.ok(clv.picks[0].clv != null);
  } finally {
    global.fetch = savedFetch;
    if (savedKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = savedKey;
  }

  const denied = await bg.handle({ headers: {}, body: '{}' }, {
    env: { PICKS_SECRET_KEY: 'secret', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T08:00:00Z'),
  });
  assert.strictEqual(denied.statusCode, 401);
  const oldDate = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-01' }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret' },
    now: new Date('2026-11-16T08:00:00Z'),
  });
  assert.strictEqual(oldDate.statusCode, 400);
  const flagged = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15' }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', OMEGA_CLOSES_AT_3AM: 'off' },
    now: new Date('2026-11-16T08:00:00Z'),
  });
  assert.strictEqual(JSON.parse(flagged.body).skipped, 'flag-off');

  let tracked = null;
  const ran = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15', picksOnly: true }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T08:00:00Z'),
    blobs: memBlobs({}),
    slateEvents: slate.slice(2),
    card: { picks: card.picks.slice(1) },
    skipGrade: true,
    storeClose: async () => ({ wrote: true }),
    writeRows: async () => ({ games: 1, odds_snapshots: 2, requests: 0 }),
    invokeTrack: async (date) => { tracked = date; return { ok: true, status: 200 }; },
    fetch: async () => oddsResponse(wrapped([event('nhl1', 'Bruins', 'Rangers', '2026-11-15T23:00:00Z')])),
  });
  assert.strictEqual(ran.statusCode, 200);
  assert.strictEqual(tracked, '2026-11-15');
  assert.ok(!JSON.stringify(JSON.parse(ran.body)).includes('test-key'));

  const mirrorOpts = {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T08:00:00Z'),
    blobs: memBlobs({}),
    slateEvents: [],
    card: { picks: [] },
    candidates: { candidates: [] },
    readBoard: async () => null,
    skipGrade: true,
    fetch: async () => { throw new Error('mirror test must not fetch'); },
  };
  const steps = [];
  let mirrorStarted = false;
  const mirrored = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: '{}',
  }, {
    ...mirrorOpts,
    invokeTrack: async (date) => {
      steps.push({ step: 'track', date });
      await new Promise((resolve) => setTimeout(resolve, 20));
      steps.push({ step: 'track-done', mirrorStarted });
      return { ok: true, status: 200 };
    },
    mirrorTodayCard: async (date, opts) => {
      mirrorStarted = true;
      steps.push({
        step: 'mirror',
        date,
        hasFetch: typeof opts.fetch === 'function',
        hasBlobs: !!opts.blobs,
        hasEnv: !!(opts.env && opts.env.PICKS_SECRET_KEY),
      });
      return { ok: true, counts: { card_picks: 2 } };
    },
  });
  const mirroredBody = JSON.parse(mirrored.body);
  assert.strictEqual(mirrored.statusCode, 200);
  assert.strictEqual(mirroredBody.ok, true);
  assert.strictEqual(mirroredBody.date, '2026-11-15');
  assert.deepStrictEqual(steps.map((row) => row.step), ['track', 'track-done', 'mirror']);
  assert.strictEqual(steps[0].date, '2026-11-15');
  assert.strictEqual(steps[1].mirrorStarted, false);
  assert.strictEqual(steps[2].date, '2026-11-15');
  assert.strictEqual(steps[2].hasFetch, true);
  assert.strictEqual(steps[2].hasBlobs, true);
  assert.strictEqual(steps[2].hasEnv, true);
  assert.strictEqual(mirroredBody.mirror.ok, true);
  assert.strictEqual(mirroredBody.mirror.counts.card_picks, 2);

  const blew = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15' }),
  }, {
    ...mirrorOpts,
    invokeTrack: async () => ({ ok: true, status: 200 }),
    mirrorTodayCard: async () => { throw new Error('mirror exploded'); },
  });
  const blewBody = JSON.parse(blew.body);
  assert.strictEqual(blew.statusCode, 200);
  assert.strictEqual(blewBody.ok, true);
  assert.strictEqual(blewBody.mirror.ok, false);
  assert.match(blewBody.mirror.error, /mirror exploded/);

  const dryCalls = [];
  const dry = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15' }),
  }, {
    ...mirrorOpts,
    dryRun: true,
    invokeTrack: async () => { dryCalls.push('track'); return { ok: true, status: 200 }; },
    mirrorTodayCard: async () => { dryCalls.push('mirror'); return { ok: true }; },
  });
  const dryBody = JSON.parse(dry.body);
  assert.strictEqual(dry.statusCode, 200);
  assert.deepStrictEqual(dryCalls, []);
  assert.strictEqual(dryBody.mirror, null);
  assert.strictEqual(dryBody.track, null);

  const skipCalls = [];
  const skippedMirror = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: '{}',
  }, {
    ...mirrorOpts,
    skipMirror: true,
    invokeTrack: async (date) => { skipCalls.push(date); return { ok: true, status: 200 }; },
    mirrorTodayCard: async () => { skipCalls.push('mirror'); return { ok: true }; },
  });
  assert.strictEqual(skippedMirror.statusCode, 200);
  assert.deepStrictEqual(skipCalls, ['2026-11-15']);
  assert.strictEqual(JSON.parse(skippedMirror.body).mirror, null);

  const flaggedMirror = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15' }),
  }, {
    ...mirrorOpts,
    env: { ...mirrorOpts.env, SUPABASE_MIRROR_V2: 'off' },
    invokeTrack: async () => ({ ok: true, status: 200 }),
  });
  assert.strictEqual(JSON.parse(flaggedMirror.body).mirror.skipped, 'flag-off');

  const tip = '2026-11-16T02:10:00Z';
  const vanGame = {
    sport: 'NHL', eventId: 'van-vgk', homeTeam: 'Vegas Golden Knights', awayTeam: 'Vancouver Canucks', commenceTime: tip,
  };
  function vanEvent(markets) {
    return {
      id: 'van-vgk',
      sport_key: 'icehockey_nhl',
      commence_time: tip,
      home_team: 'Vegas Golden Knights',
      away_team: 'Vancouver Canucks',
      bookmakers: [{
        key: 'pinnacle',
        last_update: '2026-11-16T02:09:00Z',
        markets,
      }],
    };
  }
  const vanSpreads = { key: 'spreads', last_update: '2026-11-16T02:09:00Z', outcomes: [
    { name: 'Vancouver Canucks', price: -123, point: 2.5 },
    { name: 'Vegas Golden Knights', price: 110, point: -2.5 },
  ] };
  const vanH2h = { key: 'h2h', last_update: '2026-11-16T02:09:00Z', outcomes: [
    { name: 'Vancouver Canucks', price: 130 },
    { name: 'Vegas Golden Knights', price: -150 },
  ] };
  const vanCard = { picks: [
    { sport: 'NHL', eventId: 'van-vgk', matchup: 'Vancouver Canucks @ Vegas Golden Knights', pick: 'Vancouver Canucks +2.5', market: 'Spread', betType: 'Spread', commenceTime: tip },
    { sport: 'NHL', eventId: 'van-vgk', matchup: 'Vancouver Canucks @ Vegas Golden Knights', pick: 'Vancouver Canucks ML', market: 'Moneyline', betType: 'Moneyline', commenceTime: tip },
    { sport: 'NHL', eventId: 'van-vgk', matchup: 'Vancouver Canucks @ Vegas Golden Knights', pick: 'Over 6', market: 'Total', betType: 'Total', commenceTime: tip },
  ] };
  const vanCandidates = { candidates: [
    { sport: 'NHL', eventId: 'van-vgk', matchup: 'Vancouver Canucks @ Vegas Golden Knights', side: 'Vancouver Canucks +2.5', market: 'Spread', commenceTime: tip },
  ] };
  const shapeCalls = [];
  const shapePosts = [];
  const shape = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: [vanGame],
    card: vanCard,
    candidates: vanCandidates,
    blobs: memBlobs({}),
    requestsRemaining: 50000,
    writeRows: async (built) => {
      shapePosts.push(built.snaps.map((row) => `${row.game_id}|${row.market}`));
      return { games: built.games.length, odds_snapshots: built.snaps.length, requests: 0 };
    },
    storeClose: async () => ({ wrote: true }),
    fetch: async (url) => {
      shapeCalls.push(String(url));
      const date = new URL(String(url)).searchParams.get('date');
      if (date === '2026-11-16T02:09:00Z') {
        return oddsResponse(wrapped([vanEvent([vanH2h])], '2026-11-16T02:09:00Z'));
      }
      return oddsResponse(wrapped([vanEvent([vanSpreads])], '2026-11-16T01:55:00Z'));
    },
  });
  assert.strictEqual(shapeCalls.length, 2, 'primary miss retries once at tip minus 15 minutes');
  const shapeQs = shapeCalls.map((url) => new URL(url).searchParams);
  assert.strictEqual(shapeQs[0].get('date'), '2026-11-16T02:09:00Z');
  assert.strictEqual(shapeQs[0].get('commenceTimeFrom'), '2026-11-16T01:40:00Z');
  assert.strictEqual(shapeQs[0].get('commenceTimeTo'), '2026-11-16T02:40:00Z');
  assert.strictEqual(shapeQs[1].get('date'), '2026-11-16T01:55:00Z');
  assert.strictEqual(shapeQs[1].get('commenceTimeFrom'), '2026-11-16T01:40:00Z');
  assert.strictEqual(shapeQs[1].get('commenceTimeTo'), '2026-11-16T02:40:00Z');
  const mlRow = shape.picks.find((row) => row.pick === 'Vancouver Canucks ML');
  const spreadRow = shape.picks.find((row) => row.pick === 'Vancouver Canucks +2.5' && row.kind === 'card');
  const totalRow = shape.picks.find((row) => row.pick === 'Over 6');
  const candRow = shape.picks.find((row) => row.kind === 'candidate');
  assert.strictEqual(mlRow.status, 'closed');
  assert.strictEqual(mlRow.market, 'h2h');
  assert.strictEqual(mlRow.closeLeadMin, 1);
  assert.strictEqual(totalRow.status, 'no-close');
  assert.strictEqual(totalRow.reason, 'pinnacle-not-priced');
  assert.strictEqual(totalRow.market, 'totals');
  assert.strictEqual(spreadRow.status, 'closed');
  assert.strictEqual(spreadRow.market, 'spreads');
  assert.strictEqual(spreadRow.closeLeadMin, 15);
  assert.strictEqual(candRow.status, 'closed');
  assert.strictEqual(candRow.market, 'spreads');
  assert.strictEqual(candRow.closeLeadMin, 15);
  assert.ok(shape.calls.some((call) => call.fallback === true && call.path === 'closes-3am-historical' && call.sport === 'NHL'));
  const fallbackSnaps = shapePosts[shapePosts.length - 1];
  assert.ok(fallbackSnaps.every((sig) => sig.endsWith('|spreads')));
  assert.ok(!fallbackSnaps.some((sig) => sig.endsWith('|h2h')));

  const bills = {
    id: 'bills', sport_key: 'americanfootball_nfl', commence_time: '2026-11-15T18:00:00Z',
    home_team: 'New York Jets', away_team: 'Buffalo Bills',
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Buffalo Bills', price: -121 }, { name: 'New York Jets', price: 101 }] }] }],
  };
  const later = {
    id: 'later', sport_key: 'americanfootball_nfl', commence_time: '2026-11-15T18:20:00Z',
    home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles',
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Philadelphia Eagles', price: -140 }, { name: 'Dallas Cowboys', price: 120 }] }] }],
  };
  const walkin = {
    id: 'walkin', sport_key: 'americanfootball_nfl', commence_time: '2026-11-15T18:01:00Z',
    home_team: 'Home Walk', away_team: 'Away Walk',
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Walk', price: -110 }, { name: 'Away Walk', price: -110 }] }] }],
  };
  const stray = {
    id: 'stray', sport_key: 'americanfootball_nfl', commence_time: '2026-11-15T18:20:00Z',
    home_team: 'Home Stray', away_team: 'Away Stray',
    bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home Stray', price: -110 }, { name: 'Away Stray', price: -110 }] }] }],
  };
  const windowPosts = [];
  const windowStored = [];
  const windowBlobs = memBlobs({});
  const windowed = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: [
      { sport: 'NFL', eventId: 'bills', homeTeam: 'New York Jets', awayTeam: 'Buffalo Bills', commenceTime: '2026-11-15T18:00:00Z' },
      { sport: 'NFL', eventId: 'later', homeTeam: 'Dallas Cowboys', awayTeam: 'Philadelphia Eagles', commenceTime: '2026-11-15T18:20:00Z' },
    ],
    card: { picks: [
      { sport: 'NFL', eventId: 'bills', matchup: 'Buffalo Bills @ New York Jets', pick: 'Buffalo Bills ML', market: 'Moneyline', betType: 'Moneyline', commenceTime: '2026-11-15T18:00:00Z' },
    ] },
    blobs: windowBlobs,
    requestsRemaining: 50000,
    writeRows: async (built) => {
      windowPosts.push(built.games.map((row) => row.game_id));
      return { games: built.games.length, odds_snapshots: built.snaps.length, requests: 0 };
    },
    storeClose: async (ev, info) => {
      windowStored.push({ id: ev.id, requestedAt: info.requestedAt });
      return { wrote: true };
    },
    fetch: async (url) => {
      const date = new URL(String(url)).searchParams.get('date');
      if (date === '2026-11-15T17:59:00Z') {
        return oddsResponse(wrapped([bills, later, walkin, stray], '2026-11-15T17:59:00Z'));
      }
      if (date === '2026-11-15T18:19:00Z') {
        return oddsResponse(wrapped([later], '2026-11-15T18:19:00Z'));
      }
      return oddsResponse(wrapped([], date));
    },
  });
  assert.strictEqual(windowed.calls.length, 2);
  assert.deepStrictEqual(windowPosts[0].slice().sort(), ['bills', 'walkin']);
  assert.deepStrictEqual(windowPosts[1], ['later']);
  assert.ok(windowStored.some((row) => row.id === 'bills' && row.requestedAt === '2026-11-15T17:59:00Z'));
  assert.ok(windowStored.some((row) => row.id === 'later' && row.requestedAt === '2026-11-15T18:19:00Z'));
  assert.ok(!windowStored.some((row) => row.id === 'later' && row.requestedAt === '2026-11-15T17:59:00Z'));
  assert.ok(!windowStored.some((row) => row.id === 'stray'));
  assert.ok(!windowBlobs.data.has('clv-close-capture:done-ev/NFL/stray'));
  assert.ok(windowBlobs.data.has('clv-close-capture:done-ev/NFL/bills'));
  const earlyArchive = [...windowBlobs.data.keys()]
    .filter((key) => key.includes(':raw/') && key.includes('17:59'))
    .map((key) => windowBlobs.data.get(key))[0];
  assert.ok(earlyArchive && earlyArchive.body && earlyArchive.body.data.some((row) => row.id === 'stray'));
  assert.ok(earlyArchive.body.data.some((row) => row.id === 'later'));
  const billsBucket = C.planBuckets([
    { sport: 'NFL', eventId: 'bills', commenceTime: '2026-11-15T18:00:00Z', roles: new Set(['card']), picks: [] },
  ])[0];
  const slateIds = new Set(['bills', 'later']);
  assert.strictEqual(C.eventBelongsToBucket({ id: 'bills', commence_time: '2026-11-15T18:00:00Z' }, billsBucket, slateIds), true);
  assert.strictEqual(C.eventBelongsToBucket({ id: 'later', commence_time: '2026-11-15T18:00:00Z' }, billsBucket, slateIds), false);
  assert.strictEqual(C.eventBelongsToBucket({ id: 'walkin', commence_time: '2026-11-15T18:01:00Z' }, billsBucket, slateIds), true);
  assert.strictEqual(C.eventBelongsToBucket({ id: 'stray', commence_time: '2026-11-15T18:20:00Z' }, billsBucket, slateIds), false);

  const capBlobs = memBlobs({});
  const capFallbackCalls = [];
  const cappedFallback = await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env: { ODDS_API_KEY: 'test-key', OMEGA_CLOSES_3AM_CAP: '60' },
    date: '2026-11-15',
    slateEvents: [vanGame],
    card: { picks: vanCard.picks.slice(0, 1) },
    blobs: capBlobs,
    requestsRemaining: 50000,
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    fetch: async (url) => {
      capFallbackCalls.push(String(url));
      return oddsResponse(wrapped([]));
    },
  });
  assert.strictEqual(capFallbackCalls.length, 1);
  assert.strictEqual(cappedFallback.picks.find((row) => row.pick === 'Vancouver Canucks +2.5').reason, 'cap');
  const resumedCalls = [];
  const resumed = await C.runCloses({
    now: new Date('2026-11-16T08:10:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: [vanGame],
    card: { picks: vanCard.picks.slice(0, 1) },
    blobs: capBlobs,
    requestsRemaining: 50000,
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    storeClose: async () => ({ wrote: true }),
    fetch: async (url) => {
      resumedCalls.push(String(url));
      return oddsResponse(wrapped([vanEvent([vanSpreads])], '2026-11-16T01:55:00Z'));
    },
  });
  assert.strictEqual(resumedCalls.length, 1, 'done primary bucket does not block the fallback snapshot');
  assert.strictEqual(new URL(resumedCalls[0]).searchParams.get('date'), '2026-11-16T01:55:00Z');
  assert.strictEqual(resumed.picks.find((row) => row.pick === 'Vancouver Canucks +2.5').status, 'closed');
  assert.strictEqual(resumed.picks.find((row) => row.pick === 'Vancouver Canucks +2.5').closeLeadMin, 15);

  const retryBlobs = memBlobs({});
  const retryCard = { picks: [
    vanCard.picks[1],
    vanCard.picks[0],
  ] };
  await C.runCloses({
    now: new Date('2026-11-16T08:00:00Z'),
    env,
    date: '2026-11-15',
    slateEvents: [vanGame],
    card: retryCard,
    blobs: retryBlobs,
    requestsRemaining: 50000,
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    storeClose: async () => ({ wrote: true }),
    fetch: async (url) => {
      const date = new URL(String(url)).searchParams.get('date');
      if (date === '2026-11-16T02:09:00Z') return oddsResponse(wrapped([vanEvent([vanH2h])], '2026-11-16T02:09:00Z'));
      return oddsResponse(wrapped([vanEvent([vanH2h])], '2026-11-16T01:55:00Z'));
    },
  });
  const quietRetry = [];
  await C.runCloses({
    now: new Date('2026-11-16T08:20:00Z'),
    env,
    date: '2026-11-15',
    onlyMissing: true,
    slateEvents: [vanGame],
    card: retryCard,
    blobs: retryBlobs,
    requestsRemaining: 50000,
    fetch: async (url) => { quietRetry.push(String(url)); return oddsResponse(wrapped([])); },
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
  });
  assert.strictEqual(quietRetry.length, 0, 'terminal no-close stays terminal without retryNoClose');
  const reopenCalls = [];
  const reopened = await C.runCloses({
    now: new Date('2026-11-16T08:30:00Z'),
    env,
    date: '2026-11-15',
    onlyMissing: true,
    retryNoClose: true,
    slateEvents: [vanGame],
    card: retryCard,
    blobs: retryBlobs,
    requestsRemaining: 50000,
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    storeClose: async () => ({ wrote: true }),
    fetch: async (url) => {
      reopenCalls.push(String(url));
      return oddsResponse(wrapped([vanEvent([vanSpreads])], '2026-11-16T02:09:00Z'));
    },
  });
  assert.strictEqual(reopenCalls.length, 1);
  assert.strictEqual(new URL(reopenCalls[0]).searchParams.get('date'), '2026-11-16T02:09:00Z');
  const reopenedMl = reopened.picks.find((row) => row.pick === 'Vancouver Canucks ML');
  const reopenedSpread = reopened.picks.find((row) => row.pick === 'Vancouver Canucks +2.5');
  assert.strictEqual(reopenedMl.status, 'closed');
  assert.strictEqual(reopenedMl.closeLeadMin, 1);
  assert.strictEqual(reopenedSpread.status, 'closed');
  assert.strictEqual(reopenedSpread.market, 'spreads');
  assert.strictEqual(reopenedSpread.closeLeadMin, 1);
  const saved = retryBlobs.data.get('clv-close-capture:closes-3am/2026-11-15');
  assert.strictEqual(saved.picks.find((row) => row.pick === 'Vancouver Canucks ML').status, 'closed');
  assert.strictEqual(saved.picks.find((row) => row.pick === 'Vancouver Canucks +2.5').status, 'closed');

  function noCloseSeed() {
    return memBlobs({
      'clv-close-capture:closes-3am/2026-11-15': {
        picks: [{
          kind: 'card', sport: 'NHL', matchup: 'Vancouver Canucks @ Vegas Golden Knights',
          pick: 'Vancouver Canucks +2.5', market: 'Spread', betType: 'Spread',
          commenceTime: tip, status: 'no-close', reason: 'pinnacle-not-priced',
        }],
      },
      'clv-close-capture:done-bucket/NHL/2026-11-16T02:09:00Z': { at: '2026-11-16T08:00:00Z' },
      'clv-close-capture:done-bucket/NHL/2026-11-16T01:55:00Z': { at: '2026-11-16T08:00:00Z' },
    });
  }
  const scheduledUrls = [];
  const scheduledRetry = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15', onlyMissing: true, retryNoClose: true, scheduled: true }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T08:40:00Z'),
    blobs: noCloseSeed(),
    slateEvents: [vanGame],
    card: { picks: [vanCard.picks[0]] },
    skipGrade: true,
    invokeTrack: async () => ({ ok: true, status: 200 }),
    storeClose: async () => ({ wrote: true }),
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    fetch: async (url) => { scheduledUrls.push(String(url)); return oddsResponse(wrapped([])); },
  });
  assert.strictEqual(scheduledRetry.statusCode, 200);
  assert.strictEqual(scheduledUrls.length, 0, 'scheduled runs ignore retryNoClose');
  const manualUrls = [];
  const manualRetry = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15', onlyMissing: true, retryNoClose: true }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T08:45:00Z'),
    blobs: noCloseSeed(),
    slateEvents: [vanGame],
    card: { picks: [vanCard.picks[0]] },
    skipGrade: true,
    invokeTrack: async () => ({ ok: true, status: 200 }),
    storeClose: async () => ({ wrote: true }),
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    fetch: async (url) => {
      manualUrls.push(String(url));
      return oddsResponse(wrapped([vanEvent([vanSpreads])], '2026-11-16T02:09:00Z'));
    },
  });
  assert.strictEqual(manualRetry.statusCode, 200);
  assert.ok(manualUrls.length >= 1);
  assert.strictEqual(new URL(manualUrls[0]).searchParams.get('date'), '2026-11-16T02:09:00Z');
  const manualBody = JSON.parse(manualRetry.body);
  assert.strictEqual(manualBody.picks.find((row) => row.pick === 'Vancouver Canucks +2.5').status, 'closed');
  assert.ok(!JSON.stringify(manualBody).includes('test-key'));

  const savedRows = new Map();
  const archiveBlobs = {
    async get(store, key) { return savedRows.get(`${store}:${key}`) || null; },
    async set(store, key, value) { savedRows.set(`${store}:${key}`, value); },
    async list(store, prefix) {
      const head = `${store}:${prefix}`;
      return [...savedRows.keys()].filter((key) => key.startsWith(head)).map((key) => key.slice(`${store}:`.length));
    },
  };
  await archiveBlobs.set('clv-close-capture', 'raw/2026-11-15/NHL/early.json', {
    meta: { timestamp: '2026-11-16T01:55:00Z', snapshot: '2026-11-16T01:55:00Z' },
    body: { data: [vanEvent([vanSpreads])], timestamp: '2026-11-16T01:55:00Z' },
  });
  await archiveBlobs.set('clv-close-capture', 'raw/2026-11-15/NHL/late.json', {
    meta: { timestamp: '2026-11-16T02:09:00Z', snapshot: '2026-11-16T02:09:00Z' },
    body: { data: [vanEvent([vanH2h])], timestamp: '2026-11-16T02:09:00Z' },
  });
  const storedEvents = await C.loadStoredEventsForSport('icehockey_nhl', { date: '2026-11-15', blobs: archiveBlobs });
  assert.strictEqual(storedEvents.length, 1);
  const storedMarkets = storedEvents[0].bookmakers[0].markets.map((market) => market.key).sort();
  assert.deepStrictEqual(storedMarkets, ['h2h', 'spreads']);

  const liveEv = { at: '2026-11-15T18:05:00Z', via: 'live' };
  const gapBlobs = memBlobs({
    'clv-close-capture:done-ev/NFL/already': liveEv,
    'clv-close-capture:done-ev/NFL/walkin-done': liveEv,
    'clv-close-capture:done-ev/NHL/nhl-retry': liveEv,
    'clv-close-capture:done-bucket/NFL/2026-11-15T14:32:33Z': { at: '2026-11-16T08:00:00Z' },
    'clv-close-capture:done-bucket/NHL/2026-11-16T02:09:00Z': { at: '2026-11-16T08:00:00Z' },
    'clv-close-capture:done-bucket/NHL/2026-11-16T01:55:00Z': { at: '2026-11-16T08:00:00Z' },
    [`clv-close-capture:${FB.doneMarketKey('NBA', '2026-11-15T23:30:00Z', 'h2h')}`]: { at: 'live' },
    [`clv-close-capture:${FB.doneMarketKey('NBA', '2026-11-15T23:30:00Z', 'spreads')}`]: { at: 'live' },
    [`clv-close-capture:${FB.doneMarketKey('NBA', '2026-11-15T23:30:00Z', 'totals')}`]: { at: 'live' },
    [`clv-close-capture:${FB.doneMarketKey('NFL', '2026-11-15T19:00:00Z', 'h2h')}`]: { at: 'live' },
    [`clv-close-capture:${FB.doneMarketKey('NFL', '2026-11-15T19:00:00Z', 'spreads')}`]: { at: 'live' },
    'clv-close-capture:closes-3am/2026-11-15': {
      date: '2026-11-15',
      picks: [
        {
          kind: 'card', sport: 'NCAAM', eventId: 'summary-closed',
          matchup: 'Quinnipiac @ Central Connecticut', pick: 'Quinnipiac ML',
          betType: 'Moneyline', commenceTime: '2026-11-16T01:00:00Z', status: 'closed',
        },
        {
          kind: 'card', sport: 'NHL', eventId: 'nhl-retry',
          matchup: 'Vancouver Canucks @ Vegas Golden Knights', pick: 'Vancouver Canucks +2.5',
          betType: 'Spread', commenceTime: '2026-11-16T02:10:00Z',
          status: 'no-close', reason: 'pinnacle-not-priced',
        },
        {
          kind: 'candidate', sport: 'NHL', eventId: 'nhl-retry',
          matchup: 'Vancouver Canucks @ Vegas Golden Knights', pick: 'Vancouver Canucks ML',
          betType: 'Moneyline', commenceTime: '2026-11-16T02:10:00Z',
          status: 'no-close', reason: 'pinnacle-not-priced',
        },
      ],
      games: [{
        sport: 'NCAAF', eventId: 'games-closed', matchup: 'Clemson @ South Carolina',
        status: 'closed', reason: null, closeLeadMin: 1,
      }],
    },
  });
  const gapWritten = [];
  const gapStored = [];
  const gapCalls = [];
  const gaps = await C.runCloses({
    now: new Date('2026-11-16T09:00:00Z'),
    env,
    date: '2026-11-15',
    onlyMissing: true,
    missingGames: true,
    slateEvents: [
      { sport: 'NFL', eventId: 'ne-det', awayTeam: 'New England Patriots', homeTeam: 'Detroit Lions', commenceTime: '2026-11-15T14:33:33Z' },
      { sport: 'NFL', eventId: 'partial', awayTeam: 'Jacksonville Jaguars', homeTeam: 'Tennessee Titans', commenceTime: '2026-11-15T19:00:00Z' },
      { sport: 'NFL', eventId: 'already', awayTeam: 'Chicago Bears', homeTeam: 'Green Bay Packers', commenceTime: '2026-11-15T21:25:00Z' },
      { sport: 'NBA', eventId: 'nba-done', awayTeam: 'Knicks', homeTeam: 'Celtics', commenceTime: '2026-11-15T23:30:00Z' },
      { sport: 'NCAAM', eventId: 'summary-closed', awayTeam: 'Quinnipiac', homeTeam: 'Central Connecticut', commenceTime: '2026-11-16T01:00:00Z' },
      { sport: 'NCAAF', eventId: 'games-closed', awayTeam: 'Clemson', homeTeam: 'South Carolina', commenceTime: '2026-11-15T17:00:00Z' },
      { sport: 'NHL', eventId: 'nhl-retry', awayTeam: 'Vancouver Canucks', homeTeam: 'Vegas Golden Knights', commenceTime: '2026-11-16T02:10:00Z' },
    ],
    card: { picks: [{
      sport: 'NHL', eventId: 'nhl-retry', matchup: 'Vancouver Canucks @ Vegas Golden Knights',
      pick: 'Vancouver Canucks +2.5', betType: 'Spread',
      awayTeam: 'Vancouver Canucks', homeTeam: 'Vegas Golden Knights',
      commenceTime: '2026-11-16T02:10:00Z',
    }] },
    candidates: { candidates: [{
      sport: 'NHL', eventId: 'nhl-retry', matchup: 'Vancouver Canucks @ Vegas Golden Knights',
      pick: 'Vancouver Canucks ML', betType: 'Moneyline',
      awayTeam: 'Vancouver Canucks', homeTeam: 'Vegas Golden Knights',
      commenceTime: '2026-11-16T02:10:00Z',
    }] },
    blobs: gapBlobs,
    requestsRemaining: 50000,
    writeRows: async (built) => {
      gapWritten.push(...built.games.map((row) => row.game_id));
      return { games: built.games.length, odds_snapshots: built.snaps.length, requests: 0 };
    },
    storeClose: async (ev) => {
      gapStored.push(ev.id);
      return { wrote: true };
    },
    fetch: async (url) => {
      gapCalls.push(String(url));
      const date = new URL(String(url)).searchParams.get('date');
      if (date === '2026-11-15T14:32:33Z') {
        return oddsResponse(wrapped([
          event('walkin-done', 'Chicago Bears', 'Dallas Cowboys', '2026-11-15T14:34:00Z'),
        ], date));
      }
      if (date === '2026-11-15T18:59:00Z') {
        return oddsResponse(wrapped([
          event('partial', 'Tennessee Titans', 'Jacksonville Jaguars', '2026-11-15T19:00:00Z'),
          event('already', 'Green Bay Packers', 'Chicago Bears', '2026-11-15T21:25:00Z'),
        ], date));
      }
      if (date === '2026-11-16T02:09:00Z') {
        return oddsResponse(wrapped([
          event('nhl-retry', 'Vegas Golden Knights', 'Vancouver Canucks', '2026-11-16T02:10:00Z'),
        ], date));
      }
      if (date === '2026-11-16T01:55:00Z') {
        return oddsResponse(wrapped([
          event('nhl-retry', 'Vegas Golden Knights', 'Vancouver Canucks', '2026-11-16T02:10:00Z', [
            pinnacleBook('Vegas Golden Knights', 'Vancouver Canucks', 'spreads'),
          ]),
        ], date));
      }
      return oddsResponse(wrapped([], date));
    },
  });
  const gapDates = gapCalls.map((url) => new URL(url).searchParams.get('date'));
  assert.deepStrictEqual(gapDates, [
    '2026-11-16T02:09:00Z',
    '2026-11-15T14:32:33Z',
    '2026-11-15T18:59:00Z',
    '2026-11-16T01:55:00Z',
  ], 'missingGames plans only buckets that still need a close');
  assert.ok(!gapDates.includes('2026-11-15T21:24:00Z'), 'done-ev game is not its own bucket');
  assert.ok(!gapDates.includes('2026-11-15T23:29:00Z'), 'all three market markers count as a close');
  assert.ok(!gapDates.includes('2026-11-16T00:59:00Z'), 'closed summary pick is not refetched');
  assert.ok(!gapDates.includes('2026-11-15T16:59:00Z'), 'closed summary game is not refetched');
  assert.ok(!gapDates.includes('2026-11-15T14:18:33Z'), 'slate no-close does not take the card fallback');
  assert.deepStrictEqual(gapWritten, ['partial']);
  assert.deepStrictEqual(gapStored, ['partial']);
  assert.deepStrictEqual(gapBlobs.data.get('clv-close-capture:done-ev/NFL/already'), liveEv);
  assert.deepStrictEqual(gapBlobs.data.get('clv-close-capture:done-ev/NFL/walkin-done'), liveEv);
  assert.deepStrictEqual(gapBlobs.data.get('clv-close-capture:done-ev/NHL/nhl-retry'), liveEv);
  assert.strictEqual(gapBlobs.data.get('clv-close-capture:done-ev/NFL/partial').via, 'closes-3am');
  assert.strictEqual(gaps.missingGames, true);
  const gapSummary = gapBlobs.data.get('clv-close-capture:closes-3am/2026-11-15');
  const gapGame = (id) => gapSummary.games.find((row) => row.eventId === id);
  assert.deepStrictEqual(gapGame('ne-det'), {
    sport: 'NFL', eventId: 'ne-det', matchup: 'New England Patriots @ Detroit Lions',
    status: 'no-close', reason: 'not-in-historical-snapshot', closeLeadMin: 1,
  });
  assert.deepStrictEqual(gapGame('partial'), {
    sport: 'NFL', eventId: 'partial', matchup: 'Jacksonville Jaguars @ Tennessee Titans',
    status: 'closed', reason: null, closeLeadMin: 1,
  });
  assert.strictEqual(gapGame('nhl-retry').status, 'closed');
  assert.strictEqual(gapGame('nhl-retry').closeLeadMin, 1);
  assert.strictEqual(gapGame('games-closed').status, 'closed');
  assert.strictEqual(gapGame('already'), undefined);
  const gapSpread = gaps.picks.find((row) => row.pick === 'Vancouver Canucks +2.5');
  const gapMl = gaps.picks.find((row) => row.pick === 'Vancouver Canucks ML');
  assert.strictEqual(gapSpread.status, 'closed');
  assert.strictEqual(gapSpread.closeLeadMin, 15);
  assert.strictEqual(gapMl.status, 'closed');
  assert.strictEqual(gapMl.closeLeadMin, 1);
  assert.ok(gaps.calls.every((call) => call.path === 'closes-3am-historical' && call.estCost === 60));

  const schedCalls = [];
  const sched = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15', missingGames: true, scheduled: true }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T09:10:00Z'),
    blobs: memBlobs({
      'clv-close-capture:done-bucket/NFL/2026-11-15T14:32:33Z': { at: '2026-11-16T08:00:00Z' },
    }),
    slateEvents: [
      { sport: 'NFL', eventId: 'ne-det', awayTeam: 'New England Patriots', homeTeam: 'Detroit Lions', commenceTime: '2026-11-15T14:33:33Z' },
    ],
    card: { picks: [] },
    skipGrade: true,
    skipMirror: true,
    invokeTrack: async () => ({ ok: true, status: 200 }),
    storeClose: async () => ({ wrote: true }),
    writeRows: async () => ({ games: 0, odds_snapshots: 0, requests: 0 }),
    fetch: async (url) => { schedCalls.push(String(url)); return oddsResponse(wrapped([])); },
  });
  assert.strictEqual(sched.statusCode, 200);
  assert.strictEqual(schedCalls.length, 0, 'scheduled runs ignore missingGames');
  assert.strictEqual(JSON.parse(sched.body).missingGames, false);

  const manualCalls = [];
  const manualWritten = [];
  const manualBlobs = memBlobs({
    'clv-close-capture:done-bucket/NFL/2026-11-15T14:32:33Z': { at: '2026-11-16T08:00:00Z' },
    'clv-close-capture:done-ev/NFL/keep-live': liveEv,
    'clv-close-capture:done-ev/NFL/walkin-done': liveEv,
  });
  const manual = await bg.handle({
    headers: { 'x-picks-secret': 'secret' },
    body: JSON.stringify({ date: '2026-11-15', missingGames: true }),
  }, {
    env: { PICKS_SECRET_KEY: 'secret', ODDS_API_KEY: 'test-key', OMEGA_CLOSES_AT_3AM: 'on' },
    now: new Date('2026-11-16T09:20:00Z'),
    blobs: manualBlobs,
    slateEvents: [
      { sport: 'NFL', eventId: 'ne-det', awayTeam: 'New England Patriots', homeTeam: 'Detroit Lions', commenceTime: '2026-11-15T14:33:33Z' },
      { sport: 'NFL', eventId: 'keep-live', awayTeam: 'Chicago Bears', homeTeam: 'Green Bay Packers', commenceTime: '2026-11-15T21:25:00Z' },
    ],
    card: { picks: [] },
    skipGrade: true,
    skipMirror: true,
    invokeTrack: async () => ({ ok: true, status: 200 }),
    storeClose: async (ev) => ({ wrote: true, id: ev.id }),
    writeRows: async (built) => {
      manualWritten.push(...built.games.map((row) => row.game_id));
      return { games: built.games.length, odds_snapshots: built.snaps.length, requests: 0 };
    },
    fetch: async (url) => {
      manualCalls.push(String(url));
      return oddsResponse(wrapped([
        event('ne-det', 'Detroit Lions', 'New England Patriots', '2026-11-15T14:33:33Z'),
        event('keep-live', 'Green Bay Packers', 'Chicago Bears', '2026-11-15T14:34:00Z'),
        event('walkin-done', 'Dallas Cowboys', 'Philadelphia Eagles', '2026-11-15T14:34:30Z'),
      ], '2026-11-15T14:32:33Z'));
    },
  });
  assert.strictEqual(manual.statusCode, 200);
  assert.deepStrictEqual(manualCalls.map((url) => new URL(url).searchParams.get('date')), ['2026-11-15T14:32:33Z']);
  const gapManualBody = JSON.parse(manual.body);
  assert.strictEqual(gapManualBody.missingGames, true);
  assert.strictEqual(gapManualBody.games.find((row) => row.eventId === 'ne-det').status, 'closed');
  assert.deepStrictEqual(manualWritten, ['ne-det']);
  assert.deepStrictEqual(manualBlobs.data.get('clv-close-capture:done-ev/NFL/keep-live'), liveEv);
  assert.deepStrictEqual(manualBlobs.data.get('clv-close-capture:done-ev/NFL/walkin-done'), liveEv);
  assert.ok(!JSON.stringify(gapManualBody).includes('test-key'));

  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  const pickBlock = toml.split('[functions."capture-pick-closes"]')[1].split('[functions.')[0];
  const clvBlock = toml.split('[functions."trigger-clv"]')[1].split('[functions.')[0];
  const closeBlock = toml.split('[functions."capture-closes-3am-background"]')[1].split('[functions.')[0];
  assert.ok(!/^\s*schedule\s*=/m.test(pickBlock));
  assert.ok(pickBlock.includes('# schedule = "*/5 * * * *"'));
  assert.ok(!/^\s*schedule\s*=/m.test(clvBlock));
  assert.ok(clvBlock.includes('# schedule = "0 7,17,23 * * *"'));
  assert.ok(!/^\s*schedule\s*=/m.test(closeBlock));
  assert.ok(/\[functions\."capture-odds-3am"\]\s*\n\s*schedule = "0 7,8 \* \* \*"/.test(toml));
  assert.ok(/\[functions\."capture-odds-10am"\]\s*\n\s*schedule = "0 14,15 \* \* \*"/.test(toml));
  assert.ok(/\[functions\."monitor-omega-missed-pull"\]\s*\n\s*schedule = "15 7,8 \* \* \*"/.test(toml));

  console.log('PASS test-closes-3am');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
