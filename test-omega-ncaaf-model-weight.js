'use strict';
/**
 * NCAAF blend at NCAAF_MODEL_WEIGHT 0.10 on ML, spread, and total.
 * No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const cfb = require(path.join(root, 'sports/cfb'));
const { blendWithMarket, totalDetail, spreadDetail, mlDetail } = require(path.join(root, 'sports/_common'));
const { collectMarketOutcomes, noVigPinnacleCircaImplied } = require(path.join(root, 'edge'));

assert.deepStrictEqual(config.NCAAF_MODEL_WEIGHT, { ml: 0.10, spread: 0.10, total: 0.10 });
assert.strictEqual(config.MODEL_VERSION, 'v12.3.65-omega-vnext-price-lock');

const home = 'Ohio State Buckeyes';
const away = 'Iowa Hawkeyes';
const total = 70.5;
const spread = -20.5;

function book(key, overPrice, underPrice, homeSpreadPrice, awaySpreadPrice, homeMl, awayMl) {
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
      { key: 'spreads', outcomes: [
        { name: home, price: homeSpreadPrice, point: spread },
        { name: away, price: awaySpreadPrice, point: -spread },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: overPrice, point: total },
        { name: 'Under', price: underPrice, point: total },
      ] },
    ],
  };
}

const ev = {
  home_team: home,
  away_team: away,
  commence_time: '2026-10-12T17:00:00Z',
  bookmakers: [
    book('pinnacle', -115, -105, -118, 100, -280, 230),
    book('circa', -112, -108, -115, -105, -275, 225),
    book('draftkings', -110, -110, -110, -110, -270, 220),
  ],
};

const rows = cfb.project({ oddsEvents: [ev], standings: {}, efficiency: {}, gameDay: {} });
const over = rows.find((c) => c.market === 'Total' && c.side.startsWith('Over'));
const homeSpread = rows.find((c) => c.market === 'Spread' && c.side.startsWith(home));
const homeMl = rows.find((c) => c.market === 'Moneyline' && c.side === home);
assert.ok(over, 'NCAAF over');
assert.ok(homeSpread, 'NCAAF home spread');
assert.ok(homeMl, 'NCAAF home moneyline');

function blendAt(c, weight) {
  const key = c.market === 'Total' ? 'totals' : c.market === 'Spread' ? 'spreads' : 'h2h';
  const bundles = collectMarketOutcomes(ev, key);
  const wantSide = c.market === 'Total' ? 'Over' : home;
  const bundle = bundles.find((b) => b.side === wantSide && (c.market === 'Moneyline' || b.point === c.line));
  assert.ok(bundle, `${c.market} bundle`);
  const anchor = noVigPinnacleCircaImplied(bundles, bundle);
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

assert.ok(Math.abs(over.modelRawP - blendAt(over, 0.10)) < 1e-9, `total ${over.modelRawP}`);
assert.ok(Math.abs(over.modelRawP - blendAt(over, 0.4)) > 1e-3, 'NCAAF total must not stay on 0.4');
assert.ok(Math.abs(homeSpread.modelRawP - blendAt(homeSpread, 0.10)) < 1e-9, `spread ${homeSpread.modelRawP}`);
assert.ok(Math.abs(homeSpread.modelRawP - blendAt(homeSpread, 0.45)) > 1e-3, 'NCAAF spread must not stay on 0.45');
assert.ok(Math.abs(homeMl.modelRawP - blendAt(homeMl, 0.10)) < 1e-9, `ml ${homeMl.modelRawP}`);
assert.ok(Math.abs(homeMl.modelRawP - blendAt(homeMl, 0.45)) > 1e-3, 'NCAAF moneyline must not stay on 0.45');

console.log('PASS test-omega-ncaaf-model-weight');
