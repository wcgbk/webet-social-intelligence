'use strict';

/**
 * OMEGA_V2_RANKED_POOL stores the next 12 forced-order games on the v2
 * card. The field is additive. Flag off omits it and the rest of the
 * card matches. No network.
 */

const assert = require('assert');
const { buildCard } = require('./netlify/functions/lib/omega-v2/pipeline');
const {
  annotateCandidate, selectForcedTop3, orderForcedPool, gameKey,
} = require('./netlify/functions/lib/omega-v2/select');
const {
  rankedPoolEnabled, buildStoredRankedPool, RANKED_POOL_N,
} = require('./netlify/functions/lib/omega-v2/ranked_pool');

const AS_OF = Date.parse('2026-11-14T15:05:00Z');
const COMMENCE = '2026-11-15T18:00:00Z';
const ENV = {
  OMEGA_V2_FORCE_TOP3: 'on',
  OMEGA_V2_MARKET_P: 'off',
  OMEGA_V2_LONGSHOT_ADJ: 'off',
  OMEGA_V2_FAV_CAP: 'on',
  OMEGA_V2_EV_FIRST: 'off',
  OMEGA_V2_EV_FIRST_CAPPED: 'on',
};
const OPTS = { forceTop3: true, pregameAsOfMs: AS_OF, env: ENV };

function assertFlag(env, expected) {
  assert.strictEqual(rankedPoolEnabled(env), expected, JSON.stringify(env));
}

assertFlag({}, true);
assertFlag({ OMEGA_V2_RANKED_POOL: 'on' }, true);
assertFlag({ OMEGA_V2_RANKED_POOL: '1' }, true);
assertFlag({ OMEGA_V2_RANKED_POOL: 'true' }, true);
assertFlag({ OMEGA_V2_RANKED_POOL: 'yes' }, true);
assertFlag({ OMEGA_V2_RANKED_POOL: 'off' }, false);
assertFlag({ OMEGA_V2_RANKED_POOL: '0' }, false);
assertFlag({ OMEGA_V2_RANKED_POOL: 'false' }, false);
assertFlag({ OMEGA_V2_RANKED_POOL: '' }, false);
assertFlag({ OMEGA_V2_RANKED_POOL: 'maybe' }, false);

function row(spec) {
  return annotateCandidate({
    sport: spec.sport || 'NFL',
    matchup: spec.matchup,
    pick: spec.pick,
    side: spec.pick,
    market: spec.market || 'Spread',
    line: spec.line != null ? spec.line : -3.5,
    odds: spec.odds,
    book: 'draftkings',
    gameKey: gameKey(spec.matchup),
    commenceTime: spec.commenceTime || COMMENCE,
    homeTeam: spec.home,
    awayTeam: spec.away,
    sharpBook: spec.sharpBook || 'pinnacle',
    noSharpFair: spec.noSharpFair === true,
    calibration: {
      pCal: spec.pCal,
      pMkt: spec.pMkt,
      pModel: spec.pCal,
      method: 'board',
    },
  }, OPTS);
}

const games = [];
for (let i = 0; i < 13; i += 1) {
  const name = `Club ${String(i).padStart(2, '0')}`;
  games.push(row({
    matchup: `Away ${name} @ Home ${name}`,
    pick: `${name} Side`,
    home: `Home ${name}`,
    away: `Away ${name}`,
    odds: -110,
    pCal: 0.60 - i * 0.002,
    pMkt: 0.524,
  }));
}
const heavy = row({
  matchup: 'Away Heavy @ Home Heavy',
  pick: 'Heavy Side',
  home: 'Home Heavy',
  away: 'Away Heavy',
  odds: -450,
  pCal: 0.86,
  pMkt: 0.82,
});
const otherSide = row({
  matchup: games[0].matchup,
  pick: 'Club 00 Other',
  home: games[0].homeTeam,
  away: games[0].awayTeam,
  odds: -110,
  pCal: 0.55,
  pMkt: 0.524,
});
const fallback = row({
  matchup: 'Away Fair @ Home Fair',
  pick: 'Fair Side',
  home: 'Home Fair',
  away: 'Away Fair',
  odds: -110,
  pCal: 0.57,
  pMkt: 0.524,
  noSharpFair: true,
  sharpBook: null,
});

const annotated = games.concat([heavy, otherSide, fallback]);
assert.ok(annotated.every((c) => c.qualified), annotated.filter((c) => !c.qualified).map((c) => c.rejectReason).join(','));

const published = selectForcedTop3(annotated, OPTS);
assert.strictEqual(published.length, 3);
const pool = buildStoredRankedPool(annotated, published, OPTS);
assert.ok(Array.isArray(pool));
assert.strictEqual(pool.length, RANKED_POOL_N);

