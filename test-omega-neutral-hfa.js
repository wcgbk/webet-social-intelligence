'use strict';
/**
 * Neutral-site HFA. NFL and NCAAF only. A matched ESPN game
 * (resolved team ids + same America/New_York date, neutralSite === true)
 * projects with HFA 0 and game-day hfaBase 0. Unmatched keeps today's HFA
 * and does not grow a diag field. MLB neutralSite does not move the margin.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const mlb = require(path.join(root, 'sports/mlb'));
const epa = require(path.join(root, 'sports/epa'));
const { matchEspnGameByIdentity } = require(path.join(root, 'sports/_common'));
const { projectAll } = require(path.join(root, 'index'));
const { toPickObject } = require(path.join(root, 'select'));
const { pickPublic } = require(path.join(__dirname, 'netlify/functions/lib/public-picks'));

assert.strictEqual(config.HFA.NFL, 2.1);
assert.strictEqual(config.HFA.NCAAF, 2.6);
assert.strictEqual(config.HFA.MLB, 0.12);

function synthEvent(home, away, commence) {
  const spread = -3.5;
  const total = 45.5;
  return {
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: ['pinnacle', 'draftkings'].map(key => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ]},
      ],
    })),
  };
}

function spreadOf(cands) {
  const row = cands.find(c => c.market === 'Spread' && c.side && c.homeTeam && c.side.indexOf(c.homeTeam) === 0);
  assert.ok(row, 'home spread candidate');
  return row;
}

function assertNeutralDelta(project, sport, hfa, home, away) {
  const commence = '2026-10-04T13:30:00Z';
  const ev = synthEvent(home, away, commence);
  const espn = {
    homeTeam: home,
    awayTeam: away,
    commenceTime: '2026-10-05T03:30:00Z',
    neutralSite: true,
  };
  const neutral = spreadOf(project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [espn] } }));
  const homeField = spreadOf(project({ oddsEvents: [ev], standings: {}, efficiency: {} }));
  assert.strictEqual(
    neutral.modelProjection,
    +(homeField.modelProjection - hfa).toFixed(2),
    `${sport} neutral margin must be non-neutral minus HFA`
  );
  assert.strictEqual(neutral.modelProjection, homeField.modelProjection - hfa);
  assert.strictEqual(neutral.gameDay.hfaBase, 0);
  assert.deepStrictEqual(neutral.diag, { neutralSite: true });
  const totalN = neutral && project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [espn] } })
    .find(c => c.market === 'Total');
  const totalH = project({ oddsEvents: [ev], standings: {}, efficiency: {} }).find(c => c.market === 'Total');
  assert.strictEqual(totalN.modelProjection, totalH.modelProjection, `${sport} total ignores HFA`);

  const wrongDay = {
    homeTeam: home,
    awayTeam: away,
    commenceTime: '2026-10-05T05:00:00Z',
    neutralSite: true,
  };
  const unmatched = project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [wrongDay] } });
  const baseline = project({ oddsEvents: [ev], standings: {}, efficiency: {} });
  if (sport === 'NFL') {
    const row = spreadOf(unmatched);
    assert.strictEqual(row.gameDay.hfaBase, 0, 'NFL id-only fallback passes neutralSite');
    assert.deepStrictEqual(row.diag, { neutralSite: true });
    assert.strictEqual(row.modelProjection, +(spreadOf(baseline).modelProjection - hfa).toFixed(2));
    const wrongDayOff = { ...wrongDay, neutralSite: false };
    assert.deepStrictEqual(
      project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [wrongDayOff] } }),
      baseline,
      'NFL id-only non-neutral keeps HFA'
    );
  } else {
    assert.deepStrictEqual(unmatched, baseline, `${sport} different ET date stays on today's HFA`);
    assert.ok(!Object.prototype.hasOwnProperty.call(spreadOf(unmatched), 'diag'));
  }

  const notNeutral = {
    homeTeam: home,
    awayTeam: away,
    commenceTime: commence,
    neutralSite: false,
  };
  const flaggedString = {
    homeTeam: home,
    awayTeam: away,
    commenceTime: commence,
    neutralSite: 'true',
  };
  assert.deepStrictEqual(
    project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [notNeutral] } }),
    baseline,
    `${sport} neutralSite false keeps HFA`
  );
  assert.deepStrictEqual(
    project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [flaggedString] } }),
    baseline,
    `${sport} neutralSite must be boolean true`
  );

  const swapped = {
    homeTeam: away,
    awayTeam: home,
    commenceTime: commence,
    neutralSite: true,
  };
  assert.deepStrictEqual(
    project({ oddsEvents: [ev], standings: {}, efficiency: {}, espnGames: { games: [swapped] } }),
    baseline,
    `${sport} swapped sides do not match`
  );

  const noDate = synthEvent(home, away, null);
  const noDateBase = project({ oddsEvents: [noDate], standings: {}, efficiency: {} });
  const noDateHit = project({ oddsEvents: [noDate], standings: {}, efficiency: {}, espnGames: { games: [espn] } });
  if (sport === 'NFL') {
    const row = spreadOf(noDateHit);
    assert.strictEqual(row.gameDay.hfaBase, 0, 'NFL id match with no odds clock still passes neutralSite');
    assert.deepStrictEqual(row.diag, { neutralSite: true });
  } else {
    assert.deepStrictEqual(noDateHit, noDateBase, `${sport} missing commence time is unmatched`);
  }
}

assertNeutralDelta(nfl.project, 'NFL', config.HFA.NFL, 'Kansas City Chiefs', 'Buffalo Bills');
assertNeutralDelta(cfb.project, 'NCAAF', config.HFA.NCAAF, 'Ohio State Buckeyes', 'Iowa Hawkeyes');

{
  const eff = {
    'Kansas City Chiefs': { offEpa: 0.10, defEpa: 0.04 },
    'Buffalo Bills': { offEpa: 0.00, defEpa: 0.00 },
  };
  const home = epa.footballProjection({
    sport: 'NFL', home: 'Kansas City Chiefs', away: 'Buffalo Bills', standings: {}, efficiency: eff,
  });
  const neutral = epa.footballProjection({
    sport: 'NFL', home: 'Kansas City Chiefs', away: 'Buffalo Bills', standings: {}, efficiency: eff, hfa: 0,
  });
  assert.strictEqual(neutral.modelMargin, home.modelMargin - config.HFA.NFL);
  assert.strictEqual(neutral.modelTotal, home.modelTotal);
  assert.ok(Math.abs(home.modelMargin) < epa.SPORT_CFG.NFL.marginCap - 1);
}

{
  const ev = synthEvent('Kansas City Chiefs', 'Buffalo Bills', '2026-10-04T23:30:00Z');
  const hit = matchEspnGameByIdentity('NFL', ev, [{
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    commenceTime: '2026-10-04T13:30:00Z',
    neutralSite: true,
  }]);
  assert.ok(hit && hit.neutralSite === true);
  const miss = matchEspnGameByIdentity('NFL', ev, [{
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    commenceTime: '2026-10-05T05:00:00Z',
    neutralSite: true,
  }]);
  assert.strictEqual(miss, null);
  assert.strictEqual(matchEspnGameByIdentity('NFL', ev, [{
    homeTeam: 'Not A Club',
    awayTeam: 'Buffalo Bills',
    commenceTime: '2026-10-04T23:30:00Z',
    neutralSite: true,
  }]), null);
}

{
  const ev = synthEvent('New York Yankees', 'Boston Red Sox', '2026-10-04T23:00:00Z');
  ev.bookmakers[0].markets[2].outcomes[0].point = 8.5;
  ev.bookmakers[0].markets[2].outcomes[1].point = 8.5;
  ev.bookmakers[1].markets[2].outcomes[0].point = 8.5;
  ev.bookmakers[1].markets[2].outcomes[1].point = 8.5;
  const espn = {
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox',
    commenceTime: '2026-10-04T23:00:00Z',
    neutralSite: true,
  };
  const neutral = mlb.project({ oddsEvents: [ev], standings: {}, espnGames: { games: [espn] } });
  const base = mlb.project({ oddsEvents: [ev], standings: {} });
  assert.deepStrictEqual(neutral, base, 'MLB neutralSite does not change the projection');
  assert.strictEqual(neutral.find(c => c.market === 'Spread').gameDay.hfaBase, config.HFA.MLB);
  assert.ok(!Object.prototype.hasOwnProperty.call(neutral[0], 'diag'));
}

{
  const ev = synthEvent('Ohio State Buckeyes', 'Iowa Hawkeyes', '2026-10-09T23:30:00Z');
  const snap = {
    oddsBySport: { MLB: [], NFL: [], NCAAF: [ev], NBA: [], NHL: [] },
    standingsBySport: { MLB: {}, NFL: {}, NCAAF: {}, NBA: {}, NHL: {} },
    efficiencyBySport: { NCAAF: {} },
    espnBySport: {
      NCAAF: {
        games: [{
          homeTeam: 'Ohio State Buckeyes',
          awayTeam: 'Iowa Hawkeyes',
          commenceTime: '2026-10-10T02:30:00Z',
          neutralSite: true,
        }],
      },
    },
    gameDay: {},
  };
  const rows = projectAll(snap).filter(c => c.sport === 'NCAAF' && c.market === 'Spread');
  assert.ok(rows.length > 0);
  assert.ok(rows.every(c => c.diag && c.diag.neutralSite === true));
  assert.ok(rows.every(c => c.gameDay && c.gameDay.hfaBase === 0));
  const pick = toPickObject(rows[0], { modelVersion: config.MODEL_VERSION });
  assert.ok(!Object.prototype.hasOwnProperty.call(pick, 'diag'));
  assert.ok(!Object.prototype.hasOwnProperty.call(pick, 'neutralSite'));
  const pub = pickPublic(pick);
  assert.ok(!/Alpha|Omega/.test(JSON.stringify(pub)));
}

console.log('test-omega-neutral-hfa: ok');
