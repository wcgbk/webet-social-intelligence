'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mirror = require('../netlify/functions/lib/supa-mirror');
const { buildDay, snapsFromPriceDoc } = require('../netlify/functions/lib/clv-sync');
const bg = require('../netlify/functions/sync-supabase-background');
const cap = require('../netlify/functions/capture-pick-closes');
const backfill = require('../tools/supa-mirror/backfill');

const FIX = path.join(__dirname, '../test/fixtures/supa-mirror');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const picks = load('picks.json');
const board = load('board.json');
const clv = load('clv.json');
const verification = load('verification.json');
const tracking = load('tracking.json');
const clvReport = load('clv-report.json');
const results = load('results.json');
const DATE = '2026-11-13';

function memBlobs(data) {
  const store = new Map(Object.entries(data));
  return {
    gets: [],
    writes: [],
    async get(s, k) { this.gets.push(`${s}:${k}`); return store.has(`${s}:${k}`) ? store.get(`${s}:${k}`) : null; },
    async list(s, p) { return [...store.keys()].filter((k) => k.startsWith(`${s}:${p}`)).map((k) => k.slice(s.length + 1)); },
    async set(s, k, v) { this.writes.push([s, k, v]); store.set(`${s}:${k}`, v); },
  };
}

function okFetch(log) {
  return async (url, opts = {}) => {
    log.push({ url: String(url), opts });
    return { ok: true, status: 201, text: async () => '', json: async () => ({}), headers: { get: () => null } };
  };
}

const EV = {
  sport: 'NBA', eventId: 'e1', homeTeam: 'Miami Heat', awayTeam: 'Cleveland Cavaliers', commenceTime: '2026-11-14T01:10:00Z',
};

test('flag defaults on and off|0|false disable it', () => {
  assert.equal(mirror.enabled({}), true);
  assert.equal(mirror.enabled({ SUPABASE_MIRROR_V2: '' }), true);
  assert.equal(mirror.enabled({ SUPABASE_MIRROR_V2: 'on' }), true);
  assert.equal(mirror.enabled({ SUPABASE_MIRROR_V2: 'off' }), false);
  assert.equal(mirror.enabled({ SUPABASE_MIRROR_V2: '0' }), false);
  assert.equal(mirror.enabled({ SUPABASE_MIRROR_V2: 'FALSE' }), false);
});

test('board and card builders on the sample blobs', () => {
  const rows = mirror.buildBoardRows(board, picks, DATE);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.is_pick).length, 1);
  assert.ok(rows.every((r) => r.row_key.length === 20));
  const picked = rows.find((r) => r.is_pick);
  assert.equal(picked.side, 'Cleveland Cavaliers +2.5');
  assert.equal(picked.p_cal, board.candidates.find((c) => c.side === picked.side).coverProb);
  assert.equal(picked.odds, -112);
  assert.equal(picked.model_version, board.modelVersion);
  const again = mirror.buildBoardRows(board, picks, DATE).map((r) => r.row_key).sort();
  assert.deepEqual(rows.map((r) => r.row_key).sort(), again);

  const dup = mirror.buildBoardRows({ ...board, candidates: [board.candidates[0], board.candidates[0]] }, picks, DATE);
  assert.equal(dup.length, 1);

  const sharp = { ...board.candidates[0], pMktPower: 0.51, sharpOdds: -110, sharpBook: 'pinnacle', pinnaclePrice: -108, fair_sharp_p: 0.5, note: 'keep-out' };
  const sharpRows = mirror.buildBoardRows({ ...board, candidates: [sharp] }, null, DATE);
  assert.equal(sharpRows[0].p_mkt_power, 0.51);
  assert.equal(sharpRows[0].sharp_prices.sharpOdds, -110);
  assert.equal(sharpRows[0].sharp_prices.pinnaclePrice, -108);
  assert.equal(sharpRows[0].sharp_prices.fair_sharp_p, 0.5);
  assert.equal(sharpRows[0].sharp_prices.note, undefined);
  assert.equal(Object.hasOwn(sharpRows[0].sharp_prices, 'note'), false);

  const card = mirror.buildCardRows(picks, verification, DATE);
  assert.equal(card.cards.length, 1);
  assert.equal(card.cards[0].verification.verifiedAt, verification.verifiedAt);
  assert.equal(card.cards[0].model_version, picks.model);
  assert.equal(card.cards[0].engine, 'omega-v2');
  assert.equal(card.cards[0].total_picks, 1);
  assert.equal(card.cards[0].no_plays, false);
  assert.equal(card.card_picks.length, 1);
  assert.equal(card.card_picks[0].kind, 'straight');
  assert.equal(card.card_picks[0].pick_key, picks.picks[0].pickId);
  assert.equal(card.card_picks[0].odds, -112);
  assert.equal(card.card_picks[0].units, 0.25);
  assert.equal(card.card_picks[0].profit, -37.5);
  assert.equal(card.card_picks[0].filler, false);
  assert.equal(card.parlays.length, 0);
  assert.equal(card.board_rejections.length, 2);
  assert.equal(card.board_rejections[0].row_key.length, 20);
  assert.equal(card.board_rejections[0].odds, -115);
});

