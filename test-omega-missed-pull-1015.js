'use strict';
// 3:15 ET missed 3:00 pull. Reads only. No Odds API.
const assert = require('assert');
const fn = require('./netlify/functions/monitor-omega-missed-pull');
const store = require('./netlify/functions/lib/omega-vnext/store');
const moves = require('./netlify/functions/lib/omega-vnext/pinnacle_line_move');
const health = require('./netlify/functions/get-omega-capture-health');

const DATE = '2026-10-15';
const WHEN = new Date('2026-10-15T07:15:00Z');

function scheduler(iso) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: iso || WHEN.toISOString() }),
  };
}

function marker(ok, extra) {
  return Object.assign({
    schema: moves.CAPTURE_DONE_SCHEMA,
    date: DATE,
    slot: '0300',
    completedAt: '2026-10-15T07:04:00.000Z',
    ok,
    gameCount: ok ? 4 : 1,
    sports: ok ? ['NFL:4'] : ['NFL:err', 'NHL:2'],
    pulls: 2,
    closesStored: 1,
  }, extra || {});
}

async function run(deps, event) {
  const writes = [];
  const posts = [];
  const alerts = [];
  const prev = console.error;
  console.error = (line) => { alerts.push(String(line)); };
  let res;
  try {
    res = await fn.handleMissedPull(event || scheduler(), {}, Object.assign({
      now: WHEN,
      env: { OMEGA_REPLAY_NO_WRITE: '0' },
      webhookUrl: 'https://ops.example/hook',
      sportsForCard: () => ['NFL', 'NHL'],
      readPinnacleLineMoves: async () => null,
      writeJson: async (key, data) => { writes.push({ key, data }); },
      postWebhook: async (url, report) => { posts.push({ url, report }); return { ok: true }; },
    }, deps));
  } finally {
    console.error = prev;
  }
  return { res, body: JSON.parse(res.body), writes, posts, alerts };
}

