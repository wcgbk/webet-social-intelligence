'use strict';
/**
 * ESPN football pointsFor/pointsAgainst are season sums.
 * sierraAdjust divides whenever gp >= 2. No magnitude cutoff.
 * Synthetic rows only. No network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const epa = require(path.join(root, 'sports/epa'));
const ingest = require(path.join(root, 'ingest'));
const { powerFromStandings, gamesPlayed } = require(path.join(root, 'sports/_common'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.17-omega-vnext-cal-b');
assert.strictEqual(epa.sierraWeight(2, epa.SPORT_CFG.NFL), 0.2);
assert.strictEqual(epa.sierraWeight(2, epa.SPORT_CFG.NCAAF), 0.2);

const nfl = epa.SPORT_CFG.NFL;
const cfb = epa.SPORT_CFG.NCAAF;

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} vs ${expected}`);
}

function blend(seed, pfPg, paPg, cfg, gp) {
  const w = epa.sierraWeight(gp, cfg);
  return {
    offEpa: (1 - w) * seed.offEpa + w * ((pfPg - cfg.leaguePpg) / cfg.plays),
    defEpa: (1 - w) * seed.defEpa + w * ((cfg.leaguePpg - paPg) / cfg.plays),
  };
}

/** Commit 3ac7894: divide both sides only when either side is above 55. */
function rates3ac7894(row) {
  const g = gamesPlayed(row);
  let pfPg = Number(row.pf);
  let paPg = Number(row.pa);
  const divided = pfPg > 55 || paPg > 55;
  if (divided) {
    pfPg /= g;
    paPg /= g;
  }
  return { pfPg, paPg, divided, g };
}

function legacyStandings(table) {
  const out = {};
  for (const [name, row] of Object.entries(table)) {
    const rates = rates3ac7894(row);
    out[name] = { ...row, avgPointsFor: rates.pfPg, avgPointsAgainst: rates.paPg };
  }
  return out;
}

const zero = { offEpa: 0, defEpa: 0 };

// Giants pf 46 pa 55, W2 L1 → 15.33 / 18.33 and adjusted.
{
  const row = { pf: 46, pa: 55, wins: 2, losses: 1 };
  assert.strictEqual(gamesPlayed(row), 3);
  const got = epa.sierraAdjust(zero, row, nfl);
  const expect = blend(zero, 46 / 3, 55 / 3, nfl, 3);
  assert.strictEqual(got.adjusted, true);
  assert.strictEqual((46 / 3).toFixed(2), '15.33');
  assert.strictEqual((55 / 3).toFixed(2), '18.33');
  close(got.offEpa, expect.offEpa, 'giants off');
  close(got.defEpa, expect.defEpa, 'giants def');
  assert.ok(got.offEpa < 0, '15.33 ppg is below the NFL league rate');
  const misread = blend(zero, 46, 55, nfl, 3);
  assert.ok(Math.abs(got.offEpa - misread.offEpa) > 0.05);
}

// Same Giants with gp=4 (W2 L2) → 11.5 / 13.75.
{
  const row = { pf: 46, pa: 55, wins: 2, losses: 2 };
  assert.strictEqual(gamesPlayed(row), 4);
  const got = epa.sierraAdjust(zero, row, nfl);
  const expect = blend(zero, 11.5, 13.75, nfl, 4);
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, expect.offEpa, 'giants gp4 off');
  close(got.defEpa, expect.defEpa, 'giants gp4 def');
}

// Explicit gamesPlayed wins over a different W-L record. games does too.
{
  const byField = epa.sierraAdjust(zero, { pf: 46, pa: 55, wins: 2, losses: 1, gamesPlayed: 4 }, nfl);
  const byGames = epa.sierraAdjust(zero, { pf: 46, pa: 55, wins: 2, losses: 1, games: 4 }, nfl);
  const expect = blend(zero, 11.5, 13.75, nfl, 4);
  assert.strictEqual(byField.adjusted, true);
  close(byField.offEpa, expect.offEpa, 'gamesPlayed field');
  close(byGames.offEpa, expect.offEpa, 'games field');
  close(byField.defEpa, expect.defEpa, 'gamesPlayed def');
}