test('filler flags, parlay ticket, and flat parlay legs', () => {
  assert.equal(mirror.buildCardRows({ date: DATE, picks: [{ filler: true, pick: 'a', matchup: 'a @ b' }] }, null, DATE).card_picks[0].filler, true);
  assert.equal(mirror.buildCardRows({ date: DATE, picks: [{ isFiller: true, pick: 'a', matchup: 'a @ b' }] }, null, DATE).card_picks[0].filler, true);
  assert.equal(mirror.buildCardRows({ date: DATE, picks: [{ badge: 'Filler', pick: 'a', matchup: 'a @ b' }] }, null, DATE).card_picks[0].filler, true);

  const leg = { ...picks.picks[0], pickId: 'leg1', pick: 'Miami Heat -1.5', side: 'Miami Heat -1.5' };
  const withTicket = {
    ...picks,
    parlayLegs: [{ combinedOdds: '+150', unitsNum: 0.25, stakeUsd: 38, result: 'loss', profit: -38, legs: [leg] }],
    parlayUnits: 0.25,
  };
  const built = mirror.buildCardRows(withTicket, null, DATE);
  assert.equal(built.parlays.length, 1);
  assert.equal(built.parlays[0].combined_odds, 150);
  assert.equal(built.parlays[0].units, 0.25);
  assert.equal(built.parlays[0].stake_usd, 38);
  assert.equal(built.parlays[0].result, 'loss');
  assert.equal(built.card_picks.filter((p) => p.kind === 'parlay').length, 1);
  const boardRows = mirror.buildBoardRows(board, withTicket, DATE);
  assert.equal(boardRows.find((r) => r.side === 'Miami Heat -1.5').is_parlay_leg, true);
  assert.equal(boardRows.find((r) => r.is_pick).is_parlay_leg, false);

  const flat = mirror.buildCardRows({
    date: DATE,
    combinedOdds: '-110',
    parlayUnits: 0.5,
    parlayStake: 75,
    parlayResult: 'win',
    parlayProfit: 68,
    parlayLegs: [
      { pick: 'Over 220', matchup: 'A @ B', sport: 'NBA' },
      { pick: 'Under 6.5', matchup: 'C @ D', sport: 'NHL' },
    ],
  }, null, DATE);
  assert.equal(flat.card_picks.length, 2);
  assert.ok(flat.card_picks.every((p) => p.kind === 'parlay'));
  assert.equal(flat.parlays[0].legs, 2);
  assert.equal(flat.parlays[0].combined_odds, -110);
  assert.equal(flat.parlays[0].result, 'win');
});

