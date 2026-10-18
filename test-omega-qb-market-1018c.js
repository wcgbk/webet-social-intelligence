'use strict';
// NFL QB-flag diagnostic and anchor-weight cap. The model margin is not refit.
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const gd = require('./netlify/functions/lib/omega-vnext/sports/game_day');
const nfl = require('./netlify/functions/lib/omega-vnext/sports/nfl');
const {
  applyMarketAnchor, normalQuantile, QB_MARKET_GAP, QB_MARKET_WEIGHT_CAP,
} = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');

// ASSUMED 2026-10-18. Not fit on this box. Documented in prob_anchor.js.
assert.strictEqual(QB_MARKET_GAP, 0.10);
assert.strictEqual(QB_MARKET_WEIGHT_CAP, 0.10);
assert.strictEqual(config.QB_INJURY.NFL.outMarginPts, 3.0);
assert.strictEqual(config.SPORT_SPREAD_STD.NFL, 13.2);

const PHI = 'Philadelphia Eagles';
const CAR = 'Carolina Panthers';
const MATCH = `${CAR} @ ${PHI}`;
const KICK = '2026-10-18T17:00:00Z';

function phiChart() {
  return {
    map: {
      '21': {
        teamId: '21',
        abbr: 'PHI',
        displayName: PHI,
        qb1: { name: 'Tanner McKee', athleteId: '4685201' },
        qb2: { name: 'Jalen Hurts', athleteId: '4040715' },
      },
    },
  };
}

function day(extra) {
  return {
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: PHI,
    away: CAR,
    restByTeam: {},
    depthByTeam: phiChart(),
    ...extra,
  };
}

// Hurts IR, chart QB1 is the backup. Generic 3.0 still moves the margin.
// The flag does not add a second adjustment.
{
  const hurts = gd.applyGameDayAdjustments(day({
    qbByTeam: { [PHI]: { qbStatus: 'injured reserve', qbName: 'Jalen Hurts' } },
  }));
  assert.strictEqual(hurts.gameDay.qbFlag, true);
  assert.ok(Math.abs(hurts.gameDay.qbMarginAdj - (-3)) < 1e-9, hurts.gameDay.qbMarginAdj);
  assert.ok(Math.abs(hurts.modelMargin - (2 - 3)) < 1e-9, hurts.modelMargin);
}

// Doubtful moves the 0.75 table and is a flag. Questionable does not.
{
  const doubtful = gd.applyGameDayAdjustments(day({
    qbByTeam: { [PHI]: { qbStatus: 'doubtful', qbName: 'Jalen Hurts' } },
  }));
  assert.strictEqual(doubtful.gameDay.qbFlag, true);
  assert.ok(Math.abs(doubtful.gameDay.qbMarginAdj - (-2.25)) < 1e-9);
  const questionable = gd.applyGameDayAdjustments(day({
    qbByTeam: { [PHI]: { qbStatus: 'questionable', qbName: 'Jalen Hurts' } },
  }));
  assert.strictEqual(questionable.gameDay.qbFlag, false);
  assert.strictEqual(questionable.gameDay.qbMarginAdj, 0);
}

// No injury row. Not a flag. Margin stays the input.
{
  const quiet = gd.applyGameDayAdjustments(day({
    home: 'New England Patriots',
    away: 'New York Jets',
    depthByTeam: null,
    qbByTeam: {},
  }));
  assert.strictEqual(quiet.gameDay.qbFlag, false);
  assert.strictEqual(quiet.modelMargin, 2);
}

// Chart lists a backup while the claimed starter is out, and that name is
// not on the frozen PRESEASON_QB1 list, so the margin is not moved. The
// starter is still unconfirmed, so the flag is on.
{
  const backup = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 2,
    modelTotal: 45,
    uncertainty: 0.16,
    home: 'New England Patriots',
    away: 'New York Jets',
    restByTeam: {},
    qbByTeam: {
      'New England Patriots': { qbStatus: 'out', qbName: 'Drake Maye', depthChartRank: 1 },
    },
    depthByTeam: {
      map: {
        '17': {
          teamId: '17',
          abbr: 'NE',
          displayName: 'New England Patriots',
          qb1: { name: 'Jacoby Brissett', athleteId: '1' },
        },
      },
    },
  });
  assert.strictEqual(backup.gameDay.qbMarginAdj, 0);
  assert.ok(Math.abs(backup.modelMargin - 2) < 1e-9, backup.modelMargin);
  assert.strictEqual(backup.gameDay.qbFlag, true);
}