// Ties count when ESPN did not store a game count.
{
  const row = { pf: 46, pa: 55, wins: 2, losses: 1, ties: 1 };
  assert.strictEqual(gamesPlayed(row), 4);
  const got = epa.sierraAdjust(zero, row, nfl);
  close(got.offEpa, blend(zero, 11.5, 13.75, nfl, 4).offEpa, 'ties');
}

// Patriots 36/51 gp=3 → 12 / 17.
{
  const row = { pf: 36, pa: 51, wins: 1, losses: 2 };
  const got = epa.sierraAdjust(zero, row, nfl);
  const expect = blend(zero, 12, 17, nfl, 3);
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, expect.offEpa, 'patriots off');
  close(got.defEpa, expect.defEpa, 'patriots def');
  assert.ok(got.offEpa < zero.offEpa);
}

// gp=1 → no adjustment, even if an explicit gamesPlayed says 1.
{
  const seed = { offEpa: 0.08, defEpa: -0.02, offSuccess: 0.45 };
  const one = epa.sierraAdjust(seed, { pf: 36, pa: 51, wins: 1, losses: 0 }, nfl);
  assert.strictEqual(one.adjusted, false);
  assert.strictEqual(one.offEpa, 0.08);
  assert.strictEqual(one.defEpa, -0.02);
  assert.strictEqual(one.offSuccess, 0.45);
  const tagged = epa.sierraAdjust(seed, { pf: 92, pa: 78, wins: 4, losses: 3, gamesPlayed: 1 }, nfl);
  assert.strictEqual(tagged.adjusted, false);
  assert.strictEqual(tagged.offEpa, seed.offEpa);
}

// High-scoring club (92/78 gp=3) matches 3ac7894, which already divided both.
{
  const seed = { offEpa: 0.05, defEpa: 0.02 };
  const row = { pf: 92, pa: 78, wins: 2, losses: 1 };
  const rates = rates3ac7894(row);
  assert.strictEqual(rates.divided, true);
  close(rates.pfPg, 92 / 3, 'ravens pf');
  close(rates.paPg, 78 / 3, 'ravens pa');
  const got = epa.sierraAdjust(seed, row, nfl);
  const expect = blend(seed, rates.pfPg, rates.paPg, nfl, 3);
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, expect.offEpa, 'ravens off unchanged');
  close(got.defEpa, expect.defEpa, 'ravens def unchanged');
}

// NCAAF low season sums (both sides <= 55) are divided. 3ac7894 would not.
{
  const row = { pf: 48, pa: 42, wins: 2, losses: 1 };
  const rates = rates3ac7894(row);
  assert.strictEqual(rates.divided, false);
  assert.strictEqual(rates.pfPg, 48);
  const got = epa.sierraAdjust(zero, row, cfb);
  const expect = blend(zero, 48 / 3, 42 / 3, cfb, 3);
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, expect.offEpa, 'ncaaf off');
  close(got.defEpa, expect.defEpa, 'ncaaf def');
  const misread = blend(zero, 48, 42, cfb, 3);
  assert.ok(got.offEpa < misread.offEpa, 'dividing a 48-point season sum lowers offEpa');
}

// A lone avgPointsFor is not a per-game pair. Do not guess.
{
  const row = { pf: 46, pa: 55, wins: 2, losses: 1, avgPointsFor: 30 };
  const got = epa.sierraAdjust(zero, row, nfl);
  close(got.offEpa, blend(zero, 46 / 3, 55 / 3, nfl, 3).offEpa, 'half pair still divides');
}

// Explicit per-game pair is used as the rate and is not divided again.
{
  const seed = { offEpa: 0.12, defEpa: -0.04 };
  const row = {
    pf: 46,
    pa: 55,
    wins: 2,
    losses: 1,
    avgPointsFor: 22,
    avgPointsAgainst: 19,
  };
  const got = epa.sierraAdjust(seed, row, nfl);
  const expect = blend(seed, 22, 19, nfl, 3);
  const divided = blend(seed, 46 / 3, 55 / 3, nfl, 3);
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, expect.offEpa, 'explicit off');
  close(got.defEpa, expect.defEpa, 'explicit def');
  assert.ok(Math.abs(got.offEpa - divided.offEpa) > 1e-6);
}