test('results, pick clv, and kpi builders', () => {
  const days = mirror.buildResultRows(results, DATE);
  assert.equal(days.length, 1);
  assert.equal(days[0].record, '0-1-0');
  assert.equal(days[0].roi, -100);
  assert.equal(days[0].wins, 0);
  assert.equal(days[0].parlay_result, 'skip');
  assert.equal(days[0].raw.picks, undefined);
  assert.equal(days[0].no_plays, false);

  const clvRows = mirror.buildPickClvRows(clv, DATE);
  assert.equal(clvRows.length, 1);
  assert.equal(clvRows[0].pick_key.length, 16);
  assert.equal(clvRows[0].closing_odds, -108);
  assert.equal(clvRows[0].pick_time_odds, -112);
  assert.equal(clvRows[0].segment, 'fullgame');
  assert.deepEqual(mirror.buildPickClvRows(clv, DATE).map((r) => r.pick_key), clvRows.map((r) => r.pick_key));

  const kpi = mirror.buildKpiRows(DATE, { tracking, clvReport });
  assert.deepEqual(kpi.map((r) => r.kind), ['tracking', 'clv-report']);
  const cum = mirror.cumulativePayload(results);
  assert.equal(cum.days, undefined);
  assert.ok(cum.cumulative);
  const withCum = mirror.buildKpiRows(DATE, { tracking, cumulative: cum });
  assert.equal(withCum.find((r) => r.kind === 'results-cumulative').payload.days, undefined);
});

test('book price rows: slots, raw books, post-commence skip', () => {
  assert.equal(mirror.slotFor('2026-11-13T08:00:00Z'), '0300');
  assert.equal(mirror.slotFor('2026-11-13T15:00:00Z'), '1000');
  assert.equal(mirror.slotFor('2026-11-13T16:00:00Z'), 'other');
  assert.equal(mirror.slotFor('2026-10-20T07:00:00Z'), '0300');
  const raw = {
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Miami Heat', price: -150 }, { name: 'Cleveland Cavaliers', price: 130 }] }] },
      { key: 'hardrockbet', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 220.5 }, { name: 'Under', price: -115, point: 220.5 }] }] },
      { key: 'raw', markets: [{ key: 'h2h', outcomes: [{ name: 'Miami Heat', price: -100 }] }] },
    ],
  };
  const rows = mirror.buildBookPriceRows(DATE, [EV], {
    raw: [
      { event: EV, ts: '2026-11-13T08:00:00Z', body: raw },
      { event: EV, ts: '2026-11-14T02:00:00Z', body: raw },
    ],
    prices: [{
      event: EV,
      key: 'NBA/e1/draftkings/spreads/2026-11-13T15:00:00Z',
      doc: { book: 'draftkings', market: 'spreads', sides: { home: { price: -110, line: -1.5 }, away: { price: -110, line: 1.5 } } },
    }],
  });
  assert.equal(rows.length, 3);
  const pin = rows.find((r) => r.book === 'pinnacle');
  assert.equal(pin.slot, '0300');
  assert.deepEqual(pin.markets.h2h.home, { price: -150 });
  assert.equal(pin.markets.h2h.home.line, undefined);
  const hr = rows.find((r) => r.book === 'hardrockbet');
  assert.equal(hr.markets.totals.over.line, 220.5);
  const dk = rows.find((r) => r.book === 'draftkings');
  assert.equal(dk.slot, '1000');
  assert.equal(dk.snapshot_ts, '2026-11-13T15:00:00Z');
  assert.ok(!rows.some((r) => r.book === 'raw'));
  assert.ok(!rows.some((r) => r.snapshot_ts === '2026-11-14T02:00:00Z'));
});

