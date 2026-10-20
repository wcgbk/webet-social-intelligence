'use strict';
/**
 * v12.5.2: EV-first straights, parlay built from those straights,
 * parlay EV = joint probability × product of leg decimals − 1.
 * Distinct games take no correlation haircut. V1 no-edge grade, grade fields
 * on stored straights.
 * No network, no blobs.
 *
 * The 10/20 v12.5.1 card printed straights at negative EV and a parlay of
 * three different positive-EV sides. The retired 0.95^(n-1) haircut on those
 * distinct games printed -3.6%. Distinct games now keep the independent EV. The
 * saved Pistons diagnostic stores the raw gap as edgePct and does not store
 * modelRawP or fair separately; this file checks the new record shape with
 * synthetic inputs.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));
const { publishEdgeCard } = require(path.join(root, 'assemble'));
const { americanToDecimal } = require(path.join(root, 'odds_math'));
const { publicPicksPayload } = require('./netlify/functions/lib/public-picks');
const { selectV1, evFor } = require('./netlify/functions/lib/v1-lock/select-v1');
const { MODEL_VERSION_V1 } = require('./netlify/functions/lib/v1-lock/config-v1');

assert.strictEqual(config.MODEL_VERSION, 'v12.5.4-omega-vnext');
assert.strictEqual(MODEL_VERSION_V1, 'v1-lock-2.2');

function pos(overrides) {
  const odds = overrides.odds;
  return {
    sport: 'NHL',
    market: 'Moneyline',
    coverProb: 0.55,
    ev: 0.02,
    edgePct: 0.02,
    predictedClv: 1,
    uncertainty: 0.2,
    liquid: true,
    book: 'draftkings',
    bestDkHr: { book: 'draftkings', american: odds },
    commenceTime: '2026-10-20T23:00:00Z',
    line: null,
    ...overrides,
    odds,
  };
}

function parsePct(v) {
  const n = parseFloat(String(v == null ? '' : v).replace('%', ''));
  return Number.isFinite(n) ? n / 100 : null;
}

// Quality score still prefers the fat edge. The published straight is the higher EV.
{
  const chalk = pos({
    matchup: 'A @ B', homeTeam: 'B', awayTeam: 'A', side: 'B',
    odds: -110, ev: 0.02, edgePct: 0.08, coverProb: 0.55,
  });
  const dog = pos({
    matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C', side: 'C',
    odds: 180, ev: 0.09, edgePct: 0.02, coverProb: 0.40,
  });
  assert.ok(select.scoreCandidate(chalk) > select.scoreCandidate(dog));
  assert.strictEqual(select.selectStraights([chalk, dog], 1)[0].matchup, 'C @ D');
}

// A positive-EV alternate ranks ahead of a negative-EV main.
{
  const alt = pos({
    matchup: 'A @ B', homeTeam: 'B', awayTeam: 'A', side: 'Over 6.5', market: 'Total', line: 6.5,
    odds: -110, ev: 0.02, edgePct: 0.01, coverProb: 0.54, alternate: true,
  });
  const negMain = pos({
    matchup: 'C @ D', homeTeam: 'D', awayTeam: 'C', side: 'D',
    odds: -110, ev: -0.02, edgePct: 0.09, coverProb: 0.50, alternate: false, predictedClv: 3,
  });
  assert.ok(select.scoreCandidate(negMain) > select.scoreCandidate(alt));
  const ranked = select.selectStraights([negMain, alt], 2);
  assert.strictEqual(ranked[0].matchup, 'A @ B');
  assert.strictEqual(ranked[1].matchup, 'C @ D');
}

// Fill: every +EV side, one per game, before a negative-EV lean.
// The negative row has the higher quality score and still waits.
{
  const plusLow = pos({
    matchup: 'Jets @ Blues', homeTeam: 'Blues', awayTeam: 'Jets',
    side: 'Over 5.5', market: 'Total', line: 5.5,
    odds: -120, ev: 0.029, edgePct: 0.02, coverProb: 0.56,
  });
  const plusMid = pos({
    matchup: 'Kings @ Capitals', homeTeam: 'Capitals', awayTeam: 'Kings',
    side: 'Washington Capitals', odds: -150, ev: 0.02, edgePct: 0.015, coverProb: 0.61,
  });
  const plusSameGame = pos({
    matchup: 'Jets @ Blues', homeTeam: 'Blues', awayTeam: 'Jets',
    side: 'Winnipeg Jets', odds: 140, ev: 0.01, edgePct: 0.012, coverProb: 0.43,
  });
  const negSharp = pos({
    matchup: 'Avalanche @ Devils', homeTeam: 'Devils', awayTeam: 'Avalanche',
    side: 'Colorado Avalanche', odds: -110, ev: -0.01, edgePct: 0.09, coverProb: 0.51, predictedClv: 3,
  });
  const plusThird = pos({
    matchup: 'Leafs @ Jackets', homeTeam: 'Jackets', awayTeam: 'Leafs',
    side: 'Toronto Maple Leafs +1.5', market: 'Spread', line: 1.5,
    odds: -180, ev: 0.016, edgePct: 0.012, coverProb: 0.65,
  });
  const worse = pos({
    matchup: 'Canucks @ Home', homeTeam: 'Home', awayTeam: 'Canucks',
    side: 'Vancouver Canucks', odds: 250, ev: -0.06, edgePct: 0.04, coverProb: 0.27,
  });
  assert.ok(select.scoreCandidate(negSharp) > select.scoreCandidate(plusLow));
  const filled = select.fillNeverBlock([], [plusSameGame, negSharp, worse, plusMid, plusThird, plusLow], 3);
  assert.deepStrictEqual(filled.map(c => c.side), [
    'Over 5.5', 'Washington Capitals', 'Toronto Maple Leafs +1.5',
  ]);
  assert.ok(filled.every(c => c.ev > 0));
  assert.ok(!filled.some(c => /Avalanche|Canucks|Winnipeg Jets/.test(c.side)));
  const short = select.fillNeverBlock([], [plusLow, negSharp, worse], 3);
  assert.deepStrictEqual(short.map(c => c.side), ['Over 5.5', 'Colorado Avalanche', 'Vancouver Canucks']);
}

// 10/20 parlay legs, full precision, three distinct games. No haircut.
// The retired 0.95^(3-1) haircut is what printed -3.6%.
{
  const raw = [
    { sport: 'NHL', matchup: 'Winnipeg Jets @ St Louis Blues', side: 'Over 5.5', market: 'Total', odds: -120, coverProb: 0.5616895689658767, ev: 0.0298 },
    { sport: 'NHL', matchup: 'Los Angeles Kings @ Washington Capitals', side: 'Washington Capitals', market: 'Moneyline', odds: -150, coverProb: 0.612379530394655, ev: 0.0206 },
    { sport: 'NHL', matchup: 'Toronto Maple Leafs @ Columbus Blue Jackets', side: 'Toronto Maple Leafs +1.5', market: 'Spread', odds: -180, coverProb: 0.653529088648878, ev: 0.0166 },
  ];
  const dec = raw.reduce((s, l) => s * americanToDecimal(l.odds), 1);
  const p = raw.reduce((s, l) => s * l.coverProb, 1);
  const independent = p * dec - 1;
  const retired = p * Math.pow(0.95, 2) * dec - 1;
  assert.ok(independent > 0.06 && independent < 0.07, independent);
  assert.strictEqual(`${(retired * 100).toFixed(1)}%`, '-3.6%');
  const stats = parlay.comboStats(raw);
  assert.strictEqual(stats.correlationHaircut, '1');
  assert.strictEqual(stats.sameGameExtras, 0);
  assert.ok(Math.abs(stats.ev - independent) < 1e-12);
  assert.notStrictEqual(`${(stats.ev * 100).toFixed(1)}%`, '-3.6%');
  assert.ok(stats.combinedDecimal > 4.7 && stats.combinedDecimal < 4.8);
}

// Published card: those +EV sides are the straights. The parlay is those
// straights. Distinct games get factor 1, so joint EV stays the product.
{
  const over = pos({
    sport: 'NHL', matchup: 'Winnipeg Jets @ St Louis Blues',
    homeTeam: 'St Louis Blues', awayTeam: 'Winnipeg Jets',
    side: 'Over 5.5', market: 'Total', line: 5.5,
    odds: -120, coverProb: 0.5616895689658767, ev: 0.0298, edgePct: 0.029,
    book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -120 },
  });
  const caps = pos({
    sport: 'NHL', matchup: 'Los Angeles Kings @ Washington Capitals',
    homeTeam: 'Washington Capitals', awayTeam: 'Los Angeles Kings',
    side: 'Washington Capitals', market: 'Moneyline',
    odds: -150, coverProb: 0.612379530394655, ev: 0.0206, edgePct: 0.017,
    book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -150 },
  });
  const leafs = pos({
    sport: 'NHL', matchup: 'Toronto Maple Leafs @ Columbus Blue Jackets',
    homeTeam: 'Columbus Blue Jackets', awayTeam: 'Toronto Maple Leafs',
    side: 'Toronto Maple Leafs +1.5', market: 'Spread', line: 1.5,
    odds: -180, coverProb: 0.653529088648878, ev: 0.0166, edgePct: 0.017,
    book: 'draftkings', bestDkHr: { book: 'draftkings', american: -180 },
  });
  const avalanche = pos({
    sport: 'NHL', matchup: 'Colorado Avalanche @ New Jersey Devils',
    homeTeam: 'New Jersey Devils', awayTeam: 'Colorado Avalanche',
    side: 'Colorado Avalanche', odds: -110, coverProb: 0.518763447859645, ev: -0.0096, edgePct: 0.09,
    predictedClv: 3, book: 'draftkings', bestDkHr: { book: 'draftkings', american: -110 },
  });
  const capsOpp = pos({
    sport: 'NHL', matchup: caps.matchup, homeTeam: caps.homeTeam, awayTeam: caps.awayTeam,
    side: 'Los Angeles Kings', odds: 130, coverProb: 0.39, ev: -0.10, edgePct: -0.02,
    book: 'draftkings', bestDkHr: { book: 'draftkings', american: 130 },
  });
  const under = pos({
    sport: 'NHL', matchup: over.matchup, homeTeam: over.homeTeam, awayTeam: over.awayTeam,
    side: 'Under 5.5', market: 'Total', line: 5.5,
    odds: 100, coverProb: 0.44, ev: -0.12, edgePct: -0.02,
    book: 'draftkings', bestDkHr: { book: 'draftkings', american: 100 },
  });
  const card = publishEdgeCard({
    positions: [avalanche, under, capsOpp, leafs, caps, over],
    qualified: [],
    yesPool: [],
    rejected: [],
    miscalibrated: [],
    hardFails: [],
    cardDate: '2026-10-20',
    modelVersion: config.MODEL_VERSION,
    dateFormatted: 'Tuesday, October 20, 2026',
  });
  assert.strictEqual(card.picks.length, 3);
  assert.ok(card.picks.every(p => parsePct(p.ev) > 0), card.picks.map(p => `${p.pick} ${p.ev}`).join(' | '));
  assert.ok(!card.picks.some(p => /Avalanche/.test(p.pick)));
  const names = card.picks.map(p => p.pick).sort();
  assert.deepStrictEqual(names, ['Over 5.5', 'Toronto Maple Leafs +1.5', 'Washington Capitals ML']);
  for (const p of card.picks) {
    assert.ok(p.rating && p.grade && p.qualityGrade, p.pick);
    assert.strictEqual(p.grade, p.rating);
    assert.strictEqual(p.qualityGrade, p.rating);
  }
  assert.strictEqual(card.parlayLegs.length, 1);
  const ticket = card.parlayLegs[0];
  assert.strictEqual(ticket.legs.length, 3);
  const legNames = ticket.legs.map(l => l.pick).sort();
  assert.deepStrictEqual(legNames, names);
  assert.ok(ticket.legs.every(l => parsePct(l.ev) > 0));
  for (const leg of ticket.legs) {
    const straight = card.picks.find(p => p.pick === leg.pick);
    assert.ok(straight, leg.pick);
    assert.strictEqual(parlay.conflictsWithStraight(leg, straight), false);
  }
  assert.strictEqual(ticket.correlationHaircut, '1');
  assert.ok(/published straights/i.test(ticket.correlationNote), ticket.correlationNote);
  assert.ok(!/0\.95\^/.test(ticket.correlationNote), ticket.correlationNote);
  assert.ok(/product of leg decimals/i.test(ticket.correlationNote), ticket.correlationNote);
  const shown = ticket.legs.map(l => ({
    odds: parseFloat(String(l.odds).replace(/[^0-9.+-]/g, '')),
    coverProb: parsePct(l.coverProb),
    matchup: l.matchup,
    sport: l.sport,
  }));
  const shownP = shown.reduce((s, l) => s * l.coverProb, 1);
  const shownDec = shown.reduce((s, l) => s * americanToDecimal(l.odds), 1);
  const shownIndependent = shownP * shownDec - 1;
  assert.ok(shownIndependent > 0, shownIndependent);
  const stats = parlay.comboStats(shown);
  assert.strictEqual(stats.correlationHaircut, '1');
  assert.ok(Math.abs(stats.ev - shownIndependent) < 1e-12);
  assert.strictEqual(ticket.ev, `${(stats.ev * 100).toFixed(1)}%`);
  assert.strictEqual(ticket.lean, false);
  assert.notStrictEqual(ticket.flag, 'parlay-lean');
  assert.ok(card.rejections.some(r => r.reason === 'conflict-with-straight' && /Kings/.test(r.side || '')));
  assert.ok(card.rejections.some(r => r.reason === 'conflict-with-straight' && /Under 5\.5/.test(r.side || '')));

  const qualifying = select.toPickObject(pos({
    matchup: 'Home @ Away', homeTeam: 'Away', awayTeam: 'Home', side: 'Home',
    odds: -110, ev: 0.05, edgePct: 0.04, coverProb: 0.56, predictedClv: 1, uncertainty: 0.12,
  }), { modelVersion: config.MODEL_VERSION });
  assert.strictEqual(qualifying.rating, 'a');
  assert.strictEqual(qualifying.grade, 'a');
  assert.strictEqual(qualifying.qualityGrade, 'a');

  const stored = publicPicksPayload({
    model: config.MODEL_VERSION,
    picks: card.picks.concat([qualifying]),
    parlayLegs: card.parlayLegs,
    rejections: card.rejections,
    candidateTable: [{ secret: true }],
  });
  assert.strictEqual(stored.rejections.length, 0);
  assert.ok(stored.picks.every(p => p.rating && p.grade && p.qualityGrade));
  assert.ok(stored.picks.some(p => p.rating === 'a' && p.grade === 'a' && p.qualityGrade === 'a'));
  assert.strictEqual(stored.parlayLegs[0].correlationHaircut, '1');
  assert.ok(!/0\.95\^/.test(stored.parlayLegs[0].correlationNote));
}

// Pre-calibration gate keeps modelRawP and fair on the record. Synthetic gap, not the 10/20 card.
{
  const wild = {
    sport: 'NBA', market: 'Spread', side: 'Home +1.5',
    matchup: 'Away @ Home', line: 1.5, odds: -110, book: 'fanduel',
    modelRawP: 0.64, fair_sharp_p: 0.50, coverProb: 0.54, ev: 0.03, edgePct: 0.04,
  };
  const calm = {
    sport: 'NBA', market: 'Moneyline', side: 'Calm',
    matchup: 'X @ Y', odds: -110, modelRawP: 0.55, fair_sharp_p: 0.50,
  };
  const split = select.splitRawMiscalibrated([wild, calm]);
  assert.strictEqual(split.candidates.length, 1);
  assert.strictEqual(split.candidates[0].side, 'Calm');
  assert.strictEqual(split.miscalibrated.length, 1);
  const rec = split.miscalibrated[0];
  assert.strictEqual(rec.stage, 'pre-calibration');
  assert.strictEqual(rec.reason, 'edge-over-10pp');
  assert.strictEqual(rec.modelRawP, 0.64);
  assert.strictEqual(rec.fair, 0.5);
  assert.strictEqual(rec.edgePct, 0.14);
  assert.strictEqual(rec.line, 1.5);
}

// V1: edge 0.48pp with EV>0 is no-edge, and EV<=0 is no-edge. Qualifying stays a letter.
{
  const meta = {
    sport: 'NHL', market: 'Total', line: 6.5, fallback: true,
    confirmedBook: 'Hard Rock Bet', book: 'hardrockbet',
    commenceTime: '2026-10-20T23:00:00Z',
    formulaInputs: { method: 'test' },
  };
  const thin = selectV1([{
    ...meta,
    matchup: 'Winnipeg Jets @ St Louis Blues',
    awayTeam: 'Winnipeg Jets', homeTeam: 'St Louis Blues',
    side: 'Over 6.5', trueProbability: 0.52, odds: 100, oddsStr: '+100',
    edge: 0.004778,
  }], []);
  assert.ok(evFor(0.52, 100) > 0);
  assert.strictEqual(thin.picks.length, 1);
  assert.strictEqual(thin.picks[0].rating, 'no-edge');
  assert.strictEqual(thin.picks[0].flag, 'no-edge-lean');
  assert.ok(thin.picks[0].filterFlags.includes('no-edge-lean'));
  assert.strictEqual(thin.picks[0].grade, 'no-edge');
  assert.strictEqual(thin.picks[0].units, '0.5u');
  assert.strictEqual(thin.picks[0].model, 'v1-lock-2.2');
  assert.ok(parseFloat(thin.picks[0].ev) > 0);

  const neg = selectV1([{
    ...meta,
    matchup: 'Carolina Hurricanes @ Vancouver Canucks',
    awayTeam: 'Carolina Hurricanes', homeTeam: 'Vancouver Canucks',
    side: 'Vancouver Canucks', market: 'Moneyline', line: null,
    trueProbability: 0.45, odds: -110, oddsStr: '-110', edge: 0.015,
  }], []);
  assert.ok(evFor(0.45, -110) <= 0);
  assert.strictEqual(neg.picks[0].rating, 'no-edge');
  assert.strictEqual(neg.picks[0].flag, 'no-edge-lean');
  assert.strictEqual(neg.picks[0].units, '0.5u');

  const real = selectV1([{
    sport: 'NHL', matchup: 'Los Angeles Kings @ Washington Capitals',
    awayTeam: 'Los Angeles Kings', homeTeam: 'Washington Capitals',
    side: 'Washington Capitals', market: 'Moneyline', line: null, fallback: true,
    trueProbability: 0.56, odds: -110, oddsStr: '-110', pPinnacle: 0.52,
    confirmedBook: 'Hard Rock Bet', book: 'hardrockbet',
    commenceTime: '2026-10-20T23:00:00Z',
    formulaInputs: { method: 'test' },
  }], []);
  assert.ok(evFor(0.56, -110) > 0);
  assert.ok(0.56 - 0.52 >= 0.01);
  assert.notStrictEqual(real.picks[0].rating, 'no-edge');
  assert.notStrictEqual(real.picks[0].flag, 'no-edge-lean');
}

console.log('PASS test-omega-fixes-1020b');
