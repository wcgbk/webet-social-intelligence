'use strict';
// Offline generate-time health monitors. No network.
const assert = require('assert');
const { SPORTS_ENABLED } = require('./netlify/functions/lib/omega-vnext/config');
const { slateCountsFor } = require('./netlify/functions/lib/omega-vnext/index');
const { oddsFailureRecord } = require('./netlify/functions/lib/omega-vnext/ingest');
const { buildHealthRecord, attachGenerateHealth } = require('./netlify/functions/lib/omega-vnext/health');
const np = require('./netlify/functions/lib/no-plays');

assert.strictEqual(SPORTS_ENABLED.NBA, false);

function row(extra) {
  return Object.assign({ wins: 1, losses: 1, ties: 0, games: 2, pf: 30 }, extra || {});
}

const same = { pointsPerGame: 22, games: 4, wins: 2, losses: 2, ties: 0, pf: 88 };
const standings = {
  A: same, B: same, C: same, D: same, E: same, F: same,
  Zero: { pointsPerGame: 22, games: 0, wins: 0, losses: 0, ties: 0, pf: 12 },
  Low: { pointsPerGame: 3, games: 2, wins: 1, losses: 1, ties: 0, pf: 6 },
  Bad: { pointsPerGame: 22, games: 5, wins: 2, losses: 1, ties: 0, pf: 40, record: '2-1' },
};

function cand(partial) {
  return Object.assign({
    sport: 'MLB',
    matchup: 'A @ B',
    homeTeam: 'B',
    awayTeam: 'A',
    market: 'Total',
    side: 'Over 8',
    modelProjection: 8,
    consensusLine: 8,
    line: 8,
  }, partial);
}

