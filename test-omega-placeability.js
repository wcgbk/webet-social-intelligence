'use strict';
/** Omega v12.2.1 placeability soft-veto — no network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const edge = require(path.join(root, 'edge'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const parlay = require(path.join(root, 'parlay'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.12-omega-vnext-desk-lock');
assert.strictEqual(config.PLACEABILITY.minMajorBooks, 2);
assert.strictEqual(config.PLACEABILITY.maxImpliedWorsePp, 3);
assert.strictEqual(config.PLACEABILITY.maxAmericanCentsWorse, 15);
assert.ok(/placeability soft-veto/i.test(config.MODEL_NOTES));
assert.ok(config.US_BOOK_PRIORITY.includes('draftkings'));
assert.ok(config.US_BOOK_PRIORITY.includes('hardrockbet'));
assert.ok(!config.US_BOOK_PRIORITY.includes('pinnacle'), 'placeability is US retail, not sharp');
assert.ok(!config.US_BOOK_PRIORITY.includes('barstool'));
assert.ok(!config.US_BOOK_PRIORITY.includes('wynnbet'));
assert.ok(!config.US_BOOK_PRIORITY.includes('superbook'));
assert.strictEqual(config.LEAN_PAD, false);
assert.strictEqual(config.DAILY_UNIT_CAP, 4.0);
assert.strictEqual(config.STRAIGHT_UNIT_BUDGET, 3.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.LINE_MOVE.rejectSteamAgainstCents, 18);
assert.strictEqual(config.QUALITY_GRADE.aplus, 0.05);
assert.strictEqual(config.QUALITY_GRADE.a, 0.035);
assert.strictEqual(config.QUALITY_GRADE.aminus, 0.02);
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.SPORTS_ENABLED.NHL, false);
assert.strictEqual(config.DAY_SCOPE_STRICT, true);

// Juice ballpark: either ≤15 American cents worse OR ≤3 implied pp worse.
assert.strictEqual(edge.withinPlaceableJuice(-125, -110), true, '15 cents worse still counts');
assert.strictEqual(edge.withinPlaceableJuice(-120, -110), true);
assert.strictEqual(edge.withinPlaceableJuice(-130, -110), false, '20 cents and >3pp is outside');
assert.strictEqual(edge.withinPlaceableJuice(-105, -110), true, 'better price counts');
assert.strictEqual(edge.withinPlaceableJuice(180, 200), true, '20 cents but ≤3pp still counts');
assert.strictEqual(edge.withinPlaceableJuice(130, 200), false);

// Sharp-only quotes do not satisfy US retail placeability.
{
  const onlySharp = edge.assessPlaceability([
    { book: 'pinnacle', american: -110 },
    { book: 'circa', american: -110 },
    { book: 'bovada', american: -110 },
  ], -110, null);
  assert.deepStrictEqual(onlySharp.placeableBooks, []);
  assert.strictEqual(onlySharp.placeable, false);
  assert.strictEqual(onlySharp.bestPlaceable, null);
}

// One US major is not enough, even next to Pinnacle. A far price does not count.
{
  const thin = edge.assessPlaceability([
    { book: 'pinnacle', american: -110 },
    { book: 'draftkings', american: -110 },
    { book: 'fanduel', american: -130 },
  ], -110, -1.5);
  assert.deepStrictEqual(thin.placeableBooks, ['draftkings']);
  assert.strictEqual(thin.placeable, false);
  assert.deepStrictEqual(thin.bestPlaceable, { book: 'draftkings', american: -110, point: -1.5 });
}

// ≥N majors inside the ballpark. Hard Rock state aliases count once. Best price wins.
{
  const ok = edge.assessPlaceability([
    { book: 'hardrockbet', american: -110 },
    { book: 'hardrockbet_oh', american: -108 },
    { book: 'fanduel', american: -112 },
    { book: 'betmgm', american: -125 },
    { book: 'pinnacle', american: -105 },
  ], -110, -3);
  assert.deepStrictEqual(ok.placeableBooks, ['fanduel', 'betmgm', 'hardrockbet']);
  assert.strictEqual(ok.placeable, true);
  assert.strictEqual(ok.bestPlaceable.book, 'hardrockbet');
  assert.strictEqual(ok.bestPlaceable.american, -108);
  assert.strictEqual(ok.bestPlaceable.point, -3);
}

function futureIso() {
  return new Date(Date.now() + 864e5).toISOString();
}

function eligible(c) {
  const next = edge.attachEv({
    ...c,
    coverProb: 0.58,
    predictedClv: 2,
    commenceTime: c.commenceTime || futureIso(),
  });
  next.coverProb = 0.58;
  next.edgePct = 0.04;
  next.ev = 0.05;
  next.predictedClv = 2;
  return next;
}

function rawSide(side, point, prices) {
  return { side, point, prices };
}

const baseRaw = {
  sport: 'MLB',
  matchup: 'Red Sox @ Yankees',
  side: 'Yankees',
  market: 'Moneyline',
  homeTeam: 'Yankees',
  awayTeam: 'Red Sox',
  modelRawP: 0.6,
};

// Strong edge, liquid via Pinnacle, but only one US book offers the number → soft-veto.
{
  const yank = rawSide('Yankees', null, [
    { book: 'pinnacle', american: -110 },
    { book: 'draftkings', american: -110 },
  ]);
  const sox = rawSide('Red Sox', null, [
    { book: 'pinnacle', american: -110 },
    { book: 'draftkings', american: -110 },
  ]);
  let c = edge.enrichCandidateWithEdge(baseRaw, yank, [yank, sox]);
  assert.strictEqual(c.liquid, true, 'Pinnacle + DK is major-book liquidity');
  assert.deepStrictEqual(c.placeableBooks, ['draftkings']);
  assert.strictEqual(c.placeable, false);
  assert.strictEqual(c.bestPlaceable.book, 'draftkings');
  c = eligible(c);
  assert.strictEqual(gates.gateReason(c), 'placeability-soft-veto');
  const { rejected } = gates.applyGates([c]);
  assert.strictEqual(rejected[0].rejectReason, 'placeability-soft-veto');
}

// Published +130 only at Fanatics; DK/FD are a different price. Do not publish it.
{
  const yank = rawSide('Yankees', null, [
    { book: 'fanatics', american: 130 },
    { book: 'draftkings', american: -150 },
    { book: 'fanduel', american: -145 },
    { book: 'pinnacle', american: -140 },
  ]);
  const sox = rawSide('Red Sox', null, [
    { book: 'fanatics', american: -150 },
    { book: 'draftkings', american: 130 },
    { book: 'pinnacle', american: 120 },
  ]);
  let c = edge.enrichCandidateWithEdge(baseRaw, yank, [yank, sox]);
  assert.strictEqual(c.odds, 130);
  assert.strictEqual(c.book, 'fanatics');
  assert.strictEqual(c.liquid, true);
  assert.deepStrictEqual(c.placeableBooks, ['fanatics']);
  assert.strictEqual(c.placeable, false);
  c = eligible(c);
  assert.strictEqual(gates.gateReason(c), 'placeability-soft-veto');
}

// Two US majors inside the juice ballpark pass and travel onto the pick object.
{
  const yank = rawSide('Yankees', -1.5, [
    { book: 'pinnacle', american: -108 },
    { book: 'draftkings', american: -110 },
    { book: 'fanduel', american: -115 },
    { book: 'betmgm', american: -118 },
    { book: 'caesars', american: -130 },
  ]);
  const sox = rawSide('Red Sox', 1.5, [
    { book: 'pinnacle', american: -108 },
    { book: 'draftkings', american: -110 },
    { book: 'fanduel', american: -110 },
  ]);
  const spreadRaw = { ...baseRaw, market: 'Spread', side: 'Yankees -1.5', line: -1.5 };
  let c = edge.enrichCandidateWithEdge(spreadRaw, yank, [yank, sox]);
  assert.strictEqual(c.placeable, true);
  assert.ok(c.placeableBooks.includes('draftkings'));
  assert.ok(c.placeableBooks.includes('fanduel'));
  assert.ok(c.placeableBooks.includes('betmgm'));
  assert.ok(!c.placeableBooks.includes('caesars'), 'caesars -130 is outside the -110 ballpark');
  assert.ok(!c.placeableBooks.includes('pinnacle'));
  assert.strictEqual(c.bestPlaceable.book, 'draftkings');
  assert.strictEqual(c.bestPlaceable.american, -110);
  assert.strictEqual(c.bestPlaceable.point, -1.5);
  c = eligible(c);
  assert.strictEqual(gates.gateReason(c), null);
  const pick = select.toPickObject(c, { modelVersion: config.MODEL_VERSION });
  assert.ok(pick.placeableBooks.includes('fanduel'));
  assert.strictEqual(pick.bestPlaceable.book, 'draftkings');
  assert.strictEqual(pick.bestPlaceable.point, -1.5);
}

// insufficient-liquidity stays distinct and wins when the line is not liquid.
{
  const illiquid = eligible({
    sport: 'MLB', matchup: 'A @ B', side: 'B', market: 'Moneyline',
    odds: -110, liquid: false, placeable: false, placeableBooks: [],
    homeTeam: 'B', awayTeam: 'A',
  });
  assert.strictEqual(gates.gateReason(illiquid), 'insufficient-liquidity');
}

// Legacy candidates with no placeability annotation are not vetoed.
{
  const legacy = eligible({
    sport: 'MLB', matchup: 'A @ B', side: 'B', market: 'Moneyline',
    odds: -110, liquid: true, homeTeam: 'B', awayTeam: 'A',
  });
  assert.strictEqual(legacy.placeable, undefined);
  assert.strictEqual(gates.gateReason(legacy), null);
}

const HR_FAIL = { available: false, errors: ['HardRock: Hard Rock Bet has no lines for this game'], warnings: [] };
const VETO = 'placeability-soft-veto: Hard Rock + majors coverage failed';

// Verify drops only when Hard Rock and majors both fail.
{
  const dropped = edge.verifyPlaceabilityDecision({
    pick: { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees', placeableBooks: ['draftkings'] },
    hr: HR_FAIL,
    livePlaceableBooks: [],
  });
  assert.strictEqual(dropped.drop, true);
  assert.strictEqual(dropped.reason, VETO);

  const noStoredLiveThin = edge.verifyPlaceabilityDecision({
    pick: { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees' },
    hr: HR_FAIL,
    livePlaceableBooks: ['draftkings'],
  });
  assert.strictEqual(noStoredLiveThin.drop, true);
  assert.strictEqual(noStoredLiveThin.reason, VETO);
}

// Stored majors (preferred) or a live recheck can save a Hard Rock miss.
{
  const stored = edge.verifyPlaceabilityDecision({
    pick: { placeableBooks: ['draftkings', 'fanduel'], bestPlaceable: { book: 'draftkings', american: -110 } },
    hr: HR_FAIL,
    livePlaceableBooks: [],
  });
  assert.strictEqual(stored.drop, false);
  assert.match(stored.warning, /US majors still cover/);

  const live = edge.verifyPlaceabilityDecision({
    pick: { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees' },
    hr: HR_FAIL,
    livePlaceableBooks: ['betmgm', 'caesars', 'espnbet'],
  });
  assert.strictEqual(live.drop, false);
}

// Hard Rock itself in ballpark: do not drop, even if majors look thin.
{
  const hrOk = edge.verifyPlaceabilityDecision({
    pick: { placeableBooks: [] },
    hr: { available: true, errors: [], warnings: ['HardRock: line is -3 vs published -3.5 — half-point off'] },
    livePlaceableBooks: [],
  });
  assert.strictEqual(hrOk.drop, false);
  assert.strictEqual(hrOk.warning, null);
}

// Odds API down / feed down / game missing: warn, do not massacre the card.
{
  for (const args of [
    { apiDown: true },
    { feedDown: true },
    { gameMissing: true },
  ]) {
    const d = edge.verifyPlaceabilityDecision({
      ...args,
      pick: { placeableBooks: [] },
      hr: HR_FAIL,
      livePlaceableBooks: [],
    });
    assert.strictEqual(d.drop, false, JSON.stringify(args));
    assert.ok(d.warning, JSON.stringify(args));
  }

  const card = {
    picks: [
      { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees', units: '1u', rating: 'a', sport: 'MLB' },
      { pick: 'Over 8.5', matchup: 'C @ D', units: '1.25u', rating: 'aplus', sport: 'MLB' },
    ],
    parlayLegs: [{ units: '0.5u', legs: [
      { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees' },
      { pick: 'Over 8.5', matchup: 'C @ D' },
    ] }],
    rejections: [],
    summary: { totalPicks: 2, totalStraightBets: 2, totalUnits: '2.5u', sportsCovered: ['MLB'] },
  };
  const decisions = card.picks.map(() => edge.verifyPlaceabilityDecision({
    apiDown: true,
    hr: HR_FAIL,
    livePlaceableBooks: [],
    pick: { placeableBooks: [] },
  }));
  assert.ok(decisions.every(d => d.drop === false));
  const applied = edge.applyPlaceabilityDrops(card, decisions, []);
  assert.strictEqual(applied.dropped, 0);
  assert.strictEqual(card.picks.length, 2);
  assert.strictEqual(card.parlayLegs.length, 1);
}

// Drop one straight, leave the other, clear a parlay that used the dropped leg. No refill.
{
  const card = {
    picks: [
      { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees', units: '1u', rating: 'a', sport: 'MLB' },
      { pick: 'Over 8.5', matchup: 'C @ D', units: '1.25u', rating: 'aplus', sport: 'MLB' },
    ],
    parlayLegs: [{ units: '0.5u', type: '2-leg-parlay-optimized', legs: [
      { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees' },
      { pick: 'Over 8.5', matchup: 'C @ D' },
    ] }],
    rejections: [{ side: 'earlier', reason: 'ev-floor' }],
    summary: { totalPicks: 2, totalStraightBets: 2, totalUnits: '2.5u', sportsCovered: ['MLB'] },
  };
  const applied = edge.applyPlaceabilityDrops(card, [
    { drop: true, reason: VETO },
    { drop: false },
  ], []);
  assert.strictEqual(applied.dropped, 1);
  assert.strictEqual(applied.parlayCleared, true);
  assert.strictEqual(card.picks.length, 1);
  assert.strictEqual(card.picks[0].pick, 'Over 8.5');
  assert.strictEqual(card.picks[0].units, '1.25u');
  assert.strictEqual(card.picks[0].rating, 'aplus');
  assert.strictEqual(card.parlayLegs.length, 0);
  assert.ok(card.rejections.some(r => r.reason === VETO && r.side === 'Yankees ML'));
  assert.ok(card.rejections.some(r => r.reason === 'ev-floor'));
  assert.strictEqual(card.summary.totalPicks, 1);
}

// A straight that is not a parlay leg does not wipe the parlay.
{
  const card = {
    picks: [
      { pick: 'Yankees ML', matchup: 'Red Sox @ Yankees', units: '1u', sport: 'MLB' },
      { pick: 'B -3', matchup: 'E @ F', units: '1u', sport: 'NFL' },
    ],
    parlayLegs: [{ units: '0.5u', legs: [
      { pick: 'B -3', matchup: 'E @ F' },
      { pick: 'Under 9', matchup: 'G @ H' },
    ] }],
    rejections: [],
  };
  const applied = edge.applyPlaceabilityDrops(card, [
    { drop: true, reason: VETO },
    { drop: false },
  ], []);
  assert.strictEqual(applied.dropped, 1);
  assert.strictEqual(applied.parlayCleared, false);
  assert.strictEqual(card.picks.length, 1);
  assert.strictEqual(card.picks[0].pick, 'B -3');
  assert.strictEqual(card.parlayLegs.length, 1);
  assert.strictEqual(card.parlayLegs[0].legs.length, 2);
}

// Parlay-only leg fails: drop the parlay, do not invent a new leg, keep straights.
{
  const card = {
    picks: [
      { pick: 'B -3', matchup: 'E @ F', units: '1u', rating: 'a', sport: 'NFL' },
    ],
    parlayLegs: [{ units: '0.5u', legs: [
      { pick: 'B -3', matchup: 'E @ F' },
      { pick: 'Under 9', matchup: 'G @ H' },
    ] }],
    rejections: [],
  };
  const applied = edge.applyPlaceabilityDrops(card, [{ drop: false }], [
    { drop: true, pick: 'Under 9', matchup: 'G @ H', reason: VETO },
  ]);
  assert.strictEqual(applied.dropped, 0);
  assert.strictEqual(applied.parlayCleared, true);
  assert.strictEqual(card.picks.length, 1);
  assert.strictEqual(card.picks[0].pick, 'B -3');
  assert.strictEqual(card.parlayLegs.length, 0);
  assert.ok(card.rejections.some(r => r.side === 'Under 9' && r.reason === VETO));
}

// Parlay legs keep placeableBooks for the verify reuse path.
{
  const mk = (matchup, side, books) => ({
    sport: 'MLB', matchup, side, market: 'Total', odds: -110, coverProb: 0.56, ev: 0.05,
    edgePct: 0.04, commenceTime: '2026-09-22T23:05:00Z',
    homeTeam: matchup.split(' @ ')[1], awayTeam: matchup.split(' @ ')[0],
    placeableBooks: books,
    bestPlaceable: { book: books[0], american: -110, point: 8.5 },
  });
  const pls = parlay.optimizeParlay([
    mk('A @ B', 'Under 8.5', ['draftkings', 'fanduel']),
    mk('C @ D', 'Over 9', ['betmgm', 'caesars']),
  ], [], { cardDate: '2026-09-22' });
  assert.ok(pls.length === 1 && pls[0].legs.length >= 2);
  const under = pls[0].legs.find(l => l.matchup === 'A @ B');
  assert.ok(under, 'under leg present');
  assert.deepStrictEqual(under.placeableBooks, ['draftkings', 'fanduel']);
  assert.strictEqual(under.bestPlaceable.book, 'draftkings');
}

// Verify wires the soft-veto and does not treat Hard Rock as advisory-only.
{
  const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  assert.ok(verifySrc.includes('verifyPlaceabilityDecision'));
  assert.ok(verifySrc.includes('applyPlaceabilityDrops'));
  assert.ok(verifySrc.includes('blockStraightRefill'));
  assert.ok(verifySrc.includes('blockParlayRefill'));
  assert.ok(/Placeability soft-veto and adverse steam drops do not refill/.test(verifySrc));
  const steamAt = verifySrc.indexOf('let droppedSteam = 0');
  const steamRegion = verifySrc.slice(steamAt, verifySrc.indexOf('Step 3: Sharp handicapper review', steamAt));
  assert.ok(/steamDropBlocksStraightRefill\(\s*droppedSteam/.test(steamRegion));
  assert.ok(/blockStraightRefill\s*=\s*true/.test(steamRegion), 'steam drop sets blockStraightRefill');
  assert.ok(verifySrc.includes('odds API unavailable'));
  assert.ok(!verifySrc.includes('Hard Rock placeability remains advisory-only'));
  assert.ok(!verifySrc.includes('placeability check (advisory)'));
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('placeableBooks'));
  assert.ok(indexSrc.indexOf('applyGates(candidates') > indexSrc.indexOf('projectAll(snap)'));
}

console.log('PASS test-omega-placeability', {
  MODEL_VERSION: config.MODEL_VERSION,
  minMajorBooks: config.PLACEABILITY.minMajorBooks,
});
