'use strict';
/**
 * MLB total level. Root fix is the fixed 2026 environment gap.
 * Recenter replaces that gap with the slate mean of (model − sharp no-vig
 * total) when at least 3 games have a sharp total. n < 3 uses the prior
 * once. Both toggles off is the unshifted engine.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const mlb = require(path.join(root, 'sports/mlb'));
const env = require(path.join(root, 'sports/mlb_env'));
const { totalCoverProb, blendWithMarket } = require(path.join(root, 'sports/_common'));
const { noVigPinnacleCircaImplied, collectMarketOutcomes } = require(path.join(root, 'edge'));

const PRIOR = env.MLB_TOTAL_PRIOR_OFFSET;
assert.strictEqual(PRIOR, 1.185);
assert.strictEqual(env.MLB_TOTAL_RECENTER_MIN, 3);

function withFlags(rootfix, recenter, fn) {
  const prevRoot = process.env.OMEGA_MLB_ROOTFIX;
  const prevRec = process.env.OMEGA_MLB_TOTAL_RECENTER;
  process.env.OMEGA_MLB_ROOTFIX = rootfix;
  process.env.OMEGA_MLB_TOTAL_RECENTER = recenter;
  try {
    return fn();
  } finally {
    if (prevRoot == null) delete process.env.OMEGA_MLB_ROOTFIX;
    else process.env.OMEGA_MLB_ROOTFIX = prevRoot;
    if (prevRec == null) delete process.env.OMEGA_MLB_TOTAL_RECENTER;
    else process.env.OMEGA_MLB_TOTAL_RECENTER = prevRec;
  }
}

function event(home, away, total, books) {
  const keys = books || ['pinnacle', 'draftkings'];
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-09-22T23:10:00Z',
    bookmakers: keys.map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -120 }, { name: away, price: 100 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -1.5 },
          { name: away, price: -110, point: 1.5 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ]},
      ],
    })),
  };
}

function totalsOf(cands) {
  const out = [];
  const seen = new Set();
  for (const c of cands) {
    if (c.market !== 'Total' || !/^Over/.test(c.side)) continue;
    const key = `${c.awayTeam}|${c.homeTeam}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Sharp line: Pinnacle and Circa averaged. Other sharp books only if both are missing.
{
  const pinOnly = event('Los Angeles Dodgers', 'San Francisco Giants', 8.5);
  assert.strictEqual(env.sharpNoVigTotal(pinOnly), 8.5);
  const both = {
    home_team: 'A',
    away_team: 'B',
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 8 }] }] },
      { key: 'circa', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 9 }] }] },
      { key: 'draftkings', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 6 }] }] },
    ],
  };
  assert.strictEqual(env.sharpNoVigTotal(both), 8.5);
  const bookOnly = {
    home_team: 'A',
    away_team: 'B',
    bookmakers: [
      { key: 'bookmaker', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 7.5 }] }] },
      { key: 'draftkings', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 9 }] }] },
    ],
  };
  assert.strictEqual(env.sharpNoVigTotal(bookOnly), 7.5);
  assert.strictEqual(env.sharpNoVigTotal({
    home_team: 'A', away_team: 'B',
    bookmakers: [{ key: 'draftkings', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 9 }] }] }],
  }), null);
}

// Shift math. Root fix is the prior. Recenter with n>=3 is the slate mean
// of the raw gap, not prior + mean. n<3 is the prior once.
{
  const rows = [
    { total: 9, sharp: 8 },
    { total: 8, sharp: 7 },
    { total: 9, sharp: 8.5 },
  ];
  const rawMean = mean(rows.map(r => r.total - r.sharp));
  assert.ok(Math.abs(rawMean - (1 + 1 + 0.5) / 3) < 1e-12);
  assert.strictEqual(env.mlbTotalLevelShift(rows, { rootfix: false, recenter: false }), 0);
  assert.strictEqual(env.mlbTotalLevelShift(rows, { rootfix: true, recenter: false }), PRIOR);
  const both = env.mlbTotalLevelShift(rows, { rootfix: true, recenter: true });
  const recOnly = env.mlbTotalLevelShift(rows, { rootfix: false, recenter: true });
  assert.ok(Math.abs(both - rawMean) < 1e-12, both);
  assert.ok(Math.abs(recOnly - rawMean) < 1e-12, recOnly);
  assert.ok(Math.abs(both - (PRIOR + rawMean)) > 0.5, 'prior is not stacked on the slate mean');

  const short = rows.slice(0, 2);
  const shortMean = mean(short.map(r => r.total - r.sharp));
  assert.ok(Math.abs(shortMean - 1) < 1e-12);
  assert.notStrictEqual(PRIOR, shortMean);
  assert.strictEqual(env.mlbTotalLevelShift(short, { rootfix: true, recenter: true }), PRIOR);
  assert.strictEqual(env.mlbTotalLevelShift(short, { rootfix: false, recenter: true }), PRIOR);
  assert.strictEqual(env.mlbTotalLevelShift(short, { rootfix: true, recenter: false }), PRIOR);
  assert.strictEqual(env.mlbTotalLevelShift(short, { rootfix: false, recenter: false }), 0);
  assert.strictEqual(env.mlbTotalLevelShift([
    { total: 9, sharp: null },
    { total: 8, sharp: null },
    { total: 9, sharp: null },
  ], { rootfix: false, recenter: true }), PRIOR);
}

// Flags are read at call time. "0" and "off" disable. Default is on.
{
  assert.strictEqual(env.mlbToggleOn('OMEGA_MLB_ROOTFIX'), true);
  assert.deepStrictEqual(withFlags('0', 'off', () => env.mlbTotalFlags()), { rootfix: false, recenter: false });
  assert.deepStrictEqual(withFlags('off', '0', () => env.mlbTotalFlags()), { rootfix: false, recenter: false });
  assert.deepStrictEqual(withFlags('1', 'on', () => env.mlbTotalFlags()), { rootfix: true, recenter: true });
}

function slate() {
  return {
    oddsEvents: [
      event('Los Angeles Dodgers', 'Colorado Rockies', 8),
      event('Atlanta Braves', 'New York Mets', 7),
      event('Seattle Mariners', 'Tampa Bay Rays', 8.5),
    ],
    standings: {
      'Los Angeles Dodgers': { pf: 5, pa: 4, wins: 90, losses: 60 },
      'Colorado Rockies': { pf: 5, pa: 4, wins: 60, losses: 90 },
      'Atlanta Braves': { pf: 4, pa: 4, wins: 80, losses: 70 },
      'New York Mets': { pf: 4, pa: 4, wins: 70, losses: 80 },
      'Seattle Mariners': { pf: 4.5, pa: 4.5, wins: 85, losses: 65 },
      'Tampa Bay Rays': { pf: 4.5, pa: 4.5, wins: 80, losses: 70 },
    },
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  };
}

function rawTotal(homePf, homePa, awayPf, awayPa) {
  return env.mlbStandingsEnv(
    { pf: homePf, pa: homePa, wins: 80, losses: 70 },
    { pf: awayPf, pa: awayPa, wins: 80, losses: 70 }
  ).modelTotal;
}

// Toggles off match the unshifted standings total. Spread and moneyline
// do not move when the total level moves.
{
  const input = slate();
  const off = withFlags('0', 'off', () => mlb.project(input));
  const expected = [
    rawTotal(5, 4, 5, 4),
    rawTotal(4, 4, 4, 4),
    rawTotal(4.5, 4.5, 4.5, 4.5),
  ];
  const offTotals = totalsOf(off);
  assert.strictEqual(offTotals.length, 3);
  offTotals.forEach((c, i) => {
    assert.strictEqual(c.modelProjection, +expected[i].toFixed(2));
  });
  const lines = [8, 7, 8.5];
  const gaps = offTotals.map((c, i) => c.modelProjection - lines[i]);
  const shift = mean(gaps.map((g, i) => expected[i] - lines[i]));
  // Rounded projection gap can differ from the raw mean by a cent.
  assert.ok(Math.abs(mean(gaps) - shift) < 0.02, mean(gaps));

  const on = withFlags('1', '1', () => mlb.project(input));
  const onTotals = totalsOf(on);
  const onGaps = onTotals.map((c, i) => c.modelProjection - lines[i]);
  assert.ok(Math.abs(mean(onGaps)) < 0.02, `slate mean bias ${mean(onGaps)}`);
  const spreadBefore = offTotals.map((c, i) => offTotals[i].modelProjection);
  // Opinions: differences between games survive the de-mean.
  const dOff = offTotals[0].modelProjection - offTotals[1].modelProjection;
  const dOn = onTotals[0].modelProjection - onTotals[1].modelProjection;
  assert.ok(Math.abs(dOff - dOn) < 0.021, `${dOff} vs ${dOn}`);
  assert.ok(Math.abs((offTotals[2].modelProjection - offTotals[1].modelProjection)
    - (onTotals[2].modelProjection - onTotals[1].modelProjection)) < 0.021);

  for (const market of ['Moneyline', 'Spread']) {
    const a = off.filter(c => c.market === market).map(c => c.modelProjection);
    const b = on.filter(c => c.market === market).map(c => c.modelProjection);
    assert.deepStrictEqual(b, a, market);
  }
  const mlOff = off.filter(c => c.market === 'Moneyline').map(c => c.modelRawP);
  const mlOn = on.filter(c => c.market === 'Moneyline').map(c => c.modelRawP);
  assert.deepStrictEqual(mlOn, mlOff);

  // Root fix alone subtracts the prior, not this slate's mean.
  const rootOnly = withFlags('on', '0', () => totalsOf(mlb.project(input)));
  rootOnly.forEach((c, i) => {
    const shifted = env.applyMlbTotalShift(expected[i], PRIOR);
    assert.strictEqual(c.modelProjection, +shifted.toFixed(2));
  });
  assert.ok(Math.abs(mean(rootOnly.map((c, i) => c.modelProjection - lines[i]))) > 0.2);

  // Recenter alone matches both-on on a slate with n>=3.
  const recOnly = withFlags('0', 'on', () => totalsOf(mlb.project(input)).map(c => c.modelProjection));
  assert.deepStrictEqual(recOnly, onTotals.map(c => c.modelProjection));
  void spreadBefore;
}

// n<3 uses the prior, not the two-game mean. "off" spelling disables.
{
  const input = {
    oddsEvents: [
      event('Los Angeles Dodgers', 'Colorado Rockies', 7.5),
      event('Atlanta Braves', 'New York Mets', 10.5),
    ],
    standings: {},
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  };
  const off = withFlags('off', 'off', () => totalsOf(mlb.project(input)));
  assert.strictEqual(off[0].modelProjection, 8.6);
  assert.strictEqual(off[1].modelProjection, 8.6);
  const twoGameMean = mean([8.6 - 7.5, 8.6 - 10.5]);
  assert.ok(Math.abs(twoGameMean - PRIOR) > 0.2);
  const on = withFlags('on', 'on', () => totalsOf(mlb.project(input)));
  const priced = +env.applyMlbTotalShift(8.6, PRIOR).toFixed(2);
  assert.strictEqual(on[0].modelProjection, priced);
  assert.strictEqual(on[1].modelProjection, priced);
  assert.notStrictEqual(priced, +env.applyMlbTotalShift(8.6, twoGameMean).toFixed(2));

  // One game, no sharp book: still the prior (n<3), and the over is priced
  // from the shifted total.
  const lone = event('Los Angeles Dodgers', 'San Francisco Giants', 8.5, ['draftkings', 'fanduel']);
  assert.strictEqual(env.sharpNoVigTotal(lone), null);
  const loneOn = withFlags('1', '1', () => mlb.project({
    oddsEvents: [lone], standings: {}, parkFactors: {}, mlbPitcherStats: {}, espnGames: [],
  }));
  const over = loneOn.find(c => c.market === 'Total' && /^Over/.test(c.side));
  assert.strictEqual(over.modelProjection, priced);
  const bundles = collectMarketOutcomes(lone, 'totals');
  const anchor = noVigPinnacleCircaImplied(bundles, bundles.find(b => b.side === 'Over'));
  const p = blendWithMarket(totalCoverProb(env.applyMlbTotalShift(8.6, PRIOR), 8.5, 'Over', 'MLB'), anchor, 0.45);
  assert.ok(Math.abs(over.modelRawP - p) < 1e-9);

  const loneOff = withFlags('0', '0', () => mlb.project({
    oddsEvents: [lone], standings: {}, parkFactors: {}, mlbPitcherStats: {}, espnGames: [],
  }));
  const overOff = loneOff.find(c => c.market === 'Total' && /^Over/.test(c.side));
  assert.strictEqual(overOff.modelProjection, 8.6);
  const pOff = blendWithMarket(totalCoverProb(8.6, 8.5, 'Over', 'MLB'), anchor, 0.45);
  assert.ok(Math.abs(overOff.modelRawP - pOff) < 1e-9);
  assert.ok(Math.abs(over.modelRawP - overOff.modelRawP) > 1e-4);
}

// Default (env unset) is on, and a 1-game slate takes the prior.
{
  const savedR = process.env.OMEGA_MLB_ROOTFIX;
  const savedC = process.env.OMEGA_MLB_TOTAL_RECENTER;
  delete process.env.OMEGA_MLB_ROOTFIX;
  delete process.env.OMEGA_MLB_TOTAL_RECENTER;
  try {
    assert.deepStrictEqual(env.mlbTotalFlags(), { rootfix: true, recenter: true });
    const cands = mlb.project({
      oddsEvents: [event('Los Angeles Dodgers', 'San Francisco Giants', 8)],
      standings: {},
      parkFactors: {},
      mlbPitcherStats: {},
      espnGames: [],
    });
    const over = cands.find(c => c.market === 'Total' && /^Over/.test(c.side));
    assert.strictEqual(over.modelProjection, +env.applyMlbTotalShift(8.6, PRIOR).toFixed(2));
    const spread = cands.find(c => c.market === 'Spread');
    assert.strictEqual(spread.modelProjection, 0.12);
  } finally {
    if (savedR == null) delete process.env.OMEGA_MLB_ROOTFIX;
    else process.env.OMEGA_MLB_ROOTFIX = savedR;
    if (savedC == null) delete process.env.OMEGA_MLB_TOTAL_RECENTER;
    else process.env.OMEGA_MLB_TOTAL_RECENTER = savedC;
  }
}

console.log('PASS test-omega-mlb-total-center');
