'use strict';
/**
 * Elite-sharp construction fixes. Each block proves the default-on path
 * and the OFF path, which is the 2e0a803 formula.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const common = require(path.join(root, 'sports/_common'));
const km = require(path.join(root, 'key_mass'));
const nhlPeriod = require(path.join(root, 'nhl_period'));
const nhl = require(path.join(root, 'sports/nhl'));
const push = require(path.join(root, 'push_ev'));
const parlay = require(path.join(root, 'parlay'));
const select = require(path.join(root, 'select'));
const audit = require(path.join(root, 'audit_card'));
const { evAtOdds, kellyFraction, normCdf, clamp } = require(path.join(root, 'odds_math'));
const { publicPicksPayload } = require(path.join(__dirname, 'netlify/functions/lib/public-picks'));

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
}

function withEnv(name, value, fn) {
  const prev = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

assert.strictEqual(config.MODEL_VERSION, 'v12.3.16-omega-vnext-ncaaf-oa-wx');

// Keyed margin PMF. Default on.
{
  assert.strictEqual(km.keyMassReady('NFL'), true);
  assert.strictEqual(km.keyMassReady('NCAAF'), true);
  const nflStd = config.SPORT_SPREAD_STD.NFL;
  const cfbStd = config.SPORT_SPREAD_STD.NCAAF;
  const totStd = config.SPORT_TOTAL_STD.NFL;

  near(km.marginBin(3, 3, 'NFL'), 0.09, 0.002, 'NFL P(M=3|μ=3)');
  near(km.marginBin(3, 3, 'NFL') + km.marginBin(3, -3, 'NFL'), 0.17, 0.015, 'NFL |M|=3');
  near(km.marginBin(7, 7, 'NFL'), 0.065, 0.002, 'NFL P(M=7|μ=7)');
  near(km.marginBin(10, 10, 'NFL'), 0.044, 0.002, 'NFL P(M=10|μ=10)');
  near(km.marginBin(3, 3, 'NCAAF'), 0.0535, 0.003, 'NCAAF P(M=3|μ=3)');
  assert.ok(Math.abs(km.marginBin(3, 3, 'NFL') - km.marginBin(3, 3, 'NCAAF')) > 0.02);

  const gap = common.spreadCoverProb(3, -2.5, 'NFL') - common.spreadCoverProb(3, -3.5, 'NFL');
  near(gap, km.marginBin(3, 3, 'NFL'), 1e-6, 'half-point gap is the 3 bin');
  const normalGap = normCdf((3 - 2.5) / nflStd) - normCdf((3 - 3.5) / nflStd);
  assert.ok(gap > normalGap + 0.04, `keyed gap ${gap} vs normal ${normalGap}`);

  near(common.spreadCoverProb(3, -2.5, 'NFL') + common.spreadCoverProb(-3, 2.5, 'NFL'), 1, 1e-9);
  near(common.spreadCoverProb(3, -3.5, 'NFL') + common.spreadCoverProb(-3, 3.5, 'NFL'), 1, 1e-9);

  const pk = km.spreadQuote(3, -3, 'NFL', nflStd);
  assert.ok(pk.pPush > 0.08 && pk.pPush < 0.10, `integer push ${pk.pPush}`);
  near(pk.coverProb, pk.pWin / (1 - pk.pPush), 1e-9, 'conditional cover');
  near(common.spreadCoverProb(3, -3, 'NFL'), pk.coverProb, 1e-12);
  const dogInt = km.spreadQuote(-3, 3, 'NFL', nflStd);
  near(pk.coverProb + dogInt.coverProb, 1, 1e-9);

  assert.ok(Math.abs(common.spreadCoverProb(3, -10, 'NFL') - normCdf((3 - 10) / nflStd)) > 0.02);
  assert.ok(Math.abs(common.spreadCoverProb(4, -3, 'NCAAF') - normCdf((4 - 3) / cfbStd)) > 0.002);
  assert.ok(Math.abs(common.spreadCoverProb(4, -10, 'NCAAF') - normCdf((4 - 10) / cfbStd)) > 0.02);
  near(common.spreadCoverProb(1.2, -1.5, 'MLB'), normCdf((1.2 - 1.5) / config.SPORT_SPREAD_STD.MLB), 1e-12);

  const t44 = km.totalBin(44, 44, totStd);
  const t42 = km.totalBin(44, 42, totStd);
  const n44 = km.normalTotalBin(44, 44, totStd);
  const n42 = km.normalTotalBin(44, 42, totStd);
  assert.ok(t44 > n44, '44 is fatter than the normal bin');
  assert.ok(t42 < n42, '42 is a valley');
  assert.ok(t44 > t42);
  const overGap = common.totalCoverProb(44, 43.5, 'Over', 'NFL') - common.totalCoverProb(44, 44.5, 'Over', 'NFL');
  assert.ok(overGap > n44, `total key gap ${overGap} vs normal ${n44}`);
  near(common.totalCoverProb(44, 43.5, 'Over', 'NCAAF'), normCdf((44 - 43.5) / config.SPORT_TOTAL_STD.NCAAF), 1e-12);

  const ml = km.mlQuote(0, 'NFL', nflStd);
  assert.ok(ml.pPush >= 0.001 && ml.pPush < 0.01, `NFL tie ${ml.pPush}`);
  near(ml.coverProb, 0.5, 1e-6);
  const cfbMl = km.mlQuote(0, 'NCAAF', cfbStd);
  assert.strictEqual(cfbMl.pPush, 0);
  near(cfbMl.coverProb, 0.5, 1e-6);

  const intTotal = km.totalQuote(44, 44, 'Over', 'NFL', totStd);
  assert.ok(intTotal.pPush > 0.03, `NFL total push ${intTotal.pPush}`);
  near(intTotal.coverProb, intTotal.pWin / (1 - intTotal.pPush), 1e-9);
  const under = km.totalQuote(44, 44, 'Under', 'NFL', totStd);
  near(intTotal.coverProb + under.coverProb, 1, 1e-9);
  near(intTotal.pPush, under.pPush, 1e-12);
}

// OFF restores nflKeyNumberCover and the plain normal.
withEnv('OMEGA_KEY_MASS', '0', () => {
  const std = config.SPORT_SPREAD_STD.NFL;
  const cfbStd = config.SPORT_SPREAD_STD.NCAAF;
  const legacy = common.nflKeyNumberCover(3, -3, std);
  assert.strictEqual(common.spreadCoverProb(3, -3, 'NFL'), legacy.coverProb);
  assert.strictEqual(common.spreadCoverProb(3, -2.5, 'NFL'), common.nflKeyNumberCover(3, -2.5, std).coverProb);
  assert.strictEqual(common.spreadCoverProb(3, -10, 'NFL'), normCdf((3 - 10) / std));
  assert.strictEqual(common.spreadCoverProb(4, -3, 'NCAAF'), normCdf((4 - 3) / cfbStd));
  assert.strictEqual(common.spreadCoverProb(4, -7.5, 'NCAAF'), normCdf((4 - 7.5) / cfbStd));
  const z = (44 - 43.5) / config.SPORT_TOTAL_STD.NFL;
  assert.strictEqual(common.totalCoverProb(44, 43.5, 'Over', 'NFL'), normCdf(z));
  assert.strictEqual(common.mlFromSpread(3, 'NFL'), clamp(normCdf(3 / std), 0.05, 0.95));
  const detail = common.spreadDetail(3, -3, 'NFL');
  assert.strictEqual(detail.pPush, legacy.pPush);
  assert.strictEqual(common.totalDetail(44, 44, 'Over', 'NFL').pPush, 0);
  assert.strictEqual(common.mlDetail(3, 'NFL').pPush, 0);
});

// Push-aware stake EV and Kelly.
{
  const naive = evAtOdds(0.52, -110);
  const scaled = push.pushAwareEv(0.52, -110, 0.09);
  near(scaled, naive * 0.91, 1e-12, 'push scales EV');
  near(push.pushAwareKelly(0.52, -110, 0.25, 0.09), kellyFraction(0.52, -110, 0.25) * 0.91, 1e-12);
  assert.strictEqual(push.pushAwareEv(0.52, -110, 0), naive);
  assert.strictEqual(push.pushAwareEv(0.52, -110), naive);
  near(push.pushKeep(0.8), 0.5, 1e-12, 'push keep floor');
  withEnv('OMEGA_PUSH_EV', '0', () => {
    assert.strictEqual(push.pushAwareEv(0.52, -110, 0.09), naive);
    assert.strictEqual(push.pushAwareKelly(0.52, -110, 0.25, 0.09), kellyFraction(0.52, -110, 0.25));
  });
}

// NHL regulation / OT / shootout.
{
  const mlH = nhlPeriod.nhlMarketQuote({ modelMargin: 0.15, modelTotal: 6.2, market: 'ml', sideIsHome: true });
  const mlA = nhlPeriod.nhlMarketQuote({ modelMargin: 0.15, modelTotal: 6.2, market: 'ml', sideIsHome: false });
  near(mlH.coverProb + mlA.coverProb, 1, 1e-9);
  assert.strictEqual(mlH.pPush, 0);
  assert.strictEqual(mlA.pPush, 0);
  assert.ok(mlH.pTie > 0.12 && mlH.pTie < 0.22, `reg tie ${mlH.pTie}`);
  near(mlH.expectedTotal, 6.2, 0.05, 'OT goal is added back onto the model total');

  const fav = nhlPeriod.nhlMarketQuote({ modelMargin: 0.6, modelTotal: 6.2, market: 'ml', sideIsHome: true });
  const pl = nhlPeriod.nhlMarketQuote({ modelMargin: 0.6, modelTotal: 6.2, market: 'spread', sideIsHome: true, line: -1.5 });
  const dog = nhlPeriod.nhlMarketQuote({ modelMargin: 0.6, modelTotal: 6.2, market: 'spread', sideIsHome: false, line: 1.5 });
  assert.strictEqual(pl.pPush, 0);
  near(pl.coverProb, pl.pHomeBy2, 1e-9, '−1.5 is regulation margin ≥ 2');
  assert.ok(pl.coverProb < fav.coverProb, 'OT win does not cover −1.5');
  near(pl.coverProb + dog.coverProb, 1, 1e-9);

  const over = nhlPeriod.nhlMarketQuote({ modelMargin: 0.15, modelTotal: 6.2, market: 'total', side: 'Over', line: 6 });
  const under = nhlPeriod.nhlMarketQuote({ modelMargin: 0.15, modelTotal: 6.2, market: 'total', side: 'Under', line: 6 });
  assert.ok(over.pPush > 0.08, `NHL total push ${over.pPush}`);
  near(over.coverProb + under.coverProb, 1, 1e-9);
  near(over.pPush, under.pPush, 1e-12);

  const home = 'Colorado Avalanche';
  const away = 'Dallas Stars';
  const ev = {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-11T23:00:00Z',
    bookmakers: [{
      key: 'pinnacle',
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [{ name: home, price: -110, point: -1.5 }, { name: away, price: -110, point: 1.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 6.5 }, { name: 'Under', price: -110, point: 6.5 }] },
      ],
    }],
  };
  const on = nhl.project({ oddsEvents: [ev], standings: {} });
  const ml = on.find(c => c.market === 'Moneyline' && c.side === home);
  assert.ok(/-60min/.test(ml.projMethod), ml.projMethod);
  assert.ok(/nhl-standings-hfa/.test(ml.projMethod));
  assert.ok(/nhl-normal-pl/.test(on.find(c => c.market === 'Spread').projMethod));
  assert.strictEqual(ml.modelProjection, on.find(c => c.market === 'Spread').modelProjection);
  withEnv('OMEGA_NHL_PERIOD', '0', () => {
    const off = nhl.project({ oddsEvents: [ev], standings: {} });
    const offMl = off.find(c => c.market === 'Moneyline' && c.side === home);
    assert.ok(!/-60min/.test(offMl.projMethod), offMl.projMethod);
    const legacy = common.blendWithMarket(common.mlFromSpread(offMl.modelProjection, 'NHL'), ml.fair_sharp_p, 0.5);
    near(offMl.modelRawP, legacy, 1e-9, 'NHL OFF is the normal moneyline');
    assert.ok(Math.abs(ml.modelRawP - offMl.modelRawP) > 1e-4, '60-minute ML moves the price');
  });
}

// Same-direction totals: positive correlation when on, 0.92 haircut when off.
{
  const leg = (side, p) => ({ sport: 'NFL', market: 'Total', side, coverProb: p, odds: -110, ev: 0.04, matchup: side, commenceTime: '2026-10-11T17:00:00Z' });
  const overs = [leg('Over 44.5', 0.55), leg('Over 41.5', 0.55)];
  const factor = parlay.sameDirectionTotalFactor(overs);
  assert.ok(factor > 1.03 && factor < 1.12, `corr factor ${factor}`);
  const stats = parlay.comboStats(overs);
  assert.ok(stats.combinedProb > 0.55 * 0.55);
  const mixed = [leg('Over 44.5', 0.55), { ...leg('Under 41.5', 0.55), market: 'Spread', side: 'A -3' }];
  assert.strictEqual(parlay.sameDirectionTotalFactor(mixed), 1);
  withEnv('OMEGA_PARLAY_CORR', '0', () => {
    const three = [leg('Over 44', 0.60), leg('Over 41', 0.58), leg('Over 47', 0.57)];
    assert.strictEqual(parlay.sameDirectionTotalFactor(three), 0.92);
    near(parlay.comboStats(three).combinedProb, 0.60 * 0.58 * 0.57 * 0.92, 1e-12);
  });
}

// Same-game exposure: straight + full parlay stake, cap 1.50u.
{
  const game = 'Buffalo Bills @ Kansas City Chiefs';
  const other = 'Dallas Cowboys @ Philadelphia Eagles';
  const straight = { pick: 'KC -2.5', matchup: game, units: '1.25u', rating: 'aplus', qualityGrade: 'aplus', qualityScore: 0.06, commenceTime: '2026-10-11T17:00:00Z' };
  const otherStraight = { pick: 'PHI -3', matchup: other, units: '1.00u', rating: 'a', qualityGrade: 'a', qualityScore: 0.04, commenceTime: '2026-10-11T20:00:00Z' };
  const ticket = {
    units: '0.5u',
    legs: [
      { pick: 'Over 47', matchup: game, commenceTime: '2026-10-11T17:00:00Z' },
      { pick: 'Over 44', matchup: game, commenceTime: '2026-10-11T17:00:00Z' },
    ],
  };
  const capped = select.applyDailyUnitCap([straight, otherStraight], [ticket]);
  const by = Object.fromEntries(capped.picks.map(p => [p.pick, p]));
  assert.strictEqual(by['KC -2.5'].units, '1u');
  assert.strictEqual(by['KC -2.5'].rating, 'aplus');
  assert.strictEqual(by['PHI -3'].units, '1.00u');
  assert.strictEqual(capped.parlayLegs[0].units, '0.5u');
  withEnv('OMEGA_GAME_EXPOSURE', '0', () => {
    const off = select.applyDailyUnitCap([
      { ...straight },
      { ...otherStraight },
    ], [ticket]);
    assert.strictEqual(off.picks.find(p => p.pick === 'KC -2.5').units, '1.25u');
  });
}

// Private card audit. Public payload drops it. OFF omits the field.
{
  const snap = {
    dateISO: '2026-10-11',
    fetchedAt: '2026-10-11T12:00:00Z',
    oddsBySport: {
      NFL: [{
        home_team: 'Kansas City Chiefs',
        away_team: 'Buffalo Bills',
        commence_time: '2026-10-11T17:00:00Z',
        bookmakers: [{
          key: 'pinnacle',
          markets: [{ key: 'spreads', outcomes: [
            { name: 'Kansas City Chiefs', price: -110, point: -2.5 },
            { name: 'Buffalo Bills', price: -110, point: 2.5 },
          ] }],
        }],
      }],
    },
    standingsBySport: {
      NFL: {
        'Kansas City Chiefs': { wins: 5, losses: 2, pf: 180, pa: 140, fetchedAt: 'nope' },
      },
    },
  };
  const a = audit.buildCardAudit({ snap, modelVersion: config.MODEL_VERSION });
  const b = audit.buildCardAudit({ snap: { ...snap, fetchedAt: '2099-01-01T00:00:00Z' }, modelVersion: config.MODEL_VERSION });
  assert.strictEqual(a.modelVersion, config.MODEL_VERSION);
  assert.strictEqual(a.gapsBuild, 'elite-sharp-gaps-1');
  assert.strictEqual(a.configHash.length, 64);
  assert.strictEqual(a.inputSnapshotHash.length, 64);
  assert.strictEqual(a.configHash, b.configHash);
  assert.strictEqual(a.inputSnapshotHash, b.inputSnapshotHash);
  assert.strictEqual(a.toggles.OMEGA_KEY_MASS, true);
  const moved = audit.buildCardAudit({
    snap: {
      ...snap,
      oddsBySport: {
        NFL: [{ ...snap.oddsBySport.NFL[0], commence_time: '2026-10-11T20:00:00Z' }],
      },
    },
    modelVersion: config.MODEL_VERSION,
  });
  assert.notStrictEqual(moved.inputSnapshotHash, a.inputSnapshotHash);
  const pub = publicPicksPayload({
    model: config.MODEL_VERSION,
    audit: a,
    gapReview: [{ side: 'x' }],
    picks: [{ pick: 'KC -2.5', sport: 'NFL', odds: '-110', units: '1u' }],
    parlayLegs: [],
  });
  assert.strictEqual(pub.audit, undefined);
  assert.ok(!JSON.stringify(pub).includes(a.configHash));
  withEnv('OMEGA_CARD_AUDIT', '0', () => {
    assert.strictEqual(audit.buildCardAudit({ snap, modelVersion: config.MODEL_VERSION }), null);
  });
}

console.log('PASS test-omega-gaps');