// Divided rates outside [6, 55] keep the seed.
{
  const seed = { offEpa: 0.04, defEpa: 0.01 };
  const got = epa.sierraAdjust(seed, { pf: 10, pa: 12, wins: 1, losses: 1 }, nfl);
  assert.strictEqual(got.adjusted, false);
  assert.strictEqual(got.offEpa, seed.offEpa);
  assert.strictEqual(got.defEpa, seed.defEpa);
}

function project(sport, home, away, standings) {
  return epa.footballProjection({
    sport,
    home,
    away,
    standings,
    efficiency: {
      [home]: { offEpa: 0.02, defEpa: 0.01 },
      [away]: { offEpa: -0.03, defEpa: 0.04 },
    },
  });
}

// Giants/Patriots-type clubs: the fixed total is lower than the 3ac7894 read.
{
  const home = 'New York Giants';
  const away = 'New England Patriots';
  const standings = {
    [home]: { pf: 46, pa: 55, wins: 2, losses: 1 },
    [away]: { pf: 36, pa: 51, wins: 1, losses: 2 },
  };
  const fixed = project('NFL', home, away, standings);
  const legacy = project('NFL', home, away, legacyStandings(standings));
  assert.strictEqual(fixed.usedEpa, true);
  assert.strictEqual(legacy.usedEpa, true);
  assert.ok(fixed.modelTotal < legacy.modelTotal, `${fixed.modelTotal} vs ${legacy.modelTotal}`);
  assert.ok(legacy.modelTotal - fixed.modelTotal > 5, legacy.modelTotal - fixed.modelTotal);
  assert.ok(fixed.modelTotal > nfl.totalMin && fixed.modelTotal < nfl.totalMax);
}

// One low club against a high club that 3ac7894 already divided. Total still drops.
{
  const home = 'New York Giants';
  const away = 'Baltimore Ravens';
  const standings = {
    [home]: { pf: 46, pa: 55, wins: 2, losses: 1 },
    [away]: { pf: 92, pa: 78, wins: 2, losses: 1 },
  };
  const fixed = project('NFL', home, away, standings);
  const legacy = project('NFL', home, away, legacyStandings(standings));
  assert.ok(fixed.modelTotal < legacy.modelTotal, `${fixed.modelTotal} vs ${legacy.modelTotal}`);
  const bothHigh = {
    'Buffalo Bills': { pf: 92, pa: 78, wins: 2, losses: 1 },
    'Baltimore Ravens': { pf: 88, pa: 70, wins: 2, losses: 1 },
  };
  const highFixed = project('NFL', 'Buffalo Bills', 'Baltimore Ravens', bothHigh);
  const highLegacy = project('NFL', 'Buffalo Bills', 'Baltimore Ravens', legacyStandings(bothHigh));
  close(highFixed.modelTotal, highLegacy.modelTotal, 'high clubs unchanged vs 3ac7894');
}

// NCAAF end to end. Both clubs sit at or under 55, so 3ac7894 kept the sums.
{
  const home = 'Ohio State Buckeyes';
  const away = 'Iowa Hawkeyes';
  const standings = {
    [home]: { pf: 48, pa: 42, wins: 2, losses: 1 },
    [away]: { pf: 51, pa: 39, wins: 2, losses: 1 },
  };
  assert.strictEqual(rates3ac7894(standings[home]).divided, false);
  assert.strictEqual(rates3ac7894(standings[away]).divided, false);
  const fixed = project('NCAAF', home, away, standings);
  const legacy = project('NCAAF', home, away, legacyStandings(standings));
  assert.strictEqual(fixed.usedEpa, true);
  assert.ok(fixed.modelTotal < legacy.modelTotal, `${fixed.modelTotal} vs ${legacy.modelTotal}`);
}

