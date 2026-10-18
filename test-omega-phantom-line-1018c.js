'use strict';
// A Pinnacle-only number is not a bet. The price and the fair stay on the
// retail number. 2026-10-18 Cardinals @ Rams: Pinnacle +13.5, DK/HR +12.5.
// Nobody retail offers 13.5, so "Arizona Cardinals +13.5 -110" must not publish.
const assert = require('assert');
const { collectMarketOutcomes, enrichCandidateWithEdge } = require('./netlify/functions/lib/omega-vnext/edge');
const { applyExecutionBook } = require('./netlify/functions/lib/omega-vnext/selection_pass');
const { applyMarketAnchor, pinnacleFair, priceEdgesAtBet } = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { toPickObject } = require('./netlify/functions/lib/omega-vnext/select');
const { powerTwoWay } = require('./netlify/functions/lib/omega-vnext/sharp_fair');
const { americanToImplied } = require('./netlify/functions/lib/omega-vnext/odds_math');

function powerP(a, b) {
  const powered = powerTwoWay(americanToImplied(a), americanToImplied(b));
  assert.ok(powered, `${a}/${b}`);
  return powered.p1;
}

function labelPoint(side, market) {
  if (/moneyline|^ml$/i.test(String(market || ''))) return null;
  const m = String(side || '').trim().match(/(?:^|\s)([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function bookPoint(c) {
  const book = String(c.book || c.priceBook || '').toLowerCase();
  const named = (obj) => (obj && obj.point != null && obj.point !== '' ? Number(obj.point) : null);
  if (book === 'draftkings') {
    const pt = named(c.dkQuote);
    if (pt != null) return pt;
  }
  if (book === 'hardrockbet' || book === 'hardrock') {
    const pt = named(c.hardRock);
    if (pt != null) return pt;
  }
  const hit = (c.bookPrices || []).find((p) => p && String(p.book || p.key || '').toLowerCase() === book);
  return hit && hit.point != null && hit.point !== '' ? Number(hit.point) : null;
}

function assertAligned(c) {
  const market = c.market || c.betType;
  const label = labelPoint(c.side || c.pick, market);
  const line = c.line != null && c.line !== '' ? Number(c.line) : null;
  const priced = bookPoint(c);
  if (label != null && line != null) {
    assert.ok(Math.abs(label - line) < 1e-6, `${c.side} label ${label} line ${line}`);
  }
  if (label != null && priced != null) {
    assert.ok(Math.abs(label - priced) < 1e-6, `${c.side} label ${label} book point ${priced}`);
  }
  if (line != null && priced != null) {
    assert.ok(Math.abs(line - priced) < 1e-6, `${c.side} line ${line} book point ${priced}`);
  }
  if (c.pinnacleSide && c.pinnacleSide.point != null && c.pinnacleSide.point !== '' && line != null) {
    assert.ok(
      Math.abs(Number(c.pinnacleSide.point) - line) < 1e-6,
      `${c.side} pinnacle ${c.pinnacleSide.point} line ${line}`,
    );
  }
  const pick = toPickObject(c);
  const pickPt = labelPoint(pick.pick, pick.betType || market);
  if (pickPt != null && line != null) {
    assert.ok(Math.abs(pickPt - line) < 1e-6, `pick ${pick.pick} line ${line}`);
  }
  if (pickPt != null && priced != null) {
    assert.ok(Math.abs(pickPt - priced) < 1e-6, `pick ${pick.pick} book point ${priced}`);
  }
  return pick;
}

function board(sport, market, home, away, marketKey, books) {
  const event = {
    home_team: home,
    away_team: away,
    bookmakers: books.map((b) => ({
      key: b.key,
      markets: [{ key: marketKey, outcomes: b.outcomes }],
    })),
  };
  const bundles = collectMarketOutcomes(event, marketKey);
  const rows = bundles.map((b) => {
    let side;
    if (/total/i.test(market)) side = `${b.side} ${b.point}`;
    else if (b.point > 0) side = `${b.side} +${b.point}`;
    else side = `${b.side} ${b.point}`;
    return enrichCandidateWithEdge({
      sport,
      homeTeam: home,
      awayTeam: away,
      matchup: `${away} @ ${home}`,
      market,
      side,
      line: b.point,
      modelRawP: 0.5,
      modelPureP: 0.52,
      coverProb: 0.5,
      commenceTime: '2026-10-18T20:05:00Z',
    }, b, bundles);
  });
  const exec = applyExecutionBook(rows);
  const anchored = priceEdgesAtBet(applyMarketAnchor(exec.candidates));
  return { exec, anchored, picks: anchored.map(assertAligned) };
}

const pin135 = powerP(-118, 105);
assert.ok(Math.abs(pin135 - 0.527105) < 1e-4, pin135);

// The fair's point has to be the bet's point. Sign included.
const pinSide = { american: -118, oppAmerican: 105, point: 13.5, oppPoint: -13.5 };
assert.ok(Math.abs(pinnacleFair({
  market: 'Spread', line: 13.5, pinnacleSide: pinSide,
}) - pin135) < 1e-9);
assert.strictEqual(pinnacleFair({
  market: 'Spread', line: 12.5, pinnacleSide: pinSide,
}), null);
assert.strictEqual(pinnacleFair({
  market: 'Spread', line: -13.5, pinnacleSide: pinSide,
}), null);
assert.strictEqual(pinnacleFair({
  market: 'Total', line: 5.5,
  pinnacleSide: { american: -105, oppAmerican: -115, point: 6.5, oppPoint: 6.5 },
}), null);
assert.ok(pinnacleFair({
  market: 'Total', line: 6.5,
  pinnacleSide: { american: -105, oppAmerican: -115, point: 6.5, oppPoint: 6.5 },
}) != null);

// A pre-attached nearest Hard Rock quote is not this bet.
{
  const glued = applyExecutionBook([{
    sport: 'NFL',
    market: 'Spread',
    side: 'Arizona Cardinals +13.5',
    line: 13.5,
    matchup: 'Arizona Cardinals @ Los Angeles Rams',
    homeTeam: 'Los Angeles Rams',
    awayTeam: 'Arizona Cardinals',
    coverProb: 0.5,
    modelPureP: 0.52,
    bookPrices: [{ book: 'pinnacle', american: -118, point: 13.5 }],
    hardRock: { book: 'hardrockbet', american: -110, point: 12.5 },
    pinnacleSide: pinSide,
  }]);
  assert.strictEqual(glued.candidates.length, 0);
  assert.strictEqual(glued.excluded.length, 1);
}

// Stored 3AM board. Pinnacle 13.5, DraftKings and Hard Rock 12.5.
const ari = board('NFL', 'Spread', 'Los Angeles Rams', 'Arizona Cardinals', 'spreads', [
  { key: 'pinnacle', outcomes: [
    { name: 'Los Angeles Rams', price: 105, point: -13.5 },
    { name: 'Arizona Cardinals', price: -118, point: 13.5 },
  ] },
  { key: 'draftkings', outcomes: [
    { name: 'Los Angeles Rams', price: -112, point: -12.5 },
    { name: 'Arizona Cardinals', price: -108, point: 12.5 },
  ] },
  { key: 'hardrockbet', outcomes: [
    { name: 'Los Angeles Rams', price: -110, point: -12.5 },
    { name: 'Arizona Cardinals', price: -110, point: 12.5 },
  ] },
]);
assert.ok(ari.exec.excluded.some((c) => c.side === 'Arizona Cardinals +13.5'));
assert.ok(ari.exec.excluded.some((c) => c.side === 'Los Angeles Rams -13.5'));
assert.ok(!ari.anchored.some((c) => /13\.5/.test(String(c.side))));
assert.ok(!ari.picks.some((p) => /13\.5/.test(String(p.pick))));
const cards = ari.anchored.find((c) => c.side === 'Arizona Cardinals +12.5');
assert.ok(cards, 'retail +12.5 row');
assert.strictEqual(cards.line, 12.5);
assert.strictEqual(cards.odds, -108);
assert.strictEqual(cards.book, 'draftkings');
assert.notStrictEqual(cards.anchorFairSource, 'pinnacle');
assert.strictEqual(cards.fairSoft, true);
assert.ok(Math.abs(cards.p_fair - +pin135.toFixed(6)) > 0.01, cards.p_fair);
const soft125 = (powerP(-108, -112) + powerP(-110, -110)) / 2;
assert.strictEqual(cards.anchorFairSource, 'consensus');
assert.strictEqual(cards.p_fair, +soft125.toFixed(6));
const cardPick = ari.picks.find((p) => p.pick === 'Arizona Cardinals +12.5');
assert.ok(cardPick);
assert.strictEqual(cardPick.odds, '-108');
assert.ok(!ari.picks.some((p) => String(p.pick).includes('+13.5') || String(p.odds) === '-110' && /13\.5/.test(String(p.pick))));

// Green Bay: Pinnacle -1, retail -1.5. The -1.5 row keeps a same-line soft fair.
const gb = board('NFL', 'Spread', 'Green Bay Packers', 'Dallas Cowboys', 'spreads', [
  { key: 'pinnacle', outcomes: [
    { name: 'Green Bay Packers', price: -102, point: -1 },
    { name: 'Dallas Cowboys', price: -110, point: 1 },
  ] },
  { key: 'draftkings', outcomes: [
    { name: 'Green Bay Packers', price: -102, point: -1.5 },
    { name: 'Dallas Cowboys', price: -118, point: 1.5 },
  ] },
  { key: 'hardrockbet', outcomes: [
    { name: 'Green Bay Packers', price: -105, point: -1.5 },
    { name: 'Dallas Cowboys', price: -115, point: 1.5 },
  ] },
]);
assert.ok(gb.exec.excluded.some((c) => c.side === 'Green Bay Packers -1'));
const packers = gb.anchored.find((c) => c.side === 'Green Bay Packers -1.5');
assert.ok(packers);
assert.strictEqual(packers.line, -1.5);
assert.notStrictEqual(packers.anchorFairSource, 'pinnacle');
assert.strictEqual(packers.fairSoft, true);
assert.ok(!gb.anchored.some((c) => {
  const pt = labelPoint(c.side, c.market);
  return pt != null && Math.abs(Math.abs(pt) - 1) < 1e-6;
}));

// NHL and NBA totals. The sharp total is not the retail total.
function totalBooks(pinPoint, retailPoint) {
  return [
    { key: 'pinnacle', outcomes: [
      { name: 'Over', price: -105, point: pinPoint },
      { name: 'Under', price: -115, point: pinPoint },
    ] },
    { key: 'draftkings', outcomes: [
      { name: 'Over', price: -112, point: retailPoint },
      { name: 'Under', price: -108, point: retailPoint },
    ] },
    { key: 'hardrockbet', outcomes: [
      { name: 'Over', price: -110, point: retailPoint },
      { name: 'Under', price: -110, point: retailPoint },
    ] },
  ];
}
const nhl = board('NHL', 'Total', 'Edmonton Oilers', 'Winnipeg Jets', 'totals', totalBooks(6.5, 5.5));
assert.ok(nhl.exec.excluded.some((c) => c.side === 'Over 6.5'));
assert.ok(nhl.exec.excluded.some((c) => c.side === 'Under 6.5'));
const nhlOver = nhl.anchored.find((c) => c.side === 'Over 5.5');
assert.ok(nhlOver);
assert.strictEqual(nhlOver.line, 5.5);
assert.notStrictEqual(nhlOver.anchorFairSource, 'pinnacle');
assert.strictEqual(nhlOver.fairSoft, true);
assert.ok(Math.abs(nhlOver.p_fair - +powerP(-105, -115).toFixed(6)) > 0.01);
assert.ok(!nhl.picks.some((p) => /6\.5/.test(String(p.pick))));

const nba = board('NBA', 'Total', 'Boston Celtics', 'New York Knicks', 'totals', totalBooks(220.5, 219.5));
assert.ok(nba.exec.excluded.some((c) => c.side === 'Over 220.5'));
assert.ok(!nba.anchored.some((c) => /220\.5/.test(String(c.side))));
assert.ok(nba.anchored.some((c) => c.side === 'Over 219.5' && c.line === 219.5));
assert.ok(!nba.picks.some((p) => /220\.5/.test(String(p.pick))));
for (const p of nba.picks) {
  const pt = labelPoint(p.pick, p.betType);
  const row = nba.anchored.find((c) => c.side === p.pick);
  assert.ok(row);
  const priced = bookPoint(row);
  if (pt != null && priced != null) assert.ok(Math.abs(pt - priced) < 1e-6, `${p.pick} vs ${priced}`);
}

console.log('test-omega-phantom-line-1018c ok');
