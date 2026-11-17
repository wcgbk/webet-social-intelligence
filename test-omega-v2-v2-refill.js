'use strict';

/**
 * OMEGA_FIX_MISSING_IMPORTS_C on a v2 card.
 * Postponed and 11:00 hard-fail legs refill from rankedPool.
 * The parlay is the same straights via buildForcedParlay.
 * Reprice codes (qb-out, ev-floor) do not drop a v2 leg.
 * An empty pool keeps the original card, except a postponed game
 * with an empty pool, which publishes the short card and logs it.
 * Flag off is the pre-change path. No network: fetch is stubbed.
 */

const assert = require('assert');
const {
  annotateCandidate, gameKey,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, toParlay } = require('./netlify/functions/lib/omega-v2/guards');
const { compactPoolRow } = require('./netlify/functions/lib/omega-v2/ranked_pool');
const {
  missingImportsC, MISSING_IMPORTS_DEFAULT_ON,
} = require('./netlify/functions/lib/omega-vnext/missing_import_flag');
const {
  rerankCard, hardDropIndexes, parlayLegsForCard, applyV2VerifyRefill,
} = require('./netlify/functions/lib/omega-vnext/rerank');
const { enforceHardFailGate } = require('./netlify/functions/lib/omega-vnext/card_integrity');
const { finalizeCard } = require('./netlify/functions/lib/omega-vnext/timeline');
const { runLateNews } = require('./netlify/functions/lib/omega-vnext/late_news');
const verify = require('./netlify/functions/verify-picks-omega');

const NOW = new Date('2026-11-15T15:15:00Z');
const COMMENCE = '2027-01-01T18:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const ENV = {
  OMEGA_V2_MARKET_P: 'off',
  OMEGA_V2_LONGSHOT_ADJ: 'off',
  OMEGA_V2_FAV_CAP: 'off',
  OMEGA_V2_FORCE_TOP3: 'on',
  OMEGA_V2_EV_FIRST: 'on',
  OMEGA_V2_EV_FIRST_CAPPED: 'off',
  // Fixture commence times are not the card's ET date. This test is the
  // refill path. Same-day stays off here so those rows still refill.
  OMEGA_SAME_DAY_ONLY: 'off',
};
const ANNOTATE = { forceTop3: true, pregameAsOfMs: NOW.getTime(), env: ENV };
const FLAG = 'OMEGA_FIX_MISSING_IMPORTS_C';
const savedFlag = process.env[FLAG];

function setFlag(value) {
  if (value == null) delete process.env[FLAG];
  else process.env[FLAG] = value;
}

function restoreFlag() {
  setFlag(savedFlag);
}

assert.strictEqual(missingImportsC({}), MISSING_IMPORTS_DEFAULT_ON);
assert.strictEqual(missingImportsC({ [FLAG]: 'on' }), true);
assert.strictEqual(missingImportsC({ [FLAG]: '1' }), true);
assert.strictEqual(missingImportsC({ [FLAG]: 'true' }), true);
assert.strictEqual(missingImportsC({ [FLAG]: 'yes' }), true);
assert.strictEqual(missingImportsC({ [FLAG]: 'off' }), false);
assert.strictEqual(missingImportsC({ [FLAG]: '0' }), false);
assert.strictEqual(missingImportsC({ [FLAG]: 'false' }), false);
assert.strictEqual(missingImportsC({ [FLAG]: '' }), false);
assert.strictEqual(missingImportsC({ [FLAG]: 'maybe' }), false);

function row(spec) {
  const matchup = spec.matchup;
  const annotated = annotateCandidate({
    sport: spec.sport || 'NFL',
    matchup,
    pick: spec.pick,
    side: spec.pick,
    market: 'Spread',
    line: spec.line != null ? spec.line : -3.5,
    odds: spec.odds,
    book: 'draftkings',
    gameKey: gameKey(matchup),
    commenceTime: spec.commenceTime || COMMENCE,
    homeTeam: spec.home,
    awayTeam: spec.away,
    sharpBook: 'pinnacle',
    calibration: {
      pCal: spec.pCal,
      pMkt: spec.pMkt,
      pModel: spec.pCal,
      method: 'board',
    },
  }, ANNOTATE);
  assert.strictEqual(annotated.qualified, true, `${spec.pick} ${annotated.rejectReason}`);
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
const heavy = row({
  matchup: 'Echo Away @ Echo Home', pick: 'Echo Side', away: 'Echo Away', home: 'Echo Home',
  odds: -450, pCal: 0.84, pMkt: 0.82,
});
const started = row({
  matchup: 'Start Away @ Start Home', pick: 'Start Side', away: 'Start Away', home: 'Start Home',
  odds: -110, pCal: 0.59, pMkt: 0.524, commenceTime: PAST,
});
const sameGame = row({
  matchup: A.matchup, pick: 'Alpha Other', away: A.awayTeam, home: A.homeTeam,
  odds: -110, pCal: 0.57, pMkt: 0.524,
});

function compact(annotated) {
  return compactPoolRow(annotated, true);
}

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
    parlaySource: 'top3-straights',
    picks,
    parlayLegs: toParlay(ticket, sized.length),
    summary: { totalPicks: 3, totalStraightBets: 3 },
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
      matchup: C.matchup,
      reason: 'Game postponed before first pitch',
    }],
    dropped: 1,
    errors: [],
    checks: [{ matched: true }],
  };
}

