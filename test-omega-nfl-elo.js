'use strict';

/**
 * NFL Elo. No live network. Forecast.py cases are hardcoded from the
 * Python formula, not from the module under test.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const elo = require(path.join(root, 'sports/nfl_elo'));
const nfl = require(path.join(root, 'sports/nfl'));
const { resolveTeamId } = require(path.join(root, 'sports/team_identity'));

function close(actual, expected, eps = 1e-9) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

// --- MOV multiplier vs forecast.py -----------------------------------------
// Home 1600, away 1400, HFA 50 → eloDiff 250. p = 0.808317672549.
// Tie branch divides by 1, not by 2.2.

{
  const diff = 250;
  close(elo.eloProb(diff), 0.808317672549);
  close(elo.movMultiplier(17, diff, 1), 2.595435864233);
  const won = elo.applyEloGame(
    { home: 1600, away: 1400 },
    { homeId: 'home', awayId: 'away', homeScore: 27, awayScore: 10, neutral: false },
  );
  // applyEloGame uses config HFA, so this case is not diff 250 unless HFA is 50.
  assert.strictEqual(elo.hfaElo(false), 50);
  assert.strictEqual(elo.hfaElo(true), 0);
  assert.notStrictEqual(elo.hfaElo(false), 65);
  close(won.eloDiff, 250);
  close(won.pHome, 0.808317672549);
  close(won.mult, 2.595435864233);
  close(won.shift, 9.949983744097);
  close(won.result, 1);
}

{
  const upset = elo.applyEloGame(
    { home: 1600, away: 1400 },
    { homeId: 'home', awayId: 'away', homeScore: 28, awayScore: 31, neutral: false },
  );
  close(upset.mult, 1.564024407417);
  close(upset.shift, -25.284571376282);
  assert.strictEqual(upset.result, 0);
}

{
  const tie = elo.applyEloGame(
    { home: 1600, away: 1400 },
    { homeId: 'home', awayId: 'away', homeScore: 20, awayScore: 20, neutral: false },
  );
  assert.strictEqual(tie.result, 0.5);
  close(tie.mult, 1.524923797232);
  close(tie.shift, -9.403219119556);
  // pd 0 still uses max(pd, 1): ln(2) * 2.2, not ln(1).
  close(elo.movMultiplier(0, 250, 0.5), Math.log(2) * 2.2);
}

{
  const neutral = elo.applyEloGame(
    { home: 1505, away: 1505 },
    { homeId: 'home', awayId: 'away', homeScore: 24, awayScore: 20, neutral: true },
  );
  close(neutral.eloDiff, 0);
  close(neutral.pHome, 0.5);
  close(neutral.mult, 1.609437912434);
  close(neutral.shift, 16.094379124341);
}

{
  const dog = elo.applyEloGame(
    { home: 1465, away: 1505 },
    { homeId: 'home', awayId: 'away', homeScore: 17, awayScore: 16, neutral: false },
  );
  // 1465 - 1505 + 50 = 10, not -80. Use a raw multiplier check for diff -80.
  close(elo.movMultiplier(1, -80, 1), 0.719303677940);
  close(elo.eloProb(-80), 0.386863179847);
  const p = elo.eloProb(-80);
  const m = elo.movMultiplier(1, -80, 1);
  close(elo.K_FACTOR * m * (1 - p), 8.820631396327);
  assert.strictEqual(dog.result, 1);
}

// --- one-third regression --------------------------------------------------

close(elo.regressElo(1610), 1575);
close(elo.regressElo(1400), 1435);
close(elo.regressElo(1505), 1505);
close(elo.regressElo(1610), 1505 * (1 / 3) + 1610 * (2 / 3));
assert.strictEqual(elo.REVERT, 1 / 3);
assert.strictEqual(elo.MEAN_ELO, 1505);
assert.strictEqual(elo.K_FACTOR, 20);
assert.strictEqual(elo.ELO_PER_POINT, 25);

// --- win-total blend -------------------------------------------------------

close(elo.winTotalEloRaw(8.5), 1505);
close(elo.winTotalEloRaw(11.5), 1633.134060343747, 1e-9);
close(elo.winTotalEloRaw(3.5), 1270.493710342108, 1e-9);
close(elo.winTotalEloRaw(10.5), 1588.310376970833, 1e-9);

{
  const raw = { a: elo.winTotalEloRaw(11.5), b: elo.winTotalEloRaw(3.5) };
  const centered = elo.centerEloMap(raw);
  const mean = (centered.a + centered.b) / 2;
  close(mean, 1505);
  const gap = raw.a - raw.b;
  close(centered.a - centered.b, gap);
  const regressed = 1575;
  close(elo.blendWinTotal(regressed, 1620), (2 * 1620 + 1575) / 3);
  close(elo.blendWinTotal(regressed, 1620), 1605);
}

// Shipped prior matches the same formulas and the DraftKings board.
{
  const prior = elo.loadPrior();
  assert.strictEqual(prior.meta.hfaElo, 50);
  assert.strictEqual(prior.meta.hfaPoints, 2);
  assert.strictEqual(prior.meta.k, 20);
  assert.ok(prior.meta.winTotalSource && prior.meta.winTotalSource.url);
  assert.ok(/si\.com\/betting\/2026-nfl-win-total/.test(prior.meta.winTotalSource.url));
  assert.strictEqual(prior.meta.winTotalSource.book, 'DraftKings Sportsbook');
  assert.ok(prior.winTotals && typeof prior.winTotals === 'object');
  const ids = Object.keys(prior.teams);
  assert.strictEqual(ids.length, 32);
  let winSum = 0;
  let eloSum = 0;
  for (const id of ids) {
    const row = prior.teams[id];
    winSum += row.winTotal;
    eloSum += row.winTotalElo;
    close(row.regressed, elo.regressElo(row.end2025), 1e-5);
    close(row.regressed, 1505 * (1 / 3) + row.end2025 * (2 / 3), 1e-5);
    close(row.winTotalEloRaw, elo.winTotalEloRaw(row.winTotal), 1e-4);
    close(row.blended, elo.blendWinTotal(row.regressed, row.winTotalElo), 1e-5);
    close(row.blended, (2 * row.winTotalElo + row.regressed) / 3, 1e-5);
    assert.strictEqual(prior.winTotals[id], row.winTotal);
  }
  close(winSum, 272, 1e-9);
  close(eloSum / ids.length, 1505, 1e-4);
}

// --- eloMargin HFA / neutral ----------------------------------------------

{
  elo.resetNflEloState();
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const homeId = resolveTeamId('NFL', home);
  const awayId = resolveTeamId('NFL', away);
  assert.ok(homeId && awayId && homeId !== awayId);
  const ratings = {};
  ratings[homeId] = 1555;
  ratings[awayId] = 1505;
  close(elo.eloMargin(home, away, false, ratings), (1555 - 1505 + 50) / 25);
  close(elo.eloMargin(home, away, false, ratings), 4);
  close(elo.eloMargin(home, away, true, ratings), 2);
  close(elo.eloMargin(home, away, false, ratings) - elo.eloMargin(home, away, true, ratings), 2);
  const equal = {};
  equal[homeId] = 1505;
  equal[awayId] = 1505;
  close(elo.eloMargin(home, away, false, equal), config.HFA.NFL);
  close(elo.eloMargin(home, away, true, equal), 0);
  close(elo.eloMargin('Not A Club', away, false, equal), config.HFA.NFL);
}

// --- frozen snap does not fetch -------------------------------------------

(async () => {
  elo.resetNflEloState();
  const prevSnap = process.env.OMEGA_FROZEN_SNAP;
  const prevDir = process.env.OMEGA_REST_SCHEDULE_DIR;
  const dir = path.join('/tmp', `nfl-elo-weeks-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const homeId = resolveTeamId('NFL', 'Kansas City Chiefs');
  const awayId = resolveTeamId('NFL', 'Buffalo Bills');
  const board = {
    season: { type: 2, year: 2026 },
    week: { number: 1 },
    events: [{
      id: 'elo-test-1',
      date: '2026-09-14T17:00:00Z',
      name: 'Buffalo Bills at Kansas City Chiefs',
      competitions: [{
        neutralSite: false,
        date: '2026-09-14T17:00:00Z',
        status: { type: { completed: true, name: 'STATUS_FINAL', description: 'Final' } },
        competitors: [
          { homeAway: 'home', score: '30', team: { id: homeId } },
          { homeAway: 'away', score: '10', team: { id: awayId } },
        ],
      }],
    }],
  };
  fs.writeFileSync(path.join(dir, 'nfl-w1.json'), JSON.stringify(board));
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error('frozen path must not fetch');
  };
  process.env.OMEGA_FROZEN_SNAP = path.join('/tmp', `nfl-elo-snap-${process.pid}.json`);
  delete process.env.OMEGA_REST_SCHEDULE_DIR;
  const priorOnly = await elo.prepareNflElo('2026-09-20', { fetchImpl, dir: null });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(priorOnly.source, 'prior');
  assert.strictEqual(priorOnly.fetched, false);
  assert.strictEqual(priorOnly.applied, 0);
  const baseHome = priorOnly.ratings[homeId];

  process.env.OMEGA_REST_SCHEDULE_DIR = dir;
  const withWeeks = await elo.prepareNflElo('2026-09-20', { fetchImpl });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(withWeeks.source, 'frozen-weeks');
  assert.strictEqual(withWeeks.fetched, false);
  assert.strictEqual(withWeeks.applied, 1);
  const weekGames = elo.gamesFromEspnBoard(JSON.parse(fs.readFileSync(path.join(dir, 'nfl-w1.json'), 'utf8')));
  const applied = elo.gamesBeforeCard(weekGames, '2026-09-20');
  const priorMap = elo.priorRatings();
  const walked = elo.ratingsAfterGames(applied, priorMap);
  assert.ok(walked[homeId] > priorMap[homeId], 'a win still raises the Elo walk');
  const priorK = config.sportPriorK('NFL');
  const legacyOn = String(process.env.OMEGA_NFL_ELO_LEGACY_DECAY || '').trim() === '1';
  let expectedHome;
  if (legacyOn || priorK == null || !Number.isFinite(Number(priorK))) {
    expectedHome = (priorK == null || !Number.isFinite(Number(priorK)))
      ? walked[homeId]
      : elo.MEAN_ELO
        + config.priorW(1, priorK) * (priorMap[homeId] - elo.MEAN_ELO)
        + (walked[homeId] - priorMap[homeId]);
  } else {
    const start = {};
    for (const id of Object.keys(priorMap)) {
      const g = (String(id) === String(homeId) || String(id) === String(awayId)) ? 1 : 0;
      start[id] = elo.MEAN_ELO + config.priorW(g, priorK) * (priorMap[id] - elo.MEAN_ELO);
    }
    expectedHome = elo.ratingsAfterGames(applied, start)[homeId];
  }
  close(withWeeks.ratings[homeId], expectedHome);

  const sameDay = await elo.prepareNflElo('2026-09-14', { fetchImpl });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(sameDay.applied, 0);
  close(sameDay.ratings[homeId], baseHome);

  const emptyDir = path.join('/tmp', `nfl-elo-empty-${process.pid}`);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'nfl-w1.json'), JSON.stringify({
    season: { type: 2, year: 2026 },
    events: [],
  }));
  process.env.OMEGA_REST_SCHEDULE_DIR = emptyDir;
  const emptyWeeks = await elo.prepareNflElo('2026-09-20', { fetchImpl });
  assert.strictEqual(fetches, 0);
  assert.strictEqual(emptyWeeks.source, 'frozen-weeks');
  assert.strictEqual(emptyWeeks.applied, 0);
  close(emptyWeeks.ratings[homeId], baseHome);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  if (prevSnap == null) delete process.env.OMEGA_FROZEN_SNAP;
  else process.env.OMEGA_FROZEN_SNAP = prevSnap;
  if (prevDir == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
  else process.env.OMEGA_REST_SCHEDULE_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
  elo.resetNflEloState();
})().then(() => {
// --- weight 0 leaves the NFL margin unchanged ------------------------------

function event(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-11T17:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -3 },
          { name: away, price: -110, point: 3 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 45.5 },
          { name: 'Under', price: -110, point: 45.5 },
        ] },
      ],
    })),
  };
}

function spreadOf(cands) {
  const row = cands.find((c) => c.market === 'Spread' && /Chiefs/.test(c.side));
  assert.ok(row, 'home spread missing');
  return row;
}

{
  elo.resetNflEloState();
  const prevW = process.env.OMEGA_NFL_ELO_WEIGHT;
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const ev = event(home, away);
  process.env.OMEGA_NFL_ELO_WEIGHT = '0';
  assert.strictEqual(config.nflEloWeight(), 0);
  const zero = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
  assert.strictEqual(zero.modelProjection, 2);
  assert.strictEqual(zero.nflElo, undefined);
  const total = nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} })
    .find((c) => c.market === 'Total');
  assert.ok(total);

  const eloPts = elo.eloMargin(home, away, false);
  process.env.OMEGA_NFL_ELO_WEIGHT = '0.3';
  assert.strictEqual(config.nflEloWeight(), 0.3);
  const blended = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
  const expected = (1 - 0.3) * 2 + 0.3 * eloPts;
  assert.strictEqual(blended.modelProjection, +expected.toFixed(2));
  assert.ok(blended.nflElo);
  assert.strictEqual(blended.nflElo.w, 0.3);
  const totalBlended = nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} })
    .find((c) => c.market === 'Total');
  assert.strictEqual(totalBlended.modelProjection, total.modelProjection);

  process.env.OMEGA_NFL_ELO_WEIGHT = '1';
  const only = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
  assert.strictEqual(only.modelProjection, +eloPts.toFixed(2));

  process.env.OMEGA_NFL_ELO_WEIGHT = '0';
  const again = spreadOf(nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
  assert.strictEqual(again.modelProjection, zero.modelProjection);

  process.env.OMEGA_NFL_ELO_WEIGHT = 'nope';
  assert.strictEqual(config.nflEloWeight(), config.NFL_ELO_WEIGHT);
  process.env.OMEGA_NFL_ELO_WEIGHT = '2';
  assert.strictEqual(config.nflEloWeight(), 1);
  process.env.OMEGA_NFL_ELO_WEIGHT = '-0.2';
  assert.strictEqual(config.nflEloWeight(), 0);

  if (prevW == null) delete process.env.OMEGA_NFL_ELO_WEIGHT;
  else process.env.OMEGA_NFL_ELO_WEIGHT = prevW;
  elo.resetNflEloState();
}

console.log('PASS test-omega-nfl-elo');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
