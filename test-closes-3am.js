'use strict';

/**
 * 3 AM historical closes. Fixtures only. No Odds API, no production blobs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const C = require('./netlify/functions/lib/closes-3am');
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
  assert.strictEqual(nba[0].from, '2026-11-15T18:00:00Z');
  assert.strictEqual(nba[0].to, '2026-11-15T18:10:00Z');
  assert.strictEqual(nba[1].snapshotAt, '2026-11-15T18:09:01Z');
  assert.strictEqual(nba[1].to, '2026-11-15T18:10:02Z');

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
  assert.strictEqual(calls.length, 3);
  assert.ok(calls[0].includes('icehockey_nhl') || calls[0].includes('basketball_nba'));
  assert.ok(calls[2].includes('americanfootball_nfl'), 'board bucket is after card buckets');
  const nhlUrl = calls.find((url) => url.includes('icehockey_nhl'));
  assert.ok(nhlUrl.includes('date=2026-11-15T22%3A59%3A00Z') || nhlUrl.includes('date=2026-11-15T22:59:00Z'));
  const nhlPick = first.picks.find((row) => row.eventId === 'nhl1' || row.pick === 'Bruins ML');
  const nbaPick = first.picks.find((row) => row.pick === 'Magic ML');
  assert.strictEqual(nhlPick.status, 'closed');
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
