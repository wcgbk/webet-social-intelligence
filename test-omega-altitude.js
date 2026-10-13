'use strict';
/**
 * Altitude is added on top of flat HFA, is 0 at a neutral site, and is capped.
 * No network.
 */
const assert = require('assert');
const { HFA } = require('./netlify/functions/lib/omega-vnext/config');
const alt = require('./netlify/functions/lib/omega-vnext/sports/altitude');
const nfl = require('./netlify/functions/lib/omega-vnext/sports/nfl');
const cfb = require('./netlify/functions/lib/omega-vnext/sports/cfb');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] == null) delete process.env[k];
    else process.env[k] = String(vars[k]);
  }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const denver = alt.altitudeHfaPoints({ home: 'Denver Broncos' });
assert.ok(Math.abs(denver - 0.590) < 1e-9, denver);
assert.strictEqual(alt.altitudeHfaPoints({ home: 'Denver Broncos', neutral: true }), 0);
assert.strictEqual(alt.altitudeHfaPoints({ home: 'Indianapolis Colts' }), 0);
assert.strictEqual(alt.altitudeHfaPoints({ venueName: 'University Stadium', home: 'Florida Gators' }), 0);

const wyoming = alt.homeFieldPoints(HFA.NCAAF, { home: 'Wyoming Cowboys' });
assert.ok(wyoming.altitude > 0 && wyoming.altitude <= alt.ALTITUDE_HFA_CAP);
assert.ok(Math.abs(wyoming.hfa - (HFA.NCAAF + wyoming.altitude)) < 1e-9);
const neutralWy = alt.homeFieldPoints(HFA.NCAAF, { home: 'Wyoming Cowboys', neutral: true });
assert.strictEqual(neutralWy.hfa, 0);
assert.strictEqual(neutralWy.altitude, 0);

const byVenue = alt.homeFieldPoints(HFA.NFL, {
  home: 'Las Vegas Raiders',
  espnGame: { venue: { displayName: 'Empower Field at Mile High' } },
});
assert.ok(Math.abs(byVenue.altitude - 0.590) < 1e-9, byVenue.altitude);

function event(home, away) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-18T20:00:00Z',
    bookmakers: [{
      key: 'pinnacle',
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -110 }, { name: away, price: -110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -2.5 },
          { name: away, price: -110, point: 2.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 44.5 },
          { name: 'Under', price: -110, point: 44.5 },
        ] },
      ],
    }],
  };
}

function spreadOf(rows, home) {
  const row = rows.find((c) => c.market === 'Spread' && c.side && c.side.indexOf(home.split(' ')[0]) === 0);
  assert.ok(row, 'missing spread');
  return row.modelProjection;
}

const board = withEnv({ OMEGA_FB_WEATHER: '0', OMEGA_NFL_ELO_WEIGHT: '0' }, () => ({
  den: nfl.project({ oddsEvents: [event('Denver Broncos', 'Las Vegas Raiders')], standings: {}, efficiency: {}, gameDay: {} }),
  ind: nfl.project({ oddsEvents: [event('Indianapolis Colts', 'Las Vegas Raiders')], standings: {}, efficiency: {}, gameDay: {} }),
  neu: nfl.project({
    oddsEvents: [event('Denver Broncos', 'Las Vegas Raiders')],
    standings: {},
    efficiency: {},
    gameDay: {},
    espnGames: [{
      homeTeam: 'Denver Broncos',
      awayTeam: 'Las Vegas Raiders',
      neutralSite: true,
      commenceTime: '2026-10-18T20:00:00Z',
    }],
  }),
}));
const den = spreadOf(board.den, 'Denver');
const ind = spreadOf(board.ind, 'Indianapolis');
assert.ok(Math.abs(den - (HFA.NFL + 0.590)) < 0.02, den);
assert.ok(Math.abs(ind - HFA.NFL) < 0.02, ind);
assert.ok(Math.abs(spreadOf(board.neu, 'Denver')) < 0.02, spreadOf(board.neu, 'Denver'));

const college = withEnv({ OMEGA_FB_WEATHER: '0', OMEGA_NCAAF_TEMPO_WEIGHT: '0' }, () => cfb.project({
  oddsEvents: [event('Wyoming Cowboys', 'Boise State Broncos')],
  standings: {},
  efficiency: {},
  gameDay: {},
}));
const wy = spreadOf(college, 'Wyoming');
assert.ok(wy > HFA.NCAAF, wy);
assert.ok(wy <= HFA.NCAAF + alt.ALTITUDE_HFA_CAP + 0.02, wy);

console.log('test-omega-altitude: ok');
