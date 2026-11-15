'use strict';

/**
 * Bet-price pickClv fill from closes capture-pick-closes already stored.
 * The ledger has the true closes and no pickClv rows. The card is empty, so
 * the older ticket merge never sees them. No Odds API calls.
 */

const assert = require('assert');
const { noVigTwoWay, americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { pickClvKey } = require('./netlify/functions/lib/omega-v2/candidate_clv');
const { pickClvFillEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const { summarizePickClv } = require('./netlify/functions/lib/clv-summary');
const {
  PICK_CLV_FILL_FROM,
  fillPublishedPickClv,
  upgradeDatesFromStore,
} = require('./netlify/functions/lib/clv-true-close');
const track = require('./netlify/functions/track-clv-omega');
const upgradeFn = require('./netlify/functions/upgrade-clv-closes');

const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'test-secret', PICKS_SECRET_KEY: 'pick-secret' };

function roundTo(n, places) {
  return Number(n.toFixed(places));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function clvPp(closeAmerican, oppAmerican, betAmerican) {
  const fair = noVigTwoWay(closeAmerican, oppAmerican);
  const closeNoVig = roundTo(fair.p1, 6);
  const betImplied = roundTo(americanToImplied(betAmerican), 6);
  return {
    closeNoVig,
    betImplied,
    clvPp: roundTo((closeNoVig - betImplied) * 100, 2),
  };
}

const EXISTING = {
  rowKey: 'straight|NBA|old away @ old home|ml|old home|',
  kind: 'straight',
  sport: 'NBA',
  matchup: 'Old Away @ Old Home',
  side: 'Old Home',
  market: 'ml',
  line: null,
  betPrice: -110,
  betImplied: 0.52381,
  closeNoVig: 0.53881,
  sharpBook: 'pinnacle',
  sharpDevig: 'power',
  clvPp: 1.5,
  beatClose: true,
  closeSource: 'supabase:capture-pick-closes',
};

function gapLedger(date) {
  return {
    date,
    avgCLV: 0.01,
    picks: [
      {
        pick: 'Boise State Broncos -3.5',
        matchup: 'Nevada Wolf Pack @ Boise State Broncos',
        sport: 'NCAAF',
        betType: 'Spread',
        market: 'Spread',
        pickTimeOdds: '+110',
        betLine: -3.5,
        homeTeam: 'Boise State Broncos',
        awayTeam: 'Nevada Wolf Pack',
        commenceTime: '2026-11-16T00:00:00Z',
        closingOdds: '-106',
        closingLine: -3,
        anchor: 'pinnacle',
        anchorBook: 'Pinnacle',
        closingNoVig: 0.42,
        clv: -0.04,
        clvCents: -4,
        beatClosing: false,
        closeSnapshotAt: '2026-11-16T00:00:00Z',
        captureMinsToCommence: 0,
        captureScore: 0,
        result: 'win',
        profit: 110,
        units: '1u',
      },
      {
        pick: 'Old Dominion Monarchs -7',
        matchup: 'Troy Trojans @ Old Dominion Monarchs',
        sport: 'NCAAF',
        betType: 'Spread',
        market: 'Spread',
        pickTimeOdds: '-110',
        betLine: -7,
        homeTeam: 'Old Dominion Monarchs',
        awayTeam: 'Troy Trojans',
        commenceTime: '2026-11-15T22:00:00Z',
        closingOdds: '-105',
        closingLine: -6.5,
        anchor: 'pinnacle',
        anchorBook: 'Pinnacle',
        closingNoVig: 0.5,
        clv: 0.02,
        clvCents: 2,
        beatClosing: true,
        closeSnapshotAt: '2026-11-15T21:01:00Z',
        captureMinsToCommence: 59,
        captureScore: 59,
        result: 'loss',
        profit: -100,
        units: '1u',
      },
      {
        pick: 'Virginia Cavaliers',
        matchup: 'California Golden Bears @ Virginia Cavaliers',
        sport: 'NCAAF',
        betType: 'Moneyline',
        market: 'Moneyline',
        pickTimeOdds: '-450',
        betLine: null,
        homeTeam: 'Virginia Cavaliers',
        awayTeam: 'California Golden Bears',
        commenceTime: '2026-11-15T18:00:00Z',
        closingOdds: '-469',
        closingLine: null,
        anchor: 'pinnacle',
        anchorBook: 'Pinnacle',
        closingNoVig: 0.8137,
        clv: 0.0063,
        clvCents: 0.63,
        beatClosing: true,
        closeSnapshotAt: '2026-11-15T18:00:00Z',
        captureMinsToCommence: 0,
        captureScore: 0,
        result: 'win',
        profit: 20,
        units: '0.25u',
      },
    ],
    parlayLegs: [{
      pick: 'Duke Blue Devils',
      matchup: 'Duke Blue Devils @ North Carolina Tar Heels',
      sport: 'NCAAB',
      betType: 'Moneyline',
      market: 'Moneyline',
      odds: '-140',
      homeTeam: 'North Carolina Tar Heels',
      awayTeam: 'Duke Blue Devils',
      commenceTime: '2026-11-15T20:00:00Z',
      result: 'win',
      isParlayLeg: true,
    }],
    pickClv: [EXISTING],
    pickClvSummary: summarizePickClv([EXISTING]),
  };
}

const GAMES = [
  {
    game_id: 'g-boise',
    sport: 'NCAAF',
    commence_time: '2026-11-16T00:00:00Z',
    home_team: 'Boise State Broncos',
    away_team: 'Nevada Wolf Pack',
  },
  {
    game_id: 'g-duke',
    sport: 'NCAAB',
    commence_time: '2026-11-15T20:00:00Z',
    home_team: 'North Carolina Tar Heels',
    away_team: 'Duke Blue Devils',
  },
  {
    game_id: 'g-odu',
    sport: 'NCAAF',
    commence_time: '2026-11-15T22:00:00Z',
    home_team: 'Old Dominion Monarchs',
    away_team: 'Troy Trojans',
  },
];

function snap(row) {
  return Object.assign({
    book: 'pinnacle',
    line_type: 'closing',
    source: 'oddsapi-live:capture-pick-closes',
  }, row);
}

const SNAPSHOTS = [
  snap({ game_id: 'g-boise', sport: 'NCAAF', market: 'spreads', side: 'Boise State Broncos', point: -3.5, price: -110, snapshot_ts: '2026-11-15T23:55:00Z' }),
  snap({ game_id: 'g-boise', sport: 'NCAAF', market: 'spreads', side: 'Nevada Wolf Pack', point: 3.5, price: -110, snapshot_ts: '2026-11-15T23:55:00Z' }),
  snap({ game_id: 'g-duke', sport: 'NCAAB', market: 'h2h', side: 'Duke Blue Devils', point: null, price: -150, snapshot_ts: '2026-11-15T19:55:00Z' }),
  snap({ game_id: 'g-duke', sport: 'NCAAB', market: 'h2h', side: 'North Carolina Tar Heels', point: null, price: 130, snapshot_ts: '2026-11-15T19:55:00Z' }),
  snap({ game_id: 'g-odu', sport: 'NCAAF', market: 'spreads', side: 'Old Dominion Monarchs', point: -6.5, price: -105, snapshot_ts: '2026-11-15T21:55:00Z' }),
  snap({ game_id: 'g-odu', sport: 'NCAAF', market: 'spreads', side: 'Troy Trojans', point: 6.5, price: -115, snapshot_ts: '2026-11-15T21:55:00Z' }),
];

function fakeSupabase(urls) {
  return async function fetchImpl(url, opts) {
    const u = String(url);
    if (urls) urls.push(u);
    assert.ok(!u.includes('api.the-odds-api.com'), u);
    const headers = (opts && opts.headers) || {};
    assert.strictEqual(headers['Accept-Profile'], 'clv');
    assert.strictEqual(headers.apikey, 'test-secret');
    const body = u.includes('/odds_snapshots') ? SNAPSHOTS : GAMES;
    return { ok: true, status: 200, json: async () => body };
  };
}

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
      writes.push(key);
      data[key] = clone(value);
    },
  };
}

