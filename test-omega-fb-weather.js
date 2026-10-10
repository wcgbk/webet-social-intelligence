'use strict';
/**
 * Football weather. Stadium coverage, total-only NWS math, and injected
 * fetch. This file does not call the network: global fetch throws.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const wx = require(path.join(root, 'sports/football_weather'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const ingest = require(path.join(root, 'ingest'));

const prevFlag = process.env.OMEGA_FB_WEATHER;
const prevFixture = process.env.OMEGA_FB_WEATHER_FIXTURE_DIR;
const prevRest = process.env.OMEGA_REST_SCHEDULE_DIR;
const prevFetch = global.fetch;
delete process.env.OMEGA_FB_WEATHER;
delete process.env.OMEGA_FB_WEATHER_FIXTURE_DIR;
global.fetch = async () => {
  throw new Error('network disabled in fb weather tests');
};

function restoreEnv() {
  if (prevFlag == null) delete process.env.OMEGA_FB_WEATHER;
  else process.env.OMEGA_FB_WEATHER = prevFlag;
  if (prevFixture == null) delete process.env.OMEGA_FB_WEATHER_FIXTURE_DIR;
  else process.env.OMEGA_FB_WEATHER_FIXTURE_DIR = prevFixture;
  if (prevRest == null) delete process.env.OMEGA_REST_SCHEDULE_DIR;
  else process.env.OMEGA_REST_SCHEDULE_DIR = prevRest;
  global.fetch = prevFetch;
}

function near(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg || 'near'} ${actual} vs ${expected}`);
}

function roundCoord(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function fixtureFile(lat, lon, kind) {
  return `${roundCoord(lat).toFixed(4)}_${roundCoord(lon).toFixed(4)}.${kind}.json`;
}

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function hourlyAt(kickoffIso, specs) {
  const start = Date.parse(kickoffIso);
  const periods = [];
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    periods.push({
      startTime: new Date(start + i * 3600000).toISOString(),
      endTime: new Date(start + (i + 1) * 3600000).toISOString(),
      windSpeed: spec.wind,
      temperature: spec.temp,
      temperatureUnit: spec.unit || 'F',
      probabilityOfPrecipitation: { value: spec.pop },
    });
  }
  return { properties: { periods } };
}

function pointsBody() {
  return {
    properties: {
      forecastHourly: 'https://api.weather.gov/gridpoints/TEST/1,1/forecast/hourly',
    },
  };
}

const KICK = '2026-10-11T17:00:00Z';
const NOW = '2026-10-11T12:00:00Z';

function game(sport, home, away, extra) {
  return Object.assign({
    sport,
    homeTeam: home,
    awayTeam: away,
    commenceTime: KICK,
    neutralSite: false,
  }, extra || {});
}

function lambeauGame(extra) {
  return game('NFL', 'Green Bay Packers', 'Chicago Bears', extra);
}

function rowFrom(loaded, sport) {
  const rows = Object.values(loaded.weatherByGame).filter((r) => r && r.sport === sport);
  assert.ok(rows.length, 'missing weather row');
  return rows[0];
}

function synth(home, away, commence) {
  const total = 45.5;
  const spread = -3.5;
  return {
    id: `${away}-${home}`,
    sport_key: 'americanfootball_nfl',
    home_team: home,
    away_team: away,
    commence_time: commence || KICK,
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -125 }, { name: away, price: 105 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ] },
      ],
    })),
  };
}

function findSide(cands, market, re) {
  const hit = cands.find((c) => c.market === market && re.test(c.side));
  assert.ok(hit, `missing ${market} ${re}`);
  return hit;
}

const NFL_STD = {
  'Green Bay Packers': { wins: 3, losses: 1, pf: 100, pa: 70, games: 4 },
  'Chicago Bears': { wins: 2, losses: 2, pf: 80, pa: 80, games: 4 },
  'New Orleans Saints': { wins: 2, losses: 2, pf: 80, pa: 75, games: 4 },
  'Atlanta Falcons': { wins: 2, losses: 2, pf: 85, pa: 80, games: 4 },
};
const NCAAF_STD = {
  'Alabama Crimson Tide': { wins: 4, losses: 0, pf: 160, pa: 60, games: 4 },
  'Auburn Tigers': { wins: 2, losses: 2, pf: 100, pa: 90, games: 4 },
};

function projectNfl(event, gameDay, espnGame) {
  return nfl.project({
    oddsEvents: [event],
    standings: NFL_STD,
    efficiency: {},
    gameDay,
    espnGames: espnGame ? { games: [espnGame] } : { games: [] },
  });
}

function projectCfb(event, gameDay, espnGame) {
  return cfb.project({
    oddsEvents: [event],
    standings: NCAAF_STD,
    efficiency: {},
    gameDay,
    espnGames: espnGame ? { games: [espnGame] } : { games: [] },
  });
}

function wxRow(sport, away, home, commence, extra) {
  const norm = (value) => String(value).toLowerCase();
  const key = `FB|${sport}|name|${norm(away)}|${norm(home)}|${commence}`;
  return {
    key,
    row: Object.assign({
      sport,
      homeTeam: home,
      awayTeam: away,
      commenceTime: commence,
      roof: 'open',
      source: 'nws',
      fetchedAt: '2026-10-11T12:00:00.000Z',
      reason: 'ok',
      windMph: 20,
      precipProb: 10,
      tempF: 55,
      stadium: 'Test Stadium',
      neutralSite: false,
    }, extra || {}),
  };
}

async function main() {
  assert.strictEqual(config.MODEL_VERSION, 'v12.3.18-omega-vnext-keys');
  assert.ok(/api\.weather\.gov/.test(config.MODEL_NOTES) && /0\.35/.test(config.MODEL_NOTES));
  assert.strictEqual(config.FB_WEATHER.k.NFL, 0.35);
  assert.strictEqual(config.FB_WEATHER.k.NCAAF, 0.35);
  assert.strictEqual(config.FB_WEATHER.windCap, 4);
  assert.strictEqual(config.FB_WEATHER.totalCap, 4.5);
  assert.strictEqual(config.fbWeatherEnabled(), true);

  const nflIds = require(path.join(root, 'sports/data/nfl-team-ids.json'));
  const ncaafIds = require(path.join(root, 'sports/data/ncaaf-team-ids.json'));
  const stadiums = wx.STADIUMS;
  const nflTeams = Object.keys(nflIds.teams);
  const fbsTeams = Object.entries(ncaafIds.teams)
    .filter(([, row]) => row && row.division === 'fbs')
    .map(([id]) => id);
  assert.strictEqual(nflTeams.length, 32);
  assert.strictEqual(fbsTeams.length, 138);
  assert.strictEqual(Object.keys(stadiums.teams.NFL).length, 32);
  assert.strictEqual(Object.keys(stadiums.teams.NCAAF).length, 138);

  const roofs = new Set(['dome', 'retractable', 'open']);
  for (const id of nflTeams) {
    const row = stadiums.teams.NFL[id];
    assert.ok(row, `NFL ${id} missing`);
    assert.ok(row.name, `NFL ${id} name`);
    assert.ok(roofs.has(row.roof), `NFL ${id} roof ${row.roof}`);
    assert.ok(wx.coordinatesInUsHi(row.lat, row.lon), `NFL ${id} ${row.lat},${row.lon}`);
  }
  for (const id of fbsTeams) {
    const row = stadiums.teams.NCAAF[id];
    assert.ok(row, `FBS ${id} missing`);
    assert.ok(row.name, `FBS ${id} name`);
    assert.ok(roofs.has(row.roof), `FBS ${id} roof ${row.roof}`);
    assert.ok(wx.coordinatesInUsHi(row.lat, row.lon), `FBS ${id} ${row.name} ${row.lat},${row.lon}`);
  }

  const nflRoof = (roof) => nflTeams.filter((id) => stadiums.teams.NFL[id].roof === roof).sort((a, b) => Number(a) - Number(b));
  assert.deepStrictEqual(nflRoof('retractable'), ['1', '6', '11', '22', '34']);
  assert.deepStrictEqual(nflRoof('dome'), ['8', '13', '14', '16', '18', '24']);
  const fbsDome = fbsTeams.filter((id) => stadiums.teams.NCAAF[id].roof === 'dome').sort((a, b) => Number(a) - Number(b));
  const fbsRetract = fbsTeams.filter((id) => stadiums.teams.NCAAF[id].roof === 'retractable');
  assert.deepStrictEqual(fbsDome, ['183', '2439', '2449', '2636']);
  assert.deepStrictEqual(fbsRetract, []);

  const kc = stadiums.teams.NFL['12'];
  near(kc.lat, 39.049, 0.01, 'arrowhead lat');
  near(kc.lon, -94.484, 0.01, 'arrowhead lon');
  const gb = stadiums.teams.NFL['9'];
  near(gb.lat, 44.501, 0.01, 'lambeau lat');
  near(gb.lon, -88.062, 0.01, 'lambeau lon');
  assert.strictEqual(gb.roof, 'open');

  const uab = stadiums.teams.NCAAF['5'];
  assert.ok(/protective/i.test(uab.name), uab.name);
  near(uab.lat, 33.523, 0.01, 'uab lat');
  near(uab.lon, -86.811, 0.01, 'uab lon');
  const illinois = stadiums.teams.NCAAF['356'];
  near(illinois.lat, 40.099, 0.02, 'illinois lat');
  near(illinois.lon, -88.236, 0.02, 'illinois lon');
  assert.ok(illinois.lon < -85, 'illinois is not in Virginia');
  const unlv = stadiums.teams.NCAAF['2439'];
  assert.strictEqual(unlv.roof, 'dome');
  near(unlv.lat, 36.091, 0.01, 'unlv lat');
  near(unlv.lon, -115.183, 0.01, 'unlv lon');
  assert.ok(Math.abs(unlv.lon + 115.017) > 0.05, 'unlv is not Sam Boyd');
  const hawaii = stadiums.teams.NCAAF['62'];
  assert.ok(wx.coordinatesInUsHi(hawaii.lat, hawaii.lon));
  assert.ok(hawaii.lat < 23, 'hawaii lat');
  assert.strictEqual(stadiums.venues.NCAAF['499'].name.includes('Cotton') || /cotton/i.test(stadiums.venues.NCAAF['499'].name), true);
  assert.strictEqual(stadiums.venues.NFL['499'].venueId, '499');
  const tottenham = stadiums.venues.NFL['5534'];
  assert.ok(tottenham);
  assert.strictEqual(wx.coordinatesInUsHi(tottenham.lat, tottenham.lon), false);
  assert.ok(!stadiums.teams.NFL['2'].name || /highmark/i.test(stadiums.teams.NFL['2'].name));
  assert.ok(/auburn|jordan/i.test(stadiums.teams.NCAAF['2'].name));

  assert.strictEqual(wx.parseWindMph('10 to 15 mph'), 12.5);
  assert.strictEqual(wx.parseWindMph('15 mph'), 15);
  assert.strictEqual(wx.parseWindMph(''), null);

  function adj(input) {
    return wx.footballWeatherAdjustment(Object.assign({ sport: 'NFL', roof: 'open' }, input));
  }
  assert.strictEqual(adj({ windMph: 10 }).totalAdj, 0);
  assert.strictEqual(adj({ windMph: 11 }).totalAdj, -0.35);
  assert.strictEqual(adj({ windMph: 20 }).totalAdj, -3.5);
  assert.strictEqual(adj({ windMph: 22 }).totalAdj, -4);
  assert.strictEqual(adj({ windMph: 22 }).windAdj, -4);
  const stacked = adj({ windMph: 30, precipProb: 70, tempF: 19 });
  assert.strictEqual(stacked.windAdj, -4);
  assert.strictEqual(stacked.precipAdj, -0.5);
  assert.strictEqual(stacked.coldAdj, -0.5);
  assert.strictEqual(stacked.totalAdj, -4.5);
  assert.strictEqual(adj({ windMph: 0, precipProb: 69.9, tempF: 20 }).totalAdj, 0);
  assert.strictEqual(adj({ windMph: 0, tempF: 19.9 }).coldAdj, -0.5);
  assert.strictEqual(adj({ windMph: 30, roof: 'dome' }).totalAdj, 0);
  assert.strictEqual(adj({ windMph: 30, roof: 'retractable', knownOpen: false }).totalAdj, 0);
  assert.strictEqual(adj({ windMph: 20, roof: 'retractable', knownOpen: true }).totalAdj, -3.5);
  assert.strictEqual(wx.footballWeatherAdjustment({ sport: 'NCAAF', roof: 'open', windMph: 11 }).totalAdj, -0.35);

  const averaged = wx.averageHours([
    { startTime: KICK, endTime: '2026-10-11T18:00:00Z', windSpeed: '10 mph', temperature: 0, temperatureUnit: 'C', probabilityOfPrecipitation: { value: 0 } },
  ], Date.parse(KICK));
  assert.strictEqual(averaged.tempF, 32);
  assert.strictEqual(averaged.windMph, 10);

  wx.clearPointsCache();
  const seenHeaders = [];
  let pointCalls = 0;
  let hourlyCalls = 0;
  const breeze = [
    { wind: '10 to 15 mph', temp: 55, pop: 10 },
    { wind: '15 to 20 mph', temp: 54, pop: 20 },
    { wind: '20 mph', temp: 53, pop: 0 },
  ];
  async function okFetch(url, init) {
    seenHeaders.push(init && init.headers);
    if (String(url).includes('/points/')) {
      pointCalls += 1;
      return jsonResp(pointsBody());
    }
    hourlyCalls += 1;
    return jsonResp(hourlyAt(KICK, breeze));
  }
  const gbPin = stadiums.teams.NFL['9'];
  const two = await wx.loadFootballWeather({
    games: [
      lambeauGame(),
      lambeauGame({ awayTeam: 'Minnesota Vikings', id: 'second' }),
    ],
    fetchImpl: okFetch,
    now: NOW,
    budgetMs: 8000,
    callTimeoutMs: 500,
  });
  assert.strictEqual(pointCalls, 1);
  assert.strictEqual(hourlyCalls, 1);
  assert.strictEqual(two.meta.calls.points, 1);
  assert.strictEqual(two.meta.calls.hourly, 1);
  assert.ok(seenHeaders.every((h) => h && h['User-Agent'] && /omega-vnext\/football-weather/.test(h['User-Agent'])));
  const gbRow = rowFrom(two, 'NFL');
  assert.strictEqual(gbRow.reason, 'ok');
  assert.strictEqual(gbRow.source, 'nws');
  assert.strictEqual(gbRow.windMph, 16.67);
  assert.ok(gbRow.fetchedAt);
  const applied = wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 45,
    gameDay: { weatherByGame: two.weatherByGame },
    event: synth('Green Bay Packers', 'Chicago Bears'),
  });
  assert.strictEqual(applied.used, true);
  assert.strictEqual(applied.totalAdj, -2.33);
  assert.strictEqual(applied.modelTotal, 42.67);
  assert.strictEqual(applied.fbWeather.source, 'nws');

  pointCalls = 0;
  hourlyCalls = 0;
  const again = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: okFetch,
    now: NOW,
    budgetMs: 8000,
    callTimeoutMs: 500,
  });
  assert.strictEqual(pointCalls, 0, 'points cache');
  assert.strictEqual(hourlyCalls, 1, 'hourly is per generate');
  assert.strictEqual(again.meta.calls.points, 0);
  assert.strictEqual(again.meta.calls.hourly, 1);

  const miamiNfl = stadiums.teams.NFL['15'];
  const miamiCfb = Object.values(stadiums.teams.NCAAF).find((row) => row.venueId && row.venueId === miamiNfl.venueId);
  if (miamiCfb && miamiCfb.roof === 'open' && wx.coordKey(miamiNfl.lat, miamiNfl.lon) === wx.coordKey(miamiCfb.lat, miamiCfb.lon)) {
    wx.clearPointsCache();
    pointCalls = 0;
    hourlyCalls = 0;
    const shared = await wx.loadFootballWeather({
      games: [
        game('NFL', miamiNfl.team, 'Buffalo Bills', { id: 'nfl-mia' }),
        game('NCAAF', miamiCfb.team, 'Florida State Seminoles', { id: 'cfb-mia' }),
      ],
      fetchImpl: okFetch,
      now: NOW,
    });
    assert.strictEqual(pointCalls, 1, 'shared outdoor venue one points call');
    assert.strictEqual(hourlyCalls, 1, 'shared outdoor venue one hourly call');
    assert.strictEqual(shared.meta.calls.points, 1);
  }

  wx.clearPointsCache();
  let failedCalls = 0;
  const failed = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: async () => {
      failedCalls += 1;
      return jsonResp({ title: 'nope' }, 500);
    },
    now: NOW,
    callTimeoutMs: 200,
  });
  assert.ok(failedCalls >= 1);
  assert.strictEqual(rowFrom(failed, 'NFL').reason, 'error');
  const soft = wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 47.2,
    gameDay: { weatherByGame: failed.weatherByGame },
    event: synth('Green Bay Packers', 'Chicago Bears'),
  });
  assert.strictEqual(soft.used, false);
  assert.strictEqual(soft.totalAdj, 0);
  assert.strictEqual(soft.modelTotal, 47.2);

  wx.clearPointsCache();
  let hung = 0;
  const timed = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: (url, init) => {
      hung += 1;
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    },
    now: NOW,
    budgetMs: 2000,
    callTimeoutMs: 80,
  });
  assert.ok(hung >= 1);
  assert.strictEqual(rowFrom(timed, 'NFL').reason, 'timeout');
  assert.strictEqual(wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 44,
    gameDay: { weatherByGame: timed.weatherByGame },
    event: synth('Green Bay Packers', 'Chicago Bears'),
  }).used, false);

  wx.clearPointsCache();
  const brokeBudget = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: async () => { throw new Error('should not fetch'); },
    now: NOW,
    budgetMs: 0,
  });
  assert.strictEqual(brokeBudget.meta.calls.points, 0);
  assert.strictEqual(brokeBudget.meta.calls.hourly, 0);
  assert.strictEqual(rowFrom(brokeBudget, 'NFL').reason, 'budget');

  const far = await wx.loadFootballWeather({
    games: [lambeauGame({ commenceTime: '2026-10-20T17:00:00Z' })],
    fetchImpl: async () => { throw new Error('should not fetch'); },
    now: '2026-10-11T12:00:00Z',
  });
  assert.strictEqual(rowFrom(far, 'NFL').reason, 'beyond-horizon');
  assert.strictEqual(far.meta.calls.points, 0);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbwx-'));
  const pointsPath = path.join(fixtureDir, fixtureFile(gbPin.lat, gbPin.lon, 'points'));
  const hourlyPath = path.join(fixtureDir, fixtureFile(gbPin.lat, gbPin.lon, 'hourly'));
  fs.writeFileSync(pointsPath, JSON.stringify(pointsBody()));
  fs.writeFileSync(hourlyPath, JSON.stringify(hourlyAt(KICK, [
    { wind: '20 mph', temp: 50, pop: 0 },
    { wind: '20 mph', temp: 50, pop: 0 },
    { wind: '20 mph', temp: 50, pop: 0 },
  ])));
  wx.clearPointsCache();
  const fromFixture = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fixtureDir,
    fetchImpl: async () => { throw new Error('fixture must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(fromFixture.meta.calls.points, 0);
  assert.strictEqual(rowFrom(fromFixture, 'NFL').source, 'fixture');
  assert.strictEqual(rowFrom(fromFixture, 'NFL').windMph, 20);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbwx-miss-'));
  wx.clearPointsCache();
  const missingFx = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fixtureDir: emptyDir,
    fetchImpl: async () => { throw new Error('missing fixture must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(rowFrom(missingFx, 'NFL').reason, 'error');

  process.env.OMEGA_FB_WEATHER_FIXTURE_DIR = fixtureDir;
  wx.clearPointsCache();
  const fromEnv = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: async () => { throw new Error('env fixture must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(rowFrom(fromEnv, 'NFL').source, 'fixture');
  const explicitOff = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fixtureDir: null,
    fetchImpl: async () => jsonResp(pointsBody()),
    now: NOW,
    budgetMs: 0,
  });
  assert.strictEqual(rowFrom(explicitOff, 'NFL').reason, 'budget');
  delete process.env.OMEGA_FB_WEATHER_FIXTURE_DIR;

  wx.clearPointsCache();
  let neutralCalls = 0;
  const cotton = stadiums.venues.NCAAF['499'];
  const neutral = await wx.loadFootballWeather({
    games: [game('NCAAF', 'Oklahoma Sooners', 'Texas Longhorns', {
      neutralSite: true,
      venue: { id: '499', name: 'Cotton Bowl', city: 'Dallas', state: 'TX' },
      id: 'rr',
    })],
    fetchImpl: async (url) => {
      neutralCalls += 1;
      if (String(url).includes('/points/')) {
        assert.ok(String(url).includes(wx.coordKey(cotton.lat, cotton.lon)), String(url));
        return jsonResp(pointsBody());
      }
      return jsonResp(hourlyAt(KICK, [
        { wind: '20 mph', temp: 70, pop: 10 },
        { wind: '20 mph', temp: 70, pop: 10 },
        { wind: '20 mph', temp: 70, pop: 10 },
      ]));
    },
    now: NOW,
  });
  assert.strictEqual(neutralCalls, 2);
  const cottonRow = rowFrom(neutral, 'NCAAF');
  assert.strictEqual(cottonRow.reason, 'ok');
  assert.strictEqual(cottonRow.venueId, '499');
  assert.strictEqual(cottonRow.neutralSite, true);
  near(cottonRow.lat, cotton.lat, 0.0001, 'cotton lat');
  assert.ok(cottonRow.lat < 34, 'not Norman');
  assert.strictEqual(wx.footballTotalFromGameDay({
    sport: 'NCAAF',
    modelTotal: 55,
    gameDay: { weatherByGame: neutral.weatherByGame },
    event: synth('Oklahoma Sooners', 'Texas Longhorns'),
    espnGame: { neutralSite: true, homeTeam: 'Oklahoma Sooners', awayTeam: 'Texas Longhorns', commenceTime: KICK },
  }).totalAdj, -3.5);

  wx.clearPointsCache();
  const unknown = await wx.loadFootballWeather({
    games: [game('NFL', 'New Orleans Saints', 'Atlanta Falcons', {
      neutralSite: true,
      venue: { id: '999991', name: 'Some London Ground' },
    })],
    fetchImpl: async () => { throw new Error('unknown venue must not fetch'); },
    now: NOW,
  });
  const unknownRow = rowFrom(unknown, 'NFL');
  assert.strictEqual(unknownRow.reason, 'unknown-venue');
  assert.strictEqual(unknown.meta.calls.points, 0);
  const unknownAdj = wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 44,
    gameDay: { weatherByGame: unknown.weatherByGame },
    event: synth('New Orleans Saints', 'Atlanta Falcons'),
  });
  assert.strictEqual(unknownAdj.used, true);
  assert.strictEqual(unknownAdj.totalAdj, 0);
  assert.strictEqual(unknownAdj.modelTotal, 44);

  wx.clearPointsCache();
  const london = await wx.loadFootballWeather({
    games: [game('NFL', 'New York Jets', 'Minnesota Vikings', {
      neutralSite: true,
      venue: { id: '5534', name: 'Tottenham Hotspur Stadium' },
    })],
    fetchImpl: async () => { throw new Error('outside nws must not fetch'); },
    now: NOW,
  });
  const londonRow = rowFrom(london, 'NFL');
  assert.strictEqual(londonRow.reason, 'outside-nws');
  assert.strictEqual(london.meta.calls.points, 0);
  assert.strictEqual(wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 46.5,
    gameDay: { weatherByGame: london.weatherByGame },
    event: synth('New York Jets', 'Minnesota Vikings'),
  }).totalAdj, 0);

  wx.clearPointsCache();
  const dome = await wx.loadFootballWeather({
    games: [game('NFL', 'New Orleans Saints', 'Atlanta Falcons')],
    fetchImpl: async () => { throw new Error('dome must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(rowFrom(dome, 'NFL').reason, 'roof');
  assert.strictEqual(dome.meta.calls.points, 0);
  assert.strictEqual(wx.footballTotalFromGameDay({
    sport: 'NFL',
    modelTotal: 48,
    gameDay: { weatherByGame: dome.weatherByGame },
    event: synth('New Orleans Saints', 'Atlanta Falcons'),
  }).totalAdj, 0);

  const retract = await wx.loadFootballWeather({
    games: [game('NFL', 'Atlanta Falcons', 'Carolina Panthers')],
    fetchImpl: async () => { throw new Error('retractable must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(rowFrom(retract, 'NFL').reason, 'roof');

  process.env.OMEGA_FB_WEATHER = '0';
  const disabled = await wx.loadFootballWeather({
    games: [lambeauGame()],
    fetchImpl: async () => { throw new Error('disabled must not fetch'); },
    now: NOW,
  });
  assert.strictEqual(disabled.disabled, true);
  assert.deepStrictEqual(disabled.weatherByGame, {});
  delete process.env.OMEGA_FB_WEATHER;

  const heavy = wxRow('NFL', 'Chicago Bears', 'Green Bay Packers', KICK, { windMph: 30, precipProb: 0, tempF: 60 });
  const calmGd = { weatherByGame: {} };
  const windGd = { weatherByGame: { [heavy.key]: heavy.row } };
  const event = synth('Green Bay Packers', 'Chicago Bears');
  const espnWind = {
    homeTeam: 'Green Bay Packers',
    awayTeam: 'Chicago Bears',
    commenceTime: KICK,
    indoor: false,
    weather: { tempF: 60, windMph: 30, condition: 'Windy' },
  };
  const bare = projectNfl(event, calmGd, null);
  const nws = projectNfl(event, windGd, espnWind);
  const espnOnly = projectNfl(event, calmGd, espnWind);
  const bareOver = findSide(bare, 'Total', /^Over/);
  const nwsOver = findSide(nws, 'Total', /^Over/);
  const espnOver = findSide(espnOnly, 'Total', /^Over/);
  assert.strictEqual(nwsOver.gameDay.weatherTotalAdj, -4);
  assert.strictEqual(nwsOver.gameDay.weatherSource, 'nws');
  assert.strictEqual(nwsOver.gameDay.fbWeather.windMph, 30);
  near(nwsOver.modelTotalRaw - bareOver.modelTotalRaw, -4, 0.02, 'nws total');
  assert.ok(Math.abs((espnOver.modelTotalRaw - bareOver.modelTotalRaw) - (-3)) < 1e-6);
  assert.ok(Math.abs(nwsOver.modelTotalRaw - espnOver.modelTotalRaw) > 0.5, 'nws replaces espn');
  for (const c of nws) {
    const b = bare.find((x) => x.market === c.market && x.side === c.side);
    assert.strictEqual(c.modelMarginRaw, b.modelMarginRaw, `${c.market} margin`);
    if (c.market !== 'Total') {
      assert.strictEqual(c.modelRawP, b.modelRawP, `${c.market} prob`);
      assert.strictEqual(c.modelProjection, b.modelProjection, `${c.market} projection`);
    }
  }

  const roofRow = wxRow('NFL', 'Atlanta Falcons', 'New Orleans Saints', KICK, {
    roof: 'dome', reason: 'roof', source: 'roof', windMph: null, stadium: 'Caesars Superdome',
  });
  const domeProj = projectNfl(
    synth('New Orleans Saints', 'Atlanta Falcons'),
    { weatherByGame: { [roofRow.key]: roofRow.row } },
    {
      homeTeam: 'New Orleans Saints',
      awayTeam: 'Atlanta Falcons',
      commenceTime: KICK,
      indoor: false,
      weather: { tempF: 10, windMph: 25, condition: 'Snow' },
    },
  );
  const domeBare = projectNfl(synth('New Orleans Saints', 'Atlanta Falcons'), calmGd, null);
  const domeOver = findSide(domeProj, 'Total', /^Over/);
  const domeBase = findSide(domeBare, 'Total', /^Over/);
  assert.strictEqual(domeOver.modelTotalRaw, domeBase.modelTotalRaw);
  assert.strictEqual(domeOver.gameDay.weatherTotalAdj, undefined);
  assert.strictEqual(domeOver.gameDay.fbWeather.reason, 'roof');

  process.env.OMEGA_FB_WEATHER = '0';
  const flagged = projectNfl(event, windGd, espnWind);
  const flaggedOver = findSide(flagged, 'Total', /^Over/);
  near(flaggedOver.modelTotalRaw - bareOver.modelTotalRaw, -3, 1e-6, 'flag off keeps espn');
  assert.strictEqual(flaggedOver.gameDay.fbWeather, undefined);
  delete process.env.OMEGA_FB_WEATHER;

  const cfbHeavy = wxRow('NCAAF', 'Auburn Tigers', 'Alabama Crimson Tide', KICK, { windMph: 20, precipProb: 80, tempF: 70 });
  const cfbEvent = synth('Alabama Crimson Tide', 'Auburn Tigers');
  const cfbBare = projectCfb(cfbEvent, calmGd, null);
  const cfbWx = projectCfb(cfbEvent, { weatherByGame: { [cfbHeavy.key]: cfbHeavy.row } }, {
    homeTeam: 'Alabama Crimson Tide',
    awayTeam: 'Auburn Tigers',
    commenceTime: KICK,
  });
  const cfbBaseOver = findSide(cfbBare, 'Total', /^Over/);
  const cfbOver = findSide(cfbWx, 'Total', /^Over/);
  assert.strictEqual(cfbOver.gameDay.weatherTotalAdj, -4);
  near(cfbOver.modelTotalRaw - cfbBaseOver.modelTotalRaw, -4, 0.02, 'ncaaf total');
  for (const c of cfbWx) {
    const b = cfbBare.find((x) => x.market === c.market && x.side === c.side);
    assert.strictEqual(c.modelMarginRaw, b.modelMarginRaw);
    if (c.market !== 'Total') assert.strictEqual(c.modelRawP, b.modelRawP);
  }

  const mapped = ingest.mapEspnEvent({
    id: '401',
    date: KICK,
    competitions: [{
      date: KICK,
      neutralSite: true,
      status: { type: { state: 'pre' } },
      venue: {
        id: '499',
        fullName: 'Cotton Bowl',
        indoor: false,
        address: { city: 'Dallas', state: 'TX' },
      },
      competitors: [
        { homeAway: 'home', team: { id: '201', displayName: 'Oklahoma Sooners', abbreviation: 'OU' } },
        { homeAway: 'away', team: { id: '251', displayName: 'Texas Longhorns', abbreviation: 'TEX' } },
      ],
    }],
  });
  assert.strictEqual(mapped.homeId, '201');
  assert.strictEqual(mapped.awayId, '251');
  assert.strictEqual(mapped.neutralSite, true);
  assert.strictEqual(mapped.venue.id, '499');
  assert.strictEqual(mapped.venue.name, 'Cotton Bowl');
  assert.strictEqual(mapped.venue.city, 'Dallas');
  assert.strictEqual(mapped.indoor, false);

  const restDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbwx-rest-'));
  process.env.OMEGA_REST_SCHEDULE_DIR = restDir;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    assert.ok(!/the-odds-api|api\.weather\.gov/i.test(String(url)), String(url));
    return jsonResp({ events: [], injuries: [], teams: [] });
  };
  const gameDay = await ingest.loadGameDayContext('2026-10-11', ['NFL'], {
    NFL: {
      games: [Object.assign(lambeauGame(), { homeId: '9', awayId: '3' })],
    },
  }, {
    fixtureDir,
    now: NOW,
    fetchImpl: async () => { throw new Error('ingest fixture must not fetch'); },
  });
  global.fetch = async () => { throw new Error('network disabled in fb weather tests'); };
  const fbKeys = Object.keys(gameDay.weatherByGame).filter((key) => key.startsWith('FB|'));
  assert.ok(fbKeys.length > 0, 'gameDay.weatherByGame has NFL rows');
  assert.ok(fbKeys.some((key) => key.includes('|id|9|3|')));
  assert.strictEqual(gameDay.weatherByGame[fbKeys[0]].source, 'fixture');
  assert.ok(gameDay.fbWeatherMeta && gameDay.fbWeatherMeta.fixture === true);
  assert.ok(!urls.some((url) => /api\.weather\.gov|the-odds-api/i.test(url)));
  delete process.env.OMEGA_REST_SCHEDULE_DIR;

  console.log('PASS test-omega-fb-weather', {
    nfl: nflTeams.length,
    fbs: fbsTeams.length,
  });
}

main().then(() => {
  restoreEnv();
}).catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
