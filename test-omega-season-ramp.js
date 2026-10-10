'use strict';

/**
 * Season label on NFL/NCAAF EPA seeds, and the in-season Sierra ramp.
 * w(gp) = 0 for gp < 2, 0.20 at gp = 2, linear to 0.50 at midseason, cap 0.50.
 * NFL midseason gp = 9. NCAAF midseason gp = 6.
 * The season label does not change projections. A 2027 card date warns.
 */

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const epa = require(path.join(root, 'sports/epa'));
const ingest = require(path.join(root, 'ingest'));
const { gamesPlayed } = require(path.join(root, 'sports/_common'));
const { clamp } = require(path.join(root, 'odds_math'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.19-omega-vnext-parlay-decorr');

const nfl = epa.SPORT_CFG.NFL;
const cfb = epa.SPORT_CFG.NCAAF;

function close(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} vs ${expected}`);
}

assert.strictEqual(nfl.sierraMidseasonGp, 9);
assert.strictEqual(cfb.sierraMidseasonGp, 6);
assert.strictEqual(epa.SIERRA_W_GP2, 0.2);
assert.strictEqual(epa.SIERRA_W_CAP, 0.5);

assert.strictEqual(epa.sierraWeight(1, nfl), 0);
assert.strictEqual(epa.sierraWeight(1, cfb), 0);
assert.strictEqual(epa.sierraWeight(2, nfl), 0.2);
assert.strictEqual(epa.sierraWeight(2, cfb), 0.2);
assert.strictEqual(epa.sierraWeight(9, nfl), 0.5);
assert.strictEqual(epa.sierraWeight(17, nfl), 0.5);
assert.strictEqual(epa.sierraWeight(6, cfb), 0.5);
assert.strictEqual(epa.sierraWeight(12, cfb), 0.5);

function assertMonotonic(cfg, mid, maxGp) {
  let prev = -1;
  for (let g = 0; g <= maxGp; g += 1) {
    const w = epa.sierraWeight(g, cfg);
    assert.ok(w + 1e-12 >= prev, `gp ${g} weight ${w} dropped below ${prev}`);
    assert.ok(w <= 0.5 + 1e-12, `gp ${g} weight ${w} above the cap`);
    if (g > 2 && g <= mid) {
      assert.ok(w > prev + 1e-9, `gp ${g} should rise before midseason`);
    }
    prev = w;
  }
}
assertMonotonic(nfl, 9, 17);
assertMonotonic(cfb, 6, 12);

close(epa.sierraWeight(5, nfl), 0.2 + 0.3 * ((5 - 2) / (9 - 2)), 'NFL linear');
close(epa.sierraWeight(4, cfb), 0.2 + 0.3 * ((4 - 2) / (6 - 2)), 'NCAAF linear');

// gp = 2 matches the previous constant 0.2 blend, including a full projection.
{
  const seed = { offEpa: 0.11, defEpa: -0.04, offSuccess: 0.46, defSuccess: 0.43 };
  const row = { pf: 48, pa: 36, wins: 1, losses: 1 };
  assert.strictEqual(gamesPlayed(row), 2);
  const got = epa.sierraAdjust(seed, row, nfl);
  const offFrom = (24 - nfl.leaguePpg) / nfl.plays;
  const defFrom = (nfl.leaguePpg - 18) / nfl.plays;
  const oldOff = 0.8 * seed.offEpa + 0.2 * offFrom;
  const oldDef = 0.8 * seed.defEpa + 0.2 * defFrom;
  assert.strictEqual(got.adjusted, true);
  close(got.offEpa, oldOff, 'gp2 off');
  close(got.defEpa, oldDef, 'gp2 def');
  assert.strictEqual(got.offSuccess, seed.offSuccess);

  const cfbSeed = { offEpa: 0.08, defEpa: 0.02, offSuccess: 0.48, defSuccess: 0.45 };
  const cfbRow = { pf: 62, pa: 48, gamesPlayed: 2 };
  const cfbGot = epa.sierraAdjust(cfbSeed, cfbRow, cfb);
  const cfbOff = 0.8 * cfbSeed.offEpa + 0.2 * ((31 - cfb.leaguePpg) / cfb.plays);
  const cfbDef = 0.8 * cfbSeed.defEpa + 0.2 * ((cfb.leaguePpg - 24) / cfb.plays);
  close(cfbGot.offEpa, cfbOff, 'ncaaf gp2 off');
  close(cfbGot.defEpa, cfbDef, 'ncaaf gp2 def');

  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const homeEpa = { offEpa: 0.10, defEpa: 0.04, offSuccess: 0.47, defSuccess: 0.44 };
  const awayEpa = { offEpa: 0.06, defEpa: 0.01, offSuccess: 0.45, defSuccess: 0.43 };
  const standings = {
    [home]: { pf: 50, pa: 40, wins: 1, losses: 1 },
    [away]: { pf: 44, pa: 46, gamesPlayed: 2 },
  };
  const proj = epa.footballProjection({
    sport: 'NFL', home, away, standings,
    efficiency: { [home]: homeEpa, [away]: awayEpa },
  });
  function oldBlend(row, st) {
    const pfPg = st.pf / 2;
    const paPg = st.pa / 2;
    return {
      offEpa: 0.8 * row.offEpa + 0.2 * ((pfPg - nfl.leaguePpg) / nfl.plays),
      defEpa: 0.8 * row.defEpa + 0.2 * ((nfl.leaguePpg - paPg) / nfl.plays),
      offSuccess: row.offSuccess,
      defSuccess: row.defSuccess,
    };
  }
  const h = oldBlend(homeEpa, standings[home]);
  const a = oldBlend(awayEpa, standings[away]);
  const homeEdge = h.offEpa - a.defEpa;
  const awayEdge = a.offEpa - h.defEpa;
  const baseMargin = (homeEdge - awayEdge) * nfl.plays + config.HFA.NFL;
  const sm = epa.successMarginAdj(h, a, config.ENGINE_SOFT.NFL);
  const margin = clamp(baseMargin + sm.marginAdj, -nfl.marginCap, nfl.marginCap);
  const total = clamp(
    nfl.baseTotal + (homeEdge + awayEdge) * nfl.plays + epa.successTotalAdj(h, a),
    nfl.totalMin,
    nfl.totalMax
  );
  assert.strictEqual(proj.usedEpa, true);
  close(proj.modelMargin, margin, 'gp2 projection margin');
  close(proj.modelTotal, total, 'gp2 projection total');
}

// Each team uses its own gp. Home stays on the old 0.20. Away is at the cap.
{
  const home = 'Kansas City Chiefs';
  const away = 'Carolina Panthers';
  const homeEpa = { offEpa: 0.08, defEpa: 0.02, offSuccess: 0.45, defSuccess: 0.44 };
  const awayEpa = { offEpa: -0.04, defEpa: -0.03, offSuccess: 0.42, defSuccess: 0.41 };
  const standings = {
    [home]: { pf: 48, pa: 40, wins: 1, losses: 1 },
    [away]: { pf: 207, pa: 180, games: 9 },
  };
  assert.strictEqual(gamesPlayed(standings[home]), 2);
  assert.strictEqual(gamesPlayed(standings[away]), 9);
  const hAdj = epa.sierraAdjust(homeEpa, standings[home], nfl);
  const aAdj = epa.sierraAdjust(awayEpa, standings[away], nfl);
  close(
    hAdj.offEpa,
    0.8 * homeEpa.offEpa + 0.2 * ((24 - nfl.leaguePpg) / nfl.plays),
    'home own gp'
  );
  close(
    aAdj.offEpa,
    0.5 * awayEpa.offEpa + 0.5 * ((23 - nfl.leaguePpg) / nfl.plays),
    'away own gp'
  );
  const asIfAwayWeight = 0.5 * homeEpa.offEpa + 0.5 * ((24 - nfl.leaguePpg) / nfl.plays);
  assert.ok(Math.abs(hAdj.offEpa - asIfAwayWeight) > 1e-6, 'home must not borrow the away gp');

  const proj = epa.footballProjection({
    sport: 'NFL', home, away, standings,
    efficiency: { [home]: homeEpa, [away]: awayEpa },
  });
  const homeEdge = hAdj.offEpa - aAdj.defEpa;
  const awayEdge = aAdj.offEpa - hAdj.defEpa;
  const baseMargin = (homeEdge - awayEdge) * nfl.plays + config.HFA.NFL;
  const sm = epa.successMarginAdj(homeEpa, awayEpa, config.ENGINE_SOFT.NFL);
  const margin = clamp(baseMargin + sm.marginAdj, -nfl.marginCap, nfl.marginCap);
  close(proj.modelMargin, margin, 'split gp margin');
}

// [6, 55] band still keeps the seed, including past midseason.
{
  const seed = { offEpa: 0.04, defEpa: 0.01 };
  const low = epa.sierraAdjust(seed, { pf: 10, pa: 12, games: 9 }, nfl);
  assert.strictEqual(low.adjusted, false);
  assert.strictEqual(low.offEpa, seed.offEpa);
  const ok = epa.sierraAdjust(seed, { pf: 207, pa: 180, games: 9 }, nfl);
  assert.strictEqual(ok.adjusted, true);
  close(ok.offEpa, 0.5 * seed.offEpa + 0.5 * ((23 - nfl.leaguePpg) / nfl.plays), 'midseason band');
}

const nflFile = require(path.join(root, 'sports/data/nfl-epa-seed.json'));
const cfbFile = require(path.join(root, 'sports/data/cfb-epa-seed.json'));
assert.strictEqual(nflFile._meta.season, 2025);
assert.strictEqual(cfbFile._meta.season, 2025);
assert.strictEqual(nflFile._meta.appliesToSeason, 2026);
assert.strictEqual(cfbFile._meta.appliesToSeason, 2026);

assert.strictEqual(epa.cardSeasonYear('2026-10-06'), 2026);
assert.strictEqual(epa.cardSeasonYear('2027-01-15'), 2027);
assert.strictEqual(epa.cardSeasonYear('2027-10-06'), 2027);
assert.strictEqual(epa.seedSeasonStatus(nflFile._meta, '2026-10-06').seedSeasonStale, false);
assert.strictEqual(epa.seedSeasonStatus(cfbFile._meta, '2027-10-06').seedSeasonStale, true);

function emptyPitchers() {
  return { byId: {}, byName: {}, byTeam: {} };
}

async function loadAt(dateISO) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    const loaded = await ingest.loadSportEngines(dateISO, {
      fetchPitchers: async () => emptyPitchers(),
    });
    return { loaded, warns };
  } finally {
    console.warn = orig;
  }
}

(async () => {
  const fresh = await loadAt('2026-10-06');
  assert.strictEqual(fresh.loaded.engineMeta.seedSeasonStale, false);
  assert.strictEqual(fresh.loaded.engineMeta.NFL.season, 2025);
  assert.strictEqual(fresh.loaded.engineMeta.NFL.appliesToSeason, 2026);
  assert.strictEqual(fresh.loaded.engineMeta.NFL.cardSeasonYear, 2026);
  assert.strictEqual(fresh.loaded.engineMeta.NFL.seedSeasonStale, false);
  assert.strictEqual(fresh.loaded.engineMeta.NCAAF.appliesToSeason, 2026);
  assert.strictEqual(fresh.loaded.engineMeta.NCAAF.seedSeasonStale, false);
  assert.ok(!fresh.warns.some(w => w.includes('EPA seed season stale')), fresh.warns.join('\n'));

  const stale = await loadAt('2027-10-06');
  assert.strictEqual(stale.loaded.engineMeta.seedSeasonStale, true);
  assert.strictEqual(stale.loaded.engineMeta.NFL.seedSeasonStale, true);
  assert.strictEqual(stale.loaded.engineMeta.NCAAF.cardSeasonYear, 2027);
  assert.strictEqual(stale.loaded.engineMeta.NCAAF.seedSeasonStale, true);
  const staleWarns = stale.warns.filter(w => w.includes('EPA seed season stale'));
  assert.strictEqual(staleWarns.length, 2, staleWarns.join('\n'));
  assert.ok(staleWarns.some(w => w.includes('sport=NFL') && w.includes('2027')));
  assert.ok(staleWarns.some(w => w.includes('sport=NCAAF') && w.includes('2027')));

  const january = await loadAt('2027-01-15');
  assert.strictEqual(january.loaded.engineMeta.seedSeasonStale, true);
  assert.ok(january.warns.some(w => w.includes('EPA seed season stale') && w.includes('2027-01-15')));

  assert.deepStrictEqual(fresh.loaded.efficiencyBySport, stale.loaded.efficiencyBySport);
  assert.ok(!fresh.loaded.efficiencyBySport.NFL._meta);
  assert.ok(!stale.loaded.efficiencyBySport.NCAAF._meta);

  console.log('PASS test-omega-season-ramp');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
