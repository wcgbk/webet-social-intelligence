'use strict';
/**
 * NFL/NCAAF point-space shrink before the CDF, and the model-vs-line review block.
 * MLB and NHL stay on the pre-change probability path.
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
const { applyGates, gateReason } = require(path.join(root, 'gates'));
const { calibrateCandidate } = require(path.join(root, 'calibrate'));
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
  NFL: { total: 0.5, margin: 0.5 },
  NCAAF: { total: 0.5, margin: 0.6 },
});
assert.deepStrictEqual(config.MODEL_LINE_GAP, { NFL: 8, NCAAF: 10 });

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

// 54 vs 38.5 NFL total: gap 15.5 blocks both sides. Shrunk total is 46.25.
{
  const home = 'Miami Dolphins';
  const away = 'Minnesota Vikings';
  const ev = event(home, away, 38.5, -3);
  const cands = projectFootball('NFL', ev, 9);
  const over = findSide(cands, 'Total', /^Over/);
  const under = findSide(cands, 'Total', /^Under/);
  assert.strictEqual(over.modelTotalRaw, 54);
  assert.strictEqual(over.modelTotalShrunk, 46.25);
  assert.strictEqual(over.marketLine, 38.5);
  assert.strictEqual(over.modelLineGap, 15.5);
  assert.strictEqual(over.gapFlag, true);
  assert.strictEqual(under.gapFlag, true);
  assert.strictEqual(under.modelLineGap, 15.5);

  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let gated;
  try {
    gated = applyGates(cands);
  } finally {
    console.log = orig;
  }
  assert.ok(gated.yesPool.every(c => !(c.market === 'Total' && c.gapFlag === true)));
  const blocked = gated.rejected.filter(r => r.market === 'Total');
  assert.strictEqual(blocked.length, 2);
  assert.ok(blocked.every(r => r.rejectReason === 'model_line_gap_review'));
  assert.ok(blocked.every(r => r.modelLineGap === 15.5));
  assert.ok(logs.some(l => l.includes('model_line_gap_review') && l.includes('gap=15.5') && l.includes('line=38.5')));
  assert.ok(!selectStraights(gated.yesPool, 3).some(c => c.market === 'Total' && c.modelLineGap === 15.5));
  const tickets = optimizeParlay(gated.yesPool, [], {});
  const legs = tickets.length ? tickets[0].legs : [];
  assert.ok(!legs.some(l => /38\.5/.test(String(l.pick || ''))));
  assertEdgesNeverGrow(cands, ev);
}

// 47 vs 42.5 → shrunk 44.75, and the over edge is strictly smaller than the unshrunk path.
{
  const home = 'Kansas City Chiefs';
  const away = 'Buffalo Bills';
  const ev = event(home, away, 42.5, -3);
  const cands = projectFootball('NFL', ev, 2);
  const over = findSide(cands, 'Total', /^Over/);
  const under = findSide(cands, 'Total', /^Under/);
  assert.strictEqual(over.modelTotalRaw, 47);
  assert.strictEqual(over.modelTotalShrunk, 44.75);
  assert.strictEqual(over.marketLine, 42.5);
  assert.strictEqual(over.modelLineGap, 4.5);
  assert.strictEqual(over.gapFlag, false);
  assert.strictEqual(under.modelTotalShrunk, 44.75);
  assert.strictEqual(under.gapFlag, false);
  const beforeP = unshrunkModelRawP(over, ev);
  const after = signedEdge(over, over.modelRawP);
  const before = signedEdge(over, beforeP);
  assert.ok(after < before, `over edge ${after} not strictly under ${before}`);
  assert.ok(over.modelRawP < beforeP);
  assertEdgesNeverGrow(cands, ev);
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

// NCAAF margin λ is 0.6. A 10-point total gap blocks; 9.9 does not.
{
  const home = 'Ohio State Buckeyes';
  const away = 'Iowa Hawkeyes';
  const wide = projectFootball('NCAAF', event(home, away, 42, -7.5), 0);
  const over = findSide(wide, 'Total', /^Over/);
  assert.strictEqual(over.modelTotalRaw, 52);
  assert.strictEqual(over.modelLineGap, 10);
  assert.strictEqual(over.gapFlag, true);
  assert.strictEqual(gateReason(over), 'model_line_gap_review');
  const spread = wide.find(c => c.market === 'Spread' && c.side.startsWith(home));
  const marketMargin = round4(-spread.marketLine);
  const expected = round4(marketMargin + config.POINT_SHRINK.NCAAF.margin * (spread.modelMarginRaw - marketMargin));
  assert.strictEqual(spread.modelMarginShrunk, expected);
  const half = round4(marketMargin + 0.5 * (spread.modelMarginRaw - marketMargin));
  assert.notStrictEqual(spread.modelMarginShrunk, half);
  assertEdgesNeverGrow(wide, event(home, away, 42, -7.5));

  const close = projectFootball('NCAAF', event(home, away, 42.1, -3), 0);
  const closeOver = findSide(close, 'Total', /^Over/);
  assert.strictEqual(closeOver.modelLineGap, round4(52 - 42.1));
  assert.ok(Math.abs(closeOver.modelLineGap) < 10);
  assert.strictEqual(closeOver.gapFlag, false);
  assert.notStrictEqual(gateReason(closeOver), 'model_line_gap_review');
}

// Spread threshold uses margin versus −homeSpread. NFL 8 blocks the spread, not the moneyline.
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
    assert.strictEqual(gateReason(c), 'model_line_gap_review');
  }
  const ml = cands.find(c => c.market === 'Moneyline' && c.side === home);
  assert.strictEqual(ml.gapFlag, false);
  assert.notStrictEqual(gateReason(ml), 'model_line_gap_review');
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
  const on = projectFootball('NFL', event(home, away, 38.5, -3), 1.5);
  const onOver = findSide(on, 'Total', /^Over/);
  assert.strictEqual(onOver.modelTotalRaw, 46.5);
  assert.strictEqual(onOver.modelLineGap, 8);
  assert.strictEqual(onOver.gapFlag, true);
  assert.strictEqual(gateReason(onOver), 'model_line_gap_review');
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
  assert.strictEqual(pick.modelTotalShrunk, 44.75);

  const mlbPick = toPickObject({
    sport: 'MLB', market: 'Moneyline', side: 'New York Yankees',
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', matchup: 'Boston Red Sox @ New York Yankees',
    coverProb: 0.55, odds: -110, edgePct: 0.03, ev: 0.04,
  }, { modelVersion: config.MODEL_VERSION });
  for (const k of FOOTBALL_AUDIT_KEYS) assert.strictEqual(mlbPick[k], undefined, k);

  const pub = publicPicksPayload({
    model: config.MODEL_VERSION,
    candidateTable: [{ rank: 1, ...over }],
    rejections: [{ side: over.side, reason: 'model_line_gap_review', modelLineGap: 15.5, gapFlag: true }],
    picks: [pick],
    parlayLegs: [{
      type: '2-leg',
      units: '0.5u',
      combinedOdds: '+250',
      legs: [pick],
    }],
  });
  assert.strictEqual(pub.candidateTable, undefined);
  assert.deepStrictEqual(pub.rejections, []);
  const pubPick = pub.picks[0];
  const pubLeg = pub.parlayLegs[0].legs[0];
  for (const k of FOOTBALL_AUDIT_KEYS) {
    assert.strictEqual(pubPick[k], undefined, `public pick leaked ${k}`);
    assert.strictEqual(pubLeg[k], undefined, `public leg leaked ${k}`);
  }
  assert.strictEqual(pubPick.pick, pick.pick);
  assert.strictEqual(pubPick.sport, 'NFL');
  assert.ok(pubPick.odds);
  const blob = JSON.stringify(pub);
  for (const k of FOOTBALL_AUDIT_KEYS) assert.ok(!blob.includes(k), `public payload contains ${k}`);

  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(idx.includes('...footballAuditFields(c)'));
  assert.ok(idx.includes('...footballAuditFields(r)'));
}

// MLB and NHL candidates match the pre-change fixture, with no football audit fields.
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
