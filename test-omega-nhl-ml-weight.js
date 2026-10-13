'use strict';
/**
 * NHL moneyline blends at BLEND.ml 0.10.
 * Spread stays 0.50. Total stays 0.45. No network.
 */
process.env.OMEGA_NHL_PERIOD = '0';
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nhl = require(path.join(root, 'sports/nhl'));
const { blendWithMarket, totalCoverProb, spreadCoverProb, mlFromSpread } = require(path.join(root, 'sports/_common'));
const { collectMarketOutcomes, noVigPinnacleCircaImplied } = require(path.join(root, 'edge'));

assert.deepStrictEqual(nhl.BLEND, { ml: 0.10, spread: 0.50, total: 0.45 });
assert.strictEqual(config.MODEL_VERSION, 'v12.3.49-omega-vnext-price-lock');

const home = 'Colorado Avalanche';
const away = 'Dallas Stars';

function book(key) {
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [
        { name: home, price: key === 'pinnacle' ? -130 : -125 },
        { name: away, price: key === 'pinnacle' ? 110 : 105 },
      ] },
      { key: 'spreads', outcomes: [
        { name: home, price: -110, point: -1.5 },
        { name: away, price: -110, point: 1.5 },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: -110, point: 6.0 },
        { name: 'Under', price: -110, point: 6.0 },
      ] },
    ],
  };
}

const ev = {
  home_team: home,
  away_team: away,
  commence_time: '2026-10-06T23:10:00Z',
  bookmakers: ['pinnacle', 'circa', 'draftkings', 'fanduel'].map(book),
};

const rows = nhl.project({ oddsEvents: [ev], standings: {} });
const homeMl = rows.find((c) => c.market === 'Moneyline' && c.side === home);
const homeSpread = rows.find((c) => c.market === 'Spread' && c.side.startsWith(home));
const over = rows.find((c) => c.market === 'Total' && c.side.startsWith('Over'));
assert.ok(homeMl, 'NHL home moneyline');
assert.ok(homeSpread, 'NHL home spread');
assert.ok(over, 'NHL over');

function anchorFor(c) {
  const key = c.market === 'Total' ? 'totals' : c.market === 'Spread' ? 'spreads' : 'h2h';
  const bundles = collectMarketOutcomes(ev, key);
  const wantSide = c.market === 'Total' ? 'Over' : home;
  const bundle = bundles.find((b) => b.side === wantSide && (c.market === 'Moneyline' || b.point === c.line));
  assert.ok(bundle, `${c.market} bundle`);
  return noVigPinnacleCircaImplied(bundles, bundle);
}

function priced(c, weight) {
  const anchor = anchorFor(c);
  let p;
  if (c.market === 'Moneyline') p = mlFromSpread(c.modelProjection, 'NHL');
  else if (c.market === 'Spread') p = spreadCoverProb(c.modelProjection, c.line, 'NHL');
  else p = totalCoverProb(c.modelProjection, c.line, 'Over', 'NHL');
  return blendWithMarket(p, anchor, weight);
}

assert.ok(Math.abs(homeMl.modelRawP - priced(homeMl, 0.10)) < 1e-9, `ml ${homeMl.modelRawP}`);
assert.ok(Math.abs(homeMl.modelRawP - priced(homeMl, 0.50)) > 1e-3, 'NHL moneyline must not stay on 0.50');
assert.ok(Math.abs(homeSpread.modelRawP - priced(homeSpread, 0.50)) < 1e-9, `spread ${homeSpread.modelRawP}`);
assert.ok(Math.abs(homeSpread.modelRawP - priced(homeSpread, 0.10)) > 1e-3, 'NHL spread must stay on 0.50');
assert.ok(Math.abs(over.modelRawP - priced(over, 0.45)) < 1e-9, `total ${over.modelRawP}`);
assert.ok(Math.abs(over.modelRawP - priced(over, 0.10)) > 1e-3, 'NHL total must stay on 0.45');

console.log('PASS test-omega-nhl-ml-weight');