function rowBy(rows, matchup) {
  return (rows || []).find((row) => row && row.matchup === matchup);
}

(async () => {
  assert.strictEqual(PICK_CLV_FILL_FROM, '2026-11-14');
  assert.strictEqual(pickClvFillEnabled({}), true);
  assert.strictEqual(pickClvFillEnabled({ OMEGA_V2_PICK_CLV_FILL: 'off' }), false);
  assert.strictEqual(pickClvFillEnabled({ OMEGA_V2_PICK_CLV_FILL: '0' }), false);
  assert.strictEqual(pickClvFillEnabled({ OMEGA_V2_PICK_CLV_FILL: 'false' }), false);

  const beforeN = gapLedger('2026-11-15').pickClvSummary.n;
  assert.strictEqual(beforeN, 1);

  const offDoc = gapLedger('2026-11-15');
  const offJson = JSON.stringify(offDoc);
  let offCalls = 0;
  const offReport = await fillPublishedPickClv(offDoc, { picks: [], parlayLegs: [] }, {
    OMEGA_V2_PICK_CLV_FILL: 'off',
    SUPABASE_SERVICE_ROLE_KEY: 'test-secret',
  }, async () => { offCalls += 1; throw new Error('fetch'); }, '2026-11-15');
  assert.strictEqual(offReport.skipped, 'flag-off');
  assert.strictEqual(offReport.changed, false);
  assert.strictEqual(offCalls, 0);
  assert.strictEqual(JSON.stringify(offDoc), offJson);

  const early = gapLedger('2026-11-13');
  const earlyJson = JSON.stringify(early);
  let earlyCalls = 0;
  const earlyReport = await fillPublishedPickClv(early, null, ENV, async () => { earlyCalls += 1; throw new Error('fetch'); }, '2026-11-13');
  assert.strictEqual(earlyReport.skipped, 'before-fill-start');
  assert.strictEqual(earlyCalls, 0);
  assert.strictEqual(JSON.stringify(early), earlyJson);

  const urls = [];
  const doc = gapLedger('2026-11-15');
  const picksBefore = JSON.stringify(doc.picks);
  const legsBefore = JSON.stringify(doc.parlayLegs);
  const report = await fillPublishedPickClv(doc, { picks: [], parlayLegs: [] }, ENV, fakeSupabase(urls), '2026-11-15');
  assert.strictEqual(report.changed, true);
  assert.ok(report.filled >= 3);
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => !u.includes('api.the-odds-api.com')));
  assert.strictEqual(JSON.stringify(doc.picks), picksBefore);
  assert.strictEqual(JSON.stringify(doc.parlayLegs), legsBefore);
  assert.ok(doc.pickClvSummary.n > beforeN);
  assert.strictEqual(doc.pickClvSummary.n, 4);
  assert.deepStrictEqual(doc.pickClvSummary, summarizePickClv(doc.pickClv));

  const boise = rowBy(doc.pickClv, 'Nevada Wolf Pack @ Boise State Broncos');
  const duke = rowBy(doc.pickClv, 'Duke Blue Devils @ North Carolina Tar Heels');
  const virginia = rowBy(doc.pickClv, 'California Golden Bears @ Virginia Cavaliers');
  const boiseMath = clvPp(-110, -110, 110);
  const dukeMath = clvPp(-150, 130, -140);
  assert.ok(boise && duke && virginia);
  assert.strictEqual(boise.kind, 'straight');
  assert.strictEqual(boise.betPrice, 110);
  assert.strictEqual(boise.line, -3.5);
  assert.strictEqual(boise.closeNoVig, boiseMath.closeNoVig);
  assert.strictEqual(boise.clvPp, boiseMath.clvPp);
  assert.strictEqual(boise.clvPp, 2.38);
  assert.notStrictEqual(boise.closeNoVig, 0.42);
  assert.strictEqual(boise.closeSource, 'supabase:capture-pick-closes');
  assert.strictEqual(boise.rowKey, pickClvKey({
    sport: 'NCAAF', matchup: boise.matchup, side: 'Boise State Broncos -3.5', market: 'Spread', line: -3.5,
  }, 'straight', 0));
  assert.strictEqual(duke.kind, 'leg');
  assert.strictEqual(duke.betPrice, -140);
  assert.strictEqual(duke.closeNoVig, dukeMath.closeNoVig);
  assert.strictEqual(duke.clvPp, dukeMath.clvPp);
  assert.strictEqual(duke.closeSource, 'supabase:capture-pick-closes');
  assert.strictEqual(virginia.kind, 'straight');
  assert.strictEqual(virginia.betPrice, -450);
  assert.strictEqual(virginia.closeSource, 'ledger:true-close');
  assert.strictEqual(virginia.closeNoVig, 0.8137);
  const virginiaImplied = roundTo(americanToImplied(-450), 6);
  assert.strictEqual(virginia.clvPp, roundTo((0.8137 - virginiaImplied) * 100, 2));
  assert.ok(!doc.pickClv.some((row) => /Old Dominion/.test(String(row.side || row.matchup || ''))));
  assert.ok(doc.pickClv.some((row) => row.rowKey === EXISTING.rowKey && row.clvPp === 1.5));

  const filled = JSON.stringify(doc);
  const again = await fillPublishedPickClv(doc, { picks: [], parlayLegs: [] }, ENV, fakeSupabase([]), '2026-11-15');
  assert.strictEqual(again.changed, false);
  assert.strictEqual(JSON.stringify(doc), filled);

  const store = memoryStore({
    'clv-2026-11-15': gapLedger('2026-11-15'),
    'picks-2026-11-15': { picks: [], parlayLegs: [] },
  });
  const first = await upgradeDatesFromStore(['2026-11-15'], {
    env: ENV,
    fetchImpl: fakeSupabase([]),
    readClv: (d) => store.get(`clv-${d}`),
    readPicks: (d) => store.get(`picks-${d}`),
    writeClv: (d, data) => store.setJSON(`clv-${d}`, data),
  });
  assert.strictEqual(first[0].wrote, true);
  assert.strictEqual(store.data['clv-2026-11-15'].pickClvSummary.n, 4);
  assert.strictEqual(store.data['clv-2026-11-15'].picks[1].closingLine, -6.5);
  const second = await upgradeDatesFromStore(['2026-11-15'], {
    env: ENV,
    fetchImpl: fakeSupabase([]),
    readClv: (d) => store.get(`clv-${d}`),
    readPicks: (d) => store.get(`picks-${d}`),
    writeClv: (d, data) => store.setJSON(`clv-${d}`, data),
  });
  assert.strictEqual(second[0].wrote, false);
  assert.strictEqual(store.writes.length, 1);

  const held = memoryStore({
    'clv-2026-11-15': gapLedger('2026-11-15'),
    'picks-2026-11-15': { picks: [], parlayLegs: [] },
  });
  const heldJson = JSON.stringify(held.data['clv-2026-11-15']);
  await upgradeDatesFromStore(['2026-11-15'], {
    env: Object.assign({ OMEGA_V2_PICK_CLV_FILL: 'off' }, ENV),
    fetchImpl: fakeSupabase([]),
    readClv: (d) => held.get(`clv-${d}`),
    readPicks: (d) => held.get(`picks-${d}`),
    writeClv: (d, data) => held.setJSON(`clv-${d}`, data),
  });
  assert.strictEqual(held.writes.length, 0);
  assert.strictEqual(JSON.stringify(held.data['clv-2026-11-15']), heldJson);

  const afternoonUrls = [];
  const afternoon = memoryStore({
    'clv-2026-11-14': gapLedger('2026-11-14'),
    'picks-2026-11-14': { picks: [], parlayLegs: [] },
  });
  const afternoonRes = await track.handle({
    httpMethod: 'POST',
    queryStringParameters: {},
  }, {
    now: '2026-11-15T18:00:00Z',
    env: ENV,
    fetch: fakeSupabase(afternoonUrls),
    store: afternoon,
  });
  const afternoonBody = JSON.parse(afternoonRes.body);
  assert.strictEqual(afternoonRes.statusCode, 200);
  assert.ok(/No picks/.test(afternoonBody.message));
  assert.ok(afternoon.writes.includes('clv-2026-11-14'));
  assert.strictEqual(afternoon.data['clv-2026-11-14'].pickClvSummary.n, 4);
  assert.ok(afternoonUrls.every((u) => !u.includes('api.the-odds-api.com')));
  assert.ok(!afternoonUrls.some((u) => u.includes('/track-clv')));

  const quietUrls = [];
  const quiet = memoryStore({
    'clv-2026-11-14': gapLedger('2026-11-14'),
  });
  await track.handle({
    httpMethod: 'GET',
    queryStringParameters: {},
  }, {
    now: '2026-11-15T18:00:00Z',
    env: Object.assign({ OMEGA_V2_PICK_CLV_FILL: 'off' }, ENV),
    fetch: async (url) => {
      quietUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) };
    },
    store: quiet,
  });
  assert.strictEqual(quiet.writes.length, 0);
  assert.ok(quietUrls.every((u) => !u.includes('/rest/v1/')));
  assert.ok(quietUrls.every((u) => !u.includes('api.the-odds-api.com')));

  const endpoint = memoryStore({
    'clv-2026-11-14': gapLedger('2026-11-14'),
    'picks-2026-11-14': { picks: [], parlayLegs: [] },
    'clv-2026-11-15': gapLedger('2026-11-15'),
    'picks-2026-11-15': { picks: [], parlayLegs: [] },
  });
  const unauth = await upgradeFn.handle({
    httpMethod: 'GET',
    queryStringParameters: { from: '2026-11-14', to: '2026-11-15', dry: '1' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  assert.strictEqual(unauth.statusCode, 401);
  const bad = await upgradeFn.handle({
    httpMethod: 'GET',
    queryStringParameters: { key: 'pick-secret', from: '2026-11-15', to: '2026-11-14' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  assert.strictEqual(bad.statusCode, 400);
  const missingTo = await upgradeFn.handle({
    httpMethod: 'POST',
    queryStringParameters: { key: 'pick-secret', from: '2026-11-14' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  assert.strictEqual(missingTo.statusCode, 400);
  assert.strictEqual(endpoint.writes.length, 0);

  const dry = await upgradeFn.handle({
    httpMethod: 'GET',
    queryStringParameters: { key: 'pick-secret', from: '2026-11-14', to: '2026-11-15', dry: '1' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  const dryBody = JSON.parse(dry.body);
  assert.strictEqual(dry.statusCode, 200);
  assert.strictEqual(dryBody.dry, true);
  assert.strictEqual(dryBody.wrote, 0);
  assert.strictEqual(dryBody.days.length, 2);
  assert.ok(dryBody.days.every((day) => day.wrote === false && day.after.pickClvSummary.n === 4));
  assert.strictEqual(endpoint.writes.length, 0);
  assert.strictEqual(endpoint.data['clv-2026-11-14'].pickClv.length, 1);

  const live = await upgradeFn.handle({
    httpMethod: 'POST',
    queryStringParameters: { key: 'pick-secret', from: '2026-11-14', to: '2026-11-15' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  const liveBody = JSON.parse(live.body);
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(liveBody.dry, false);
  assert.strictEqual(liveBody.wrote, 2);
  assert.strictEqual(endpoint.data['clv-2026-11-14'].pickClvSummary.n, 4);
  assert.strictEqual(endpoint.data['clv-2026-11-15'].pickClvSummary.n, 4);
  assert.ok(endpoint.data['clv-2026-11-15'].pickClv.some((row) => row.closeSource === 'ledger:true-close'));

  const replay = await upgradeFn.handle({
    httpMethod: 'POST',
    queryStringParameters: { key: 'pick-secret', from: '2026-11-14', to: '2026-11-15' },
  }, { env: ENV, fetch: fakeSupabase([]), store: endpoint });
  const replayBody = JSON.parse(replay.body);
  assert.strictEqual(replayBody.wrote, 0);
  assert.ok(replayBody.days.every((day) => day.wrote === false));

  console.log('PASS test-pick-clv-fill');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
