'use strict';
// Night P2s: posted-total name, NHL health copy, legacy capture-health read.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const env = require(path.join(root, 'sports/mlb_env'));
const { buildHealthRecord } = require(path.join(root, 'health'));
const healthFn = require(path.join(__dirname, 'netlify/functions/get-omega-capture-health'));
const config = require(path.join(root, 'config'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.16-omega-vnext-ncaaf-oa-wx');
assert.ok(String(config.MODEL_NOTES).includes('v12.3.16-omega-vnext-ncaaf-oa-wx'));
assert.strictEqual(env.sharpPostedTotal, env.sharpNoVigTotal);

const both = {
  bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'totals', outcomes: [{ name: 'Over', point: 8, price: -110 }, { name: 'Under', point: 8, price: -110 }] }] },
    { key: 'circa', markets: [{ key: 'totals', outcomes: [{ name: 'Over', point: 9, price: -105 }, { name: 'Under', point: 9, price: -115 }] }] },
  ],
};
assert.strictEqual(env.sharpPostedTotal(both), 8.5);
assert.strictEqual(env.sharpNoVigTotal(both), 8.5);

function snap(standings, events) {
  const ev = events || [{ home_team: 'Boston Bruins', away_team: 'Buffalo Sabres', commence_time: '2026-10-10T23:00:00Z' }];
  return {
    oddsBySport: { NHL: ev, MLB: [], NFL: [], NCAAF: [], NBA: [] },
    standingsBySport: { NHL: standings },
    espnBySport: { NHL: { games: [] } },
  };
}

const missingGoals = buildHealthRecord({
  snap: snap({
    'Boston Bruins': { pf: 3.2, pa: 2.9, games: 20, wins: 10, losses: 8, otLosses: 2 },
    'Buffalo Sabres': { pf: 2.8, pa: 3.1, games: 20, wins: 9, losses: 9, otLosses: 2 },
  }),
});
const goalAlerts = missingGoals.alerts.filter((a) => a.sport === 'NHL' && String(a.code).startsWith('schema_missing:goals'));
assert.ok(goalAlerts.length >= 2);
assert.ok(goalAlerts.every((a) => String(a.detail).includes('snap lacks goal columns')));

const empty = buildHealthRecord({ snap: snap({}) });
const base = empty.alerts.find((a) => a.sport === 'NHL' && a.code === 'baseline_teams');
assert.ok(base, 'empty NHL snap still raises baseline_teams');
assert.ok(String(base.detail).includes('not a live 6.2 claim'), base.detail);

const withGoals = buildHealthRecord({
  snap: snap({
    'Boston Bruins': { pf: 3.1, pa: 2.9, games: 1, wins: 1, losses: 0, otLosses: 0, nhlSeasonGoals: true, goalsFor: 3.1, goalsAgainst: 2.9 },
    'Buffalo Sabres': { pf: 2.8, pa: 3.0, games: 20, wins: 10, losses: 8, otLosses: 2, nhlSeasonGoals: true, goalsFor: 2.8, goalsAgainst: 3.0 },
  }),
});
assert.ok(!withGoals.alerts.some((a) => a.sport === 'NHL' && String(a.code).startsWith('schema_missing:goals')));
const realBase = withGoals.alerts.find((a) => a.sport === 'NHL' && a.code === 'baseline_teams');
if (realBase) {
  assert.ok(!String(realBase.detail).includes('snap lacks goal columns'), realBase.detail);
}

(async () => {
  const now = new Date('2026-10-09T23:35:00Z');
  const store = {
    'clv-candidates-2026-10-09': { candidates: [{ a: 1 }, { a: 2 }] },
    'clv-candidates-2026-10-08': null,
  };
  assert.ok(healthFn.handler.length <= 2);
  const res = await healthFn.handleCaptureHealth({ httpMethod: 'GET', queryStringParameters: {} }, {}, {
    now,
    readCaptureHealthLatest: async () => ({ ok: true }),
    readJson: async () => null,
    readWithFallback: async (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
  });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.legacyCandidates.today.date, '2026-10-09');
  assert.strictEqual(body.legacyCandidates.today.key, 'clv-candidates-2026-10-09');
  assert.strictEqual(body.legacyCandidates.today.exists, true);
  assert.strictEqual(body.legacyCandidates.today.rows, 2);
  assert.strictEqual(body.legacyCandidates.yesterday.date, '2026-10-08');
  assert.strictEqual(body.legacyCandidates.yesterday.exists, false);
  assert.strictEqual(body.legacyCandidates.yesterday.rows, 0);

  console.log('PASS test-omega-night-p2');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