test('price loader prefers raw blobs and decodes %3A keys', async () => {
  const rawBody = { bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Miami Heat', price: -140 }, { name: 'Cleveland Cavaliers', price: 120 }] }] }] };
  const blobs = memBlobs({
    'odds-master:by-date/2026-11-13': { events: [EV] },
    'odds-master:NBA/e1/raw/2026-11-13T08:00:00Z': rawBody,
    'odds-master:NBA/e1/pinnacle/h2h/2026-11-13T08:00:00Z': { book: 'pinnacle', market: 'h2h', at: '2026-11-13T08:00:00Z', sides: { home: { price: -999 } } },
    'odds-master:NBA/e1/draftkings/spreads/2026-11-13T15%3A00%3A00Z': {
      book: 'draftkings', market: 'spreads', sides: { home: { price: -110, line: -3 }, away: { price: -110, line: 3 } },
    },
  });
  const collected = await mirror.collectPriceInputs(DATE, blobs);
  assert.equal(collected.raw.length, 1);
  assert.equal(collected.prices.length, 1);
  assert.ok(!blobs.gets.includes('odds-master:NBA/e1/pinnacle/h2h/2026-11-13T08:00:00Z'));
  const rows = mirror.buildBookPriceRows(DATE, collected.events, collected);
  assert.ok(rows.some((r) => r.book === 'pinnacle' && r.markets.h2h.home.price === -140));
  const dk = rows.find((r) => r.book === 'draftkings');
  assert.equal(dk.snapshot_ts, '2026-11-13T15:00:00Z');
  assert.equal(dk.slot, '1000');
});

test('parseEspn and fetchScores record failures', async () => {
  const rows = mirror.parseEspn({
    events: [{
      id: 401,
      date: '2026-11-14T01:10:00Z',
      competitions: [{
        neutralSite: true,
        competitors: [
          { homeAway: 'home', score: '133', team: { displayName: 'Miami Heat' } },
          { homeAway: 'away', score: '121', team: { displayName: 'Cleveland Cavaliers' } },
        ],
        status: { type: { name: 'STATUS_FINAL', completed: true } },
      }],
    }],
  }, 'NBA');
  assert.equal(rows[0].event_id, '401');
  assert.equal(rows[0].date, '2026-11-13');
  assert.equal(rows[0].home_score, 133);
  assert.equal(rows[0].away_score, 121);
  assert.equal(rows[0].status, 'STATUS_FINAL');
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].neutral_site, true);

  const calls = [];
  const scored = await mirror.fetchScores(DATE, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/hockey/nhl/')) return { ok: false, status: 503, text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ events: [] }) };
  });
  assert.equal(scored.rows.length, 0);
  assert.ok(scored.errors.some((e) => e.startsWith('NHL:')));
  assert.equal(calls.length, 6);
  assert.ok(calls.some((u) => u.includes('/football/nfl/scoreboard?') && u.includes('dates=20261113') && u.includes('limit=500')));
  assert.ok(calls.some((u) => u.includes('/football/college-football/') && u.includes('groups=80')));
  assert.ok(calls.some((u) => u.includes('/basketball/mens-college-basketball/') && u.includes('groups=50')));
  assert.ok(!calls.some((u) => u.includes('/basketball/nba/') && u.includes('groups=')));
});

test('upsert merges, dedupes, and stamps updated_at only where the table has it', async () => {
  const log = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value' };
  const n = await mirror.upsert('cards', [
    { date: DATE, model_version: 'a' },
    { date: DATE, model_version: 'b' },
  ], env, okFetch(log));
  assert.equal(n, 1);
  const body = JSON.parse(log[0].opts.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].model_version, 'b');
  assert.ok(body[0].updated_at);
  assert.match(log[0].opts.headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(log[0].opts.headers['Content-Profile'], 'clv');
  log.length = 0;
  await mirror.upsert('book_prices', [{ game_id: 'e', book: 'pinnacle', snapshot_ts: '2026-11-13T08:00:00Z', markets: { h2h: {} } }], env, okFetch(log));
  const price = JSON.parse(log[0].opts.body)[0];
  assert.equal(price.updated_at, undefined);
  log.length = 0;
  await mirror.upsert('mirror_runs', [{ date: DATE, job: 'daily', ok: true, summary: {} }], env, okFetch(log));
  const run = JSON.parse(log[0].opts.body)[0];
  assert.equal(run.updated_at, undefined);
  assert.ok(run.ran_at);
  const bad = async () => {
    await mirror.upsert('cards', [{ date: DATE }], env, async () => ({ ok: false, status: 401, text: async () => `nope super-secret-value` }));
  };
  await assert.rejects(bad, (e) => {
    assert.match(e.message, /HTTP 401/);
    assert.ok(!e.message.includes('super-secret-value'));
    return true;
  });
});

