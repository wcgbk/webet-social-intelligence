'use strict';

/**
 * Daily progress table. Fixture rows only. No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tracking = require('./netlify/functions/lib/tracking-report');
const ledger = require('./netlify/functions/lib/clv-ledger');
const job = require('./netlify/functions/report-tracking-omega');
const reader = require('./netlify/functions/get-tracking');
const et = require('./netlify/functions/lib/et-schedule');
const { aggregateDays } = require('./netlify/functions/get-results-omega')._test;

const root = __dirname;

assert.strictEqual(job.handler.length <= 2, true);
assert.strictEqual(reader.handler.length <= 2, true);

const jobSrc = fs.readFileSync(path.join(root, 'netlify/functions/report-tracking-omega.js'), 'utf8');
const readerSrc = fs.readFileSync(path.join(root, 'netlify/functions/get-tracking.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(root, 'netlify/functions/lib/tracking-report.js'), 'utf8');
const resultsSrc = fs.readFileSync(path.join(root, 'netlify/functions/get-results-omega.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'tracking/index.html'), 'utf8');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const redirects = fs.readFileSync(path.join(root, '_redirects'), 'utf8');

assert.ok(!/selectStraights|calibrateAll|generateOmega|leanFill|force-fill|storePicks/.test(jobSrc));
assert.ok(!/selectStraights|leanFill|force-fill|storePicks/.test(libSrc));
assert.ok(jobSrc.includes("require('./get-results-omega')"));
assert.ok(jobSrc.includes("require('./lib/kpi-cache')"));
assert.ok(libSrc.includes('kpiSidesFromDays'));
assert.ok(resultsSrc.includes(`const RESULTS_CACHE_KEY = '${tracking.RESULTS_CACHE_KEY}'`));
assert.ok(resultsSrc.includes('const dollarPerUnit = 150'));
assert.ok(jobSrc.includes('tracking.RESULTS_CACHE_KEY'));
assert.ok(!/NETLIFY_AUTH_TOKEN|Authorization|api\.netlify\.com/.test(readerSrc));
assert.ok(page.includes("fetch('/api/get-tracking'"));
assert.ok(page.includes("fetch('/tracking/report.json'"));
assert.ok(page.includes('src="/nav.js"'));
assert.ok(page.includes('class="day-row"'));
assert.ok(page.includes('Engineering'));
assert.ok(page.includes('Track record'));
assert.ok(page.includes('Closing line'));
assert.ok(page.includes('Edge (all-time)'));
assert.ok(page.includes('Current version'));
assert.ok(page.includes('All evaluated bets'));
assert.ok(page.includes('STALE'));
assert.ok(page.includes('Omega'));
assert.ok(page.includes('−2pp or lower is the 20th'));
assert.ok(page.includes('+3pp or higher is the 95th'));
assert.ok(page.includes('Values between those points are linear'));
assert.deepStrictEqual(et.ET_SCHEDULE['report-tracking-omega'].etTimes, ['09:15']);
assert.ok(/\[functions\."report-tracking-omega"\][\s\S]*?schedule = "15 13,14 \* \* \*"/.test(toml));
assert.ok(redirects.includes('/tracking'));
assert.ok(redirects.includes('/api/get-tracking'));
assert.strictEqual(tracking.DOLLAR_PER_UNIT, 150);

assert.deepStrictEqual(
  tracking.CLV_PERCENTILE_ANCHORS.map((item) => [item.avgClvPp, item.percentile]),
  [[-2, 20], [-1, 35], [0, 50], [1, 75], [2, 85], [3, 95]],
);

assert.strictEqual(tracking.clvPercentile(-3), 20);
assert.strictEqual(tracking.clvPercentile(-2), 20);
assert.strictEqual(tracking.clvPercentile(-1.5), 27.5);
assert.strictEqual(tracking.clvPercentile(-1), 35);
assert.strictEqual(tracking.clvPercentile(-0.5), 42.5);
assert.strictEqual(tracking.clvPercentile(0), 50);
assert.strictEqual(tracking.clvPercentile(0.18), 54.5);
assert.strictEqual(tracking.clvPercentile(0.17), 54.3);
assert.strictEqual(tracking.clvPercentile(1), 75);
assert.strictEqual(tracking.clvPercentile(1.5), 80);
assert.strictEqual(tracking.clvPercentile(2), 85);
assert.strictEqual(tracking.clvPercentile(2.5), 90);
assert.strictEqual(tracking.clvPercentile(3), 95);
assert.strictEqual(tracking.clvPercentile(4), 95);
assert.strictEqual(tracking.clvPercentile(null), null);

const history = [
  {
    date: '2026-10-05',
    edge: { processes: 89, architecture: 88, math: 85, overall: 85 },
    omega: { processes: 89, architecture: 88, math: 85, overall: 85 },
  },
  {
    date: '2026-10-12',
    edge: { processes: 87, architecture: 86, math: 86, overall: 86 },
  },
];
const carried = tracking.carryEngineering(history, '2026-10-11', 'edge');
assert.strictEqual(carried.processes, 89);
assert.strictEqual(carried.scoredOn, '2026-10-05');
assert.strictEqual(carried.carriedForward, true);
const todayOmega = tracking.carryEngineering(history, '2026-10-12', 'omega');
assert.strictEqual(todayOmega.overall, 85);
assert.strictEqual(todayOmega.scoredOn, '2026-10-05');
assert.strictEqual(todayOmega.carriedForward, true);
const todayEdge = tracking.carryEngineering(history, '2026-10-12', 'edge');
assert.strictEqual(todayEdge.processes, 87);
assert.strictEqual(todayEdge.carriedForward, false);
assert.strictEqual(tracking.carryEngineering(history, '2026-10-04', 'edge').processes, null);

function dayRow(wins, losses, pushes, profit) {
  return {
    date: '2026-10-01',
    wins,
    losses,
    pushes,
    pending: 0,
    wagered: 300,
    profit,
    picks: [
      { sport: 'MLB', result: 'win', units: '1', profit: 100 },
      { sport: 'MLB', result: 'loss', units: '1', profit: -150 },
      { sport: 'MLB', result: 'push', units: '1', profit: 0 },
    ],
    parlayResult: 'loss',
    parlayProfit: -75,
    parlayRisk: 75,
  };
}

{
  const day = dayRow(1, 1, 1, 50);
  const agg = aggregateDays([day]);
  const sides = tracking.kpiSidesFromDays([day], [day], aggregateDays);
  assert.strictEqual(sides.edge.wins, agg.straight.wins);
  assert.strictEqual(sides.edge.losses, agg.straight.losses);
  assert.strictEqual(sides.edge.pushes, agg.cumulative.pushes);
  assert.strictEqual(sides.edge.record, '1-1-1');
  assert.strictEqual(sides.edge.accuracy, agg.straight.accuracy);
  assert.strictEqual(sides.edge.roi, agg.cumulative.roi);
  assert.strictEqual(sides.edge.profitDollars, agg.cumulative.totalProfit);
  assert.strictEqual(sides.edge.profitUnits, tracking.kpiFromAggregate(agg).profitUnits);
  assert.strictEqual(sides.edge.profitUnits, 0.33);
  assert.strictEqual(sides.omega.record, sides.edge.record);
}

function resultsFixture(edgeProfit, omegaProfit) {
  return {
    cumulative: {
      wins: 2, losses: 1, pushes: 1, pending: 0,
      accuracy: '66.7%', roi: '10.0%', totalWagered: 450, totalProfit: edgeProfit,
    },
    straight: { wins: 2, losses: 1, accuracy: '66.7%', totalWagered: 300, totalProfit: edgeProfit },
    omegaOnly: {
      cumulative: {
        wins: 1, losses: 0, pushes: 0, pending: 0,
        accuracy: '100%', roi: '5.0%', totalWagered: 150, totalProfit: omegaProfit,
      },
      straight: { wins: 1, losses: 0, accuracy: '100.0%', totalWagered: 150, totalProfit: omegaProfit },
    },
  };
}

function clvFixture(edgeAvg, omegaAvg) {
  return {
    totals: {
      overall: { n: 10, avgClvPp: edgeAvg, beatClosePct: 40, smallSample: true },
      byModel: {
        Omega: { n: 4, avgClvPp: omegaAvg, beatClosePct: 50, smallSample: true },
      },
    },
  };
}

const scoreFile = {
  entries: [
    {
      date: '2026-10-01',
      edge: { processes: 80, architecture: 80, math: 80, overall: 80 },
      omega: { processes: 70, architecture: 70, math: 70, overall: 70 },
    },
    {
      date: '2026-10-12',
      edge: { processes: 87, architecture: 86, math: 86, overall: 86 },
      omega: { processes: 87, architecture: 86, math: 86, overall: 86 },
    },
  ],
};

{
  const first = tracking.buildDayRow({
    date: '2026-10-11',
    entries: scoreFile.entries,
    results: resultsFixture(100, 0),
    clvReport: clvFixture(0, 1),
  });
  assert.strictEqual(first.edge.engineering.processes, 80);
  assert.strictEqual(first.edge.engineering.carriedForward, true);
  assert.strictEqual(first.edge.clv.percentile, 50);
  assert.strictEqual(first.omega.clv.percentile, 75);
  const second = tracking.buildDayRow({
    date: '2026-10-12',
    entries: scoreFile.entries,
    results: resultsFixture(250, 150),
    clvReport: clvFixture(1, 2),
  });
  const index = tracking.buildIndex({
    row: second,
    previousRows: [first],
    generatedAt: '2026-10-12T13:15:00.000Z',
    updatedAtEt: 'Oct 12, 2026, 9:15 AM ET',
  });
  assert.strictEqual(index.rows.length, 2);
  assert.strictEqual(index.rows[0].delta.from, null);
  assert.strictEqual(index.rows[0].delta.edge.kpi.wins, null);
  const delta = index.rows[1].delta;
  assert.strictEqual(delta.from, '2026-10-11');
  assert.strictEqual(delta.edge.engineering.processes, 7);
  assert.strictEqual(delta.omega.engineering.processes, 17);
  assert.strictEqual(delta.edge.kpi.profitDollars, 150);
  assert.strictEqual(delta.edge.kpi.profitUnits, 1);
  assert.strictEqual(delta.omega.kpi.profitDollars, 150);
  assert.strictEqual(delta.edge.clv.avgClvPp, 1);
  assert.strictEqual(delta.edge.clv.percentile, 25);
  assert.strictEqual(delta.omega.clv.percentile, 10);
  const again = tracking.buildIndex({
    row: second,
    previousRows: index.rows,
    generatedAt: index.generatedAt,
    updatedAtEt: index.updatedAtEt,
  });
  assert.strictEqual(again.rows.length, 2);
  assert.strictEqual(again.rows[1].date, '2026-10-12');
}

{
  const scores = require('./data/engineering-scores.json');
  const clvSeed = require('./data/clv-ledger-seed.json');
  const kpi = require('./data/tracking-kpi-seed.json');
  const snapshot = require('./tracking/report.json');
  assert.strictEqual(scores.schema, 'engineering-scores-v1');
  assert.strictEqual(scores.entries.length, 1);
  assert.strictEqual(scores.entries[0].date, '2026-10-12');
  assert.deepStrictEqual(scores.entries[0].edge, {
    processes: 87, architecture: 86, math: 86, overall: 86,
  });
  assert.deepStrictEqual(scores.entries[0].omega, scores.entries[0].edge);
  const clvReport = ledger.buildReport({
    rows: clvSeed.rows,
    asOf: '2026-10-12',
    generatedAt: snapshot.generatedAt,
    source: 'seed',
  });
  const rebuilt = tracking.buildIndex({
    date: '2026-10-12',
    entries: scores.entries,
    results: kpi,
    clvReport,
    clvRows: clvSeed.rows,
    liveVersion: 'v12.3.38-omega-vnext-price-lock',
    generatedAt: snapshot.generatedAt,
    updatedAtEt: snapshot.updatedAtEt,
  });
  rebuilt.source = 'seed';
  assert.deepStrictEqual(rebuilt, snapshot);
  const row = snapshot.rows[0];
  assert.strictEqual(snapshot.rows.length, 1);
  assert.strictEqual(row.date, '2026-10-12');
  assert.strictEqual(row.delta.from, null);
  assert.strictEqual(row.edge.kpi.record, '289-247-18');
  assert.strictEqual(row.edge.kpi.accuracy, '53.9%');
  assert.strictEqual(row.edge.kpi.roi, '15.3%');
  assert.strictEqual(row.edge.kpi.profitDollars, 12624);
  assert.strictEqual(row.edge.kpi.profitUnits, 84.16);
  assert.strictEqual(row.omega.kpi.record, '27-23-0');
  assert.strictEqual(row.omega.kpi.accuracy, '54.0%');
  assert.strictEqual(row.omega.kpi.roi, '3.1%');
  assert.strictEqual(row.omega.kpi.profitDollars, 304);
  assert.strictEqual(row.omega.kpi.profitUnits, 2.03);
  // Headline: published straights. Edge = Alpha <= 9/21 + Omega >= 9/22.
  assert.strictEqual(row.edge.clv.basis, 'published-straights');
  assert.strictEqual(row.edge.clv.n, 293);
  assert.strictEqual(row.edge.clv.avgClvPp, 0.24);
  assert.strictEqual(row.edge.clv.beatClosePct, 44.7);
  assert.strictEqual(row.edge.clv.percentile, 56);
  assert.strictEqual(row.omega.clv.n, 47);
  assert.strictEqual(row.omega.clv.avgClvPp, 0.54);
  assert.strictEqual(row.omega.clv.beatClosePct, 48.9);
  assert.strictEqual(row.omega.clv.percentile, 63.5);
  assert.strictEqual(row.omega.clv.parlay.available, false);
  // Secondary: every evaluated bet (ledger totals).
  assert.strictEqual(row.edge.clvAll.avgClvPp, 0.18);
  assert.strictEqual(row.edge.clvAll.beatClosePct, 44.2);
  assert.strictEqual(row.edge.clvAll.percentile, 54.5);
  assert.strictEqual(row.omega.clvAll.avgClvPp, 0.17);
  assert.strictEqual(row.omega.clvAll.percentile, 54.3);
  assert.strictEqual(row.version.live, 'v12.3.38-omega-vnext-price-lock');
  assert.strictEqual(row.edge.engineering.stale, false);
  assert.strictEqual(snapshot.dollarPerUnit, 150);
  assert.strictEqual(snapshot.displayOnly, true);
  assert.strictEqual(snapshot.applied, false);
}

// v12.4.0 tracking: whole numbers, versions, stale engineering, current-version totals.
{
  assert.strictEqual(tracking.wholeAway(15.2), 16);
  assert.strictEqual(tracking.wholeAway(-0.98), -1);
  assert.strictEqual(tracking.wholeAway(-1.2), -2);
  assert.strictEqual(tracking.wholeAway(0), 0);
  assert.strictEqual(tracking.wholeAway(3), 3);
  assert.strictEqual(tracking.wholeAway(null), null);

  const v1 = tracking.resolveVersion([], '2026-10-14', 'v12.4.0-webetai-pure');
  assert.deepStrictEqual(v1, { live: 'v12.4.0-webetai-pure', since: '2026-10-14', previous: null, changed: false });
  const prior = [{ date: '2026-10-13', version: { live: 'v12.3.69-x', since: '2026-10-13' } }];
  const v2 = tracking.resolveVersion(prior, '2026-10-14', 'v12.4.0-webetai-pure');
  assert.strictEqual(v2.changed, true);
  assert.strictEqual(v2.previous, 'v12.3.69-x');
  const v3 = tracking.resolveVersion([{ date: '2026-10-14', version: v1 }], '2026-10-15', 'v12.4.0-webetai-pure');
  assert.strictEqual(v3.since, '2026-10-14');
  assert.strictEqual(v3.changed, false);
  const v4 = tracking.resolveVersion([], '2026-10-20', 'v12.9.9-new');
  assert.strictEqual(v4.since, '2026-10-20');

  const rows = [
    { source: 'alpha', kind: 'pick', date: '2026-09-21', clvPp: 1, beatClose: true },
    { source: 'alpha', kind: 'pick', date: '2026-10-01', clvPp: 9, beatClose: true },
    { source: 'omega', kind: 'pick', date: '2026-09-10', clvPp: 9, beatClose: true },
    { source: 'omega', kind: 'pick', date: '2026-09-22', clvPp: -1, beatClose: false },
    { source: 'omega', kind: 'candidate', date: '2026-09-23', clvPp: 9, beatClose: true },
    { source: 'omega', kind: 'pick', date: '2026-10-14', clvPp: 2, beatClose: true },
    { source: 'omega', kind: 'pick', date: '2026-10-15', clvPp: 5, beatClose: true },
  ];
  const pub = tracking.clvPublishedFromRows(rows, { asOf: '2026-10-14', versionSince: '2026-10-14' });
  assert.strictEqual(pub.edge.n, 3);
  assert.strictEqual(pub.edge.avgClvPp, 0.67);
  assert.strictEqual(pub.omega.n, 2);
  assert.strictEqual(pub.omega.avgClvPp, 0.5);
  assert.strictEqual(pub.omega.beatClosePct, 50);
  assert.strictEqual(pub.current.n, 1);
  assert.strictEqual(pub.current.avgClvPp, 2);
  assert.strictEqual(pub.current.percentile, 85);
  assert.strictEqual(pub.edge.parlay.available, false);

  const eng = tracking.carryEngineering([{ date: '2026-10-12', edge: { processes: 1, architecture: 1, math: 1, overall: 1 } }], '2026-10-14', 'edge', '2026-10-14');
  assert.strictEqual(eng.scoredOn, '2026-10-12');
  assert.strictEqual(eng.stale, true);
  const fresh = tracking.carryEngineering([{ date: '2026-10-14', edge: { processes: 1, architecture: 1, math: 1, overall: 1 } }], '2026-10-14', 'edge', '2026-10-14');
  assert.strictEqual(fresh.stale, false);

  const fakeAgg = (list) => ({
    cumulative: { wins: list.length, losses: 0, pushes: 0, pending: 0, roi: '10.0%', totalProfit: 15 * list.length },
    straight: { wins: list.length, losses: 0, accuracy: '100.0%' },
  });
  const days = [{ date: '2026-10-13', source: 'omega' }, { date: '2026-10-14', source: 'omega' }, { date: '2026-10-15', source: 'omega' }];
  const cur = tracking.currentKpi(days, '2026-10-14', '2026-10-16', fakeAgg);
  assert.strictEqual(cur.wins, 2);
  const sameDay = tracking.currentKpi(days, '2026-10-14', '2026-10-14', fakeAgg);
  assert.strictEqual(sameDay.wins, 0);

  // Current-version delta only within one version.
  const idx = tracking.applyDeltas([
    { date: '2026-10-13', version: { live: 'a' }, edge: {}, omega: {}, current: { kpi: { wins: 1 } } },
    { date: '2026-10-14', version: { live: 'b' }, edge: {}, omega: {}, current: { kpi: { wins: 0 } } },
    { date: '2026-10-15', version: { live: 'b' }, edge: {}, omega: {}, current: { kpi: { wins: 2 } } },
  ]);
  assert.strictEqual(idx[1].delta.current.kpi.wins, null);
  assert.strictEqual(idx[2].delta.current.kpi.wins, 2);
}

function scheduler(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify(body || { next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

function baseDeps(extra) {
  return Object.assign({
    entries: scoreFile.entries,
    results: resultsFixture(100, 50),
    clvReport: clvFixture(0.18, 0.17),
    previousRows: [],
    env: { OMEGA_REPLAY_NO_WRITE: '0' },
    readJson: async () => { throw new Error('readJson should not run'); },
    writeJson: async () => { throw new Error('writeJson should not run'); },
    readResultsCache: async () => { throw new Error('results cache should not run'); },
    invokeResults: async () => { throw new Error('results invoke should not run'); },
  }, extra || {});
}

(async () => {
  const skipped = await job.handle(
    scheduler(),
    new Date('2026-10-12T13:30:00Z'),
    baseDeps(),
  );
  const skippedBody = JSON.parse(skipped.body);
  assert.strictEqual(skippedBody.skipped, 'et-guard');
  assert.strictEqual(skippedBody.function, 'report-tracking-omega');

  const writes = [];
  const saved = await job.handle(
    Object.assign(scheduler(), { body: JSON.stringify({ date: '2026-10-12', next_run: 'x' }) }),
    new Date('2026-10-12T13:15:00Z'),
    baseDeps({
      writeJson: async (key, data) => { writes.push({ key, schema: data.schema, date: data.date || data.asOf }); },
    }),
  );
  const savedBody = JSON.parse(saved.body);
  assert.strictEqual(savedBody.wrote, true);
  assert.strictEqual(savedBody.reason, null);
  assert.deepStrictEqual(savedBody.keys, ['omega-tracking/2026-10-12', 'omega-tracking/index']);
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].schema, 'omega-tracking-day-v1');
  assert.strictEqual(writes[1].schema, 'omega-tracking-v1');
  assert.strictEqual(savedBody.rows.length, 1);
  assert.strictEqual(savedBody.rows[0].edge.engineering.processes, 87);
  assert.strictEqual(savedBody.displayOnly, true);
  assert.strictEqual(savedBody.applied, false);

  const est = await job.handle(
    scheduler(),
    new Date('2026-01-15T14:15:00Z'),
    baseDeps({
      entries: [{
        date: '2026-01-01',
        edge: { processes: 1, architecture: 1, math: 1, overall: 1 },
        omega: { processes: 1, architecture: 1, math: 1, overall: 1 },
      }],
      writeJson: async () => {},
    }),
  );
  assert.strictEqual(JSON.parse(est.body).wrote, true);
  assert.strictEqual(JSON.parse(est.body).asOf, '2026-01-15');

  const dryWrites = [];
  const dry = await job.handle(
    { httpMethod: 'POST', queryStringParameters: { dryRun: '1', date: '2026-10-12' } },
    new Date('2026-10-12T16:00:00Z'),
    baseDeps({ writeJson: async () => { dryWrites.push('x'); } }),
  );
  assert.strictEqual(JSON.parse(dry.body).reason, 'dry-run');
  assert.strictEqual(JSON.parse(dry.body).wrote, false);
  assert.strictEqual(dryWrites.length, 0);

  const blockedWrites = [];
  const blocked = await job.handle(
    { httpMethod: 'POST', body: JSON.stringify({ date: '2026-10-12' }) },
    new Date('2026-10-12T13:15:00Z'),
    baseDeps({
      env: { OMEGA_REPLAY_NO_WRITE: '1' },
      writeJson: async () => { blockedWrites.push('x'); },
    }),
  );
  assert.strictEqual(JSON.parse(blocked.body).reason, 'no-write');
  assert.strictEqual(blockedWrites.length, 0);

  let invoked = 0;
  const settled = {
    cumulative: resultsFixture(100, 50).cumulative,
    straight: resultsFixture(100, 50).straight,
    omegaOnly: resultsFixture(100, 50).omegaOnly,
    cachedAt: Date.now() - 86400000,
    days: [{ pending: 0 }],
  };
  const fromCache = await job.loadResultsDocument({
    readResultsCache: async () => settled,
    invokeResults: async () => { invoked += 1; throw new Error('should not refresh a settled cache'); },
  }, { queryStringParameters: {} });
  assert.strictEqual(invoked, 0);
  assert.strictEqual(fromCache.cumulative.totalProfit, 100);

  const pending = {
    cumulative: { wins: 1, losses: 0, pushes: 0, pending: 2, accuracy: '100%', roi: '1%', totalProfit: 10, totalWagered: 100 },
    straight: { wins: 1, losses: 0, accuracy: '100%' },
    omegaOnly: {
      cumulative: { wins: 1, losses: 0, pushes: 0, pending: 2, accuracy: '100%', roi: '1%', totalProfit: 10 },
      straight: { wins: 1, losses: 0, accuracy: '100%' },
    },
    cachedAt: Date.now() - 120000,
    days: [{ pending: 2 }],
  };
  const refreshed = resultsFixture(9, 8);
  const fromInvoke = await job.loadResultsDocument({
    readResultsCache: async () => pending,
    invokeResults: async () => { invoked += 1; return refreshed; },
  }, { queryStringParameters: {} });
  assert.strictEqual(invoked, 1);
  assert.strictEqual(fromInvoke, refreshed);

  const freshPending = Object.assign({}, pending, { cachedAt: Date.now() });
  const kept = await job.loadResultsDocument({
    readResultsCache: async () => freshPending,
    invokeResults: async () => { invoked += 1; return refreshed; },
  }, { queryStringParameters: {} });
  assert.strictEqual(invoked, 1);
  assert.strictEqual(kept.cumulative.pending, 2);

  const integrated = await job.runTrackingReport({
    asOf: '2026-10-12',
    now: new Date('2026-10-12T13:15:00.000Z'),
    results: resultsFixture(150, 0),
    seedRows: [{
      source: 'omega', kind: 'pick', date: '2026-10-01', sport: 'MLB', market: 'ML',
      side: 'Home', matchup: 'A @ B', line: null, clvPp: 2, beatClose: true,
      key: 'omega|2026-10-01|ML|home',
    }],
    entries: scoreFile.entries,
    previousRows: [],
    readJson: async (key) => {
      if (key === 'clv-2026-10-12') {
        return {
          date: '2026-10-12',
          model: 'v-test',
          picks: [{
            pick: 'Over 8', matchup: 'A @ B', sport: 'MLB', market: 'Total', betLine: 8,
            pickTimeOdds: '-110', closingNoVig: 0.55, clvCents: 4, beatClosing: true,
          }],
        };
      }
      return null;
    },
    lookbackDays: 1,
    dryRun: true,
    env: { OMEGA_REPLAY_NO_WRITE: '1' },
  });
  assert.strictEqual(integrated.wrote, false);
  assert.strictEqual(integrated.reason, 'dry-run');
  assert.ok(integrated.index.rows[0].edge.clv.n >= 1);
  assert.strictEqual(integrated.index.rows[0].edge.kpi.profitDollars, 150);

  const fetched = await reader.handle({ httpMethod: 'GET' }, { readIndex: async () => null });
  const fetchedBody = JSON.parse(fetched.body);
  assert.strictEqual(fetchedBody.source, 'seed');
  assert.strictEqual(fetchedBody.rows[0].date, '2026-10-12');
  assert.strictEqual(fetchedBody.rows[0].edge.engineering.overall, 86);
  assert.strictEqual(fetchedBody.displayOnly, true);

  const cached = await reader.handle({ httpMethod: 'GET' }, {
    readIndex: async () => ({
      schema: 'omega-tracking-v1',
      rows: [{ date: '2026-10-13' }],
      updatedAtEt: 'Oct 13, 2026, 9:15 AM ET',
    }),
  });
  const cachedBody = JSON.parse(cached.body);
  assert.strictEqual(cachedBody.rows[0].date, '2026-10-13');
  assert.strictEqual(cachedBody.source, 'omega-tracking/index');

  const missing = await job.handle(
    { httpMethod: 'GET' },
    new Date('2026-10-12T13:15:00Z'),
    { readJson: async () => null },
  );
  assert.strictEqual(JSON.parse(missing.body).missing, true);

  console.log('tracking report tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
