'use strict';
// MLB golden below is the unshifted engine. Level correction is off here.
process.env.OMEGA_MLB_ROOTFIX = '0';
process.env.OMEGA_MLB_TOTAL_RECENTER = '0';
/**
 * NFL/NCAAF point-space shrink before the CDF (λ=1, no pull), and a private
 * model-vs-line review flag. The flag does not reject and does not change
 * coverProb, edge, or EV versus the pre-item-5 path. MLB and NHL stay identical.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nfl = require(path.join(root, 'sports/nfl'));
const cfb = require(path.join(root, 'sports/cfb'));
const mlb = require(path.join(root, 'sports/mlb'));
const nhl = require(path.join(root, 'sports/nhl'));
const { applyGates, gateReason, buildGapReview } = require(path.join(root, 'gates'));
const { calibrateCandidate, calibrateAll } = require(path.join(root, 'calibrate'));
const { attachEv } = require(path.join(root, 'edge'));
const { selectStraights, toPickObject } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const {
  blendWithMarket, totalCoverProb, spreadCoverProb, mlFromSpread, FOOTBALL_AUDIT_KEYS,
} = require(path.join(root, 'sports/_common'));
const { collectMarketOutcomes, noVigPinnacleCircaImplied } = require(path.join(root, 'edge'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.13-omega-vnext-nhl-engine');
assert.deepStrictEqual(config.SHRINK_K, { Total: 0.58, Spread: 0.68, Moneyline: 0.73, default: 0.63 });
assert.deepStrictEqual(config.GATES.minEV, { MLB: 0.03, NFL: 0.025, NCAAF: 0.03, NBA: 0.03, NHL: 0.03, default: 0.03 });
assert.deepStrictEqual(config.GATES.minCoverProb, { MLB: 0.48, NFL: 0.48, NCAAF: 0.48, default: 0.48 });
assert.deepStrictEqual(config.POINT_SHRINK, {
  NFL: { total: 1, margin: 1 },
  NCAAF: { total: 1, margin: 1 },
});
assert.deepStrictEqual(config.MODEL_LINE_GAP, { NFL: 8, NCAAF: 10, mode: 'flag' });
assert.ok(/block' failed the 2026-10-06 replay gate/.test(
  fs.readFileSync(path.join(root, 'config.js'), 'utf8'),
));

const NFL_PLAYS = 62;
const NCAAF_PLAYS = 68;

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function event(home, away, total, spread) {
  return {
    home_team: home,
    away_team: away,
    commence_time: '2099-06-01T23:10:00Z',
    bookmakers: ['pinnacle', 'circa', 'draftkings', 'fanduel'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: -130 }, { name: away, price: 110 }] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: spread },
          { name: away, price: -110, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ] },
      ],
    })),
  };
}

/** offEpa on the home club moves only the total, by delta points. Both clubs resolve. */
function efficiency(home, away, deltaPoints, plays) {
  return {
    [home]: { offEpa: deltaPoints / plays, defEpa: 0 },
    [away]: { offEpa: 0, defEpa: 0 },
  };
}

function projectFootball(sport, ev, deltaPoints) {
  const plays = sport === 'NFL' ? NFL_PLAYS : NCAAF_PLAYS;
  const mod = sport === 'NFL' ? nfl : cfb;
  return mod.project({
    oddsEvents: [ev],
    standings: {},
    efficiency: efficiency(ev.home_team, ev.away_team, deltaPoints, plays),
  });
}

function findSide(cands, market, re) {
  const row = cands.find(c => c.market === market && re.test(c.side));
  assert.ok(row, `missing ${market} ${re}`);
  return row;
}

function weightFor(c) {
  if (c.sport === 'NFL') return c.market === 'Total' ? 0.45 : 0.5;
  if (c.sport === 'NCAAF') return c.market === 'Total' ? 0.4 : 0.45;
  throw new Error(`unexpected sport ${c.sport}`);
}