// NCAAF out still prices the college table and does not set an NFL qbFlag.
{
  const cfb = gd.applyGameDayAdjustments({
    sport: 'NCAAF',
    modelMargin: 6,
    modelTotal: 52,
    uncertainty: 0.2,
    home: 'Auburn Tigers',
    away: 'Alabama Crimson Tide',
    restByTeam: {},
    qbByTeam: { 'Auburn Tigers': { qbStatus: 'out', qbName: 'Payton Thorne', depthChartRank: 1 } },
  });
  assert.strictEqual(cfb.gameDay.qbFlag, undefined);
  assert.ok(Math.abs(cfb.gameDay.qbMarginAdj + config.QB_INJURY.NCAAF.outMarginPts) < 1e-9);
  assert.ok(Math.abs(cfb.modelMargin - (6 - config.QB_INJURY.NCAAF.outMarginPts)) < 1e-9);
}

// Projector stores the flag and the no-QB margin. modelMarginRaw still
// includes the generic −3.
{
  const prev = process.env.OMEGA_NFL_ELO_WEIGHT;
  process.env.OMEGA_NFL_ELO_WEIGHT = '0';
  try {
    const ev = {
      home_team: PHI,
      away_team: CAR,
      commence_time: KICK,
      bookmakers: [{
        key: 'pinnacle',
        markets: [
          { key: 'h2h', outcomes: [{ name: PHI, price: 140 }, { name: CAR, price: -166 }] },
          { key: 'spreads', outcomes: [
            { name: PHI, price: -105, point: 3 },
            { name: CAR, price: -115, point: -3 },
          ] },
          { key: 'totals', outcomes: [
            { name: 'Over', price: -110, point: 45.5 },
            { name: 'Under', price: -110, point: 45.5 },
          ] },
        ],
      }],
    };
    const rows = nfl.project({
      oddsEvents: [ev],
      standings: {},
      efficiency: {},
      gameDay: {
        qbStatusBySport: { NFL: { [PHI]: { qbStatus: 'injured reserve', qbName: 'Jalen Hurts' } } },
        depthCharts: { NFL: phiChart() },
      },
    });
    const homeMl = rows.find((c) => c.market === 'Moneyline' && c.side === PHI);
    assert.ok(homeMl, 'home ML');
    assert.strictEqual(homeMl.qbFlag, true);
    assert.ok(Math.abs(homeMl.gameDay.qbMarginAdj - (-3)) < 1e-9);
    assert.ok(Math.abs((homeMl.modelMarginNoQb + homeMl.gameDay.qbMarginAdj) - homeMl.modelMarginRaw) < 1e-6);
    assert.ok(homeMl.modelMarginNoQb > homeMl.modelMarginRaw);
    const quiet = nfl.project({
      oddsEvents: [{ ...ev, home_team: 'New England Patriots', away_team: 'New York Jets' }],
      standings: {},
      efficiency: {},
      gameDay: {},
    });
    const quietMl = quiet.find((c) => c.market === 'Moneyline');
    assert.strictEqual(quietMl.qbFlag, false);
    assert.ok(Math.abs(quietMl.modelMarginNoQb - quietMl.modelMarginRaw) < 1e-6);
  } finally {
    if (prev == null) delete process.env.OMEGA_NFL_ELO_WEIGHT;
    else process.env.OMEGA_NFL_ELO_WEIGHT = prev;
  }
}

// +130/−177 power-devigs to 39.4%. That is the PHI-like fair, not a fitted weight.
function phiMl(extra) {
  return {
    sport: 'NFL',
    market: 'Moneyline',
    side: PHI,
    homeTeam: PHI,
    awayTeam: CAR,
    matchup: MATCH,
    commenceTime: KICK,
    odds: 140,
    modelPureP: 0.579,
    coverProb: 0.70,
    qbFlag: true,
    modelMarginNoQb: 5.7,
    pinnacleSide: { american: 130, oppAmerican: -177, point: null, oppPoint: null },
    ...extra,
  };
}

function spreadRow(extra) {
  return {
    sport: 'NFL',
    market: 'Spread',
    side: `${PHI} +3.5`,
    line: 3.5,
    homeTeam: PHI,
    awayTeam: CAR,
    matchup: MATCH,
    commenceTime: KICK,
    odds: -110,
    modelPureP: 0.52,
    coverProb: 0.52,
    qbFlag: true,
    modelMarginNoQb: 6,
    pinnacleSide: { american: -110, oppAmerican: -110, point: 3.5, oppPoint: -3.5 },
    ...extra,
  };
}

