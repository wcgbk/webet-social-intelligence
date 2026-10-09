'use strict';
/**
 * Point-aware realized CLV from CLV_POINT_AWARE_FROM (2026-10-09).
 * Earlier card dates stay on the price-only formula, byte for byte,
 * even when the close snapshot also carries an alternate at the bet's number.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const grade = require(path.join(root, 'clv_grade'));
const rules = require('./netlify/functions/lib/omega-grading-rules');
const { normCdf } = require(path.join(root, 'odds_math'));
const track = require('./netlify/functions/track-clv-omega')._test;

assert.strictEqual(rules.GRADING_RULES_V2_FROM, '2026-10-07');
assert.strictEqual(rules.CLV_POINT_AWARE_FROM, '2026-10-09');
assert.strictEqual(rules.clvPointAware('2026-10-08'), false);
assert.strictEqual(rules.clvPointAware('2026-10-09'), true);
assert.strictEqual(config.MODEL_VERSION, 'v12.3.14-omega-vnext-rest');
assert.strictEqual(config.SPORT_TOTAL_STD.NFL, 10.5);
assert.strictEqual(config.SPORT_SPREAD_STD.NFL, 13.5);

const CUT = '2026-10-09';
const BEFORE = '2026-10-08';
const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';

function game(marketKey, outcomes, books) {
  const bookmakers = books || [{
    key: 'pinnacle',
    title: 'Pinnacle',
    markets: [{ key: marketKey, outcomes }],
  }];
  return { home_team: HOME, away_team: AWAY, bookmakers };
}

function pick(text, betType, odds) {
  return {
    pick: text,
    odds,
    betType,
    sport: 'NFL',
    matchup: `${AWAY} @ ${HOME}`,
  };
}

function legacyPrice(close, p) {
  const betRaw = track.impliedProbability(p.odds);
  const closingNoVig = +(close.sideRaw / close.overround).toFixed(4);
  const pickTimeNoVig = betRaw != null ? +(betRaw / close.overround).toFixed(4) : null;
  const clv = pickTimeNoVig != null ? +(closingNoVig - pickTimeNoVig).toFixed(4) : null;
  const clvRaw = (betRaw != null && close.sideRaw != null) ? +(close.sideRaw - betRaw).toFixed(4) : null;
  return {
    closingOdds: String(close.sideOdds),
    closingLine: close.closingLine ?? null,
    anchor: close.anchor,
    anchorBook: close.anchorBook,
    pickTimeImplied: betRaw != null ? +betRaw.toFixed(4) : null,
    closingImplied: close.sideRaw != null ? +close.sideRaw.toFixed(4) : null,
    pickTimeNoVig,
    closingNoVig,
    closingOverround: +close.overround.toFixed(4),
    betDevigMethod: 'closing-overround',
    clv,
    clvCents: clv != null ? +(clv * 100).toFixed(2) : null,
    clvRaw,
    beatClosing: clv != null ? clv > 0 : null,
  };
}

function record(g, p, dateISO) {
  const info = track.pickSideInfo(p);
  const close = track.extractClose(g, info, p, dateISO);
  assert.ok(close, p.pick);
  return { close, info, rec: track.priceClvRecord(close, p, info, dateISO, g) };
}

function expectNormal(rec, close, p, favoredDelta, sigma) {
  const price = legacyPrice(close, p);
  const z = grade.normInv(price.closingNoVig);
  const pAtBet = +normCdf(z + favoredDelta / sigma).toFixed(4);
  const clv = +(pAtBet - price.pickTimeNoVig).toFixed(4);
  assert.strictEqual(rec.clvMethod, 'point-normal');
  assert.strictEqual(rec.clv, clv);
  assert.strictEqual(rec.closingNoVig, pAtBet);
  assert.strictEqual(rec.clvRaw, null);
  assert.strictEqual(rec.betDevigMethod, 'point-normal');
  assert.strictEqual(rec.closingLine, close.closingLine);
  assert.strictEqual(rec.closingOdds, String(close.sideOdds));
  assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'clvReason'));
  return clv;
}

// Over, point moved 47 → 44, close shorter so price-only CLV is the wrong sign.
{
  const outcomes = [
    { name: 'Over', price: -130, point: 44 },
    { name: 'Under', price: 110, point: 44 },
  ];
  const g = game('totals', outcomes);
  const p = pick('Over 47', 'Total', -110);
  const early = record(g, p, BEFORE);
  assert.deepStrictEqual(early.rec, legacyPrice(early.close, p));
  assert.ok(early.rec.clv > 0, 'pre-cutover price-only CLV stays positive');
  assert.ok(!Object.prototype.hasOwnProperty.call(early.rec, 'clvMethod'));
  assert.strictEqual(JSON.stringify(early.rec), JSON.stringify(legacyPrice(early.close, p)));

  const late = record(g, p, CUT);
  const clv = expectNormal(late.rec, late.close, p, 44 - 47, config.SPORT_TOTAL_STD.NFL);
  assert.ok(clv < 0, 'over moved down is a worse number');
  assert.strictEqual(late.rec.clvLine, 47);
  assert.strictEqual(late.close.closingLine, 44);
}

// Same snapshot plus an alternate at the bet's number. Before the cutover
// the alt is ignored. After it, CLV uses that pair only.
{
  const outcomes = [
    { name: 'Over', price: -130, point: 44 },
    { name: 'Under', price: 110, point: 44 },
    { name: 'Over', price: -105, point: 47 },
    { name: 'Under', price: -115, point: 47 },
  ];
  const g = game('totals', outcomes);
  const p = pick('Over 47', 'Total', -110);
  const early = record(g, p, BEFORE);
  assert.deepStrictEqual(early.rec, legacyPrice(early.close, p));
  assert.strictEqual(early.rec.closingOdds, '-130');
  assert.ok(early.close.bookOutcomes.length === 4);

  const late = record(g, p, CUT);
  assert.strictEqual(late.rec.clvMethod, 'same-point');
  assert.strictEqual(late.rec.closingOdds, '-105');
  assert.strictEqual(late.rec.closingLine, 44, 'closingLine stays the main number');
  assert.strictEqual(late.rec.clvLine, 47);
  const altRaw = track.impliedProbability(-105);
  const altOv = track.impliedProbability(-105) + track.impliedProbability(-115);
  const betRaw = track.impliedProbability(-110);
  const closingNoVig = +(altRaw / altOv).toFixed(4);
  const pickTimeNoVig = +(betRaw / altOv).toFixed(4);
  assert.strictEqual(late.rec.closingNoVig, closingNoVig);
  assert.strictEqual(late.rec.clv, +(closingNoVig - pickTimeNoVig).toFixed(4));
  assert.notStrictEqual(late.rec.closingOverround, early.rec.closingOverround);
  const direct = grade.gradeRealizedClv({
    dateISO: BEFORE,
    betRaw,
    closeRaw: early.close.sideRaw,
    overround: early.close.overround,
    closeAmerican: early.close.sideOdds,
    betPoint: 47,
    closePoint: 44,
    sport: 'NFL',
    marketBase: 'totals',
    isOver: true,
    altSideRaw: altRaw,
    altOverround: altOv,
    altAmerican: -105,
  });
  assert.strictEqual(direct.clvMethod, null);
  assert.strictEqual(direct.closingOdds, -130);
  assert.strictEqual(direct.clv, early.rec.clv);
}

// Under. Close number is higher, so the under is easier at the close than at the bet.
{
  const g = game('totals', [
    { name: 'Under', price: -110, point: 47 },
    { name: 'Over', price: -110, point: 47 },
  ]);
  const p = pick('Under 44', 'Total', -110);
  const early = record(g, p, BEFORE);
  assert.strictEqual(early.rec.clv, 0);
  assert.deepStrictEqual(early.rec, legacyPrice(early.close, p));
  const late = record(g, p, CUT);
  const clv = expectNormal(late.rec, late.close, p, 44 - 47, config.SPORT_TOTAL_STD.NFL);
  assert.ok(clv < 0);
}

// Spread favorite. Bet -7.5, close -3.5, same juice. Price-only CLV is 0.
{
  const g = game('spreads', [
    { name: HOME, price: -110, point: -3.5 },
    { name: AWAY, price: -110, point: 3.5 },
  ]);
  const p = pick(`${HOME} -7.5`, 'Spread', -110);
  const early = record(g, p, BEFORE);
  assert.strictEqual(early.rec.clv, 0);
  assert.strictEqual(JSON.stringify(early.rec), JSON.stringify(legacyPrice(early.close, p)));
  const late = record(g, p, CUT);
  const clv = expectNormal(late.rec, late.close, p, -7.5 - (-3.5), config.SPORT_SPREAD_STD.NFL);
  assert.ok(clv < 0, 'laying more points is harder');
  assert.strictEqual(late.rec.clvLine, -7.5);
}

// Spread dog. Bet +3.5, close +7.5.
{
  const g = game('spreads', [
    { name: AWAY, price: -110, point: 7.5 },
    { name: HOME, price: -110, point: -7.5 },
  ]);
  const p = pick(`${AWAY} +3.5`, 'Spread', -110);
  const early = record(g, p, BEFORE);
  assert.deepStrictEqual(early.rec, legacyPrice(early.close, p));
  assert.strictEqual(early.rec.clv, 0);
  const late = record(g, p, CUT);
  const clv = expectNormal(late.rec, late.close, p, 3.5 - 7.5, config.SPORT_SPREAD_STD.NFL);
  assert.ok(clv < 0, 'taking fewer points is harder');
}

// Unchanged point, including on the cutover date, is the old record.
{
  const g = game('totals', [
    { name: 'Over', price: -120, point: 47 },
    { name: 'Under', price: 100, point: 47 },
  ]);
  const p = pick('Over 47', 'Total', -110);
  const late = record(g, p, CUT);
  assert.deepStrictEqual(late.rec, legacyPrice(late.close, p));
  assert.ok(!Object.prototype.hasOwnProperty.call(late.rec, 'clvMethod'));
  assert.ok(!Object.prototype.hasOwnProperty.call(late.rec, 'clvLine'));
  assert.notStrictEqual(late.rec.clv, 0);
  const spread = game('spreads', [
    { name: HOME, price: -120, point: -3.5 },
    { name: AWAY, price: 100, point: 3.5 },
  ]);
  const sp = pick(`${HOME} -3.5`, 'Spread', -110);
  const same = record(spread, sp, CUT);
  assert.strictEqual(JSON.stringify(same.rec), JSON.stringify(legacyPrice(same.close, sp)));
}

// Moneyline has no point. Forward date stays price-only.
{
  const g = game('h2h', [
    { name: HOME, price: -150 },
    { name: AWAY, price: 130 },
  ]);
  const p = pick(`${HOME} ML`, 'Moneyline', -140);
  const late = record(g, p, CUT);
  assert.deepStrictEqual(late.rec, legacyPrice(late.close, p));
  assert.strictEqual(late.rec.closingLine, null);
}

// F5 point move with no alternate is not defensible off the full-game std.
{
  const g = game('totals_1st_5_innings', [
    { name: 'Over', price: -130, point: 5.5 },
    { name: 'Under', price: 110, point: 5.5 },
  ]);
  const p = pick('Over 4.5', 'F5 Total', -110);
  const late = record(g, p, CUT);
  assert.strictEqual(late.rec.clvMethod, 'point_moved');
  assert.strictEqual(late.rec.clvReason, 'point_moved');
  assert.strictEqual(late.rec.clv, null);
  assert.strictEqual(late.rec.closingNoVig, null);
  assert.strictEqual(late.rec.clvRaw, null);
  assert.strictEqual(late.rec.beatClosing, null);
  assert.strictEqual(late.rec.clvLine, 4.5);
  const early = record(g, p, BEFORE);
  assert.deepStrictEqual(early.rec, legacyPrice(early.close, p));
  assert.ok(early.rec.clv > 0);
}

// No single sharp book: point-normal, alt is not taken from the soft median.
{
  const outcomes = [
    { name: 'Over', price: -110, point: 44 },
    { name: 'Under', price: -110, point: 44 },
    { name: 'Over', price: -105, point: 47 },
    { name: 'Under', price: -115, point: 47 },
  ];
  const g = game('totals', outcomes, [
    { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'totals', outcomes }] },
    { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'totals', outcomes }] },
  ]);
  const p = pick('Over 47', 'Total', -110);
  const late = record(g, p, CUT);
  assert.strictEqual(late.close.anchor, 'soft-median');
  assert.ok(late.close.bookOutcomes == null);
  assert.strictEqual(late.rec.clvMethod, 'point-normal');
  assert.notStrictEqual(late.rec.closingOdds, '-105');
}

console.log('test-omega-clv-point: ok');