function unshrunkModelRawP(c, ev) {
  const key = c.market === 'Total' ? 'totals' : c.market === 'Spread' ? 'spreads' : 'h2h';
  const bundles = collectMarketOutcomes(ev, key);
  const bundle = bundles.find((b) => {
    if (c.market === 'Moneyline') return b.side === c.side;
    if (c.market === 'Total') return b.side === c.side.split(' ')[0] && b.point === c.line;
    return c.side.startsWith(b.side) && b.point === c.line;
  });
  assert.ok(bundle, `bundle for ${c.market} ${c.side}`);
  const anchor = noVigPinnacleCircaImplied(bundles, bundle);
  let p;
  if (c.market === 'Total') {
    p = totalCoverProb(c.modelTotalRaw, c.line, c.side, c.sport);
  } else if (c.market === 'Spread') {
    const isHome = c.side.startsWith(c.homeTeam);
    p = spreadCoverProb(isHome ? c.modelMarginRaw : -c.modelMarginRaw, c.line, c.sport);
  } else {
    const homeP = mlFromSpread(c.modelMarginRaw, c.sport);
    p = c.side === c.homeTeam ? homeP : 1 - homeP;
  }
  return blendWithMarket(p, anchor, weightFor(c));
}

function signedEdge(c, modelRawP) {
  const row = calibrateCandidate({ ...c, modelRawP });
  assert.ok(Number.isFinite(row.coverProb) && Number.isFinite(row.fair_sharp_p));
  return row.coverProb - row.fair_sharp_p;
}

/** coverProb, edge, and EV the way the card scores a candidate. */
function cardScore(c, modelRawP) {
  const row = attachEv(calibrateCandidate({ ...c, modelRawP }));
  return { coverProb: row.coverProb, edge: row.edgePct, ev: row.ev };
}

/**
 * Flag on or off, the score matches the pre-item-5 (unshrunk) probability.
 * λ=1 does not move the projection. The flag is not an input to the score.
 */
function assertPickNeutral(c, ev) {
  const beforeP = unshrunkModelRawP(c, ev);
  assert.ok(
    Math.abs(c.modelRawP - beforeP) < 1e-12,
    `${c.sport} ${c.market} ${c.side} modelRawP ${c.modelRawP} vs pre-item-5 ${beforeP}`,
  );
  const now = cardScore(c, c.modelRawP);
  const before = cardScore(c, beforeP);
  const flipped = cardScore({ ...c, gapFlag: !c.gapFlag }, c.modelRawP);
  assert.ok(Math.abs(now.coverProb - before.coverProb) < 1e-12, `${c.side} coverProb moved`);
  assert.strictEqual(now.edge, before.edge, `${c.side} edge`);
  assert.strictEqual(now.ev, before.ev, `${c.side} ev`);
  assert.strictEqual(now.coverProb, flipped.coverProb);
  assert.strictEqual(now.edge, flipped.edge);
  assert.strictEqual(now.ev, flipped.ev);
  assert.strictEqual(gateReason(attachEv(calibrateCandidate(c))), gateReason(attachEv(calibrateCandidate({ ...c, gapFlag: false }))));
  assert.notStrictEqual(gateReason(c), 'model_line_gap_review');
}

function scoreAll(cands) {
  return calibrateAll(cands).map(attachEv);
}

function assertEdgesNeverGrow(cands, ev) {
  for (const c of cands) {
    const beforeP = unshrunkModelRawP(c, ev);
    const after = signedEdge(c, c.modelRawP);
    const before = signedEdge(c, beforeP);
    assert.ok(
      after <= before + 1e-9,
      `${c.sport} ${c.market} ${c.side} edge ${after} > before ${before}`,
    );
  }
}