test('flag off clv-sync ignores hardrock and matches the two-book rows', async () => {
  const doc = { book: 'pinnacle', market: 'h2h', at: '2026-11-13T15:00:00Z', sides: { home: { price: -150 } } };
  const hr = { book: 'hardrockbet', market: 'h2h', at: '2026-11-13T15:00:00Z', sides: { home: { price: -145 } } };
  const blobs = memBlobs({
    'odds-master:by-date/2026-11-13': { events: [EV] },
    'odds-master:NBA/e1/pinnacle/h2h/2026-11-13T15:00:00Z': doc,
    'odds-master:NBA/e1/hardrockbet/h2h/2026-11-13T15:00:00Z': hr,
  });
  const off = await buildDay(DATE, blobs, { env: { SUPABASE_MIRROR_V2: 'off' } });
  assert.equal(off.snaps.length, 1);
  assert.deepEqual(off.snaps, snapsFromPriceDoc(doc, EV));
  const on = await buildDay(DATE, blobs, { env: { SUPABASE_MIRROR_V2: 'on' } });
  assert.equal(on.snaps.length, 2);
  assert.ok(on.snaps.some((s) => s.book === 'hardrockbet'));
  const def = await buildDay(DATE, blobs, { env: {} });
  assert.equal(def.snaps.length, 2);
});

function dayBlobs(extra = {}) {
  return memBlobs({
    [`edge-picks-omega:picks-${DATE}`]: picks,
    [`edge-picks-omega:verification-${DATE}`]: verification,
    [`edge-picks-omega:omega-v2/morning-board/${DATE}`]: board,
    [`edge-picks-omega:clv-${DATE}`]: clv,
    [`edge-picks-omega:omega-tracking/${DATE}`]: tracking,
    [`edge-picks-omega:omega-clv-report/${DATE}`]: clvReport,
    'edge-picks-omega:results-omega-cache-v9-kpi1030': results,
    'odds-master:by-date/2026-11-13': { events: [EV] },
    'odds-master:NBA/e1/raw/2026-11-13T08:00:00Z': {
      bookmakers: [{ key: 'hardrockbet', markets: [{ key: 'h2h', outcomes: [{ name: 'Miami Heat', price: -130 }, { name: 'Cleveland Cavaliers', price: 110 }] }] }],
    },
    ...extra,
  });
}