const candidates = [
  cand({ matchup: 'A @ H', homeTeam: 'H', awayTeam: 'A', market: 'Total', side: 'Over 8', modelProjection: 9, consensusLine: 8, line: 8 }),
  cand({ matchup: 'A @ H', homeTeam: 'H', awayTeam: 'A', market: 'Total', side: 'Under 8', modelProjection: 9, consensusLine: 8, line: 8 }),
  cand({ matchup: 'A @ H', homeTeam: 'H', awayTeam: 'A', market: 'Spread', side: 'H -1.5', modelProjection: 1, consensusLine: -1.5, line: -1.5 }),
  cand({ sport: 'NHL', matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C', market: 'Total', side: 'Over 6.2', modelProjection: 6.2, line: 6.2 }),
  cand({ sport: 'NHL', matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E', market: 'Total', side: 'Under 6.2', modelProjection: 6.2, line: 6.2 }),
];

const oddsErr = (() => {
  const err = new Error('HTTP 422 for https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=SECRETKEY');
  err.status = 422;
  return oddsFailureRecord('MLB', err);
})();
assert.strictEqual(oddsErr.status, 422);
assert.ok(!/apiKey/i.test(oddsErr.message), oddsErr.message);
assert.ok(!oddsErr.message.includes('SECRETKEY'));
assert.ok(!/https?:/i.test(oddsErr.message), oddsErr.message);

const input = {
  dateISO: '2026-10-07',
  snap: {
    espnBySport: { MLB: { games: [{ homeTeam: 'H', awayTeam: 'A' }] }, NFL: { games: [{}] } },
    oddsBySport: { MLB: [{ home_team: 'Not A Real Club', away_team: 'Also Missing' }] },
    standingsBySport: { NFL: standings },
    mlbPitcherStats: { byId: {}, byTeam: {} },
  },
  rawBySport: { MLB: 0, NFL: 5 },
  candidates,
  yesPool: candidates.slice(0, 2),
  oddsErrors: [oddsErr],
};

const record = buildHealthRecord(input);
assert.strictEqual(record.date, '2026-10-07');
assert.strictEqual(record.status, 'warn');
const codes = record.alerts.map(a => a.sport + ':' + a.code);
assert.ok(codes.includes('NFL:constant_stat'), codes.join(','));
assert.ok(codes.includes('NFL:gp_zero_points'), codes.join(','));
assert.ok(codes.includes('NFL:rate_out_of_band'), codes.join(','));
assert.ok(codes.includes('NFL:record_mismatch'), codes.join(','));
assert.ok(codes.includes('MLB:mlb_pitchers_empty'), codes.join(','));
assert.ok(codes.includes('MLB:odds_error'), codes.join(','));
assert.ok(codes.includes('MLB:bias_total'), codes.join(','));
assert.ok(codes.includes('MLB:bias_margin'), codes.join(','));
assert.ok(codes.includes('NHL:constant_total'), codes.join(','));
assert.ok(codes.includes('MLB:zero_candidates'), codes.join(','));
assert.ok(codes.includes('MLB:unresolved_names'), codes.join(','));
assert.strictEqual(record.mlbPitchersEmpty, true);
assert.strictEqual(record.oddsErrors[0].status, 422);
assert.ok(record.bySport.MLB.bias.totalMean > 0.4);
assert.ok(Math.abs(record.bySport.MLB.bias.marginMean) > 0.4);
assert.strictEqual(record.splits.candidates.over >= 1, true);
assert.strictEqual(record.splits.yesPool.over, 1);
assert.strictEqual(record.splits.yesPool.under, 1);

const clean = buildHealthRecord({
  dateISO: '2026-10-08',
  snap: { espnBySport: {}, oddsBySport: {}, standingsBySport: {}, mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } } },
  rawBySport: {},
  candidates: [],
  yesPool: [],
  oddsErrors: [],
});
assert.strictEqual(clean.status, 'ok');
assert.strictEqual(clean.date, '2026-10-08');
assert.deepStrictEqual(clean.alerts, []);

const nhlSnap = {
  espnBySport: {
    NHL: { games: [{}, {}] },
    NBA: { games: [{}, {}, {}] },
    MLB: { games: [] },
    NFL: { games: [] },
    NCAAF: { games: [] },
  },
  oddsBySport: {},
};
const nhlCounts = slateCountsFor(nhlSnap);
assert.strictEqual(nhlCounts.bySport.NHL, 2);
assert.strictEqual(nhlCounts.bySport.NBA, undefined);
assert.ok(nhlCounts.total >= 2);
const nhlReason = np.omegaReason({ counts: nhlCounts.bySport, dateISO: '2026-10-07' });
assert.ok(!/no baseball or football games/i.test(nhlReason), nhlReason);
assert.ok(/hockey/.test(nhlReason), nhlReason);
assert.strictEqual(
  nhlReason,
  "None of the 2 hockey games on today's board cleared Omega's edge floors."
);
assert.strictEqual(
  np.omegaReason({ counts: { MLB: 0, NFL: 0, NCAAF: 0, NHL: 1 }, dateISO: '2026-10-07' }),
  "The one hockey game on today's board didn't clear Omega's edge floors."
);
assert.strictEqual(
  np.omegaReason({ counts: { MLB: 0, NFL: 2, NCAAF: 0, NHL: 0 }, dateISO: '2026-10-07' }),
  "Baseball has a postseason off day. None of the 2 games on today's board cleared Omega's edge floors."
);
assert.strictEqual(
  np.omegaReason({ counts: { MLB: 0, NFL: 0, NCAAF: 0, NHL: 0 }, dateISO: '2026-10-07' }),
  "There are no baseball or football games on today's board, so Omega has nothing to price."
);

const picks = [{ pick: 'Home ML', units: '1u', sport: 'MLB' }];
const frozen = JSON.parse(JSON.stringify(picks));
const held = { date: '2026-10-07', picks };
const thrown = attachGenerateHealth(held, input, () => { throw new Error('boom'); });
assert.strictEqual(thrown, null);
assert.strictEqual(held.health, undefined);
assert.deepStrictEqual(held.picks, frozen);
const kept = { date: '2026-10-07', picks: JSON.parse(JSON.stringify(frozen)) };
const built = attachGenerateHealth(kept, input);
assert.ok(built && built.alerts.length);
assert.deepStrictEqual(kept.picks, frozen);
assert.deepStrictEqual(held.picks, kept.picks);
assert.ok(kept.health && kept.health.status === 'warn');

const frozenCands = candidates.map(c => Object.freeze(Object.assign({}, c)));
buildHealthRecord(Object.assign({}, input, { candidates: frozenCands }));

(async () => {
  const [a, b] = await Promise.all([
    new Promise((resolve) => setImmediate(() => resolve(buildHealthRecord(input)))),
    new Promise((resolve) => setImmediate(() => resolve(buildHealthRecord({
      dateISO: '2026-11-02',
      snap: { espnBySport: {}, oddsBySport: {}, standingsBySport: {}, mlbPitcherStats: { byId: { a: 1 }, byTeam: { a: 1 } } },
      rawBySport: {},
      candidates: [],
      yesPool: [],
      oddsErrors: [],
    })))),
  ]);
  assert.strictEqual(a.date, '2026-10-07');
  assert.strictEqual(b.date, '2026-11-02');
  assert.notStrictEqual(a.status, b.status);
  console.log('ok test-omega-health');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