const publishedGames = new Set(published.map((c) => c.gameKey));
const seen = new Set();
const allowed = new Set([
  'sport', 'matchup', 'gameKey', 'pick', 'side', 'market', 'line', 'odds', 'book',
  'commenceTime', 'homeTeam', 'awayTeam', 'pBet', 'pMkt', 'ev', 'edge', 'sharpBook', 'inBand',
  'noSharpFair', 'staleSoft',
]);
for (const item of pool) {
  assert.ok(!publishedGames.has(item.gameKey), item.pick);
  assert.ok(!seen.has(item.gameKey), `duplicate game ${item.gameKey}`);
  seen.add(item.gameKey);
  for (const key of Object.keys(item)) assert.ok(allowed.has(key), key);
  assert.strictEqual(typeof item.pBet, 'number');
  assert.strictEqual(typeof item.ev, 'number');
  assert.strictEqual(typeof item.edge, 'number');
  assert.strictEqual(typeof item.inBand, 'boolean');
  assert.ok(item.pick && item.side && item.matchup && item.sport);
}
assert.ok(pool.every((item) => item.pick !== 'Club 00 Other'));
assert.ok(pool.some((item) => item.inBand === true));
const heavyStored = pool.find((item) => item.pick === 'Heavy Side');
if (heavyStored) {
  assert.strictEqual(heavyStored.inBand, false);
  assert.strictEqual(heavyStored.odds, -450);
  assert.ok(pool.findIndex((item) => item.inBand) < pool.indexOf(heavyStored));
}
const fairStored = pool.find((item) => item.pick === 'Fair Side');
if (fairStored) assert.strictEqual(fairStored.noSharpFair, true);

const orderedNames = orderForcedPool(annotated, OPTS).map((c) => c.pick);
const poolNames = pool.map((item) => item.pick);
const expected = [];
const used = new Set(published.map((c) => c.gameKey));
for (const cand of orderForcedPool(annotated, OPTS)) {
  if (used.has(cand.gameKey)) continue;
  used.add(cand.gameKey);
  expected.push(cand.pick);
  if (expected.length >= RANKED_POOL_N) break;
}
assert.deepStrictEqual(poolNames, expected, `pool ${poolNames} vs order ${orderedNames}`);

const saved = {
  force: process.env.OMEGA_V2_FORCE_TOP3,
  pool: process.env.OMEGA_V2_RANKED_POOL,
  market: process.env.OMEGA_V2_MARKET_P,
  adj: process.env.OMEGA_V2_LONGSHOT_ADJ,
  fav: process.env.OMEGA_V2_FAV_CAP,
  ev: process.env.OMEGA_V2_EV_FIRST,
  capped: process.env.OMEGA_V2_EV_FIRST_CAPPED,
};

function restore() {
  const put = (key, value) => {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  };
  put('OMEGA_V2_FORCE_TOP3', saved.force);
  put('OMEGA_V2_RANKED_POOL', saved.pool);
  put('OMEGA_V2_MARKET_P', saved.market);
  put('OMEGA_V2_LONGSHOT_ADJ', saved.adj);
  put('OMEGA_V2_FAV_CAP', saved.fav);
  put('OMEGA_V2_EV_FIRST', saved.ev);
  put('OMEGA_V2_EV_FIRST_CAPPED', saved.capped);
}

function cand(i, over) {
  const name = `Side ${i}`;
  return {
    sport: 'NBA',
    matchup: `Away ${i} @ Home ${i}`,
    pick: name,
    side: name,
    market: 'Moneyline',
    odds: (over && over.odds) || -110,
    book: 'draftkings',
    line: null,
    homeTeam: `Home ${i}`,
    awayTeam: `Away ${i}`,
    sharpBook: 'pinnacle',
    pModel: 0.58,
    pMkt: 0.52,
    commenceTime: COMMENCE,
  };
}

function withoutPool(card) {
  const copy = JSON.parse(JSON.stringify(card));
  delete copy.rankedPool;
  return copy;
}

(async () => {
  process.env.OMEGA_V2_FORCE_TOP3 = '1';
  process.env.OMEGA_V2_MARKET_P = 'off';
  process.env.OMEGA_V2_LONGSHOT_ADJ = 'off';
  process.env.OMEGA_V2_FAV_CAP = 'on';
  process.env.OMEGA_V2_EV_FIRST = 'off';
  process.env.OMEGA_V2_EV_FIRST_CAPPED = 'on';
  const input = {
    date: '2026-11-14',
    dateFormatted: 'Saturday, November 14, 2026',
    candidates: [0, 1, 2, 3, 4].map((i) => cand(i)),
    history: [],
    pregameAsOfMs: AS_OF,
  };
  process.env.OMEGA_V2_RANKED_POOL = 'off';
  const off = await buildCard(input);
  delete process.env.OMEGA_V2_RANKED_POOL;
  const on = await buildCard(input);
  process.env.OMEGA_V2_RANKED_POOL = '';
  const blank = await buildCard(input);
  assert.strictEqual(off.rankedPool, undefined);
  assert.strictEqual(blank.rankedPool, undefined);
  assert.ok(Array.isArray(on.rankedPool));
  assert.ok(on.rankedPool.length >= 1);
  assert.ok(on.rankedPool.length <= RANKED_POOL_N);
  assert.strictEqual(on.picks.length, 3);
  assert.deepStrictEqual(withoutPool(on), withoutPool(off));
  assert.deepStrictEqual(withoutPool(blank), withoutPool(off));
  const publishedKeys = new Set(on.picks.map((p) => gameKey(p.matchup)));
  assert.ok(on.rankedPool.every((item) => !publishedKeys.has(item.gameKey)));
  restore();
  console.log('PASS test-omega-v2-ranked-pool');
})().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
