'use strict';

const assert = require('assert');
const ledger = require('./netlify/functions/lib/clv-ledger');
const oddsMaster = require('./netlify/functions/lib/omega-vnext/odds_master');
const config = require('./netlify/functions/lib/omega-vnext/config');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.66-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.66-omega-vnext-price-lock:'));
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);
assert.strictEqual(config.LEAN_MIN_EV, 0.015);

const blob = {
  date: '2026-10-12',
  note: 'fixture only',
  candidates: [
    {
      sport: 'NFL', market: 'Spread', side: 'A -3', matchup: 'A @ B', line: -3,
      odds: -110, clvCents: 2, beatClose: true, published: true,
    },
    {
      sport: 'NFL', market: 'Total', side: 'Over 44', matchup: 'C @ D', line: 44,
      odds: -110, clvCents: -1, beatClose: false, published: false,
    },
    {
      sport: 'NHL', market: 'ML', side: 'Home', matchup: 'E @ F',
      odds: -120, clv: 0.01, beatClose: true,
    },
  ],
};

const rows = ledger.rowsFromCandidateBlob(blob, { date: '2026-10-12' });
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows.filter((row) => row.kind === 'pick').length, 1);

const kpis = ledger.clvKpis(rows);
assert.strictEqual(kpis.displayOnly, true);
assert.strictEqual(kpis.picks.n, 1);
assert.strictEqual(kpis.picks.avgClvPp, 2);
assert.strictEqual(kpis.picks.beatClosePct, 100);
assert.strictEqual(kpis.candidates.n, 2);
assert.strictEqual(kpis.candidates.avgClvPp, 0);
assert.strictEqual(kpis.candidates.beatClosePct, 50);

const nfl = kpis.bySport.find((row) => row.sport === 'NFL');
const nhl = kpis.bySport.find((row) => row.sport === 'NHL');
assert.ok(nfl && nhl);
assert.strictEqual(nfl.picks.n, 1);
assert.strictEqual(nfl.picks.avgClvPp, 2);
assert.strictEqual(nfl.candidates.n, 1);
assert.strictEqual(nfl.candidates.avgClvPp, -1);
assert.strictEqual(nhl.picks.n, 0);
assert.strictEqual(nhl.candidates.n, 1);
assert.strictEqual(nhl.candidates.avgClvPp, 1);

const fromBlob = oddsMaster.clvKpisFromCandidateBlob(blob);
assert.strictEqual(fromBlob.readOnly, true);
assert.strictEqual(fromBlob.source, 'clv-candidates-v2');
assert.strictEqual(fromBlob.picks.n, 1);
assert.strictEqual(fromBlob.candidates.n, 2);
assert.strictEqual(oddsMaster.clvKpisFromCandidateBlob(null).picks.n, 0);

const report = ledger.buildReport({
  rows,
  asOf: '2026-10-12',
  generatedAt: '2026-10-13T13:15:00.000Z',
});
assert.strictEqual(report.displayOnly, true);
assert.strictEqual(report.clvKpis.picks.n, 1);
assert.strictEqual(report.clvKpis.bySport.length, 2);
const table = ledger.formatTotalsTable(report);
assert.ok(table.includes('NFL picks'));
assert.ok(table.includes('NHL candidates'));

(async () => {
  const reads = [];
  const got = await oddsMaster.clvKpisForDate('2026-10-12', {
    readJson: async (key) => {
      reads.push(key);
      return blob;
    },
  });
  assert.deepStrictEqual(reads, ['clv-candidates-v2/2026-10-12']);
  assert.strictEqual(got.picks.n, 1);
  assert.strictEqual(got.candidates.n, 2);
  const empty = await oddsMaster.clvKpisForDate('2026-10-11', {
    readJson: async () => null,
  });
  assert.strictEqual(empty.picks.n, 0);
  assert.strictEqual(empty.candidates.n, 0);
  assert.strictEqual(empty.bySport.length, 0);
  console.log('test-omega-clv-kpis ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
