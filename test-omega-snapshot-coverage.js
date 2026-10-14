'use strict';

const assert = require('assert');
const cov = require('./netlify/functions/lib/omega-vnext/snapshot_coverage');
const fn = require('./netlify/functions/monitor-omega-snapshot-coverage');

const oct10 = cov.morningWindowCoverage([
  { snapshot_ts: '2026-10-10T10:00:00Z', sport: 'NCAAF', game_id: 'g', line_type: 'snapshot' },
], '2026-10-10');
assert.strictEqual(oct10.at0600, 1);
assert.strictEqual(oct10.at0300, 0);
assert.strictEqual(oct10.at1000, 0);
assert.strictEqual(oct10.missing0300, true);
assert.strictEqual(oct10.missing1000, true);

const both = cov.morningWindowCoverage([
  { snapshot_ts: '2026-10-10T07:00:00Z', sport: 'NHL', game_id: 'a', line_type: 'snapshot' },
  { snapshot_ts: '2026-10-10T14:00:00Z', sport: 'NHL', game_id: 'a', line_type: 'snapshot' },
], '2026-10-10');
assert.strictEqual(both.at0300, 1);
assert.strictEqual(both.at1000, 1);
assert.strictEqual(both.missing0300, false);
assert.strictEqual(both.missing1000, false);

const partial = cov.assessSnapshotCoverage('2026-10-10', [
  { sport: 'NCAAF', eventId: '1', checks: [{ slot: '1000' }] },
], {});
assert.strictEqual(partial.ok, false);
assert.strictEqual(partial.missing0300, 1);
assert.strictEqual(partial.missing1000, 0);

const full = cov.assessSnapshotCoverage('2026-10-14', [
  { sport: 'NFL', eventId: '1', checks: [{ slot: '0300' }, { slot: '1000' }] },
], { masterGames: 1 });
assert.strictEqual(full.ok, true);
assert.strictEqual(full.indexShort, false);

const short = cov.assessSnapshotCoverage('2026-10-14', [
  { sport: 'NFL', eventId: '1', checks: [{ slot: '0300' }, { slot: '1000' }] },
], { masterGames: 4 });
assert.strictEqual(short.ok, false);
assert.strictEqual(short.indexShort, true);

function scheduler(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify(body || { next_run: '2099-01-01T00:00:00Z' }),
  };
}

(async () => {
  const skipped = await fn.handleSnapshotCoverage(scheduler(), {}, {
    now: new Date('2026-10-14T14:00:00Z'),
    dryRun: true,
  });
  const skipBody = JSON.parse(skipped.body);
  assert.strictEqual(skipBody.skipped, 'et-guard');

  const ran = await fn.handleSnapshotCoverage(scheduler(), {}, {
    now: new Date('2026-10-14T14:20:00Z'),
    dryRun: true,
    readPinnacleLineMoves: async () => ({
      events: [{ sport: 'NFL', eventId: '1', checks: [{ slot: '0300' }, { slot: '1000' }] }],
    }),
    readMasterKey: async (key) => {
      assert.strictEqual(key, 'by-date/2026-10-14');
      return { events: [{ eventId: '1' }] };
    },
  });
  const okBody = JSON.parse(ran.body);
  assert.strictEqual(okBody.ok, true);
  assert.strictEqual(okBody.report.games, 1);

  const empty = await fn.handleSnapshotCoverage(scheduler(), {}, {
    now: new Date('2026-10-10T14:20:00Z'),
    dryRun: true,
    snapshotRows: [
      { snapshot_ts: '2026-10-10T10:00:00Z', sport: 'NCAAF', game_id: 'g', line_type: 'snapshot' },
    ],
    readPinnacleLineMoves: async () => ({ events: [] }),
    readMasterKey: async () => ({ events: [] }),
  });
  const emptyBody = JSON.parse(empty.body);
  assert.strictEqual(emptyBody.ok, false);
  assert.strictEqual(emptyBody.report.games, 0);
  assert.strictEqual(emptyBody.report.windows.missing0300, true);
  assert.strictEqual(emptyBody.report.windows.at0600, 1);
  assert.strictEqual(fn.handler.length, 2);

  console.log('PASS test-omega-snapshot-coverage');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