// 54 vs 38.5 NFL total: gap 15.5 is flagged, and the market-gap guard rejects
// it (NFL total cap 13). λ=1 does not pull the total. The flag itself still
// does not change the score. A flagged gap under that cap (12.5) still
// prices, and clearing gapFlag does not change selection or the parlay.
{
  const home = 'Miami Dolphins';
  const away = 'Minnesota Vikings';
  const ev = event(home, away, 38.5, -3);
  const cands = projectFootball('NFL', ev, 9);
  const over = findSide(cands, 'Total', /^Over/);
  const under = findSide(cands, 'Total', /^Under/);
  assert.strictEqual(over.modelTotalRaw, 54);
  assert.strictEqual(over.modelTotalShrunk, 54);
  assert.strictEqual(over.marketLine, 38.5);
  assert.strictEqual(over.modelLineGap, 15.5);
  assert.strictEqual(over.gapFlag, true);
  assert.strictEqual(under.gapFlag, true);
  assert.strictEqual(under.modelLineGap, 15.5);
  for (const c of cands) assertPickNeutral(c, ev);

  const home2 = 'Detroit Lions';
  const away2 = 'Chicago Bears';
  const ev2 = event(home2, away2, 38.5, -3);
  const cands2 = projectFootball('NFL', ev2, 9);
  for (const c of cands2) assertPickNeutral(c, ev2);
  const slate = scoreAll([...cands, ...cands2]);

  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let gated;
  try {
    gated = applyGates(slate);
  } finally {
    console.log = orig;
  }
  assert.ok(!logs.some(l => l.includes('model_line_gap_review')));
  assert.ok(!gated.rejected.some(r => r.rejectReason === 'model_line_gap_review'));
  const scoredOver = gated.rejected.find(c => c.side === over.side && c.matchup === over.matchup);
  assert.ok(scoredOver, '54 vs 38.5 over was not rejected');
  assert.strictEqual(scoredOver.rejectReason, 'model_market_gap');
  assert.strictEqual(scoredOver.gapFlag, true);
  assert.strictEqual(gateReason(scoredOver), 'model_market_gap');
  assert.ok(!gated.yesPool.some(c => c.market === 'Total' && c.modelLineGap === 15.5));

  const review = buildGapReview(slate);
  const overRow = review.find(r => r.side === over.side && r.matchup === over.matchup);
  const underRow = review.find(r => r.side === under.side && r.matchup === under.matchup);
  assert.ok(overRow);
  assert.deepStrictEqual(
    { sport: overRow.sport, line: overRow.line, modelRaw: overRow.modelRaw, gap: overRow.gap },
    { sport: 'NFL', line: 38.5, modelRaw: 54, gap: 15.5 },
  );
  assert.strictEqual(overRow.selected, false);
  assert.ok(underRow);
  assert.strictEqual(underRow.modelRaw, 54);
  assert.strictEqual(underRow.gap, 15.5);
  assert.strictEqual(underRow.selected, false);
  assert.strictEqual(review.filter(r => r.line === 38.5 && r.gap === 15.5).length, 4);
  assertEdgesNeverGrow(cands, ev);

  // 51 vs 38.5 is flagged (NFL flag starts at 8) and still inside the cap.
  const midHome = 'Los Angeles Chargers';
  const midAway = 'Las Vegas Raiders';
  const midEv = event(midHome, midAway, 38.5, -3);
  const midHome2 = 'Seattle Seahawks';
  const midAway2 = 'San Francisco 49ers';
  const midEv2 = event(midHome2, midAway2, 38.5, -3);
  const mid1 = projectFootball('NFL', midEv, 6);
  const mid2 = projectFootball('NFL', midEv2, 6);
  const midOver = findSide(mid1, 'Total', /^Over/);
  assert.strictEqual(midOver.modelTotalRaw, 51);
  assert.strictEqual(midOver.modelLineGap, 12.5);
  assert.strictEqual(midOver.gapFlag, true);
  for (const c of mid1) assertPickNeutral(c, midEv);
  for (const c of mid2) assertPickNeutral(c, midEv2);
  const midSlate = scoreAll([...mid1, ...mid2]);
  const midGated = applyGates(midSlate);
  const midScored = midGated.yesPool.find(c => c.side === midOver.side && c.matchup === midOver.matchup);
  assert.ok(midScored, '12.5-point NFL total gap was rejected');
  assert.strictEqual(midScored.gapFlag, true);
  assert.strictEqual(gateReason(midScored), null);
  const midCleared = midGated.yesPool.map(c => ({ ...c, gapFlag: false }));
  const picked = selectStraights(midGated.yesPool, 3).map(c => `${c.matchup}|${c.side}`);
  const pickedClear = selectStraights(midCleared, 3).map(c => `${c.matchup}|${c.side}`);
  assert.deepStrictEqual(picked, pickedClear);
  assert.ok(picked.some(s => s.endsWith(`|${midOver.side}`)));

  const tickets = optimizeParlay(midGated.yesPool, [], {});
  const ticketsClear = optimizeParlay(midCleared, [], {});
  const legKey = (t) => (t[0] ? t[0].legs.map(l => `${l.matchup}|${l.pick}`).sort() : []);
  assert.deepStrictEqual(legKey(tickets), legKey(ticketsClear));
  const flaggedLegs = (tickets[0] ? tickets[0].legs : []).filter(l => /38\.5/.test(String(l.pick || '')));
  assert.ok(flaggedLegs.length >= 1, 'flagged total did not compete for the parlay');
  for (const leg of flaggedLegs) {
    assert.strictEqual(leg.gapFlag, true);
    assert.strictEqual(leg.modelLineGap, 12.5);
    for (const k of FOOTBALL_AUDIT_KEYS) assert.notStrictEqual(leg[k], undefined, k);
  }
  const midPicks = selectStraights(midGated.yesPool, 3).map(c => toPickObject(c, { modelVersion: config.MODEL_VERSION }));
  const midReview = buildGapReview(midSlate, midPicks, tickets);
  const midRow = midReview.find(r => r.side === midOver.side && r.matchup === midOver.matchup);
  assert.ok(midRow);
  assert.strictEqual(midRow.selected, true);
  assert.strictEqual(midRow.gap, 12.5);
}

