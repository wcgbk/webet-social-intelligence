'use strict';
/**
 * Display-only results views. No blobs, no Odds API, no grading.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildResultKpis, americanImplied } = require('./netlify/functions/lib/omega-vnext/result_kpis');
const job = require('./netlify/functions/report-tracking-omega');

const be110 = 110 / 210;
assert.ok(Math.abs(americanImplied(-110) - be110) < 1e-12);
assert.ok(Math.abs(americanImplied('+150') - 0.4) < 1e-12);
assert.strictEqual(americanImplied('even'), null);

const days = [
  {
    date: '2026-10-01',
    parlayResult: 'win',
    picks: [
      { sport: 'NFL', pick: 'A -3', odds: -110, result: 'win' },
      { sport: 'NFL', pick: 'Over 44', odds: -110, result: 'loss' },
      { sport: 'NHL', pick: 'B ML', odds: '+150', result: 'win' },
      { sport: 'PARLAY', pick: '3-Team Parlay', odds: '', result: 'win' },
    ],
  },
  {
    date: '2026-10-02',
    parlayResult: 'push',
    picks: [
      { sport: 'MLB', pick: 'C +1.5', odds: '+180', result: 'push' },
    ],
  },
];

const kpis = buildResultKpis({
  days,
  clvRows: [
    { entryPrice: -110, market: 'Total', side: 'Over', clvPp: 2 },
    { entryPrice: 180, market: 'Moneyline', side: 'B', clvPp: -1 },
    { entryPrice: -200, market: 'Spread', side: 'A', clvPp: 0.5 },
  ],
  scoredRows: [
    { sport: 'NFL', coverProb: 0.6, pClose: 0.55, y: 1 },
    { sport: 'NHL', coverProb: 0.4, pClose: 0.42, result: 'loss' },
  ],
});

assert.strictEqual(kpis.displayOnly, true);
assert.strictEqual(kpis.applied, false);
assert.strictEqual(kpis.winRateVsBreakEven.n, 3);
assert.strictEqual(kpis.winRateVsBreakEven.wins, 2);
assert.strictEqual(kpis.winRateVsBreakEven.losses, 1);
assert.strictEqual(kpis.winRateVsBreakEven.pushes, 1);
assert.ok(Math.abs(kpis.winRateVsBreakEven.winRate - (2 / 3)) < 1e-4);
const breakEven = (be110 + be110 + 0.4) / 3;
assert.ok(Math.abs(kpis.winRateVsBreakEven.breakEven - breakEven) < 1e-4);
assert.ok(kpis.winRateVsBreakEven.gap > 0);

assert.strictEqual(kpis.parlayHitVsImplied.n, 1);
assert.strictEqual(kpis.parlayHitVsImplied.wins, 1);
const ticket = be110 * be110 * 0.4;
assert.ok(Math.abs(kpis.parlayHitVsImplied.implied - ticket) < 1e-4);
assert.ok(kpis.parlayHitVsImplied.hitRate > kpis.parlayHitVsImplied.implied);

const bands = {};
for (const row of kpis.clvByPriceBand) bands[row.band] = row;
assert.strictEqual(bands['-150 to +150'].n, 1);
assert.strictEqual(bands['-150 to +150'].avgClvPp, 2);
assert.strictEqual(bands['+151 to +200'].n, 1);
assert.strictEqual(bands['+151 to +200'].avgClvPp, -1);
assert.strictEqual(bands['-300 to -151'].n, 1);
const markets = {};
for (const row of kpis.clvByMarket) markets[row.market] = row;
assert.strictEqual(markets.Total.n, 1);
assert.strictEqual(markets.ML.n, 1);
assert.strictEqual(markets.Spread.n, 1);

const bySport = {};
for (const row of kpis.scoringBySport) bySport[row.sport] = row;
assert.strictEqual(bySport.NFL.n, 1);
assert.ok(Math.abs(bySport.NFL.logLossModel - (-Math.log(0.6))) < 1e-4);
assert.ok(Math.abs(bySport.NFL.brierModel - 0.16) < 1e-4);
assert.ok(Math.abs(bySport.NFL.logLossClose - (-Math.log(0.55))) < 1e-4);
assert.strictEqual(bySport.NHL.n, 1);
assert.ok(Math.abs(bySport.NHL.brierModel - (0.4 * 0.4)) < 1e-4);

const copied = buildResultKpis({
  recal: {
    sports: {
      MLB: { windows: { 28: { n: 4, logLossModel: 0.6, brierModel: 0.2, logLossClose: 0.58, brierClose: 0.19 } } },
    },
  },
});
assert.strictEqual(copied.scoringBySport.length, 1);
assert.strictEqual(copied.scoringBySport[0].sport, 'MLB');
assert.strictEqual(copied.scoringBySport[0].logLossModel, 0.6);
assert.strictEqual(copied.winRateVsBreakEven.n, 0);

const page = fs.readFileSync(path.join(__dirname, 'tracking/index.html'), 'utf8');
assert.ok(page.includes('Win rate vs break-even'));
assert.ok(page.includes('Parlay hit vs implied'));
assert.ok(page.includes('Log-loss'));
assert.ok(page.includes('resultKpis'));

(async () => {
  const saved = await job.runTrackingReport({
    asOf: '2026-10-12',
    now: new Date('2026-10-12T13:15:00Z'),
    dryRun: true,
    entries: [{
      date: '2026-10-01',
      edge: { processes: 80, architecture: 80, math: 80, overall: 80 },
      omega: { processes: 70, architecture: 70, math: 70, overall: 70 },
    }],
    results: {
      cumulative: { wins: 2, losses: 1, pushes: 1, pending: 0, accuracy: '66.7%', roi: '10%', totalWagered: 450, totalProfit: 40 },
      straight: { wins: 2, losses: 1, accuracy: '66.7%', totalWagered: 300, totalProfit: 40 },
      omegaOnly: {
        cumulative: { wins: 1, losses: 0, pushes: 0, pending: 0, accuracy: '100%', roi: '5%', totalWagered: 150, totalProfit: 10 },
        straight: { wins: 1, losses: 0, accuracy: '100%', totalWagered: 150, totalProfit: 10 },
      },
      days,
    },
    clvReport: {
      totals: {
        overall: { n: 3, avgClvPp: 0.5, beatClosePct: 60, smallSample: true },
        byModel: { Omega: { n: 3, avgClvPp: 0.5, beatClosePct: 60, smallSample: true } },
      },
    },
    clvRows: [
      { entryPrice: -110, market: 'Total', clvPp: 2 },
    ],
    scoredRows: [{ sport: 'NFL', coverProb: 0.6, y: 1 }],
    previousRows: [],
    env: { OMEGA_REPLAY_NO_WRITE: '1' },
    readJson: async () => { throw new Error('tracking kpi test must not read'); },
    writeJson: async () => { throw new Error('tracking kpi test must not write'); },
  });
  assert.strictEqual(saved.wrote, false);
  assert.strictEqual(saved.reason, 'dry-run');
  assert.strictEqual(saved.index.resultKpis.displayOnly, true);
  assert.strictEqual(saved.index.resultKpis.winRateVsBreakEven.wins, 2);
  assert.strictEqual(saved.index.resultKpis.clvByPriceBand[0].band, '-150 to +150');
  assert.strictEqual(saved.index.resultKpis.scoringBySport[0].sport, 'NFL');
  console.log('test-omega-result-kpis: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