// PHI-like: QB flag, model 57.9% vs fair 39.4% → w capped at 0.10 and
// p_final within 2pp of fair. The cap is the ASSUMED 0.10, not a fit to this row.
{
  const [row] = applyMarketAnchor([phiMl()]);
  assert.ok(Math.abs(row.p_model - 0.579) < 1e-9, row.p_model);
  assert.ok(Math.abs(row.p_fair - 0.394) < 0.001, row.p_fair);
  assert.ok(Math.abs(row.p_model - row.p_fair) > QB_MARKET_GAP);
  assert.strictEqual(row.anchorWeight, QB_MARKET_WEIGHT_CAP);
  assert.strictEqual(row.qbMarketInformed, true);
  assert.ok(Math.abs(row.coverProb - row.p_fair) < 0.02, row.coverProb);
  // p_fair on the row is rounded to 6 decimals. The blend uses the full fair.
  assert.ok(Math.abs(row.coverProb - (0.10 * row.p_model + 0.90 * row.p_fair)) < 1e-6);
  assert.ok(row.notes.includes(`QB flag: market treated as informed (model-vs-market gap ${(Math.round(Math.abs(row.p_model - row.p_fair) * 1000) / 10).toFixed(1)}pp)`));
  // ML-only inversion: market margin is sd * Φ^{-1}(p_fair). Home is the dog,
  // so the diagnostic is negative and larger than the generic 3.0 table.
  const market = config.SPORT_SPREAD_STD.NFL * normalQuantile(row.p_fair);
  const expected = +(market - 5.7).toFixed(2);
  assert.ok(Math.abs(row.qbMarketImpliedPts - expected) < 1e-9, row.qbMarketImpliedPts);
  assert.ok(row.qbMarketImpliedPts < -3, row.qbMarketImpliedPts);
  assert.ok(row.notes.includes('No fitted QB value table exists'));
  assert.strictEqual(row.modelMarginNoQb, 5.7);

  const pick = toPickObject(row);
  const pub = publicPicksPayload({ picks: [pick], parlayLegs: [] });
  const shown = pub.picks[0];
  assert.strictEqual(shown.qbFlag, true);
  assert.strictEqual(shown.qbMarketInformed, true);
  assert.strictEqual(shown.qbMarketImpliedPts, row.qbMarketImpliedPts);
  assert.ok(shown.notes.includes('QB flag: market treated as informed'));
  assert.ok(shown.coreReasoning.includes('QB flag: market treated as informed'));
  assert.ok(shown.coreReasoning.includes('QB diagnostic:'));
}

// Same gap, no QB flag: table weight, not capped.
// 2026-10-18: c3 set NFL ML to 0.40. 0.25 was the pre-merge cell.
{
  const [row] = applyMarketAnchor([phiMl({ qbFlag: false })]);
  assert.ok(Math.abs(row.p_model - row.p_fair) > QB_MARKET_GAP);
  assert.strictEqual(row.anchorWeight, 0.40);
  assert.notStrictEqual(row.qbMarketInformed, true);
  assert.ok(Math.abs(row.coverProb - (0.40 * row.p_model + 0.60 * row.p_fair)) < 1e-6);
  assert.ok(!row.notes || !String(row.notes).includes('market treated as informed'));
  const pub = publicPicksPayload({ picks: [toPickObject(row)], parlayLegs: [] });
  assert.strictEqual(pub.picks[0].qbFlag, undefined);
  assert.strictEqual(pub.picks[0].qbMarketInformed, undefined);
}

// Flag, small gap: not capped. Exactly 10pp is not capped. 11pp is.
{
  const [small] = applyMarketAnchor([phiMl({
    modelPureP: 0.55,
    pinnacleSide: { american: -110, oppAmerican: -110, point: null, oppPoint: null },
  })]);
  assert.ok(Math.abs(small.p_fair - 0.5) < 1e-9, small.p_fair);
  assert.ok(Math.abs(small.p_model - small.p_fair) < QB_MARKET_GAP);
  assert.strictEqual(small.qbFlag, true);
  assert.strictEqual(small.qbMarketInformed, false);
  // 2026-10-18: uncapped NFL ML is the c3 table weight 0.40, not the old 0.25 cell.
  assert.strictEqual(small.anchorWeight, 0.40);
  assert.ok(!small.notes.includes('market treated as informed'));

  const even = { american: -110, oppAmerican: -110, point: null, oppPoint: null };
  const [edge] = applyMarketAnchor([phiMl({ modelPureP: 0.60, pinnacleSide: even })]);
  assert.ok(Math.abs(edge.p_fair - 0.5) < 1e-9, edge.p_fair);
  assert.ok(Math.abs(Math.abs(edge.p_model - edge.p_fair) - 0.10) < 1e-9);
  assert.strictEqual(edge.qbMarketInformed, false);
  assert.strictEqual(edge.anchorWeight, 0.40);

  const [over] = applyMarketAnchor([phiMl({ modelPureP: 0.61, pinnacleSide: even })]);
  assert.ok(Math.abs(over.p_model - over.p_fair) - QB_MARKET_GAP > 0);
  assert.strictEqual(over.qbMarketInformed, true);
  assert.strictEqual(over.anchorWeight, 0.10);
}

