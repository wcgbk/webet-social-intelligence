'use strict';
// 3:00 capture background dispatch, start/done markers, missed-pull matrix.
// Injected fetch and blobs. No network. No real sleep.
const assert = require('assert');
const lines = require('./netlify/functions/capture-omega-pinnacle-lines');
const bg = require('./netlify/functions/capture-omega-pinnacle-lines-background');
const missed = require('./netlify/functions/monitor-omega-missed-pull');
const gate = require('./netlify/functions/lib/omega-vnext/capture_gate');
const moves = require('./netlify/functions/lib/omega-vnext/pinnacle_line_move');

const DATE = '2026-10-15';
const SECRET = 'prep-secret-1015';
const WHEN3 = new Date('2026-10-15T07:00:00Z');
const WHEN10 = new Date('2026-10-15T14:00:00Z');
const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';

global.fetch = async () => {
  throw new Error('unexpected network');
};

function scheduler(iso) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: iso || WHEN3.toISOString() }),
  };
}

function manual() {
  return { httpMethod: 'POST', headers: {}, body: '{}' };
}

function responder(body, status) {
  const text = JSON.stringify(body);
  return {
    ok: status == null || (status >= 200 && status < 300),
    status: status == null ? 200 : status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'x-requests-remaining') return '50000';
        return null;
      },
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function book(key) {
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: HOME, price: -110 }, { name: AWAY, price: -110 }] },
      { key: 'spreads', outcomes: [{ name: HOME, price: -110, point: -3 }, { name: AWAY, price: -110, point: 3 }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 47.5 }, { name: 'Under', price: -110, point: 47.5 }] },
    ],
  };
}

function board(id, commence) {
  return {
    id,
    commence_time: commence,
    home_team: HOME,
    away_team: AWAY,
    bookmakers: [book('pinnacle'), book('draftkings'), book('hardrockbet')],
  };
}

function memoryStore(seq) {
  const blobs = new Map();
  return {
    blobs,
    async read(key) {
      if (!blobs.has(key)) return null;
      return JSON.parse(JSON.stringify(blobs.get(key)));
    },
    async write(key, data) {
      const copy = JSON.parse(JSON.stringify(data));
      blobs.set(key, copy);
      if (seq) {
        seq.push({
          kind: 'write',
          key,
          phase: copy && copy.phase,
          schema: copy && copy.schema,
          closesStored: copy && copy.closesStored,
        });
      }
    },
  };
}

function oddsFetch(seq) {
  return async (url) => {
    const text = String(url);
    if (text.indexOf('api.the-odds-api.com') === -1) throw new Error('unexpected url ' + text);
    const historical = text.indexOf('/historical/') !== -1;
    seq.push({ kind: 'fetch', historical });
    if (historical) {
      return responder({
        timestamp: '2026-10-14T22:50:00Z',
        data: [board('y1', '2026-10-14T23:00:00Z')],
      });
    }
    return responder([board('e1', '2026-10-15T23:30:00Z')]);
  };
}

function captureCtx(extra) {
  return Object.assign({
    apiKey: 'test-key-1234',
    labels: ['NFL'],
    skipExternalCloses: true,
    yesterdayGames: [{
      sport: 'NFL',
      eventId: 'y1',
      commenceTime: '2026-10-14T23:00:00Z',
      homeTeam: HOME,
      awayTeam: AWAY,
    }],
  }, extra || {});
}

function envWithSecret(extra) {
  return Object.assign({
    PICKS_SECRET_KEY: SECRET,
    URL: 'https://webetsocial.com',
    OMEGA_REPLAY_NO_WRITE: '0',
  }, extra || {});
}

