'use strict';
/**
 * NBA shadow observer. Not the daily card.
 * No network. No blob writes. No Odds API.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nba = require(path.join(root, 'sports/nba'));
const shadow = require(path.join(root, 'nba_shadow'));
const { projectAll } = require(path.join(root, 'index'));
const { noVigTwoWay } = require(path.join(root, 'odds_math'));

const ids = require(path.join(root, 'sports/data/nba-team-ids.json'));
const seed = require(path.join(root, 'sports/data/nba-net-rating-seed.json'));

assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.NBA_CARD_LIVE, false);
assert.strictEqual(config.NBA_SHADOW.enabled, true);
assert.notStrictEqual(process.env.OMEGA_NBA, '1');
assert.strictEqual(config.SPORT_SPREAD_STD.NBA, 12);
assert.strictEqual(config.SPORT_TOTAL_STD.NBA, 14);
assert.strictEqual(nba.NBA_TOTAL_SD, 18);
assert.strictEqual(config.HFA.NBA, 2.5);
assert.strictEqual(config.GATES.minEV.NBA, 0.03);
assert.deepStrictEqual(shadow.OBSERVER, {
  minEV: 0.02,
  maxEV: 0.12,
  minAmericanOdds: -250,
  maxAmericanOdds: 250,
});
assert.deepStrictEqual(nba.BLEND, { ml: 0, spread: 0, total: 0 });
assert.strictEqual(shadow.ODDS_CREDITS_PER_RUN, 9);

async function main() {
{
  const http = require('./netlify/functions/omega-nba-shadow');
  const projectWrap = require('./netlify/functions/trigger-omega-nba-shadow');
  const gradeWrap = require('./netlify/functions/trigger-omega-nba-shadow-grade');
  assert.strictEqual(typeof http.handler, 'function');
  assert.strictEqual(typeof http.handleShadow, 'function');
  assert.strictEqual(typeof projectWrap.handler, 'function');
  assert.strictEqual(typeof gradeWrap.handler, 'function');
  const denied = await http.handler({ httpMethod: 'POST', body: '{}', headers: {} }, {});
  assert.strictEqual(denied.statusCode, 403);
  const deniedBody = JSON.parse(denied.body);
  assert.strictEqual(deniedBody.oddsCalls, 0);
  assert.strictEqual(deniedBody.wrote, false);
  assert.strictEqual(deniedBody.sportsEnabledNba, false);
  const read = await http.handler({ httpMethod: 'GET', headers: {} }, {});
  const readBody = JSON.parse(read.body);
  assert.strictEqual(read.statusCode, 200);
  assert.strictEqual(readBody.readOnly, true);
  assert.strictEqual(readBody.sportsEnabledNba, false);
  assert.strictEqual(readBody.oddsCalls, 0);
}

{
  const teams = Object.values(ids.teams);
  assert.strictEqual(teams.length, 30);
  assert.strictEqual(nba.resolveTeamId('Los Angeles Lakers'), '13');
  assert.strictEqual(nba.resolveTeamId('LA Lakers'), '13');
  assert.strictEqual(nba.resolveTeamId('Los Angeles Clippers'), '12');
  assert.strictEqual(nba.resolveTeamId('L.A. Clippers'), '12');
  assert.notStrictEqual(nba.resolveTeamId('Los Angeles Lakers'), nba.resolveTeamId('Los Angeles Clippers'));
  assert.strictEqual(nba.resolveTeamId('Sixers'), '20');
  assert.strictEqual(nba.resolveTeamId('Portland Trailblazers'), '22');
  for (const banned of ['Celtics', 'Lakers', 'Clippers', 'Trail Blazers', '76ers', 'Los Angeles', 'LA']) {
    assert.strictEqual(nba.resolveTeamId(banned), null, banned);
  }
  assert.strictEqual(seed._meta.season, '2025-26');
  const names = Object.keys(seed).filter((k) => !k.startsWith('_'));
  assert.strictEqual(names.length, 30);
  const centered = nba.centerNbaSeed(seed);
  const sum = names.reduce((s, n) => s + centered[n].netRtg, 0);
  assert.ok(Math.abs(sum) < 1e-6, `netRtg sum ${sum}`);
  assert.strictEqual(nba.loadPrior()._meta.season, '2025-26');
  const league = seed._meta.leaguePpg;
  const fromSum = nba.resolveTeamRates({ pointsFor: 9657, pointsAgainst: 9020, gamesPlayed: 82 }, league);
  assert.strictEqual(fromSum.source, 'season-sum');
  assert.ok(Math.abs(fromSum.offPpg - 9657 / 82) < 1e-9);
  assert.strictEqual(nba.resolveTeamRates({ pointsFor: 9657, pointsAgainst: 9020, gamesPlayed: 1 }, league), null);
  const ratings = nba.resolveTeamRates({ offRtg: 118, defRtg: 110, pace: 100, gamesPlayed: 10 }, league);
  assert.strictEqual(ratings.source, 'ratings');
  assert.strictEqual(nba.seasonWeight(1, false), 0);
  assert.strictEqual(nba.seasonWeight(10, false), 0.5);
  assert.strictEqual(nba.seasonWeight(40, true), 0);
}

const LEAGUE = seed._meta.leaguePpg;
const PACE = seed._meta.leaguePace;

function equalPrior() {
  const row = { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE, netRtg: 0, espnId: null };
  return {
    _meta: { season: '2025-26', leaguePpg: LEAGUE, leaguePace: PACE },
    'Boston Celtics': { ...row, espnId: '2' },
    'New York Knicks': { ...row, espnId: '18' },
  };
}

function book(key, home, away, opts) {
  const spread = opts.spread != null ? opts.spread : -2.5;
  const total = opts.total != null ? opts.total : 231.5;
  const homeMl = opts.homeMl != null ? opts.homeMl : -130;
  const awayMl = opts.awayMl != null ? opts.awayMl : 110;
  const price = opts.price != null ? opts.price : -110;
  const homeSpread = opts.homeSpreadPrice != null ? opts.homeSpreadPrice : price;
  const awaySpread = opts.awaySpreadPrice != null ? opts.awaySpreadPrice : price;
  const over = opts.overPrice != null ? opts.overPrice : price;
  const under = opts.underPrice != null ? opts.underPrice : price;
  return {
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
      { key: 'spreads', outcomes: [
        { name: home, price: homeSpread, point: spread },
        { name: away, price: awaySpread, point: -spread },
      ] },
      { key: 'totals', outcomes: [
        { name: 'Over', price: over, point: total },
        { name: 'Under', price: under, point: total },
      ] },
    ],
  };
}

function event(home, away, opts = {}) {
  const books = opts.books || [
    book('pinnacle', home, away, opts.pin || opts),
    book('draftkings', home, away, opts.dk || opts),
    book('hardrockbet', home, away, opts.hr || opts.dk || opts),
  ];
  return {
    home_team: home,
    away_team: away,
    commence_time: opts.commence || '2026-10-20T23:30:00Z',
    seasonType: opts.seasonType,
    preseason: opts.preseason,
    bookmakers: books,
  };
}

function byMarket(rows, market, sideIncludes) {
  return rows.find((c) => c.market === market && (!sideIncludes || String(c.side).includes(sideIncludes)));
}

{
  const env = nba.projectEnvironment({
    homeProfile: { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE },
    awayProfile: { offPpg: LEAGUE, defPpg: LEAGUE, pace: PACE },
    league: { ppg: LEAGUE, pace: PACE },
    hfa: config.HFA.NBA,
  });
  assert.ok(Math.abs(env.modelMargin - config.HFA.NBA) < 1e-9);
  assert.ok(Math.abs(env.modelTotal - 2 * LEAGUE) < 1e-6);

  const rows = nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: {},
    prior: equalPrior(),
  });
  assert.ok(rows.length >= 6, `rows ${rows.length}`);
  const markets = new Set(rows.map((c) => c.market));
  assert.ok(markets.has('Moneyline') && markets.has('Spread') && markets.has('Total'));
  for (const c of rows) {
    assert.ok(Object.prototype.hasOwnProperty.call(c, 'p_model'));
    assert.ok(Object.prototype.hasOwnProperty.call(c, 'p_fair'));
    assert.ok(Object.prototype.hasOwnProperty.call(c, 'price'));
    assert.ok(Object.prototype.hasOwnProperty.call(c, 'book'));
    assert.strictEqual(c.sport, 'NBA');
    assert.strictEqual(c.shadowOnly, true);
  }
  const ml = byMarket(rows, 'Moneyline', 'Boston Celtics');
  assert.ok(ml.p_pinnacle > 0.5 && ml.p_pinnacle < 0.7, String(ml.p_pinnacle));
  assert.ok(Math.abs(ml.p_fair - ml.p_pinnacle) < 1e-12, 'blend 0 prices Pinnacle');
  assert.ok(Math.abs(ml.p_model - ml.p_fair) > 0.005, `model stays logged ${ml.p_model} vs ${ml.p_fair}`);
  assert.strictEqual(ml.sharpAnchorBook, 'pinnacle');
  assert.strictEqual(ml.book, 'draftkings');

  const nv = noVigTwoWay(-130, 110);
  assert.ok(Math.abs(ml.p_fair - nv.p1) < 1e-12);

  const rested = nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks')],
    standings: {},
    prior: equalPrior(),
    gameDay: { restByTeam: { NBA: { Boston: { playedYesterday: true } } } },
  });
  const restedMl = byMarket(rested, 'Moneyline', 'Boston Celtics');
  assert.ok(restedMl.modelProjection < ml.modelProjection, 'B2B is logged on the margin');
  assert.ok(Math.abs(restedMl.modelProjection - (ml.modelProjection - 1.5)) < 0.05);
  assert.ok(Math.abs(restedMl.p_model - ml.p_model) < 1e-12, 'rest does not move p_model');
  assert.ok(Math.abs(restedMl.p_fair - ml.p_fair) < 1e-12, 'rest does not move p_fair');

  assert.deepStrictEqual(nba.project({
    oddsEvents: [event('Boston Celtics', 'New York Knicks', { preseason: true, seasonType: 1 })],
    prior: equalPrior(),
  }), []);

  const unknown = nba.project({
    oddsEvents: [event('Boston Celtics', 'Lakers')],
    prior: equalPrior(),
  });
  assert.ok(unknown.length > 0);
  assert.ok(unknown.every((c) => c.unknownTeam === true));
}

{
  const pin = { homeMl: -130, awayMl: 110, price: -110, spread: -2.5, total: 231.5 };
  const dk = { homeMl: 105, awayMl: -125, price: -110, spread: -2.5, total: 231.5 };
  const hr = { homeMl: -140, awayMl: 120, homeSpreadPrice: 130, awaySpreadPrice: -150, overPrice: -105, underPrice: -115 };
  const slateEvent = event('Boston Celtics', 'New York Knicks', {
    books: [
      book('pinnacle', 'Boston Celtics', 'New York Knicks', pin),
      book('draftkings', 'Boston Celtics', 'New York Knicks', dk),
      book('hardrockbet', 'Boston Celtics', 'New York Knicks', { ...dk, ...hr, spread: -2.5, total: 231.5 }),
      book('fanduel', 'Boston Celtics', 'New York Knicks', { homeMl: 250, awayMl: -300, price: 250 }),
    ],
  });
  const priced = nba.project({ oddsEvents: [slateEvent], prior: equalPrior(), standings: {} });
  const homeMl = byMarket(priced, 'Moneyline', 'Boston Celtics');
  assert.strictEqual(homeMl.price, 105, 'best DK/HR price, not FanDuel');
  assert.strictEqual(homeMl.book, 'draftkings');
  assert.ok(homeMl.ev > shadow.OBSERVER.minEV && homeMl.ev <= shadow.OBSERVER.maxEV, String(homeMl.ev));

  const spreadHome = byMarket(priced, 'Spread', 'Boston Celtics -2.5');
  assert.strictEqual(spreadHome.price, 130);
  assert.strictEqual(spreadHome.book, 'hardrockbet');

  const moved = event('Boston Celtics', 'New York Knicks', {
    books: [
      book('pinnacle', 'Boston Celtics', 'New York Knicks', { ...pin, spread: -3.5 }),
      book('draftkings', 'Boston Celtics', 'New York Knicks', { ...dk, spread: -2.5 }),
    ],
  });
  const movedRows = nba.project({ oddsEvents: [moved], prior: equalPrior(), standings: {} });
  const movedSpread = byMarket(movedRows, 'Spread', 'Boston Celtics -2.5');
  assert.strictEqual(movedSpread.p_pinnacle, null);
  assert.strictEqual(shadow.observerReason(movedSpread, { dateISO: '2026-10-20' }), 'no-pinnacle-same-line');

  const longshot = { ...homeMl, price: 300, odds: 300, ev: 0.2 };
  assert.strictEqual(shadow.observerReason(longshot, { dateISO: '2026-10-20' }), 'odds-out-of-band');
  const short = { ...homeMl, price: -260, odds: -260, ev: 0.05 };
  assert.strictEqual(shadow.observerReason(short, { dateISO: '2026-10-20' }), 'odds-out-of-band');
  const edge = { ...homeMl, price: -250, odds: -250 };
  edge.ev = 0.019;
  assert.strictEqual(shadow.observerReason(edge, { dateISO: '2026-10-20' }), 'ev-floor');
  edge.ev = 0.121;
  assert.strictEqual(shadow.observerReason(edge, { dateISO: '2026-10-20' }), 'ev-cap');
  edge.ev = 0.02;
  edge.price = -250;
  assert.strictEqual(shadow.observerReason(edge, { dateISO: '2026-10-20' }), null);
  edge.ev = 0.12;
  edge.price = 250;
  assert.strictEqual(shadow.observerReason(edge, { dateISO: '2026-10-20' }), null);
}

{
  const snap = {
    oddsBySport: {
      MLB: [],
      NFL: [],
      NCAAF: [],
      NHL: [],
      NBA: [event('Boston Celtics', 'New York Knicks')],
    },
    standingsBySport: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} },
    espnBySport: {
      NBA: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 2, preseason: false }] },
    },
    efficiencyBySport: { NFL: {}, NCAAF: {} },
    parkFactors: {},
    mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
    gameDay: { restByTeam: { NBA: {} } },
  };
  const prev = process.env.OMEGA_NBA;
  delete process.env.OMEGA_NBA;
  try {
    const slate = projectAll(snap);
    assert.ok(!slate.some((c) => c.sport === 'NBA'));
    config.SPORTS_ENABLED.NBA = true;
    const flagged = projectAll(snap);
    assert.ok(!flagged.some((c) => c.sport === 'NBA'), 'card wiring does not pass the NBA board');
  } finally {
    config.SPORTS_ENABLED.NBA = false;
    if (prev == null) delete process.env.OMEGA_NBA;
    else process.env.OMEGA_NBA = prev;
  }
  assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
  assert.strictEqual(config.NBA_CARD_LIVE, false);
}

{
  const pin = { homeMl: -130, awayMl: 110, price: -110 };
  const dk = { homeMl: 105, awayMl: 140, price: -110, homeSpreadPrice: -110, awaySpreadPrice: -110 };
  const board = {
    dateISO: '2026-10-20',
    dryRun: true,
    asOf: '2026-10-20T16:00:00Z',
    prior: equalPrior(),
    standings: {},
    espnGames: { games: [{ homeTeam: 'Boston Celtics', awayTeam: 'New York Knicks', seasonType: 2, preseason: false }] },
    oddsEvents: [event('Boston Celtics', 'New York Knicks', {
      books: [
        book('pinnacle', 'Boston Celtics', 'New York Knicks', pin),
        book('draftkings', 'Boston Celtics', 'New York Knicks', dk),
      ],
    })],
  };
  const prevFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('shadow fixture must not fetch'); };
  try {
    const dry = await shadow.runNbaShadow(board);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(dry.oddsCalls, 0);
    assert.strictEqual(dry.creditsEstimate, 0);
    assert.strictEqual(dry.wrote, false);
    assert.strictEqual(dry.key, 'omega-nba-shadow-2026-10-20');
    assert.strictEqual(dry.payload.shadowOnly, true);
    assert.strictEqual(dry.payload.sportsEnabledNba, false);
    assert.strictEqual(dry.payload.gates.minEV, 0.02);
    assert.strictEqual(dry.payload.gates.maxEV, 0.12);
    assert.ok(dry.candidateCount >= 6);
    assert.ok(dry.payload.candidates.length === dry.candidateCount);
    for (const row of dry.payload.candidates) {
      assert.ok('p_model' in row && 'p_fair' in row && 'price' in row && 'book' in row);
      assert.strictEqual(row.shadowOnly, true);
    }
    assert.ok(dry.yesCount >= 1, `yes ${dry.yesCount}`);
    assert.ok(dry.payload.picks.every((p) => p.ev >= 0.02 && p.ev <= 0.12));
    assert.ok(dry.payload.picks.every((p) => p.price >= -250 && p.price <= 250));
    assert.ok(dry.payload.picks.every((p) => p.book === 'draftkings' || p.book === 'hardrockbet'));
    const mlPicks = dry.payload.picks.filter((p) => p.market === 'Moneyline');
    assert.ok(mlPicks.length <= 1, 'one side per market');
    const home = dry.payload.picks.find((p) => p.market === 'Moneyline' && p.side === 'Boston Celtics');
    assert.ok(home, 'home ML clears the single floor');
    assert.strictEqual(home.price, 105);
    assert.ok(dry.payload.rejected.some((r) => r.rejectReason === 'one-side-per-market' || r.rejectReason === 'ev-floor' || r.rejectReason === 'ev-cap'));

    const off = await shadow.logNbaFromGenerate({
      dateISO: '2026-10-20',
      oddsEvents: board.oddsEvents,
      prior: equalPrior(),
      dryRun: true,
      store: async () => { throw new Error('flag-off must not write'); },
    });
    assert.strictEqual(off.ran, false);
    assert.strictEqual(off.reason, 'flag-off');
    assert.strictEqual(off.attachedToCard, false);
    assert.strictEqual(fetches, 0);

    const card = { picks: [{ sport: 'NHL' }], parlayLegs: [{ legs: [{}, {}, {}] }] };
    const before = JSON.stringify(card);
    const writes = [];
    process.env.OMEGA_NBA_GENERATE_SHADOW = '1';
    const on = await shadow.logNbaFromGenerate({
      dateISO: '2026-10-20',
      snap: { oddsBySport: { NBA: board.oddsEvents }, espnBySport: { NBA: board.espnGames } },
      prior: equalPrior(),
      dryRun: false,
      asOf: '2026-10-20T16:00:00Z',
      store: async (key, data) => { writes.push({ key, data }); },
    });
    assert.strictEqual(JSON.stringify(card), before);
    assert.strictEqual(on.attachedToCard, false);
    assert.strictEqual(on.oddsCalls, 0);
    assert.strictEqual(on.wrote, true);
    assert.strictEqual(writes[0].key, 'omega-nba-shadow-2026-10-20');
    assert.strictEqual(writes[0].data.sportsEnabledNba, false);
    delete process.env.OMEGA_NBA_GENERATE_SHADOW;

    const finals = [{
      homeTeam: 'Boston Celtics',
      awayTeam: 'New York Knicks',
      homeScore: 118,
      awayScore: 110,
      status: 'final',
    }];
    const closes = [{
      home_team: 'Boston Celtics',
      away_team: 'New York Knicks',
      bookmakers: [{
        key: 'pinnacle',
        markets: [
          { key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -150 }, { name: 'New York Knicks', price: 130 }] },
          { key: 'spreads', outcomes: [
            { name: 'Boston Celtics', price: -110, point: -4.5 },
            { name: 'New York Knicks', price: -110, point: 4.5 },
          ] },
        ],
      }],
    }];
    const graded = await shadow.gradeNbaShadow({
      dateISO: '2026-10-20',
      dryRun: true,
      slate: dry.payload,
      finals,
      closes,
    });
    assert.strictEqual(graded.oddsCalls, 0);
    assert.ok(graded.graded >= 1);
    const homeGrade = graded.payload.rows.find((r) => r.market === 'Moneyline' && r.side === 'Boston Celtics');
    assert.ok(homeGrade, 'graded the logged home ML');
    assert.strictEqual(homeGrade.result, 'win');
    assert.strictEqual(homeGrade.p_model, home.p_model);
    assert.strictEqual(homeGrade.p_fair, home.p_fair);
    assert.strictEqual(homeGrade.price, 105);
    assert.strictEqual(homeGrade.book, 'draftkings');
    assert.ok(homeGrade.clv > 0, `beat the close ${homeGrade.clv}`);
    assert.strictEqual(homeGrade.beatClose, true);
    const spreadGrade = graded.payload.rows.find((r) => r.market === 'Spread');
    if (spreadGrade) {
      assert.strictEqual(spreadGrade.clv, null);
      assert.strictEqual(spreadGrade.clvReason, 'line-moved');
    }
    const sameLineSpread = shadow.gradeClv({
      market: 'Spread',
      side: 'Boston Celtics -2.5',
      pickSide: 'home',
      line: -2.5,
      odds: -110,
      price: -110,
      homeTeam: 'Boston Celtics',
      awayTeam: 'New York Knicks',
    }, [{
      home_team: 'Boston Celtics',
      away_team: 'New York Knicks',
      bookmakers: [{
        key: 'pinnacle',
        markets: [{
          key: 'spreads',
          outcomes: [
            { name: 'Boston Celtics', price: -120, point: -2.5 },
            { name: 'New York Knicks', price: 100, point: 2.5 },
          ],
        }],
      }],
    }]);
    assert.ok(sameLineSpread.clv > 0, `same-line spread CLV ${sameLineSpread.clv}`);
    assert.strictEqual(sameLineSpread.closeLine, -2.5);
    assert.strictEqual(sameLineSpread.beatClose, true);
    assert.ok(graded.summary.clv.n >= 1);

    process.env.OMEGA_NBA_SHADOW = '0';
    const killed = await shadow.runNbaShadow({ dateISO: '2026-10-20', dryRun: true });
    assert.strictEqual(killed.skipped, true);
    assert.strictEqual(killed.reason, 'OMEGA_NBA_SHADOW=0');
    assert.strictEqual(killed.oddsCalls, 0);
    delete process.env.OMEGA_NBA_SHADOW;
  } finally {
    global.fetch = prevFetch;
    delete process.env.OMEGA_NBA_GENERATE_SHADOW;
    delete process.env.OMEGA_NBA_SHADOW;
  }
}

console.log('PASS test-omega-nba-engine', {
  model: config.MODEL_VERSION,
  nbaEnabled: config.SPORTS_ENABLED.NBA,
  cardLive: config.NBA_CARD_LIVE,
  observer: shadow.OBSERVER,
});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
