'use strict';

/**
 * 10:15 v2 news re-rank.
 * No hard news leaves the 10:00 card and writes nothing.
 * A postponed leg is replaced from the stored v2 pool, still 3 straights
 * plus the same-3 parlay. The -300 row stays off while an in-band +EV
 * refill exists. OMEGA_V2_NEWS_RERANK=off returns the 10:00 card.
 */

const assert = require('assert');
const {
  annotateCandidate, orderForcedPool, gameKey,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, toParlay } = require('./netlify/functions/lib/omega-v2/guards');
const {
  rerankCard, isV2Card, newsRerankEnabled, pastRerankCutoff,
} = require('./netlify/functions/lib/omega-vnext/rerank');
const { runRerank } = require('./netlify/functions/rerank-picks-omega');
const {
  passesPublishFloor, passesLeanFill, compareByEv, straightCardLabel,
  eligibleForLeanPool, eligiblePairedFill,
} = require('./netlify/functions/lib/omega-vnext/select_floor');
const { statusAction, decideLateNews } = require('./netlify/functions/lib/omega-vnext/late_news');

require('./netlify/functions/lib/omega-vnext/card_topup');
require('./netlify/functions/lib/omega-vnext/selection_pass');

const NOW = new Date('2026-11-15T15:15:00Z');
const COMMENCE = '2026-11-15T23:00:00Z';
const ENV = {
  OMEGA_V2_MARKET_P: 'off',
  OMEGA_V2_LONGSHOT_ADJ: 'off',
  OMEGA_V2_FAV_CAP: 'on',
  OMEGA_V2_FORCE_TOP3: 'on',
};
const ANNOTATE = { forceTop3: true, pregameAsOfMs: NOW.getTime(), env: ENV };

function row(spec) {
  const matchup = spec.matchup;
  const annotated = annotateCandidate({
    sport: spec.sport || 'NCAAF',
    matchup,
    pick: spec.pick,
    market: 'Spread',
    line: spec.line != null ? spec.line : 3.5,
    odds: spec.odds,
    book: 'draftkings',
    gameKey: gameKey(matchup),
    commenceTime: COMMENCE,
    homeTeam: spec.home,
    awayTeam: spec.away,
    calibration: {
      pCal: spec.pCal,
      pMkt: spec.pMkt,
      pModel: spec.pCal,
      method: 'board',
    },
  }, ANNOTATE);
  assert.strictEqual(
    annotated.qualified,
    true,
    `${spec.pick} rejected: ${annotated.rejectReason}`,
  );
  return annotated;
}

const A = row({
  matchup: 'Alpha Away @ Alpha Home', pick: 'Alpha Side', away: 'Alpha Away', home: 'Alpha Home',
  odds: -110, pCal: 0.58, pMkt: 0.524,
});
const B = row({
  matchup: 'Bravo Away @ Bravo Home', pick: 'Bravo Side', away: 'Bravo Away', home: 'Bravo Home',
  odds: -110, pCal: 0.56, pMkt: 0.524,
});
const C = row({
  matchup: 'Charlie Away @ Charlie Home', pick: 'Charlie Side', away: 'Charlie Away', home: 'Charlie Home',
  odds: -110, pCal: 0.55, pMkt: 0.524,
});
const D = row({
  matchup: 'Delta Away @ Delta Home', pick: 'Delta Side', away: 'Delta Away', home: 'Delta Home',
  odds: -110, pCal: 0.54, pMkt: 0.524,
});
const F = row({
  matchup: 'Foxtrot Away @ Foxtrot Home', pick: 'Foxtrot Side', away: 'Foxtrot Away', home: 'Foxtrot Home',
  odds: -110, line: 22.5, pCal: 0.52, pMkt: 110 / 210,
});
const E = row({
  matchup: 'Echo Away @ Echo Home', pick: 'Echo Side', away: 'Echo Away', home: 'Echo Home',
  odds: -450, pCal: 0.84, pMkt: 0.82,
});

assert.ok(A.ev > 0 && B.ev > 0 && C.ev > 0 && D.ev > 0, 'in-band replacements are +EV');
assert.ok(F.ev <= 0, `in-band fill EV should be <= 0 (${F.ev})`);
assert.ok(E.ev > 0, 'out-of-band -450 is +EV and still must not take a slot');
assert.ok(E.odds < -300);