test('mirrorDay writes idempotent rows and a backfill-style run can be dry', async () => {
  const log = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k', NETLIFY_AUTH_TOKEN: 't', SUPABASE_MIRROR_V2: 'on' };
  const fetchImpl = async (url, opts = {}) => {
    log.push({ url: String(url), opts });
    if (String(url).includes('site.api.espn.com')) {
      if (String(url).includes('/hockey/nhl/')) return { ok: false, status: 500, text: async () => 'x', json: async () => ({}) };
      return {
        ok: true, status: 200, json: async () => ({
          events: [{ id: '99', date: '2026-11-14T01:10:00Z', competitions: [{ neutralSite: false, status: { type: { name: 'STATUS_FINAL', completed: true } }, competitors: [
            { homeAway: 'home', score: '1', team: { displayName: 'Home' } },
            { homeAway: 'away', score: '0', team: { displayName: 'Away' } },
          ] }] }],
        }),
      };
    }
    return { ok: true, status: 201, text: async () => '', json: async () => ({}), headers: { get: () => null } };
  };
  const live = await mirror.mirrorDay(DATE, { env, fetch: fetchImpl, blobs: dayBlobs(), includeCumulative: true, job: 'daily' });
  assert.equal(live.counts.board_candidates, 6);
  assert.equal(live.counts.card_picks, 1);
  assert.equal(live.counts.cards, 1);
  assert.equal(live.counts.board_rejections, 2);
  assert.equal(live.counts.pick_clv, 1);
  assert.equal(live.counts.daily_results, 1);
  assert.equal(live.counts.book_prices, 1);
  assert.equal(live.counts.scores, 5);
  assert.equal(live.counts.kpi_snapshots, 3);
  assert.equal(live.counts.mirror_runs, 1);
  assert.equal(live.ok, false);
  assert.ok(live.errors.some((e) => e.includes('NHL:')));
  const posts = log.filter((c) => c.opts && c.opts.method === 'POST');
  assert.ok(posts.every((c) => /merge-duplicates|ignore-duplicates/.test(c.opts.headers.Prefer)));
  const kpi = posts.find((c) => c.url.includes('/kpi_snapshots'));
  const kinds = JSON.parse(kpi.opts.body).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['clv-report', 'results-cumulative', 'tracking']);
  const run = JSON.parse(posts.find((c) => c.url.includes('/mirror_runs')).opts.body)[0];
  assert.equal(run.job, 'daily');
  assert.equal(run.ok, false);

  log.length = 0;
  const dry = await mirror.mirrorDay(DATE, { env, fetch: fetchImpl, blobs: dayBlobs(), dry: true, parts: ['card'] });
  assert.equal(dry.counts.cards, 1);
  assert.equal(dry.counts.mirror_runs, undefined);
  assert.equal(log.length, 0);
});

test('mirrorTodayCard skips unchanged cards and reruns when a result changes', async () => {
  const log = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k', NETLIFY_AUTH_TOKEN: 't' };
  const blobs = dayBlobs();
  const first = await mirror.mirrorTodayCard(DATE, { env, fetch: okFetch(log), blobs });
  assert.equal(first.ok, true);
  assert.ok(first.counts.cards >= 1);
  const posts = log.length;
  const second = await mirror.mirrorTodayCard(DATE, { env, fetch: okFetch(log), blobs });
  assert.equal(second.skipped, 'unchanged');
  assert.equal(log.length, posts);
  const changed = JSON.parse(JSON.stringify(picks));
  changed.picks[0].result = 'win';
  blobs.writes.length = 0;
  await blobs.set('edge-picks-omega', `picks-${DATE}`, changed);
  const third = await mirror.mirrorTodayCard(DATE, { env, fetch: okFetch(log), blobs });
  assert.equal(third.skipped, undefined);
  assert.ok(log.length > posts);
});

test('sync mirror failure does not change the existing status', async () => {
  const EV2 = { sport: 'NHL', eventId: 'e1', homeTeam: 'Boston Bruins', awayTeam: 'Toronto Maple Leafs', commenceTime: '2026-10-20T23:00:00Z' };
  const blobs = memBlobs({
    'odds-master:by-date/2026-10-20': { events: [EV2] },
    'odds-master:NHL/e1/pinnacle/totals/2026-10-20T14:00:00Z': { book: 'pinnacle', market: 'totals', at: '2026-10-20T14:00:00Z', sides: { over: { price: -105, line: 6.5 }, under: { price: -115, line: 6.5 } } },
    'odds-master:NHL/e1/hardrockbet/h2h/2026-10-20T14:00:00Z': { book: 'hardrockbet', market: 'h2h', at: '2026-10-20T14:00:00Z', sides: { home: { price: -130 } } },
  });
  const env = { PICKS_SECRET_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 's', NETLIFY_AUTH_TOKEN: 't', SUPABASE_MIRROR_V2: 'on' };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/games') || u.includes('/odds_snapshots')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    throw new Error('mirror down');
  };
  const summary = await bg.run('2026-10-20', { env, blobs, fetchImpl });
  assert.equal(summary.ok, true);
  assert.equal(summary.posted.odds_snapshots, 3);
  assert.equal(summary.mirror.ok, false);
  const res = await bg.handle({ headers: { 'x-picks-secret': 'k' }, queryStringParameters: { date: '2026-10-20' } }, { env, blobs, fetch: fetchImpl });
  assert.equal(res.statusCode, 200);
  const off = await bg.run('2026-10-20', { env: { ...env, SUPABASE_MIRROR_V2: 'off' }, blobs, fetchImpl });
  assert.equal(off.mirror, undefined);
  assert.equal(off.posted.odds_snapshots, 2);
});

