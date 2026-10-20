'use strict';
/**
 * v12.5.3 / v1-lock-2.2: positive-edge fills keep their grade and Kelly size,
 * parlay haircut is same-game only, V1 no-edge grade, page label and ET.
 * No network, no blobs.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));
const { publishEdgeCard } = require(path.join(root, 'assemble'));
const { americanToDecimal } = require(path.join(root, 'odds_math'));
const { selectV1, parlayFromPicksV1, decFromAmerican } = require('./netlify/functions/lib/v1-lock/select-v1');
const { MODEL_VERSION_V1 } = require('./netlify/functions/lib/v1-lock/config-v1');

assert.strictEqual(config.MODEL_VERSION, 'v12.5.3-omega-vnext');
assert.strictEqual(MODEL_VERSION_V1, 'v1-lock-2.2');

function row(overrides) {
  const odds = overrides.odds != null ? overrides.odds : -110;
  return {
    sport: 'NHL',
    market: 'Total',
    homeTeam: 'St Louis Blues',
    awayTeam: 'Winnipeg Jets',
    matchup: 'Winnipeg Jets @ St Louis Blues',
    side: 'Over 5.5',
    line: 5.5,
    coverProb: 0.5617,
    ev: 0.03,
    edgePct: 0.029,
    book: 'hardrockbet',
    bestDkHr: { book: 'hardrockbet', american: odds },
    commenceTime: '2026-10-20T23:00:00Z',
    leanFill: true,
    ...overrides,
    odds,
  };
}

function publish(positions) {
  return publishEdgeCard({
    positions,
    qualified: [],
    yesPool: [],
    rejected: [],
    miscalibrated: [],
    hardFails: [],
    cardDate: '2026-10-20',
    modelVersion: config.MODEL_VERSION,
    dateFormatted: 'Tuesday, October 20, 2026',
  });
}

// Jets @ Blues Over 5.5 -120, edge 2.90pp, EV 3.0%. Fill keeps A- at 1u Kelly.
{
  const jets = row({ odds: -120, coverProb: 0.5617, ev: 0.03, edgePct: 0.029 });
  const pick = select.toPickObject(jets, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(pick.rating, 'aminus');
  assert.strictEqual(pick.grade, 'aminus');
  assert.strictEqual(pick.qualityGrade, 'aminus');
  assert.strictEqual(pick.units, '1u');
  assert.notStrictEqual(pick.flag, 'no-edge-lean');
  assert.ok(!pick.lean);

  const card = publish([jets]);
  assert.strictEqual(card.picks.length, 1);
  assert.strictEqual(card.picks[0].rating, 'aminus');
  assert.strictEqual(card.picks[0].grade, 'aminus');
  assert.strictEqual(card.picks[0].units, '1u');
  assert.notStrictEqual(card.picks[0].flag, 'no-edge-lean');
}

// No-edge fills: edge <= 0, or EV <= 0, are 0.5u and labelled no-edge.
{
  const flatEdge = row({ edgePct: 0, ev: 0.03, odds: -120 });
  const flat = select.toPickObject(flatEdge, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(flat.rating, 'no-edge');
  assert.strictEqual(flat.grade, 'no-edge');
  assert.strictEqual(flat.qualityGrade, 'no-edge');
  assert.strictEqual(flat.units, '0.5u');
  assert.strictEqual(flat.flag, 'no-edge-lean');

  const negEv = row({ edgePct: 0.029, ev: -0.01, odds: -120 });
  const neg = select.toPickObject(negEv, { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(neg.rating, 'no-edge');
  assert.strictEqual(neg.grade, 'no-edge');
  assert.strictEqual(neg.units, '0.5u');
  assert.strictEqual(neg.flag, 'no-edge-lean');

  const dead = row({
    matchup: 'Carolina Hurricanes @ Vancouver Canucks',
    homeTeam: 'Vancouver Canucks',
    awayTeam: 'Carolina Hurricanes',
    side: 'Under 6',
    edgePct: -0.02,
    ev: -0.04,
    coverProb: 0.45,
    odds: -110,
  });
  const card = publish([dead]);
  assert.strictEqual(card.picks[0].rating, 'no-edge');
  assert.strictEqual(card.picks[0].grade, 'no-edge');
  assert.strictEqual(card.picks[0].units, '0.5u');
  assert.strictEqual(card.picks[0].flag, 'no-edge-lean');

  const real = select.toPickObject(row({ leanFill: false, edgePct: 0.04, ev: -0.01 }), { modelVersion: config.MODEL_VERSION });
  assert.notStrictEqual(real.rating, 'no-edge');
  assert.notStrictEqual(real.flag, 'no-edge-lean');
}

// Haircut 0.95 only for each extra leg that shares a game.
{
  const leg = (matchup, coverProb) => ({
    sport: 'NHL', matchup, odds: -110, coverProb, ev: 0.04,
  });
  const distinct = [leg('A @ B', 0.55), leg('C @ D', 0.56), leg('E @ F', 0.57)];
  const dec = distinct.reduce((s, l) => s * americanToDecimal(l.odds), 1);
  const p = distinct.reduce((s, l) => s * l.coverProb, 1);
  const none = parlay.comboStats(distinct);
  assert.strictEqual(none.sameGameExtras, 0);
  assert.strictEqual(none.correlationHaircut, '1');
  assert.strictEqual(none.correlationFactor, 1);
  assert.ok(Math.abs(none.ev - (p * dec - 1)) < 1e-12);

  const oneExtra = [leg('A @ B', 0.55), leg('A @ B', 0.56), leg('E @ F', 0.57)];
  const p1 = oneExtra.reduce((s, l) => s * l.coverProb, 1);
  const one = parlay.comboStats(oneExtra);
  assert.strictEqual(one.sameGameExtras, 1);
  assert.strictEqual(one.correlationHaircut, '0.95^(1)');
  assert.ok(Math.abs(one.correlationFactor - 0.95) < 1e-12);
  assert.ok(Math.abs(one.ev - (p1 * 0.95 * dec - 1)) < 1e-12);

  const allSame = [leg('A @ B', 0.55), leg('A @ B', 0.56), leg('A @ B', 0.57)];
  const p2 = allSame.reduce((s, l) => s * l.coverProb, 1);
  const two = parlay.comboStats(allSame);
  assert.strictEqual(two.sameGameExtras, 2);
  assert.strictEqual(two.correlationHaircut, '0.95^(2)');
  assert.ok(Math.abs(two.ev - (p2 * Math.pow(0.95, 2) * dec - 1)) < 1e-12);
}

// V1: same haircut rule, and no-edge picks carry grade no-edge.
{
  const v1Leg = (matchup) => ({ matchup, odds: -110, trueProbability: 0.55 });
  const distinct = parlayFromPicksV1([v1Leg('A @ B'), v1Leg('C @ D'), v1Leg('E @ F')])[0];
  const dec = Math.pow(decFromAmerican(-110), 3);
  const independent = (0.55 ** 3) * dec - 1;
  assert.strictEqual(distinct.correlationHaircut, '1');
  assert.strictEqual(distinct.ev, `${(independent * 100).toFixed(1)}%`);

  const shared = parlayFromPicksV1([v1Leg('A @ B'), v1Leg('A @ B'), v1Leg('E @ F')])[0];
  const hair = (0.55 ** 3) * 0.95 * dec - 1;
  assert.strictEqual(shared.correlationHaircut, '0.95^(1)');
  assert.strictEqual(shared.ev, `${(hair * 100).toFixed(1)}%`);

  const meta = {
    sport: 'NHL', market: 'Total', line: 6.5, fallback: true,
    confirmedBook: 'Hard Rock Bet', book: 'hardrockbet',
    commenceTime: '2026-10-20T23:00:00Z',
    formulaInputs: { method: 'test' },
    matchup: 'Winnipeg Jets @ St Louis Blues',
    awayTeam: 'Winnipeg Jets', homeTeam: 'St Louis Blues',
    side: 'Over 6.5', trueProbability: 0.52, odds: 100, oddsStr: '+100',
    edge: 0.004778,
  };
  const thin = selectV1([meta], []);
  assert.strictEqual(thin.picks[0].rating, 'no-edge');
  assert.strictEqual(thin.picks[0].grade, 'no-edge');
  assert.strictEqual(thin.picks[0].flag, 'no-edge-lean');
  assert.strictEqual(thin.picks[0].units, '0.5u');
  assert.strictEqual(thin.picks[0].model, 'v1-lock-2.2');
}

// Pages: no-edge badge, and game times say ET.
{
  for (const rel of ['v1/index.html', 'daily-omega/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(html.includes("'no-edge':'badge-no-edge'"), rel);
    assert.ok(html.includes("'no-edge':'No edge'"), rel);
    assert.ok(html.includes("'no-edge': 'no-edge'"), rel);
    assert.ok(html.includes('.badge-no-edge'), rel);
    assert.ok(html.includes(".badge-lean, .badge-no-edge"), rel);
    assert.ok(html.includes("+ ' ET'"), rel);
    assert.ok(!html.includes("+ ' EST'"), rel);
    assert.ok(!html.includes("t + ' EST'"), rel);
  }
}

console.log('PASS test-omega-fixes-1020c');
