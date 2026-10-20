'use strict';
/**
 * NBA on the 2026-10-20 card.
 * Pinnacle de-vig on the same point, shared shrink, DK/Hard Rock price,
 * the same sizing as the other sports, never-block, and the parlay guard.
 * No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const nba = require(path.join(root, 'sports/nba'));
const shadow = require(path.join(root, 'nba_shadow'));
const calibrate = require(path.join(root, 'calibrate'));
const edge = require(path.join(root, 'edge'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));
const { publishEdgeCard } = require(path.join(root, 'assemble'));
const { projectAll } = require(path.join(root, 'index'));
const { noVigTwoWay } = require(path.join(root, 'odds_math'));
const { projectAllV1 } = require('./netlify/functions/lib/v1-lock/project-v1');
const { selectV1 } = require('./netlify/functions/lib/v1-lock/select-v1');
const { SPORTS_V1, unitsForGradeV1 } = require('./netlify/functions/lib/v1-lock/config-v1');

const CARD = '2026-10-20';
const COMMENCE = '2026-10-20T23:30:00Z';
const AS_OF = Date.parse('2026-10-20T16:00:00Z');

assert.strictEqual(config.MODEL_VERSION, 'v12.5.3-omega-vnext');
assert.strictEqual(config.SPORTS_ENABLED.NBA, true);
assert.strictEqual(config.NBA_CARD_LIVE, true);
assert.strictEqual(config.nbaCardEnabled(), true);
assert.strictEqual(config.ODDS_SPORT_KEYS.NBA, 'basketball_nba');
assert.ok(SPORTS_V1.includes('NBA'));
assert.strictEqual(calibrate.shrinkKForMarket('Moneyline', 'NBA'), calibrate.shrinkKForMarket('Moneyline', 'NFL'));
assert.strictEqual(calibrate.shrinkKForMarket('Spread', 'NBA'), config.SHRINK_K.Spread);
assert.strictEqual(calibrate.shrinkKForMarket('Total', 'NBA'), config.SHRINK_K.Total);
assert.strictEqual(config.GATES.minEV.NBA, config.GATES.minEV.default);
assert.strictEqual(config.MAX_STRAIGHT_UNITS_PER_PICK, 1.25);

function bk(key, home, away, spec) {
  const markets = [];
  if (spec.homeMl != null) {
    markets.push({ key: 'h2h', outcomes: [
      { name: home, price: spec.homeMl },
      { name: away, price: spec.awayMl },
    ] });
  }
  if (spec.spread != null) {
    markets.push({ key: 'spreads', outcomes: [
      { name: home, price: spec.homeSpread, point: spec.spread },
      { name: away, price: spec.awaySpread, point: -spec.spread },
    ] });
  }
  if (spec.total != null) {
    markets.push({ key: 'totals', outcomes: [
      { name: 'Over', price: spec.over, point: spec.total },
      { name: 'Under', price: spec.under, point: spec.total },
    ] });
  }
  return { key, markets };
}

function event(home, away, books) {
  return {
    sport: 'NBA',
    home_team: home,
    away_team: away,
    commence_time: COMMENCE,
    bookmakers: books,
  };
}

function pricedEvent(home, away, opts = {}) {
  const spread = opts.pinSpread != null ? opts.pinSpread : -2.5;
  const pin = {
    homeMl: -130, awayMl: 110,
    spread, homeSpread: -110, awaySpread: -110,
    total: 220.5, over: -110, under: -110,
  };
  const maker = {
    homeMl: -150, awayMl: 130,
    spread: -2.5, homeSpread: -140, awaySpread: 120,
    total: 220.5, over: -115, under: -105,
  };
  const dk = {
    homeMl: 130, awayMl: -150,
    spread: -2.5, homeSpread: -110, awaySpread: -110,
    total: 220.5, over: -108, under: -112,
  };
  const hr = {
    homeMl: 125, awayMl: -145,
    spread: -2.5, homeSpread: -105, awaySpread: -115,
    total: 220.5, over: -102, under: -118,
  };
  const fd = {
    homeMl: 135, awayMl: -155,
    spread: -2.5, homeSpread: -102, awaySpread: -118,
    total: 220.5, over: 100, under: -120,
  };
  return event(home, away, [
    bk('pinnacle', home, away, pin),
    bk('bookmaker', home, away, maker),
    bk('draftkings', home, away, dk),
    bk('hardrockbet', home, away, hr),
    bk('fanduel', home, away, fd),
  ]);
}

function bySide(rows, market, side) {
  return rows.find((c) => c.market === market && c.side === side);
}

function parseU(u) {
  return parseFloat(String(u == null ? '' : u).replace(/[^0-9.]/g, '')) || 0;
}

const games = [
  pricedEvent('Boston Celtics', 'New York Knicks', { pinSpread: -3.5 }),
  pricedEvent('Golden State Warriors', 'Los Angeles Lakers'),
  pricedEvent('Milwaukee Bucks', 'Miami Heat'),
];

{
  const raw = nba.project({ oddsEvents: [games[0]], forCard: true });
  assert.ok(raw.length >= 6, `card rows ${raw.length}`);
  assert.ok(raw.every((c) => c.shadowOnly !== true && c.sport === 'NBA'));
  const markets = new Set(raw.map((c) => c.market));
  assert.ok(markets.has('Moneyline') && markets.has('Spread') && markets.has('Total'));

  const ml = bySide(raw, 'Moneyline', 'Boston Celtics');
  assert.ok(ml, 'home moneyline');
  const pinFair = noVigTwoWay(-130, 110);
  assert.ok(Math.abs(ml.fair_sharp_p - pinFair.p1) < 1e-9, `pinnacle fair ${ml.fair_sharp_p} vs ${pinFair.p1}`);
  assert.strictEqual(ml.p_pinnacle, ml.fair_sharp_p);
  assert.strictEqual(ml.sharpAnchorBook, 'pinnacle');
  assert.ok(Math.abs(ml.modelRawP - ml.fair_sharp_p) > 0.005, 'model is the shrink input');
  assert.ok(ml.bestDkHr && ml.bestDkHr.american === 130 && ml.bestDkHr.book === 'draftkings');

  const moved = bySide(raw, 'Spread', 'Boston Celtics -2.5');
  assert.ok(moved, 'DK spread is -2.5');
  assert.strictEqual(moved.p_pinnacle, null, 'Pinnacle -3.5 is not this point');
  const makerFair = noVigTwoWay(-140, 120);
  assert.ok(Math.abs(moved.fair_sharp_p - makerFair.p1) < 1e-9, `sharp fallback ${moved.fair_sharp_p} vs ${makerFair.p1}`);
  assert.ok(Math.abs(moved.fair_sharp_p - 0.5) > 0.02, 'the other point was not shifted onto -2.5');
  assert.strictEqual(moved.sharpAnchorBook, null);

  const shadowRows = nba.project({ oddsEvents: [games[0]] });
  const shadowMl = bySide(shadowRows, 'Moneyline', 'Boston Celtics');
  assert.strictEqual(shadowMl.shadowOnly, true);
  assert.ok(Math.abs(shadowMl.p_fair - shadowMl.p_pinnacle) < 1e-12, 'observer stays blend 0');

  const cal = calibrate.calibrateCandidate(ml);
  const shrunkP = calibrate.shrinkTowardSharp(ml.modelRawP, ml.fair_sharp_p, ml.market, 'NBA');
  const expected = ml.fair_sharp_p + calibrate.compressEdge(shrunkP - ml.fair_sharp_p);
  assert.ok(Math.abs(cal.coverProb - expected) < 1e-12, `${cal.coverProb} vs ${expected}`);
  assert.strictEqual(cal.calibK, config.SHRINK_K.Moneyline);
  assert.ok(Math.abs(cal.coverProb - ml.fair_sharp_p) < Math.abs(ml.modelRawP - ml.fair_sharp_p));
}

const rawAll = nba.project({ oddsEvents: games, forCard: true });
const calibrated = calibrate.calibrateAll(rawAll).map((c) => edge.attachEv(c));
const prepared = select.prepareEdgePositions(calibrated);
const homeMl = prepared.positions.find((c) => c.sport === 'NBA' && c.market === 'Moneyline' && c.side === 'Boston Celtics');
assert.ok(homeMl, 'prepared home moneyline');
assert.strictEqual(homeMl.odds, 130);
assert.strictEqual(homeMl.book, 'draftkings');
assert.ok(homeMl.ev > config.GATES.minEV.NBA, `ev ${homeMl.ev}`);
assert.ok(homeMl.ev > shadow.OBSERVER.maxEV, `card ev ${homeMl.ev} is outside the observer cap`);

{
  const pick = select.toPickObject(homeMl);
  const twin = select.toPickObject({ ...homeMl, sport: 'NHL' });
  assert.strictEqual(pick.units, twin.units, 'NBA Kelly units match the other sports');
  assert.ok(parseU(pick.units) > 0.5, `no 0.5u NBA cap, got ${pick.units}`);
  assert.ok(parseU(pick.units) <= config.MAX_STRAIGHT_UNITS_PER_PICK + 1e-9);
  const wide = {
    ...homeMl,
    ev: 0.15,
    odds: 150,
    coverProb: 0.58,
    edgePct: 0.04,
    predictedClv: 1,
    liquid: true,
    placeable: true,
    commenceTime: COMMENCE,
  };
  assert.strictEqual(gates.gateReason(wide, { cardDate: CARD, asOfMs: AS_OF }), null);
  assert.strictEqual(
    shadow.observerReason({ ...wide, p_pinnacle: 0.5, p_fair: 0.5, price: 150 }, { dateISO: CARD }),
    'ev-cap'
  );
}

{
  const { yesPool, rejected } = gates.applyGates(prepared.positions, { cardDate: CARD, asOfMs: AS_OF });
  assert.ok(yesPool.some((c) => c.sport === 'NBA'), 'NBA clears the shared gates');
  assert.ok(!rejected.some((c) => c.rejectReason === 'ev-cap'));
  const chosen = select.selectStraights(yesPool, 3);
  const card = publishEdgeCard({
    positions: prepared.positions,
    qualified: chosen,
    yesPool,
    rejected,
    miscalibrated: prepared.diagnostics.miscalibrated,
    hardFails: [],
    cardDate: CARD,
    modelVersion: config.MODEL_VERSION,
    dateFormatted: CARD,
  });
  assert.strictEqual(card.picks.length, 3, `straights ${card.picks.length}`);
  assert.strictEqual(card.parlayLegs.length, 1);
  assert.strictEqual((card.parlayLegs[0].legs || []).length, 3);
  for (const leg of card.parlayLegs[0].legs) {
    assert.ok(!card.picks.some((straight) => parlay.conflictsWithStraight(leg, straight)), `${leg.pick || leg.side} opposes a straight`);
  }
  assert.ok(
    card.rejections.some((r) => r.reason === 'conflict-with-straight' && r.sport === 'NBA'),
    'opposing NBA leg is rejected by the parlay guard'
  );
  const snap = {
    oddsBySport: { MLB: [], NFL: [], NCAAF: [], NHL: [], NBA: games },
    standingsBySport: { NBA: {} },
    espnBySport: {},
    efficiencyBySport: { NFL: {}, NCAAF: {} },
    parkFactors: {},
    mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
    gameDay: {},
  };
  const slate = projectAll(snap);
  assert.ok(slate.some((c) => c.sport === 'NBA' && c.shadowOnly !== true));
  assert.ok(slate.length >= rawAll.length);
}

{
  const fav = (home, away) => event(home, away, [
    bk('pinnacle', home, away, { homeMl: -250, awayMl: 200 }),
    bk('draftkings', home, away, { homeMl: -190, awayMl: 170 }),
    bk('hardrockbet', home, away, { homeMl: -210, awayMl: 175 }),
  ]);
  const v1Events = [
    fav('Boston Celtics', 'New York Knicks'),
    fav('Golden State Warriors', 'Los Angeles Lakers'),
    fav('Milwaukee Bucks', 'Miami Heat'),
  ];
  const projected = projectAllV1(v1Events, {}, {});
  assert.ok(projected.candidates.length >= 3, `v1 candidates ${projected.candidates.length}`);
  assert.ok(projected.candidates.every((c) => c.sport === 'NBA'));
  assert.ok(!projected.passes.some((p) => /sport|allow/i.test(String(p.reason || ''))), JSON.stringify(projected.passes));
  const home = projected.candidates.find((c) => c.market === 'Moneyline' && c.side === 'Boston Celtics');
  assert.ok(home && home.trueProbability > 0.65, `v1 fair ${home && home.trueProbability}`);
  assert.strictEqual(home.book, 'draftkings');
  const sel = selectV1(projected.candidates, projected.passes);
  assert.strictEqual(sel.picks.length, 3);
  assert.strictEqual((sel.parlayLegs[0] && sel.parlayLegs[0].legs || []).length, 3);
  const strict = sel.picks.find((p) => parseU(p.units) > 0.5);
  assert.ok(strict, `V1 NBA straight uses the shared grade stake, picks=${sel.picks.map((p) => `${p.units}/${p.grade}`).join(',')}`);
  assert.strictEqual(parseU(strict.units), unitsForGradeV1(strict.grade));
}

console.log('test-omega-nba-1020 ok');
