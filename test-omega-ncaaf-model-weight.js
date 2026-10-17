'use strict';
/**
 * NCAAF keeps the raw model point. NCAAF_MODEL_WEIGHT is 1 on ML, spread,
 * and total, so a Pinnacle line does not pull the pick forecast.
 * NFL spread/ML stay at 0.5 and NFL totals stay at 0.10. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const cfb = require(path.join(root, 'sports/cfb'));
const nfl = require(path.join(root, 'sports/nfl'));
const { blendWithMarket, totalDetail, spreadDetail, mlDetail, pureForecastPoint } = require(path.join(root, 'sports/_common'));
const { collectMarketOutcomes, noVigPinnacleImplied } = require(path.join(root, 'edge'));

assert.deepStrictEqual(config.NCAAF_MODEL_WEIGHT, { ml: 1, spread: 1, total: 1 });
assert.strictEqual(config.NFL_TOTAL_MODEL_WEIGHT, 0.10);
assert.strictEqual(config.MODEL_VERSION, 'v12.4.0-webetai-pure');

assert.strictEqual(pureForecastPoint(24.5, 48, 1), 24.5);
assert.strictEqual(pureForecastPoint(-8.5902, -3.5, 1), -8.5902);
assert.strictEqual(pureForecastPoint(-8.5902, 40, 1), -8.5902);
assert.strictEqual(pureForecastPoint(52.25, 61.5, 1), 52.25);
assert.notStrictEqual(pureForecastPoint(-8.5902, -3.5, 0.10), -8.5902);

const home = 'Ohio State Buckeyes';
const away = 'Iowa Hawkeyes';

function book(key, spreadPoint, totalPoint, overPrice, underPrice, homeSpreadPrice, awaySpreadPrice, homeMl, awayMl) {
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
      { key: 'spreads', outcomes: [
        { name: home, price: homeSpreadPrice, point: spreadPoint },
        { name: away, price: awaySpreadPrice, point: -spreadPoint },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: overPrice, point: totalPoint },
        { name: 'Under', price: underPrice, point: totalPoint },
      ] },
    ],
  };
}

function project(pinSpread, pinTotal, dkSpread, dkTotal) {
  const ev = {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-12T17:00:00Z',
    bookmakers: [
      book('pinnacle', pinSpread, pinTotal, -115, -105, -118, 100, -280, 230),
      book('draftkings', dkSpread, dkTotal, -110, -110, -110, -110, -270, 220),
    ],
  };
  return cfb.project({ oddsEvents: [ev], standings: {}, efficiency: {}, gameDay: {} });
}

const near = project(-3.5, 48.5, -7.5, 52.5);
const far = project(-21.5, 71.5, -7.5, 52.5);

function row(rows, market, pred) {
  const found = rows.find((c) => c.market === market && pred(c));
  assert.ok(found, market);
  return found;
}

const overNear = row(near, 'Total', (c) => c.line === 52.5 && c.side.startsWith('Over'));
const overFar = row(far, 'Total', (c) => c.line === 52.5 && c.side.startsWith('Over'));
const spreadNear = row(near, 'Spread', (c) => c.line === -7.5 && c.side.startsWith(home));
const spreadFar = row(far, 'Spread', (c) => c.line === -7.5 && c.side.startsWith(home));
const mlNear = row(near, 'Moneyline', (c) => c.side === home);
const mlFar = row(far, 'Moneyline', (c) => c.side === home);
const awayMl = row(near, 'Moneyline', (c) => c.side === away);

assert.strictEqual(overNear.betProjection, overNear.modelTotalRaw);
assert.strictEqual(overFar.betProjection, overFar.modelTotalRaw);
assert.strictEqual(overNear.betProjection, overFar.betProjection);
assert.notStrictEqual(overNear.marketLine, overFar.marketLine);
assert.ok(Math.abs(overNear.marketLine - overFar.marketLine) > 15, 'totals sit far apart');
assert.strictEqual(overNear.modelPureP, overFar.modelPureP);
assert.ok(Math.abs(overNear.modelPureP - totalDetail(overNear.modelTotalRaw, overNear.line, 'Over', 'NCAAF').coverProb) < 1e-9);

assert.strictEqual(spreadNear.betProjection, spreadNear.modelMarginRaw);
assert.strictEqual(spreadFar.betProjection, spreadFar.modelMarginRaw);
assert.strictEqual(spreadNear.betProjection, spreadFar.betProjection);
assert.notStrictEqual(spreadNear.marketLine, spreadFar.marketLine);
assert.ok(Math.abs(spreadNear.marketLine - spreadFar.marketLine) > 10, 'spreads sit far apart');
assert.strictEqual(spreadNear.modelPureP, spreadFar.modelPureP);
assert.ok(Math.abs(spreadNear.modelPureP - spreadDetail(
  spreadNear.modelMarginRaw, spreadNear.line, 'NCAAF', undefined, { distribution: 'normal' },
).coverProb) < 1e-9);
assert.notStrictEqual(
  spreadNear.betProjection,
  pureForecastPoint(spreadNear.modelMarginRaw, -spreadNear.marketLine, 0.10),
);

assert.strictEqual(mlNear.betProjection, mlNear.modelMarginRaw);
assert.strictEqual(mlFar.betProjection, mlFar.modelMarginRaw);
assert.strictEqual(mlNear.betProjection, mlFar.betProjection);
assert.strictEqual(mlNear.modelPureP, mlFar.modelPureP);
assert.ok(Math.abs(mlNear.modelPureP - mlDetail(
  mlNear.modelMarginRaw, 'NCAAF', undefined, { distribution: 'normal' },
).coverProb) < 1e-9);
assert.ok(Math.abs(mlNear.modelPureP + awayMl.modelPureP - 1) < 1e-9, 'moneylines are complements');
assert.ok(Math.abs(mlNear.modelPureP - awayMl.modelPureP) > 0.05, 'away moneyline is not the home win');

// Legacy modelRawP uses the same weight. At 1 it is the model cover, not a 0.10 market blend.
const pricedBoard = project(-20.5, 70.5, -20.5, 70.5);
const pricedEv = {
  home_team: home,
  away_team: away,
  commence_time: '2026-10-12T17:00:00Z',
  bookmakers: [
    book('pinnacle', -20.5, 70.5, -115, -105, -118, 100, -280, 230),
    book('draftkings', -20.5, 70.5, -110, -110, -110, -110, -270, 220),
  ],
};
function blendAt(c, weight) {
  const key = c.market === 'Total' ? 'totals' : c.market === 'Spread' ? 'spreads' : 'h2h';
  const bundles = collectMarketOutcomes(pricedEv, key);
  const wantSide = c.market === 'Total' ? 'Over' : home;
  const bundle = bundles.find((b) => b.side === wantSide && (c.market === 'Moneyline' || b.point === c.line));
  assert.ok(bundle, `${c.market} bundle`);
  const anchor = noVigPinnacleImplied(bundles, bundle);
  const detailAt = c.market === 'Total'
    ? (proj) => totalDetail(proj, c.line, 'Over', 'NCAAF')
    : c.market === 'Spread'
      ? (proj) => spreadDetail(proj, c.line, 'NCAAF')
      : (proj) => mlDetail(proj, 'NCAAF');
  const rawProj = c.market === 'Total' ? c.modelTotalRaw : c.modelMarginRaw;
  const shrunkProj = c.market === 'Total' ? c.modelTotalShrunk : c.modelMarginShrunk;
  const pRaw = blendWithMarket(detailAt(rawProj).coverProb, anchor, weight);
  const pShr = blendWithMarket(detailAt(shrunkProj).coverProb, anchor, weight);
  if (!Number.isFinite(pRaw)) return pShr;
  if (!Number.isFinite(pShr)) return pRaw;
  return pShr < pRaw ? pShr : pRaw;
}
const pricedOver = row(pricedBoard, 'Total', (c) => c.side.startsWith('Over'));
const pricedSpread = row(pricedBoard, 'Spread', (c) => c.side.startsWith(home));
const pricedMl = row(pricedBoard, 'Moneyline', (c) => c.side === home);
for (const c of [pricedOver, pricedSpread, pricedMl]) {
  assert.ok(Math.abs(c.modelRawP - blendAt(c, 1)) < 1e-9, `${c.market} raw ${c.modelRawP}`);
  assert.ok(Math.abs(c.modelRawP - blendAt(c, 0.10)) > 1e-3, `${c.market} must not stay on 0.10`);
}

// NFL still pulls. Spread and moneyline weight 0.5. Total weight 0.10.
const nflHome = 'Kansas City Chiefs';
const nflAway = 'Buffalo Bills';
const nflSpread = -13.5;
const nflTotal = 58.5;
const nflEv = {
  home_team: nflHome,
  away_team: nflAway,
  commence_time: '2026-10-12T17:00:00Z',
  bookmakers: [{
    key: 'pinnacle',
    markets: [
      { key: 'h2h', outcomes: [{ name: nflHome, price: -140 }, { name: nflAway, price: 120 }] },
      { key: 'spreads', outcomes: [
        { name: nflHome, price: -118, point: nflSpread },
        { name: nflAway, price: 100, point: -nflSpread },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: -115, point: nflTotal },
        { name: 'Under', price: -105, point: nflTotal },
      ] },
    ],
  }],
};
const nflRows = nfl.project({ oddsEvents: [nflEv], standings: {}, efficiency: {}, gameDay: {} });
const nflOver = nflRows.find((c) => c.market === 'Total' && c.side.startsWith('Over'));
const nflHomeSpread = nflRows.find((c) => c.market === 'Spread' && c.side.startsWith(nflHome));
const nflHomeMl = nflRows.find((c) => c.market === 'Moneyline' && c.side === nflHome);
assert.ok(nflOver && nflHomeSpread && nflHomeMl);
const nflTotalForecast = pureForecastPoint(nflOver.modelTotalRaw, nflOver.marketLine, 0.10);
const nflSpreadForecast = pureForecastPoint(nflHomeSpread.modelMarginRaw, nflHomeSpread.marketLine == null ? null : -nflHomeSpread.marketLine, 0.5);
const nflMlForecast = pureForecastPoint(nflHomeMl.modelMarginRaw, nflHomeMl.marketLine == null ? null : -nflHomeMl.marketLine, 0.5);
assert.strictEqual(nflOver.betProjection, nflTotalForecast);
assert.strictEqual(nflHomeSpread.betProjection, nflSpreadForecast);
assert.strictEqual(nflHomeMl.betProjection, nflMlForecast);
assert.notStrictEqual(nflOver.betProjection, nflOver.modelTotalRaw);
assert.notStrictEqual(nflHomeSpread.betProjection, nflHomeSpread.modelMarginRaw);
assert.strictEqual(config.NFL_TOTAL_MODEL_WEIGHT, 0.10);

// Georgia Southern home margin from the 10:00 board. Weight 1 keeps -8.5902.
const gsHome = pureForecastPoint(-8.5902, -3.5, 1);
assert.strictEqual(gsHome, -8.5902);
const gsCover = spreadDetail(-gsHome, -3.5, 'NCAAF', undefined, { distribution: 'normal' }).coverProb;
const pulledCover = spreadDetail(4.009, -3.5, 'NCAAF', undefined, { distribution: 'normal' }).coverProb;
assert.ok(Math.abs(gsCover - pulledCover) > 0.05, `raw GS cover ${gsCover} left the 0.10 pull ${pulledCover}`);

console.log('PASS test-omega-ncaaf-model-weight');
