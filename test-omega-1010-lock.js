'use strict';
// v12.3.24 spec: 10:30 ET price lock, Hard Rock review flag, 3% EV floor.
// A short floor card fills from the lean pool. The 10/10 morning still
// clears 3 floor straights, so leans do not replace them. +EV parlay with a
// 45% cover on each leg. Replays the 2026-10-10 morning snapshot. No network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const { priceLockTimestamp, resolveGenerateOddsSnapshot } = require(path.join(root, 'price_lock'));
const { EDGE_FLOOR, MAIN_EDGE_FLOOR, minEdgeFor } = require(path.join(root, 'edge_floor'));
const { gateReason, applyGates, minEdgeFor: gateMinEdge } = require(path.join(root, 'gates'));
const { selectStraights, toPickObject } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { fetchOddsMultiSport } = require(path.join(root, 'ingest'));
const { autoCorrectHardRock } = require(path.join(root, 'hr_autocorrect'));
const { requiredFloor } = require(path.join(root, 'shortfall'));
const { americanToImplied } = require(path.join(root, 'odds_math'));

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.0002, `${label}: ${actual} vs ${expected}`);
}

function curve(american, uncertainty) {
  const anchor = americanToImplied(-110);
  const implied = americanToImplied(american);
  let floor = 0.0175 + 0.05 * Math.max(0, anchor - implied);
  if (Number.isFinite(uncertainty)) floor += 0.04 * Math.max(0, uncertainty - 0.15);
  floor = Math.min(0.06, floor);
  if (floor < MAIN_EDGE_FLOOR) floor = MAIN_EDGE_FLOOR;
  return +floor.toFixed(6);
}

// ── Price lock clock ──
assert.strictEqual(priceLockTimestamp('2026-10-10'), '2026-10-10T14:00:00Z');
assert.strictEqual(priceLockTimestamp('2026-11-08'), '2026-11-08T15:00:00Z');
assert.strictEqual(
  resolveGenerateOddsSnapshot('2026-10-10', { nowMs: Date.parse('2026-10-10T16:00:00Z') }),
  '2026-10-10T14:00:00Z',
);
assert.strictEqual(
  resolveGenerateOddsSnapshot('2026-10-10', { historicalSnapshot: '2026-10-10T13:00:00Z' }),
  '2026-10-10T13:00:00Z',
);
assert.strictEqual(resolveGenerateOddsSnapshot('', {}), null);
assert.strictEqual(EDGE_FLOOR.atMinus110, 0.0175);
assert.strictEqual(MAIN_EDGE_FLOOR, 0.03);
assert.strictEqual(EDGE_FLOOR.max, 0.06);
near(minEdgeFor(-110, 0.15), 0.03, '-110 hard floor');
near(minEdgeFor(-110, 0.17), 0.03, '-110 unc 0.17');
near(minEdgeFor(-110, 0.30), 0.03, '-110 unc 0.30');
near(minEdgeFor(150, 0.15), 0.03, '+150');
near(minEdgeFor(200, 0.15), 0.03, '+200');
near(minEdgeFor(300, 0.15), curve(300, 0.15), '+300');
assert.ok(minEdgeFor(300, 0.15) > 0.03, '+300 curve stays above the hard floor');
near(minEdgeFor(-150, 0.15), 0.03, 'favorite stays at the hard floor');
near(minEdgeFor(-110, undefined), 0.03, 'missing uncertainty');
assert.ok(minEdgeFor(400, 0.9) <= 0.06);
assert.strictEqual(gateMinEdge(-110, 0.15), minEdgeFor(-110, 0.15));
near(requiredFloor({ odds: -110, uncertainty: 0.15 }, 'edge-floor'), 0.03, 'shortfall');

