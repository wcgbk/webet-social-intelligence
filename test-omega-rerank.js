'use strict';

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { rerankCard, pastRerankCutoff } = require('./netlify/functions/lib/omega-vnext/rerank');
const { applyCardActions } = require('./netlify/functions/lib/omega-vnext/late_news');
const { parseEdgeFraction } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { passesPublishFloor } = require('./netlify/functions/lib/omega-vnext/select');
const { runRerank } = require('./netlify/functions/rerank-picks-omega');
const et = require('./netlify/functions/lib/et-schedule');

assert.strictEqual(config.MODEL_VERSION, 'v12.3.63-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.63-omega-vnext-price-lock:'));
assert.strictEqual(config.LEAN_MIN_EDGE, 0.015);
assert.strictEqual(config.LEAN_MIN_EV, 0.015);
assert.deepStrictEqual(et.ET_SCHEDULE['rerank-picks-omega'].etTimes, ['10:15']);

const AT = new Date('2026-10-13T14:15:00.000Z');
const AFTER = new Date('2026-10-13T14:31:00.000Z');
assert.strictEqual(et.etParts(AT).et, '10:15');
assert.strictEqual(pastRerankCutoff(AT), false);
assert.strictEqual(pastRerankCutoff(AFTER), true);

function row(side, matchup, edge, extra) {
  return {
    sport: 'NFL',
    market: 'Spread',
    side,
    matchup,
    homeTeam: matchup.split(' @ ')[1],
    awayTeam: matchup.split(' @ ')[0],
    commenceTime: '2026-10-13T23:30:00.000Z',
    odds: -110,
    edgePct: edge,
    ev: 0.04,
    coverProb: 0.55,
    line: -3,
    uncertainty: 0.15,
    book: 'draftkings',
    tier: 'floor',
    ...extra,
  };
}

function cardFrom(rows) {
  const picks = rows.slice(0, 3).map((r) => ({
    ...r,
    pick: r.side,
    betType: r.market,
    edgePct: r.edgePct,
    evRaw: r.ev,
    tier: 'floor',
    units: '1.0u',
    coreReasoning: `${r.side} writeup`,
  }));
  return {
    date: '2026-10-13',
    model: config.MODEL_VERSION,
    picks,
    parlayLegs: [{ legs: picks.map((p) => ({ pick: p.pick, matchup: p.matchup })) }],
    candidateTable: rows.map((r) => ({ ...r, edge: r.edgePct })),
    selection: { window: '10:00-10:15', rerankWindow: '10:15-10:30', top10: [] },
    summary: { totalPicks: picks.length },
  };
}

function edgeOf(pick) {
  return parseEdgeFraction(pick.edgePct != null ? pick.edgePct : pick.edge);
}

