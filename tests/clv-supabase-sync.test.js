'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sync = require('../netlify/functions/sync-supabase');
const bg = require('../netlify/functions/sync-supabase-background');
const cap = require('../netlify/functions/capture-pick-closes');
const { snapsFromPriceDoc, clvRows } = require('../netlify/functions/lib/clv-sync');
const S = require('../netlify/functions/lib/clv-supabase');

const EV = { sport: 'NHL', eventId: 'e1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-10-20T23:00:00Z' };

function memBlobs(data) {
  const store = new Map(Object.entries(data));
  return {
    writes: [],
    async get(s, k) { return store.get(`${s}:${k}`) || null; },
    async list(s, p) { return [...store.keys()].filter((k) => k.startsWith(`${s}:${p}`)).map((k) => k.slice(s.length + 1)); },
    async set(s, k, v) { this.writes.push([s, k]); store.set(`${s}:${k}`, v); },
  };
}
function fakeFetch(log, oddsBody) {
  return async (url, opts = {}) => {
    log.push({ url, opts });
    if (String(url).includes('the-odds-api')) {
      return { ok: true, status: 200, headers: { get: (h) => (h === 'x-requests-last' ? '1' : '999') }, json: async () => oddsBody };
    }
    return { ok: true, status: url.includes('background') ? 202 : 201, text: async () => '', json: async () => ({}) };
  };
}