// 47 vs 42.5 stays under the NFL 8 block. λ=1 leaves the total, so the edge matches the unshrunk path.
{
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const ev = event(home, away, 42.5, -3);
  const cands = projectFootball('NFL', ev, 2);
  const over = findSide(cands, 'Total', /^Over/);
  const under = findSide(cands, 'Total', /^Under/);
  assert.strictEqual(over.modelTotalRaw, 47);
  assert.strictEqual(over.modelTotalShrunk, 47);
  assert.strictEqual(over.marketLine, 42.5);
  assert.strictEqual(over.modelLineGap, 4.5);
  assert.strictEqual(over.gapFlag, false);
  assert.strictEqual(under.modelTotalShrunk, 47);
  assert.strictEqual(under.gapFlag, false);
  const beforeP = unshrunkModelRawP(over, ev);
  const after = signedEdge(over, over.modelRawP);
  const before = signedEdge(over, beforeP);
  assert.ok(Math.abs(over.modelRawP - beforeP) < 1e-12, `modelRawP moved ${over.modelRawP} vs ${beforeP}`);
  assert.ok(Math.abs(after - before) < 1e-12, `over edge moved ${after} vs ${before}`);
  assert.ok(after <= before + 1e-9);
  for (const c of cands) assertPickNeutral(c, ev);
  assert.strictEqual(buildGapReview(cands).length, 0);
  assert.notStrictEqual(gateReason(over), 'model_line_gap_review');
}

// Model equal to the line: shrunk number and probability match the old path.
{
  const home = 'Green Bay Packers';
  const away = 'Tampa Bay Buccaneers';
  const ev = event(home, away, 45, -2.1);
  const cands = projectFootball('NFL', ev, 0);
  const over = findSide(cands, 'Total', /^Over/);
  const under = findSide(cands, 'Total', /^Under/);
  assert.strictEqual(over.modelTotalRaw, 45);
  assert.strictEqual(over.modelTotalShrunk, 45);
  assert.strictEqual(over.modelLineGap, 0);
  assert.strictEqual(over.gapFlag, false);
  for (const c of [over, under]) {
    const beforeP = unshrunkModelRawP(c, ev);
    assert.ok(Math.abs(c.modelRawP - beforeP) < 1e-12, `${c.side} moved off the line`);
    assert.ok(Math.abs(signedEdge(c, c.modelRawP) - signedEdge(c, beforeP)) < 1e-12);
  }
  const homeSpread = cands.find(c => c.market === 'Spread' && c.side.startsWith(home));
  assert.ok(homeSpread);
  assert.strictEqual(homeSpread.marketLine, -2.1);
  const marketMargin = -homeSpread.marketLine;
  assert.ok(Math.abs(homeSpread.modelMarginRaw - marketMargin) < 1e-9);
  assert.strictEqual(homeSpread.modelMarginShrunk, homeSpread.modelMarginRaw);
  assert.strictEqual(homeSpread.modelLineGap, 0);
  const ml = cands.find(c => c.market === 'Moneyline' && c.side === home);
  const mlBefore = unshrunkModelRawP(ml, ev);
  assert.ok(Math.abs(ml.modelRawP - mlBefore) < 1e-12, 'moneyline uses the margin, unchanged when it equals the line');
  assertEdgesNeverGrow(cands, ev);
}

