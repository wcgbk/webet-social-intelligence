'use strict';
// P0: two BAL@NYY games on 2026-09-25 bind different ESPN rows.
// No network. No card generate.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const mlb = require(path.join(root, 'sports/mlb'));
const nhl = require(path.join(root, 'sports/nhl'));
const nfl = require(path.join(root, 'sports/nfl'));
const { bindEspnGameByTeamAndTime, ESPN_ROW_CLEAR_MARGIN_MS, matchEspnGameByIdentity } = require(path.join(root, 'sports/_common'));
const { resolveTeamId } = require(path.join(root, 'sports/team_identity'));
const { indexMlbWeather } = require(path.join(root, 'ingest'));
const { matchFinal } = require(path.join(root, 'nba_shadow'));

assert.strictEqual(ESPN_ROW_CLEAR_MARGIN_MS, 75 * 60 * 1000);

function books(home, away, total, spread) {
  return ['pinnacle', 'draftkings'].map((key) => ({
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: -120 }, { name: away, price: 100 }] },
      { key: 'spreads', outcomes: [
        { name: home, price: -110, point: spread },
        { name: away, price: -110, point: -spread },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: -110, point: total },
        { name: 'Under', price: -110, point: total },
      ] },
    ],
  }));
}

function event(home, away, commence, total) {
  return {
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: books(home, away, total, -1.5),
  };
}

const NYY = 'New York Yankees';
const BAL = 'Baltimore Orioles';
const standings = {
  [NYY]: { pf: 700, pa: 680, wins: 80, losses: 70 },
  [BAL]: { pf: 700, pa: 680, wins: 80, losses: 70 },
};
const dayIso = '2026-09-25T20:05:00Z';
const nightOdds = '2026-09-25T23:06:00Z';
const nightEspn = '2026-09-25T23:30:00Z';

const dayRow = {
  homeTeam: NYY,
  awayTeam: BAL,
  commenceTime: dayIso,
  homeProbable: { name: 'Will Warren', id: '11' },
  awayProbable: { name: 'Cade Povich', id: '22' },
  weather: { tempF: 42, condition: 'Clear', windMph: 4 },
};
const nightRow = {
  homeTeam: NYY,
  awayTeam: BAL,
  commenceTime: nightEspn,
  homeProbable: { name: 'Carlos Rodon', id: '33' },
  awayProbable: { name: 'Trevor Rogers', id: '44' },
  weather: { tempF: 90, condition: 'Clear', windMph: 4 },
};
const pitchers = {
  byId: {
    11: { id: 11, name: 'Will Warren', quality: 0.8, ip: 140 },
    22: { id: 22, name: 'Cade Povich', quality: -0.4, ip: 140 },
    33: { id: 33, name: 'Carlos Rodon', quality: -1.2, ip: 140 },
    44: { id: 44, name: 'Trevor Rogers', quality: 0.6, ip: 140 },
  },
  byName: {},
  byTeam: {},
};

const cands = mlb.project({
  oddsEvents: [
    event(NYY, BAL, dayIso, 8.5),
    event(NYY, BAL, nightOdds, 8.5),
  ],
  standings,
  parkFactors: {},
  mlbPitcherStats: pitchers,
  espnGames: { games: [dayRow, nightRow] },
});

function totalsFor(iso) {
  return cands.filter((c) => c.market === 'Total' && c.commenceTime === iso);
}
const dayTot = totalsFor(dayIso)[0];
const nightTot = totalsFor(nightOdds)[0];
assert.ok(dayTot && nightTot, 'both doubleheader halves price a total');
assert.notStrictEqual(dayTot.modelProjection, nightTot.modelProjection, 'different probables must move the total');
const dayMl = cands.find((c) => c.market === 'Moneyline' && c.commenceTime === dayIso);
const nightMl = cands.find((c) => c.market === 'Moneyline' && c.commenceTime === nightOdds);
assert.strictEqual(dayMl.assumedStarter.name, 'Will Warren');
assert.strictEqual(nightMl.assumedStarter.name, 'Carlos Rodon');
assert.ok(String(dayTot.gameDay.weatherNote || '').includes('cold'), dayTot.gameDay.weatherNote);
assert.ok(String(nightTot.gameDay.weatherNote || '').includes('hot'), nightTot.gameDay.weatherNote);

// A collided name key must not repaint the bound row.
const poisoned = mlb.project({
  oddsEvents: [event(NYY, BAL, dayIso, 8.5)],
  standings,
  parkFactors: {},
  mlbPitcherStats: pitchers,
  espnGames: { games: [dayRow] },
  weatherByGame: { [`${BAL}|${NYY}`]: { tempF: 90, condition: 'Clear', windMph: 4 } },
});
const poisonedTot = poisoned.find((c) => c.market === 'Total');
assert.ok(String(poisonedTot.gameDay.weatherNote || '').includes('cold'), poisonedTot.gameDay.weatherNote);

const wx = indexMlbWeather([dayRow, nightRow]);
assert.strictEqual(wx[`${BAL}|${NYY}`], undefined, 'name key drops on a doubleheader collision');
assert.strictEqual(wx[`${BAL}|${NYY}|${dayIso}`].tempF, 42);
assert.strictEqual(wx[`${BAL}|${NYY}|${nightEspn}`].tempF, 90);
const single = indexMlbWeather([dayRow]);
assert.strictEqual(single[`${BAL}|${NYY}`].tempF, 42);

const oddsNight = { home_team: NYY, away_team: BAL, commence_time: nightOdds };
assert.strictEqual(bindEspnGameByTeamAndTime('MLB', oddsNight, [dayRow, nightRow]).homeProbable.name, 'Carlos Rodon');
assert.strictEqual(bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: BAL, commence_time: dayIso }, [dayRow]).homeProbable.name, 'Will Warren');