function same3(card) {
  assert.strictEqual(card.picks.length, 3);
  assert.strictEqual(card.parlayLegs.length, 1);
  assert.strictEqual(card.parlayLegs[0].source, 'omega-v2');
  assert.strictEqual(card.parlayLegs[0].legs.length, 3);
  assert.deepStrictEqual(
    card.parlayLegs[0].legs.map((leg) => leg.pick),
    card.picks.map((pick) => pick.pick),
  );
}

const pool = [
  compact(started),
  compact(sameGame),
  compact(heavy),
  compact(D),
];
assert.strictEqual(pool[2].inBand, false);
assert.strictEqual(pool[2].odds, -450);
assert.strictEqual(pool[3].inBand, true);
assert.ok(pool[2].pick === 'Echo Side' && pool.indexOf(pool[2]) < pool.indexOf(pool[3]));

function qbCard() {
  const card = buildCard([compact(D)]);
  const leg = card.picks[0];
  leg.sport = 'NFL';
  leg.pick = 'Baltimore Ravens -3.5';
  leg.side = leg.pick;
  leg.matchup = 'Cincinnati Bengals @ Baltimore Ravens';
  leg.homeTeam = 'Baltimore Ravens';
  leg.awayTeam = 'Cincinnati Bengals';
  leg.commenceTime = '2026-11-15T18:00:00Z';
  leg.odds = -110;
  leg.coverProb = 0.55;
  leg.winProbability = 0.55;
  leg.lateNews = {
    qb: {
      loaded: true,
      home: { qbStatus: 'healthy', qbName: 'Lamar Jackson' },
      away: { qbStatus: 'healthy', qbName: 'Joe Burrow' },
    },
  };
  card.picks[1].commenceTime = '2026-11-20T18:00:00Z';
  card.picks[2].commenceTime = '2026-11-20T18:00:00Z';
  return card;
}

function qbFetch(url) {
  const text = String(url && url.url ? url.url : url || '');
  if (/the-odds-api\.com/i.test(text)) throw new Error('odds api');
  if (text.includes('/nfl/injuries')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        injuries: [{
          displayName: 'Baltimore Ravens',
          injuries: [{
            status: 'Out',
            athlete: {
              displayName: 'Lamar Jackson',
              position: { abbreviation: 'QB' },
            },
          }],
        }],
      }),
    });
  }
  if (text.includes('/nfl/scoreboard')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        events: [{
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Baltimore Ravens' } },
              { homeAway: 'away', team: { displayName: 'Cincinnati Bengals' } },
            ],
            status: { type: { description: 'Scheduled', name: 'STATUS_SCHEDULED' } },
          }],
        }],
      }),
    });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

