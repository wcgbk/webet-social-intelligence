'use strict';
// 2026-10-11 card defects: floor-only straights, top-10 bet rows, QB-out
// totals, long-term IR, X token at runtime, capture warning, London one-off,
// and the pre-10:30 odds snapshot. No network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const { passesPublishFloor, straightCardLabel, selectStraights } = require(path.join(root, 'select'));
const { selectTop10, oneOffBypassesEarlyWindow, slateReason } = require(path.join(root, 'selection_pass'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { gateReason } = require(path.join(root, 'gates'));
const { conservativeNonQbAdj, isLongTermRosterStatus } = require(path.join(root, 'personnel'));
const gd = require(path.join(root, 'sports/game_day'));
const { priceLockTimestamp, resolveGenerateOddsSnapshot, etLocalToUtcISO } = require(path.join(root, 'price_lock'));
const { assessCaptureHealth, warnCaptureHealth } = require(path.join(root, 'line_path'));
const { fetchXNews, tokenFrom } = require(path.join(root, 'x_news'));
const { filterEventsSameEtDay, fetchOddsMultiSport } = require(path.join(root, 'ingest'));

const CARD = '2026-10-11';
const KICK = '2026-10-11T20:00:00Z';
const EARLY = Date.parse(etLocalToUtcISO(CARD, 8, 30));
const LOCK = Date.parse(priceLockTimestamp(CARD));
const LONDON_KICK = etLocalToUtcISO(CARD, 9, 30);

function row(extra) {
  return {
    sport: 'NFL',
    matchup: 'Minnesota Vikings @ New Orleans Saints',
    side: 'Minnesota Vikings -2.5',
    market: 'Spread',
    line: -2.5,
    odds: -105,
    coverProb: 0.56,
    ev: 0.05,
    edgePct: 0.04,
    uncertainty: 0.12,
    liquid: true,
    commenceTime: KICK,
    homeTeam: 'New Orleans Saints',
    awayTeam: 'Minnesota Vikings',
    book: 'draftkings',
    ...extra,
  };
}

(async () => {
  // A. Straights and parlay legs are the 3% floor and minEdgeFor only.
  const floor = row({ side: 'Over 43.5', market: 'Total', line: 43.5, ev: 0.063, edgePct: 0.046 });
  const minLean = row({
    side: 'Minnesota Vikings -2.5', ev: 0.025, edgePct: 0.037, odds: -105,
  });
  const kraken = row({
    sport: 'NHL',
    matchup: 'Seattle Kraken @ Washington Capitals',
    side: 'Seattle Kraken ML',
    market: 'Moneyline',
    line: null,
    odds: 180,
    ev: 0.025,
    edgePct: 0.017,
    coverProb: 0.37,
    homeTeam: 'Washington Capitals',
    awayTeam: 'Seattle Kraken',
  });
  assert.strictEqual(passesPublishFloor(floor), true);
  assert.strictEqual(passesPublishFloor(minLean), false);
  assert.strictEqual(passesPublishFloor(kraken), false);
  const published = selectStraights([floor, minLean, kraken], 3, [minLean, kraken]);
  assert.deepStrictEqual(published.map(c => c.side), ['Over 43.5']);
  assert.ok(published.every(c => c.tier === 'floor'));
  assert.strictEqual(straightCardLabel(published.length), 'short card: 1 floor straight');
  assert.strictEqual(straightCardLabel(2), 'short card: 2 floor straights');
  assert.strictEqual(straightCardLabel(3), '3 floor straights');
  assert.strictEqual(straightCardLabel(0), 'no floor plays');
  const parlay = optimizeParlay([floor, minLean, kraken, row({
    matchup: 'C @ D', side: 'D +3', ev: 0.04, edgePct: 0.03, homeTeam: 'D', awayTeam: 'C',
  })], published, { cardDate: CARD });
  assert.strictEqual(parlay.length, 1);
  assert.ok(parlay[0].legs.every(l => parseFloat(l.ev) >= 3));
  assert.ok(!parlay[0].legs.some(l => /Vikings -2\.5|Kraken/.test(l.pick)));

  // B. Top 10 is one bet, ranked by EV. One-per-game is straights only.
  const over = row({
    matchup: 'Baltimore Ravens @ Atlanta Falcons',
    side: 'Over 43.5', market: 'Total', line: 43.5, ev: 0.0625, edgePct: 0.045,
    homeTeam: 'Atlanta Falcons', awayTeam: 'Baltimore Ravens',
  });
  const spread = row({
    matchup: 'Baltimore Ravens @ Atlanta Falcons',
    side: 'Baltimore Ravens +3', market: 'Spread', line: 3, ev: 0.036, edgePct: 0.032,
    homeTeam: 'Atlanta Falcons', awayTeam: 'Baltimore Ravens',
  });
  const other = row({
    matchup: 'C @ D', side: 'D +3', ev: 0.05, edgePct: 0.02, homeTeam: 'D', awayTeam: 'C',
  });
  // Same bet at a lower EV is one candidate, not a second top-10 row. Same game, different bet stays.
  const top = selectTop10([spread, over, other, { ...over, ev: 0.01 }], 10);
  assert.deepStrictEqual(top.map(c => c.side), ['Over 43.5', 'D +3', 'Baltimore Ravens +3']);
  assert.strictEqual(top.filter(c => c.matchup.includes('Baltimore')).length, 2);
  assert.ok(top.filter(c => c.side === 'Over 43.5').every(c => c.ev === 0.0625));
  const straightGames = selectStraights([over, spread, other], 3);
  assert.strictEqual(new Set(straightGames.map(c => c.matchup)).size, straightGames.length);
  assert.ok(!straightGames.some(c => c.side === 'Baltimore Ravens +3'));

  // C. QB out moves the total, and a fresh Out excludes totals.
  const qbOut = gd.applyGameDayAdjustments({
    sport: 'NFL',
    modelMargin: 0,
    modelTotal: 52.28,
    uncertainty: 0.18,
    home: 'Atlanta Falcons',
    away: 'Baltimore Ravens',
    restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'out', qbName: 'Lamar Jackson' } },
  });
  assert.ok(qbOut.modelTotal < 52.28, `total moved: ${qbOut.modelTotal}`);
  assert.ok(Math.abs((qbOut.gameDay.qbTotalAdj || 0) + 1.5) < 1e-9, qbOut.gameDay.qbTotalAdj);
  assert.strictEqual(qbOut.startingQbOut, true);
  const doubtful = gd.applyGameDayAdjustments({
    sport: 'NFL', modelMargin: 0, modelTotal: 45, uncertainty: 0.13,
    home: 'Atlanta Falcons', away: 'Baltimore Ravens', restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'doubtful', qbName: 'Lamar Jackson' } },
  });
  assert.strictEqual(doubtful.startingQbOut, false);
  assert.ok(doubtful.modelTotal < 45);
  const irQb = gd.applyGameDayAdjustments({
    sport: 'NFL', modelMargin: 0, modelTotal: 45, uncertainty: 0.13,
    home: 'Atlanta Falcons', away: 'Baltimore Ravens', restByTeam: {},
    qbByTeam: { 'Baltimore Ravens': { qbStatus: 'injured reserve', qbName: 'Lamar Jackson' } },
  });
  assert.strictEqual(irQb.startingQbOut, false);
  const totalGate = gateReason(row({
    market: 'Total', side: 'Over 43.5', line: 43.5, startingQbOut: true,
    homeTeam: 'Atlanta Falcons', awayTeam: 'Baltimore Ravens',
    matchup: 'Baltimore Ravens @ Atlanta Falcons',
  }), { cardDate: CARD, asOfMs: EARLY });
  assert.strictEqual(totalGate, 'starting-qb-out');
  const spreadGate = gateReason(row({
    market: 'Spread', side: 'Baltimore Ravens +3', line: 3, startingQbOut: true,
    homeTeam: 'Atlanta Falcons', awayTeam: 'Baltimore Ravens',
    matchup: 'Baltimore Ravens @ Atlanta Falcons',
  }), { cardDate: CARD, asOfMs: EARLY });
  assert.strictEqual(spreadGate, null);

  // D. IR / PUP / season-ending are not outs. CIN@MIA cluster re-check.
  assert.strictEqual(isLongTermRosterStatus('injured reserve'), true);
  assert.strictEqual(isLongTermRosterStatus('pup'), true);
  assert.strictEqual(isLongTermRosterStatus('season-ending'), true);
  assert.strictEqual(isLongTermRosterStatus('out'), false);
  const miami = [
    { name: 'Storm Duck', position: 'CB', status: 'out' },
    { name: 'Robert Beal Jr.', position: 'DE', status: 'out' },
    { name: 'Justin Joly', position: 'TE', status: 'out' },
    { name: 'Caleb Douglas', position: 'WR', status: 'out' },
    { name: 'Jalen Davis', position: 'CB', status: 'injured reserve' },
  ];
  const cin = [
    { name: 'Reese Taylor', position: 'CB', status: 'out' },
    { name: 'Kyle Dugger', position: 'S', status: 'out' },
  ];
  const cinMia = conservativeNonQbAdj(miami, cin);
  assert.strictEqual(cinMia.homeOuts, 4);
  assert.strictEqual(cinMia.awayOuts, 2);
  assert.strictEqual(cinMia.exclude, false);
  const davis = cinMia.logs.find(r => r.name === 'Jalen Davis');
  assert.strictEqual(davis.action, 'logged-priced-in');
  assert.strictEqual(davis.points, 0);
  const stillCluster = conservativeNonQbAdj(miami.map(p => (
    p.name === 'Jalen Davis' ? { ...p, status: 'out' } : p
  )), cin);
  assert.strictEqual(stillCluster.homeOuts, 5);
  assert.strictEqual(stillCluster.exclude, true);
  const pup = conservativeNonQbAdj([{ name: 'PUP WR', position: 'WR', status: 'PUP' }], []);
  assert.strictEqual(pup.homeOuts, 0);
  assert.strictEqual(pup.exclude, false);
  const inactive = conservativeNonQbAdj([{ name: 'Scratch', position: 'WR', status: 'inactive' }], []);
  assert.strictEqual(inactive.homeOuts, 1);

  // E. Token is read at call time. The return value does not contain it.
  const prevX = process.env.X_BEARER_TOKEN;
  const prevT = process.env.TWITTER_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  delete process.env.TWITTER_BEARER_TOKEN;
  assert.strictEqual(tokenFrom(), '');
  assert.strictEqual(tokenFrom({}), '');
  const secret = 'runtime-token-should-not-print';
  process.env.X_BEARER_TOKEN = secret;
  assert.strictEqual(tokenFrom(), secret);
  assert.strictEqual(tokenFrom({}), '');
  const calls = [];
  const live = await fetchXNews({
    dateISO: CARD,
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init && init.headers && init.headers.Authorization });
      return { ok: true, json: async () => ({ data: [{ id: '1', text: 'questionable' }] }) };
    },
  });
  assert.strictEqual(live.mode, 'live');
  assert.strictEqual(live.count, 1);
  assert.ok(!JSON.stringify(live).includes(secret));
  assert.ok(calls[0].auth === `Bearer ${secret}`);
  delete process.env.X_BEARER_TOKEN;
  process.env.TWITTER_BEARER_TOKEN = secret;
  assert.strictEqual(tokenFrom(), secret);
  const stub = await fetchXNews({ env: {}, dateISO: CARD, fetchImpl: () => { throw new Error('no fetch'); } });
  assert.strictEqual(stub.mode, 'stub');
  if (prevX == null) delete process.env.X_BEARER_TOKEN;
  else process.env.X_BEARER_TOKEN = prevX;
  if (prevT == null) delete process.env.TWITTER_BEARER_TOKEN;
  else process.env.TWITTER_BEARER_TOKEN = prevT;

  // F. Missing capture slots warn. They do not hard-fail the publish.
  const empty = assessCaptureHealth(CARD, { path: { polls: [] } }, { retriedCapture: true, retryOk: false });
  assert.strictEqual(empty.hardFail, true);
  const warned = warnCaptureHealth(empty, CARD);
  assert.strictEqual(warned.hardFail, false);
  assert.ok(warned.warning);
  assert.strictEqual(warned.reason, null);
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('warnCaptureHealth(captureHealth, dateISO)'));
  assert.ok(indexSrc.includes("code: 'CAPTURE_HEALTH'"));
  assert.ok(!indexSrc.includes("err.code = 'CAPTURE_HEALTH'"));
  assert.ok(!/throw err;\s*$/m.test(indexSrc.slice(indexSrc.indexOf('captureHealthWarning'), indexSrc.indexOf('Kalshi/Polymarket'))));

  // G. London Eagles @ Jaguars, 2026-10-11, early run only.
  assert.strictEqual(LONDON_KICK, '2026-10-11T13:30:00Z');
  const london = {
    id: 'london-phi-jax',
    home_team: 'Jacksonville Jaguars',
    away_team: 'Philadelphia Eagles',
    commence_time: LONDON_KICK,
    homeTeam: 'Jacksonville Jaguars',
    awayTeam: 'Philadelphia Eagles',
    matchup: 'Philadelphia Eagles @ Jacksonville Jaguars',
  };
  const londonCand = row({
    ...london,
    sport: 'NFL',
    market: 'Spread',
    side: 'Jacksonville Jaguars +3',
    line: 3,
    commenceTime: LONDON_KICK,
  });
  const earlyOpts = { cardDate: CARD, includeEarly: 'Eagles', nowMs: EARLY, asOfMs: EARLY };
  assert.strictEqual(gateReason(londonCand, earlyOpts), null);
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, { includeEarly: 'Jaguars', nowMs: EARLY }), true);
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, { includeEarly: 'london-phi-jax', nowMs: EARLY }), true);
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, { nowMs: EARLY }), false);
  assert.strictEqual(gateReason(londonCand, { cardDate: CARD, nowMs: EARLY, asOfMs: EARLY }), 'starts-before-1115-et');
  // 10:30 ET is after the 9:30 kick, so the started block wins. The one-off is also off at the lock.
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, {
    includeEarly: 'Eagles', nowMs: LOCK, oddsSnapshot: priceLockTimestamp(CARD),
  }), false);
  assert.strictEqual(gateReason(londonCand, {
    cardDate: CARD, includeEarly: 'Eagles', nowMs: LOCK, asOfMs: LOCK,
    oddsSnapshot: priceLockTimestamp(CARD),
  }), 'in-progress-or-started');
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, {
    includeEarly: 'Eagles', nowMs: EARLY, oddsSnapshot: priceLockTimestamp(CARD),
  }), false);
  const afterKick = Date.parse('2026-10-11T13:40:00Z');
  assert.strictEqual(gateReason(londonCand, {
    cardDate: CARD, includeEarly: 'Eagles', nowMs: afterKick, asOfMs: afterKick,
  }), 'in-progress-or-started');
  assert.strictEqual(gateReason({ ...londonCand, inPlay: true }, earlyOpts), 'live-in-play');
  const otherEarly = row({
    matchup: 'Miami Dolphins @ Buffalo Bills',
    homeTeam: 'Buffalo Bills',
    awayTeam: 'Miami Dolphins',
    commenceTime: etLocalToUtcISO(CARD, 9, 0),
    side: 'Buffalo Bills -3',
  });
  assert.strictEqual(gateReason(otherEarly, earlyOpts), 'starts-before-1115-et');
  assert.strictEqual(slateReason(londonCand, '2026-10-12', earlyOpts), 'not-same-et-day');
  const kept = filterEventsSameEtDay([
    london,
    { id: 'mia-buf', home_team: 'Buffalo Bills', away_team: 'Miami Dolphins', commence_time: etLocalToUtcISO(CARD, 9, 0) },
    { id: 'noon', home_team: 'Green Bay Packers', away_team: 'Chicago Bears', commence_time: KICK },
  ], CARD, { includeEarly: 'Philadelphia Eagles', nowMs: EARLY });
  assert.deepStrictEqual(kept.map(e => e.id).sort(), ['london-phi-jax', 'noon']);
  const prevFlag = process.env.OMEGA_ONEOFF_INCLUDE_EVENT;
  process.env.OMEGA_ONEOFF_INCLUDE_EVENT = 'Jacksonville Jaguars';
  assert.strictEqual(oneOffBypassesEarlyWindow(london, CARD, { nowMs: EARLY }), true);
  if (prevFlag == null) delete process.env.OMEGA_ONEOFF_INCLUDE_EVENT;
  else process.env.OMEGA_ONEOFF_INCLUDE_EVENT = prevFlag;

  // H. Before 10:30 ET the snapshot is live. The final run uses 10:30.
  assert.strictEqual(resolveGenerateOddsSnapshot(CARD, { nowMs: Date.parse('2026-10-11T08:45:00Z') }), null);
  assert.strictEqual(resolveGenerateOddsSnapshot(CARD, { nowMs: EARLY }), null);
  assert.strictEqual(resolveGenerateOddsSnapshot(CARD, { nowMs: LOCK }), priceLockTimestamp(CARD));
  assert.strictEqual(resolveGenerateOddsSnapshot(CARD, { nowMs: LOCK + 60 * 60 * 1000 }), priceLockTimestamp(CARD));
  assert.strictEqual(
    resolveGenerateOddsSnapshot(CARD, { nowMs: EARLY, historicalSnapshot: '2026-10-11T12:00:00Z' }),
    '2026-10-11T12:00:00Z',
  );
  assert.ok(indexSrc.includes('odds snapshot requested='));
  assert.ok(indexSrc.includes('served=${servedSnapshot'));
  const prevFetch = global.fetch;
  const prevKey = process.env.ODDS_API_KEY;
  const urls = [];
  process.env.ODDS_API_KEY = 'test-key';
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const board = await fetchOddsMultiSport(CARD, {});
    assert.ok(board.oddsSnapshotTimestamp);
    assert.notStrictEqual(board.oddsSnapshotTimestamp, priceLockTimestamp(CARD));
    assert.ok(!urls.some(u => u.includes('/historical/')), urls.join('\n'));
  } finally {
    global.fetch = prevFetch;
    if (prevKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = prevKey;
  }

  console.log('PASS test-omega-1011-card');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