test('sync-supabase fails loudly on missing env', async () => {
  const r = await sync.handle({ headers: { 'x-picks-secret': 'k' } }, new Date(), { env: { PICKS_SECRET_KEY: 'k' } });
  assert.strictEqual(r.statusCode, 500);
  assert.match(JSON.parse(r.body).error, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('sync-supabase manual run queues background for date', async () => {
  const log = [];
  const env = { PICKS_SECRET_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't', URL: 'https://x' };
  const r = await sync.handle({ headers: { 'x-picks-secret': 'k' }, queryStringParameters: { date: '2026-10-20', dryRun: '1' } }, new Date(), { env, fetch: fakeFetch(log) });
  assert.strictEqual(r.statusCode, 202);
  assert.match(log[0].url, /sync-supabase-background\?date=2026-10-20&dryRun=1/);
});

test('sync-supabase rejects unauthorized manual calls', async () => {
  const r = await sync.handle({ headers: {} }, new Date(), { env: { PICKS_SECRET_KEY: 'k' } });
  assert.strictEqual(r.statusCode, 401);
});

test('price doc mapping: legacy role close/open, new format snapshot, post-start skipped', () => {
  const close = snapsFromPriceDoc({ book: 'pinnacle', market: 'spreads', role: 'close', pregame: true, snapshotAt: '2026-10-20T22:00:00Z', sides: { home: { team: 'Boston Bruins', price: -110, line: -1.5 }, away: { price: -110, line: 1.5 } } }, EV);
  assert.deepStrictEqual(close.map((r) => [r.side, r.point, r.line_type]), [['Boston Bruins', -1.5, 'closing'], ['Toronto Maple Leafs', 1.5, 'closing']]);
  const snap = snapsFromPriceDoc({ book: 'draftkings', market: 'totals', at: '2026-10-20T14:00:00Z', sides: { over: { price: -105, line: 6.5 }, under: { price: -115, line: 6.5 } } }, EV);
  assert.deepStrictEqual(snap.map((r) => [r.side, r.line_type]), [['Over', 'snapshot'], ['Under', 'snapshot']]);
  const h2h = snapsFromPriceDoc({ book: 'pinnacle', market: 'h2h', role: 'open', at: '2026-10-20T07:00:00Z', sides: { home: { price: -150, line: null } } }, EV);
  assert.strictEqual(h2h[0].point, null); assert.strictEqual(h2h[0].line_type, 'opening');
  assert.strictEqual(snapsFromPriceDoc({ book: 'pinnacle', market: 'h2h', at: '2026-10-21T00:00:00Z', sides: { home: { price: 100 } } }, EV).length, 0);
});

test('clv blob picks map to pinnacle closing rows', () => {
  const r = clvRows({ picks: [
    { sport: 'NHL', matchup: 'Toronto Maple Leafs @ Boston Bruins', pick: 'Boston Bruins -1.5', betType: 'Spread', closingOdds: 150, closingLine: -1.5, anchorBook: 'pinnacle', closeSnapshotAt: '2026-10-20T21:50:00Z' },
    { sport: 'NHL', matchup: 'Toronto Maple Leafs @ Boston Bruins', pick: 'Under 6.5', betType: 'Total', closingOdds: -110, closingLine: 6.5, anchorBook: 'pinnacle' },
    { sport: 'NBA', matchup: 'A @ B', pick: 'B ML', betType: 'Moneyline', closingOdds: -120, anchorBook: 'pinnacle' },
  ] }, [EV]);
  assert.strictEqual(r.snaps.length, 2);
  assert.deepStrictEqual([r.snaps[0].side, r.snaps[0].point, r.snaps[0].line_type], ['Boston Bruins', -1.5, 'closing']);
  assert.strictEqual(r.snaps[1].side, 'Under');
  assert.strictEqual(r.unmatched.length, 1);
});

test('background dry run builds rows and posts nothing', async () => {
  const blobs = memBlobs({
    'odds-master:by-date/2026-10-20': { events: [EV] },
    'odds-master:NHL/e1/pinnacle/totals/2026-10-20T14:00:00Z': { book: 'pinnacle', market: 'totals', at: '2026-10-20T14:00:00Z', sides: { over: { price: -105, line: 6.5 }, under: { price: -115, line: 6.5 } } },
    'odds-master:NHL/e1/raw/2026-10-20T14:00:00Z': { x: 1 },
  });
  const log = [];
  const s = await bg.run('2026-10-20', { env: { SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't' }, dryRun: true, blobs, fetchImpl: fakeFetch(log) });
  assert.strictEqual(s.built.games, 1); assert.strictEqual(s.built.odds_snapshots, 2);
  assert.strictEqual(log.length, 0);
  const live = await bg.run('2026-10-20', { env: { SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't' }, blobs, fetchImpl: fakeFetch(log) });
  assert.strictEqual(live.posted.odds_snapshots, 2);
  assert.ok(log.every((c) => /resolution=ignore-duplicates/.test(c.opts.headers.Prefer) && c.opts.headers['Content-Profile'] === 'clv'));
});

test('capture-pick-closes fails loudly on missing env', async () => {
  const r = await cap.handle({}, new Date(), { env: { SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't' } });
  assert.strictEqual(r.statusCode, 500);
  assert.match(JSON.parse(r.body).error, /ODDS_API_KEY/);
});

test('capture groups straights + parlay legs by kickoff/market and only in the 2-8 min window', () => {
  const now = new Date('2026-10-20T22:55:00Z');
  const legs = cap.cardLegs({
    picks: [{ sport: 'NHL', matchup: 'a @ b', pick: 'b -1.5', betType: 'Spread', commenceTime: '2026-10-20T23:00:00Z' },
      { sport: 'NHL', matchup: 'c @ d', pick: 'Over 6.5', betType: 'Total', commenceTime: '2026-10-21T00:00:00Z' }],
    parlayLegs: [{ legs: [{ sport: 'NHL', matchup: 'e @ f', pick: 'f -1.5', betType: 'Spread', commenceTime: '2026-10-20T23:00:00.000Z' }] }],
  });
  const g = cap.dueGroups(legs, now);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].market, 'spreads'); assert.strictEqual(g[0].picks.length, 2);
});

test('capture pulls once per group, writes closing rows, respects done marker and daily cap', async () => {
  const now = new Date('2026-10-20T22:55:00Z');
  const env = { ODDS_API_KEY: 'o', SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't' };
  const card = { picks: [{ sport: 'NHL', matchup: 'Toronto Maple Leafs @ Boston Bruins', pick: 'Boston Bruins -1.5', betType: 'Spread', commenceTime: '2026-10-20T23:00:00Z' }] };
  const odds = [{ id: 'e1', commence_time: '2026-10-20T23:00:00Z', home_team: 'Boston Bruins', away_team: 'Toronto Maple Leafs', bookmakers: [
    { key: 'pinnacle', last_update: '2026-10-20T22:54:00Z', markets: [{ key: 'spreads', outcomes: [{ name: 'Boston Bruins', price: 150, point: -1.5 }, { name: 'Toronto Maple Leafs', price: -170, point: 1.5 }] }] },
    { key: 'draftkings', last_update: '2026-10-20T22:54:30Z', markets: [{ key: 'spreads', outcomes: [{ name: 'Boston Bruins', price: 145, point: -1.5 }] }] }] }];
  const blobs = memBlobs({ 'edge-picks-omega:picks-2026-10-20': card });
  const log = [];
  const r = JSON.parse((await cap.handle({}, now, { env, blobs, fetch: fakeFetch(log, odds) })).body);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.creditsToday, 1);
  const oddsCall = log.find((c) => c.url.includes('the-odds-api'));
  assert.match(oddsCall.url, /markets=spreads/); assert.match(oddsCall.url, /regions=us&/); assert.match(oddsCall.url, /bookmakers=pinnacle%2Cdraftkings/);
  const snapPost = log.find((c) => c.url.includes('/odds_snapshots'));
  const rows = JSON.parse(snapPost.opts.body);
  assert.strictEqual(rows.length, 3); assert.ok(rows.every((x) => x.line_type === 'closing'));
  log.length = 0;
  const r2 = JSON.parse((await cap.handle({}, now, { env, blobs, fetch: fakeFetch(log, odds) })).body);
  assert.strictEqual(r2.results[0].skipped, 'done');
  assert.ok(!log.some((c) => c.url.includes('the-odds-api')));
  const blobs3 = memBlobs({ 'edge-picks-omega:picks-2026-10-20': card, 'clv-close-capture:credits/2026-10-20': { used: 100, calls: [] } });
  const r3 = JSON.parse((await cap.handle({}, now, { env, blobs: blobs3, fetch: fakeFetch(log, odds) })).body);
  assert.strictEqual(r3.results[0].skipped, 'cap');
});
