'use strict';

/**
 * CLV ledger: normalize, dedupe, totals. Fixture rows only. No network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ledger = require('./netlify/functions/lib/clv-ledger');
const job = require('./netlify/functions/report-clv-omega');
const reader = require('./netlify/functions/get-clv-report');

assert.strictEqual(job.handler.length <= 2, true);
assert.strictEqual(reader.handler.length <= 2, true);

const root = __dirname;
const jobSrc = fs.readFileSync(path.join(root, 'netlify/functions/report-clv-omega.js'), 'utf8');
const readerSrc = fs.readFileSync(path.join(root, 'netlify/functions/get-clv-report.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'clv/index.html'), 'utf8');
assert.ok(!/selectStraights|calibrateAll|generateOmega|leanFill|force-fill/.test(jobSrc));
assert.ok(!/NETLIFY_AUTH_TOKEN|Authorization|api\.netlify\.com/.test(readerSrc));
assert.ok(page.includes("fetch('/api/get-clv-report'"));
assert.ok(page.includes("fetch('/clv/report.json'"));
assert.ok(page.includes('src="/nav.js"'));
assert.ok(page.includes('id="updated"'));

function near(actual, expected, eps, label) {
  assert.ok(Number.isFinite(actual), `${label || 'value'} not finite: ${actual}`);
  const gap = Math.abs(actual - expected);
  assert.ok(gap <= (eps == null ? 1e-9 : eps), `${label || 'value'} ${actual} vs ${expected}`);
}

const pickBlob = {
  date: '2026-09-05',
  model: 'v11.2-omega-test',
  picks: [
    {
      pick: 'Over 7',
      matchup: 'Detroit Tigers @ Cleveland Guardians',
      sport: 'MLB',
      market: 'Total',
      betLine: 7,
      pickTimeOdds: '-115',
      closingNoVig: 0.4875,
      clv: -0.0314,
      clvCents: -3.14,
      beatClosing: false,
    },
    {
      pick: 'Yankees ML',
      matchup: 'Boston Red Sox @ New York Yankees',
      sport: 'MLB',
      betType: 'Moneyline',
      pickTimeOdds: '+100',
      closingNoVig: 0.54,
      clvCents: 1.2,
      beatClosing: true,
    },
  ],
};

{
  const rows = ledger.rowsFromClvBlob(pickBlob, { source: 'omega', date: '2026-09-05' });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].source, 'omega');
  assert.strictEqual(rows[0].kind, 'pick');
  assert.strictEqual(rows[0].market, 'Total');
  assert.strictEqual(rows[0].entryPrice, -115);
  assert.strictEqual(rows[0].closeNoVigP, 0.4875);
  assert.strictEqual(rows[0].clvPp, -3.14);
  assert.strictEqual(rows[0].beatClose, false);
  assert.strictEqual(rows[0].modelVersion, 'v11.2-omega-test');
  assert.strictEqual(rows[1].market, 'ML');
  assert.strictEqual(rows[1].entryPrice, 100);
  assert.strictEqual(rows[1].side, 'Yankees ML');
  assert.strictEqual(ledger.canonicalSide('Moneyline', 'Yankees ML'), 'yankees');
}

const candidateV2 = {
  date: '2026-09-05',
  schema: 'clv-candidates-v2',
  candidates: [
    {
      sport: 'MLB',
      market: 'Total',
      side: 'Over',
      line: 7,
      matchup: 'Detroit Tigers @ Cleveland Guardians',
      odds: -115,
      closeNoVig: 0.49,
      clvProb: -0.03,
      clvProbCents: -3,
      published: true,
    },
    {
      sport: 'MLB',
      market: 'Total',
      side: 'Under',
      line: 8.5,
      matchup: 'Detroit Tigers @ Cleveland Guardians',
      odds: '-105',
      closeNoVig: 0.52,
      clvProbCents: 0.4,
      published: false,
    },
    {
      sport: 'NFL',
      market: 'Spread',
      side: 'Home',
      line: -3,
      matchup: 'A @ B',
      odds: -110,
      published: false,
    },
  ],
};

{
  const rows = ledger.rowsFromCandidateBlob(candidateV2, { date: '2026-09-05', modelVersion: 'v12-test' });
  assert.strictEqual(rows.length, 2, 'a candidate with no close is not graded');
  assert.strictEqual(rows[0].kind, 'pick');
  assert.strictEqual(rows[0].clvPp, -3);
  assert.strictEqual(rows[0].modelVersion, 'v12-test');
  assert.strictEqual(rows[1].kind, 'candidate');
  assert.strictEqual(rows[1].entryPrice, -105);
  assert.strictEqual(rows[1].beatClose, true);
  const same = ledger.dedupeKey(rows[0]);
  const fromPick = ledger.dedupeKey(ledger.rowsFromClvBlob(pickBlob)[0]);
  assert.strictEqual(same, fromPick, 'published candidate and clv pick share a dedupe key');
}

{
  const v1 = {
    date: '2026-10-01',
    schema: 'clv-candidates-v1',
    sides: [{
      sport: 'NHL',
      market: 'Puck line',
      side: 'Rangers -1.5',
      line: -1.5,
      matchup: 'Devils @ Rangers',
      odds: '+120',
      closingNoVig: 0.48,
      clv: 0.01,
      beatClose: true,
    }],
  };
  const rows = ledger.rowsFromBlob('clv-candidates-2026-10-01', v1, { date: '2026-10-01' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].market, 'Spread');
  assert.strictEqual(rows[0].clvPp, 1);
  assert.strictEqual(rows[0].kind, 'candidate');
  assert.strictEqual(rows[0].entryPrice, 120);
  assert.strictEqual(ledger.rowsFromBlob('picks-2026-10-01', { picks: pickBlob.picks }).length, 0);
  assert.strictEqual(ledger.rowsFromBlob('omega-candidates/2026-10-01', {
    candidates: [{ sport: 'MLB', market: 'Total', side: 'Over', line: 9, matchup: 'A @ B', published: false }],
  }).length, 0);
}

{
  const day = {
    book: 'alpha',
    from: '2026-06-20',
    available: true,
    n: 3,
    meanCents: 1,
    beatClosePct: 66.7,
    byFamily: {
      Total: { n: 2, meanCents: 1.5, beatClosePct: 50 },
      ML: { n: 1, meanCents: 0, beatClosePct: 100 },
    },
  };
  const rows = ledger.rowsFromDaySummary(day, { source: 'alpha', date: '2026-06-20' });
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every((row) => row.aggregate && row.entryPrice == null && row.closeNoVigP == null));
  assert.strictEqual(rows.filter((row) => row.beatClose).length, 2);
  near(rows.reduce((sum, row) => sum + row.clvPp, 0) / rows.length, 1, 1e-9, 'family average');
  const empty = ledger.rowsFromDaySummary({ available: false, n: 0, meanCents: null, byFamily: {} }, { source: 'alpha', date: '2026-01-01' });
  assert.strictEqual(empty.length, 0);
}

{
  const pick = ledger.rowsFromClvBlob(pickBlob)[0];
  const published = ledger.rowsFromCandidateBlob(candidateV2)[0];
  const merged = ledger.mergeRows([pick, published, published]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].kind, 'pick');
  assert.strictEqual(merged[0].clvPp, -3, 'later close replaces the first value');
  const blanked = ledger.mergeRows([pick, { ...pick, entryPrice: null, closeNoVigP: null, clvPp: -2.5 }]);
  assert.strictEqual(blanked.length, 1);
  assert.strictEqual(blanked[0].clvPp, -2.5);
  assert.strictEqual(blanked[0].entryPrice, -115, 'a later null does not blank a stored price');
  assert.strictEqual(blanked[0].closeNoVigP, 0.4875);
  const again = ledger.mergeRows(merged);
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].key, merged[0].key);
}

{
  const agg = ledger.rowsFromDaySummary({
    available: true,
    n: 2,
    meanCents: 4,
    beatClosePct: 100,
    byFamily: { Total: { n: 2, meanCents: 4, beatClosePct: 100 } },
  }, { source: 'omega', date: '2026-10-10' });
  const ticket = ledger.rowsFromClvBlob({
    date: '2026-10-10',
    picks: [{
      pick: 'Over 6.5',
      matchup: 'Dodgers @ Braves',
      sport: 'MLB',
      market: 'Total',
      betLine: 6.5,
      pickTimeOdds: '-104',
      closingNoVig: 0.51,
      clvCents: 1.36,
      beatClosing: true,
    }],
  }, { source: 'omega', date: '2026-10-10' });
  const merged = ledger.mergeRows(agg.concat(ticket));
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].aggregate, undefined);
  assert.strictEqual(merged[0].clvPp, 1.36);
  const kept = ledger.mergeRows(agg.concat([{
    source: 'alpha',
    kind: 'pick',
    date: '2026-10-10',
    sport: 'NFL',
    market: 'Spread',
    side: 'Home -3',
    matchup: 'A @ B',
    line: -3,
    clvPp: 2,
    beatClose: true,
  }]));
  assert.strictEqual(kept.filter((row) => row.source === 'omega' && row.aggregate).length, 2);
  assert.strictEqual(kept.filter((row) => row.source === 'alpha').length, 1);
}

{
  const rows = [
    { source: 'omega', kind: 'pick', date: '2026-10-01', sport: 'NFL', market: 'Spread', side: 'A -3', matchup: 'A @ B', line: -3, clvPp: 2, beatClose: true },
    { source: 'omega', kind: 'pick', date: '2026-10-01', sport: 'NFL', market: 'Spread', side: 'C +3', matchup: 'C @ D', line: 3, clvPp: -1, beatClose: false },
    { source: 'omega', kind: 'candidate', date: '2026-10-02', sport: 'NHL', market: 'Total', side: 'Over 6', matchup: 'E @ F', line: 6, clvPp: 0, beatClose: false },
  ];
  const report = ledger.buildReport({ rows, asOf: '2026-10-02', generatedAt: '2026-10-12T13:15:00.000Z' });
  assert.strictEqual(report.totals.overall.n, 3);
  near(report.totals.overall.avgClvPp, 0.33, 1e-9, 'avg');
  near(report.totals.overall.beatClosePct, 33.3, 1e-9, 'beat');
  assert.strictEqual(report.totals.overall.smallSample, true);
  assert.strictEqual(report.totals.overall.sampleLabel, 'n<50');
  assert.strictEqual(report.totals.byModel.Omega.n, 3);
  assert.strictEqual(report.totals.byModel.Alpha.n, 0);
  assert.strictEqual(report.omegaTargets.allCandidates.n, 3);
  assert.strictEqual(report.omegaTargets.allCandidates.meetsAvg, true);
  assert.strictEqual(report.omegaTargets.publishedPicks.n, 2);
  near(report.omegaTargets.publishedPicks.avgClvPp, 0.5, 1e-9, 'published avg');
  assert.strictEqual(report.omegaTargets.publishedPicks.meetsAvg, false);
  assert.strictEqual(report.omegaTargets.publishedPicks.meetsBeat, false);
  assert.strictEqual(report.omegaTargets.publishedPicks.targetAvgClvPp, 1);
  assert.strictEqual(report.omegaTargets.publishedPicks.targetBeatClosePct, 55);
  assert.ok(report.updatedAtEt.indexOf('ET') !== -1);
  const fifty = [];
  for (let i = 0; i < 50; i += 1) {
    fifty.push({
      source: 'alpha', kind: 'pick', date: '2026-08-01', sport: 'MLB', market: 'ML',
      side: `Team ${i}`, matchup: `A @ B ${i}`, line: null, clvPp: 1, beatClose: true,
    });
  }
  const big = ledger.bucket(fifty);
  assert.strictEqual(big.n, 50);
  assert.strictEqual(big.smallSample, false);
  assert.strictEqual(big.sampleLabel, null);
  fifty.pop();
  assert.strictEqual(ledger.bucket(fifty).smallSample, true);
}

{
  const seed = require('./data/clv-ledger-seed.json');
  const snapshot = require('./clv/report.json');
  assert.strictEqual(seed.schema, 'clv-ledger-seed-v1');
  assert.strictEqual(seed.counts.alpha, 278);
  assert.strictEqual(seed.counts.omega, 95);
  assert.strictEqual(seed.counts.total, 373);
  assert.strictEqual(seed.rows.length, 373);
  const keys = new Set(seed.rows.map((row) => row.key));
  assert.strictEqual(keys.size, seed.rows.length, 'seed keys are unique');
  assert.strictEqual(seed.rows.filter((row) => row.source === 'alpha' && row.aggregate).length, 278);
  assert.strictEqual(seed.rows.filter((row) => row.source === 'omega' && !row.aggregate).length, seed.counts.omegaFromTickets);
  const rebuilt = ledger.buildReport({
    rows: seed.rows,
    asOf: seed.asOf,
    generatedAt: seed.generatedAt,
    source: 'seed',
  });
  assert.deepStrictEqual(rebuilt.totals, snapshot.totals);
  assert.deepStrictEqual(rebuilt.omegaTargets, snapshot.omegaTargets);
  assert.strictEqual(rebuilt.updatedAtEt, snapshot.updatedAtEt);
  assert.strictEqual(ledger.mergeRows(seed.rows).length, seed.rows.length);
  assert.strictEqual(rebuilt.totals.overall.n, 373);
  assert.strictEqual(rebuilt.totals.byModel.Alpha.n, 278);
  assert.strictEqual(rebuilt.totals.byModel.Omega.n, 95);
  assert.ok(rebuilt.totals.bySport.some((row) => row.n < 50 && row.sampleLabel === 'n<50'));
}

function scheduler(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify(body || { next_run: '2099-01-01T00:00:00.000Z' }),
  };
}

(async () => {
  let reads = 0;
  const skipped = await job.handle(scheduler(), new Date('2026-10-12T13:30:00Z'), {
    readJson: async () => { reads += 1; return null; },
    seedRows: [],
  });
  assert.strictEqual(JSON.parse(skipped.body).skipped, 'et-guard');
  assert.strictEqual(reads, 0, 'a skipped slot does not read blobs');

  const writes = [];
  const livePick = {
    date: '2026-10-12',
    picks: [{
      pick: 'Over 8',
      matchup: 'Giants @ Mets',
      sport: 'MLB',
      market: 'Total',
      betLine: 8,
      pickTimeOdds: '+100',
      closingNoVig: 0.53,
      clvCents: 2.5,
      beatClosing: true,
    }],
  };
  const seedAgg = ledger.rowsFromDaySummary({
    available: true,
    n: 1,
    meanCents: -4,
    beatClosePct: 0,
    byFamily: { Total: { n: 1, meanCents: -4, beatClosePct: 0 } },
  }, { source: 'omega', date: '2026-10-12' });
  const dry = await job.handle(
    { httpMethod: 'POST', queryStringParameters: { dryRun: '1', date: '2026-10-12' } },
    new Date('2026-10-12T17:00:00Z'),
    {
      readJson: async (key) => (key === 'clv-2026-10-12' ? livePick : null),
      writeJson: async (key) => { writes.push(key); },
      seedRows: seedAgg,
      env: {},
      lookbackDays: 3,
    },
  );
  const dryBody = JSON.parse(dry.body);
  assert.strictEqual(dryBody.wrote, false);
  assert.strictEqual(dryBody.reason, 'dry-run');
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(dryBody.totals.overall.n, 1);
  assert.strictEqual(dryBody.totals.overall.avgClvPp, 2.5);
  assert.strictEqual(dryBody.n, 1);

  const saved = await job.handle(
    { httpMethod: 'POST', body: JSON.stringify({ date: '2026-10-12' }) },
    new Date('2026-10-12T13:15:00Z'),
    {
      readJson: async (key) => {
        if (key === 'clv-2026-10-12') return livePick;
        if (key === 'clv-candidates-v2/2026-10-12') {
          return {
            date: '2026-10-12',
            candidates: [{
              sport: 'MLB',
              market: 'Total',
              side: 'Under',
              line: 9,
              matchup: 'Giants @ Mets',
              odds: -110,
              closeNoVig: 0.47,
              clvProbCents: -0.5,
              published: false,
            }],
          };
        }
        return null;
      },
      writeJson: async (key, data) => { writes.push({ key, n: data.n }); },
      seedRows: seedAgg.concat([{
        source: 'alpha', kind: 'pick', date: '2026-08-01', sport: null, market: 'ML',
        clvPp: 1, beatClose: true, aggregate: true, aggregateIndex: 0,
        key: 'agg|alpha|2026-08-01|ML|0',
      }]),
      env: { OMEGA_REPLAY_NO_WRITE: '0' },
      lookbackDays: 2,
    },
  );
  const savedBody = JSON.parse(saved.body);
  assert.strictEqual(savedBody.wrote, true);
  assert.deepStrictEqual(savedBody.keys, ['omega-clv-report/2026-10-12', 'omega-clv-report/latest']);
  assert.strictEqual(savedBody.totals.overall.n, 3);
  assert.strictEqual(savedBody.omegaTargets.allCandidates.n, 2);
  assert.strictEqual(savedBody.omegaTargets.publishedPicks.n, 1);
  assert.strictEqual(savedBody.totals.byModel.Alpha.n, 1);
  assert.strictEqual(writes.length, 2);

  const blocked = await job.handle(
    { httpMethod: 'POST', body: JSON.stringify({ date: '2026-10-12' }) },
    new Date('2026-10-12T13:15:00Z'),
    {
      readJson: async () => null,
      writeJson: async () => { throw new Error('should not write'); },
      seedRows: [],
      env: { OMEGA_REPLAY_NO_WRITE: '1' },
      lookbackDays: 1,
    },
  );
  assert.strictEqual(JSON.parse(blocked.body).reason, 'no-write');

  const fetched = await reader.handle({ httpMethod: 'GET' }, {
    readLatest: async () => null,
  });
  const fetchedBody = JSON.parse(fetched.body);
  assert.strictEqual(fetchedBody.source, 'seed');
  assert.strictEqual(fetchedBody.totals.overall.n, 373);
  assert.strictEqual(fetchedBody.displayOnly, true);
  assert.ok(!fetchedBody.rows, 'the public report does not dump the ledger');

  const cached = await reader.handle({ httpMethod: 'GET' }, {
    readLatest: async () => ({
      schema: 'omega-clv-report-v1',
      totals: { overall: { n: 4, avgClvPp: 1, beatClosePct: 50, smallSample: true, sampleLabel: 'n<50' } },
      updatedAtEt: 'Oct 12, 2026, 9:15 AM ET',
    }),
  });
  const cachedBody = JSON.parse(cached.body);
  assert.strictEqual(cachedBody.totals.overall.n, 4);
  assert.strictEqual(cachedBody.updatedAtEt, 'Oct 12, 2026, 9:15 AM ET');
  assert.strictEqual(cachedBody.source, 'omega-clv-report/latest');

  const dates = ledger.liveDates('2026-10-12', 45);
  assert.strictEqual(dates[0], '2026-09-05');
  assert.strictEqual(dates[dates.length - 1], '2026-10-12');
  assert.strictEqual(ledger.liveDates('2026-12-01', 10)[0], '2026-11-22');

  console.log('clv ledger tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