// NCAAF λ is 1, so the margin is not pulled. A 10-point total gap is flagged; 9.9 is not.
{
  const home = 'Ohio State Buckeyes';
  const away = 'Iowa Hawkeyes';
  const wideEv = event(home, away, 42, -7.5);
  const wide = projectFootball('NCAAF', wideEv, 0);
  const over = findSide(wide, 'Total', /^Over/);
  assert.strictEqual(over.modelTotalRaw, 52);
  assert.strictEqual(over.modelTotalShrunk, 52);
  assert.strictEqual(over.modelLineGap, 10);
  assert.strictEqual(over.gapFlag, true);
  assert.notStrictEqual(gateReason(over), 'model_line_gap_review');
  const wideRow = buildGapReview(wide).find(r => r.side === over.side);
  assert.ok(wideRow);
  assert.strictEqual(wideRow.modelRaw, 52);
  assert.strictEqual(wideRow.line, 42);
  assert.strictEqual(wideRow.gap, 10);
  assert.strictEqual(wideRow.selected, false);
  assertPickNeutral(over, wideEv);
  const spread = wide.find(c => c.market === 'Spread' && c.side.startsWith(home));
  const marketMargin = round4(-spread.marketLine);
  const expected = round4(marketMargin + config.POINT_SHRINK.NCAAF.margin * (spread.modelMarginRaw - marketMargin));
  assert.strictEqual(spread.modelMarginShrunk, expected);
  assert.strictEqual(spread.modelMarginShrunk, spread.modelMarginRaw);
  assertEdgesNeverGrow(wide, event(home, away, 42, -7.5));

  const close = projectFootball('NCAAF', event(home, away, 42.1, -3), 0);
  const closeOver = findSide(close, 'Total', /^Over/);
  assert.strictEqual(closeOver.modelLineGap, round4(52 - 42.1));
  assert.ok(Math.abs(closeOver.modelLineGap) < 10);
  assert.strictEqual(closeOver.gapFlag, false);
  assert.notStrictEqual(gateReason(closeOver), 'model_line_gap_review');
  assert.ok(!buildGapReview(close).some(r => r.side === closeOver.side));
  assertPickNeutral(closeOver, event(home, away, 42.1, -3));
}

// Spread threshold uses margin versus −homeSpread. NFL 8 flags the spread, not the moneyline.
{
  const home = 'Baltimore Ravens';
  const away = 'Cincinnati Bengals';
  const ev = event(home, away, 45, -10.5);
  const cands = projectFootball('NFL', ev, 0);
  const spread = cands.filter(c => c.market === 'Spread');
  assert.strictEqual(spread.length, 2);
  for (const c of spread) {
    assert.strictEqual(c.marketLine, -10.5);
    assert.strictEqual(c.modelLineGap, round4(c.modelMarginRaw - (-c.marketLine)));
    assert.ok(Math.abs(c.modelLineGap) >= 8);
    assert.strictEqual(c.gapFlag, true);
    assert.notStrictEqual(gateReason(c), 'model_line_gap_review');
    const row = buildGapReview(cands).find(r => r.side === c.side);
    assert.ok(row);
    assert.strictEqual(row.modelRaw, c.modelMarginRaw);
    assert.strictEqual(row.line, c.line);
    assert.strictEqual(row.gap, c.modelLineGap);
    assert.strictEqual(row.selected, false);
    assertPickNeutral(c, ev);
  }
  const ml = cands.find(c => c.market === 'Moneyline' && c.side === home);
  assert.strictEqual(ml.gapFlag, false);
  assert.notStrictEqual(gateReason(ml), 'model_line_gap_review');
  assert.ok(!buildGapReview(cands).some(r => r.side === ml.side));
  assertPickNeutral(ml, ev);
  assert.ok(ml.modelMarginShrunk != null);
  assertEdgesNeverGrow(cands, ev);
}

