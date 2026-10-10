'use strict';
/**
 * Candidate-side closes: separate blob, published CLV untouched, cap, snapshot reuse.
 * No network. Selection is not an input to this pass.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const cand = require(path.join(root, 'clv_candidates'));
const grade = require(path.join(root, 'clv_grade'));
const config = require(path.join(root, 'config'));
const { selectStraights } = require(path.join(root, 'select'));
const { buildRejectionLog } = require(path.join(root, 'index'));
const track = require('./netlify/functions/track-clv-omega')._test;

const COMMENCE = '2026-10-05T23:00:00Z';
const COMMENCE_B = '2026-10-05T20:00:00Z';
const COMMENCE_C = '2026-10-05T17:00:00Z';
const PAST = Date.parse('2026-10-06T16:00:00Z');

function oddsGame(home, away, commence) {
  return {
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: [{
      key: 'pinnacle',
      title: 'Pinnacle',
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -115, point: 8.5 },
          { name: 'Under', price: -105, point: 8.5 },
        ] },
      ],
    }],
  };
}

function baseDeps(extra) {
  return {
    dateISO: '2026-10-05',
    nowMs: PAST,
    extractClose: track.extractClose,
    pickSideInfo: track.pickSideInfo,
    findMatchingGame: track.findMatchingGame,
    teamsMatch: track.teamsMatch,
    gradePick: () => 'pending',
    findGameForGrading: () => null,
    ...extra,
  };
}

(async () => {
  assert.strictEqual(config.MODEL_VERSION, 'v12.3.18-omega-vnext-keys');
  assert.strictEqual(config.GATES.minEV.MLB, 0.03);
  assert.strictEqual(config.GATES.minEV.NFL, 0.025);
  assert.strictEqual(config.GATES.minCoverProb.MLB, 0.48);
  assert.strictEqual(config.KELLY_FRACTION, 0.25);
  assert.strictEqual(cand.CANDIDATE_SIDE_CAP, 20);
  assert.strictEqual(cand.LIVE_CREDITS, 9);
  assert.strictEqual(cand.HISTORICAL_CREDITS, 90);
  assert.strictEqual(cand.DEFAULT_EXTRA_CREDIT_CAP, 150);

  // Published formula helper matches the track-clv rounding.
  const rawClose = track.impliedProbability(-115);
  const rawBet = track.impliedProbability(-110);
  const overround = rawClose + track.impliedProbability(-105);
  const closingNoVig = grade.closingNoVigFromRaw(rawClose, overround);
  const pickTimeNoVig = grade.closingNoVigFromRaw(rawBet, overround);
  const graded = grade.clvFromNoVig(closingNoVig, pickTimeNoVig);
  assert.strictEqual(closingNoVig, +(rawClose / overround).toFixed(4));
  assert.strictEqual(graded.clvCents, +((closingNoVig - pickTimeNoVig) * 100).toFixed(2));

  // Rejection sample keeps the numbers the near-miss pass reads. Order and cap stay.
  const sampled = buildRejectionLog([], [], [
    {
      sport: 'MLB', matchup: 'A @ B', side: 'Over 8.5', rejectReason: 'ev-floor',
      market: 'Total', line: 8.5, odds: -110, fair_sharp_p: 0.51, coverProb: 0.53,
      edgePct: 0.012, ev: 0.02, commenceTime: COMMENCE, predictedClv: 0.4,
    },
    {
      sport: 'MLB', matchup: 'C @ D', side: 'C', rejectReason: 'insufficient-liquidity',
      edgePct: 0.04, ev: 0.05, coverProb: 0.55,
    },
  ]);
  assert.strictEqual(sampled.rows[0].reason, 'ev-floor');
  assert.strictEqual(sampled.rows[0].edge, 0.012);
  assert.strictEqual(sampled.rows[0].ev, 0.02);
  assert.strictEqual(sampled.rows[0].fair_sharp_p, 0.51);
  assert.strictEqual(sampled.rows[0].commenceTime, COMMENCE);
  assert.strictEqual(sampled.rows[1].reason, 'insufficient-liquidity');
  assert.ok(cand.isNearMissRejection(sampled.rows[0]));
  assert.strictEqual(cand.isNearMissRejection(sampled.rows[1]), false);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'ev-floor', sport: 'MLB', ev: 0.01 }), false);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'coverProb-floor', sport: 'MLB', coverProb: 0.47 }), true);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'coverProb-floor', sport: 'MLB', coverProb: 0.40 }), false);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'nonpositive-edge', edge: -0.014 }), true);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'nonpositive-edge', edge: -0.02 }), false);
  assert.strictEqual(cand.isNearMissRejection({ reason: 'ev-floor', sport: 'NFL', ev: 0.012 }), true);

  // Cap: 15 yes-pool rows outrank near-misses; only 20 sides survive.
  const candidateTable = [];
  for (let i = 0; i < 15; i++) {
    candidateTable.push({
      sport: 'MLB', matchup: `Yes ${i} @ Opp`, side: `Over ${i}.5`, market: 'Total',
      odds: -110, edge: 0.04 + i / 1000, ev: 0.05, coverProb: 0.55,
      fair_sharp_p: 0.50, commenceTime: COMMENCE, selected: false, line: i + 0.5,
    });
  }
  candidateTable.push({
    sport: 'MLB', matchup: 'Published @ Game', side: 'Over 9.5', market: 'Total',
    odds: -110, edge: 0.08, ev: 0.09, coverProb: 0.57, selected: true,
    commenceTime: COMMENCE, line: 9.5,
  });
  const rejections = [];
  for (let i = 0; i < 10; i++) {
    rejections.push({
      sport: 'MLB', matchup: `Miss ${i} @ Opp`, side: `Under ${i}.5`, market: 'Total',
      reason: 'ev-floor', odds: -110, edge: -0.001 * (i + 1), ev: 0.03 - 0.001 * (i + 1),
      coverProb: 0.50, fair_sharp_p: 0.50, commenceTime: COMMENCE, line: i + 0.5,
    });
  }
  const picksData = {
    date: '2026-10-05',
    picks: [{ pick: 'Over 9.5', matchup: 'Published @ Game', sport: 'MLB', betType: 'Total', odds: -110, commenceTime: COMMENCE }],
    candidateTable,
    rejections,
  };
  const picksBefore = JSON.stringify(picksData.picks);
  const selected = cand.selectCandidateSides(picksData);
  assert.strictEqual(selected.length, 20);
  assert.ok(selected.every((s) => s.matchup !== 'Published @ Game'));
  assert.strictEqual(selected.filter((s) => s.rejectReason === 'yes-pool-unselected').length, 15);
  assert.strictEqual(selected.filter((s) => s.rejectReason === 'ev-floor').length, 5);
  assert.ok(selected[0].qualityScore >= selected[selected.length - 1].qualityScore);

  // Selection fixture is unchanged by loading or running the candidate pass.
  const pool = [
    { sport: 'MLB', matchup: 'A @ B', side: 'Over 8', market: 'Total', edgePct: 0.04, ev: 0.05, coverProb: 0.55, odds: -110, predictedClv: 1 },
    { sport: 'MLB', matchup: 'C @ D', side: 'Over 7', market: 'Total', edgePct: 0.06, ev: 0.08, coverProb: 0.56, odds: -110, predictedClv: 1 },
  ];
  const pickedBefore = selectStraights(pool).map((p) => p.side);

  const clvData = {
    date: '2026-10-05',
    picks: [{
      pick: 'Over 9.5', matchup: 'Published @ Game', clv: 0.012, clvCents: 1.2,
      captureMinsToCommence: 0, captureScore: 0, closingNoVig: 0.52,
    }],
    avgCLV: 0.012,
    bySport: { MLB: { count: 1, clvSum: 0.012, beat: 1 } },
  };
  const clvBefore = JSON.stringify(clvData);
  const writes = {};
  const network = [];
  const cache = new Map();
  const game = oddsGame('Game', 'Published', COMMENCE);
  cache.set(`baseball_mlb|${COMMENCE}`, [game]);
  const publishedSnapshotKeys = new Set([`baseball_mlb|${COMMENCE}`]);

  async function getBulk(sportKey, atISO) {
    const key = `${sportKey}|${atISO || 'live'}`;
    if (!cache.has(key)) {
      network.push(key);
      cache.set(key, [oddsGame('Opp', 'Yes 0', atISO || COMMENCE)]);
    }
    return cache.get(key);
  }

  const shared = await cand.captureCandidateCloses(baseDeps({
    picksData,
    clvData,
    publishedSnapshotKeys,
    getBulk,
    store: {
      async get() { return null; },
      async setJSON(key, value) { writes[key] = JSON.parse(JSON.stringify(value)); },
    },
  }));

  assert.strictEqual(JSON.stringify(clvData), clvBefore, 'published clv rows stay byte-identical');
  assert.strictEqual(JSON.stringify(picksData.picks), picksBefore, 'published picks stay byte-identical');
  assert.deepStrictEqual(Object.keys(writes), ['clv-candidates-2026-10-05']);
  assert.strictEqual(writes['clv-2026-10-05'], undefined);
  assert.strictEqual(shared.payload.sides.length, 20);
  assert.ok(shared.payload.sides.every((s) => s.rejectReason));
  assert.strictEqual(network.length, 0, 'candidates that share the published commence snapshot make 0 extra pulls');
  assert.strictEqual(shared.credits.extraPulls, 0);
  assert.strictEqual(shared.credits.extraCredits, 0);
  const yesOnShared = shared.payload.sides.find((s) => s.matchup === 'Yes 0 @ Opp');
  assert.ok(yesOnShared);
  assert.strictEqual(yesOnShared.rejectReason, 'yes-pool-unselected');
  // Yes 0's game is not in the published snapshot (different matchup). Close may be null.
  // The pull was not made because the commence key was already covered. That is the reuse rule.

  assert.deepStrictEqual(selectStraights(pool).map((p) => p.side), pickedBefore);
  assert.deepStrictEqual(pickedBefore, ['Over 7', 'Over 8']);

  // A commence the published pass did not buy is one historical pull (90), and the cap
  // refuses a second and third historical pull (180 and 270 would clear 150).
  const uncovered = {
    date: '2026-10-05',
    picks: [],
    candidateTable: [
      { sport: 'MLB', matchup: 'A @ B', side: 'Over 8.5', market: 'Total', odds: -110, edge: 0.05, ev: 0.06, coverProb: 0.55, fair_sharp_p: 0.50, commenceTime: COMMENCE, line: 8.5, selected: false },
      { sport: 'MLB', matchup: 'C @ D', side: 'Over 7.5', market: 'Total', odds: -110, edge: 0.04, ev: 0.05, coverProb: 0.54, fair_sharp_p: 0.50, commenceTime: COMMENCE_B, line: 7.5, selected: false },
      { sport: 'MLB', matchup: 'E @ F', side: 'Over 6.5', market: 'Total', odds: -110, edge: 0.03, ev: 0.04, coverProb: 0.53, fair_sharp_p: 0.50, commenceTime: COMMENCE_C, line: 6.5, selected: false },
    ],
    rejections: [],
  };
  const pulls = [];
  const capped = await cand.captureCandidateCloses(baseDeps({
    picksData: uncovered,
    creditCap: 150,
    fetchBulk: async (sportKey, atISO) => {
      pulls.push(`${sportKey}|${atISO || 'live'}`);
      const home = atISO === COMMENCE ? 'B' : atISO === COMMENCE_B ? 'D' : 'F';
      const away = atISO === COMMENCE ? 'A' : atISO === COMMENCE_B ? 'C' : 'E';
      return [oddsGame(home, away, atISO)];
    },
  }));
  assert.deepStrictEqual(pulls, [`baseball_mlb|${COMMENCE}`]);
  assert.strictEqual(capped.credits.extraPulls, 1);
  assert.strictEqual(capped.credits.extraCredits, 90);
  assert.strictEqual(capped.credits.cap, 150);
  assert.ok(capped.plan.decisions.some((d) => d.action === 'skip-cap'));
  const closed = capped.payload.sides.find((s) => s.matchup === 'A @ B');
  const skipped = capped.payload.sides.find((s) => s.matchup === 'C @ D');
  assert.strictEqual(closed.closingOdds, '-115');
  assert.strictEqual(closed.closingLine, 8.5);
  assert.strictEqual(closed.closingNoVig, closingNoVig);
  assert.strictEqual(closed.clvCents, graded.clvCents);
  assert.strictEqual(closed.captureMinsToCommence, 0);
  assert.strictEqual(closed.fair_sharp_p, 0.50);
  assert.strictEqual(closed.odds, -110);
  assert.strictEqual(closed.rejectReason, 'yes-pool-unselected');
  assert.strictEqual(skipped.closingNoVig, null);
  assert.strictEqual(skipped.clvCents, null);

  // Upcoming games in one sport share one live pull (9), not a historical pull each.
  const livePulls = [];
  const upcoming = await cand.captureCandidateCloses(baseDeps({
    nowMs: Date.parse('2026-10-05T18:00:00Z'),
    picksData: {
      picks: [],
      candidateTable: [
        { sport: 'NHL', matchup: 'A @ B', side: 'A ML', market: 'Moneyline', odds: 130, edge: 0.04, ev: 0.05, coverProb: 0.52, fair_sharp_p: 0.48, commenceTime: '2026-10-05T23:00:00Z', selected: false },
        { sport: 'NHL', matchup: 'C @ D', side: 'C ML', market: 'Moneyline', odds: 140, edge: 0.03, ev: 0.04, coverProb: 0.51, fair_sharp_p: 0.47, commenceTime: '2026-10-06T00:00:00Z', selected: false },
      ],
      rejections: [],
    },
    fetchBulk: async (sportKey, atISO) => {
      livePulls.push(`${sportKey}|${atISO || 'live'}`);
      return [
        oddsGame('B', 'A', '2026-10-05T23:00:00Z'),
        oddsGame('D', 'C', '2026-10-06T00:00:00Z'),
      ];
    },
  }));
  assert.deepStrictEqual(livePulls, ['icehockey_nhl|live']);
  assert.strictEqual(upcoming.credits.extraCredits, 9);
  assert.strictEqual(upcoming.credits.extraPulls, 1);

  // Existing late live capture near commence is 0 credits and uses the same de-vig.
  const snapPulls = [];
  const snapAt = new Date(Date.parse(COMMENCE) - 10 * 60 * 1000).toISOString();
  const fromSnap = await cand.captureCandidateCloses(baseDeps({
    picksData: {
      picks: [],
      candidateTable: [{
        sport: 'MLB', matchup: 'A @ B', side: 'Over 8.5', market: 'Total', odds: -110,
        edge: 0.04, ev: 0.05, coverProb: 0.55, fair_sharp_p: 0.50, commenceTime: COMMENCE,
        line: 8.5, selected: false, homeTeam: 'B', awayTeam: 'A',
      }],
      rejections: [],
    },
    lateSnaps: [{
      capturedAt: snapAt,
      games: {
        'a @ b': {
          homeTeam: 'B', awayTeam: 'A', commenceTime: COMMENCE,
          books: {
            pinnacle: { total: 8.5, overOdds: -115, underOdds: -105, mlHome: -150, mlAway: 130 },
          },
        },
      },
    }],
    fetchBulk: async () => { snapPulls.push('x'); return []; },
  }));
  assert.deepStrictEqual(snapPulls, []);
  assert.strictEqual(fromSnap.credits.extraCredits, 0);
  assert.strictEqual(fromSnap.credits.existingLive, 1);
  assert.strictEqual(fromSnap.payload.sides[0].closingNoVig, closingNoVig);
  assert.strictEqual(fromSnap.payload.sides[0].captureMinsToCommence, 10);

  // Free events list says the game is gone and the side already has a close: no pull.
  const eventPulls = [];
  const storedSide = {
    date: '2026-10-05', sport: 'MLB', matchup: 'A @ B', market: 'Total', side: 'Over 8.5',
    line: 8.5, odds: -110, fair_sharp_p: 0.5, closingNoVig: 0.51, clv: 0.01, clvCents: 1,
    captureMinsToCommence: 0, captureScore: 0,
  };
  const skippedEvents = await cand.captureCandidateCloses(baseDeps({
    picksData: {
      picks: [],
      candidateTable: [{
        sport: 'MLB', matchup: 'A @ B', side: 'Over 8.5', market: 'Total', odds: -110,
        edge: 0.04, ev: 0.05, coverProb: 0.55, fair_sharp_p: 0.50, commenceTime: COMMENCE,
        line: 8.5, selected: false,
      }],
      rejections: [],
    },
    existing: { sides: [storedSide] },
    fetchEvents: async () => [],
    fetchBulk: async () => { eventPulls.push('x'); return []; },
  }));
  assert.deepStrictEqual(eventPulls, []);
  assert.strictEqual(skippedEvents.credits.extraPulls, 0);
  assert.ok(skippedEvents.plan.decisions.some((d) => d.action === 'skip-stored-close'));
  assert.strictEqual(skippedEvents.payload.sides[0].clvCents, 1);
  assert.strictEqual(skippedEvents.payload.sides[0].closingNoVig, 0.51);

  // Game has left the free events list and a prior (not-yet-true) close is stored: do not pay again.
  const earlyClose = { ...storedSide, captureMinsToCommence: 15, captureScore: 15, clv: 0.004, clvCents: 0.4, closingNoVig: 0.505 };
  const eventPulls2 = [];
  const eventsSkip = await cand.captureCandidateCloses(baseDeps({
    picksData: {
      picks: [],
      candidateTable: [{
        sport: 'MLB', matchup: 'A @ B', side: 'Over 8.5', market: 'Total', odds: -110,
        edge: 0.04, ev: 0.05, coverProb: 0.55, fair_sharp_p: 0.50, commenceTime: COMMENCE,
        line: 8.5, selected: false,
      }],
      rejections: [],
    },
    existing: { sides: [earlyClose] },
    fetchEvents: async () => [],
    fetchBulk: async () => { eventPulls2.push('x'); return []; },
  }));
  assert.deepStrictEqual(eventPulls2, []);
  assert.strictEqual(eventsSkip.credits.skippedEvents, 1);
  assert.strictEqual(eventsSkip.payload.sides[0].clvCents, 0.4);

  const handlerSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/track-clv-omega.js'), 'utf8');
  const candSrc = fs.readFileSync(path.join(root, 'clv_candidates.js'), 'utf8');
  assert.ok(handlerSrc.includes('recordCandidateCloses'));
  assert.ok(/setJSON\(`clv-\$\{dateISO\}`/.test(handlerSrc));
  assert.ok(candSrc.includes('clv-candidates-'));
  assert.ok(!/setJSON\(\s*`clv-\$\{/.test(candSrc));
  assert.ok(!candSrc.includes('selectStraights'));
  assert.ok(!candSrc.includes("setJSON(`clv-"));

  console.log('test-omega-clv-candidates: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
