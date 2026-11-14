'use strict';

// Legacy positive-edge assertions. The default card is top-3 by EV.
process.env.OMEGA_V2_FORCE_TOP3 = 'off';

const assert = require('assert');
const { SPORTS, REGIONS, MARKETS } = require('./netlify/functions/lib/odds-master/pull');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { SPORT_PRIOR_K, SPORT_MIN_GAMES, MODEL_SPORTS, MIN_SPORT } = require('./netlify/functions/lib/omega-v2/constants');
const { projectAll } = require('./netlify/functions/lib/omega-vnext');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const { marketAnchorBoard } = require('./netlify/functions/lib/omega-v2/coverage');
const { americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');
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

  const boardEvent = {
    home_team: 'Home College',
    away_team: 'Away College',
    commence_time: future,
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [
        { name: 'Away College', price: 150 }, { name: 'Home College', price: -170 },
      ] }] },
      { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [
        { name: 'Away College', price: 140 }, { name: 'Home College', price: -160 },
      ] }] },
      { key: 'hardrockbet', markets: [{ key: 'h2h', outcomes: [
        { name: 'Away College', price: 160 }, { name: 'Home College', price: -175 },
      ] }] },
    ],
  };
  const anchored = marketAnchorBoard('NBA', [boardEvent]);
  const away = anchored.find((row) => row.pick === 'Away College ML');
  const home = anchored.find((row) => row.pick === 'Home College ML');
  assert.ok(away && home, 'both sides rescore when Pinnacle and a DK/HR price exist');
  assert.strictEqual(away.odds, 160, 'best DK/HR price on the away side is Hard Rock +160');
  assert.strictEqual(away.book, 'hardrockbet');
  assert.strictEqual(home.odds, -160, 'best DK/HR price on the home side is DraftKings -160');
  assert.strictEqual(home.book, 'draftkings');
  assert.strictEqual(away.pModel, away.pMkt);
  assert.ok(Math.abs(away.priceEdge - (away.pModel - americanToImplied(away.odds))) < 1e-12);
  assert.ok(Math.abs(away.pModel - americanToImplied(150)) > 1e-4, 'p is the Pinnacle no-vig, not the raw price');

  const warnings = [];
  const logs = [];
  const warn0 = console.warn;
  const log0 = console.log;
  console.warn = (...args) => { warnings.push(args.map((part) => String(part)).join(' ')); };
  console.log = (...args) => { logs.push(args.map((part) => String(part)).join(' ')); };
  let gapCard;
  let boomCard;
  let boomThrew = null;
  try {
    gapCard = await buildCard({
      date: '2026-11-04',
      candidates: [],
      history: [],
      stageCounts: { board: { NBA: 1 }, raw: { NBA: 0 } },
      boardBySport: { NBA: [boardEvent] },
    });
    try {
      boomCard = await buildCard({
        date: '2026-11-04',
        candidates: [],
        history: [],
        stageCounts: { board: { NHL: 2 }, raw: { NHL: 1 } },
        boardBySport: new Proxy({}, {
          get() { throw new Error('rescore failed'); },
        }),
      });
    } catch (err) {
      boomThrew = err;
    }
  } finally {
    console.warn = warn0;
    console.log = log0;
  }

  assert.ok(gapCard, 'a zero-score sport still publishes');
  assert.strictEqual(boomThrew, null, 'a throwing auto-correct must not reject the card');
  assert.ok(boomCard && Array.isArray(boomCard.picks), 'throwing auto-correct still returns a card');
  const gapRow = (gapCard.sportCoverage.rows || []).find((r) => r.sport === 'NBA');
  assert.ok(gapRow, 'NBA coverage row');
  assert.strictEqual(gapRow.action, 'auto-corrected');
  assert.strictEqual(gapRow.board, 1);
  assert.strictEqual(gapRow.scored, 0);
  assert.ok(gapRow.candidates >= 2, 'rescued sides count as candidates');
  assert.strictEqual(gapCard.sportCoverage.added, undefined, 'rescued rows are not stored on the card');
  assert.ok(!gapCard.sportCoverage.corrected.includes('NBA'));
  assert.strictEqual((gapCard.picks || []).length, 0, 'market-anchored rows are graded, not forced');
  assert.ok((gapCard.rejections || []).some((r) => r.sport === 'NBA'), 'rescued rows reach grading');
  assert.strictEqual(gapCard.pass, true);
  assert.ok(warnings.some((line) => line.includes('NBA') && /scored=0/.test(line) && /board games=/.test(line)));
  for (const sport of MODEL_SPORTS) {
    assert.ok(logs.some((line) => line.startsWith(`[coverage] ${sport} board games=`) && /scored=\d+/.test(line) && /candidates=\d+/.test(line)), sport);
  }
  for (const line of logs.concat(warnings)) {
    if (!line.includes('[coverage]')) continue;
    assert.ok(!/\bAlpha\b/.test(line) && !/\bOmega\b/.test(line), line);
  }

  const boomRow = (boomCard.sportCoverage.rows || []).find((r) => r.sport === 'NHL');
  assert.ok(boomRow, 'NHL coverage row after a throw');
  assert.strictEqual(boomCard.sportCoverage.rows.length, 5, 'one sport throwing does not drop the report');
  assert.strictEqual(boomRow.action, 'no-score-warn');
  assert.strictEqual(boomRow.scored, 0);
  assert.strictEqual((boomCard.picks || []).length, 0);
  assert.strictEqual(boomCard.pass, true, 'publish is not blocked');
  assert.ok(warnings.some((line) => line.includes('NHL') && line.includes('auto-correct failed') && line.includes('rescore failed')));
  assert.ok(warnings.some((line) => line.includes('NHL') && /scored=0/.test(line)));

  console.log('test-omega-v2-sports: ALL PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