// Below the NFL total threshold stays publishable by this rule.
{
  const home = 'Dallas Cowboys';
  const away = 'Philadelphia Eagles';
  const ev = event(home, away, 38.5, -3);
  const cands = projectFootball('NFL', ev, 1.4);
  const over = findSide(cands, 'Total', /^Over/);
  assert.strictEqual(over.modelTotalRaw, 46.4);
  assert.ok(Math.abs(over.modelLineGap) < 8);
  assert.strictEqual(over.gapFlag, false);
  assert.notStrictEqual(gateReason(over), 'model_line_gap_review');
  assert.ok(!buildGapReview(cands).some(r => r.side === over.side));
  assertPickNeutral(over, ev);
  const onEv = event(home, away, 38.5, -3);
  const on = projectFootball('NFL', onEv, 1.5);
  const onOver = findSide(on, 'Total', /^Over/);
  assert.strictEqual(onOver.modelTotalRaw, 46.5);
  assert.strictEqual(onOver.modelLineGap, 8);
  assert.strictEqual(onOver.gapFlag, true);
  assert.notStrictEqual(gateReason(onOver), 'model_line_gap_review');
  const onRow = buildGapReview(on).find(r => r.side === onOver.side);
  assert.ok(onRow);
  assert.strictEqual(onRow.gap, 8);
  assert.strictEqual(onRow.modelRaw, 46.5);
  assert.strictEqual(onRow.line, 38.5);
  assert.strictEqual(onRow.selected, false);
  assertPickNeutral(onOver, onEv);
}

