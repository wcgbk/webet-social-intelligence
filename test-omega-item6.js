'use strict';
/**
 * Omega item 6. Weather (6a), same-direction total parlay haircut (6b),
 * NFL 3/7 key-number mass (6c). No network on the formula cases.
 * One mocked ESPN scoreboard proves the free fetch carries indoor + weather.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const gd = require(path.join(root, 'sports/game_day'));
const nfl = require(path.join(root, 'sports/nfl'));
const mlb = require(path.join(root, 'sports/mlb'));
const ingest = require(path.join(root, 'ingest'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.13-omega-vnext-nhl-engine');
assert.deepStrictEqual(config.WEATHER_NFL, {
  windOnMph: 15,
  windBaseMph: 12,
  windPtsPerMph: 0.25,
  windCap: 3.0,
  coldAtOrBelowF: 25,
  coldAdj: 1.0,
  totalCap: 3.5,
});

function near(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
}

// MLB weather formula is the pre-item-6 path.
{
  const cold = gd.applyWeatherTotalAdj(8.6, { tempF: 40, condition: 'Clear', windMph: 5 });
  near(cold.modelTotal, 8.25);
  assert.strictEqual(cold.applied, true);
  const none = gd.applyWeatherTotalAdj(8.6, null);
  assert.strictEqual(none.modelTotal, 8.6);
  assert.strictEqual(none.applied, false);
  const out = gd.applyWeatherTotalAdj(8.6, { tempF: 42, condition: 'Clear', windMph: 14, windDir: 'out to RF' });
  near(out.modelTotal, 8.45);
  const cross = gd.applyWeatherTotalAdj(8.6, { tempF: 70, condition: 'Clear', windMph: 20, windDir: 'cross' });
  near(cross.modelTotal, 8.55);
  assert.ok(Math.abs(cross.modelTotal - (8.6 - 2)) > 1);
}

// NFL caps. Dome and missing weather are 0. Margin is not an input.
{
  const dome = gd.applyNflWeatherTotalAdj(45, { temperature: 10, windSpeed: 25, displayValue: 'Snow' }, { indoor: true });
  assert.strictEqual(dome.totalAdj, 0);
  assert.strictEqual(dome.modelTotal, 45);
  assert.strictEqual(dome.applied, false);

  const domeOnWeather = gd.applyNflWeatherTotalAdj(45, { tempF: 10, windMph: 25, indoor: true });
  assert.strictEqual(domeOnWeather.totalAdj, 0);

  const missing = gd.applyNflWeatherTotalAdj(45, null, { indoor: false });
  assert.strictEqual(missing.totalAdj, 0);
  assert.strictEqual(missing.applied, false);

  const wind20 = gd.applyNflWeatherTotalAdj(50, { windMph: 20, tempF: 60 });
  near(wind20.totalAdj, -2);
  near(wind20.modelTotal, 48);
  assert.strictEqual(wind20.applied, true);

  const fromEspnFields = gd.applyNflWeatherTotalAdj(50, {
    temperature: 60,
    windSpeed: '20 mph',
    displayValue: 'Breezy',
  });
  near(fromEspnFields.totalAdj, -2);

  const fromDisplay = gd.applyNflWeatherTotalAdj(50, { temperature: 60, displayValue: 'Wind 20 mph' });
  near(fromDisplay.totalAdj, -2);

  const directionIgnored = gd.applyNflWeatherTotalAdj(50, { windMph: 20, tempF: 60, windDir: 'out' });
  near(directionIgnored.totalAdj, -2);

  const capped = gd.applyNflWeatherTotalAdj(50, { windMph: 25, tempF: 10 });
  near(capped.totalAdj, -3.5);
  near(capped.modelTotal, 46.5);

  const breeze = gd.applyNflWeatherTotalAdj(50, { windMph: 14, tempF: 40 });
  assert.strictEqual(breeze.totalAdj, 0);

  const coldOnly = gd.applyNflWeatherTotalAdj(50, { tempF: 25, windMph: 0 });
  near(coldOnly.totalAdj, -1);
  const notCold = gd.applyNflWeatherTotalAdj(50, { tempF: 26, windMph: 0 });
  assert.strictEqual(notCold.totalAdj, 0);
}

function synth(home, away, opts = {}) {
  const total = opts.total != null ? opts.total : 45.5;
  const spread = opts.spread != null ? opts.spread : -3.5;
  return {
    home_team: home,
    away_team: away,
    commence_time: '2026-10-11T17:00:00Z',
    bookmakers: ['pinnacle', 'draftkings'].map(key => ({
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

const NFL_STANDINGS = {
  'Kansas City Chiefs': { wins: 2, losses: 0, pf: 50, pa: 30, games: 2 },
  'Buffalo Bills': { wins: 1, losses: 1, pf: 40, pa: 35, games: 2 },
};

function projectNfl(espnGame) {
  return nfl.project({
    oddsEvents: [synth('Kansas City Chiefs', 'Buffalo Bills')],
    standings: NFL_STANDINGS,
    efficiency: {},
    gameDay: { restByTeam: { NFL: {} }, qbStatusBySport: { NFL: {} } },
    espnGames: espnGame ? { games: [espnGame] } : { games: [] },
  });
}

function findSide(cands, market, re) {
  const row = cands.find(c => c.market === market && re.test(c.side));
  assert.ok(row, `missing ${market} ${re}`);
  return row;
}

{
  const base = projectNfl(null);
  const windy = projectNfl({
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    indoor: false,
    weather: { tempF: 60, windMph: 20, condition: 'Breezy' },
  });
  const dome = projectNfl({
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    indoor: true,
    weather: { tempF: 10, windMph: 25, condition: 'Snow' },
  });
  const coldWind = projectNfl({
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    indoor: false,
    weather: { tempF: 10, windMph: 25, condition: 'Snow' },
  });
  const unmatched = projectNfl({
    homeTeam: 'Green Bay Packers',
    awayTeam: 'Chicago Bears',
    indoor: false,
    weather: { tempF: 10, windMph: 25 },
  });

  const baseOver = findSide(base, 'Total', /^Over/);
  const windOver = findSide(windy, 'Total', /^Over/);
  const domeOver = findSide(dome, 'Total', /^Over/);
  const capOver = findSide(coldWind, 'Total', /^Over/);
  const missOver = findSide(unmatched, 'Total', /^Over/);
  near(windOver.modelTotalRaw - baseOver.modelTotalRaw, -2, 1e-6);
  assert.strictEqual(domeOver.modelTotalRaw, baseOver.modelTotalRaw);
  near(capOver.modelTotalRaw - baseOver.modelTotalRaw, -3.5, 1e-6);
  assert.strictEqual(missOver.modelTotalRaw, baseOver.modelTotalRaw);

  for (const [label, rows] of [['wind', windy], ['dome', dome], ['cap', coldWind]]) {
    for (const c of rows) {
      const b = base.find(x => x.market === c.market && x.side === c.side);
      assert.strictEqual(c.modelMarginRaw, b.modelMarginRaw, `${label} margin moved`);
      if (c.market !== 'Total') {
        assert.strictEqual(c.modelRawP, b.modelRawP, `${label} ${c.market} prob moved`);
        assert.strictEqual(c.modelProjection, b.modelProjection, `${label} projection moved`);
      }
    }
  }
  assert.ok(windOver.modelRawP < baseOver.modelRawP, 'wind lowers the over probability');
  assert.strictEqual(windOver.gameDay.weatherTotalAdj, -2);
}

// MLB projector still uses the MLB weather function, including a 20 mph wind.
{
  const event = synth('New York Yankees', 'Boston Red Sox', { total: 8.5, spread: -1.5 });
  const standings = {
    'New York Yankees': { wins: 90, losses: 60 },
    'Boston Red Sox': { wins: 80, losses: 70 },
  };
  const common = {
    oddsEvents: [event],
    standings,
    mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
    parkFactors: {},
    gameDay: { restByTeam: { MLB: {} }, weatherByGame: {} },
  };
  const calm = mlb.project({ ...common, espnGames: { games: [] } });
  const wx = { tempF: 70, condition: 'Clear', windMph: 20, windDir: 'cross' };
  const breezy = mlb.project({
    ...common,
    espnGames: { games: [{ homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', weather: wx }] },
  });
  const calmOver = findSide(calm, 'Total', /^Over/);
  const windOver = findSide(breezy, 'Total', /^Over/);
  const delta = windOver.modelProjection - calmOver.modelProjection;
  assert.ok(Math.abs(delta - (-0.05)) < 0.02, `MLB 20mph delta ${delta}`);
  assert.ok(Math.abs(delta - (-2)) > 0.5, 'MLB wind must not use the NFL scale');
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function comp(home, away, extra) {
  return {
    id: `${away}-${home}`,
    date: '2026-10-11T17:00:00Z',
    competitions: [{
      date: '2026-10-11T17:00:00Z',
      status: { type: { state: 'pre' } },
      competitors: [
        { homeAway: 'home', team: { displayName: home, abbreviation: 'H' } },
        { homeAway: 'away', team: { displayName: away, abbreviation: 'A' } },
      ],
      ...extra,
    }],
  };
}

async function main() {
  const prev = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    assert.ok(String(url).includes('/football/nfl/scoreboard'), String(url));
    assert.ok(!/odds-api|weather\.com|wttr/i.test(String(url)), String(url));
    return jsonResponse({
      events: [
        comp('New Orleans Saints', 'Minnesota Vikings', {
          venue: { fullName: 'Caesars Superdome', indoor: true },
          weather: { temperature: 72, windSpeed: 5, displayValue: 'Dome' },
        }),
        comp('Green Bay Packers', 'Chicago Bears', {
          venue: { fullName: 'Lambeau Field', indoor: false },
          weather: { temperature: 20, windSpeed: '20 mph', displayValue: 'Windy' },
        }),
        comp('Kansas City Chiefs', 'Buffalo Bills', {
          venue: { fullName: 'Arrowhead Stadium', indoor: false },
        }),
      ],
    });
  };
  try {
    const board = await ingest.fetchEspnScoreboard('NFL', '2026-10-11');
    assert.strictEqual(calls, 1, 'NFL weather reuses the one scoreboard fetch');
    assert.strictEqual(board.games.length, 3);
    const dome = board.games.find(g => g.homeTeam === 'New Orleans Saints');
    const lambeau = board.games.find(g => g.homeTeam === 'Green Bay Packers');
    const arrowhead = board.games.find(g => g.homeTeam === 'Kansas City Chiefs');
    assert.strictEqual(dome.indoor, true);
    assert.strictEqual(dome.weather.tempF, 72);
    assert.strictEqual(dome.weather.windMph, 5);
    assert.strictEqual(lambeau.indoor, false);
    assert.strictEqual(lambeau.weather.tempF, 20);
    assert.strictEqual(lambeau.weather.windMph, 20);
    assert.strictEqual(lambeau.weather.condition, 'Windy');
    assert.strictEqual(arrowhead.indoor, false);
    assert.strictEqual(arrowhead.weather, null);

    const domeProj = nfl.project({
      oddsEvents: [synth('New Orleans Saints', 'Minnesota Vikings')],
      standings: {
        'New Orleans Saints': { wins: 2, losses: 1, pf: 70, pa: 60, games: 3 },
        'Minnesota Vikings': { wins: 2, losses: 1, pf: 68, pa: 55, games: 3 },
      },
      efficiency: {},
      gameDay: {},
      espnGames: board,
    });
    const outdoor = nfl.project({
      oddsEvents: [synth('Green Bay Packers', 'Chicago Bears')],
      standings: {
        'Green Bay Packers': { wins: 2, losses: 1, pf: 70, pa: 60, games: 3 },
        'Chicago Bears': { wins: 2, losses: 1, pf: 68, pa: 55, games: 3 },
      },
      efficiency: {},
      gameDay: {},
      espnGames: board,
    });
    const bare = nfl.project({
      oddsEvents: [synth('Green Bay Packers', 'Chicago Bears')],
      standings: {
        'Green Bay Packers': { wins: 2, losses: 1, pf: 70, pa: 60, games: 3 },
        'Chicago Bears': { wins: 2, losses: 1, pf: 68, pa: 55, games: 3 },
      },
      efficiency: {},
      gameDay: {},
      espnGames: { games: [] },
    });
    const domeBare = nfl.project({
      oddsEvents: [synth('New Orleans Saints', 'Minnesota Vikings')],
      standings: {
        'New Orleans Saints': { wins: 2, losses: 1, pf: 70, pa: 60, games: 3 },
        'Minnesota Vikings': { wins: 2, losses: 1, pf: 68, pa: 55, games: 3 },
      },
      efficiency: {},
      gameDay: {},
      espnGames: { games: [] },
    });
    const domeOver = findSide(domeProj, 'Total', /^Over/);
    const domeBase = findSide(domeBare, 'Total', /^Over/);
    const outOver = findSide(outdoor, 'Total', /^Over/);
    const bareOver = findSide(bare, 'Total', /^Over/);
    assert.strictEqual(domeOver.modelTotalRaw, domeBase.modelTotalRaw);
    assert.strictEqual(domeOver.modelMarginRaw, domeBase.modelMarginRaw);
    assert.strictEqual(domeOver.gameDay.weatherTotalAdj, undefined);
    // 20°F is cold (−1) and 20 mph is −2. Together −3, inside the −3.5 cap.
    near(outOver.modelTotalRaw - bareOver.modelTotalRaw, -3, 1e-6);
    assert.strictEqual(outOver.modelMarginRaw, bareOver.modelMarginRaw);
  } finally {
    global.fetch = prev;
  }

  console.log('PASS test-omega-item6', {
    model: config.MODEL_VERSION,
    weatherNfl: config.WEATHER_NFL,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
