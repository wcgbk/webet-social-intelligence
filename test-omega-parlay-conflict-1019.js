'use strict';

/**
 * 10/19 Edge: the published parlay took the other side of two straights
 * (Ducks +1.5 vs Rangers -1.5, Avalanche ML vs Flyers ML) at -46% EV,
 * and the stored card's rejections array was empty.
 *
 * The card object is the one generateOmegaVnext returns (dry run, no network).
 */

const assert = require('assert');
const { generateOmegaVnext, MODEL_VERSION } = require('./netlify/functions/lib/omega-vnext');
const parlay = require('./netlify/functions/lib/omega-vnext/parlay');
const { americanToDecimal } = require('./netlify/functions/lib/omega-vnext/odds_math');
const { ensureCardParlay } = parlay;

assert.strictEqual(MODEL_VERSION, 'v12.5.0-nba');

const CARD_DATE = '2026-10-19';
const AS_OF = Date.parse('2026-10-19T16:00:00Z');

function row(overrides) {
  const odds = overrides.odds;
  return {
    sport: 'NHL',
    market: 'Moneyline',
    coverProb: 0.5,
    ev: 0,
    edgePct: 0.01,
    predictedClv: 1,
    uncertainty: 0.2,
    liquid: true,
    book: 'draftkings',
    bestDkHr: { book: 'draftkings', american: odds },
    commenceTime: '2026-10-19T23:10:00Z',
    line: null,
    ...overrides,
    odds,
  };
}

function slate1019() {
  return [
    row({
      sport: 'MLB', matchup: 'Cleveland Guardians @ Tampa Bay Rays',
      homeTeam: 'Tampa Bay Rays', awayTeam: 'Cleveland Guardians',
      side: 'Over 6.5', market: 'Total', odds: -115, line: 6.5,
      coverProb: 0.5640999816904269, ev: 0.0546, edgePct: 0.045, predictedClv: 4.24,
      uncertainty: 0.19, book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -115 },
      commenceTime: '2026-10-20T00:10:00Z',
    }),
    row({
      sport: 'MLB', matchup: 'Cleveland Guardians @ Tampa Bay Rays',
      homeTeam: 'Tampa Bay Rays', awayTeam: 'Cleveland Guardians',
      side: 'Under 6.5', market: 'Total', odds: -102, line: 6.5,
      coverProb: 0.4359000182592736, ev: -0.1367, edgePct: -0.045, predictedClv: -4.02,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: -102 },
      commenceTime: '2026-10-20T00:10:00Z',
    }),
    row({
      sport: 'NHL', matchup: 'Colorado Avalanche @ Philadelphia Flyers',
      homeTeam: 'Philadelphia Flyers', awayTeam: 'Colorado Avalanche',
      side: 'Philadelphia Flyers', market: 'Moneyline', odds: 195,
      coverProb: 0.4003996057107808, ev: 0.1812, edgePct: 0.0873, predictedClv: 4.5,
      uncertainty: 0.3, book: 'draftkings', bestDkHr: { book: 'draftkings', american: 195 },
    }),
    row({
      sport: 'NHL', matchup: 'Colorado Avalanche @ Philadelphia Flyers',
      homeTeam: 'Philadelphia Flyers', awayTeam: 'Colorado Avalanche',
      side: 'Colorado Avalanche', market: 'Moneyline', odds: -230,
      coverProb: 0.5996003942752334, ev: -0.1397, edgePct: -0.0873, predictedClv: -4.44,
      book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -230 },
    }),
    row({
      sport: 'NHL', matchup: 'Colorado Avalanche @ Philadelphia Flyers',
      homeTeam: 'Philadelphia Flyers', awayTeam: 'Colorado Avalanche',
      side: 'Philadelphia Flyers +1.5', market: 'Spread', odds: -130, line: 1.5,
      coverProb: 0.572215354935422, ev: 0.0124, edgePct: 0.033, predictedClv: 5.08,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: -130 },
    }),
    row({
      sport: 'NHL', matchup: 'Anaheim Ducks @ New York Rangers',
      homeTeam: 'New York Rangers', awayTeam: 'Anaheim Ducks',
      side: 'New York Rangers -1.5', market: 'Spread', odds: 180, line: -1.5,
      coverProb: 0.39902684090215773, ev: 0.1173, edgePct: 0.0612, predictedClv: -0.32,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: 180 },
    }),
    row({
      sport: 'NHL', matchup: 'Anaheim Ducks @ New York Rangers',
      homeTeam: 'New York Rangers', awayTeam: 'Anaheim Ducks',
      side: 'Anaheim Ducks +1.5', market: 'Spread', odds: -210, line: 1.5,
      coverProb: 0.6009731591165195, ev: -0.1128, edgePct: -0.0612, predictedClv: 0.72,
      book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -210 },
    }),
    row({
      sport: 'NFL', matchup: 'Washington Commanders @ San Francisco 49ers',
      homeTeam: 'San Francisco 49ers', awayTeam: 'Washington Commanders',
      side: 'San Francisco 49ers', market: 'Moneyline', odds: -410,
      coverProb: 0.6307574726725775, ev: -0.2154, edgePct: -0.1646, predictedClv: -1.93,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: -410 },
      commenceTime: '2026-10-20T00:15:00Z',
    }),
    row({
      sport: 'NFL', matchup: 'Washington Commanders @ San Francisco 49ers',
      homeTeam: 'San Francisco 49ers', awayTeam: 'Washington Commanders',
      side: 'Washington Commanders', market: 'Moneyline', odds: 350,
      coverProb: 0.37, ev: 0.2, edgePct: 0.1646, predictedClv: 2,
      book: 'fanduel', bestDkHr: { book: 'draftkings', american: 330 },
      commenceTime: '2026-10-20T00:15:00Z',
    }),
    row({
      sport: 'NFL', matchup: 'Washington Commanders @ San Francisco 49ers',
      homeTeam: 'San Francisco 49ers', awayTeam: 'Washington Commanders',
      side: 'Over 51.5', market: 'Total', odds: -110, line: 51.5,
      coverProb: 0.5483519477009797, ev: 0.0469, edgePct: 0, predictedClv: 5.31,
      book: 'hardrockbet', bestDkHr: { book: 'hardrockbet', american: -110 },
      commenceTime: '2026-10-20T00:15:00Z',
    }),
    row({
      sport: 'NHL', matchup: 'San Jose Sharks @ Toronto Maple Leafs',
      homeTeam: 'Toronto Maple Leafs', awayTeam: 'San Jose Sharks',
      side: 'Toronto Maple Leafs -1.5', market: 'Spread', odds: 170, line: -1.5,
      coverProb: 0.4006473395099407, ev: 0.0817, edgePct: 0.0562, predictedClv: -0.7,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: 170 },
      commenceTime: '2026-10-19T23:40:00Z',
    }),
    row({
      sport: 'NHL', matchup: 'Pittsburgh Penguins @ Utah Mammoth',
      homeTeam: 'Utah Mammoth', awayTeam: 'Pittsburgh Penguins',
      side: 'Pittsburgh Penguins', market: 'Moneyline', odds: 154,
      coverProb: 0.40842219758684706, ev: 0.0374, edgePct: 0.0371, predictedClv: 0.31,
      book: 'draftkings', bestDkHr: { book: 'draftkings', american: 154 },
      commenceTime: '2026-10-20T01:10:00Z',
    }),
  ];
}