(async () => {
  setFlag('on');
  const original = buildCard(pool);
  const before = JSON.parse(JSON.stringify(original));
  const replaced = await rerankCard({
    card: original,
    now: NOW,
    env: ENV,
    runNews: async () => postponedNews(),
  });
  assert.strictEqual(replaced.changed, true, replaced.reason);
  assert.strictEqual(replaced.reason, 'v2-hard-news');
  assert.deepStrictEqual(original, before);
  assert.deepStrictEqual(replaced.card.picks.map((pick) => pick.pick), [
    'Alpha Side', 'Bravo Side', 'Delta Side',
  ]);
  assert.ok(replaced.card.picks.every((pick) => pick.pick !== 'Echo Side' && pick.pick !== 'Start Side' && pick.pick !== 'Alpha Other'));
  same3(replaced.card);
  assert.deepStrictEqual(replaced.card.newsRerank.refilled, ['Delta Side']);

  const reprice = { actions: [], dropped: 0, errors: [], checks: [{ matched: true }] };
  for (const code of ['qb-out', 'ev-floor', 'suspended']) {
    const news = {
      actions: [{ action: 'drop', code, pick: 'Charlie Side', matchup: C.matchup, reason: `Repriced ${code}` }],
      dropped: 1,
      errors: [],
      checks: [{ matched: true }],
    };
    assert.strictEqual(hardDropIndexes(original, news).size, 0, code);
    reprice.actions.push(news.actions[0]);
  }
  const ignored = await rerankCard({
    card: original,
    now: NOW,
    env: ENV,
    runNews: async () => reprice,
  });
  assert.strictEqual(ignored.changed, false);
  assert.strictEqual(ignored.reason, 'unchanged');
  assert.strictEqual(ignored.card, original);
  assert.strictEqual(hardDropIndexes(original, postponedNews()).size, 1);

  const qb = qbCard();
  const qbBefore = JSON.parse(JSON.stringify(qb));
  const live = await runLateNews({
    picksData: JSON.parse(JSON.stringify(qb)),
    now: NOW,
    fetchImpl: qbFetch,
    dateISO: '2026-11-15',
    withinMin: 20 * 60,
  });
  assert.strictEqual(live.softFail, false, (live.errors || []).join(';'));
  const qbAction = (live.actions || []).find((action) => action && (action.code === 'ev-floor' || action.code === 'qb-out'));
  assert.ok(qbAction, `expected qb reprice, got ${JSON.stringify(live.actions)}`);
  assert.strictEqual(qbAction.code, 'ev-floor');
  assert.ok(/qb-out/i.test(String(qbAction.reason || qbAction.from || '')));
  assert.strictEqual(hardDropIndexes(qb, live).size, 0, 'reprice is not a v2 hard drop');
  const qbRerank = await rerankCard({
    card: qb,
    now: NOW,
    env: ENV,
    fetchImpl: qbFetch,
  });
  assert.strictEqual(qbRerank.changed, false);
  assert.strictEqual(qbRerank.reason, 'unchanged');
  assert.strictEqual(qbRerank.card, qb);
  assert.deepStrictEqual(qb.picks.map((pick) => pick.pick), qbBefore.picks.map((pick) => pick.pick));

  const qa = buildCard(pool);
  qa.qaHardFails = [{ side: 'Charlie Side', matchup: C.matchup, hardFail: true, reason: 'math' }];
  const gated = enforceHardFailGate(JSON.parse(JSON.stringify(qa)));
  assert.strictEqual(gated.changed, true);
  assert.deepStrictEqual(gated.card.picks.map((pick) => pick.pick), [
    'Alpha Side', 'Bravo Side', 'Delta Side',
  ]);
  same3(gated.card);
  const finalized = finalizeCard(JSON.parse(JSON.stringify(qa)), NOW);
  assert.strictEqual(finalized.card.finalized, true);
  assert.strictEqual(finalized.card.timelineStep, '11:00');
  same3(finalized.card);
  assert.ok(finalized.card.picks.every((pick) => pick.pick !== 'Charlie Side' && pick.pick !== 'Echo Side'));

  const empty = buildCard(null);
  empty.rankedPool = [];
  empty.qaHardFails = [{ side: 'Charlie Side', matchup: C.matchup, hardFail: true, reason: 'math' }];
  const emptyBefore = JSON.parse(JSON.stringify(empty.picks));
  const kept = enforceHardFailGate(empty);
  assert.strictEqual(kept.changed, false);
  assert.deepStrictEqual(kept.card.picks, emptyBefore);
  assert.strictEqual(kept.card.picks.length, 3);

  const warns = [];
  const priorWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let shortResult;
  try {
    shortResult = await rerankCard({
      card: buildCard(null),
      now: NOW,
      env: ENV,
      runNews: async () => postponedNews(),
    });
  } finally {
    console.warn = priorWarn;
  }
  assert.strictEqual(shortResult.changed, true, shortResult.reason);
  assert.strictEqual(shortResult.reason, 'v2-short');
  assert.strictEqual(shortResult.card.picks.length, 2);
  assert.ok(shortResult.card.picks.every((pick) => pick.pick !== 'Charlie Side'));
  assert.strictEqual(shortResult.card.parlayLegs[0].source, 'omega-v2');
  assert.strictEqual(shortResult.card.parlayLegs[0].legs.length, 2);
  assert.deepStrictEqual(
    shortResult.card.parlayLegs[0].legs.map((leg) => leg.pick),
    shortResult.card.picks.map((pick) => pick.pick),
  );
  assert.ok(warns.some((line) => /postponed\/cancelled and ranked pool empty/.test(line)));

  const killed = buildCard(pool);
  const snapshot = JSON.parse(JSON.stringify(killed));
  killed.picks = killed.picks.filter((pick) => pick.pick !== 'Charlie Side');
  assert.strictEqual(typeof verify.applyV2VerifyRefill, 'function');
  const verified = verify.applyV2VerifyRefill(killed, {
    snapshot,
    pregameAsOfMs: NOW.getTime(),
    env: ENV,
  });
  assert.strictEqual(verified.changed, true, verified.reason);
  assert.strictEqual(verified.skipLockedParlay, true);
  assert.deepStrictEqual(killed.picks.map((pick) => pick.pick), [
    'Alpha Side', 'Bravo Side', 'Delta Side',
  ]);
  same3(killed);

  const legacy = parlayLegsForCard(original, original.picks, {});
  assert.strictEqual(legacy[0].source, 'omega-v2');
  assert.strictEqual(legacy[0].legs.length, 3);
  assert.deepStrictEqual(
    legacy[0].legs.map((leg) => leg.pick),
    original.picks.map((pick) => pick.pick),
  );

  setFlag('off');
  const offCard = buildCard(pool);
  const offBefore = JSON.parse(JSON.stringify(offCard));
  const offReplaced = await rerankCard({
    card: offCard,
    now: NOW,
    env: ENV,
    runNews: async () => postponedNews(),
  });
  assert.strictEqual(offReplaced.changed, true);
  assert.strictEqual(offReplaced.reason, 'v2-hard-news');
  // Missing-imports off does not force the old in-band fill. The favorite
  // cap is off. Blend rank is price EV, so Delta (-110, p 0.54, about +3.1%)
  // beats Echo (-450, p 0.84, about +2.7%). Growth order would have kept Echo.
  assert.deepStrictEqual(offReplaced.card.picks.map((pick) => pick.pick), [
    'Alpha Side', 'Bravo Side', 'Delta Side',
  ]);
  same3(offReplaced.card);
  assert.deepStrictEqual(offCard, offBefore);

  const offBare = buildCard(null);
  const offBareBefore = JSON.parse(JSON.stringify(offBare));
  const offEmpty = await rerankCard({
    card: offBare,
    now: NOW,
    env: ENV,
    runNews: async () => postponedNews(),
  });
  assert.strictEqual(offEmpty.changed, false);
  assert.strictEqual(offEmpty.reason, 'no-v2-pool');
  assert.strictEqual(offEmpty.card, offBare);
  assert.deepStrictEqual(offBare, offBareBefore);

  const offQb = qbCard();
  const offLive = await runLateNews({
    picksData: offQb,
    now: NOW,
    fetchImpl: qbFetch,
    dateISO: '2026-11-15',
    withinMin: 20 * 60,
  });
  assert.strictEqual(offLive.softFail, true);
  assert.ok((offLive.errors || []).some((line) => /lookupQb is not a function/.test(line)));
  const offQbRerank = await rerankCard({
    card: offQb,
    now: NOW,
    env: ENV,
    fetchImpl: qbFetch,
  });
  assert.strictEqual(offQbRerank.changed, false);
  assert.strictEqual(offQbRerank.reason, 'news-failed');
  assert.strictEqual(offQbRerank.card, offQb);

  const offQa = buildCard(pool);
  offQa.qaHardFails = [{ side: 'Charlie Side', matchup: C.matchup, hardFail: true, reason: 'math' }];
  assert.throws(
    () => enforceHardFailGate(offQa),
    /parlayFromStraights is not a function/,
  );
  assert.throws(
    () => parlayLegsForCard(offQa, offQa.picks, {}),
    /parlayFromStraights is not a function/,
  );
  const offKilled = buildCard(pool);
  offKilled.picks = offKilled.picks.slice(0, 2);
  const offVerify = applyV2VerifyRefill(offKilled, { snapshot: buildCard(pool) });
  assert.strictEqual(offVerify.handled, false);
  assert.strictEqual(offKilled.picks.length, 2);

  restoreFlag();
  console.log('PASS test-omega-v2-v2-refill');
})().catch((err) => {
  restoreFlag();
  console.error(err);
  process.exit(1);
});