(async () => {
  assert.strictEqual(fn.handler.length, 2);
  assert.strictEqual(fn.missedPullKey(DATE), `omega-ops/missed-pull-${DATE}`);
  assert.doesNotThrow(() => store.assertOpsKey(`omega-ops/missed-pull-${DATE}`));
  assert.throws(() => store.assertOpsKey('omega-ops/missed-pull'), /refused/);
  assert.doesNotThrow(() => store.assertOpsKey('omega-ops/snapshot-coverage-2026-10-15'));

  // etGuard uses the injected clock, not next_run. 08:15Z is 04:15 EDT.
  const skip = await run({ now: new Date('2026-10-15T08:15:00Z') }, scheduler('2026-10-15T08:15:00Z'));
  assert.strictEqual(skip.body.skipped, 'et-guard');
  assert.strictEqual(skip.writes.length, 0);
  assert.strictEqual(skip.posts.length, 0);

  const ok = await run({ read: async () => marker(true) });
  assert.strictEqual(ok.body.ok, true);
  assert.strictEqual(ok.body.report.code, 'ok');
  assert.strictEqual(ok.body.report.severity, 'ok');
  assert.strictEqual(ok.writes.length, 1);
  assert.strictEqual(ok.writes[0].key, `omega-ops/missed-pull-${DATE}`);
  assert.strictEqual(ok.writes[0].data.code, 'ok');
  assert.strictEqual(ok.posts.length, 0);
  assert.ok(!ok.alerts.some((line) => line.includes('ALERT')));

  const present = await run({
    read: async () => null,
    readPinnacleLineMoves: async () => ({
      events: [{ sport: 'NFL', eventId: 'e1', checks: [{ slot: '0300', at: '2026-10-15T07:00:00Z' }] }],
    }),
  });
  assert.strictEqual(present.body.report.severity, 'warn');
  assert.strictEqual(present.body.report.code, 'marker-missing-data-present');
  assert.strictEqual(present.posts.length, 1);
  assert.strictEqual(present.posts[0].url, 'https://ops.example/hook');
  assert.strictEqual(present.posts[0].report.code, 'marker-missing-data-present');
  assert.ok(present.alerts.some((line) => line.includes('marker-missing-data-present')));

  const quiet = await run({
    read: async () => null,
    readPinnacleLineMoves: async () => ({ events: [] }),
    sportsForCard: () => [],
  });
  assert.strictEqual(quiet.body.report.code, 'no-slate');
  assert.strictEqual(quiet.body.report.severity, 'ok');
  assert.strictEqual(quiet.posts.length, 0);
  assert.ok(!quiet.alerts.some((line) => line.includes('missed-0300-pull')));
  assert.strictEqual(quiet.writes[0].data.code, 'no-slate');

  const missed = await run({
    read: async () => null,
    readPinnacleLineMoves: async () => ({
      events: [{ sport: 'NFL', eventId: 'e1', checks: [{ slot: '1000' }] }],
    }),
    sportsForCard: () => ['NFL'],
  });
  assert.strictEqual(missed.body.ok, false);
  assert.strictEqual(missed.body.report.code, 'missed-0300-pull');
  assert.strictEqual(missed.body.report.severity, 'alert');
  assert.deepStrictEqual(missed.body.report.sports, ['NFL']);
  assert.strictEqual(missed.posts.length, 1);
  assert.ok(missed.alerts.some((line) => line.includes('missed-0300-pull') && line.includes('NFL')));

  const partial = await run({ read: async () => marker(false) });
  assert.strictEqual(partial.body.report.code, 'partial-0300-pull');
  assert.strictEqual(partial.body.report.severity, 'alert');
  assert.ok(partial.body.report.sports.indexOf('NFL:err') !== -1);
  assert.ok(partial.alerts.some((line) => line.includes('partial-0300-pull') && line.includes('NFL:err')));
  assert.strictEqual(partial.posts.length, 1);

  const soft = await run({
    read: async () => null,
    sportsForCard: () => ['NHL'],
    postWebhook: async () => { throw new Error('hook down'); },
  });
  assert.strictEqual(soft.res.statusCode, 200);
  assert.strictEqual(soft.body.report.code, 'missed-0300-pull');
  assert.strictEqual(soft.writes.length, 1);

  const badStatus = await run({
    read: async () => null,
    sportsForCard: () => ['NHL'],
    postWebhook: async () => ({ ok: false, status: 502 }),
  });
  assert.strictEqual(badStatus.res.statusCode, 200);
  assert.strictEqual(badStatus.body.report.code, 'missed-0300-pull');

  const dry = await run({
    dryRun: true,
    read: async () => null,
    sportsForCard: () => ['NFL'],
    writeJson: async () => { throw new Error('dry wrote'); },
    postWebhook: async () => { throw new Error('dry posted'); },
  });
  assert.strictEqual(dry.body.report.code, 'missed-0300-pull');
  assert.strictEqual(dry.writes.length, 0);

  const noWrite = await run({
    env: { OMEGA_REPLAY_NO_WRITE: '1' },
    read: async () => marker(false),
    writeJson: async () => { throw new Error('replay wrote'); },
    postWebhook: async () => { throw new Error('replay posted'); },
  });
  assert.strictEqual(noWrite.body.report.code, 'partial-0300-pull');
  assert.strictEqual(noWrite.writes.length, 0);
  assert.strictEqual(noWrite.posts.length, 0);

  const qsDry = await fn.handleMissedPull(
    Object.assign(scheduler(), { queryStringParameters: { dryRun: '1' } }),
    {},
    {
      now: WHEN,
      webhookUrl: 'https://ops.example/hook',
      read: async () => null,
      sportsForCard: () => ['NFL'],
      readPinnacleLineMoves: async () => null,
      writeJson: async () => { throw new Error('qs dry wrote'); },
      postWebhook: async () => { throw new Error('qs dry posted'); },
    },
  );
  assert.strictEqual(JSON.parse(qsDry.body).report.code, 'missed-0300-pull');

  const healthRes = await health.handleCaptureHealth({ httpMethod: 'GET', queryStringParameters: {} }, {}, {
    now: WHEN,
    readCaptureHealthLatest: async () => ({ ok: true }),
    readJson: async (key) => (key === `omega-ops/missed-pull-${DATE}` ? { code: 'ok', date: DATE } : null),
    readWithFallback: async () => null,
  });
  const healthBody = JSON.parse(healthRes.body);
  assert.strictEqual(healthBody.ok, true);
  assert.strictEqual(healthBody.missedPull.code, 'ok');

  console.log('PASS test-omega-missed-pull-1015');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
