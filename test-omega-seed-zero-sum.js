'use strict';

/**
 * NFL and NCAAF EPA seeds are zero-sum after load.
 * Raw JSON stays the source of truth. centerSeed shifts
 * off' = off - d/2, def' = def + d/2, d = mean(off) - mean(def).
 * Margins do not move. An average pair adds nothing to the total.
 * Success rates get the same shift: defSuccess is higher-is-better,
 * and successTotalAdj's environment term is (mean off - mean def) * 12.
 */

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const epa = require(path.join(root, 'sports/epa'));
const ingest = require(path.join(root, 'ingest'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.13-omega-vnext-nhl-engine');
assert.strictEqual(epa.SIERRA_W, 0.2);
assert.strictEqual(epa.SPORT_CFG.NFL.plays, 62);
assert.strictEqual(epa.SPORT_CFG.NFL.baseTotal, 45);
assert.strictEqual(epa.SPORT_CFG.NCAAF.plays, 68);
assert.strictEqual(epa.SPORT_CFG.NCAAF.baseTotal, 52);

const nflFile = require(path.join(root, 'sports/data/nfl-epa-seed.json'));
const cfbFile = require(path.join(root, 'sports/data/cfb-epa-seed.json'));

function strip(table) {
  const out = {};
  for (const [key, row] of Object.entries(table)) {
    if (!key || key.startsWith('_')) continue;
    out[key] = row;
  }
  return out;
}

function teamNames(table) {
  return Object.keys(table).filter((key) => key && !key.startsWith('_'));
}

function columnMean(table, field) {
  const vals = [];
  for (const name of teamNames(table)) {
    const n = Number(table[name][field]);
    if (Number.isFinite(n)) vals.push(n);
  }
  assert.ok(vals.length > 0, field);
  return vals.reduce((sum, n) => sum + n, 0) / vals.length;
}

function meanGap(table, offKey, defKey) {
  return columnMean(table, offKey) - columnMean(table, defKey);
}

function maxMarginDelta(sport, raw, centered) {
  let max = 0;
  let worst = '';
  const names = teamNames(raw);
  for (const home of names) {
    for (const away of names) {
      if (home === away) continue;
      const before = epa.footballProjection({
        sport, home, away, standings: {}, efficiency: raw,
      });
      const after = epa.footballProjection({
        sport, home, away, standings: {}, efficiency: centered,
      });
      const diff = Math.abs(before.modelMargin - after.modelMargin);
      if (diff > max) {
        max = diff;
        worst = `${away} @ ${home}`;
      }
    }
  }
  return { max, worst, pairs: names.length * (names.length - 1) };
}

function assertAveragePair(sport, table) {
  const cfg = epa.SPORT_CFG[sport];
  const home = sport === 'NFL' ? 'Kansas City Chiefs' : 'Ohio State Buckeyes';
  const away = sport === 'NFL' ? 'Buffalo Bills' : 'Georgia Bulldogs';
  const row = {
    offEpa: columnMean(table, 'offEpa'),
    defEpa: columnMean(table, 'defEpa'),
    offSuccess: columnMean(table, 'offSuccess'),
    defSuccess: columnMean(table, 'defSuccess'),
  };
  const efficiency = { [home]: { ...row }, [away]: { ...row } };
  const proj = epa.footballProjection({
    sport, home, away, standings: {}, efficiency,
  });
  const success = epa.successTotalAdj(efficiency[home], efficiency[away]);
  assert.strictEqual(proj.usedEpa, true, sport);
  assert.ok(
    Math.abs(proj.modelTotal - (cfg.baseTotal + success)) < 1e-9,
    `${sport} total ${proj.modelTotal} vs base+success ${cfg.baseTotal + success}`
  );
  assert.ok(
    Math.abs(proj.modelTotal - cfg.baseTotal) < 0.3,
    `${sport} average pair ${proj.modelTotal} vs base ${cfg.baseTotal} (success ${success})`
  );
}

const rawNfl = strip(nflFile);
const rawCfb = strip(cfbFile);
const chiefOff = nflFile['Kansas City Chiefs'].offEpa;
const techOff = cfbFile['Texas Tech Red Raiders'].offEpa;

const loaded = ingest.loadEfficiencySeeds();
const centeredNfl = epa.centerSeed(rawNfl);
const centeredCfb = epa.centerSeed(rawCfb);

assert.strictEqual(nflFile['Kansas City Chiefs'].offEpa, chiefOff, 'raw NFL file must stay raw');
assert.strictEqual(cfbFile['Texas Tech Red Raiders'].offEpa, techOff, 'raw NCAAF file must stay raw');
assert.strictEqual(techOff, 0.08);

assert.strictEqual(nflFile._meta.centered.method, 'load-time symmetric zero-sum');
assert.strictEqual(cfbFile._meta.centered.method, 'load-time symmetric zero-sum');
assert.strictEqual(nflFile._meta.centered.date, '2026-10-05');
assert.strictEqual(cfbFile._meta.centered.date, '2026-10-05');
assert.ok(!loaded.NFL._meta && !loaded.NCAAF._meta);

const nflStats = epa.seedCenterStats(rawNfl);
const cfbStats = epa.seedCenterStats(rawCfb);
assert.strictEqual(nflStats.success.applied, true, nflStats.success.reason);
assert.strictEqual(cfbStats.success.applied, true, cfbStats.success.reason);
assert.ok(Math.abs(nflFile._meta.centered.dEpa - nflStats.epa.d) < 1e-12);
assert.ok(Math.abs(cfbFile._meta.centered.dEpa - cfbStats.epa.d) < 1e-12);
assert.ok(Math.abs(nflFile._meta.centered.dSuccess - nflStats.success.d) < 1e-12);
assert.ok(Math.abs(cfbFile._meta.centered.dSuccess - cfbStats.success.d) < 1e-12);

assert.ok(Math.abs(meanGap(loaded.NFL, 'offEpa', 'defEpa')) < 1e-9, 'NFL off-def');
assert.ok(Math.abs(meanGap(loaded.NCAAF, 'offEpa', 'defEpa')) < 1e-9, 'NCAAF off-def');
assert.ok(Math.abs(meanGap(loaded.NFL, 'offSuccess', 'defSuccess')) < 1e-9, 'NFL success');
assert.ok(Math.abs(meanGap(loaded.NCAAF, 'offSuccess', 'defSuccess')) < 1e-9, 'NCAAF success');
assert.ok(meanGap(rawNfl, 'offEpa', 'defEpa') > 0.02);
assert.ok(meanGap(rawCfb, 'offEpa', 'defEpa') > 0.06);

for (const name of teamNames(centeredNfl)) {
  assert.strictEqual(loaded.NFL[name].offEpa, centeredNfl[name].offEpa, name);
  assert.strictEqual(loaded.NFL[name].defEpa, centeredNfl[name].defEpa, name);
  assert.strictEqual(loaded.NFL[name].offSuccess, centeredNfl[name].offSuccess, name);
  assert.strictEqual(loaded.NFL[name].defSuccess, centeredNfl[name].defSuccess, name);
}
for (const name of teamNames(centeredCfb)) {
  assert.strictEqual(loaded.NCAAF[name].offEpa, centeredCfb[name].offEpa, name);
  assert.strictEqual(loaded.NCAAF[name].defEpa, centeredCfb[name].defEpa, name);
  assert.strictEqual(loaded.NCAAF[name].offSuccess, centeredCfb[name].offSuccess, name);
  assert.strictEqual(loaded.NCAAF[name].defSuccess, centeredCfb[name].defSuccess, name);
}
assert.strictEqual(loaded.NCAAF['Ohio State Buckeyes'].talent, 2.4);

const twice = epa.centerSeed(centeredCfb);
assert.ok(Math.abs(twice['Texas Tech Red Raiders'].offEpa - centeredCfb['Texas Tech Red Raiders'].offEpa) < 1e-12);

const nflMargins = maxMarginDelta('NFL', rawNfl, centeredNfl);
const cfbMargins = maxMarginDelta('NCAAF', rawCfb, centeredCfb);
assert.ok(nflMargins.max < 1e-9, `NFL margin ${nflMargins.max} ${nflMargins.worst}`);
assert.ok(cfbMargins.max < 1e-9, `NCAAF margin ${cfbMargins.max} ${cfbMargins.worst}`);
assert.strictEqual(nflMargins.pairs, 32 * 31);
assert.ok(cfbMargins.pairs >= 52 * 51);

assertAveragePair('NFL', loaded.NFL);
assertAveragePair('NCAAF', loaded.NCAAF);

// Texas Tech @ Colorado, both clubs Sierra-blended. The EPA piece is
// (1 - SIERRA_W) * 2 * d * plays ≈ 7.28. Success is not blended by Sierra,
// so centering it drops every pair by dSuccess * 12 on top of that.
{
  const home = 'Colorado Buffaloes';
  const away = 'Texas Tech Red Raiders';
  const standings = {
    [home]: { pf: 112, pa: 96, games: 4 },
    [away]: { pf: 152, pa: 80, games: 4 },
  };
  const cfg = epa.SPORT_CFG.NCAAF;
  assert.strictEqual(epa.sierraAdjust(rawCfb[home], standings[home], cfg).adjusted, true);
  assert.strictEqual(epa.sierraAdjust(rawCfb[away], standings[away], cfg).adjusted, true);
  const before = epa.footballProjection({
    sport: 'NCAAF', home, away, standings, efficiency: rawCfb,
  });
  const after = epa.footballProjection({
    sport: 'NCAAF', home, away, standings, efficiency: centeredCfb,
  });
  assert.strictEqual(before.usedEpa, true);
  assert.strictEqual(after.usedEpa, true);
  assert.ok(before.modelTotal < cfg.totalMax - 1 && before.modelTotal > cfg.totalMin + 1);
  assert.ok(after.modelTotal < cfg.totalMax - 1 && after.modelTotal > cfg.totalMin + 1);
  assert.ok(Math.abs(before.modelMargin - after.modelMargin) < 1e-9);
  const drop = before.modelTotal - after.modelTotal;
  const epaDrop = (1 - epa.SIERRA_W) * 2 * cfbStats.epa.d * cfg.plays;
  const successDrop = cfbStats.success.d * 12;
  assert.ok(Math.abs(epaDrop - 7.3) < 0.1, `EPA sierra drop ${epaDrop}`);
  assert.ok(
    Math.abs(drop - (epaDrop + successDrop)) < 1e-6,
    `drop ${drop} vs ${epaDrop + successDrop}`
  );
  assert.ok(Math.abs(drop - 7.3) < 0.5, `Texas Tech @ Colorado drop ${drop}`);
}

console.log('PASS test-omega-seed-zero-sum', {
  NFL: {
    dEpa: nflStats.epa.d,
    dSuccess: nflStats.success.d,
    success: nflStats.success.reason,
    marginDelta: nflMargins.max,
    pairs: nflMargins.pairs,
  },
  NCAAF: {
    dEpa: cfbStats.epa.d,
    dSuccess: cfbStats.success.d,
    success: cfbStats.success.reason,
    marginDelta: cfbMargins.max,
    pairs: cfbMargins.pairs,
  },
});