// Private pick keeps the fields. Public payload drops them. MLB pick gains none.
{
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const ev = event(home, away, 42.5, -3);
  const over = findSide(projectFootball('NFL', ev, 2), 'Total', /^Over/);
  const priced = calibrateCandidate(over);
  const pick = toPickObject({ ...over, ...priced, edgePct: 0.03, ev: 0.04 }, { modelVersion: config.MODEL_VERSION });
  for (const k of FOOTBALL_AUDIT_KEYS) assert.strictEqual(pick[k], over[k], k);
  assert.strictEqual(pick.modelTotalShrunk, 47);

  const mlbPick = toPickObject({
    sport: 'MLB', market: 'Moneyline', side: 'New York Yankees',
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', matchup: 'Boston Red Sox @ New York Yankees',
    coverProb: 0.55, odds: -110, edgePct: 0.03, ev: 0.04,
  }, { modelVersion: config.MODEL_VERSION });
  for (const k of FOOTBALL_AUDIT_KEYS) assert.strictEqual(mlbPick[k], undefined, k);

  const flagged = findSide(projectFootball('NFL', event(home, away, 38.5, -3), 9), 'Total', /^Over/);
  const flaggedScored = attachEv(calibrateCandidate(flagged));
  const flaggedPick = toPickObject({ ...flagged, ...flaggedScored, edgePct: flaggedScored.edgePct, ev: flaggedScored.ev }, { modelVersion: config.MODEL_VERSION });
  for (const k of FOOTBALL_AUDIT_KEYS) assert.strictEqual(flaggedPick[k], flagged[k], k);
  assert.strictEqual(flaggedPick.gapFlag, true);
  assert.strictEqual(flaggedPick.modelLineGap, 15.5);
  const flaggedLeg = {
    pick: flagged.side,
    matchup: flagged.matchup,
    betType: flagged.market,
    sport: 'NFL',
    odds: '-110',
    ...Object.fromEntries(FOOTBALL_AUDIT_KEYS.map(k => [k, flagged[k]])),
  };
  assert.strictEqual(flaggedLeg.gapFlag, true);

  const gapReview = buildGapReview([flagged, over], [flaggedPick], [{ legs: [flaggedLeg] }]);
  assert.strictEqual(gapReview.find(r => r.side === flagged.side).selected, true);

  const pub = publicPicksPayload({
    model: config.MODEL_VERSION,
    candidateTable: [{ rank: 1, ...over, ...flagged }],
    rejections: [{ side: over.side, reason: 'ev-floor', modelLineGap: 15.5, gapFlag: true }],
    gapReview,
    picks: [pick, flaggedPick],
    parlayLegs: [{
      type: '2-leg',
      units: '0.5u',
      combinedOdds: '+250',
      legs: [pick, flaggedLeg],
    }],
  });
  assert.strictEqual(pub.candidateTable, undefined);
  assert.strictEqual(pub.gapReview, undefined);
  assert.deepStrictEqual(pub.rejections, []);
  const pubPick = pub.picks[0];
  const pubFlagged = pub.picks[1];
  const pubLeg = pub.parlayLegs[0].legs[0];
  const pubFlaggedLeg = pub.parlayLegs[0].legs[1];
  for (const row of [pubPick, pubFlagged, pubLeg, pubFlaggedLeg]) {
    for (const k of FOOTBALL_AUDIT_KEYS) {
      assert.strictEqual(row[k], undefined, `public leaked ${k}`);
    }
  }
  assert.strictEqual(pubPick.pick, pick.pick);
  assert.strictEqual(pubPick.sport, 'NFL');
  assert.ok(pubPick.odds);
  assert.strictEqual(pubFlagged.sport, 'NFL');
  const blob = JSON.stringify(pub);
  for (const k of [...FOOTBALL_AUDIT_KEYS, 'gapReview', 'modelRaw']) {
    assert.ok(!blob.includes(k), `public payload contains ${k}`);
  }
  const beforeKeys = Object.keys(publicPicksPayload({
    model: config.MODEL_VERSION,
    picks: [{ pick: pick.pick, sport: 'NFL', odds: pick.odds, units: pick.units, rating: pick.rating }],
    parlayLegs: [],
  })).sort();
  assert.deepStrictEqual(Object.keys(pub).sort(), beforeKeys);

  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(idx.includes('...footballAuditFields(c)'));
  assert.ok(idx.includes('...footballAuditFields(r)'));
  assert.ok(idx.includes('gapReview: buildGapReview('));
}