const pool = [E, F, D, C, B, A];
const ordered = orderForcedPool(pool, { pregameAsOfMs: NOW.getTime(), env: ENV });
assert.deepStrictEqual(ordered.map((c) => c.pick), [
  'Alpha Side', 'Bravo Side', 'Charlie Side', 'Delta Side', 'Foxtrot Side', 'Echo Side',
]);
assert.strictEqual(ordered.find((c) => c.pick === 'Foxtrot Side').kellyGrowth, null);
assert.ok(ordered.find((c) => c.pick === 'Delta Side').kellyGrowth > 0);

function buildCard(rankedPool) {
  const sized = sizeForcedStraights([A, B, C]);
  const picks = sized.map((leg) => toPick(leg));
  const ticket = buildForcedParlay(sized);
  assert.strictEqual(ticket.publish, true, ticket.skipReason);
  const card = {
    date: '2026-11-15',
    engine: 'omega-v2',
    model: 'omega-v2-sharp-2026-11-01-dkhr',
    modelVersion: 'omega-v2-sharp-2026-11-01-dkhr',
    selectionRule: 'force-top3',
    pipeline: 'omega-v2',
    parlaySource: 'top3-straights',
    picks,
    parlayLegs: toParlay(ticket, sized.length),
    summary: { totalPicks: 3, totalStraightBets: 3 },
    edgeSummary: 'keep-me',
    qaHardFails: [],
    hardFails: [],
  };
  if (rankedPool) card.rankedPool = rankedPool;
  return card;
}

function postponedNews() {
  return {
    actions: [{
      action: 'drop',
      code: 'postponed',
      pick: 'Charlie Side',
      matchup: 'Charlie Away @ Charlie Home',
      reason: 'Game postponed before first pitch',
    }],
    dropped: 1,
    errors: [],
    checks: [{ matched: true }],
  };
}

function quietNews() {
  return { actions: [], dropped: 0, errors: [], checks: [{ matched: true }] };
}

assert.strictEqual(pastRerankCutoff(NOW), false);
assert.strictEqual(isV2Card(buildCard(pool)), true);
assert.strictEqual(newsRerankEnabled({}), true);
assert.strictEqual(newsRerankEnabled({ OMEGA_V2_NEWS_RERANK: 'off' }), false);