// powerFromStandings: football fallback divides the same way. Other sports do not.
{
  close(
    powerFromStandings({ pf: 46, pa: 55, wins: 2, losses: 1 }, 'NFL'),
    (46 - 55) / 3,
    'giants power'
  );
  close(
    powerFromStandings({ pf: 30, pa: 20, wins: 2, losses: 1 }, 'NFL'),
    10 / 3,
    'small nfl season sum'
  );
  assert.strictEqual(
    powerFromStandings({ pf: 46, pa: 55, wins: 1, losses: 0 }, 'NFL'),
    46 - 55
  );
  assert.strictEqual(
    powerFromStandings({
      pf: 46, pa: 55, wins: 2, losses: 1, avgPointsFor: 20, avgPointsAgainst: 18,
    }, 'NFL'),
    2
  );
  assert.strictEqual(
    powerFromStandings({ pf: 46, pa: 55, wins: 2, losses: 1 }),
    46 - 55
  );
  assert.strictEqual(
    powerFromStandings({ pf: 48, pa: 42, wins: 2, losses: 1 }, 'NCAAF'),
    (48 - 42) / 3
  );
  // MLB/NHL/NBA do not call this. The 1.8× branch stays for those labels.
  assert.strictEqual(
    powerFromStandings({ pf: 5.2, pa: 4.1, wins: 10, losses: 8 }, 'MLB'),
    5.2 - 4.1
  );
  close(
    powerFromStandings({ pf: 90, pa: 70, wins: 10, losses: 8 }, 'MLB'),
    (90 - 70) / 18,
    'mlb season branch'
  );
  close(
    powerFromStandings({ pf: 40, pa: 30, wins: 10, losses: 8 }, 'NHL'),
    (40 - 30) / 18,
    'nhl season branch'
  );
  assert.strictEqual(
    powerFromStandings({ pf: 4, pa: 3, wins: 10, losses: 8 }, 'NHL'),
    1
  );
}

// Ingest stores gamesPlayed for football only, and does not replace pf/pa.
{
  const row = ingest.applyFootballStandingExtras(
    { pf: 46, pa: 55, wins: 2, losses: 1 },
    [
      { name: 'pointsFor', value: 46 },
      { name: 'pointsAgainst', value: 55 },
      { name: 'wins', value: 2 },
      { name: 'losses', value: 1 },
      { name: 'gamesPlayed', value: 3 },
    ]
  );
  assert.strictEqual(row.pf, 46);
  assert.strictEqual(row.pa, 55);
  assert.strictEqual(row.gamesPlayed, 3);
  assert.strictEqual(row.games, 3);
  assert.strictEqual(row.avgPointsFor, undefined);

  const bare = ingest.applyFootballStandingExtras(
    { pf: 46, pa: 55, wins: 2, losses: 1 },
    [
      { name: 'pointsFor', value: 46 },
      { name: 'pointsAgainst', value: 55 },
      { name: 'wins', value: 2 },
      { name: 'losses', value: 1 },
    ]
  );
  assert.strictEqual(bare.games, undefined);
  assert.strictEqual(bare.gamesPlayed, undefined);

  const avg = ingest.applyFootballStandingExtras({ pf: 46, pa: 55, wins: 2, losses: 1 }, [
    { name: 'pointsFor', value: 46 },
    { name: 'pointsAgainst', value: 55 },
    { name: 'avgPointsFor', value: 15.3 },
    { name: 'avgPointsAgainst', value: 18.3 },
    { name: 'gamesPlayed', value: 3 },
  ]);
  assert.strictEqual(avg.pf, 46);
  assert.strictEqual(avg.avgPointsFor, 15.3);
  assert.strictEqual(avg.avgPointsAgainst, 18.3);
  const used = epa.sierraAdjust(zero, avg, nfl);
  close(used.offEpa, blend(zero, 15.3, 18.3, nfl, 3).offEpa, 'ingested avg');

  const half = ingest.applyFootballStandingExtras({ pf: 46, pa: 55 }, [
    { name: 'avgPointsFor', value: 15.3 },
    { name: 'gamesPlayed', value: 3 },
  ]);
  assert.strictEqual(half.avgPointsFor, undefined);
  assert.strictEqual(half.gamesPlayed, 3);

  const src = fs.readFileSync(path.join(root, 'ingest.js'), 'utf8');
  assert.ok(src.includes("else if (label === 'NFL' || label === 'NCAAF') applyFootballStandingExtras"));
  assert.ok(src.includes("if (label === 'NHL') applyNhlStandingStats"));
}

console.log('test-omega-points-season-sums: ok');
