'use strict';
// Selection-pass rules. No network. No blob writes.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { priceLockTimestamp } = require(path.join(root, 'price_lock'));
const { etLocalToUtcISO } = require(path.join(root, 'price_lock'));
const { gateReason } = require(path.join(root, 'gates'));
const { minEdgeFor } = require(path.join(root, 'edge_floor'));
const { selectStraights } = require(path.join(root, 'select'));
const { NFL_KEY_NUMBERS } = require(path.join(root, 'config'));
const { applyGameDayAdjustments } = require(path.join(root, 'sports/game_day'));
const { roofClosed, footballWeatherAdjustment } = require(path.join(root, 'sports/football_weather'));
const { resolveTeamId, isFbsTeamId } = require(path.join(root, 'sports/team_identity'));
const { solveNcaafOpponentRatings } = require(path.join(root, 'sports/epa'));
const nhl = require(path.join(root, 'sports/nhl'));
const { parseFootballPersonnel } = require(path.join(root, 'late_news'));
const {
  LAST5_K, LAST5_CAP, shrinkLast5IntoRating, lookupLast5,
} = require(path.join(root, 'last5'));
const {
  NON_QB_ASSUMPTION, conservativeNonQbAdj,
} = require(path.join(root, 'personnel'));
const { fetchXNews, tokenFrom } = require(path.join(root, 'x_news'));
const {
  slateBounds, slateReason, inSlate, priceAtDraftKings, applyExecutionBook,
  hardRockReviewFlag, reviewHardRock, nflProjectionGap, selectTop10, top10Rows,
  verifySchedule, verifyStartReason, sampleInSlateKick,
} = require(path.join(root, 'selection_pass'));

const CARD = '2026-10-11';
const IN_SLATE = '2026-10-11T20:00:00Z'; // 16:00 ET