// MLB matches the pre-change fixture. NHL in-band per-game rates stay raw under the
// oob default (same board as mode off). Neither sport carries football audit fields.
{
  function synth(home, away, opts) {
    const total = opts.total;
    const spread = opts.spread;
    return {
      home_team: home,
      away_team: away,
      commence_time: '2026-10-06T23:10:00Z',
      bookmakers: ['pinnacle', 'circa', 'draftkings', 'fanduel'].map((key) => ({
        key,
        markets: [
          { key: 'h2h', outcomes: [
            { name: home, price: key === 'pinnacle' ? -130 : -125 },
            { name: away, price: key === 'pinnacle' ? 110 : 105 },
          ] },
          { key: 'spreads', outcomes: [
            { name: home, price: -110, point: spread },
            { name: away, price: -110, point: -spread },
          ] },
          { key: 'totals', outcomes: [
            { name: 'Over', price: -110, point: total },
            { name: 'Under', price: -110, point: total },
          ] },
        ],
      })),
    };
  }
  function slim(rows) {
    return rows.map(c => ({
      sport: c.sport,
      market: c.market,
      side: c.side,
      line: c.line,
      modelRawP: c.modelRawP,
      modelProjection: c.modelProjection,
      fair_sharp_p: c.fair_sharp_p,
      odds: c.odds,
      projMethod: c.projMethod,
    }));
  }
  const mlbC = mlb.project({
    oddsEvents: [synth('New York Yankees', 'Boston Red Sox', { total: 8.5, spread: -1.5 })],
    standings: {
      'New York Yankees': { pf: 720, pa: 640, wins: 90, losses: 60 },
      'Boston Red Sox': { pf: 680, pa: 700, wins: 80, losses: 70 },
    },
    parkFactors: {},
    mlbPitcherStats: {},
    espnGames: [],
  });
  const nhlC = nhl.project({
    oddsEvents: [synth('Colorado Avalanche', 'Dallas Stars', { total: 6.0, spread: -1.5 })],
    standings: {
      'Colorado Avalanche': { pf: 3.4, pa: 2.6, wins: 40, losses: 20, otLosses: 5 },
      'Dallas Stars': { pf: 3.1, pa: 2.9, wins: 35, losses: 25, otLosses: 4 },
    },
  });
  const before = {
    mlb: [
      { sport: 'MLB', market: 'Moneyline', side: 'New York Yankees', line: null, modelRawP: 0.5402913459468046, modelProjection: 0.45, fair_sharp_p: 0.5427435387673957, odds: -125, projMethod: 'mlb-pythag-lite+hfa' },
      { sport: 'MLB', market: 'Moneyline', side: 'Boston Red Sox', line: null, modelRawP: 0.45970865405319533, modelProjection: 0.45, fair_sharp_p: 0.4572564612326044, odds: 105, projMethod: 'mlb-pythag-lite+hfa' },
      { sport: 'MLB', market: 'Spread', side: 'New York Yankees -1.5', line: -1.5, modelRawP: 0.45080026309255516, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'mlb-normal-rl' },
      { sport: 'MLB', market: 'Spread', side: 'Boston Red Sox +1.5', line: 1.5, modelRawP: 0.5491997369074448, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'mlb-normal-rl' },
      { sport: 'MLB', market: 'Total', side: 'Over 8.5', line: 8.5, modelRawP: 0.5323089361649493, modelProjection: 9.13, fair_sharp_p: 0.5, odds: -110, projMethod: 'mlb-total-baseline' },
      { sport: 'MLB', market: 'Total', side: 'Under 8.5', line: 8.5, modelRawP: 0.46769106383505077, modelProjection: 9.13, fair_sharp_p: 0.5, odds: -110, projMethod: 'mlb-total-baseline' },
    ],
    nhl: [
      { sport: 'NHL', market: 'Moneyline', side: 'Colorado Avalanche', line: null, modelRawP: 0.554514682531127, modelProjection: 0.45, fair_sharp_p: 0.5427435387673957, odds: -125, projMethod: 'nhl-standings-hfa' },
      { sport: 'NHL', market: 'Moneyline', side: 'Dallas Stars', line: null, modelRawP: 0.445485317468873, modelProjection: 0.45, fair_sharp_p: 0.4572564612326044, odds: 105, projMethod: 'nhl-standings-hfa' },
      { sport: 'NHL', market: 'Spread', side: 'Colorado Avalanche -1.5', line: -1.5, modelRawP: 0.4186213384597734, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
      { sport: 'NHL', market: 'Spread', side: 'Dallas Stars +1.5', line: 1.5, modelRawP: 0.5813786615402265, modelProjection: 0.45, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-normal-pl' },
      { sport: 'NHL', market: 'Total', side: 'Over 6', line: 6, modelRawP: 0.4999999325447795, modelProjection: 6, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
      { sport: 'NHL', market: 'Total', side: 'Under 6', line: 6, modelRawP: 0.4999999325447795, modelProjection: 6, fair_sharp_p: 0.5, odds: -110, projMethod: 'nhl-total-baseline' },
    ],
  };
  assert.deepStrictEqual(slim(mlbC), before.mlb);
  assert.deepStrictEqual(slim(nhlC), before.nhl);
  for (const c of [...mlbC, ...nhlC]) {
    for (const k of FOOTBALL_AUDIT_KEYS) assert.strictEqual(c[k], undefined, `${c.sport} leaked ${k}`);
  }
}

console.log('PASS test-omega-point-shrink');
