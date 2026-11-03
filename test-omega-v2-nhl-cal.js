'use strict';

/**
 * Thin-sport calibration. A pooled Platt does not write a sport under its
 * floor. NHL moneylines stay on the Pinnacle no-vig fair until an NHL-only
 * walk-forward beats that price. The 10pp screen reads the final map.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');

const DATE = '2026-11-03';
const PREGAME = Date.parse('2026-11-03T18:00:00Z');
const COMMENCE = '2026-11-04T00:40:00Z';

function row(over) {
  return {
    sport: 'NFL',
    matchup: 'Away @ Home',
    awayTeam: 'Away',
    homeTeam: 'Home',
    pick: 'Away ML',
    side: 'Away ML',
    market: 'Moneyline',
    odds: 130,
    oddsStr: '+130',
    book: 'draftkings',
    bestDkHr: { american: 130, book: 'draftkings' },
    pModel: 0.47,
    pMkt: 0.41,
    commenceTime: COMMENCE,
    ...over,
  };
}

function graded(sport, date, pModel, pMkt, result) {
  return { date, sport, pModel, pMkt, result };
}

(async () => {
  assert.strictEqual(v2.SHRINK_N0, 80);
  assert.strictEqual(v2.NHL_ML_SHRINK_K, 1);
  assert.strictEqual(v2.NHL_ML_WALKFORWARD_BEATS_NOVIG, false);
  assert.strictEqual(v2.SPORT_MIN_GAMES.NHL, v2.MIN_SPORT);
  assert.strictEqual(v2.priorKFor('NHL'), 0.68);
  assert.strictEqual(v2.priorWeight(0), 1);
  assert.strictEqual(v2.priorWeight(v2.SHRINK_N0), 0.5);
  assert.ok(v2.priorWeight(800) < 0.1);

  assert.strictEqual(v2.nhlMoneylineLocked('NHL', 'Moneyline', 'Edmonton Oilers'), true);
  assert.strictEqual(v2.nhlMoneylineLocked('NHL', 'Spread', 'Edmonton Oilers +1.5'), false);
  assert.strictEqual(v2.nhlMoneylineLocked('NHL', 'Moneyline', 'Edmonton Oilers', true), false);
  assert.strictEqual(v2.shrinkKFor('NHL', 0, null, 'Moneyline', 'Oilers'), 1);
  assert.strictEqual(v2.shrinkKFor('NHL', 200, 0.4, 'Moneyline', 'Oilers'), 1);
  assert.strictEqual(v2.shrinkKFor('NHL', 200, 0.4, 'Moneyline', 'Oilers', true), v2.shrinkKFor('NHL', 200, 0.4, 'Spread', 'Oilers +1.5'));
  assert.strictEqual(v2.shrinkKFor('NHL', 10, 0.4, 'Spread', 'Oilers +1.5'), 0.68);
  assert.strictEqual(v2.shrinkKFor('NFL', 0, null, 'Moneyline', 'Home'), 0.70);
  const blended = v2.shrinkKFor('NFL', 80, 0.40, 'Moneyline', 'Home');
  assert.ok(Math.abs(blended - (0.5 * 0.70 + 0.5 * 0.40)) < 1e-12);

  const oilers = {
    sport: 'NHL',
    market: 'Moneyline',
    pick: 'Edmonton Oilers',
    pModel: 0.47384426883708364,
    pMkt: 0.410886027132864,
  };
  const preds = {
    sport: 'NHL',
    market: 'Moneyline',
    pick: 'Nashville Predators',
    pModel: 0.35685703744779784,
    pMkt: 0.350142641428195,
  };
  const jets = {
    sport: 'NHL',
    market: 'Moneyline',
    pick: 'Winnipeg Jets',
    pModel: 0.34859502379169677,
    pMkt: 0.3571599839071228,
  };

  const pooledDogMap = {
    trainN: 28,
    pooled: {
      n: 28,
      k: 0.70,
      platt: { a: 0.079, b: 0.78 },
      isotonic: [{ lo: 0.02, hi: 0.98, avg: 0.9, n: 28 }],
      method: 'platt+isotonic',
    },
    bySport: {},
    sportN: { NHL: 6, NCAAF: 12, NFL: 10 },
  };

  for (const cand of [oilers, preds, jets]) {
    const cal = v2.applyCalibration(cand, pooledDogMap);
    assert.strictEqual(cal.shrinkK, 1, cand.pick);
    assert.strictEqual(cal.method, 'nhl-ml-novig', cand.pick);
    assert.strictEqual(cal.mapApplied, false, cand.pick);
    assert.ok(Math.abs(cal.pCal - cal.pMkt) < 1e-12, `${cand.pick} pCal ${cal.pCal} fair ${cal.pMkt}`);
    assert.ok(cal.pCal < 0.5, cand.pick);
  }

  const spread = v2.applyCalibration({
    sport: 'NHL',
    market: 'Spread',
    pick: 'Detroit Red Wings +1.5',
    pModel: 0.60,
    pMkt: 0.50,
  }, pooledDogMap);
  const expectSpread = v2.shrinkP(0.60, 0.50, 0.68);
  assert.strictEqual(spread.method, 'sport-floor');
  assert.strictEqual(spread.mapApplied, false);
  assert.ok(Math.abs(spread.pCal - expectSpread) < 1e-12);
  assert.ok(Math.abs(spread.pCal - 0.9) > 0.1, 'pooled isotonic must not lift an under-floor spread');

  const ncaaf = v2.applyCalibration({
    sport: 'NCAAF',
    market: 'Total',
    pick: 'Over 44.5',
    pModel: 0.62,
    pMkt: 0.50,
  }, pooledDogMap);
  assert.strictEqual(ncaaf.shrinkK, 0.72);
  assert.strictEqual(ncaaf.mapApplied, false);
  assert.ok(Math.abs(ncaaf.pCal - v2.shrinkP(0.62, 0.50, 0.72)) < 1e-12);

  const sportMap = {
    trainN: 40,
    pooled: pooledDogMap.pooled,
    sportN: { NFL: 40, NHL: 40 },
    bySport: {
      NFL: {
        n: 40,
        k: 0.40,
        platt: { a: 0, b: 1 },
        isotonic: [{ lo: 0.02, hi: 0.98, avg: 0.9, n: 40 }],
        method: 'platt+isotonic',
      },
      NHL: {
        n: 40,
        k: 0.40,
        platt: { a: 0.2, b: 0.8 },
        isotonic: null,
        method: 'platt',
      },
    },
  };
  const nfl = v2.applyCalibration({
    sport: 'NFL', market: 'Moneyline', pick: 'Home ML', pModel: 0.62, pMkt: 0.52,
  }, sportMap);
  assert.strictEqual(nfl.mapApplied, true);
  assert.strictEqual(nfl.method, 'platt+isotonic');
  const kNfl = v2.shrinkKFor('NFL', 40, 0.40, 'Moneyline', 'Home ML');
  const shrunk = v2.shrinkP(0.62, 0.52, kNfl);
  assert.ok(Math.abs(nfl.pCal - (0.5 * shrunk + 0.5 * 0.9)) < 1e-12);

  const nhlAbove = v2.applyCalibration(oilers, sportMap);
  assert.strictEqual(nhlAbove.shrinkK, 1);
  assert.strictEqual(nhlAbove.mapApplied, false);
  assert.ok(Math.abs(nhlAbove.pCal - oilers.pMkt) < 1e-12, 'sport Platt must not move a locked NHL moneyline');

  assert.strictEqual(v2.nhlMoneylineLocked('NHL', 'Moneyline', oilers.pick, true), false);
  const asSpread = v2.shrinkKFor('NHL', 40, 0.40, 'Spread', 'Oilers +1.5');
  assert.ok(asSpread < 1 && asSpread > 0.40);

  const history = [];
  for (let i = 0; i < 10; i += 1) {
    history.push(graded('NHL', `2026-10-${String(i + 1).padStart(2, '0')}`, 0.42, 0.40, i % 2 ? 'win' : 'loss'));
    history.push(graded('NFL', `2026-10-${String(i + 1).padStart(2, '0')}`, 0.55, 0.48, i % 2 ? 'loss' : 'win'));
  }
  const fit = v2.fitWalkForward(history, DATE);
  assert.strictEqual(fit.sportN.NHL, 10);
  assert.strictEqual(fit.sportN.NFL, 10);
  assert.ok(!fit.bySport.NHL, '10 NHL rows are under the floor');
  assert.ok(!fit.bySport.NFL, '10 NFL rows are under the floor');
  assert.strictEqual(fit.pooled.n, 20);
  const fromFit = v2.applyCalibration(oilers, fit);
  assert.ok(Math.abs(fromFit.pCal - oilers.pMkt) < 1e-12);

  const rawWide = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    history: [],
    candidates: [row({
      sport: 'NFL',
      pModel: 0.80,
      pMkt: 0.55,
      odds: -110,
      oddsStr: '-110',
      bestDkHr: { american: -110, book: 'draftkings' },
    })],
  });
  assert.ok(rawWide.picks.length === 1, 'a raw gap over 10pp can clear after the shrink');
  assert.ok(rawWide.picks[0].edgeNovig <= 0.10);
  assert.ok(rawWide.picks[0].edgeNovig > 0);
  assert.ok(!(0.80 - 0.55 <= 0.10), 'the pre-map gap is over 10pp');

  const mappedWide = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    history: [],
    candidates: [row({
      sport: 'NFL',
      pModel: 0.95,
      pMkt: 0.50,
      odds: -110,
      oddsStr: '-110',
      bestDkHr: { american: -110, book: 'draftkings' },
    })],
  });
  assert.strictEqual(mappedWide.picks.length, 0);
  assert.ok(mappedWide.rejections.some((r) => r.reason === 'edge-over-10pp'));
  const rejected = mappedWide.rejections.find((r) => r.reason === 'edge-over-10pp');
  assert.ok(rejected.edgeNovig > 0.10, 'the screen uses the post-map edge');

  const dogs = await v2.buildCard({
    date: DATE,
    pregameAsOfMs: PREGAME,
    history: [],
    candidates: [oilers, preds, jets].map((c) => row({
      sport: 'NHL',
      matchup: `${c.pick} @ Opponent`,
      pick: c.pick,
      side: c.pick,
      market: 'Moneyline',
      pModel: c.pModel,
      pMkt: c.pMkt,
      odds: c.pick === 'Edmonton Oilers' ? 130 : (c.pick === 'Nashville Predators' ? 165 : 160),
      oddsStr: c.pick === 'Edmonton Oilers' ? '+130' : (c.pick === 'Nashville Predators' ? '+165' : '+160'),
      bestDkHr: {
        american: c.pick === 'Edmonton Oilers' ? 130 : (c.pick === 'Nashville Predators' ? 165 : 160),
        book: 'draftkings',
      },
    })),
  });
  assert.strictEqual(dogs.picks.length, 0, 'locked NHL moneylines are not a forced card');
  assert.strictEqual(dogs.parlayLegs.length, 0);
  assert.strictEqual(dogs.pass, true);
  assert.strictEqual(dogs.calibration.pooledAppliesUnderFloor, false);
  assert.strictEqual(dogs.calibration.nhlMlShrinkK, 1);
  assert.strictEqual(dogs.calibration.nhlMlWalkforwardBeatsNovig, false);

  console.log('PASS test-omega-v2-nhl-cal');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