async function main() {

function base(extra) {
  return {
    sport: 'NFL',
    matchup: 'A @ B',
    side: 'B -3',
    market: 'Spread',
    line: -3,
    odds: -110,
    coverProb: 0.56,
    ev: 0.05,
    edgePct: 0.04,
    liquid: true,
    uncertainty: 0.12,
    commenceTime: IN_SLATE,
    homeTeam: 'B',
    awayTeam: 'A',
    ...extra,
  };
}

// ── 1. DraftKings execution book and backfill ──
{
  const noDk = base({
    matchup: 'A @ B', side: 'A +9', line: 9, market: 'Spread', ev: 0.09, edgePct: 0.06,
    book: 'bovada', bookPrices: [{ book: 'bovada', american: -105, point: 9 }],
  });
  const dk = base({
    matchup: 'C @ D', side: 'C +8.5', line: 8.5, market: 'Spread',
    book: 'fanduel', odds: -102, coverProb: 0.55, fair_sharp_p: 0.50,
    bookPrices: [
      { book: 'fanduel', american: -102, point: 8.5 },
      { book: 'draftkings', american: -110, point: 8.5 },
    ],
  });
  const priced = priceAtDraftKings(dk);
  assert.strictEqual(priced.book, 'draftkings');
  assert.strictEqual(priced.odds, -110);
  assert.ok(priced.ev != null);
  const exec = applyExecutionBook([noDk, dk]);
  assert.strictEqual(exec.excluded.length, 1);
  assert.strictEqual(exec.excluded[0].excludeReason, 'no-draftkings-line');
  assert.strictEqual(exec.candidates.length, 1);
  assert.strictEqual(exec.candidates[0].book, 'draftkings');
  assert.strictEqual(exec.candidates[0].side, 'C +8.5');

  const synthetic = base({ book: 'bovada', odds: -105 });
  const kept = applyExecutionBook([synthetic]);
  assert.strictEqual(kept.excluded.length, 0);
  assert.strictEqual(kept.candidates[0].book, 'bovada');
  assert.strictEqual(kept.candidates[0].odds, -105);
}

// ── 2. Hard Rock review-only. Never a reject. ──
{
  const cross3 = hardRockReviewFlag({ sport: 'NFL', line: -2.5, hardRock: { point: -3, american: -110 } });
  assert.ok(cross3.flags.some((f) => f.type === 'nfl-key-cross' && f.key === -3));
  const cross7 = hardRockReviewFlag({ sport: 'NFL', line: 7, hardRock: { point: 7.5, american: -110 } });
  assert.ok(cross7.flags.some((f) => f.type === 'nfl-key-cross' && f.key === 7));
  const full = hardRockReviewFlag({ sport: 'NBA', line: -3.5, hardRock: { point: -4.5, american: -110 } });
  assert.ok(full.flags.some((f) => f.type === 'point-gap'));
  assert.strictEqual(hardRockReviewFlag({ sport: 'NFL', line: -2.5, hardRock: { point: -2, american: -110 } }), null);
  assert.strictEqual(hardRockReviewFlag({ sport: 'NFL', line: -3, hardRock: null }), null);
  const flagged = base({ line: -2.5, hardRock: { point: -3, american: -115 }, hrFlags: null });
  assert.strictEqual(gateReason({ ...flagged, hrFlags: cross3.flags }, { cardDate: CARD }), null);

  const card = {
    picks: [base({
      pick: 'Home Team -2.5', side: 'Home Team -2.5', betType: 'Spread', line: -2.5, odds: '-110', sport: 'NFL',
      matchup: 'Away Team @ Home Team',
    })],
    parlayLegs: [],
  };
  const before = card.picks[0].odds;
  const reviewed = reviewHardRock(card, {
    NFL: [{
      home_team: 'Home Team',
      away_team: 'Away Team',
      bookmakers: [{
        key: 'hardrockbet',
        markets: [{
          key: 'spreads',
          outcomes: [
            { name: 'Home Team', price: -110, point: -3 },
            { name: 'Away Team', price: -110, point: 3 },
          ],
        }],
      }],
    }],
  });
  assert.strictEqual(reviewed.changed, false);
  assert.strictEqual(card.picks[0].odds, before);
  assert.strictEqual(card.picks[0].line, -2.5);
  assert.ok(card.picks[0].hrFlags.some((f) => f.type === 'nfl-key-cross'));
}

// ── 3. NFL |projection − sharp| > 10, log path via the gate reason ──
{
  const total = base({
    market: 'Total', side: 'Over 44', line: 44,
    modelTotalRaw: 55, marketTotal: 44, modelLineGap: 11,
  });
  assert.strictEqual(nflProjectionGap(total), 'nfl-projection-gap');
  assert.strictEqual(gateReason(total, { cardDate: CARD }), 'nfl-projection-gap');
  const exact = base({
    market: 'Total', side: 'Over 44', line: 44,
    modelTotalRaw: 54, marketTotal: 44, modelLineGap: 10,
  });
  assert.strictEqual(nflProjectionGap(exact), null);
  assert.strictEqual(gateReason(exact, { cardDate: CARD }), null);
  const spread = base({
    market: 'Spread', modelMarginRaw: 14, marketMargin: 3, modelLineGap: 11,
  });
  assert.strictEqual(gateReason(spread, { cardDate: CARD }), 'model_market_gap');
  const cfbTotal = base({
    sport: 'NCAAF', market: 'Total', side: 'Over 50',
    modelTotalRaw: 61, marketTotal: 50, modelLineGap: 11,
  });
  assert.strictEqual(nflProjectionGap(cfbTotal), null);
  assert.notStrictEqual(gateReason(cfbTotal, { cardDate: CARD }), 'nfl-projection-gap');
}

// ── 4. 10:30 ET lock, ESPN personnel, X hook, weather, last-5 inside the rating ──
{
  assert.strictEqual(priceLockTimestamp('2026-10-11'), '2026-10-11T14:30:00Z');
  assert.strictEqual(priceLockTimestamp('2026-10-10'), '2026-10-10T14:30:00Z');
  assert.strictEqual(priceLockTimestamp('2026-11-08'), '2026-11-08T15:30:00Z');

  const parsed = parseFootballPersonnel({
    injuries: [{
      team: { displayName: 'Buffalo Bills' },
      injuries: [
        { athlete: { displayName: 'Wide Out', position: { abbreviation: 'WR' } }, status: 'Out' },
        { athlete: { displayName: 'The Kicker', position: { abbreviation: 'K' } }, status: 'Out' },
        { athlete: { displayName: 'Signal', position: { abbreviation: 'QB' } }, status: 'Doubtful' },
      ],
    }],
  });
  assert.strictEqual(parsed['Buffalo Bills'].players.length, 3);

  const homeOnly = conservativeNonQbAdj(parsed['Buffalo Bills'].players, []);
  assert.ok(Math.abs(homeOnly.marginAdj + NON_QB_ASSUMPTION.outPoints) < 1e-9, homeOnly.marginAdj);
  assert.ok(homeOnly.logs.some((row) => row.action === 'logged-unquantified-specialist'));
  assert.strictEqual(homeOnly.logs.filter((row) => row.action === 'assumption-adj').length, 1);

  const bare = applyGameDayAdjustments({
    sport: 'NFL', modelMargin: 2.5, modelTotal: 44, uncertainty: 0.13,
    home: 'Buffalo Bills', away: 'Miami Dolphins',
  });
  const explicitEmpty = applyGameDayAdjustments({
    sport: 'NFL', modelMargin: 2.5, modelTotal: 44, uncertainty: 0.13,
    home: 'Buffalo Bills', away: 'Miami Dolphins',
    last5ByTeam: null, personnelByTeam: null,
  });
  assert.strictEqual(bare.modelMargin, explicitEmpty.modelMargin);

  assert.strictEqual(shrinkLast5IntoRating(3, null, null).applied, false);
  assert.strictEqual(shrinkLast5IntoRating(3, null, null).margin, 3);
  const moved = shrinkLast5IntoRating(0, { n: 5, meanMargin: 20 }, { n: 5, meanMargin: -20 });
  assert.strictEqual(moved.applied, true);
  assert.ok(Math.abs(moved.delta) <= LAST5_CAP + 1e-9);
  assert.strictEqual(LAST5_K, 8);
  const buf = String(resolveTeamId('NFL', 'Buffalo Bills'));
  const mia = String(resolveTeamId('NFL', 'Miami Dolphins'));
  assert.ok(buf && buf !== 'null');
  const withForm = applyGameDayAdjustments({
    sport: 'NFL', modelMargin: 2.5, modelTotal: 44, uncertainty: 0.13,
    home: 'Buffalo Bills', away: 'Miami Dolphins',
    commenceTime: '2026-10-11T17:00:00Z',
    last5ByTeam: {
      NFL: {
        [buf]: [
          { teamId: buf, margin: 14, commence: '2026-10-04T17:00:00Z' },
          { teamId: buf, margin: 10, commence: '2026-09-27T17:00:00Z' },
        ],
        [mia]: [
          { teamId: mia, margin: -7, commence: '2026-10-04T17:00:00Z' },
          { teamId: mia, margin: -3, commence: '2026-09-27T17:00:00Z' },
        ],
      },
    },
  });
  assert.ok(withForm.modelMargin > bare.modelMargin);
  assert.ok(withForm.gameDay.last5);
  const looked = lookupLast5('NFL', 'Buffalo Bills', withForm && {
    NFL: { [buf]: [{ teamId: buf, margin: 14, commence: '2026-10-04T17:00:00Z' }] },
  }, '2026-10-11T17:00:00Z');
  assert.strictEqual(looked.n, 1);

  assert.strictEqual(roofClosed({ roof: 'dome' }), true);
  assert.strictEqual(roofClosed({ roof: 'retractable', knownOpen: false }), true);
  const wind = footballWeatherAdjustment({ sport: 'NFL', roof: 'open', windMph: 20, precipProb: 10, tempF: 60 });
  assert.ok(wind.totalAdj < 0);

  const stub = await fetchXNews({ env: {}, dateISO: CARD });
  assert.strictEqual(stub.mode, 'stub');
  assert.strictEqual(stub.count, 0);
  assert.strictEqual(tokenFrom({}), '');
  let sawAuth = false;
  const live = await fetchXNews({
    env: { X_BEARER_TOKEN: 'super-secret-token' },
    dateISO: CARD,
    fetchImpl: async (url, opts) => {
      sawAuth = opts.headers.Authorization === 'Bearer super-secret-token';
      assert.ok(!String(url).includes('super-secret-token'));
      return { ok: true, json: async () => ({ data: [{ id: '9', text: 'starter inactive' }] }) };
    },
  });
  assert.strictEqual(sawAuth, true);
  assert.strictEqual(live.mode, 'live');
  assert.strictEqual(live.count, 1);
  assert.strictEqual(live.logs[0].action, 'logged-unquantified');
  assert.ok(!JSON.stringify(live).includes('super-secret-token'));
}

// ── 5. NFL key numbers, NCAAF FBS/priors, NHL both goalie scenarios ──
{
  assert.ok(NFL_KEY_NUMBERS[3] > 0);
  assert.ok(NFL_KEY_NUMBERS[7] > 0);
  assert.strictEqual(typeof solveNcaafOpponentRatings, 'function');
  assert.strictEqual(typeof isFbsTeamId, 'function');

  const known = nhl.applyNhlEngineSoft({
    modelMargin: 0.15, modelTotal: 6.2, usedStandings: true, homeGoals: 3.1, awayGoals: 3.1,
    espnGame: {
      homeGoalie: { savePct: 0.920, name: 'Home' },
      awayGoalie: { savePct: 0.900, name: 'Away' },
    },
  });
  assert.ok(known.goalie);
  const unconfirmed = nhl.applyNhlEngineSoft({
    modelMargin: 0.15, modelTotal: 6.2, usedStandings: true, homeGoals: 3.1, awayGoals: 3.1,
    espnGame: {
      homeGoalie: { savePct: 0.920, confirmed: false, name: 'Home' },
      awayGoalie: { savePct: 0.900, confirmed: true, name: 'Away' },
    },
  });
  assert.ok(unconfirmed.goalie, 'unconfirmed starter with a save rate is still priced');
  const direct = nhl.priceUnconfirmedGoalies(
    { savePct: 0.920, confirmed: false },
    { savePct: 0.900, confirmed: true },
    {},
  );
  assert.ok(direct.scenarios >= 2);
  assert.strictEqual(direct.unconfirmed, true);
  const missing = nhl.priceUnconfirmedGoalies({ confirmed: false }, { confirmed: false }, {});
  assert.strictEqual(missing.used, false);
  assert.strictEqual(nhl.UNCONFIRMED_BACKUP_SAVE_HAIRCUT, 0.010);
}

// ── 6. EV rank, 3% floor, edge floor, one bet, one straight per game, top 10 ──
{
  const need = minEdgeFor(300, 0.1);
  assert.ok(need > 0.03);
  const longshot = base({
    sport: 'MLB', market: 'Moneyline', side: 'A ML', odds: 300,
    edgePct: 0.02, ev: 0.05, coverProb: 0.30, uncertainty: 0.1,
  });
  assert.strictEqual(gateReason(longshot, { cardDate: CARD }), 'edge-floor');
  const underEv = base({ ev: 0.02, edgePct: 0.04, coverProb: 0.53 });
  assert.strictEqual(gateReason(underEv, { cardDate: CARD }), 'ev-floor');

  const lowEvHighEdge = base({ matchup: 'A @ B', side: 'B -3', ev: 0.04, edgePct: 0.08, line: -3 });
  const highEvLowEdge = base({ matchup: 'C @ D', side: 'D +3', ev: 0.09, edgePct: 0.03, line: 3, homeTeam: 'D', awayTeam: 'C' });
  const dup = base({ matchup: 'C @ D', side: 'D +3', ev: 0.07, edgePct: 0.05, line: 3, homeTeam: 'D', awayTeam: 'C' });
  const ranked = selectTop10([lowEvHighEdge, highEvLowEdge, dup], 10);
  assert.strictEqual(ranked[0].side, 'D +3');
  assert.strictEqual(ranked[0].ev, 0.09);
  assert.strictEqual(ranked.filter((c) => c.side === 'D +3').length, 1);
  const rows = top10Rows([lowEvHighEdge, highEvLowEdge], 10);
  assert.strictEqual(rows[0].game, 'C @ D');
  assert.strictEqual(rows[0].dkPrice, -110);
  assert.ok('hrFlags' in rows[0]);

  const same = [
    base({ matchup: 'A @ B', edgePct: 0.08, side: 'B -3' }),
    base({ matchup: 'A @ B', edgePct: 0.07, side: 'Over 44', market: 'Total', line: 44 }),
    base({ matchup: 'C @ D', edgePct: 0.05, side: 'D +3', homeTeam: 'D', awayTeam: 'C' }),
  ];
  const straights = selectStraights(same, 3);
  assert.strictEqual(straights.length, 2);
  assert.strictEqual(new Set(straights.map((c) => c.matchup)).size, 2);
}

// ── 7 and 8. Before 11:15, live, slate through 6:00 ET next day, verify recheck ──
{
  const bounds = slateBounds(CARD);
  assert.strictEqual(slateReason({ commenceTime: bounds.start }, CARD), null);
  assert.ok(inSlate(bounds.start, CARD));
  const early = etLocalToUtcISO(CARD, 11, 14);
  assert.strictEqual(slateReason({ commenceTime: early }, CARD), 'starts-before-1115-et');
  assert.strictEqual(
    gateReason(base({ commenceTime: early }), { cardDate: CARD, asOfMs: Date.parse(etLocalToUtcISO(CARD, 10, 30)) }),
    'starts-before-1115-et',
  );
  const overnight = etLocalToUtcISO('2026-10-12', 5, 59);
  assert.strictEqual(slateReason({ commenceTime: overnight }, CARD), null);
  const six = etLocalToUtcISO('2026-10-12', 6, 0);
  assert.strictEqual(slateReason({ commenceTime: six }, CARD), 'future-date');
  assert.strictEqual(slateReason({ commenceTime: '2026-10-10T20:00:00Z' }, CARD), 'not-same-et-day');
  assert.strictEqual(gateReason(base({ inPlay: true }), { cardDate: CARD }), 'live-in-play');
  assert.strictEqual(gateReason(base({ priceState: 'in-play' }), { cardDate: CARD }), 'live-in-play');

  const kick = sampleInSlateKick(Date.parse('2026-10-11T03:00:00Z'));
  assert.ok(inSlate(kick, require(path.join(root, 'odds_math')).etCalendarDate(kick)));

  const now = Date.parse('2026-10-11T18:00:00Z');
  const started = base({
    pick: 'B -3', matchup: 'A @ B', commenceTime: '2026-10-11T16:00:00Z', book: 'draftkings',
  });
  const filler = {
    sport: 'NFL', matchup: 'E @ F', side: 'F +3', market: 'Spread', line: 3,
    odds: -110, coverProb: 0.56, edge: 0.04, ev: 0.05, uncertainty: 0.12,
    commenceTime: '2026-10-11T23:00:00Z', homeTeam: 'F', awayTeam: 'E', book: 'draftkings',
  };
  const blocked = {
    ...filler, matchup: 'G @ H', side: 'H +3', book: 'bovada', homeTeam: 'H', awayTeam: 'G',
  };
  const card = {
    date: CARD,
    picks: [started],
    parlayLegs: [{ legs: [started] }],
    candidateTable: [blocked, filler],
  };
  assert.strictEqual(verifyStartReason(started, now, CARD), 'live-in-play');
  assert.strictEqual(verifyStartReason({ pick: 'no time' }, now, CARD), null);
  const checked = verifySchedule(card, now);
  assert.strictEqual(checked.changed, true);
  assert.strictEqual(checked.picks.length, 1);
  assert.strictEqual(checked.picks[0].matchup, 'E @ F');
  assert.ok(!checked.picks.some((p) => p.matchup === 'G @ H'));
  assert.strictEqual(card.parlayLegs[0].legs.length, 0);
}

// ── 9. Unquantifiable cluster is an exclusion, not a bigger number ──
{
  const outs = [1, 2, 3, 4, 5].map((i) => ({ name: `WR${i}`, position: 'WR', status: 'out' }));
  const cluster = conservativeNonQbAdj(outs, []);
  assert.strictEqual(cluster.exclude, true);
  assert.ok(cluster.marginAdj >= -NON_QB_ASSUMPTION.cap - 1e-9);
  assert.strictEqual(gateReason(base({ personnelExclude: true }), { cardDate: CARD }), 'unquantified-injury-cluster');
  const q = conservativeNonQbAdj([{ name: 'Slot', position: 'WR', status: 'questionable' }], []);
  assert.ok(Math.abs(q.marginAdj + NON_QB_ASSUMPTION.outPoints * NON_QB_ASSUMPTION.questionableWeight) < 1e-6);
  assert.strictEqual(q.exclude, false);
}

// ── OMEGA_REPLAY_NO_WRITE blocks store and blob writers. No network. ──
{
  const prev = process.env.OMEGA_REPLAY_NO_WRITE;
  process.env.OMEGA_REPLAY_NO_WRITE = '1';
  const store = require(path.join(root, 'store'));
  const linePath = require(path.join(root, 'line_path'));
  const closes = require(path.join(root, 'candidate_closes_v2'));
  const clv = require(path.join(root, 'clv_candidates'));
  const { replayNoWrite } = require(path.join(root, 'no_write'));
  assert.strictEqual(replayNoWrite(), true);
  assert.strictEqual(await store.storeJson('picks-2026-10-11', { picks: [{ pick: 'nope' }] }), false);
  assert.strictEqual(await store.storePicks('2026-10-11', { picks: [] }), false);
  assert.strictEqual(await linePath.writeJsonBlob('omega-line-snap-2026-10-11-1030', { games: {} }), false);
  const blob = await closes.writeBlob('omega-candidate-closes-2026-10-11', { rows: [1] }, {
    writeJson: () => { throw new Error('writeJson must not run'); },
  });
  assert.strictEqual(blob.noWrite, true);
  const cand = await clv.writeCandidateBlob('omega-clv-candidates-2026-10-11', { sides: [] }, {
    store: { setJSON: () => { throw new Error('setJSON must not run'); } },
  });
  assert.strictEqual(cand.noWrite, true);
  process.env.OMEGA_REPLAY_NO_WRITE = 'yes';
  assert.strictEqual(replayNoWrite(), true);
  process.env.OMEGA_REPLAY_NO_WRITE = 'on';
  assert.strictEqual(replayNoWrite(), true);
  if (prev == null) delete process.env.OMEGA_REPLAY_NO_WRITE;
  else process.env.OMEGA_REPLAY_NO_WRITE = prev;
  assert.strictEqual(replayNoWrite(), false);
}

console.log('test-omega-selection-pass: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
