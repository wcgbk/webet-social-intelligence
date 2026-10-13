'use strict';
/**
 * Daily Supabase sync. Blobs and fetch are in memory.
 * No Odds API call. No 10:30 lock capture is stored.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sync = require('./netlify/functions/sync-supabase');
const lib = require('./netlify/functions/lib/supabase-sync');
const master = require('./netlify/functions/lib/omega-vnext/odds_master');
const lines = require('./netlify/functions/lib/omega-vnext/pinnacle_line_move');
const { BLOB_STORE, MODEL_VERSION, MODEL_NOTES } = require('./netlify/functions/lib/omega-vnext/config');
const ledger = require('./netlify/functions/lib/clv-ledger');
const schedule = require('./netlify/functions/lib/et-schedule');

const DATE = '2026-10-12';
const HOME = 'New York Yankees';
const AWAY = 'Boston Red Sox';
const COMMENCE = '2026-10-12T23:05:00Z';
const HOME2 = 'Baltimore Orioles';
const AWAY2 = 'Tampa Bay Rays';
const COMMENCE2 = '2026-10-12T23:10:00Z';
const T_OPEN = '2026-10-12T07:00:00.000Z';
const T_BASE = '2026-10-12T07:05:00.000Z';
const T_0300 = '2026-10-12T07:10:00.000Z';
const T_10 = '2026-10-12T14:00:00.000Z';
const T_CLOSE = '2026-10-12T22:00:00.000Z';
const T_1030 = '2026-10-12T14:30:00.000Z';
const LOST_COMMENCE = '2026-10-12T18:00:00Z';
const PICKS_SECRET = 'test-picks-secret';
const ADMIN_SECRET = 'test-admin-secret';
const SERVICE_KEY = 'test-service-role';
const WRITE_ENV = { OMEGA_REPLAY_NO_WRITE: '0' };

function h2hEvent(id, book, homePrice, awayPrice, home, away, commence) {
  return {
    id,
    commence_time: commence,
    home_team: home,
    away_team: away,
    bookmakers: [{
      key: book,
      markets: [{
        key: 'h2h',
        outcomes: [
          { name: home, price: homePrice },
          { name: away, price: awayPrice },
        ],
      }],
    }],
  };
}

function h2hQuotes(id, book, homePrice, awayPrice, at, home, away, commence) {
  const quotes = lines.quotesFromEvent(
    h2hEvent(id, book, homePrice, awayPrice, home, away, commence),
    'MLB',
    { at, book },
    book,
  );
  assert.strictEqual(
    Object.keys(quotes).length,
    2,
    `expected two h2h quotes for ${id} ${book} ${homePrice}/${awayPrice}`,
  );
  return quotes;
}

function memory() {
  const blobs = new Map();
  return {
    blobs,
    async read(store, key) {
      const hit = blobs.get(`${store}\0${key}`);
      return hit == null ? null : JSON.parse(JSON.stringify(hit));
    },
    async write(store, key, data) {
      blobs.set(`${store}\0${key}`, JSON.parse(JSON.stringify(data)));
    },
    snapshot() {
      return JSON.stringify([...blobs.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}

function io(mem, storeName) {
  return {
    env: WRITE_ENV,
    read: (key) => mem.read(storeName, key),
    write: (key, data) => mem.write(storeName, key, data),
  };
}

async function storeMaster(mem, input) {
  const saved = await master.storeQuotes(input, io(mem, master.STORE));
  assert.strictEqual(saved.wrote, true, `storeQuotes ${input.role} ${input.book}: ${saved.reason}`);
  return saved;
}

function mlbGame() {
  return {
    state: 'post',
    completed: true,
    statusName: 'STATUS_FINAL',
    awayTeam: AWAY,
    homeTeam: HOME,
    awayScore: 3,
    homeScore: 5,
    awayLine: [3, 0, 0, 0, 0, 0, 0, 0, 0],
    homeLine: [5, 0, 0, 0, 0, 0, 0, 0, 0],
    awayInnings: 9,
    homeInnings: 9,
    startISO: COMMENCE,
    _sport: 'MLB',
  };
}

function straight(selection, odds) {
  return {
    sport: 'MLB',
    matchup: `${AWAY} @ ${HOME}`,
    pick: selection,
    betType: 'moneyline',
    odds,
    units: '1u',
    commenceTime: COMMENCE,
    homeTeam: HOME,
    awayTeam: AWAY,
  };
}

function adminToken(secret) {
  const encoded = Buffer.from(JSON.stringify({
    email: 'ops@example.com',
    exp: Date.now() + 60 * 60 * 1000,
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

function schedulerEvent(extra) {
  return Object.assign({
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: '2026-10-14T13:25:00.000Z' }),
  }, extra);
}

function manualEvent(qs, headers) {
  return {
    httpMethod: 'GET',
    headers: headers || {},
    queryStringParameters: qs || {},
  };
}

function baseEnv(extra) {
  return Object.assign({
    PICKS_SECRET_KEY: PICKS_SECRET,
    ADMIN_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  }, extra);
}

function depsFor(mem, extra) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 201, text: async () => '' };
  };
  const deps = Object.assign({
    read: (store, key) => mem.read(store, key),
    env: baseEnv(),
    games: [mlbGame()],
    fetch: fetchImpl,
    writeLog: async () => { throw new Error('writeLog should not run'); },
  }, extra);
  deps.fetch.calls = calls;
  if (extra && extra.fetch) deps.fetch.calls = calls;
  return deps;
}

function bodyOf(res) {
  return JSON.parse(res.body || '{}');
}

function postedBodies(calls) {
  return calls.map((call) => JSON.parse(call.init.body));
}

function assertSupabaseCall(call, table, conflict, profile) {
  const url = new URL(call.url);
  assert.strictEqual(url.protocol, 'https:');
  assert.strictEqual(url.host, 'qvfgebrkolfyggfizgkx.supabase.co');
  assert.strictEqual(url.pathname, `/rest/v1/${table}`);
  assert.strictEqual(url.searchParams.get('on_conflict'), conflict);
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.headers.apikey, SERVICE_KEY);
  assert.strictEqual(call.init.headers.Authorization, `Bearer ${SERVICE_KEY}`);
  assert.strictEqual(call.init.headers['Content-Type'], 'application/json');
  assert.strictEqual(call.init.headers['Content-Profile'], profile);
  assert.strictEqual(call.init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.ok(!/merge-duplicates/i.test(call.init.headers.Prefer));
  assert.ok(!/the-odds-api/i.test(call.url));
  const rows = JSON.parse(call.init.body);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0 && rows.length <= 500);
  return rows;
}

function runsOnDay(startIso, minutes) {
  const start = new Date(startIso).getTime();
  const cron = '25 13,14 * * *';
  let runs = 0;
  let matched = null;
  for (let i = 0; i < minutes; i += 1) {
    const when = new Date(start + i * 60 * 1000);
    if (!schedule.cronMatches(cron, when)) continue;
    const guard = schedule.etGuard('sync-supabase', schedulerEvent(), when);
    if (!guard.run) continue;
    runs += 1;
    matched = guard.matched;
  }
  return { runs, matched };
}

(async () => {
  assert.strictEqual(sync.handler.length, 2);
  assert.strictEqual(MODEL_VERSION, 'v12.3.71-omega-vnext-price-lock');
  assert.ok(String(MODEL_NOTES).startsWith('v12.3.71-omega-vnext-price-lock:'));
  assert.ok(!/placeholder/i.test(String(MODEL_NOTES)));
  assert.ok(/10:30/.test(lib.LOCK_NOTE));
  assert.ok(/10:00/.test(lib.LOCK_NOTE));
  assert.ok(/3:00/.test(lib.LOCK_NOTE));

  const srcLib = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/supabase-sync.js'), 'utf8');
  const srcFn = fs.readFileSync(path.join(__dirname, 'netlify/functions/sync-supabase.js'), 'utf8');
  assert.ok(!/the-odds-api/i.test(srcLib + srcFn));
  assert.ok(!/resolution=merge-duplicates/.test(srcLib));
  assert.strictEqual(lib.BATCH_LIMIT, 500);
  assert.deepStrictEqual(schedule.ET_SCHEDULE['sync-supabase'].etTimes, ['09:25']);

  const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
  const block = toml.split('[functions."sync-supabase"]')[1].split('\n[')[0];
  assert.ok(block.includes('schedule = "25 13,14 * * *"'));
  assert.ok(block.includes('netlify/functions/lib/omega-vnext/**'));
  assert.ok(block.includes('netlify/functions/lib/clv-ledger.js'));
  assert.ok(block.includes('netlify/functions/lib/omega-grading-rules.js'));
  assert.ok(block.includes('js/live-score.js'));
  const active = schedule.activeTomlSchedules(toml).filter((row) => row.functionName === 'sync-supabase');
  assert.deepStrictEqual(active.map((row) => row.cron), ['25 13,14 * * *']);
  const hours = schedule.utcHoursForEt('09:25');
  assert.strictEqual(hours.minute, 25);
  assert.deepStrictEqual(hours.hours, [13, 14]);

  const guardEvent = schedulerEvent();
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-10-13T13:25:00Z')).matched, '09:25');
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-10-13T13:25:00Z')).run, true);
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-12-13T14:25:00Z')).run, true);
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-12-13T14:25:00Z')).matched, '09:25');
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-12-13T13:25:00Z')).run, false);
  assert.strictEqual(schedule.etGuard('sync-supabase', guardEvent, new Date('2026-10-13T14:25:00Z')).run, false);
  assert.deepStrictEqual(runsOnDay('2026-10-13T04:00:00Z', 24 * 60), { runs: 1, matched: '09:25' });
  assert.deepStrictEqual(runsOnDay('2026-12-13T05:00:00Z', 24 * 60), { runs: 1, matched: '09:25' });
  assert.deepStrictEqual(runsOnDay('2026-11-01T04:00:00Z', 25 * 60), { runs: 1, matched: '09:25' });

  const mem = memory();
  const masterIo = io(mem, master.STORE);
  const ev1Open = h2hQuotes('ev1', 'pinnacle', -150, 130, T_OPEN, HOME, AWAY, COMMENCE);
  const ev1Snap = h2hQuotes('ev1', 'pinnacle', -140, 120, T_10, HOME, AWAY, COMMENCE);
  const ev1Close = h2hQuotes('ev1', 'pinnacle', -160, 140, T_CLOSE, HOME, AWAY, COMMENCE);
  const ev1Dk = h2hQuotes('ev1', 'draftkings', -145, 125, T_10, HOME, AWAY, COMMENCE);
  const ev1Base = h2hQuotes('ev1', 'pinnacle', 333, -110, T_BASE, HOME, AWAY, COMMENCE);
  const ev1Chk = h2hQuotes('ev1', 'pinnacle', 333, -120, T_0300, HOME, AWAY, COMMENCE);
  const meta1 = {
    sport: 'MLB',
    eventId: 'ev1',
    homeTeam: HOME,
    awayTeam: AWAY,
    commenceTime: COMMENCE,
    date: DATE,
  };
  await storeMaster(mem, { ...meta1, book: 'pinnacle', role: 'open', timestamp: T_OPEN, quotes: ev1Open });
  await storeMaster(mem, { ...meta1, book: 'pinnacle', role: 'check-1000', timestamp: T_10, quotes: ev1Snap });
  await storeMaster(mem, { ...meta1, book: 'draftkings', role: 'check-1000', timestamp: T_10, quotes: ev1Dk });
  await storeMaster(mem, {
    ...meta1,
    book: 'pinnacle',
    role: 'close',
    timestamp: T_CLOSE,
    snapshotAt: T_CLOSE,
    quotes: ev1Close,
    source: 'historical',
  });
  await storeMaster(mem, { ...meta1, book: 'pinnacle', role: 'baseline-0300', timestamp: T_BASE, quotes: ev1Base });
  await storeMaster(mem, { ...meta1, book: 'pinnacle', role: 'check-0300', timestamp: T_0300, quotes: ev1Chk });

  const dupOpen = h2hQuotes('ev1', 'pinnacle', -151, 131, T_OPEN, HOME, AWAY, COMMENCE);
  const opened = await lines.storeOpen('MLB', 'ev1', {
    at: T_OPEN,
    date: DATE,
    homeTeam: HOME,
    awayTeam: AWAY,
    commenceTime: COMMENCE,
    quotes: dupOpen,
  }, io(mem, lines.LINE_MOVE_STORE));
  assert.strictEqual(opened.wrote, true, opened.reason);

  const ev2Open = h2hQuotes('ev2', 'pinnacle', -110, -110, T_OPEN, HOME2, AWAY2, COMMENCE2);
  const ev2Pin = h2hQuotes('ev2', 'pinnacle', -115, -105, T_10, HOME2, AWAY2, COMMENCE2);
  const ev2Dk = h2hQuotes('ev2', 'draftkings', -118, -102, T_10, HOME2, AWAY2, COMMENCE2);
  const lineIo = io(mem, lines.LINE_MOVE_STORE);
  const ev2Stored = await lines.storeOpen('MLB', 'ev2', {
    at: T_OPEN,
    date: DATE,
    homeTeam: HOME2,
    awayTeam: AWAY2,
    commenceTime: COMMENCE2,
    quotes: ev2Open,
  }, lineIo);
  assert.strictEqual(ev2Stored.wrote, true, ev2Stored.reason);
  const ev2Check = await lines.storeCheck('MLB', 'ev2', {
    slot: '1000',
    at: T_10,
    date: DATE,
    homeTeam: HOME2,
    awayTeam: AWAY2,
    commenceTime: COMMENCE2,
    books: { pinnacle: ev2Pin, draftkings: ev2Dk },
  }, lineIo);
  assert.strictEqual(ev2Check.wrote, true, ev2Check.reason);

  const yankees = {
    sport: 'MLB',
    market: 'moneyline',
    side: 'New York Yankees ML',
    matchup: `${AWAY} @ ${HOME}`,
    homeTeam: HOME,
    awayTeam: AWAY,
    commenceTime: COMMENCE,
    odds: '-150',
    clvCents: 2,
    closingOdds: '-155',
    beatClose: true,
    published: true,
    book: 'pinnacle',
  };
  const lost = {
    sport: 'MLB',
    market: 'moneyline',
    side: 'Nowhere FC ML',
    matchup: 'Lost City @ Nowhere FC',
    homeTeam: 'Nowhere FC',
    awayTeam: 'Lost City',
    commenceTime: LOST_COMMENCE,
    odds: '-110',
    clvCents: 1,
    published: true,
    id: 'not-an-event',
  };
  await mem.write(BLOB_STORE, `clv-candidates-v2/${DATE}`, { candidates: [yankees, lost] });
  const expectedClv = ledger.rowsFromBlob(`clv-candidates-v2/${DATE}`, { candidates: [yankees, lost] }, { source: 'omega', date: DATE });
  assert.strictEqual(expectedClv.length, 2);

  const win = straight('New York Yankees ML', '-150');
  const lose = straight('Boston Red Sox ML', '+130');
  const card = {
    date: DATE,
    picks: [win, lose],
    parlayLegs: [{ units: '0.25u', leanDay: true, legs: [win, lose] }],
  };
  await mem.write(BLOB_STORE, `picks-${DATE}`, card);
  const before = mem.snapshot();

  const dryFetch = async () => { throw new Error('dry run must not fetch'); };
  const dry = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE, key: PICKS_SECRET }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, { fetch: dryFetch, writeLog: async () => { throw new Error('dry run must not log'); } }),
  );
  assert.strictEqual(dry.statusCode, 200);
  const dryBody = bodyOf(dry);
  assert.strictEqual(dryBody.dryRun, true);
  assert.strictEqual(dryBody.date, DATE);
  assert.strictEqual(dryBody.requests, 0);
  assert.strictEqual(dryBody.oddsApiCalls, 0);
  assert.strictEqual(dryBody.wroteLog, false);
  assert.strictEqual(dryBody.ok, true);
  assert.strictEqual(dryBody.lockNote, lib.LOCK_NOTE);
  assert.strictEqual(dryBody.counts.games, 2);
  assert.strictEqual(dryBody.counts.odds_snapshots, 14);
  assert.strictEqual(dryBody.counts.clv_results, 2);
  assert.strictEqual(dryBody.counts.picks, 3);
  assert.ok(dryBody.sample.games);
  assert.ok(dryBody.sample.odds_snapshots);
  assert.ok(dryBody.sample.clv_results);
  assert.ok(dryBody.sample.picks);
  assert.deepStrictEqual(dryBody.rows.games.map((row) => row.game_id), ['ev1', 'ev2']);
  assert.ok(dryBody.rows.games.every((row) => row.season == null && row.sport));
  assert.ok(!JSON.stringify(dryBody.rows.games).includes('not-an-event'));
  assert.ok(!JSON.stringify(dryBody.rows.games).includes('Nowhere'));
  const prices = dryBody.rows.odds_snapshots.map((row) => row.price);
  assert.ok(prices.includes(-150));
  assert.ok(!prices.includes(-151));
  assert.ok(!prices.includes(333));
  assert.ok(dryBody.rows.odds_snapshots.every((row) => ['opening', 'snapshot', 'closing'].includes(row.line_type)));
  assert.ok(dryBody.rows.odds_snapshots.every((row) => row.snapshot_ts !== T_1030));
  const ev1Rows = dryBody.rows.odds_snapshots.filter((row) => row.game_id === 'ev1' && row.book === 'pinnacle' && row.side === 'home');
  assert.deepStrictEqual(ev1Rows.map((row) => row.line_type).sort(), ['closing', 'opening', 'snapshot']);
  assert.strictEqual(ev1Rows.find((row) => row.line_type === 'opening').price, -150);
  assert.strictEqual(ev1Rows.find((row) => row.line_type === 'snapshot').price, -140);
  assert.strictEqual(ev1Rows.find((row) => row.line_type === 'snapshot').snapshot_ts, T_10);
  assert.strictEqual(ev1Rows.find((row) => row.line_type === 'closing').price, -160);
  const ev2Types = new Set(dryBody.rows.odds_snapshots.filter((row) => row.game_id === 'ev2').map((row) => row.line_type));
  assert.ok(ev2Types.has('opening'));
  assert.ok(ev2Types.has('snapshot'));
  assert.ok(!ev2Types.has('closing'));
  const dkSnap = dryBody.rows.odds_snapshots.find((row) => row.game_id === 'ev1' && row.book === 'draftkings' && row.side === 'home');
  assert.strictEqual(dkSnap.line_type, 'snapshot');
  assert.strictEqual(dkSnap.price, -145);
  const yankeeClv = dryBody.rows.clv_results.find((row) => row.selection === 'New York Yankees ML');
  const lostClv = dryBody.rows.clv_results.find((row) => row.selection === 'Nowhere FC ML');
  assert.ok(yankeeClv);
  assert.strictEqual(yankeeClv.game_id, 'ev1');
  assert.strictEqual(yankeeClv.model, 'Omega');
  assert.strictEqual(yankeeClv.pick_key, expectedClv.find((row) => String(row.side).includes('Yankees')).key);
  assert.strictEqual(yankeeClv.clv_cents, 2);
  assert.strictEqual(yankeeClv.close_price, -155);
  assert.strictEqual(lostClv.game_id, null);
  assert.ok(dryBody.skipped.some((row) => row.reason === 'unmatched' && row.home === 'Nowhere FC'));
  const parlay = dryBody.rows.picks.find((row) => row.is_parlay);
  const straights = dryBody.rows.picks.filter((row) => !row.is_parlay);
  assert.strictEqual(dryBody.rows.picks.filter((row) => row.is_parlay).length, 1);
  assert.strictEqual(parlay.units, 0.25);
  assert.strictEqual(parlay.risk, 37.5);
  assert.strictEqual(parlay.profit, -37.5);
  assert.strictEqual(parlay.result, 'loss');
  assert.strictEqual(parlay.model, 'Omega');
  assert.strictEqual(parlay.sport, 'PARLAY');
  assert.ok(straights.every((row) => row.model === 'Omega' && row.risk === 150));
  const yankeePick = straights.find((row) => row.selection === 'New York Yankees ML');
  const soxPick = straights.find((row) => row.selection === 'Boston Red Sox ML');
  assert.strictEqual(yankeePick.result, 'win');
  assert.strictEqual(yankeePick.profit, 100);
  assert.strictEqual(soxPick.result, 'loss');
  assert.strictEqual(soxPick.profit, -150);
  assert.strictEqual(mem.snapshot(), before);

  await mem.write(BLOB_STORE, `picks-${DATE}`, { date: DATE, picks: [win, lose], parlayLegs: [] });
  const noParlay = await lib.buildSync({
    date: DATE,
    dryRun: true,
    now: new Date('2026-10-13T13:25:00Z'),
    deps: { read: (store, key) => mem.read(store, key), games: [mlbGame()], env: baseEnv() },
  });
  assert.strictEqual(noParlay.rows.picks.length, 2);
  assert.ok(noParlay.rows.picks.every((row) => row.is_parlay === false));
  await mem.write(BLOB_STORE, `picks-${DATE}`, card);

  const denied = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE }),
    new Date('2026-10-13T12:25:00Z'),
    depsFor(mem, { fetch: dryFetch, env: {} }),
  );
  assert.strictEqual(denied.statusCode, 401);
  const openBearer = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE }, { authorization: 'Bearer open' }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, { fetch: dryFetch }),
  );
  assert.strictEqual(openBearer.statusCode, 401);
  const demoBearer = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE }, { authorization: 'Bearer demo' }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, { fetch: dryFetch }),
  );
  assert.strictEqual(demoBearer.statusCode, 401);

  const authed = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE }, { authorization: `Bearer ${adminToken(ADMIN_SECRET)}` }),
    new Date('2026-12-13T13:25:00Z'),
    depsFor(mem, {
      fetch: dryFetch,
      env: { ADMIN_SECRET, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY },
    }),
  );
  assert.strictEqual(authed.statusCode, 200);
  assert.notStrictEqual(bodyOf(authed).skipped, 'et-guard');
  assert.strictEqual(bodyOf(authed).counts.games, 2);
  assert.strictEqual(bodyOf(authed).dryRun, true);

  const headerAuth = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE }, { 'x-picks-secret': PICKS_SECRET }),
    new Date('2026-12-13T13:25:00Z'),
    depsFor(mem, { fetch: dryFetch }),
  );
  assert.strictEqual(headerAuth.statusCode, 200);

  let reads = 0;
  const counting = depsFor(mem, {
    read: async (store, key) => {
      reads += 1;
      return mem.read(store, key);
    },
    fetch: dryFetch,
  });
  const skippedSlot = await sync.handle(schedulerEvent(), new Date('2026-12-13T13:25:00Z'), counting);
  assert.strictEqual(skippedSlot.statusCode, 200);
  assert.strictEqual(bodyOf(skippedSlot).skipped, 'et-guard');
  assert.strictEqual(reads, 0);

  const bad = await sync.handle(
    manualEvent({ date: 'yesterday', key: PICKS_SECRET }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, { fetch: dryFetch }),
  );
  assert.strictEqual(bad.statusCode, 200);
  assert.strictEqual(bodyOf(bad).ok, false);
  assert.strictEqual(bodyOf(bad).error, 'bad date');

  const options = await sync.handle({ httpMethod: 'OPTIONS' }, new Date(), null);
  assert.strictEqual(options.statusCode, 200);

  const logs = [];
  const origErr = console.error;
  console.error = (...args) => {
    logs.push(args.map((part) => String(part)).join(' '));
  };
  let postCalls = [];
  try {
    const posted = await sync.handle(
      schedulerEvent(),
      new Date('2026-10-13T13:25:00Z'),
      depsFor(mem, {
        fetch: async (url, init) => {
          postCalls.push({ url: String(url), init });
          const table = new URL(url).pathname.split('/').pop();
          if (table === 'games') return { ok: false, status: 500, text: async () => 'db down' };
          return { ok: true, status: 201, text: async () => '' };
        },
      }),
    );
    assert.strictEqual(posted.statusCode, 200);
    const postedBody = bodyOf(posted);
    assert.strictEqual(postedBody.date, DATE);
    assert.strictEqual(postedBody.dryRun, false);
    assert.ok(postedBody.errors.length > 0);
    assert.strictEqual(postedBody.ok, false);
    assert.strictEqual(postedBody.oddsApiCalls, 0);
    assert.ok(!JSON.stringify(postedBody).includes(SERVICE_KEY));
    assert.ok(logs.some((line) => line.includes('supabase 500')));
    assert.ok(!logs.join('\n').includes(SERVICE_KEY));
  } finally {
    console.error = origErr;
  }
  assert.strictEqual(postCalls.length, 4);
  const byTable = {};
  for (const call of postCalls) {
    const table = new URL(call.url).pathname.split('/').pop();
    const profile = table === 'picks' ? 'kpi' : 'clv';
    const conflict = lib.TABLES[table].onConflict;
    byTable[table] = assertSupabaseCall(call, table, conflict, profile);
  }
  assert.ok(byTable.games && byTable.odds_snapshots && byTable.clv_results && byTable.picks);
  assert.ok(postCalls.every((call) => call.init.method === 'POST'));
  assert.ok(!JSON.stringify(postedBodies(postCalls)).includes('333'));
  assert.ok(!JSON.stringify(postedBodies(postCalls)).includes('-151'));
  const postedParlay = byTable.picks.find((row) => row.is_parlay);
  assert.strictEqual(postedParlay.units, 0.25);
  assert.strictEqual(postedParlay.risk, 37.5);
  assert.strictEqual(mem.snapshot(), before);

  const logWrites = [];
  const logged = await sync.handle(
    schedulerEvent(),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, {
      env: baseEnv({ OMEGA_REPLAY_NO_WRITE: '0' }),
      writeLog: async (key, payload) => { logWrites.push({ key, payload }); },
      fetch: async (url, init) => {
        postCalls.push({ url: String(url), init });
        return { ok: true, status: 201, text: async () => '' };
      },
    }),
  );
  assert.strictEqual(logged.statusCode, 200);
  assert.strictEqual(bodyOf(logged).wroteLog, true);
  assert.deepStrictEqual(logWrites.map((row) => row.key), [DATE]);
  assert.ok(!JSON.stringify(logWrites).includes(SERVICE_KEY));

  const dryLogged = await sync.handle(
    manualEvent({ dryRun: '1', date: DATE, key: PICKS_SECRET }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, {
      env: baseEnv({ OMEGA_REPLAY_NO_WRITE: '0' }),
      fetch: dryFetch,
      writeLog: async () => { throw new Error('dry run wrote a log'); },
    }),
  );
  assert.strictEqual(dryLogged.statusCode, 200);
  assert.strictEqual(bodyOf(dryLogged).wroteLog, false);

  const missingKey = await sync.handle(
    manualEvent({ date: DATE, key: PICKS_SECRET }),
    new Date('2026-10-13T13:25:00Z'),
    depsFor(mem, {
      env: { PICKS_SECRET_KEY: PICKS_SECRET },
      fetch: async () => { throw new Error('missing key must not fetch'); },
    }),
  );
  assert.strictEqual(missingKey.statusCode, 200);
  assert.ok(bodyOf(missingKey).errors.some((row) => /SUPABASE_SERVICE_ROLE_KEY/.test(row.error)));

  const many = Array.from({ length: 501 }, (_, i) => ({
    game_id: `g${String(i).padStart(4, '0')}`,
    sport: 'MLB',
    season: null,
    commence_time: null,
    home_team: 'H',
    away_team: 'A',
    source: 'test',
  }));
  many.push({ ...many[0] });
  const batchCalls = [];
  const batched = await lib.postRows('games', many, {
    env: { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY },
    fetchImpl: async (url, init) => {
      batchCalls.push({ url: String(url), init });
      return { ok: true, status: 201, text: async () => '' };
    },
  });
  assert.strictEqual(batchCalls.length, 2);
  assert.strictEqual(JSON.parse(batchCalls[0].init.body).length, 500);
  assert.strictEqual(JSON.parse(batchCalls[1].init.body).length, 1);
  assert.strictEqual(batched.posted, 501);
  assert.strictEqual(batched.requests, 2);
  assertSupabaseCall(batchCalls[0], 'games', 'game_id', 'clv');

  console.log('PASS test-omega-supabase-sync');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
