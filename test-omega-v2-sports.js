'use strict';

const assert = require('assert');
const { SPORTS, REGIONS, MARKETS } = require('./netlify/functions/lib/odds-master/pull');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { SPORT_PRIOR_K, SPORT_MIN_GAMES, MODEL_SPORTS, MIN_SPORT } = require('./netlify/functions/lib/omega-v2/constants');
const { projectAll } = require('./netlify/functions/lib/omega-vnext');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const ncaam = require('./netlify/functions/lib/omega-vnext/sports/ncaam');

const labels = SPORTS.map((row) => row[0]);
for (const sport of ['NBA', 'NHL', 'NCAAM', 'NFL', 'NCAAF']) {
  assert.ok(labels.includes(sport), `3 AM/10 AM pull list missing ${sport}`);
  assert.strictEqual(config.SPORTS_ENABLED[sport], true, sport);
  assert.ok(MODEL_SPORTS.includes(sport), sport);
  assert.strictEqual(SPORT_MIN_GAMES[sport], MIN_SPORT, sport);
  assert.ok(Number.isFinite(SPORT_PRIOR_K[sport]), sport);
}
assert.strictEqual(config.ODDS_SPORT_KEYS.NCAAM, 'basketball_ncaab');
assert.strictEqual(config.ESPN_LEAGUES.NCAAM.league, 'mens-college-basketball');
const creditsPerSport = MARKETS.split(',').length * REGIONS.split(',').length;
assert.strictEqual(creditsPerSport, 9);
assert.ok(labels.includes('NCAAM'), 'NCAAM already in the pull, so enabling the projector adds 0 credits');

const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
const event = {
  id: 'ncaam1',
  sport: 'NCAAM',
  home_team: 'Home College',
  away_team: 'Away College',
  commence_time: future,
  bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
    key,
    markets: [
      { key: 'h2h', outcomes: [{ name: 'Away College', price: 150 }, { name: 'Home College', price: -170 }] },
    ],
  })),
};
const slate = projectAll({
  oddsBySport: { NCAAM: [event] },
  standingsBySport: {},
  espnBySport: {},
  gameDay: {},
});
assert.ok(slate.some((row) => row.sport === 'NCAAM'), 'projectAll emits NCAAM');
const away = ncaam.project({ oddsEvents: [event], standings: {} }).find((row) => row.side === 'Away College');
assert.ok(away && Math.abs(away.modelRawP - away.fair_sharp_p) < 0.02);

(async () => {
  const card = await buildCard({
    date: '2026-11-04',
    candidates: [0, 1, 2].map((i) => ({
      sport: 'NCAAM',
      matchup: `A${i} @ B${i}`,
      pick: `A${i} ML`,
      market: 'Moneyline',
      odds: '+150',
      book: 'draftkings',
      pModel: 0.98,
      pMkt: 0.30,
      commenceTime: future,
    })),
    history: [],
    stageCounts: { board: { NCAAM: 3 }, raw: { NCAAM: 3 }, afterMiscal: { NCAAM: 3 }, gated: { NCAAM: 3 } },
  });
  const row = (card.sportCoverage.rows || []).find((r) => r.sport === 'NCAAM');
  assert.ok(row, 'coverage row');
  assert.strictEqual(card.sportCoverage.rows.length, 5, 'all five model sports are logged');
  assert.strictEqual(row.action, 'sharp-anchor');
  assert.ok(card.sportCoverage.corrected.includes('NCAAM'));
  assert.ok(Math.abs(row.meanBiasAfter) < 1e-9);
  assert.strictEqual(row.board, 3);
  assert.strictEqual((card.picks || []).length, 0, 'anchored card does not force a NCAAM bet');

  const kept = await buildCard({
    date: '2026-11-04',
    candidates: [{
      sport: 'NFL',
      matchup: 'Away @ Home',
      pick: 'Away ML',
      market: 'Moneyline',
      odds: '-110',
      book: 'draftkings',
      pModel: 0.62,
      pMkt: 0.52,
      commenceTime: future,
    }],
    history: [],
    stageCounts: { board: { NFL: 1 }, raw: { NFL: 1 } },
  });
  const nfl = (kept.sportCoverage.rows || []).find((r) => r.sport === 'NFL');
  assert.strictEqual(nfl.action, 'none', 'a prior-shrink edge is not rewritten');
  assert.ok(!kept.sportCoverage.corrected.includes('NFL'));
  console.log('test-omega-v2-sports: ALL PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