const closeA = { ...dayRow, commenceTime: '2026-09-25T20:00:00Z', homeProbable: { name: 'A', id: '1' } };
const closeB = { ...nightRow, commenceTime: '2026-09-25T20:55:00Z', homeProbable: { name: 'B', id: '2' } };
assert.strictEqual(
  bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: BAL, commence_time: '2026-09-25T20:00:00Z' }, [closeA, closeB]),
  null,
  '55 minutes is not a clear margin'
);
assert.strictEqual(
  bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: BAL, commence_time: '2026-09-25T21:40:00Z' }, [dayRow, nightRow]),
  null,
  'nearest beyond 75 minutes is a miss'
);
const far = { ...dayRow, commenceTime: '2026-09-25T12:00:00Z' };
assert.strictEqual(
  bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: BAL, commence_time: nightOdds }, [far]).commenceTime,
  far.commenceTime,
  'one row is kept even when the clock is far'
);
assert.strictEqual(
  bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: 'New York Mets', commence_time: dayIso }, [dayRow]),
  null,
  'last-word Yankees/Mets must not bind'
);

const hid = resolveTeamId('MLB', NYY);
const aid = resolveTeamId('MLB', BAL);
const byId = bindEspnGameByTeamAndTime('MLB', { home_team: NYY, away_team: BAL, commence_time: dayIso }, [{
  homeTeam: '',
  awayTeam: '',
  homeId: hid,
  awayId: aid,
  commenceTime: dayIso,
  homeProbable: { name: 'Id Only', id: '9' },
}]);
assert.strictEqual(byId.homeProbable.name, 'Id Only');

const sameDay = matchEspnGameByIdentity('MLB', { home_team: NYY, away_team: BAL, commence_time: nightOdds }, [dayRow, nightRow]);
assert.strictEqual(sameDay.homeProbable.name, 'Carlos Rodon');

// NHL goalies: first-row bind would give both games the same margin.
const BOS = 'Boston Bruins';
const BUF = 'Buffalo Sabres';
function nhlEv(commence) {
  return {
    home_team: BOS,
    away_team: BUF,
    commence_time: commence,
    bookmakers: books(BOS, BUF, 6.5, -1.5),
  };
}
function goalieRow(commence, homeSv, awaySv) {
  return {
    homeTeam: BOS,
    awayTeam: BUF,
    commenceTime: commence,
    homeGoalie: { savePct: homeSv, confirmed: true },
    awayGoalie: { savePct: awaySv, confirmed: true },
  };
}
const nhlEarly = '2026-10-10T17:00:00Z';
const nhlLate = '2026-10-10T23:00:00Z';
const nhlCands = nhl.project({
  oddsEvents: [nhlEv(nhlEarly), nhlEv(nhlLate)],
  standings: {},
  espnGames: {
    games: [
      goalieRow(nhlEarly, 0.910, 0.900),
      goalieRow(nhlLate, 0.900, 0.910),
    ],
  },
});
const nhlM = (iso) => nhlCands.find((c) => c.market === 'Moneyline' && c.commenceTime === iso).modelProjection;
assert.notStrictEqual(nhlM(nhlEarly), nhlM(nhlLate));

// NFL weather follows the nearest row, not the first name hit.
const KC = 'Kansas City Chiefs';
const BILLS = 'Buffalo Bills';
function nflEv(commence) {
  return {
    home_team: KC,
    away_team: BILLS,
    commence_time: commence,
    bookmakers: books(KC, BILLS, 45.5, -3.5),
  };
}
const nflEarly = '2026-10-11T17:00:00Z';
const nflLate = '2026-10-11T23:30:00Z';
const nflCands = nfl.project({
  oddsEvents: [nflEv(nflEarly), nflEv(nflLate)],
  standings: {},
  efficiency: {},
  espnGames: {
    games: [
      { homeTeam: KC, awayTeam: BILLS, commenceTime: nflEarly, weather: { windMph: 0, tempF: 70 } },
      { homeTeam: KC, awayTeam: BILLS, commenceTime: nflLate, weather: { windMph: 30, tempF: 70 } },
    ],
  },
});
const nflT = (iso) => nflCands.find((c) => c.market === 'Total' && c.commenceTime === iso).modelProjection;
assert.ok(nflT(nflLate) < nflT(nflEarly), `wind total ${nflT(nflLate)} vs calm ${nflT(nflEarly)}`);

const lakers = 'Los Angeles Lakers';
const celtics = 'Boston Celtics';
const finals = [
  { homeTeam: lakers, awayTeam: celtics, commenceTime: '2026-10-12T17:00:00Z', homeScore: 100, awayScore: 90 },
  { homeTeam: lakers, awayTeam: celtics, commenceTime: '2026-10-12T23:30:00Z', homeScore: 110, awayScore: 108 },
];
assert.strictEqual(matchFinal({
  homeTeam: lakers, awayTeam: celtics, commenceTime: '2026-10-12T23:00:00Z',
}, finals).homeScore, 110);
assert.strictEqual(matchFinal({
  homeTeam: lakers, awayTeam: celtics, commenceTime: '2026-10-12T19:00:00Z',
}, finals), null);

console.log('PASS test-omega-mlb-dh', {
  day: dayTot.modelProjection,
  night: nightTot.modelProjection,
  nhl: [nhlM(nhlEarly), nhlM(nhlLate)],
  nfl: [nflT(nflEarly), nflT(nflLate)],
});