// ── Odds-scaled gate. No flat cover floor. ──
const asOf = { cardDate: '2026-10-11', asOfMs: Date.parse('2026-10-11T13:30:00Z') };
function side(extra) {
  return {
    sport: 'NCAAF', matchup: 'A @ B', side: 'B +3', market: 'Spread', line: 3,
    odds: -110, coverProb: 0.55, ev: 0.04, edgePct: 0.02, liquid: true,
    uncertainty: 0.15, commenceTime: '2026-10-11T20:00:00Z',
    homeTeam: 'B', awayTeam: 'A',
    ...extra,
  };
}
assert.strictEqual(gateReason(side({ edgePct: 0.01 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.02 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.029, ev: 0.05 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: minEdgeFor(-110, 0.15) }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 200, edgePct: 0.02, coverProb: 0.40, ev: 0.05 }), asOf), null);
assert.strictEqual(gateReason(side({ odds: 200, edgePct: 0.03, coverProb: 0.40, ev: 0.05 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.02, uncertainty: 0.30 }), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0.03, uncertainty: 0.30 }), asOf), null);
assert.strictEqual(gateReason(side({
  odds: 200, coverProb: 0.30, edgePct: 0.04, ev: 0.05, side: 'B ML', market: 'Moneyline', line: null,
}), asOf), null);
assert.strictEqual(gateReason(side({ edgePct: 0, ev: 0.04 }), asOf), null);
assert.strictEqual(gateReason(side({ ev: -0.01, edgePct: 0.04 }), asOf), 'ev-floor');
{
  const missing = side();
  delete missing.edgePct;
  assert.notStrictEqual(gateReason(missing, asOf), 'edge-floor');
}
assert.strictEqual(config.GATES.minCoverProb.NCAAF, 0);
assert.strictEqual(config.GATES.minCoverProb.default, 0);
assert.strictEqual(config.GATES.minEV.NFL, 0.02);
assert.strictEqual(config.GATES.minEV.NCAAF, 0.02);
assert.strictEqual(config.GATES.maxEV, 0.12);
assert.strictEqual(config.GATES.minAmericanOdds, -250);
assert.strictEqual(config.GATES.maxAmericanOdds, 250);
assert.strictEqual(config.LEAN_MIN_EV, 0.015);
assert.strictEqual(config.LEAN_MAX_UNITS, 0.5);
assert.strictEqual(config.PARLAY_MIN_COVER, 0.45);

