'use strict';

/**
 * regrade-omega-letters: B straights at 2.0% <= edge < 3.5% become A-
 * on rating, grade, and qualityGrade. Fake store. No blob network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setEnvironmentContext } = require('@netlify/blobs');
const {
  handle,
  regradeOmegaLetters,
  parseEdgePct,
  ALLOWED_DATES,
  BLOB_STORE,
} = require('./netlify/functions/regrade-omega-letters');
const picksStore = require('./netlify/functions/lib/omega-vnext/store');
const { SITE_ID } = require('./netlify/functions/lib/omega-vnext/config');

assert.strictEqual(BLOB_STORE, 'edge-picks-omega');
assert.deepStrictEqual(ALLOWED_DATES, ['2026-10-31', '2026-11-01', '2026-11-02']);

const fnSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/regrade-omega-letters.js'), 'utf8');
assert.ok(!/getStore\(\s*\{/.test(fnSrc), 'live regrade must not open getStore({ siteID, token })');
assert.ok(!/storePicks\s*\(/.test(fnSrc), 'regrade must not call storePicks');
assert.ok(/readPicksLocated\(/.test(fnSrc));
assert.ok(/writePicksRaw\(/.test(fnSrc));
assert.ok(/\.setJSON\(/.test(fnSrc));

const storeSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/store.js'), 'utf8');
const locatedStart = storeSrc.indexOf('async function readPicksLocated(dateISO)');
const readStart = storeSrc.indexOf('async function readPicks(dateISO)');
const rawStart = storeSrc.indexOf('async function writePicksRaw(dateISO, data)');
const resolveStart = storeSrc.indexOf('function resolvePicksStoreTarget');
assert.ok(locatedStart >= 0 && locatedStart < readStart && readStart < rawStart && rawStart < resolveStart);
const locatedFn = storeSrc.slice(locatedStart, readStart);
const readFn = storeSrc.slice(readStart, rawStart);
const rawFn = storeSrc.slice(rawStart, storeSrc.indexOf('/**', rawStart));
assert.ok(locatedFn.includes('getStore(BLOB_STORE)'));
assert.ok(locatedFn.indexOf('getStore(BLOB_STORE)') < locatedFn.indexOf('blobFetch('));
assert.ok(!/siteID/.test(locatedFn));
assert.ok(/return found \? found\.card : null/.test(readFn));
assert.ok(/method:\s*'PUT'/.test(rawFn));
assert.ok(/blobFetch\(/.test(rawFn));
assert.ok(/picks-\$\{dateISO\}/.test(rawFn));
assert.ok(!/latest-date/.test(rawFn));
assert.ok(!/picks-dates/.test(rawFn));
assert.ok(!/storePicks/.test(rawFn));
assert.ok(!/setJSON/.test(rawFn));

assert.strictEqual(parseEdgePct('2.8%'), 2.8);
assert.strictEqual(parseEdgePct('2.0%'), 2);
assert.strictEqual(parseEdgePct('3.5%'), 3.5);
assert.strictEqual(parseEdgePct('1.96%'), 1.96);
assert.strictEqual(parseEdgePct(0.028), 2.8);
assert.strictEqual(parseEdgePct(2.8), 2.8);

function memoryStore(seed) {
  const data = Object.assign({}, seed);
  const writes = [];
  return {
    writes,
    data,
    async get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async setJSON(key, value) {
      writes.push({ key, value });
      data[key] = value;
    },
  };
}

function straight(extra) {
  return Object.assign({
    pick: 'Home ML',
    matchup: 'Away @ Home',
    odds: '-110',
    units: '0.75u',
    unitsNum: 0.75,
    stakeUsd: 113,
    result: 'win',
    confidence: 60,
    rating: 'b',
    grade: 'b',
    qualityGrade: 'b',
    edgePct: '2.8%',
  }, extra);
}

function cardFor(picks, extra) {
  return Object.assign({
    date: '2026-10-31',
    model: 'omega-v2-sharp-2026-10-30',
    picks,
    parlayLegs: [{
      units: '0.25u',
      legs: [straight({ pick: 'Parlay leg', grade: 'b', rating: 'b', qualityGrade: 'b', edgePct: '2.7%', units: '0.25u' })],
    }],
    summary: { totalPicks: picks.length },
  }, extra);
}

function untouched(before, after) {
  const drop = (row) => {
    const copy = Object.assign({}, row);
    delete copy.rating;
    delete copy.grade;
    delete copy.qualityGrade;
    return copy;
  };
  assert.deepStrictEqual(after.map(drop), before.map(drop));
}

(async () => {
  const picks = [
    straight({ pick: 'Low edge', edgePct: '2.0%' }),
    straight({ pick: 'Mid', edgePct: '2.8%', matchup: 'A @ B' }),
    straight({ pick: 'Just under A', edgePct: '3.49%' }),
    straight({ pick: 'Exact A', edgePct: '3.5%' }),
    straight({ pick: 'Still B', edgePct: '1.9%' }),
    straight({ pick: 'Unrounded', edgePct: '1.96%' }),
    straight({ pick: 'Already A', grade: 'a', rating: 'a', qualityGrade: 'a', edgePct: '2.8%' }),
    straight({ pick: 'High B', edgePct: '4.0%' }),
    straight({ pick: 'No edge', edgePct: null }),
    straight({ pick: 'Upper B', grade: 'B', rating: 'B', qualityGrade: 'B', edgePct: '2.5%' }),
    straight({ pick: 'Not a letter b', grade: 'b+', rating: 'b+', qualityGrade: 'b+', edgePct: '2.5%' }),
    straight({ pick: 'Fraction', edgePct: 0.028 }),
  ];
  const original = cardFor(picks);
  const snapshot = JSON.parse(JSON.stringify(original));
  const store = memoryStore({ 'picks-2026-10-31': original });

  const dry = await regradeOmegaLetters({ date: '2026-10-31', store });
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(store.writes.length, 0);
  assert.deepStrictEqual(original, snapshot, 'dry run must not mutate the stored card');
  assert.deepStrictEqual(dry.changes.map((row) => row.pick), ['Low edge', 'Mid', 'Just under A', 'Upper B', 'Fraction']);
  for (const row of dry.changes) {
    assert.deepStrictEqual(row.to, { rating: 'aminus', grade: 'aminus', qualityGrade: 'aminus' });
    assert.ok(row.edge >= 2 && row.edge < 3.5);
  }
  assert.strictEqual(dry.changes[1].matchup, 'A @ B');
  assert.strictEqual(dry.changes[1].index, 1);

  const explicit = await regradeOmegaLetters({ date: '2026-10-31', dryRun: true, store });
  assert.strictEqual(explicit.wrote, false);
  assert.strictEqual(store.writes.length, 0);

  const asString = await regradeOmegaLetters({ date: '2026-10-31', dryRun: 'false', store });
  assert.strictEqual(asString.dryRun, true);
  assert.strictEqual(asString.wrote, false);
  assert.strictEqual(store.writes.length, 0);

  const live = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false, store });
  assert.strictEqual(live.wrote, true);
  assert.strictEqual(live.dryRun, false);
  assert.strictEqual(store.writes.length, 1);
  assert.strictEqual(store.writes[0].key, 'picks-2026-10-31');
  const written = store.writes[0].value;
  assert.deepStrictEqual(original, snapshot, 'write copies the card');
  assert.strictEqual(written.summary.totalPicks, snapshot.summary.totalPicks);
  assert.deepStrictEqual(written.parlayLegs, snapshot.parlayLegs);
  assert.strictEqual(written.parlayLegs[0].legs[0].grade, 'b');
  untouched(snapshot.picks, written.picks);
  assert.strictEqual(store.writes[0].value.picks.filter((pick) => pick.grade === 'aminus').length, 5);
  const changedIdx = new Set(live.changes.map((row) => row.index));
  written.picks.forEach((pick, index) => {
    if (changedIdx.has(index)) {
      assert.strictEqual(pick.rating, 'aminus');
      assert.strictEqual(pick.grade, 'aminus');
      assert.strictEqual(pick.qualityGrade, 'aminus');
    } else {
      assert.deepStrictEqual(
        { rating: pick.rating, grade: pick.grade, qualityGrade: pick.qualityGrade },
        { rating: snapshot.picks[index].rating, grade: snapshot.picks[index].grade, qualityGrade: snapshot.picks[index].qualityGrade }
      );
    }
    assert.strictEqual(pick.confidence, snapshot.picks[index].confidence);
    assert.strictEqual(pick.units, snapshot.picks[index].units);
    assert.strictEqual(pick.unitsNum, snapshot.picks[index].unitsNum);
    assert.strictEqual(pick.stakeUsd, snapshot.picks[index].stakeUsd);
    assert.strictEqual(pick.odds, snapshot.picks[index].odds);
    assert.strictEqual(pick.result, snapshot.picks[index].result);
  });

  const again = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false, store });
  assert.strictEqual(again.wrote, false);
  assert.deepStrictEqual(again.changes, []);
  assert.strictEqual(store.writes.length, 1, 'a second pass does not write');

  const missing = memoryStore({});
  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-11-01', dryRun: false, store: missing }),
    (err) => err.statusCode === 404
  );
  assert.strictEqual(missing.writes.length, 0);

  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-11-03', dryRun: false, store }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => regradeOmegaLetters({ date: '2026-10-30', store }),
    (err) => err.statusCode === 400
  );

  const savedKey = process.env.PICKS_SECRET_KEY;
  process.env.PICKS_SECRET_KEY = 'test-key';
  try {
    const denied = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'nope' },
      body: JSON.stringify({ date: '2026-11-02', dryRun: false }),
    });
    assert.strictEqual(denied.statusCode, 401);
    assert.strictEqual(JSON.parse(denied.body).error, 'Unauthorized');

    const missingKey = await handle({
      httpMethod: 'POST',
      queryStringParameters: {},
      body: JSON.stringify({ date: '2026-11-02' }),
    });
    assert.strictEqual(missingKey.statusCode, 401);

    const get = await handle({
      httpMethod: 'GET',
      queryStringParameters: { key: 'test-key' },
    });
    assert.strictEqual(get.statusCode, 405);

    const badDate = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-09-01', dryRun: false }),
    });
    assert.strictEqual(badDate.statusCode, 400);

    const badJson = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: '{',
    });
    assert.strictEqual(badJson.statusCode, 400);

    const nov = cardFor([
      straight({ pick: 'Nov 1', edgePct: '2.2%', confidence: 60, result: 'loss', units: '0.5u', odds: '+140' }),
    ], { date: '2026-11-01' });
    const novSnap = JSON.parse(JSON.stringify(nov));
    const novStore = memoryStore({ 'picks-2026-11-01': nov });
    const ok = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-11-01' }),
    }, { store: novStore });
    assert.strictEqual(ok.statusCode, 200);
    const okBody = JSON.parse(ok.body);
    assert.strictEqual(okBody.dryRun, true);
    assert.strictEqual(okBody.wrote, false);
    assert.strictEqual(okBody.changes.length, 1);
    assert.strictEqual(novStore.writes.length, 0);
    assert.deepStrictEqual(nov, novSnap);

    const posted = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-11-02', dryRun: false }),
    }, {
      store: memoryStore({
        'picks-2026-11-02': cardFor([
          straight({ pick: 'Nov 2', edgePct: '3.4%', confidence: 60, result: null, units: '1u', odds: '-105' }),
        ], { date: '2026-11-02' }),
      }),
    });
    assert.strictEqual(posted.statusCode, 200);
    const postedBody = JSON.parse(posted.body);
    assert.strictEqual(postedBody.wrote, true);
    assert.strictEqual(postedBody.changes.length, 1);
    assert.strictEqual(postedBody.changes[0].to.grade, 'aminus');
    const saved = postedBody;
    assert.ok(saved.changes[0].edge >= 2 && saved.changes[0].edge < 3.5);
    await assert.rejects(
      () => regradeOmegaLetters({ date: '2026-10-31', dryRun: false, store: {} }),
      (err) => err && err.statusCode === 500
    );
  } finally {
    if (savedKey == null) delete process.env.PICKS_SECRET_KEY;
    else process.env.PICKS_SECRET_KEY = savedKey;
  }

  function httpResult(status, body) {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get() { return null; } },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  async function withBlobs(run) {
    const prevFetch = global.fetch;
    const prevCtx = process.env.NETLIFY_BLOBS_CONTEXT;
    const prevTok = process.env.NETLIFY_AUTH_TOKEN;
    const prevKey = process.env.PICKS_SECRET_KEY;
    const origStorePicks = picksStore.storePicks;
    let storePicksCalled = 0;
    picksStore.storePicks = async () => {
      storePicksCalled += 1;
      throw new Error('storePicks must not run');
    };
    try {
      await run(() => storePicksCalled);
    } finally {
      global.fetch = prevFetch;
      picksStore.storePicks = origStorePicks;
      if (prevCtx == null) delete process.env.NETLIFY_BLOBS_CONTEXT;
      else process.env.NETLIFY_BLOBS_CONTEXT = prevCtx;
      if (prevTok == null) delete process.env.NETLIFY_AUTH_TOKEN;
      else process.env.NETLIFY_AUTH_TOKEN = prevTok;
      if (prevKey == null) delete process.env.PICKS_SECRET_KEY;
      else process.env.PICKS_SECRET_KEY = prevKey;
    }
  }

  await withBlobs(async (storePicksCalled) => {
    const calls = [];
    const sdkCard = cardFor([
      straight({ pick: 'Sdk band', edgePct: '2.4%', confidence: 60, result: 'win', units: '0.75u', odds: '-110', stakeUsd: 113 }),
    ], { date: '2026-10-31' });
    const sdkUrl = 'https://edge.example.test/site-test/site:edge-picks-omega/picks-2026-10-31';
    const blobs = new Map([[sdkUrl, sdkCard]]);
    process.env.NETLIFY_AUTH_TOKEN = 'offline-test-token';
    setEnvironmentContext({
      siteID: 'site-test',
      token: 'edge-token',
      edgeURL: 'https://edge.example.test',
    });
    global.fetch = async (url, opts) => {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const href = String(url);
      calls.push({ url: href, method, body: opts && opts.body });
      if (href.includes('api.netlify.com')) return httpResult(500, { error: 'wrong store' });
      if (method === 'GET') return blobs.has(href) ? httpResult(200, blobs.get(href)) : httpResult(404, null);
      if (method === 'PUT') {
        blobs.set(href, JSON.parse(opts.body));
        return httpResult(200, {});
      }
      return httpResult(500, {});
    };

    const located = await picksStore.readPicksLocated('2026-10-31');
    assert.strictEqual(located.via, 'sdk');
    assert.strictEqual(typeof located.store.setJSON, 'function');
    const same = await picksStore.readPicks('2026-10-31');
    assert.strictEqual(same.picks[0].pick, 'Sdk band');
    assert.strictEqual(same.picks[0].grade, 'b');

    calls.length = 0;
    const dry = await regradeOmegaLetters({ date: '2026-10-31' });
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(dry.wrote, false);
    assert.strictEqual(dry.changes.length, 1);
    assert.deepStrictEqual(calls.map((row) => row.method), ['GET']);
    assert.strictEqual(calls[0].url, sdkUrl);

    calls.length = 0;
    const live = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false });
    assert.strictEqual(live.wrote, true);
    assert.strictEqual(live.changes[0].to.grade, 'aminus');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[1].method, 'PUT');
    assert.strictEqual(calls[0].url, sdkUrl);
    assert.strictEqual(calls[1].url, sdkUrl);
    assert.ok(!calls.some((row) => /api\.netlify\.com|latest-date|picks-dates/.test(row.url)));
    const written = JSON.parse(calls[1].body);
    assert.strictEqual(written.picks[0].grade, 'aminus');
    assert.strictEqual(written.picks[0].rating, 'aminus');
    assert.strictEqual(written.picks[0].qualityGrade, 'aminus');
    assert.strictEqual(written.picks[0].odds, '-110');
    assert.strictEqual(written.picks[0].units, '0.75u');
    assert.strictEqual(written.picks[0].confidence, 60);
    assert.strictEqual(written.picks[0].result, 'win');
    assert.strictEqual(written.picks[0].stakeUsd, 113);
    assert.strictEqual(written.parlayLegs[0].legs[0].grade, 'b');
    assert.strictEqual(storePicksCalled(), 0);

    calls.length = 0;
    const again = await regradeOmegaLetters({ date: '2026-10-31', dryRun: false });
    assert.strictEqual(again.wrote, false);
    assert.deepStrictEqual(again.changes, []);
    assert.deepStrictEqual(calls.map((row) => row.method), ['GET']);
  });

  await withBlobs(async (storePicksCalled) => {
    const calls = [];
    process.env.NETLIFY_AUTH_TOKEN = 'offline-test-token';
    delete process.env.NETLIFY_BLOBS_CONTEXT;
    const sdkUrl = 'https://edge.example.test/site-test/site:edge-picks-omega/picks-2026-11-02';
    setEnvironmentContext({
      siteID: 'site-test',
      token: 'edge-token',
      edgeURL: 'https://edge.example.test',
    });
    const restOnly = cardFor([
      straight({ pick: 'Only on REST', edgePct: '2.2%' }),
    ], { date: '2026-11-02' });
    const restUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${BLOB_STORE}/picks-2026-11-02`;
    global.fetch = async (url, opts) => {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const href = String(url);
      calls.push({ url: href, method, body: opts && opts.body });
      if (href === sdkUrl && method === 'GET') return httpResult(404, null);
      if (href === restUrl && method === 'GET') return httpResult(200, restOnly);
      return httpResult(500, { error: 'unexpected ' + method + ' ' + href });
    };
    await assert.rejects(
      () => regradeOmegaLetters({ date: '2026-11-02', dryRun: false }),
      (err) => err && err.statusCode === 404 && /no card for 2026-11-02/.test(err.message)
    );
    assert.deepStrictEqual(calls.map((row) => row.url), [sdkUrl]);
    assert.strictEqual(storePicksCalled(), 0);
  });

  await withBlobs(async (storePicksCalled) => {
    const calls = [];
    process.env.NETLIFY_AUTH_TOKEN = 'offline-test-token';
    process.env.PICKS_SECRET_KEY = 'test-key';
    delete process.env.NETLIFY_BLOBS_CONTEXT;
    const restCard = cardFor([
      straight({ pick: 'Rest band', edgePct: '3.1%', confidence: 55, result: 'loss', units: '0.5u', odds: '+140', stakeUsd: 75 }),
    ], { date: '2026-11-01' });
    const restUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${BLOB_STORE}/picks-2026-11-01`;
    const blobs = new Map([[restUrl, restCard]]);
    global.fetch = async (url, opts) => {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const href = String(url);
      calls.push({ url: href, method, body: opts && opts.body });
      if (method === 'GET') return blobs.has(href) ? httpResult(200, blobs.get(href)) : httpResult(404, null);
      if (method === 'PUT') {
        blobs.set(href, JSON.parse(opts.body));
        return httpResult(200, {});
      }
      return httpResult(500, {});
    };

    const located = await picksStore.readPicksLocated('2026-11-01');
    assert.strictEqual(located.via, 'rest');
    assert.strictEqual(located.store, null);
    assert.strictEqual(located.card.picks[0].grade, 'b');
    const same = await picksStore.readPicks('2026-11-01');
    assert.strictEqual(same.picks[0].pick, 'Rest band');

    calls.length = 0;
    const live = await regradeOmegaLetters({ date: '2026-11-01', dryRun: false });
    assert.strictEqual(live.wrote, true);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[1].method, 'PUT');
    assert.strictEqual(calls[0].url, restUrl);
    assert.strictEqual(calls[1].url, restUrl);
    assert.ok(!calls.some((row) => /latest-date|picks-dates|edge\.example\.test/.test(row.url)));
    const written = JSON.parse(calls[1].body);
    assert.strictEqual(written.picks[0].grade, 'aminus');
    assert.strictEqual(written.picks[0].rating, 'aminus');
    assert.strictEqual(written.picks[0].qualityGrade, 'aminus');
    assert.strictEqual(written.picks[0].odds, '+140');
    assert.strictEqual(written.picks[0].units, '0.5u');
    assert.strictEqual(written.picks[0].confidence, 55);
    assert.strictEqual(written.picks[0].result, 'loss');
    assert.strictEqual(written.picks[0].stakeUsd, 75);
    assert.strictEqual(written.parlayLegs[0].legs[0].grade, 'b');
    assert.strictEqual(storePicksCalled(), 0);

    calls.length = 0;
    const posted = await handle({
      httpMethod: 'POST',
      queryStringParameters: { key: 'test-key' },
      body: JSON.stringify({ date: '2026-11-01', dryRun: false }),
    });
    assert.strictEqual(posted.statusCode, 200);
    const postedBody = JSON.parse(posted.body);
    assert.strictEqual(postedBody.wrote, false, 'handler writes through the same REST key and does not rewrite an already regraded card');
    assert.deepStrictEqual(calls.map((row) => row.method), ['GET']);
    assert.strictEqual(calls[0].url, restUrl);
  });

  await withBlobs(async () => {
    const calls = [];
    process.env.NETLIFY_AUTH_TOKEN = 'offline-test-token';
    delete process.env.NETLIFY_BLOBS_CONTEXT;
    global.fetch = async (url, opts) => {
      calls.push({
        url: String(url),
        method: String((opts && opts.method) || 'GET').toUpperCase(),
      });
      return httpResult(403, {});
    };
    await assert.rejects(
      () => picksStore.writePicksRaw('2026-10-31', { picks: [{ grade: 'aminus' }] }),
      /blob PUT picks-2026-10-31 → 403/
    );
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'PUT');
    assert.ok(calls[0].url.endsWith(`/${BLOB_STORE}/picks-2026-10-31`));
    assert.ok(!/latest-date|picks-dates/.test(calls[0].url));
  });

  console.log('PASS regrade-omega-letters');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
