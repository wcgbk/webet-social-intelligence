'use strict';
/**
 * The live card excludes NBA unless the code flag is on, and that flag
 * stays off. OMEGA_NBA unset does not put NBA on the card. The shadow
 * function loads. No network.
 */
const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { projectAll } = require('./netlify/functions/lib/omega-vnext/index');
const http = require('./netlify/functions/omega-nba-shadow');

assert.strictEqual(typeof http.handler, 'function');
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.NBA_CARD_LIVE, false);
assert.strictEqual(config.NBA_SHADOW.enabled, true);
assert.notStrictEqual(process.env.OMEGA_NBA, '1');

function event(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-21T23:30:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -2.5 },
          { name: away, price: -110, point: 2.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 220.5 },
          { name: 'Under', price: -110, point: 220.5 },
        ] },
      ],
    })),
  };
}

const snap = {
  oddsBySport: {
    MLB: [],
    NFL: [],
    NCAAF: [],
    NHL: [event('Colorado Avalanche', 'Dallas Stars')],
    NBA: [event('Boston Celtics', 'New York Knicks')],
  },
  standingsBySport: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} },
  espnBySport: {
    NHL: { games: [{ homeTeam: 'Colorado Avalanche', awayTeam: 'Dallas Stars', seasonType: 2 }] },
    NBA: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 2, preseason: false }] },
  },
  efficiencyBySport: { NFL: {}, NCAAF: {} },
  parkFactors: {},
  mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
  gameDay: { restByTeam: { NHL: {}, NBA: {} } },
};

const prev = process.env.OMEGA_NBA;
try {
  delete process.env.OMEGA_NBA;
  for (const value of [undefined, '', '0', 'off', 'false', 'true']) {
    if (value == null) delete process.env.OMEGA_NBA;
    else process.env.OMEGA_NBA = value;
    const slate = projectAll(snap);
    assert.ok(slate.length >= 0);
    assert.ok(!slate.some((c) => c.sport === 'NBA'), `OMEGA_NBA=${value == null ? 'unset' : value}`);
  }
  process.env.OMEGA_NBA = '1';
  assert.ok(!projectAll(snap).some((c) => c.sport === 'NBA'), 'OMEGA_NBA=1 still does not publish NBA');
} finally {
  if (prev == null) delete process.env.OMEGA_NBA;
  else process.env.OMEGA_NBA = prev;
}

assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.NBA_CARD_LIVE, false);
console.log('test-omega-nba-flag ok');