test('capture-pick-closes calls the mirror on an empty due list and does not throw when it fails', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/capture-pick-closes.js'), 'utf8');
  assert.match(src, /MIRROR_BUDGET_MS = 8000/);
  assert.match(src, /Promise\.race/);
  const now = new Date('2026-10-20T12:00:00Z');
  const card = {
    generatedAt: '2026-10-20T15:00:00Z',
    picks: [{ sport: 'NHL', matchup: 'A @ B', pick: 'B ML', betType: 'Moneyline', commenceTime: '2026-10-21T23:00:00Z', result: 'pending' }],
  };
  const envOn = { ODDS_API_KEY: 'o', SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value', NETLIFY_AUTH_TOKEN: 't', SUPABASE_MIRROR_V2: 'on' };
  const blobs = memBlobs({ 'edge-picks-omega:picks-2026-10-20': card });
  const r = await cap.handle({}, now, {
    env: envOn,
    blobs,
    fetch: async () => { throw new Error('mirror exploded super-secret-value'); },
  });
  const body = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(body.due, 0);
  assert.equal(body.ok, true);
  assert.equal(body.mirror.ok, false);
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));

  const calls = [];
  const off = await cap.handle({}, now, {
    env: { ...envOn, SUPABASE_MIRROR_V2: 'off' },
    blobs: memBlobs({ 'edge-picks-omega:picks-2026-10-20': card }),
    fetch: async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => [] }; },
  });
  assert.equal(JSON.parse(off.body).mirror, undefined);
  assert.equal(calls.length, 0);
  assert.equal(off.statusCode, 200);
});

test('backfill prints per-date counts and never the service key', async () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value', NETLIFY_AUTH_TOKEN: 'tok-secret' };
  const log = [];
  const lines = await backfill.backfill({
    from: DATE, to: DATE, dry: true, parts: ['card'], env, print: false,
    blobs: dayBlobs(),
    fetch: async (url) => { log.push(String(url)); return { ok: true, status: 201, text: async () => '', json: async () => ({}) }; },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].counts.cards, 1);
  assert.equal(lines[0].counts.mirror_runs, undefined);
  assert.equal(log.length, 0);
  assert.ok(!JSON.stringify(lines).includes('super-secret-value'));

  const posts = [];
  const live = await backfill.backfill({
    from: DATE, to: DATE, parts: ['clv'], env, print: false,
    blobs: dayBlobs(),
    fetch: async (url, opts = {}) => { posts.push({ url: String(url), opts }); return { ok: true, status: 201, text: async () => '', json: async () => ({}) }; },
  });
  assert.equal(live[0].counts.pick_clv, 1);
  const run = posts.find((c) => c.url.includes('/mirror_runs'));
  assert.equal(JSON.parse(run.opts.body)[0].job, 'backfill');

  assert.throws(() => backfill.parseArgs(['node', 'backfill.js', '--from', 'nope', '--to', DATE]), /usage/);
  const cli = spawnSync(process.execPath, ['tools/supa-mirror/backfill.js', '--from', 'nope'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value', NETLIFY_AUTH_TOKEN: 'tok-secret' },
    encoding: 'utf8',
  });
  assert.notEqual(cli.status, 0);
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes('super-secret-value'));
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes('tok-secret'));
});