// Other sports are not capped, even with the flag and the same gap.
{
  const [ncaaf] = applyMarketAnchor([phiMl({ sport: 'NCAAF', qbFlag: true })]);
  // 2026-10-18: c3 set NCAAF ML to 0.05. 0.25 was the pre-merge cell.
  assert.strictEqual(ncaaf.anchorWeight, 0.05);
  assert.notStrictEqual(ncaaf.qbMarketInformed, true);
  const [nhl] = applyMarketAnchor([phiMl({ sport: 'NHL', market: 'Moneyline', qbFlag: true })]);
  assert.strictEqual(nhl.anchorWeight, 0.25);
  assert.notStrictEqual(nhl.qbMarketInformed, true);
}

// NFL total weight is 0. The cap must not raise it. The note still prints.
{
  const [total] = applyMarketAnchor([phiMl({
    market: 'Total',
    side: 'Over 45.5',
    line: 45.5,
  })]);
  assert.strictEqual(total.anchorWeight, 0);
  assert.strictEqual(total.qbMarketInformed, true);
  assert.ok(Math.abs(total.coverProb - total.p_fair) < 1e-6);
  assert.ok(total.notes.includes('market treated as informed'));
}

// Spread line, even −110/−110: market home margin is −homeLine.
// no-QB model is home by 6, so the market is 9.5 points worse on the home QB.
// The other sign: home −7 at even money and a 0 no-QB margin is +7.
{
  const [dog] = applyMarketAnchor([spreadRow()]);
  assert.ok(Math.abs(dog.p_fair - 0.5) < 1e-9, dog.p_fair);
  assert.strictEqual(dog.qbMarketInformed, false);
  // 2026-10-18: uncapped NFL spread is the c3 table weight 0.40, not the old 0.25 cell.
  assert.strictEqual(dog.anchorWeight, 0.40);
  assert.ok(Math.abs(dog.qbMarketImpliedPts - (-9.5)) < 1e-9, dog.qbMarketImpliedPts);
  assert.ok(dog.qbMarketImpliedPts < -config.QB_INJURY.NFL.outMarginPts);

  const [fav] = applyMarketAnchor([spreadRow({
    side: `${PHI} -7`,
    line: -7,
    modelMarginNoQb: 0,
    matchup: 'Dallas Cowboys @ Philadelphia Eagles',
    awayTeam: 'Dallas Cowboys',
    pinnacleSide: { american: -110, oppAmerican: -110, point: -7, oppPoint: 7 },
  })]);
  assert.ok(Math.abs(fav.qbMarketImpliedPts - 7) < 1e-9, fav.qbMarketImpliedPts);
  assert.ok(fav.qbMarketImpliedPts > config.QB_INJURY.NFL.outMarginPts);
}

// When the game has a spread, the ML row uses that margin, not the ML inverse.
{
  const ml = phiMl({ modelPureP: 0.52, modelMarginNoQb: 6 });
  const sp = spreadRow();
  const [mlOut, spOut] = applyMarketAnchor([ml, sp]);
  assert.ok(Math.abs(spOut.qbMarketImpliedPts - (-9.5)) < 1e-9, spOut.qbMarketImpliedPts);
  assert.strictEqual(mlOut.qbMarketImpliedPts, spOut.qbMarketImpliedPts);
  const mlOnlyMarket = config.SPORT_SPREAD_STD.NFL * normalQuantile(mlOut.p_fair);
  const mlOnlyPts = +(mlOnlyMarket - 6).toFixed(2);
  assert.notStrictEqual(mlOut.qbMarketImpliedPts, mlOnlyPts);
}

console.log('test-omega-qb-market-1018c ok');
