'use strict';
/**
 * NCAAF returning production scales the opponent-adjusted seed prior only.
 * Games-played shrink stays g/(g+K). A missing team and OMEGA_NCAAF_RETPROD=0
 * both use multiplier 1. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const epa = require(path.join(root, 'sports/epa'));
const table = require(path.join(root, 'sports/data/cfb-returning-production-2026.json'));
const { resolveTeamId, teamRecord } = require(path.join(root, 'sports/team_identity'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.60-omega-vnext-price-lock');
assert.ok(config.MODEL_NOTES.includes('v12.3.29-omega-vnext-price-lock: NCAAF returning production'));
assert.ok(/OMEGA_NCAAF_RETPROD=0/.test(config.MODEL_NOTES));

assert.deepStrictEqual(
  {
    base: config.NCAAF_RET_PROD.base,
    slope: config.NCAAF_RET_PROD.slope,
    center: config.NCAAF_RET_PROD.center,
    min: config.NCAAF_RET_PROD.min,
    max: config.NCAAF_RET_PROD.max,
  },
  { base: 0.6, slope: 0.8, center: 0.5, min: 0.4, max: 1 },
);

function expectMultiplier(overallRet) {
  const raw = 0.6 + 0.8 * (overallRet - 0.5);
  return Math.min(1, Math.max(0.4, raw));
}

assert.strictEqual(config.ncaafRetProdMultiplier(0.5), 0.6);
assert.strictEqual(config.ncaafRetProdMultiplier(1), 1);
assert.strictEqual(config.ncaafRetProdMultiplier(0), 0.4);
assert.strictEqual(config.ncaafRetProdMultiplier(1.4), 1);
assert.strictEqual(config.ncaafRetProdMultiplier(-0.2), 0.4);
assert.strictEqual(config.ncaafRetProdMultiplier(0.72), expectMultiplier(0.72));
assert.strictEqual(config.ncaafRetProdMultiplier(0.22), 0.4);
assert.strictEqual(config.ncaafRetProdMultiplier(Number.NaN), 1);
assert.strictEqual(config.ncaafRetProdMultiplier(undefined), 1);

assert.strictEqual(table._meta.season, 2026);
assert.strictEqual(
  table._meta.url,
  'https://www.espn.com/college-football/story/_/id/48259759/college-football-returning-production-2026-notre-dame-texas',
);
assert.strictEqual(table._meta.fetched, '2026-10-11');
assert.deepStrictEqual(table._meta.unresolved, []);

const ids = Object.keys(table).filter((key) => !key.startsWith('_'));
assert.strictEqual(ids.length, table._meta.teams);
assert.strictEqual(ids.length, 138);
for (const id of ids) {
  const rec = teamRecord('NCAAF', id);
  assert.ok(rec && rec.displayName, `id ${id} has no team record`);
  assert.strictEqual(rec.division, 'fbs', rec.displayName);
  assert.strictEqual(resolveTeamId('NCAAF', rec.displayName), id, rec.displayName);
  const row = table[id];
  for (const field of ['offRet', 'defRet', 'overallRet']) {
    const n = Number(row[field]);
    assert.ok(n >= 0 && n <= 1, `${rec.displayName} ${field} ${row[field]}`);
  }
  assert.strictEqual(epa.ncaafRetProdPriorMultiplier(id), config.ncaafRetProdMultiplier(row.overallRet));
}

// Notre Dame, Texas, Southern Miss from the 2026-03-23 Connelly table.
assert.deepStrictEqual(table['87'], { offRet: 0.67, defRet: 0.77, overallRet: 0.72 });
assert.deepStrictEqual(table['251'], { offRet: 0.73, defRet: 0.63, overallRet: 0.68 });
assert.deepStrictEqual(table['2572'], { offRet: 0.23, defRet: 0.2, overallRet: 0.22 });
assert.strictEqual(epa.ncaafRetProdPriorMultiplier('87'), expectMultiplier(0.72));
assert.strictEqual(epa.ncaafRetProdPriorMultiplier('2572'), 0.4);

// Missing team fail-soft. 93 is Murray State (FCS, not in the table).
assert.strictEqual(epa.ncaafRetProdPriorMultiplier('999999'), 1);
assert.strictEqual(epa.ncaafRetProdPriorMultiplier('93'), 1);
assert.strictEqual(epa.ncaafRetProdPriorMultiplier(null), 1);
assert.strictEqual(epa.ncaafRetProdPriorMultiplier(''), 1);

const ND = '87';
const USM = '2572';
const efficiency = {
  'Notre Dame Fighting Irish': { offEpa: 0.15, defEpa: 0.15 },
  'Southern Miss Golden Eagles': { offEpa: 0.15, defEpa: 0.15 },
};

function board(games) {
  return {
    events: games.map((g, i) => ({
      date: g.commence,
      status: { type: { state: 'post' } },
      competitions: [{
        neutralSite: false,
        status: { type: { state: 'post' } },
        competitors: [
          { homeAway: 'home', score: String(g.hs), team: { id: g.hid } },
          { homeAway: 'away', score: String(g.as), team: { id: g.aid } },
        ],
      }],
      id: `rp${i}`,
    })),
  };
}

function tieGames(n) {
  const games = [];
  for (let i = 0; i < n; i += 1) {
    const day = String(5 + i).padStart(2, '0');
    games.push({
      hid: i % 2 ? USM : ND,
      aid: i % 2 ? ND : USM,
      hs: 24,
      as: 24,
      commence: `2026-09-${day}T20:00:00Z`,
    });
  }
  return games;
}

function strengthGap(pack) {
  const s = (id) => pack.byId[id].off + pack.byId[id].def;
  return s(ND) - s(USM);
}

function solve(priorGames, nGames) {
  return epa.solveNcaafOpponentRatings([board(tieGames(nGames))], {
    asOf: '2026-10-10',
    efficiency,
    minGames: 1,
    priorGames,
    pacePriorGames: priorGames,
    iters: 24,
    hfa: 0,
  });
}

const prev = process.env.OMEGA_NCAAF_RETPROD;
try {
  delete process.env.OMEGA_NCAAF_RETPROD;
  // priorGames 0 makes the seed weight 0. The multiplier cannot move the fit.
  const open = solve(0, 1);
  process.env.OMEGA_NCAAF_RETPROD = '0';
  const shut = solve(0, 1);
  assert.deepStrictEqual(open.byId, shut.byId);

  delete process.env.OMEGA_NCAAF_RETPROD;
  const early = solve(2, 1);
  const later = solve(2, 12);
  const earlyGap = strengthGap(early);
  const laterGap = strengthGap(later);
  assert.ok(earlyGap > 2, `one game should keep a seed gap, got ${earlyGap}`);
  assert.ok(laterGap > 0, `twelve ties still remember a little seed, got ${laterGap}`);
  assert.ok(laterGap < earlyGap / 2, `in-season ties must take over, ${laterGap} vs ${earlyGap}`);

  process.env.OMEGA_NCAAF_RETPROD = '0';
  assert.strictEqual(config.ncaafRetProdMultiplier(0), 1);
  assert.strictEqual(epa.ncaafRetProdPriorMultiplier(USM), 1);
  assert.strictEqual(epa.ncaafRetProdPriorMultiplier(ND), 1);
  const disabled = solve(40, 1);
  assert.strictEqual(strengthGap(disabled), 0);
  delete process.env.OMEGA_NCAAF_RETPROD;
  const enabled = solve(40, 1);
  assert.ok(strengthGap(enabled) > 5, strengthGap(enabled));
} finally {
  if (prev == null) delete process.env.OMEGA_NCAAF_RETPROD;
  else process.env.OMEGA_NCAAF_RETPROD = prev;
}

console.log('test-omega-ncaaf-retprod: ok');
