'use strict';
/**
 * NFL totals blend at NFL_TOTAL_MODEL_WEIGHT 0.10.
 * NFL spreads stay at 0.5. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nfl = require(path.join(root, 'sports/nfl'));
const { blendWithMarket, totalDetail, spreadDetail } = require(path.join(root, 'sports/_common'));
const { collectMarketOutcomes, noVigPinnacleCircaImplied } = require(path.join(root, 'edge'));

assert.strictEqual(config.NFL_TOTAL_MODEL_WEIGHT, 0.10);
assert.strictEqual(config.MODEL_VERSION, 'v12.3.72-omega-vnext-price-lock');

const home = 'Kansas City Chiefs';
const away = 'Buffalo Bills';
const total = 58.5;
const spread = -13.5;

function book(key, overPrice, underPrice, homeSpreadPrice, awaySpreadPrice) {
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: -140 }, { name: away, price: 120 }] },
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
    book('pinnacle', -115, -105, -118, 100),
    book('circa', -112, -108, -115, -105),
    book('draftkings', -110, -110, -110, -110),
  ],
};

const rows = nfl.project({ oddsEvents: [ev], standings: {}, efficiency: {}, gameDay: {} });
const over = rows.find((c) => c.market === 'Total' && c.side.startsWith('Over'));
const homeSpread = rows.find((c) => c.market === 'Spread' && c.side.startsWith(home));
assert.ok(over, 'NFL over');
assert.ok(homeSpread, 'NFL home spread');

function blendAt(c, weight) {
  const key = c.market === 'Total' ? 'totals' : 'spreads';
  const bundles = collectMarketOutcomes(ev, key);
  const wantSide = c.market === 'Total' ? 'Over' : home;
  const bundle = bundles.find((b) => b.side === wantSide && b.point === c.line);
  assert.ok(bundle, `${c.market} bundle`);
  const anchor = noVigPinnacleCircaImplied(bundles, bundle);
  const detailAt = c.market === 'Total'
    ? (proj) => totalDetail(proj, c.line, 'Over', 'NFL')
    : (proj) => spreadDetail(proj, c.line, 'NFL');
  const rawProj = c.market === 'Total' ? c.modelTotalRaw : c.modelMarginRaw;
  const shrunkProj = c.market === 'Total' ? c.modelTotalShrunk : c.modelMarginShrunk;
  const pRaw = blendWithMarket(detailAt(rawProj).coverProb, anchor, weight);
  const pShr = blendWithMarket(detailAt(shrunkProj).coverProb, anchor, weight);
  if (!Number.isFinite(pRaw)) return pShr;
  if (!Number.isFinite(pShr)) return pRaw;
  return pShr < pRaw ? pShr : pRaw;
}

assert.ok(Math.abs(over.modelRawP - blendAt(over, 0.10)) < 1e-9, `total ${over.modelRawP}`);
assert.ok(Math.abs(over.modelRawP - blendAt(over, 0.45)) > 1e-3, 'NFL total must not stay on 0.45');
assert.ok(Math.abs(homeSpread.modelRawP - blendAt(homeSpread, 0.5)) < 1e-9, `spread ${homeSpread.modelRawP}`);
assert.ok(Math.abs(homeSpread.modelRawP - blendAt(homeSpread, 0.10)) > 1e-3, 'NFL spread must stay on 0.5');

console.log('PASS test-omega-nfl-total-weight');
