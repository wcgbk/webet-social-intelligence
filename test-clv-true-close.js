'use strict';

/**
 * True close from Supabase capture-pick-closes.
 * Fixtures are trimmed copies of the 11/12–11/14 ledgers. The fetch is fake.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { noVigTwoWay, americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { pickClvKey } = require('./netlify/functions/lib/omega-v2/candidate_clv');
const { summarizePickClv } = require('./netlify/functions/lib/clv-summary');
const {
  trueCloseEnabled,
  loadTrueCloses,
  upgradeLedger,
  applyTrueClose,
} = require('./netlify/functions/lib/clv-true-close');
const track = require('./netlify/functions/track-clv-omega');
const upgradeFn = require('./netlify/functions/upgrade-clv-closes');

const FIX = path.join(__dirname, 'tests/fixtures/clv-true-close');
const read = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const CLOSES = read('closes.json');
const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'test-secret', PICKS_SECRET_KEY: 'pick-secret' };

function roundTo(n, places) {
  return Number(n.toFixed(places));
}

function fakeSupabase(urls) {
  return async function fetchImpl(url, opts) {
    const u = String(url);
    urls.push(u);
    assert.ok(!u.includes('api.the-odds-api.com'), u);
    const headers = (opts && opts.headers) || {};
    assert.strictEqual(headers['Accept-Profile'], 'clv');
    assert.strictEqual(headers.apikey, 'test-secret');
    assert.strictEqual(headers.Authorization, 'Bearer test-secret');
    const body = u.includes('/odds_snapshots') ? CLOSES.snapshots : CLOSES.games;
    if (u.includes('/odds_snapshots')) {
      assert.ok(u.includes('line_type'), u);
      assert.ok(u.includes('pinnacle'), u);
      assert.ok(u.includes('closing'), u);
    }
    if (u.includes('/games')) assert.ok(u.includes('commence_time') || u.includes('or='), u);
    return { ok: true, status: 200, json: async () => body };
  };
}

function settlementOf(clv) {
  return (clv.picks || []).map((p) => ({
    result: p.result, profit: p.profit, units: p.units,
  }));
}

function aggOf(clv) {
  return {
    avgCLV: clv.avgCLV,
    avgCLVCents: clv.avgCLVCents,
    picksBeatClosing: clv.picksBeatClosing,
    totalTracked: clv.totalTracked,
    sharpAnchoredCount: clv.sharpAnchoredCount,
    sharpAnchorPct: clv.sharpAnchorPct,
    anchorBreakdown: clv.anchorBreakdown,
    bySport: clv.bySport,
    byMarket: clv.byMarket,
    bySource: clv.bySource,
    byGameType: clv.byGameType,
    byCohort: clv.byCohort,
  };
}

(async () => {
  assert.strictEqual(trueCloseEnabled({}), true);
  assert.strictEqual(trueCloseEnabled({ OMEGA_CLV_TRUE_CLOSE: 'off' }), false);
  assert.strictEqual(trueCloseEnabled({ OMEGA_CLV_TRUE_CLOSE: '0' }), false);
  assert.strictEqual(trueCloseEnabled({ OMEGA_CLV_TRUE_CLOSE: 'false' }), false);

  for (const name of ['clv-2026-11-12.json', 'clv-2026-11-13.json', 'clv-2026-11-14.json']) {
    const clv = read(name);
    assert.deepStrictEqual(aggOf(clv), aggOf({ picks: clv.picks, ...track.summarizeTrackedPicks(clv.picks) }));
  }

  const urls = [];
  const fetchImpl = fakeSupabase(urls);
  const ledger13 = clone(read('clv-2026-11-13.json'));
  const picks13 = clone(read('picks-2026-11-13.json'));
  const picksBefore = JSON.stringify(picks13);
  const loaded13 = await loadTrueCloses('2026-11-13', ledger13.picks, ENV, fetchImpl);
  assert.strictEqual(loaded13.reason, null);
  assert.ok(urls.some((u) => u.includes('/rest/v1/games')));
  assert.ok(urls.some((u) => u.includes('/rest/v1/odds_snapshots')));
  assert.ok(urls.every((u) => !u.includes('api.the-odds-api.com')));
  assert.ok(urls.filter((u) => u.includes('/rest/v1/games')).length <= 2);

  const off = clone(ledger13);
  const offBefore = JSON.stringify(off);
  const offReport = upgradeLedger(off, picks13, {
    ledgerEntries: loaded13.entries,
    ticketEntries: [],
    tickets: [],
  }, { OMEGA_CLV_TRUE_CLOSE: 'off', OMEGA_V2_PICK_CLV: 'on' });
  assert.strictEqual(offReport.skipped, 'flag-off');
  assert.strictEqual(JSON.stringify(off), offBefore);
  let offFetches = 0;
  await applyTrueClose(clone(ledger13), picks13, { OMEGA_CLV_TRUE_CLOSE: '0' }, async () => { offFetches += 1; throw new Error('fetch'); });
  await applyTrueClose(clone(ledger13), picks13, { OMEGA_CLV_TRUE_CLOSE: 'false' }, async () => { offFetches += 1; throw new Error('fetch'); });
  assert.strictEqual(offFetches, 0);

  const cavsCard = clone(picks13);
  cavsCard.parlayLegs = [{
    type: '2-leg',
    units: '0.25u',
    legs: [clone(picks13.picks[0]), {
      sport: 'NBA', matchup: 'Other Away @ Other Home', pick: 'Other Home +3', side: 'Other Home +3',
      market: 'Spread', betType: 'Spread', odds: '-110', line: 3, book: 'draftkings',
      commenceTime: '2026-11-14T01:10:00Z',
    }],
  }];
  const on = clone(ledger13);
  const settledBefore = settlementOf(on);
  const report = await applyTrueClose(on, cavsCard, Object.assign({ OMEGA_V2_PICK_CLV: 'on' }, ENV), fetchImpl);
  assert.strictEqual(report.picksExamined, 1);
  assert.strictEqual(report.upgraded, 1);
  assert.strictEqual(report.stillEarly, 0);
  assert.deepStrictEqual(report.noTrueClose, []);
  assert.strictEqual(report.changed, true);
  assert.deepStrictEqual(settlementOf(on), settledBefore);
  assert.strictEqual(JSON.stringify(picks13), picksBefore);

  const row = on.picks[0];
  const fair = noVigTwoWay(-102, -108);
  const closingNoVig = roundTo(fair.p1, 4);
  const expectedClv = roundTo(closingNoVig - 0.5168, 4);
  assert.strictEqual(row.closingOdds, '-102');
  assert.strictEqual(row.closingLine, 2.5);
  assert.strictEqual(row.closingNoVig, closingNoVig);
  assert.strictEqual(row.closingNoVig, 0.4928);
  assert.strictEqual(row.closingImplied, 0.505);
  assert.strictEqual(row.clv, expectedClv);
  assert.strictEqual(row.clv, -0.024);
  assert.strictEqual(row.clvCents, -2.4);
  assert.strictEqual(row.beatClosing, false);
  assert.strictEqual(row.closeSnapshotAt, '2026-11-14T01:04:53Z');
  assert.strictEqual(row.captureMinsToCommence, 0);
  assert.strictEqual(row.captureScore, 0);
  assert.strictEqual(row.anchor, 'pinnacle');
  assert.strictEqual(row.anchorBook, 'pinnacle');
  assert.strictEqual(row.closeSource, 'supabase:capture-pick-closes');
  assert.strictEqual(row.betDevigMethod, 'power');
  assert.strictEqual(row.pickTimeNoVig, 0.5168);
  assert.strictEqual(row.closingOverround, 1.0242);
  assert.strictEqual(row.clvRaw, -0.0091);
  assert.strictEqual(row.result, 'pending');
  assert.strictEqual(row.profit, 0);
  assert.strictEqual(row.units, '0.25u');
  assert.deepStrictEqual(row.preTrueClose, {
    closingOdds: '-108',
    closingNoVig: 0.5072,
    clv: -0.0096,
    clvCents: -0.96,
    beatClosing: false,
    closeSnapshotAt: '2026-11-13T23:00:58.884Z',
    captureMinsToCommence: 129,
  });
  assert.deepStrictEqual(aggOf(on), aggOf({ picks: on.picks, ...track.summarizeTrackedPicks(on.picks) }));
  assert.strictEqual(on.avgCLV, -0.024);
  assert.strictEqual(on.avgCLVCents, -2.4);
  assert.strictEqual(on.wins, 0);
  assert.strictEqual(on.losses, 0);
  assert.strictEqual(on.totalProfit, 0);
  assert.strictEqual(on.pending, 1);

  assert.strictEqual(on.pickClv.length, 2);
  const straight = on.pickClv.find((r) => r.kind === 'straight');
  const leg = on.pickClv.find((r) => r.kind === 'leg');
  const betImplied = roundTo(americanToImplied(-112), 6);
  const closeNoVig = roundTo(fair.p1, 6);
  const clvPp = roundTo((closeNoVig - betImplied) * 100, 2);
  assert.strictEqual(straight.rowKey, pickClvKey(cavsCard.picks[0], 'straight', 0));
  assert.strictEqual(straight.betPrice, -112);
  assert.strictEqual(straight.betImplied, betImplied);
  assert.strictEqual(straight.closeNoVig, closeNoVig);
  assert.strictEqual(straight.clvPp, clvPp);
  assert.strictEqual(straight.clvPp, -3.55);
  assert.strictEqual(straight.beatClose, false);
  assert.strictEqual(straight.sharpBook, 'pinnacle');
  assert.strictEqual(straight.sharpDevig, 'power');
  assert.strictEqual(straight.market, 'spread');
  assert.strictEqual(straight.line, 2.5);
  assert.strictEqual(straight.closeSource, 'supabase:capture-pick-closes');
  assert.strictEqual(leg.rowKey, pickClvKey(cavsCard.parlayLegs[0].legs[0], 'leg', 0));
  assert.strictEqual(leg.clvPp, clvPp);
  assert.ok(!on.pickClv.some((r) => r.line === 3));
  assert.deepStrictEqual(on.pickClvSummary, summarizePickClv(on.pickClv));
  assert.strictEqual(on.pickClvSummary.n, 2);
  assert.strictEqual(on.pickClvSummary.meanClvPp, -3.55);
  assert.strictEqual(on.pickClvSummary.beatClosePct, 0);

  const againBefore = JSON.stringify(on);
  const again = await applyTrueClose(on, cavsCard, Object.assign({ OMEGA_V2_PICK_CLV: 'on' }, ENV), fetchImpl);
  assert.strictEqual(again.upgraded, 0);
  assert.strictEqual(again.changed, false);
  assert.strictEqual(JSON.stringify(on), againBefore);
  assert.strictEqual(on.picks[0].preTrueClose.closingOdds, '-108');

  const noPickClv = clone(ledger13);
  const noPickReport = await applyTrueClose(noPickClv, picks13, Object.assign({ OMEGA_V2_PICK_CLV: 'off' }, ENV), fetchImpl);
  assert.strictEqual(noPickReport.upgraded, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(noPickClv, 'pickClv'), false);
  assert.strictEqual(noPickClv.picks[0].closingOdds, '-102');

  for (const name of ['clv-2026-11-12.json', 'clv-2026-11-14.json']) {
    const clv = clone(read(name));
    const picksName = name === 'clv-2026-11-12.json' ? 'picks-2026-11-12.json' : null;
    const picks = picksName ? clone(read(picksName)) : { picks: [], parlayLegs: [] };
    if (!picksName) {
      picks.picks = clv.picks.map((p) => ({
        pick: p.pick, side: p.pick, matchup: p.matchup, sport: p.sport, market: p.market,
        betType: p.betType, odds: p.pickTimeOdds, line: p.betLine, book: 'draftkings',
        commenceTime: p.commenceTime,
      }));
    }
    const before = JSON.stringify(clv);
    const day = await applyTrueClose(clv, picks, Object.assign({ OMEGA_V2_PICK_CLV: 'on' }, ENV), fetchImpl);
    assert.strictEqual(day.upgraded, 0, name);
    assert.strictEqual(JSON.stringify(clv), before, name);
    assert.ok(day.noTrueClose.every((miss) => miss.reason === 'closing line differs from bet line'), JSON.stringify(day.noTrueClose));
  }
  const usa = read('clv-2026-11-14.json').picks[0];
  assert.strictEqual(usa.betLine, -3.5);
  assert.strictEqual(usa.pick, 'South Alabama Jaguars -3.5');
  const day14 = await applyTrueClose(clone(read('clv-2026-11-14.json')), { picks: [], parlayLegs: [] }, ENV, fetchImpl);
  assert.strictEqual(day14.stillEarly, 1);
  assert.strictEqual(day14.noTrueClose[0].pick, 'South Alabama Jaguars -3.5');
  assert.strictEqual(day14.picksExamined, 3);

  const held = clone(ledger13);
  held.picks[0].captureMinsToCommence = 0;
  held.picks[0].closeSnapshotAt = held.picks[0].commenceTime;
  held.picks[0].captureScore = 0;
  const heldOdds = held.picks[0].closingOdds;
  const heldReport = await applyTrueClose(held, picks13, Object.assign({ OMEGA_V2_PICK_CLV: 'on' }, ENV), fetchImpl);
  assert.strictEqual(heldReport.upgraded, 0);
  assert.strictEqual(held.picks[0].closingOdds, heldOdds);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(held.picks[0], 'preTrueClose'), false);
  assert.strictEqual(held.pickClv.length, 1);
  assert.strictEqual(held.pickClv[0].closeSource, 'supabase:capture-pick-closes');

  const empty = await loadTrueCloses('2026-11-13', ledger13.picks, {}, fetchImpl);
  assert.ok(empty.entries.every((e) => !e.close));
  assert.ok(/SUPABASE_SERVICE_ROLE_KEY/.test(empty.reason));

  const totalLedger = {
    date: '2026-11-13',
    picks: [{
      pick: 'Over 45.5', matchup: 'Away @ Home', sport: 'NBA', betType: 'Total', market: 'Total',
      betLine: 45.5, pickTimeOdds: '-110', pickTimeNoVig: 0.48, commenceTime: '2026-11-14T01:10:00Z',
      closingOdds: '-105', closingLine: 46, closingNoVig: 0.49, clv: 0.01, clvCents: 1,
      beatClosing: true, closeSnapshotAt: '2026-11-13T23:00:00Z', captureMinsToCommence: 130,
      captureScore: 130, anchor: 'pinnacle', anchorBook: 'Pinnacle', betDevigMethod: 'power',
      result: 'win', profit: 10, units: '0.5u', segment: 'fullgame', source: 'full-game',
    }],
    avgCLV: 0.01, wins: 1, losses: 0, pushes: 0, totalProfit: 10, settled: 1, pending: 0,
  };
  const totalFetch = async (url) => {
    const u = String(url);
    assert.ok(!u.includes('api.the-odds-api.com'));
    if (u.includes('/odds_snapshots')) {
      return { ok: true, status: 200, json: async () => [
        { game_id: 'g-tot', book: 'pinnacle', market: 'totals', side: 'Over', point: 46.5, price: -110, line_type: 'closing', snapshot_ts: '2026-11-14T01:05:00Z' },
        { game_id: 'g-tot', book: 'pinnacle', market: 'totals', side: 'Under', point: 46.5, price: -110, line_type: 'closing', snapshot_ts: '2026-11-14T01:05:00Z' },
        { game_id: 'g-tot', book: 'pinnacle', market: 'totals', side: 'Over', point: 45.5, price: -108, line_type: 'closing', snapshot_ts: '2026-11-14T01:05:00Z' },
      ] };
    }
    return { ok: true, status: 200, json: async () => [
      { game_id: 'g-tot', sport: 'NBA', commence_time: '2026-11-14T01:10:00Z', home_team: 'Home', away_team: 'Away' },
    ] };
  };
  const totalClv = clone(totalLedger);
  const totalReport = await applyTrueClose(totalClv, { picks: [], parlayLegs: [] }, ENV, totalFetch);
  assert.strictEqual(totalReport.upgraded, 0);
  assert.strictEqual(totalReport.noTrueClose[0].reason, 'missing the other side at the bet line');
  assert.strictEqual(totalClv.picks[0].result, 'win');
  assert.strictEqual(totalClv.picks[0].profit, 10);
  assert.strictEqual(totalClv.picks[0].closingOdds, '-105');

  function memoryStore(seed) {
    const data = {};
    for (const [k, v] of Object.entries(seed)) data[k] = clone(v);
    const writes = [];
    return {
      writes,
      data,
      async get(key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? clone(data[key]) : null;
      },
      async setJSON(key, value) {
        writes.push({ key, value: clone(value) });
        data[key] = clone(value);
      },
    };
  }

  function settledCard(card) {
    const next = clone(card);
    for (const p of next.picks || []) {
      if (!p.result || p.result === 'pending') p.result = 'win';
    }
    for (const t of next.parlayLegs || []) {
      for (const leg of t.legs || []) {
        if (leg && (!leg.result || leg.result === 'pending')) leg.result = 'win';
      }
    }
    return next;
  }

  const morningUrls = [];
  const morningFetch = fakeSupabase(morningUrls);
  const store = memoryStore({
    'clv-2026-11-13': read('clv-2026-11-13.json'),
    'picks-2026-11-13': settledCard(read('picks-2026-11-13.json')),
    'clv-2026-11-12': read('clv-2026-11-12.json'),
    'picks-2026-11-12': settledCard(read('picks-2026-11-12.json')),
  });
  const morning = await track.handle({
    httpMethod: 'POST',
    queryStringParameters: {},
  }, {
    now: '2026-11-14T15:00:00Z',
    env: Object.assign({}, ENV),
    fetch: morningFetch,
    store,
  });
  const morningBody = JSON.parse(morning.body);
  assert.strictEqual(morning.statusCode, 200);
  assert.ok(/No picks/.test(morningBody.message));
  assert.ok(morningUrls.length > 0);
  assert.ok(morningUrls.every((u) => !u.includes('api.the-odds-api.com')));
  assert.ok(!morningUrls.some((u) => u.includes('/track-clv')));
  assert.ok(morningUrls.some((u) => u.includes('/rest/v1/')));
  const wrote13 = store.writes.filter((w) => w.key === 'clv-2026-11-13');
  assert.strictEqual(wrote13.length, 1);
  assert.strictEqual(wrote13[0].value.picks[0].captureMinsToCommence, 0);
  assert.strictEqual(wrote13[0].value.picks[0].result, 'pending');
  assert.strictEqual(wrote13[0].value.picks[0].profit, 0);
  assert.ok(!store.writes.some((w) => w.key === 'clv-2026-11-12'));
  assert.ok(!store.writes.some((w) => String(w.key).startsWith('picks-')));

  const offUrls = [];
  const offMorning = await track.handle({
    httpMethod: 'GET',
    queryStringParameters: {},
  }, {
    now: '2026-11-14T15:00:00Z',
    env: { OMEGA_CLV_TRUE_CLOSE: 'off', OMEGA_CLOSES_AT_3AM: 'off', URL: 'https://example.test' },
    fetch: async (url) => {
      offUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) };
    },
    store: memoryStore({}),
  });
  assert.strictEqual(offMorning.statusCode, 200);
  assert.ok(offUrls.some((u) => u.includes('https://example.test/.netlify/functions/track-clv?date=2026-11-13')));
  assert.ok(offUrls.every((u) => !u.includes('api.the-odds-api.com')));
  assert.ok(!offUrls.some((u) => u.includes('/rest/v1/')));

  const endpointStore = memoryStore({
    'clv-2026-11-13': read('clv-2026-11-13.json'),
    'picks-2026-11-13': read('picks-2026-11-13.json'),
  });
  const unauth = await upgradeFn.handle({ httpMethod: 'GET', queryStringParameters: { date: '2026-11-13' } }, {
    env: ENV, fetch: morningFetch, store: endpointStore,
  });
  assert.strictEqual(unauth.statusCode, 401);
  const wrong = await upgradeFn.handle({ httpMethod: 'POST', queryStringParameters: { key: 'nope', date: '2026-11-13' } }, {
    env: ENV, fetch: morningFetch, store: endpointStore,
  });
  assert.strictEqual(wrong.statusCode, 401);
  assert.strictEqual(endpointStore.writes.length, 0);
  assert.strictEqual(endpointStore.data['clv-2026-11-13'].avgCLV, -0.0096);

  const dry = await upgradeFn.handle({
    httpMethod: 'GET',
    queryStringParameters: { key: 'pick-secret', date: '2026-11-13', dry: '1' },
  }, { env: ENV, fetch: morningFetch, store: endpointStore });
  const dryBody = JSON.parse(dry.body);
  assert.strictEqual(dry.statusCode, 200);
  assert.strictEqual(dryBody.dry, true);
  assert.strictEqual(dryBody.wrote, false);
  assert.strictEqual(dryBody.upgraded, 1);
  assert.strictEqual(dryBody.before.avgCLV, -0.0096);
  assert.strictEqual(dryBody.after.avgCLV, -0.024);
  assert.strictEqual(dryBody.after.pickClvSummary.n, 1);
  assert.strictEqual(endpointStore.writes.length, 0);
  assert.strictEqual(endpointStore.data['clv-2026-11-13'].avgCLV, -0.0096);
  assert.strictEqual(endpointStore.data['clv-2026-11-13'].picks[0].captureMinsToCommence, 129);

  const live = await upgradeFn.handle({
    httpMethod: 'POST',
    queryStringParameters: { key: 'pick-secret', date: '2026-11-13' },
  }, { env: ENV, fetch: morningFetch, store: endpointStore });
  const liveBody = JSON.parse(live.body);
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(liveBody.wrote, true);
  assert.strictEqual(endpointStore.writes.length, 1);
  assert.strictEqual(endpointStore.data['clv-2026-11-13'].picks[0].closingOdds, '-102');
  assert.strictEqual(endpointStore.data['clv-2026-11-13'].picks[0].result, 'pending');

  const srcTrue = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/clv-true-close.js'), 'utf8');
  const srcUp = fs.readFileSync(path.join(__dirname, 'netlify/functions/upgrade-clv-closes.js'), 'utf8');
  assert.ok(!srcTrue.includes('the-odds-api.com'));
  assert.ok(!srcTrue.includes('ODDS_API'));
  assert.ok(!srcUp.includes('the-odds-api.com'));
  assert.ok(!srcUp.includes('ODDS_API'));
  assert.ok(!srcUp.includes('fetchBulk'));

  console.log('PASS test-clv-true-close');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