function parseAmerican(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePct(v) {
  const n = parseFloat(String(v == null ? '' : v).replace('%', ''));
  return Number.isFinite(n) ? n / 100 : null;
}

(async () => {
  const card = await generateOmegaVnext({
    date: CARD_DATE,
    dryRun: true,
    skipNarrate: true,
    fixtureCandidates: slate1019(),
    historicalSnapshot: '2026-10-19T16:00:00Z',
    pregameAsOfMs: AS_OF,
  });

  assert.strictEqual(card.model, MODEL_VERSION);
  assert.ok(Array.isArray(card.picks) && card.picks.length === 3, `straights ${card.picks.map(p => p.pick).join(' | ')}`);
  assert.ok(card.picks.some(p => /Over 6\.5/.test(p.pick) && /Guardians/.test(p.matchup)));
  assert.ok(card.picks.some(p => /Flyers/.test(p.pick)));
  assert.ok(card.picks.some(p => /Rangers -1\.5/.test(p.pick)));

  assert.ok(Array.isArray(card.parlayLegs) && card.parlayLegs.length === 1);
  const ticket = card.parlayLegs[0];
  assert.strictEqual(ticket.legs.length, 3, ticket.legs.map(l => l.pick).join(' | '));
  assert.strictEqual(parseFloat(ticket.units), 0.5);

  const games = new Set(ticket.legs.map(l => String(l.matchup || '').toLowerCase()));
  assert.strictEqual(games.size, 3, 'one leg per game');

  for (const leg of ticket.legs) {
    for (const straight of card.picks) {
      assert.strictEqual(
        parlay.conflictsWithStraight(leg, straight),
        false,
        `${leg.pick} conflicts with straight ${straight.pick}`,
      );
    }
  }
  assert.ok(!ticket.legs.some(l => /Ducks \+1\.5/.test(l.pick || '')), 'Ducks +1.5 is the other side of Rangers -1.5');
  assert.ok(!ticket.legs.some(l => /Avalanche/.test(l.pick || '')), 'Avalanche ML is the other side of Flyers ML');

  const legEvPositive = ticket.legs.every(l => parsePct(l.ev) > 0);
  if (!legEvPositive || parsePct(ticket.ev) < 0) {
    assert.strictEqual(ticket.lean, true);
    assert.strictEqual(ticket.flag, 'parlay-lean');
    assert.strictEqual(ticket.label, 'lean');
  } else {
    assert.notStrictEqual(ticket.flag, 'parlay-lean');
    assert.ok(parsePct(ticket.ev) >= 0);
  }

  const rawLegs = ticket.legs.map(l => ({
    odds: parseAmerican(l.odds),
    coverProb: parsePct(l.coverProb),
    matchup: l.matchup,
    sport: l.sport,
  }));
  let decimal = 1;
  for (const leg of rawLegs) {
    const dec = americanToDecimal(leg.odds);
    const ev = leg.coverProb * dec - 1;
    decimal *= dec;
    const shown = ticket.legs.find(x => x.matchup === leg.matchup);
    assert.ok(Math.abs(parsePct(shown.ev) - ev) < 0.006, `${shown.pick} ev ${shown.ev} vs ${ev}`);
  }
  const stats = parlay.comboStats(rawLegs);
  assert.ok(Math.abs(decimal - stats.combinedDecimal) < 1e-9, 'decimal is the product of leg decimals');
  assert.ok(Math.abs(parseFloat(ticket.combinedDecimal) - Number(stats.combinedDecimal.toFixed(2))) < 0.011);
  assert.ok(Math.abs(parsePct(ticket.combinedProb) - stats.combinedProb) < 0.0015, `${ticket.combinedProb} vs ${stats.combinedProb}`);
  assert.ok(Math.abs(parsePct(ticket.ev) - stats.ev) < 0.0015, `${ticket.ev} vs ${stats.ev}`);

  assert.ok(Array.isArray(card.rejections) && card.rejections.length > 0, 'rejections populated on the stored card');
  for (const r of card.rejections) {
    assert.ok(r && r.matchup, `rejection matchup ${JSON.stringify(r)}`);
    assert.ok(r.side, `rejection side ${JSON.stringify(r)}`);
    assert.ok(r.market, `rejection market ${JSON.stringify(r)}`);
    assert.ok(r.reason, `rejection reason ${JSON.stringify(r)}`);
  }
  assert.ok(card.rejections.some(r => r.reason === 'edge-over-10pp' && /Commanders/.test(r.side || '')));
  assert.ok(card.rejections.some(r => r.reason === 'conflict-with-straight' && /Ducks \+1\.5/.test(r.side || '')));
  assert.ok(card.rejections.some(r => r.reason === 'conflict-with-straight' && /Avalanche/.test(r.side || '')));
  assert.ok(card.rejections.some(r => r.reason === 'parlay-excluded' || r.reason === 'not-selected' || /floor|edge|odds/.test(r.reason || '')));

  // No qualifying +EV trio: still publish 3 legs, labeled a 0.5u lean.
  const chalk = ['A @ B', 'C @ D', 'E @ F'].map(matchup => row({
    matchup,
    homeTeam: matchup.split(' @ ')[1],
    awayTeam: matchup.split(' @ ')[0],
    side: matchup.split(' @ ')[1],
    odds: -400,
    coverProb: 0.7,
    ev: -0.12,
    edgePct: -0.05,
    predictedClv: -1,
  }));
  const leanBuilt = ensureCardParlay(chalk, [], { cardDate: CARD_DATE });
  assert.strictEqual(leanBuilt.length, 1);
  assert.strictEqual(leanBuilt[0].legs.length, 3);
  assert.strictEqual(leanBuilt[0].lean, true);
  assert.strictEqual(leanBuilt[0].flag, 'parlay-lean');
  assert.strictEqual(leanBuilt[0].label, 'lean');
  assert.strictEqual(parseFloat(leanBuilt[0].units), 0.5);
  assert.ok(leanBuilt.parlayExclusions && leanBuilt.parlayExclusions.length >= 0);

  console.log('PASS test-omega-parlay-conflict-1019', {
    straights: card.picks.map(p => `${p.pick} ${p.odds} ${p.units}`),
    parlay: ticket.legs.map(l => `${l.pick} ${l.odds} ev ${l.ev}`),
    ticket: `${ticket.type} ${ticket.combinedOdds} ev ${ticket.ev} lean ${ticket.lean}`,
    rejections: card.rejections.length,
  });
})().catch(err => {
  console.error(err);
  process.exit(1);
});
