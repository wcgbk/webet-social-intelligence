#!/usr/bin/env node
'use strict';
// Saved Pinnacle closes fill CLV when the live feed has dropped the game.
// OMEGA_CLV_SAVED_ATTACH=off keeps the null feed-miss. Backfill does not
// overwrite a close that is already stored.
const assert = require('assert');
const track = require('./netlify/functions/track-clv-omega');
const { resolveSavedClose, parseBackfillRequest } = require('./netlify/functions/lib/clv-saved-attach');
const { gradePowerClv } = require('./netlify/functions/lib/omega-vnext/clv_grade');

const TIP = '2026-11-18T00:30:00Z';
const NOW = '2026-11-24T16:00:00Z';
const SOURCE = 'odds-master-board:capture-closes-3am';
const ENV = {
  OMEGA_CLV_TRUE_CLOSE: 'off',
  OMEGA_V2_PICK_CLV: 'off',
  OMEGA_V2_PICK_CLV_FILL: 'off',
  OMEGA_CLOSES_AT_3AM: 'on',
  OMEGA_NCAAM_GRADE: 'off',
  OMEGA_DAILY_RESULTS_RESYNC: 'off',
  OMEGA_PULL_SLOT_LOCK: 'off',
};

function memoryStore(seed) {
  return {
    data: JSON.parse(JSON.stringify(seed || {})),
    writes: [],
    async get(key) {
      return this.data[key] ? JSON.parse(JSON.stringify(this.data[key])) : null;
    },
    async setJSON(key, value) {
      this.writes.push(key);
      this.data[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

function leafsPick(over) {
  return Object.assign({
    sport: 'NHL',
    matchup: 'Boston Bruins @ Toronto Maple Leafs',
    pick: 'Toronto Maple Leafs -1.5',
    betType: 'Spread',
    odds: '-110',
    units: '1u',
    commenceTime: TIP,
  }, over || {});
}

function asSaved(bundle) {
  return {
    savedProvided: true,
    savedGames: bundle.games || [],
    savedSnapshots: bundle.snapshots || [],
    savedEvents: bundle.events || [],
  };
}

function spreadSnaps(line, sidePrice, oppPrice) {
  return {
    games: [{
      game_id: 'tor-1',
      sport: 'NHL',
      home_team: 'Toronto Maple Leafs',
      away_team: 'Boston Bruins',
      commence_time: TIP,
    }],
    snapshots: [
      {
        game_id: 'tor-1', sport: 'NHL', book: 'pinnacle', market: 'spreads',
        side: 'Toronto Maple Leafs', point: line, price: sidePrice,
        line_type: 'closing', snapshot_ts: '2026-11-18T00:20:00Z', source: SOURCE,
      },
      {
        game_id: 'tor-1', sport: 'NHL', book: 'pinnacle', market: 'spreads',
        side: 'Boston Bruins', point: -line, price: oppPrice,
        line_type: 'closing', snapshot_ts: '2026-11-18T00:20:00Z', source: SOURCE,
      },
    ],
  };
}

function installFetch() {
  const urls = [];
  const prev = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.includes('the-odds-api.com') || href.includes('api.the-odds-api.com')) {
      throw new Error('odds api must not be called');
    }
    return { ok: true, status: 200, json: async () => ({ events: [] }) };
  };
  return {
    urls,
    restore() { global.fetch = prev; },
  };
}

async function runTrack(store, env, extra) {
  const net = installFetch();
  try {
    const res = await track.handle({
      httpMethod: 'POST',
      queryStringParameters: { date: '2026-11-18' },
      body: JSON.stringify({ date: '2026-11-18' }),
    }, Object.assign({
      now: NOW,
      env,
      store,
      fetch: async (url) => {
        net.urls.push(String(url));
        if (String(url).includes('the-odds-api.com')) throw new Error('odds api must not be called');
        return { ok: true, status: 200, json: async () => [] };
      },
    }, extra || {}));
    return { res, urls: net.urls };
  } finally {
    net.restore();
  }
}

async function main() {
  const expected = gradePowerClv('-110', -120, 100);
  assert.ok(expected && expected.clv != null);

  const matchedStore = memoryStore({
    'picks-2026-11-18': { picks: [leafsPick()] },
  });
  const matched = await runTrack(matchedStore, ENV, asSaved(spreadSnaps(-1.5, -120, 100)));
  assert.strictEqual(matched.res.statusCode, 200);
  assert.ok(matched.urls.every((href) => !href.includes('the-odds-api.com')));
  const row = matchedStore.data['clv-2026-11-18'].picks[0];
  assert.strictEqual(row.closingOdds, '-120');
  assert.strictEqual(row.closingLine, -1.5);
  assert.strictEqual(row.clv, expected.clv);
  assert.strictEqual(row.clvCents, expected.clvCents);
  assert.strictEqual(row.anchor, 'pinnacle');
  assert.strictEqual(row.closeSource, 'saved-pinnacle');
  assert.ok(!row.error);

  const mismatchStore = memoryStore({
    'picks-2026-11-18': { picks: [leafsPick()] },
  });
  const mismatch = await runTrack(mismatchStore, ENV, asSaved(spreadSnaps(-2.5, -110, -110)));
  assert.strictEqual(mismatch.res.statusCode, 200);
  const missed = mismatchStore.data['clv-2026-11-18'].picks[0];
  assert.strictEqual(missed.closingOdds, null);
  assert.strictEqual(missed.closingLine, null);
  assert.strictEqual(missed.clv, null);

  const offStore = memoryStore({
    'picks-2026-11-18': { picks: [leafsPick()] },
  });
  const off = await runTrack(offStore, Object.assign({ OMEGA_CLV_SAVED_ATTACH: 'off' }, ENV), asSaved(spreadSnaps(-1.5, -120, 100)));
  assert.strictEqual(off.res.statusCode, 200);
  const offRow = offStore.data['clv-2026-11-18'].picks[0];
  assert.strictEqual(offRow.closingOdds, null);
  assert.strictEqual(offRow.closingLine, null);
  assert.strictEqual(offRow.clv, null);
  assert.ok(String(offRow.error || '').includes('No matching game'));

  const quoted = resolveSavedClose(leafsPick({
    closingOdds: -120,
    closingLine: -1.5,
    oppOdds: 100,
    closeSnapshotAt: '2026-11-18T00:20:00Z',
  }), { games: [], snapshots: [], events: [] }, ENV);
  assert.strictEqual(quoted && quoted.sideOdds, -120);
  assert.strictEqual(quoted.closingLine, -1.5);
  const quotedMismatch = resolveSavedClose(leafsPick({
    closingOdds: -110,
    closingLine: -2.5,
    oppOdds: -110,
  }), { games: [], snapshots: [], events: [] }, ENV);
  assert.strictEqual(quotedMismatch, null);

  const kept = {
    pick: 'Toronto Maple Leafs -1.5',
    matchup: 'Boston Bruins @ Toronto Maple Leafs',
    sport: 'NHL',
    betType: 'Spread',
    market: 'Spread',
    pickTimeOdds: '-110',
    betLine: -1.5,
    closingOdds: '-105',
    closingLine: -1.5,
    clv: 0.02,
    clvCents: 2,
    beatClosing: true,
    anchor: 'pinnacle',
    anchorBook: 'pinnacle',
  };
  const open = {
    pick: 'Over 6.5',
    matchup: 'Boston Bruins @ Toronto Maple Leafs',
    sport: 'NHL',
    betType: 'Total',
    market: 'Total',
    pickTimeOdds: '-105',
    betLine: 6.5,
    closingOdds: null,
    closingLine: null,
    clv: null,
    error: 'No matching game found in odds feed',
  };
  const totalSnaps = {
    games: spreadSnaps(-1.5, -130, 110).games,
    snapshots: spreadSnaps(-1.5, -130, 110).snapshots.concat([
      {
        game_id: 'tor-1', sport: 'NHL', book: 'pinnacle', market: 'totals',
        side: 'Over', point: 6.5, price: -115,
        line_type: 'closing', snapshot_ts: '2026-11-18T00:20:00Z', source: SOURCE,
      },
      {
        game_id: 'tor-1', sport: 'NHL', book: 'pinnacle', market: 'totals',
        side: 'Under', point: 6.5, price: -105,
        line_type: 'closing', snapshot_ts: '2026-11-18T00:20:00Z', source: SOURCE,
      },
    ]),
  };
  const backfillStore = memoryStore({
    'picks-2026-11-18': { picks: [leafsPick(), {
      sport: 'NHL',
      matchup: 'Boston Bruins @ Toronto Maple Leafs',
      pick: 'Over 6.5',
      betType: 'Total',
      odds: '-105',
      units: '1u',
      commenceTime: TIP,
    }] },
    'clv-2026-11-18': { date: '2026-11-18', picks: [kept, open] },
  });
  const keptBefore = JSON.stringify(backfillStore.data['clv-2026-11-18'].picks[0]);
  const net = installFetch();
  try {
    const first = await track.handle({
      httpMethod: 'POST',
      queryStringParameters: { backfill: '2026-11-18..2026-11-24' },
    }, {
      now: NOW,
      env: ENV,
      store: backfillStore,
      savedByDate: { '2026-11-18': totalSnaps },
      fetch: async () => { throw new Error('backfill must not fetch'); },
    });
    const firstBody = JSON.parse(first.body);
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(firstBody.attached, 1);
    assert.strictEqual(firstBody.skipped, 1);
    assert.deepStrictEqual(firstBody.wrote, ['2026-11-18']);
    assert.strictEqual(firstBody.oddsApi, false);
    const after = backfillStore.data['clv-2026-11-18'];
    assert.strictEqual(JSON.stringify(after.picks[0]), keptBefore);
    assert.strictEqual(after.picks[0].closingOdds, '-105');
    assert.strictEqual(after.picks[0].clv, 0.02);
    const totalExpected = gradePowerClv('-105', -115, -105);
    assert.strictEqual(after.picks[1].closingOdds, '-115');
    assert.strictEqual(after.picks[1].closingLine, 6.5);
    assert.strictEqual(after.picks[1].clv, totalExpected.clv);
    assert.strictEqual(after.picks[1].error, null);
    const filled = JSON.stringify(after.picks[1]);
    const writes = backfillStore.writes.length;

    const second = await track.handle({
      httpMethod: 'POST',
      body: JSON.stringify({ days: 7 }),
    }, {
      now: NOW,
      env: ENV,
      store: backfillStore,
      savedByDate: { '2026-11-18': totalSnaps },
      fetch: async () => { throw new Error('backfill must not fetch'); },
    });
    const secondBody = JSON.parse(second.body);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(secondBody.attached, 0);
    assert.deepStrictEqual(secondBody.dates, [
      '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21',
      '2026-11-22', '2026-11-23', '2026-11-24',
    ]);
    assert.strictEqual(backfillStore.writes.length, writes);
    assert.strictEqual(JSON.stringify(backfillStore.data['clv-2026-11-18'].picks[0]), keptBefore);
    assert.strictEqual(JSON.stringify(backfillStore.data['clv-2026-11-18'].picks[1]), filled);
    assert.ok(net.urls.every((href) => !href.includes('the-odds-api.com')));
  } finally {
    net.restore();
  }

  const offBackfill = memoryStore({
    'clv-2026-11-18': { date: '2026-11-18', picks: [open] },
  });
  const offBack = await track.handle({
    httpMethod: 'POST',
    queryStringParameters: { backfill: '2026-11-18..2026-11-18' },
  }, {
    now: NOW,
    env: Object.assign({ OMEGA_CLV_SAVED_ATTACH: 'off' }, ENV),
    store: offBackfill,
    savedByDate: { '2026-11-18': totalSnaps },
    fetch: async () => { throw new Error('flag off backfill must not fetch'); },
  });
  assert.strictEqual(JSON.parse(offBack.body).skipped, 'flag-off');
  assert.strictEqual(offBackfill.writes.length, 0);
  assert.strictEqual(offBackfill.data['clv-2026-11-18'].picks[0].clv, null);

  const bad = await track.handle({
    httpMethod: 'POST',
    queryStringParameters: { backfill: 'not-a-date' },
  }, { now: NOW, env: ENV, store: memoryStore({}) });
  assert.strictEqual(bad.statusCode, 400);

  const days = parseBackfillRequest({}, { days: 7 }, new Date(NOW));
  assert.strictEqual(days.dates[0], '2026-11-18');
  assert.strictEqual(days.dates[6], '2026-11-24');

  console.log('test-omega-clv-saved-attach: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