(async () => {
  assert.strictEqual(lines.handler.length, 2);
  assert.strictEqual(bg.handler.length, 2);
  assert.strictEqual(lines.backgroundAccepted(202), true);
  assert.strictEqual(lines.backgroundAccepted(200), true);
  assert.strictEqual(lines.backgroundAccepted(500), false);
  assert.strictEqual(lines.backgroundAccepted(0), false);

  const logs = [];
  const prevLog = console.log;
  console.log = (line) => { logs.push(String(line)); };

  try {
    const bgCalls = [];
    const t0 = Date.now();
    const fired = await lines.handler(scheduler(), {
      now: WHEN3,
      env: envWithSecret(),
      fetchImpl: async (url, init) => {
        bgCalls.push({ url: String(url), init });
        return { status: 202, ok: true };
      },
      captureOpts: {
        apiKey: 'test-key-1234',
        labels: ['NFL'],
        fetchImpl: async () => { throw new Error('entry called the Odds API'); },
      },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `scheduler returned in ${elapsed}ms`);
    assert.strictEqual(fired.statusCode, 200);
    const firedBody = JSON.parse(fired.body);
    assert.strictEqual(firedBody.path, 'background');
    assert.strictEqual(firedBody.etSlot, '0300');
    assert.strictEqual(firedBody.dateISO, DATE);
    assert.strictEqual(firedBody.backgroundStatus, 202);
    assert.strictEqual(bgCalls.length, 1);
    assert.ok(bgCalls[0].url.endsWith('/.netlify/functions/capture-omega-pinnacle-lines-background'));
    assert.ok(bgCalls[0].url.indexOf(SECRET) === -1);
    const sent = JSON.parse(bgCalls[0].init.body);
    assert.deepStrictEqual(sent, { scheduled: true, etSlot: '0300', dateISO: DATE });
    assert.strictEqual(JSON.stringify(sent).indexOf(SECRET), -1);
    assert.strictEqual(bgCalls[0].init.headers['x-picks-secret'], SECRET);
    assert.ok(logs.some((line) => line.includes('path=background')));

    const noSecretCalls = [];
    const seqFallback = [];
    const storeFallback = memoryStore(seqFallback);
    const noSecret = await lines.handler(scheduler(), {
      now: WHEN3,
      env: { URL: 'https://webetsocial.com', OMEGA_REPLAY_NO_WRITE: '0' },
      fetchImpl: async () => { noSecretCalls.push('background'); return { status: 202 }; },
      captureOpts: captureCtx({
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        fetchImpl: oddsFetch(seqFallback),
        read: storeFallback.read,
        write: storeFallback.write,
      }),
    });
    const noSecretBody = JSON.parse(noSecret.body);
    assert.strictEqual(noSecretCalls.length, 0);
    assert.strictEqual(noSecretBody.path, undefined);
    assert.strictEqual(noSecretBody.mode, 'check');
    assert.strictEqual(noSecretBody.etSlot, '0300');
    assert.ok(noSecretBody.pulls >= 1);
    assert.ok(logs.some((line) => line.includes('path=inline-fallback') && line.includes('no-secret')));

    const badCalls = [];
    const seqBad = [];
    const storeBad = memoryStore(seqBad);
    const badStatus = await lines.handler(scheduler(), {
      now: WHEN3,
      env: envWithSecret(),
      fetchImpl: async (url, init) => {
        badCalls.push(JSON.parse(init.body));
        return { status: 503, ok: false };
      },
      captureOpts: captureCtx({
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        fetchImpl: oddsFetch(seqBad),
        read: storeBad.read,
        write: storeBad.write,
      }),
    });
    const badBody = JSON.parse(badStatus.body);
    assert.strictEqual(badCalls.length, 1);
    assert.deepStrictEqual(badCalls[0], { scheduled: true, etSlot: '0300', dateISO: DATE });
    assert.strictEqual(badBody.mode, 'check');
    assert.strictEqual(badBody.etSlot, '0300');
    assert.ok(seqBad.some((row) => row.kind === 'fetch' && !row.historical));
    assert.ok(logs.some((line) => line.includes('path=inline-fallback') && line.includes('background-status')));

    const threw = [];
    const boomStore = memoryStore();
    const boom = await lines.handler(scheduler(), {
      now: WHEN3,
      env: envWithSecret(),
      fetchImpl: async () => { threw.push('called'); throw new Error('background down'); },
      captureOpts: captureCtx({
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        labels: [],
        fetchImpl: async () => { threw.push('odds'); return responder([]); },
        yesterdayGames: [],
        read: boomStore.read,
        write: boomStore.write,
      }),
    });
    assert.deepStrictEqual(threw, ['called']);
    assert.strictEqual(JSON.parse(boom.body).mode, 'check');
    assert.ok(logs.some((line) => line.includes('path=inline-fallback') && line.includes('background-error')));

    const manualSeq = [];
    const manualStore = memoryStore(manualSeq);
    let manualBg = 0;
    const manualRes = await lines.handler(manual(), {
      now: WHEN3,
      env: envWithSecret(),
      fetchImpl: async () => { manualBg += 1; return { status: 202 }; },
      captureOpts: captureCtx({
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        fetchImpl: oddsFetch(manualSeq),
        read: manualStore.read,
        write: manualStore.write,
      }),
    });
    const manualBody = JSON.parse(manualRes.body);
    assert.strictEqual(manualBg, 0);
    assert.strictEqual(manualBody.path, undefined);
    assert.strictEqual(manualBody.mode, 'check');
    assert.strictEqual(manualBody.etSlot, '0300');
    assert.ok(manualBody.pulls >= 1);
    assert.ok(logs.some((line) => line.includes('path=inline-manual')));

    const directStore = memoryStore();
    const direct = await lines.handleCapture(scheduler(), 'capture-omega-pinnacle-lines', captureCtx({
      now: WHEN3,
      env: { OMEGA_REPLAY_NO_WRITE: '0' },
      labels: [],
      yesterdayGames: [],
      read: directStore.read,
      write: directStore.write,
      fetchImpl: async () => { throw new Error('direct handleCapture fetched'); },
    }));
    assert.strictEqual(JSON.parse(direct.body).etSlot, '0300');
    assert.strictEqual(JSON.parse(direct.body).mode, 'check');

    const off = await lines.handler(scheduler('2026-10-15T08:00:00Z'), {
      now: new Date('2026-10-15T08:00:00Z'),
      env: envWithSecret(),
      fetchImpl: async () => { throw new Error('off-slot fired background'); },
    });
    assert.strictEqual(JSON.parse(off.body).skipped, 'et-guard');

    const oddsBoom = async () => { throw new Error('rejected run called Odds'); };
    const missing = await bg.handleBackground({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ scheduled: true, etSlot: '0300', dateISO: DATE }),
    }, { env: envWithSecret(), fetchImpl: oddsBoom, apiKey: 'test-key-1234' });
    assert.strictEqual(missing.statusCode, 401);

    const wrong = await bg.handleBackground({
      httpMethod: 'POST',
      headers: { 'x-picks-secret': 'not-the-secret' },
      body: JSON.stringify({ scheduled: true, etSlot: '0300', dateISO: DATE }),
    }, { env: envWithSecret(), fetchImpl: oddsBoom, apiKey: 'test-key-1234' });
    assert.strictEqual(wrong.statusCode, 401);

    const bearerWrong = await bg.handleBackground({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer not-the-secret' },
      body: JSON.stringify({ scheduled: true, etSlot: '0300', dateISO: DATE }),
    }, { env: envWithSecret(), fetchImpl: oddsBoom, apiKey: 'test-key-1234' });
    assert.strictEqual(bearerWrong.statusCode, 401);

    const unset = await bg.handleBackground({
      httpMethod: 'POST',
      headers: { 'x-picks-secret': SECRET },
      body: JSON.stringify({ scheduled: true, etSlot: '0300', dateISO: DATE }),
    }, { env: {}, fetchImpl: oddsBoom, apiKey: 'test-key-1234' });
    assert.strictEqual(unset.statusCode, 401);

    for (const slot of ['0900', '1030', '09:00', '']) {
      const refused = await bg.handleBackground({
        httpMethod: 'POST',
        headers: { 'x-picks-secret': SECRET },
        body: JSON.stringify({ scheduled: true, etSlot: slot, dateISO: DATE }),
      }, { env: envWithSecret(), now: WHEN3, fetchImpl: oddsBoom, apiKey: 'test-key-1234' });
      assert.strictEqual(refused.statusCode, 400, slot);
      assert.strictEqual(JSON.parse(refused.body).skipped, 'slot');
    }

    const seq = [];
    const store = memoryStore(seq);
    const ran = await bg.handleBackground({
      httpMethod: 'POST',
      headers: { 'x-picks-secret': SECRET },
      body: JSON.stringify({ scheduled: true, etSlot: '0300', dateISO: DATE }),
    }, captureCtx({
      env: envWithSecret(),
      now: WHEN10,
      fetchImpl: oddsFetch(seq),
      read: store.read,
      write: store.write,
    }));
    const ranBody = JSON.parse(ran.body);
    assert.strictEqual(ran.statusCode, 200);
    assert.strictEqual(ranBody.etSlot, '0300');
    assert.strictEqual(ranBody.date, DATE);
    assert.ok(ranBody.historicalPulls >= 1);

    const startAt = seq.findIndex((row) => row.kind === 'write' && row.key === `capture-start/${DATE}/0300`);
    const checksAt = seq.findIndex((row) => row.kind === 'write' && row.key === `capture-done/${DATE}/0300` && row.phase === 'checks');
    const liveAt = seq.findIndex((row) => row.kind === 'fetch' && !row.historical);
    const histAt = seq.findIndex((row) => row.kind === 'fetch' && row.historical);
    const finalAt = seq.findIndex((row) => row.kind === 'write' && row.key === `capture-done/${DATE}/0300` && row.phase === 'final');
    assert.ok(startAt >= 0, 'start marker');
    assert.ok(liveAt > startAt, 'live pull after start');
    assert.ok(checksAt > liveAt, 'checks marker after the live board');
    assert.ok(histAt > checksAt, 'historical pull after checks marker');
    assert.ok(finalAt > histAt, 'final marker after historical pull');
    assert.strictEqual(seq[checksAt].closesStored, 0);
    const finalDoc = store.blobs.get(`capture-done/${DATE}/0300`);
    assert.strictEqual(finalDoc.phase, 'final');
    assert.strictEqual(finalDoc.schema, moves.CAPTURE_DONE_SCHEMA);
    assert.strictEqual(finalDoc.closesStored, ranBody.closesStored);
    const startDoc = store.blobs.get(`capture-start/${DATE}/0300`);
    assert.strictEqual(startDoc.schema, moves.CAPTURE_START_SCHEMA);
    assert.strictEqual(startDoc.slot, '0300');
    assert.ok(logs.some((line) => line.includes('sport=NFL') && line.includes('elapsedMs=')));
    assert.ok(logs.some((line) => line.includes('total elapsedMs=')));
    assert.ok(logs.some((line) => line.includes('background total elapsedMs=')));

    const seq10 = [];
    const store10 = memoryStore(seq10);
    const ten = await bg.handleBackground({
      httpMethod: 'POST',
      headers: { Authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({ scheduled: true, etSlot: '1000', dateISO: DATE }),
    }, {
      env: envWithSecret(),
      now: WHEN3,
      apiKey: 'test-key-1234',
      labels: [],
      yesterdayGames: [],
      skipExternalCloses: true,
      fetchImpl: async () => { throw new Error('empty 1000 fetched'); },
      read: store10.read,
      write: store10.write,
    });
    assert.strictEqual(JSON.parse(ten.body).etSlot, '1000');
    const done10 = seq10.filter((row) => row.kind === 'write' && row.key === `capture-done/${DATE}/1000`);
    assert.strictEqual(done10.length, 1);
    assert.strictEqual(done10[0].phase, 'final');
    assert.ok(seq10.some((row) => row.key === `capture-start/${DATE}/1000`));
    assert.ok(!Object.prototype.hasOwnProperty.call(store10.blobs.get(`capture-done/${DATE}/1000`), 'closesStored'));

    const checksDoc = {
      schema: moves.CAPTURE_DONE_SCHEMA,
      date: DATE,
      slot: '0300',
      phase: 'checks',
      ok: true,
      gameCount: 2,
      sports: ['NFL:2'],
      pulls: 1,
      closesStored: 0,
      completedAt: '2026-10-15T07:02:00.000Z',
    };
    const morning = await gate.waitForCapture(DATE, '0300', {
      read: async () => checksDoc,
      sportsForCard: () => ['NFL'],
      now: () => 0,
      sleep: async () => { throw new Error('slept on checks marker'); },
      maxWaitMs: 0,
      pollMs: 15000,
    });
    assert.strictEqual(morning.ready, true);
    assert.strictEqual(morning.reason, 'marker');

    const cardGate = await gate.waitForCapture(DATE, '1000', {
      read: async (key) => (String(key).endsWith('/0300') ? checksDoc : null),
      readPinnacleLineMoves: async () => null,
      sportsForCard: () => ['NFL'],
      now: () => 0,
      sleep: async () => {},
      maxWaitMs: 0,
      pollMs: 15000,
    });
    assert.strictEqual(cardGate.ready, false);
    assert.strictEqual(cardGate.reason, 'timeout');

    async function pull(read, extra) {
      const res = await missed.handleMissedPull(scheduler('2026-10-15T07:15:00Z'), {}, Object.assign({
        now: new Date('2026-10-15T07:15:00Z'),
        env: { OMEGA_REPLAY_NO_WRITE: '0' },
        webhookUrl: '',
        sportsForCard: () => ['NFL'],
        readPinnacleLineMoves: async () => null,
        read,
        writeJson: async () => {},
      }, extra || {}));
      return JSON.parse(res.body).report;
    }
    const doneOk = {
      schema: moves.CAPTURE_DONE_SCHEMA,
      date: DATE,
      slot: '0300',
      phase: 'final',
      ok: true,
      gameCount: 4,
      sports: ['NFL:4'],
      pulls: 1,
    };
    assert.strictEqual((await pull(async () => doneOk)).code, 'ok');
    assert.strictEqual((await pull(async () => checksDoc)).code, 'ok');
    assert.strictEqual((await pull(async () => Object.assign({}, doneOk, { ok: false, sports: ['NFL:err'] }))).code, 'partial-0300-pull');
    const startedReport = await pull(async (key) => {
      if (String(key).indexOf('capture-start/') === 0) {
        return { schema: moves.CAPTURE_START_SCHEMA, date: DATE, slot: '0300', startedAt: '2026-10-15T07:00:01.000Z' };
      }
      return null;
    }, {
      readPinnacleLineMoves: async () => ({
        events: [{ checks: [{ slot: '0300' }] }],
      }),
    });
    assert.strictEqual(startedReport.code, 'capture-started-not-finished');
    assert.strictEqual(startedReport.severity, 'alert');
    assert.strictEqual((await pull(async () => null)).code, 'missed-0300-pull');
    assert.strictEqual((await pull(async () => null, {
      readPinnacleLineMoves: async () => ({ events: [{ checks: [{ slot: '0300' }] }] }),
    })).code, 'marker-missing-data-present');
    assert.strictEqual((await pull(async () => null, { sportsForCard: () => [] })).code, 'no-slate');

    assert.ok(!logs.some((line) => line.indexOf(SECRET) !== -1));
  } finally {
    console.log = prevLog;
  }

  console.log('PASS test-omega-capture-background-1015');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
