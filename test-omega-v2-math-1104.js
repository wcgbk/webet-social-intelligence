'use strict';

/**
 * Log-odds blend, walk-forward intercept, NHL Poisson price, football key
 * numbers, power de-vig, and the stale soft-line flag.
 */

const assert = require('assert');
const v2 = require('./netlify/functions/lib/omega-v2');
const { noVigTwoWay } = require('./netlify/functions/lib/omega-vnext/odds_math');
const nhl = require('./netlify/functions/lib/omega-vnext/sports/nhl');
const { footballCoverProb, keyMassAt } = require('./netlify/functions/lib/omega-vnext/sports/margin_dist');
const { staleSoftLag } = require('./netlify/functions/lib/omega-vnext/edge');
function close(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);
}

// Log-odds blend is not the linear mix, and a zero intercept matches shrinkP.
{
  const linear = 0.3 * 0.8 + 0.7 * 0.55;
  const blended = v2.shrinkP(0.8, 0.55, 0.7);
  assert.ok(Math.abs(blended - linear) > 1e-4, 'log-odds blend moves off the linear mix');
  close(v2.shrinkP(0.6, 0.5, 0.68, 0), v2.shrinkP(0.6, 0.5, 0.68), 1e-12, 'zero intercept');
  const centered = v2.shrinkP(0.6, 0.5, 0.68, 0.04);
  assert.ok(centered < v2.shrinkP(0.6, 0.5, 0.68), 'a positive intercept pulls the model down');
}

// Walk-forward intercept removes the cell mean. It is not shrunk toward 0,
// and it is not applied to a locked NHL moneyline.
{
  assert.strictEqual(v2.BIAS_N0, 0, 'intercept prior count is 0');
  const history = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      sport: 'NHL',
      market: 'Spread',
      pick: 'Road +1.5',
      pModel: 0.62,
      pMkt: 0.55,
      result: i % 2 ? 'win' : 'loss',
    });
  }
  const fit = v2.fitWalkForward(history, '2026-11-03');
  const spread = v2.applyCalibration({
    sport: 'NHL', market: 'Spread', pick: 'Road +1.5', pModel: 0.62, pMkt: 0.55,
  }, fit);
  close(spread.pCal, 0.55, 1e-6, 'cell blend sits on the no-vig price');
  close(spread.intercept, 0.07, 1e-4, 'unshrunk gap is the shift');
  assert.ok(spread.pCal < v2.shrinkP(0.62, 0.55, spread.shrinkK), 'centered pCal is below the raw blend');
  const ml = v2.applyCalibration({
    sport: 'NHL', market: 'Moneyline', pick: 'Oilers', pModel: 0.62, pMkt: 0.55,
  }, fit);
  assert.strictEqual(ml.intercept, 0);
  close(ml.pCal, 0.55, 1e-12, 'NHL moneyline stays on the no-vig price');
  // A market with no rows of its own is not borrowed from another cell.
  const nba = v2.applyCalibration({
    sport: 'NBA', market: 'Total', pick: 'Over 220.5', pModel: 0.62, pMkt: 0.55,
  }, fit);
  assert.strictEqual(nba.intercept, 0);
}

// Uneven gaps: the solved shift centers the blend, not the raw mean.
{
  const history = [];
  const gaps = [0.02, 0.04, 0.09, 0.03, 0.08, 0.05, 0.07, 0.01, 0.06, 0.04, 0.11, 0.02];
  gaps.forEach((gap, i) => {
    history.push({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      sport: 'NFL',
      market: 'Total',
      pick: 'Over 45.5',
      pModel: 0.5 + gap,
      pMkt: 0.5,
      result: i % 2 ? 'win' : 'loss',
    });
  });
  const fit = v2.fitWalkForward(history, '2026-11-03');
  let sum = 0;
  for (const gap of gaps) {
    const row = v2.applyCalibration({
      sport: 'NFL', market: 'Total', pick: 'Over 45.5', pModel: 0.5 + gap, pMkt: 0.5,
    }, fit);
    sum += row.pCal - row.pMkt;
  }
  close(sum / gaps.length, 0, 1e-4, 'cell mean residual');
}

// The sharp prior is the power de-vig. A longshot fair sits inside proportional.
{
  const two = noVigTwoWay(145, -170);
  const proportional = (100 / 245) / ((100 / 245) + (170 / 270));
  assert.ok(two.p1 < proportional, `power ${two.p1} proportional ${proportional}`);
  close(noVigTwoWay(-110, -110).p1, 0.5, 1e-9, 'even price');
}

// Poisson prices the OT split, the two-goal puck line, and a regressed save rate.
{
  const dog = nhl.nhlMarketProb({
    margin: 0.15, total: 6.2, market: 'Spread', isHome: false, line: 1.5, side: 'Away +1.5',
  });
  const fav = nhl.nhlMarketProb({
    margin: 0.15, total: 6.2, market: 'Spread', isHome: true, line: -1.5, side: 'Home -1.5',
  });
  close(dog + fav, 1, 0.02, 'half-point puck line has no push');
  assert.ok(dog > fav, `dog ${dog} fav ${fav}`);
  const pickem = nhl.nhlMarketProb({
    margin: 0, total: 6.2, market: 'Moneyline', isHome: true, side: 'Home',
  });
  assert.ok(pickem > 0.5 && pickem < 0.56, `OT home share ${pickem}`);
  const over = nhl.nhlMarketProb({
    margin: 0, total: 6.2, market: 'Total', line: 6.5, side: 'Over 6.5',
  });
  const under = nhl.nhlMarketProb({
    margin: 0, total: 6.2, market: 'Total', line: 6.5, side: 'Under 6.5',
  });
  close(over + under, 1, 0.03, 'total');
  assert.ok(over > 0.3 && over < 0.7, over);
  const reg = nhl.regressSavePct(0.930, 400);
  assert.ok(reg < 0.930 && reg > 0.905, reg);
}

// Key number 3 is fatter than the normal gap between -2.5 and -3.5.
{
  const fav = footballCoverProb(0, -2.5, 'NFL');
  const through = footballCoverProb(0, -3.5, 'NFL');
  const gap = fav - through;
  assert.ok(gap > 0.06, `key gap ${gap}`);
  const mass3 = keyMassAt(0, 'NFL', 3);
  assert.ok(mass3 > 0.07, mass3);
  const ml = footballCoverProb(0, null, 'NFL');
  close(ml, 0.5, 0.02, 'pick-em moneyline');
  const cfb = footballCoverProb(3, -3, 'NCAAF');
  assert.ok(cfb > 0.45 && cfb < 0.7, cfb);
}

// Stale when Hard Rock is 1.5pp or more better than the Pinnacle no-vig.
{
  const bundles = [
    { side: 'Home', point: -1.5, prices: [{ book: 'pinnacle', american: -140 }, { book: 'draftkings', american: 120 }] },
    { side: 'Away', point: 1.5, prices: [{ book: 'pinnacle', american: 120 }, { book: 'draftkings', american: -130 }] },
  ];
  const lag = staleSoftLag(bundles, bundles[0]);
  assert.strictEqual(lag.stale, true);
  assert.ok(lag.lagPp >= 1.5, lag.lagPp);
  const quiet = [
    { side: 'Home', point: null, prices: [{ book: 'pinnacle', american: -110 }, { book: 'draftkings', american: -115 }] },
    { side: 'Away', point: null, prices: [{ book: 'pinnacle', american: -110 }, { book: 'draftkings', american: -105 }] },
  ];
  assert.strictEqual(staleSoftLag(quiet, quiet[0]).stale, false);
}

console.log('math-1104 tests PASS');