(async () => {
  const rows = [
    row('Alpha +3', 'Alpha @ Beta', 0.05),
    row('Gamma -2.5', 'Gamma @ Delta', 0.045),
    row('Epsilon +7', 'Epsilon @ Zeta', 0.04),
    row('Eta -1', 'Eta @ Theta', 0.035),
  ];
  const card = cardFrom(rows);
  const dropped = await rerankCard({
    card,
    now: AT,
    runNews: ({ picksData }) => applyCardActions(picksData, [{
      index: 0, action: 'drop', code: 'postponed', reason: 'Game postponed',
    }], AT),
  });
  assert.strictEqual(dropped.changed, true);
  assert.strictEqual(dropped.lastKnownGood, false);
  assert.strictEqual(dropped.oddsApi, false);
  assert.strictEqual(dropped.card.picks.length, 3);
  assert.ok(dropped.card.picks.every((p) => p.pick !== 'Alpha +3'));
  assert.ok(dropped.card.picks.some((p) => p.pick === 'Eta -1' || p.side === 'Eta -1'));
  assert.ok(dropped.card.picks.every((p) => p.tier !== 'lean' && edgeOf(p) >= 0.03));
  assert.strictEqual(dropped.card.parlayLegs[0].legs.length, 3);
  assert.ok(dropped.card.selection.top10.length >= 3);
  assert.strictEqual(dropped.card.selection.oddsApi, false);
  assert.strictEqual(card.picks[0].pick, 'Alpha +3');

  const demoted = await rerankCard({
    card,
    now: AT,
    runNews: ({ picksData }) => {
      picksData.picks[0].edgePct = 0.02;
      picksData.picks[0].ev = 0.02;
      picksData.picks[0].evRaw = 0.02;
      return { softFail: false, dropped: 0, errors: [], checks: [{ matched: true }], removed: [] };
    },
  });
  assert.strictEqual(demoted.changed, true);
  const mains = demoted.card.picks.filter((p) => p.tier !== 'lean');
  assert.ok(mains.length >= 1);
  assert.ok(mains.every((p) => passesPublishFloor({
    ...p,
    edgePct: edgeOf(p),
    ev: p.evRaw != null ? p.evRaw : p.ev,
    odds: -110,
    uncertainty: 0.15,
  })));
  assert.ok(demoted.card.picks.every((p) => p.tier === 'lean' || edgeOf(p) + 1e-12 >= 0.03));
  const alpha = demoted.card.picks.find((p) => (p.pick || p.side) === 'Alpha +3');
  if (alpha) assert.strictEqual(alpha.tier, 'lean');

  let fetches = 0;
  const failed = await rerankCard({
    card,
    now: AT,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('espn down');
    },
  });
  assert.ok(fetches >= 1);
  assert.strictEqual(failed.lastKnownGood, true);
  assert.strictEqual(failed.reason, 'news-failed');
  assert.strictEqual(failed.changed, false);
  assert.strictEqual(failed.card, card);

  let lateFetch = 0;
  const late = await rerankCard({
    card,
    now: AFTER,
    fetchImpl: async () => { lateFetch += 1; throw new Error('should not fetch'); },
  });
  assert.strictEqual(lateFetch, 0);
  assert.strictEqual(late.reason, 'after-1030');
  assert.strictEqual(late.card, card);

  const odds = await rerankCard({
    card,
    now: AT,
    fetchImpl: async (url) => {
      throw new Error(`odds fetch leaked ${url}`);
    },
    runNews: async ({ fetchImpl }) => {
      await fetchImpl('https://api.the-odds-api.com/v4/sports');
      return { softFail: false, errors: [], checks: [{ matched: true }] };
    },
  });
  assert.strictEqual(odds.lastKnownGood, true);
  assert.strictEqual(odds.reason, 'news-failed');
  assert.strictEqual(odds.card.picks[0].pick, 'Alpha +3');

  const same = await rerankCard({
    card,
    now: AT,
    runNews: () => ({ softFail: false, dropped: 0, errors: [], checks: [{ matched: true }] }),
  });
  assert.strictEqual(same.changed, false);
  assert.strictEqual(same.reason, 'unchanged');
  assert.strictEqual(same.card, card);

  let writes = 0;
  const dry = await runRerank({
    now: AT,
    dateISO: '2026-10-13',
    card,
    dryRun: true,
    runNews: ({ picksData }) => applyCardActions(picksData, [{
      index: 0, action: 'drop', code: 'postponed', reason: 'Game postponed',
    }], AT),
    writePicks: async () => { writes += 1; },
  });
  assert.strictEqual(dry.wrote, false);
  assert.strictEqual(dry.changed, true);
  assert.strictEqual(writes, 0);

  const saved = [];
  const live = await runRerank({
    now: AT,
    dateISO: '2026-10-13',
    card,
    dryRun: false,
    env: {},
    runNews: ({ picksData }) => applyCardActions(picksData, [{
      index: 0, action: 'drop', code: 'postponed', reason: 'Game postponed',
    }], AT),
    writePicks: async (date, next) => { saved.push({ date, picks: next.picks.length }); },
  });
  assert.strictEqual(live.wrote, true);
  assert.deepStrictEqual(saved, [{ date: '2026-10-13', picks: 3 }]);

  const skip = et.rejectUnlessEtSlot('rerank-picks-omega', {
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
  }, new Date('2026-10-13T13:00:00.000Z'));
  assert.ok(skip);
  assert.ok(String(skip.body).includes('outside-et-slot'));
  const allow = et.etGuard('rerank-picks-omega', {
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
  }, AT);
  assert.strictEqual(allow.run, true);
  assert.strictEqual(allow.matched, '10:15');

  console.log('test-omega-rerank ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
