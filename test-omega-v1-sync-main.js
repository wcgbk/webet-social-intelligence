'use strict';

/**
 * OMEGA_V1_SYNC_MAIN. A successful live main-card write mirrors six fields
 * onto the v1 picks blob and adds the date to v1 picks-dates.
 * A v1 write error leaves the main card in place. Flag off leaves v1 untouched.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sync = require('./netlify/functions/lib/omega-v1ab/sync-main');
const { storePicks } = require('./netlify/functions/lib/omega-vnext/store');
const { V1AB_STORE } = require('./netlify/functions/lib/omega-v1ab/sharp');

const DATE = '2026-11-15';
const FLAG = 'OMEGA_V1_SYNC_MAIN';
const KEY = `picks-${DATE}`;

const savedFlag = process.env[FLAG];
delete process.env[FLAG];

function memoryBlob(seed) {
  const data = new Map();
  for (const [k, v] of Object.entries(seed || {})) {
    data.set(k, v == null ? v : JSON.parse(JSON.stringify(v)));
  }
  const calls = [];
  return {
    calls,
    data,
    async getJSON(key) {
      calls.push(['getJSON', key]);
      if (!data.has(key)) return null;
      const v = data.get(key);
      return v == null ? v : JSON.parse(JSON.stringify(v));
    },
    async setJSON(key, val) {
      calls.push(['setJSON', key]);
      data.set(key, val == null ? val : JSON.parse(JSON.stringify(val)));
    },
    async get(key) {
      calls.push(['get', key]);
      if (!data.has(key)) return null;
      const v = data.get(key);
      return v == null ? v : JSON.parse(JSON.stringify(v));
    },
    async set(key, val) {
      calls.push(['set', key]);
      data.set(key, val);
    },
  };
}

function bombStore() {
  const calls = [];
  return {
    calls,
    async getJSON(key) {
      calls.push(['getJSON', key]);
      throw new Error('v1 touched');
    },
    async setJSON(key) {
      calls.push(['setJSON', key]);
      throw new Error('v1 touched');
    },
  };
}

function mainCard(extra) {
  return Object.assign({
    date: DATE,
    model: 'omega-v2',
    pipelineV2: true,
    environment: 'main-env',
    picks: [{ pickId: 'k0', pick: 'Home', odds: -110, units: '0.25u' }],
    parlayLegs: [{ pickId: 'p1', pick: 'Leg', odds: -120, units: '0.50u' }],
    summary: { totalPicks: 1, totalUnits: '0.8u' },
    shortCard: null,
    edgeSummary: { text: 'edge-now' },
    meta: { pipelineV2: true, run: 'regen' },
    generatedAt: '2026-11-15T16:00:00.000Z',
  }, extra || {});
}

function v1Doc() {
  return {
    date: DATE,
    model: 'v1ab-old',
    environment: 'v1-env',
    baseModel: 'keep-me',
    noPlays: null,
    sharpConfig: { W: 1 },
    sharpQualified: 2,
    rejections: [{ id: 'r1' }],
    poolSize: 40,
    sourceKey: 'old-source',
    sourceGeneratedAt: 'old-src-time',
    generatedAt: 'old-gen',
    kpiStart: '2026-10-22',
    picks: [{ pickId: 'stale', pick: 'Old' }],
    parlayLegs: [{ pickId: 'stale-p' }],
    summary: { totalPicks: 9 },
    shortCard: 'STALE TEXT',
    edgeSummary: { text: 'old-edge' },
    meta: { old: true },
    extraField: { keep: true },
    verifiedAt: 'old-stamp',
    latestNote: 'leave',
  };
}

function opts(main, v1, env) {
  return { force: true, stores: { main, v1 }, env: env || {} };
}

function keptFields(doc) {
  return {
    model: doc.model,
    environment: doc.environment,
    baseModel: doc.baseModel,
    noPlays: doc.noPlays,
    sharpConfig: doc.sharpConfig,
    sharpQualified: doc.sharpQualified,
    rejections: doc.rejections,
    poolSize: doc.poolSize,
    sourceKey: doc.sourceKey,
    sourceGeneratedAt: doc.sourceGeneratedAt,
    generatedAt: doc.generatedAt,
    kpiStart: doc.kpiStart,
    extraField: doc.extraField,
    verifiedAt: doc.verifiedAt,
    latestNote: doc.latestNote,
  };
}

async function main() {
  assert.strictEqual(sync.V1_STORE, 'edge-picks-omega-v1ab');
  assert.strictEqual(sync.V1_STORE, V1AB_STORE);
  assert.deepStrictEqual(sync.V1_SYNC_FIELDS, [
    'picks', 'parlayLegs', 'summary', 'shortCard', 'edgeSummary', 'meta',
  ]);

  assert.strictEqual(sync.v1SyncMainEnabled(undefined), true);
  assert.strictEqual(sync.v1SyncMainEnabled({}), true);
  for (const on of ['on', '1', 'true', 'yes', ' ON ', 'True']) {
    assert.strictEqual(sync.v1SyncMainEnabled({ [FLAG]: on }), true, on);
  }
  for (const off of ['off', '0', 'false', '', '   ', 'OFF', 'maybe', 'no']) {
    assert.strictEqual(sync.v1SyncMainEnabled({ [FLAG]: off }), false, JSON.stringify(off));
  }

  const prior = v1Doc();
  const card = mainCard();
  const main = memoryBlob({ 'picks-dates': ['2026-11-01'] });
  const v1 = memoryBlob({
    [KEY]: prior,
    'picks-dates': ['2026-11-14'],
    'latest-date': '2026-11-16',
  });
  const wrote = await storePicks(DATE, card, opts(main, v1));
  assert.strictEqual(wrote, true);
  assert.deepStrictEqual(main.data.get(KEY).picks, card.picks);
  assert.strictEqual(main.data.get('latest-date'), DATE);
  assert.deepStrictEqual(main.data.get('picks-dates'), ['2026-11-01', DATE]);

  const mirrored = v1.data.get(KEY);
  assert.notStrictEqual(mirrored, card);
  assert.notStrictEqual(mirrored.picks, card.picks);
  assert.notStrictEqual(mirrored.meta, card.meta);
  assert.deepStrictEqual(mirrored.picks, card.picks);
  assert.deepStrictEqual(mirrored.parlayLegs, card.parlayLegs);
  assert.deepStrictEqual(mirrored.summary, card.summary);
  assert.strictEqual(mirrored.shortCard, null);
  assert.deepStrictEqual(mirrored.edgeSummary, card.edgeSummary);
  assert.deepStrictEqual(mirrored.meta, card.meta);
  assert.deepStrictEqual(keptFields(mirrored), keptFields(prior));
  assert.strictEqual(v1.data.get('latest-date'), '2026-11-16');
  assert.deepStrictEqual(v1.data.get('picks-dates'), ['2026-11-14', DATE]);
  assert.ok(!v1.calls.some((c) => c[1] === 'latest-date' && c[0] === 'setJSON'));

  card.picks[0].pick = 'mutated-after-write';
  card.meta.run = 'mutated-meta';
  assert.strictEqual(mirrored.picks[0].pick, 'Home');
  assert.strictEqual(mirrored.meta.run, 'regen');

  const again = await storePicks(DATE, mainCard(), opts(main, v1));
  assert.strictEqual(again, true);
  assert.deepStrictEqual(v1.data.get('picks-dates'), ['2026-11-14', DATE]);

  const stripped = mainCard();
  delete stripped.shortCard;
  delete stripped.edgeSummary;
  const strippedMain = memoryBlob();
  const strippedV1 = memoryBlob({ [KEY]: v1Doc(), 'picks-dates': [DATE] });
  await storePicks(DATE, stripped, opts(strippedMain, strippedV1));
  const strippedDoc = strippedV1.data.get(KEY);
  assert.ok(!Object.prototype.hasOwnProperty.call(strippedDoc, 'shortCard'));
  assert.ok(!Object.prototype.hasOwnProperty.call(strippedDoc, 'edgeSummary'));
  assert.strictEqual(strippedDoc.sharpConfig.W, 1);
  assert.deepStrictEqual(strippedV1.data.get('picks-dates'), [DATE]);

  const freshMain = memoryBlob();
  const freshV1 = memoryBlob({ 'latest-date': '2026-11-01' });
  const freshCard = mainCard();
  await storePicks(DATE, freshCard, opts(freshMain, freshV1));
  const created = freshV1.data.get(KEY);
  assert.deepStrictEqual(created, freshCard);
  assert.notStrictEqual(created, freshCard);
  assert.deepStrictEqual(freshV1.data.get('picks-dates'), [DATE]);
  assert.strictEqual(freshV1.data.get('latest-date'), '2026-11-01');

  const errMain = memoryBlob();
  const errCard = mainCard({ picks: [{ pickId: 'new', pick: 'New', odds: -105, units: '0.25u' }] });
  const errV1 = memoryBlob({ [KEY]: v1Doc(), 'picks-dates': ['2026-11-14'], 'latest-date': '2026-11-16' });
  const before = JSON.parse(JSON.stringify(errV1.data.get(KEY)));
  errV1.setJSON = async (key) => {
    errV1.calls.push(['setJSON', key]);
    throw new Error('v1 set down');
  };
  const errWrote = await storePicks(DATE, errCard, opts(errMain, errV1));
  assert.strictEqual(errWrote, true);
  assert.deepStrictEqual(errMain.data.get(KEY).picks, errCard.picks);
  assert.strictEqual(errMain.calls.filter((c) => c[0] === 'setJSON' && c[1] === KEY).length, 1);
  assert.deepStrictEqual(errV1.data.get(KEY), before);
  assert.deepStrictEqual(errV1.data.get('picks-dates'), ['2026-11-14']);
  assert.strictEqual(errV1.data.get('latest-date'), '2026-11-16');

  const readFail = memoryBlob({ [KEY]: v1Doc() });
  const readBefore = JSON.parse(JSON.stringify(readFail.data.get(KEY)));
  readFail.getJSON = async (key) => {
    readFail.calls.push(['getJSON', key]);
    if (key === KEY) throw new Error('v1 read down');
    return null;
  };
  const readMain = memoryBlob();
  assert.strictEqual(await storePicks(DATE, mainCard(), opts(readMain, readFail)), true);
  assert.deepStrictEqual(readFail.data.get(KEY), readBefore);
  assert.ok(readMain.data.has(KEY));

  const datesDown = memoryBlob({ [KEY]: v1Doc() });
  const datesSet = datesDown.setJSON.bind(datesDown);
  datesDown.setJSON = async (key, val) => {
    if (key === 'picks-dates') throw new Error('dates down');
    return datesSet(key, val);
  };
  const datesMain = memoryBlob();
  const datesCard = mainCard();
  assert.strictEqual(await storePicks(DATE, datesCard, opts(datesMain, datesDown)), true);
  assert.deepStrictEqual(datesDown.data.get(KEY).picks, datesCard.picks);
  assert.deepStrictEqual(datesMain.data.get(KEY).picks, datesCard.picks);
  assert.ok(!datesDown.data.has('picks-dates'));

  for (const off of ['off', '', '0', 'false', '   ']) {
    const offMain = memoryBlob();
    const offV1 = bombStore();
    const offCard = mainCard();
    const offWrote = await storePicks(DATE, offCard, opts(offMain, offV1, { [FLAG]: off }));
    assert.strictEqual(offWrote, true, off);
    assert.deepStrictEqual(offMain.data.get(KEY).picks, offCard.picks);
    assert.strictEqual(offV1.calls.length, 0, off);
  }

  const shadowMain = memoryBlob();
  const shadowV1 = bombStore();
  const shadowCard = mainCard();
  assert.strictEqual(
    await storePicks(DATE, shadowCard, { force: true, shadow: true, stores: { main: shadowMain, v1: shadowV1 }, env: {} }),
    true
  );
  assert.ok(shadowMain.data.has(`omega-shadow/picks-${DATE}`));
  assert.ok(!shadowMain.data.has(KEY));
  assert.strictEqual(shadowV1.calls.length, 0);

  const marked = mainCard({ shadow: true });
  const markedMain = memoryBlob();
  const markedV1 = bombStore();
  await storePicks(DATE, marked, { force: true, stores: { main: markedMain, v1: markedV1 }, env: {} });
  assert.ok(markedMain.data.has(`omega-shadow/picks-${DATE}`));
  assert.strictEqual(markedV1.calls.length, 0);

  const simMain = memoryBlob();
  const simV1 = bombStore();
  await storePicks(DATE, mainCard(), { force: true, simMode: true, stores: { main: simMain, v1: simV1 }, env: {} });
  assert.ok(simMain.data.has(`picks-sim-${DATE}`));
  assert.ok(!simMain.data.has(KEY));
  assert.strictEqual(simV1.calls.length, 0);

  const replayMain = memoryBlob();
  const replayV1 = bombStore();
  assert.strictEqual(
    await storePicks(DATE, mainCard(), opts(replayMain, replayV1, { OMEGA_REPLAY_NO_WRITE: 'on' })),
    true
  );
  assert.ok(replayMain.data.has(KEY));
  assert.strictEqual(replayV1.calls.length, 0);

  const badV1 = bombStore();
  assert.deepStrictEqual(
    await sync.syncMainCardToV1('11/15', mainCard(), { env: {}, store: badV1 }),
    { synced: false, reason: 'bad-date' }
  );
  assert.deepStrictEqual(
    await sync.syncMainCardToV1(DATE, null, { env: {}, store: badV1 }),
    { synced: false, reason: 'bad-doc' }
  );
  assert.deepStrictEqual(
    await sync.syncMainCardToV1(DATE, [], { env: {}, store: badV1 }),
    { synced: false, reason: 'bad-doc' }
  );
  assert.strictEqual(badV1.calls.length, 0);

  const mainBoom = memoryBlob();
  mainBoom.setJSON = async () => { throw new Error('main down'); };
  const mainBoomV1 = bombStore();
  await assert.rejects(
    () => storePicks(DATE, mainCard(), opts(mainBoom, mainBoomV1)),
    /main down/
  );
  assert.strictEqual(mainBoomV1.calls.length, 0);

  const storeSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/store.js'), 'utf8');
  const fn = storeSrc.slice(
    storeSrc.indexOf('async function storePicks'),
    storeSrc.indexOf('async function storeShadowPicks')
  );
  const tryAt = fn.indexOf('let wroteSdk = false;');
  const catchAt = fn.indexOf('trying REST');
  const afterSdk = fn.indexOf('if (wroteSdk)');
  const restAt = fn.indexOf('blobFetch(pickKey');
  assert.ok(tryAt > 0 && catchAt > tryAt && afterSdk > catchAt && restAt > afterSdk);
  assert.ok(fn.indexOf('finishLiveV1Sync', tryAt) > afterSdk);

  const prevFetch = global.fetch;
  const prevToken = process.env.NETLIFY_AUTH_TOKEN;
  process.env.NETLIFY_AUTH_TOKEN = 'test-token';
  const hits = [];
  try {
    global.fetch = async (url, req) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('edge-picks-omega-v1ab')) throw new Error('v1 fetch');
      if (req && req.method === 'PUT' && u.includes('/edge-picks-omega/picks-')) {
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 404 };
    };
    const verify = require('./netlify/functions/verify-picks-omega');
    const recorded = [];
    const verifyCard = mainCard();
    const ok = await verify.updatePicksBlob(DATE, verifyCard, {
      syncMainCardToV1: async (d, doc) => {
        recorded.push({ d, picks: JSON.parse(JSON.stringify(doc.picks)), verifiedAt: doc.verifiedAt });
      },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].d, DATE);
    assert.deepStrictEqual(recorded[0].picks, verifyCard.picks);
    assert.ok(recorded[0].verifiedAt);
    assert.ok(hits.every((u) => !u.includes('edge-picks-omega-v1ab')));

    recorded.length = 0;
    global.fetch = async () => ({ ok: false, status: 500 });
    const failed = await verify.updatePicksBlob(DATE, mainCard(), {
      syncMainCardToV1: async () => { recorded.push('called'); },
    });
    assert.strictEqual(failed, false);
    assert.strictEqual(recorded.length, 0);

    global.fetch = async () => { throw new Error('network down'); };
    const thrown = await verify.updatePicksBlob(DATE, mainCard(), {
      syncMainCardToV1: async () => { recorded.push('called'); },
    });
    assert.strictEqual(thrown, false);
    assert.strictEqual(recorded.length, 0);

    global.fetch = async (url, req) => {
      hits.push(String(url));
      if (String(url).includes('v1ab')) throw new Error('v1 fetch');
      if (req && req.method === 'PUT') return { ok: true, status: 200 };
      return { ok: false, status: 404 };
    };
    const soft = await verify.updatePicksBlob(DATE, mainCard(), {
      syncMainCardToV1: async () => { throw new Error('sync boom'); },
    });
    assert.strictEqual(soft, true);

    const offStore = bombStore();
    hits.length = 0;
    const offOk = await verify.updatePicksBlob(DATE, mainCard(), {
      env: { [FLAG]: 'off' },
      store: offStore,
    });
    assert.strictEqual(offOk, true);
    assert.strictEqual(offStore.calls.length, 0);
    assert.ok(hits.every((u) => !u.includes('v1ab')));

    const liveV1 = memoryBlob({
      [KEY]: v1Doc(),
      'picks-dates': ['2026-11-14'],
      'latest-date': '2026-11-16',
    });
    const liveCard = mainCard();
    const liveOk = await verify.updatePicksBlob(DATE, liveCard, { env: {}, store: liveV1 });
    assert.strictEqual(liveOk, true);
    const liveDoc = liveV1.data.get(KEY);
    assert.deepStrictEqual(liveDoc.picks, liveCard.picks);
    assert.deepStrictEqual(liveDoc.parlayLegs, liveCard.parlayLegs);
    assert.deepStrictEqual(liveDoc.summary, liveCard.summary);
    assert.strictEqual(liveDoc.shortCard, null);
    assert.deepStrictEqual(liveDoc.edgeSummary, liveCard.edgeSummary);
    assert.deepStrictEqual(liveDoc.meta, liveCard.meta);
    assert.strictEqual(liveDoc.verifiedAt, 'old-stamp');
    assert.strictEqual(liveDoc.sharpConfig.W, 1);
    assert.strictEqual(liveDoc.model, 'v1ab-old');
    assert.deepStrictEqual(liveV1.data.get('picks-dates'), ['2026-11-14', DATE]);
    assert.strictEqual(liveV1.data.get('latest-date'), '2026-11-16');
    assert.strictEqual(liveCard.odds || liveCard.picks[0].odds, -110);

    delete process.env.NETLIFY_AUTH_TOKEN;
    recorded.length = 0;
    const noToken = await verify.updatePicksBlob(DATE, mainCard(), {
      syncMainCardToV1: async () => { recorded.push('called'); },
    });
    assert.strictEqual(noToken, false);
    assert.strictEqual(recorded.length, 0);
  } finally {
    global.fetch = prevFetch;
    if (prevToken == null) delete process.env.NETLIFY_AUTH_TOKEN;
    else process.env.NETLIFY_AUTH_TOKEN = prevToken;
    if (savedFlag == null) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  }

  console.log('PASS v1 sync main');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