(async () => {
  const original = buildCard(pool);
  const before = JSON.parse(JSON.stringify(original));
  let writes = 0;

  const quiet = await runRerank({
    card: original,
    now: NOW,
    dateISO: '2026-11-15',
    env: ENV,
    runNews: async () => quietNews(),
    writePicks: async () => { writes += 1; },
  });
  assert.strictEqual(quiet.changed, false);
  assert.strictEqual(quiet.wrote, false);
  assert.strictEqual(quiet.reason, 'unchanged');
  assert.strictEqual(writes, 0);
  assert.strictEqual(quiet.card, original);
  assert.deepStrictEqual(original, before);

  let newsCalls = 0;
  const off = await runRerank({
    card: original,
    now: NOW,
    dateISO: '2026-11-15',
    env: { ...ENV, OMEGA_V2_NEWS_RERANK: 'off' },
    runNews: async () => { newsCalls += 1; return postponedNews(); },
    writePicks: async () => { writes += 1; },
  });
  assert.strictEqual(off.changed, false);
  assert.strictEqual(off.wrote, false);
  assert.strictEqual(off.reason, 'v2-rerank-off');
  assert.strictEqual(newsCalls, 0);
  assert.strictEqual(writes, 0);
  assert.deepStrictEqual(original, before);

  const bare = buildCard(null);
  const bareBefore = JSON.parse(JSON.stringify(bare));
  const noPool = await rerankCard({
    card: bare,
    now: NOW,
    env: ENV,
    runNews: async () => postponedNews(),
  });
  assert.strictEqual(noPool.changed, false);
  assert.strictEqual(noPool.reason, 'no-v2-pool');
  assert.strictEqual(noPool.card, bare);
  assert.deepStrictEqual(bare, bareBefore);

  const suspended = await rerankCard({
    card: original,
    now: NOW,
    env: ENV,
    pool,
    runNews: async () => ({
      actions: [{ action: 'drop', code: 'suspended', pick: 'Charlie Side', reason: 'Game suspended' }],
      dropped: 1,
      errors: [],
      checks: [{ matched: true }],
    }),
  });
  assert.strictEqual(suspended.changed, false);
  assert.strictEqual(suspended.reason, 'unchanged');
  assert.deepStrictEqual(original, before);

  const replaced = await runRerank({
    card: original,
    now: NOW,
    dateISO: '2026-11-15',
    env: ENV,
    runNews: async () => postponedNews(),
    writePicks: async () => { writes += 1; },
  });
  assert.strictEqual(replaced.changed, true);
  assert.strictEqual(replaced.wrote, true);
  assert.strictEqual(writes, 1);
  assert.strictEqual(replaced.reason, 'v2-hard-news');
  const next = replaced.card;
  assert.notStrictEqual(next, original);
  assert.deepStrictEqual(original, before);
  assert.strictEqual(next.picks.length, 3);
  assert.deepStrictEqual(next.picks.map((p) => p.pick), ['Alpha Side', 'Bravo Side', 'Delta Side']);
  assert.deepStrictEqual(next.picks[0], before.picks[0]);
  assert.deepStrictEqual(next.picks[1], before.picks[1]);
  assert.ok(next.picks.every((p) => p.pick !== 'Charlie Side'));
  assert.ok(next.picks.every((p) => p.pick !== 'Echo Side' && p.pick !== 'Foxtrot Side'));
  assert.strictEqual(next.engine, 'omega-v2');
  assert.strictEqual(next.selectionRule, 'force-top3');
  assert.strictEqual(next.parlaySource, 'top3-straights');
  assert.strictEqual(next.parlayLegs.length, 1);
  assert.strictEqual(next.parlayLegs[0].legs.length, 3);
  assert.deepStrictEqual(
    next.parlayLegs[0].legs.map((leg) => leg.pick),
    next.picks.map((p) => p.pick),
  );
  assert.strictEqual(next.edgeSummary, 'keep-me');
  assert.strictEqual(next.summary.totalPicks, 3);
  assert.strictEqual(next.summary.totalStraightBets, 3);
  assert.ok(next.picks[2].units);
  assert.ok(next.picks[2].odds);
  assert.strictEqual(next.newsRerank.type, 'v2-hard-news');
  assert.strictEqual(next.newsRerank.oddsApi, false);
  assert.deepStrictEqual(next.newsRerank.refilled, ['Delta Side']);

  const shortPool = buildCard([A, B, C]);
  const shortBefore = JSON.parse(JSON.stringify(shortPool));
  const short = await rerankCard({
    card: shortPool,
    now: NOW,
    env: ENV,
    runNews: async () => postponedNews(),
  });
  assert.strictEqual(short.changed, false);
  assert.strictEqual(short.reason, 'pool-short');
  assert.deepStrictEqual(shortPool, shortBefore);

  assert.strictEqual(typeof passesPublishFloor, 'function');
  assert.strictEqual(typeof passesLeanFill, 'function');
  assert.strictEqual(typeof compareByEv, 'function');
  assert.strictEqual(typeof straightCardLabel, 'function');
  assert.strictEqual(typeof eligibleForLeanPool, 'function');
  assert.strictEqual(typeof eligiblePairedFill, 'function');
  assert.strictEqual(passesPublishFloor({ sport: 'NFL', ev: 0.04, odds: -110 }), true);
  assert.strictEqual(passesPublishFloor({ sport: 'NFL', ev: 0.01, odds: -110 }), false);
  assert.strictEqual(passesPublishFloor({ sport: 'NFL', ev: 0.04, odds: -110, marginBiasExtreme: true }), false);
  assert.strictEqual(passesLeanFill({ ev: 0.05, book: 'draftkings' }), false);
  assert.strictEqual(straightCardLabel(3), '3 floor straights');
  const byEv = [{ ev: 0.01, edgePct: 0.02, matchup: 'a @ b' }, { ev: 0.05, edgePct: 0.02, matchup: 'c @ d' }];
  byEv.sort(compareByEv);
  assert.strictEqual(byEv[0].ev, 0.05);

  assert.strictEqual(statusAction({ detailedState: 'Postponed', statusCode: 'STATUS_POSTPONED' }), 'postponed');
  assert.strictEqual(statusAction({ detailedState: 'Canceled', statusCode: 'STATUS_CANCELED' }), 'canceled');
  assert.strictEqual(statusAction({ statusCode: 'PPD' }), 'postponed');
  assert.strictEqual(statusAction({ statusCode: 'CNCL' }), 'canceled');
  assert.strictEqual(statusAction({ detailedState: 'Suspended', statusCode: 'STATUS_SUSPENDED' }), 'suspended');
  const canceled = decideLateNews(
    { sport: 'NCAAF', pick: 'Charlie Side' },
    { detailedState: 'Canceled', status: 'Canceled', statusCode: 'STATUS_CANCELED' },
  );
  assert.strictEqual(canceled.action, 'drop');
  assert.strictEqual(canceled.code, 'canceled');

  console.log('PASS test-omega-v2-news-rerank');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