const mixed = applyGates([
  side({ edgePct: 0.01, side: 'Thin +3', matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C' }),
  side({ edgePct: 0.04, side: 'Fat +3', matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E' }),
], asOf);
assert.strictEqual(mixed.yesPool.length, 2);
assert.ok(mixed.yesPool.some((c) => c.side === 'Fat +3'));
assert.ok(mixed.yesPool.some((c) => c.side === 'Thin +3'));
assert.strictEqual(mixed.leanPool.length, 0);
assert.strictEqual(mixed.rejected.length, 0);
{
  const mixedCard = selectStraights(mixed.yesPool, 3, mixed.leanPool);
  assert.strictEqual(mixedCard.length, 2);
  assert.ok(mixedCard.every((c) => c.tier === 'floor'));
}

const floorA = side({ edgePct: 0.05, ev: 0.06, side: 'Floor A' });
const floorB = side({ edgePct: 0.04, ev: 0.05, side: 'Floor B', matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C' });
const leanRow = side({
  edgePct: 0.0, ev: 0.019, coverProb: 0.534, side: 'Lean C',
  matchup: 'E @ F', homeTeam: 'F', awayTeam: 'E',
});
const leanGated = applyGates([leanRow], asOf);
assert.strictEqual(leanGated.yesPool.length, 0);
assert.strictEqual(leanGated.leanPool.length, 1);
assert.strictEqual(leanGated.leanPool[0].leanReason, 'ev-floor');
const filled = selectStraights([floorA, floorB], 3, [leanRow]);
assert.strictEqual(filled.length, 3);
assert.deepStrictEqual(filled.map(c => c.tier), ['floor', 'floor', 'lean']);
assert.strictEqual(filled[2].side, 'Lean C');
const leanPick = toPickObject({ ...leanRow, tier: 'lean' });
assert.strictEqual(leanPick.tier, 'lean');
assert.ok(parseFloat(leanPick.units) <= 0.5, leanPick.units);
assert.strictEqual(selectStraights([floorA], 3, []).length, 1);
const secondLean = side({
  edgePct: 0.0, ev: 0.018, coverProb: 0.53, side: 'Lean D',
  matchup: 'G @ H', homeTeam: 'H', awayTeam: 'G',
});
const leansOnly = selectStraights([], 3, [leanRow, secondLean]);
assert.strictEqual(leansOnly.length, 2);
assert.deepStrictEqual(leansOnly.map(c => c.side), ['Lean C', 'Lean D']);
assert.ok(leansOnly.every(c => c.tier === 'lean'));
const edgeLean = applyGates([side({ edgePct: 0.0, ev: 0.05 })], asOf);
assert.strictEqual(edgeLean.yesPool.length, 1);
assert.strictEqual(edgeLean.leanPool.length, 0);
const belowLean = applyGates([side({ edgePct: 0.02, ev: 0.01 })], asOf);
assert.strictEqual(belowLean.leanPool.length, 1);
assert.strictEqual(belowLean.leanPool[0].leanReason, 'ev-floor');
assert.strictEqual(belowLean.rejected.length, 0);

function leg(matchup, cover, ev, edge) {
  const [away, home] = matchup.split(' @ ');
  return {
    sport: 'NCAAF', matchup, side: `${home} -3`, market: 'Spread', line: -3,
    odds: -110, coverProb: cover, ev, edgePct: edge, liquid: true,
    commenceTime: '2026-10-11T20:00:00Z', homeTeam: home, awayTeam: away,
  };
}
assert.strictEqual(optimizeParlay([
  leg('A @ B', 0.40, 0.08, 0.05),
  leg('C @ D', 0.42, 0.07, 0.04),
  leg('E @ F', 0.44, 0.06, 0.03),
], [], { cardDate: '2026-10-11' }).length, 0);
const fallback = optimizeParlay([
  leg('A @ B', 0.55, 0.04, 0.05),
  leg('C @ D', 0.55, 0.04, 0.04),
  leg('E @ F', 0.46, 0.02, 0.02),
], [], { cardDate: '2026-10-11' });
assert.strictEqual(fallback.length, 1);
assert.strictEqual(fallback[0].legs.length, 2);
assert.ok(parseFloat(fallback[0].ev) > 0, fallback[0].ev);

// ── Generate wires the lock without flipping replayLike ──
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
assert.ok(indexSrc.includes('resolveGenerateOddsSnapshot(dateISO, { ...opts, nowMs })'));
assert.ok(indexSrc.includes('historicalSnapshot: allowPaidOdds ? oddsSnapshot : null'));
assert.ok(indexSrc.includes('storedBoardOnly: !allowPaidOdds'));
assert.ok(indexSrc.includes('const replayLike = !!(opts.historicalSnapshot || opts.replay)'));
assert.ok(indexSrc.includes('warnCaptureHealth(captureHealth, dateISO)'));
assert.ok(!indexSrc.includes("err.code = 'CAPTURE_HEALTH'"));
const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
assert.ok(verifySrc.includes('reviewHardRock(picksData, sportGames)'));
assert.ok(!verifySrc.includes('autoCorrectHardRock(picksData, sportGames)'));
assert.ok(verifySrc.includes('verifySchedule('));
assert.ok(verifySrc.includes('if (hrCheck.changed)'));

// ── Historical URL is the morning board. Live URL is the late board. ──
function board(totalPoint, spreadPoint) {
  return {
    id: `g-${totalPoint}-${spreadPoint}`,
    commence_time: '2026-10-10T19:30:00Z',
    home_team: 'Oklahoma Sooners',
    away_team: 'Texas Longhorns',
    bookmakers: [{
      key: 'draftkings',
      markets: [
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: totalPoint }, { name: 'Under', price: -110, point: totalPoint }] },
        { key: 'spreads', outcomes: [
          { name: 'Texas Longhorns', price: -110, point: spreadPoint },
          { name: 'Oklahoma Sooners', price: -110, point: -spreadPoint },
        ] },
      ],
    }],
  };
}
function jsonResp(body) {
  return { ok: true, status: 200, json: async () => body };
}
const priorFetch = global.fetch;
const priorKey = process.env.ODDS_API_KEY;
process.env.ODDS_API_KEY = 'test-key';
const seen = [];
global.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  if (u.includes('/events')) {
    return jsonResp([{ commence_time: '2026-10-10T19:30:00Z', home_team: 'Oklahoma Sooners', away_team: 'Texas Longhorns' }]);
  }
  if (u.includes('/historical/') && u.includes('date=2026-10-10T14%3A00%3A00Z')) {
    return jsonResp({ timestamp: '2026-10-10T14:00:00Z', data: [board(38.5, 8.5)] });
  }
  if (u.includes('/v4/sports/') && u.includes('/odds') && !u.includes('/historical/')) {
    return jsonResp([board(40.5, 9.5)]);
  }
  return jsonResp([]);
};
(async () => {
  try {
    const morning = await fetchOddsMultiSport('2026-10-10', { historicalSnapshot: priceLockTimestamp('2026-10-10') });
    const morningText = JSON.stringify(morning.bySport.NCAAF || []);
    assert.ok(morningText.includes('38.5'), 'morning board missing 38.5');
    assert.ok(morningText.includes('8.5'), 'morning board missing +8.5');
    assert.ok(!morningText.includes('40.5'), 'morning board included the late total');
    assert.strictEqual(morning.oddsSnapshotTimestamp, '2026-10-10T14:00:00Z');
    assert.ok(seen.some(u => u.includes('/historical/') && u.includes('date=2026-10-10T14%3A00%3A00Z')));
    const histCount = seen.length;
    const live = await fetchOddsMultiSport('2026-10-10');
    const liveText = JSON.stringify(live.bySport.NCAAF || []);
    assert.ok(liveText.includes('40.5'), 'live board missing 40.5');
    assert.ok(liveText.includes('9.5'), 'live board missing +9.5');
    assert.ok(!seen.slice(histCount).some(u => u.includes('/historical/')), 'live generate used the historical URL');

    // ── Hard Rock keep: +9.5 reprices to the +8.5 pool row ──
    const kept = autoCorrectHardRock(cardKeep(), gamesKeep());
    assert.strictEqual(kept.changed, true);
    assert.ok(kept.log.some(r => r.action === 'repriced' && /\+9\.5/.test(r.from) && /\+8\.5/.test(r.to)));
    assert.ok(kept.picks.length >= 1);
    const sac = kept.picks.find(p => /Sacramento State/.test(p.pick));
    assert.ok(sac, 'Sac State stayed on the card');
    assert.ok(/\+8\.5/.test(sac.pick), sac.pick);
    assert.strictEqual(sac.odds, '-110');
    assert.strictEqual(sac.book, 'hardrockbet');
    assert.ok(!kept.picks.some(p => /\+9\.5/.test(p.pick)));
    assert.strictEqual(kept.parlayLegs.length, 1);
    assert.strictEqual(kept.parlayLegs[0].legs.length, 3);
    assert.ok(kept.parlayLegs[0].legs.some(l => /\+8\.5/.test(l.pick)));
    assert.ok(!kept.parlayLegs[0].legs.some(l => /\+9\.5/.test(l.pick)));
    const games = kept.parlayLegs[0].legs.map(l => l.matchup);
    assert.strictEqual(new Set(games).size, 3);

    // ── Hard Rock replace: +8.5 edge under the floor takes the next HR side ──
    const replaced = autoCorrectHardRock(cardReplace(), gamesReplace());
    assert.strictEqual(replaced.changed, true);
    assert.ok(replaced.log.some(r => r.action === 'replaced' && /UCF/.test(r.to)));
    assert.ok(replaced.picks.length >= 1, 'card was withheld');
    assert.ok(replaced.picks.some(p => /UCF/.test(p.pick)));
    assert.ok(!replaced.picks.some(p => /\+9\.5/.test(p.pick)));
    assert.ok(replaced.parlayLegs.length >= 1);
    assert.ok(!JSON.stringify(replaced.parlayLegs).includes('+9.5'));

    // Unknown Hard Rock keeps the published number.
    const unknown = autoCorrectHardRock(cardKeep(), {});
    assert.strictEqual(unknown.changed, false);
    assert.ok(unknown.picks.some(p => /\+9\.5/.test(p.pick)));

    // ── 2026-10-10 morning yes pool under the new floor ──
    const snapPaths = [
      path.join(__dirname, 'test/fixtures/live-1010-2026-10-10.json'),
      '/workspace/omega-replay-2w/out/live-1010/2026-10-10.json',
    ];
    const snapPath = snapPaths.find((p) => fs.existsSync(p));
    assert.ok(snapPath, `missing 2026-10-10 candidate snapshot; tried ${snapPaths.join(', ')}`);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const asOf1010 = { cardDate: '2026-10-10', asOfMs: Date.parse('2026-10-10T13:30:00Z') };
    const coerce = (c, fromYes) => ({
      ...c,
      odds: typeof c.odds === 'number' ? c.odds : parseFloat(String(c.odds).replace(/[^0-9.+-]/g, '')),
      liquid: fromYes ? true : (c.rejectReason || c.reason) !== 'insufficient-liquidity',
    });
    const yes = (snap.yes || []).map(c => coerce(c, true));
    const board = yes.concat((snap.rejected || []).map(c => coerce(c, false)));
    const gatedYes = applyGates(yes, asOf1010);
    assert.strictEqual(
      gatedYes.yesPool.length + gatedYes.leanPool.length + gatedYes.rejected.length,
      yes.length,
      `10/10 yes pool left the gates: ${gatedYes.rejected.map(r => `${r.side}:${r.rejectReason}`).join(', ')}`,
    );
    assert.ok(gatedYes.yesPool.every((c) => Number(c.ev) + 1e-12 >= 0.02 && Number(c.ev) <= 0.12 + 1e-9));
    const gated = applyGates(board, asOf1010);
    const sacMl = [...gated.yesPool, ...gated.leanPool, ...gated.rejected]
      .find(c => c.side === 'Sacramento State Hornets' && c.odds === 270);
    assert.ok(sacMl, '+270 moneyline stays on the board');
    assert.strictEqual(sacMl.rejectReason, 'odds-out-of-band');
    const straights = selectStraights(gated.yesPool, 3, gated.leanPool);
    assert.strictEqual(straights.length, 3);
    const labels = straights.map(s => `${s.side} @ ${s.line}`);
    assert.strictEqual(new Set(straights.map(s => s.matchup)).size, 3, labels.join(' | '));
    assert.ok(gated.yesPool.every((c) => c.tier === 'floor' && Number(c.ev) + 1e-12 >= 0.02 && Number(c.ev) <= 0.12 + 1e-9));
    assert.ok(gated.leanPool.every((c) => c.tier === 'lean'));
    assert.ok(!straights.some(s => /40\.5/.test(String(s.side)) || s.line === 40.5));
    assert.ok(!straights.some(s => /\+9\.5/.test(s.side) || s.line === 9.5));
    assert.ok(!straights.some(s => /\+6\.5/.test(s.side) || s.line === 6.5));
    const parlayPool = gated.yesPool.concat(gated.leanPool);
    const parlayEligible = parlayPool.filter(c => Number(c.coverProb) >= 0.45 && c.ev > 0);
    assert.ok(!parlayEligible.some(c => c.side === 'Sacramento State Hornets' && c.odds === 270));
    const parlay = optimizeParlay(parlayPool, straights, { cardDate: '2026-10-10' });
    assert.strictEqual(parlay.length, 1);
    assert.strictEqual(parlay[0].legs.length, 3);
    assert.strictEqual(new Set(parlay[0].legs.map(l => l.matchup)).size, 3);
    assert.ok(parlay[0].legs.some(l => /Sacramento State Hornets \+9\b/.test(l.pick)));
    assert.ok(parlayEligible.length >= 3);
    assert.ok(parseFloat(parlay[0].ev) > 0, parlay[0].ev);
    assert.ok(parlay[0].legs.every(l => parseFloat(l.coverProb) >= 45));
    console.log('PASS test-omega-1010-lock');
    console.log(JSON.stringify({
      curve: 'max(0.03, min(0.06, 0.0175 + 0.05 * max(0, implied(-110) - implied(american)) + 0.04 * max(0, uncertainty - 0.15)))',
      evFloor: 0.03,
      leanMinEv: 0.015,
      parlayMinCover: 0.45,
      examples: {
        minus110: minEdgeFor(-110, 0.15),
        minus110unc17: minEdgeFor(-110, 0.17),
        minus110unc30: minEdgeFor(-110, 0.30),
        plus150: minEdgeFor(150, 0.15),
        plus200: minEdgeFor(200, 0.15),
        plus300: minEdgeFor(300, 0.15),
      },
      floor: gated.yesPool.length,
      lean: gated.leanPool.length,
      parlayEligible: parlayEligible.length,
      straights: straights.map(s => ({
        side: s.side, line: s.line, tier: s.tier, edge: s.edgePct, ev: s.ev, odds: s.odds, book: s.book, fair: s.fair_sharp_p, matchup: s.matchup,
      })),
      parlay: parlay[0].legs.map(l => ({ pick: l.pick, matchup: l.matchup, odds: l.odds, edgePct: l.edgePct, coverProb: l.coverProb })),
      parlayEv: parlay[0].ev,
    }, null, 2));
  } finally {
    global.fetch = priorFetch;
    if (priorKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = priorKey;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function published(pick, extra) {
  return {
    sport: 'NCAAF',
    betType: extra.betType || 'Spread',
    odds: '-110',
    coverProb: '55%',
    ev: '4.0%',
    edgePct: '3.2%',
    fair_sharp_p: 0.51,
    uncertainty: 0.17,
    book: 'draftkings',
    coreReasoning: 'WeBetAI projects a real edge on this number at the morning price.',
    whatLoses: 'The other side covers the number.',
    ...extra,
    pick,
  };
}

function cardKeep() {
  return {
    date: '2026-10-10',
    picks: [
      published('Over 40.5', {
        betType: 'Total', matchup: 'Texas Longhorns @ Oklahoma Sooners', line: 40.5,
        edgePct: '5.4%', fair_sharp_p: 0.496, commenceTime: '2026-10-10T19:30:00Z',
        homeTeam: 'Oklahoma Sooners', awayTeam: 'Texas Longhorns', book: 'espnbet',
      }),
      published('Sacramento State Hornets +9.5', {
        matchup: 'Sacramento State Hornets @ Bowling Green Falcons', line: 9.5,
        odds: '-108', coverProb: '54.6%', ev: '4.8%', edgePct: '4.3%', fair_sharp_p: 0.503,
        commenceTime: '2026-10-10T16:00:00Z',
        homeTeam: 'Bowling Green Falcons', awayTeam: 'Sacramento State Hornets',
      }),
      published('UMass Minutemen +6.5', {
        matchup: 'Miami (OH) RedHawks @ UMass Minutemen', line: 6.5,
        commenceTime: '2026-10-10T18:00:00Z',
        homeTeam: 'UMass Minutemen', awayTeam: 'Miami (OH) RedHawks',
      }),
    ],
    parlayLegs: [{ type: '3-leg', legs: [{ pick: 'Sacramento State Hornets +9.5', matchup: 'Sacramento State Hornets @ Bowling Green Falcons' }] }],
    candidateTable: [{
      sport: 'NCAAF',
      matchup: 'Sacramento State Hornets @ Bowling Green Falcons',
      side: 'Sacramento State Hornets +8.5',
      market: 'Spread',
      line: 8.5,
      odds: '-108',
      coverProb: 0.542,
      edge: 0.041,
      fair_sharp_p: 0.501,
      ev: 0.035,
      commenceTime: '2026-10-10T16:00:00Z',
      homeTeam: 'Bowling Green Falcons',
      awayTeam: 'Sacramento State Hornets',
      uncertainty: 0.17,
    }],
  };
}

function hrSpread(home, away, team, point, price) {
  return {
    home_team: home,
    away_team: away,
    bookmakers: [{
      key: 'hardrockbet',
      markets: [{
        key: 'spreads',
        outcomes: [
          { name: team, price, point },
          { name: home === team ? away : home, price: -110, point: -point },
        ],
      }],
    }],
  };
}

function gamesKeep() {
  return {
    NCAAF: [
      hrSpread('Bowling Green Falcons', 'Sacramento State Hornets', 'Sacramento State Hornets', 8.5, -110),
    ],
  };
}

function cardReplace() {
  const card = cardKeep();
  card.candidateTable = [
    {
      sport: 'NCAAF',
      matchup: 'Sacramento State Hornets @ Bowling Green Falcons',
      side: 'Sacramento State Hornets +8.5',
      market: 'Spread',
      line: 8.5,
      odds: -110,
      coverProb: 0.505,
      edge: 0.004,
      fair_sharp_p: 0.501,
      ev: -0.03,
      commenceTime: '2026-10-10T16:00:00Z',
      homeTeam: 'Bowling Green Falcons',
      awayTeam: 'Sacramento State Hornets',
      uncertainty: 0.17,
    },
    {
      sport: 'NCAAF',
      matchup: 'UCF Knights @ Florida Atlantic Owls',
      side: 'UCF Knights +10.5',
      market: 'Spread',
      line: 10.5,
      odds: -110,
      coverProb: 0.56,
      edge: 0.05,
      fair_sharp_p: 0.51,
      ev: 0.07,
      commenceTime: '2026-10-10T23:00:00Z',
      homeTeam: 'Florida Atlantic Owls',
      awayTeam: 'UCF Knights',
      uncertainty: 0.15,
    },
  ];
  return card;
}

function gamesReplace() {
  return {
    NCAAF: [
      hrSpread('Bowling Green Falcons', 'Sacramento State Hornets', 'Sacramento State Hornets', 8.5, -110),
      hrSpread('Florida Atlantic Owls', 'UCF Knights', 'UCF Knights', 10.5, -110),
    ],
  };
}
