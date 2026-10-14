'use strict';

/**
 * Seeded property checks for the straight card and the parlay.
 * Synthetic candidates only. No network, no fixtures, no blob writes.
 *
 * For every pool, selectStraights + optimizeParlay + the unit cap must:
 *   - publish at most one straight per game
 *   - never put two parlay legs on the same game
 *   - never publish a negative-EV straight or a negative-EV ticket
 *   - keep straight units inside the per-pick, B-grade, lean, 3.5u, and 4.0u caps
 *   - keep every published parlay at 0.25u after the unit cap
 *   - return the same card for the same input
 */

const assert = require('assert');
const config = require('./netlify/functions/lib/omega-vnext/config');
const {
  selectStraights, toPickObject, applyDailyUnitCap, passesPublishFloor, passesLeanFill, matchupKey,
} = require('./netlify/functions/lib/omega-vnext/select');
const { optimizeParlay } = require('./netlify/functions/lib/omega-vnext/parlay');

const CARD = '2026-10-11';
const KICK = '2026-10-11T20:00:00Z';
const SEED = 20261011;
const TRIALS = 48;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function row(matchup, side, extra) {
  const parts = String(matchup).split(' @ ');
  return {
    sport: extra.sport || 'NFL',
    matchup,
    side,
    market: extra.market || 'Spread',
    line: extra.line == null ? -3 : extra.line,
    odds: extra.odds == null ? -110 : extra.odds,
    coverProb: extra.coverProb == null ? 0.56 : extra.coverProb,
    ev: extra.ev,
    edgePct: extra.edgePct,
    uncertainty: extra.uncertainty == null ? 0.12 : extra.uncertainty,
    liquid: true,
    commenceTime: extra.commenceTime || KICK,
    homeTeam: parts[1] || 'Home',
    awayTeam: parts[0] || 'Away',
    book: extra.book || 'draftkings',
  };
}

function tag(c) {
  if (passesPublishFloor(c)) return { ...c, tier: 'floor' };
  if (passesLeanFill(c)) return { ...c, tier: 'lean' };
  return { ...c };
}

function publish(pool) {
  const tagged = pool.map(tag);
  const floors = tagged.filter((c) => c.tier === 'floor');
  const leans = tagged.filter((c) => c.tier === 'lean');
  const straights = selectStraights(floors, config.MAX_STRAIGHTS, leans);
  const picks = straights.map((c) => toPickObject(c));
  const parlay = optimizeParlay(tagged, straights, { cardDate: CARD });
  return applyDailyUnitCap(picks, parlay);
}

function parseU(units) {
  return parseFloat(String(units || '0').replace(/[^0-9.]/g, '')) || 0;
}

function parsePct(value) {
  return parseFloat(String(value == null ? '' : value).replace('%', ''));
}

function assertCard(card, label) {
  const picks = card.picks || [];
  const games = picks.map((p) => matchupKey(p));
  assert.strictEqual(new Set(games).size, games.length, `${label} two straights on one game: ${games.join(' || ')}`);
  assert.ok(picks.length <= config.MAX_STRAIGHTS, label);

  let straightUnits = 0;
  for (const pickRow of picks) {
    const ev = parsePct(pickRow.ev);
    assert.ok(Number.isFinite(ev) && ev > 0, `${label} negative straight EV ${pickRow.pick} ${pickRow.ev}`);
    if (pickRow.tier === 'lean') {
      assert.ok(ev > 0, `${label} lean ${pickRow.ev}`);
      assert.ok(parseU(pickRow.units) <= config.LEAN_MAX_UNITS + 1e-9, `${label} lean units ${pickRow.units}`);
    } else {
      assert.ok(ev + 1e-6 >= config.GATES.minEV.default * 100, `${label} floor ${pickRow.ev}`);
    }
    if (String(pickRow.rating || '').toLowerCase() === 'b') {
      assert.ok(parseU(pickRow.units) <= config.B_GRADE_UNIT_CAP + 1e-9, `${label} B units ${pickRow.units}`);
    }
    const units = parseU(pickRow.units);
    assert.ok(units <= config.MAX_STRAIGHT_UNITS_PER_PICK + 1e-9, `${label} units ${pickRow.units}`);
    assert.ok(units >= 0, pickRow.units);
    straightUnits += units;
  }
  assert.ok(straightUnits <= config.STRAIGHT_UNIT_BUDGET + 1e-9, `${label} straight budget ${straightUnits}`);

  const tickets = card.parlayLegs || [];
  assert.ok(tickets.length <= 1, label);
  let parlayUnits = 0;
  for (const ticket of tickets) {
    parlayUnits += parseU(ticket.units);
    assert.strictEqual(parseU(ticket.units), config.LEAN_PARLAY_UNITS, `${label} parlay units ${ticket.units}`);
    assert.ok(parsePct(ticket.ev) > 0, `${label} ticket EV ${ticket.ev}`);
    const legs = ticket.legs || [];
    assert.ok(legs.length >= 2 && legs.length <= 3, `${label} leg count ${legs.length}`);
    const legGames = legs.map((leg) => matchupKey(leg));
    assert.strictEqual(new Set(legGames).size, legGames.length, `${label} same-game parlay: ${legGames.join(' || ')}`);
    for (const leg of legs) {
      assert.ok(parsePct(leg.ev) > 0, `${label} leg EV ${leg.pick} ${leg.ev}`);
    }
  }
  assert.ok(straightUnits + parlayUnits <= config.DAILY_UNIT_CAP + 1e-9, `${label} daily ${straightUnits + parlayUnits}`);
}

function stable(card) {
  return JSON.parse(JSON.stringify({
    picks: card.picks,
    parlayLegs: card.parlayLegs,
  }));
}

function assertDeterministic(pool, label) {
  const first = publish(pool);
  const second = publish(pool);
  assert.deepStrictEqual(stable(first), stable(second), `${label} drifted`);
  assertCard(first, label);
  return first;
}

function randomPool(rng, index) {
  const games = 1 + Math.floor(rng() * 7);
  const pool = [];
  for (let g = 0; g < games; g += 1) {
    const matchup = `Away ${index}-${g} @ Home ${index}-${g}`;
    const sides = 1 + Math.floor(rng() * 3);
    for (let s = 0; s < sides; s += 1) {
      const market = pick(rng, ['Spread', 'Total', 'Moneyline']);
      const line = market === 'Moneyline' ? null : Math.round((rng() * 16 - 6) * 2) / 2;
      const odds = pick(rng, [-200, -150, -110, 100, 130, 180, 220]);
      const cover = Math.round((0.35 + rng() * 0.4) * 1000) / 1000;
      const positive = rng() < 0.72;
      const ev = positive
        ? Math.round((0.02 + rng() * 0.16) * 1000) / 1000
        : Math.round((-0.08 + rng() * 0.07) * 1000) / 1000;
      const edge = positive
        ? Math.round((0.012 + rng() * 0.06) * 1000) / 1000
        : Math.round((-0.02 + rng() * 0.015) * 1000) / 1000;
      let side;
      if (market === 'Total') side = `${rng() < 0.5 ? 'Over' : 'Under'} ${line}`;
      else if (market === 'Moneyline') side = rng() < 0.5 ? `Home ${index}-${g}` : `Away ${index}-${g}`;
      else {
        const club = rng() < 0.5 ? `Home ${index}-${g}` : `Away ${index}-${g}`;
        const printed = line > 0 ? `+${line}` : String(line);
        side = `${club} ${printed}`;
      }
      pool.push(row(matchup, `${side} #${s}`, {
        market,
        line,
        odds,
        coverProb: cover,
        ev,
        edgePct: edge,
        uncertainty: Math.round((0.1 + rng() * 0.12) * 100) / 100,
        sport: pick(rng, ['NFL', 'NCAAF', 'NHL', 'MLB']),
        book: rng() < 0.8 ? 'draftkings' : 'bovada',
      }));
    }
  }
  return pool;
}

function fixedPools() {
  const same = 'Denver Broncos @ Los Angeles Chargers';
  const a = 'Dallas Cowboys @ Carolina Panthers';
  const b = 'Green Bay Packers @ Arizona Cardinals';
  const c = 'New York Jets @ Denver Broncos';
  return [
    {
      label: 'one-game',
      pool: [
        row(same, 'Under 41.5', { market: 'Total', line: 41.5, ev: 0.06, edgePct: 0.05 }),
        row(same, 'Broncos +3', { market: 'Spread', line: 3, ev: 0.05, edgePct: 0.04 }),
        row(same, 'Chargers ML', { market: 'Moneyline', line: null, ev: 0.04, edgePct: 0.03 }),
      ],
      expectStraights: 1,
      expectParlay: 0,
    },
    {
      label: 'three-floor',
      pool: [
        row(a, 'Over 46.5', { market: 'Total', line: 46.5, ev: 0.06, edgePct: 0.05, coverProb: 0.57 }),
        row(b, 'Packers -2.5', { market: 'Spread', line: -2.5, ev: 0.05, edgePct: 0.04, coverProb: 0.56 }),
        row(c, 'Jets +3.5', { market: 'Spread', line: 3.5, ev: 0.045, edgePct: 0.03, coverProb: 0.55 }),
        row(same, 'Under 40', { market: 'Total', line: 40, ev: -0.04, edgePct: 0.02, coverProb: 0.4 }),
      ],
      expectStraights: 3,
      expectParlay: 3,
    },
    {
      label: 'negative-only',
      pool: [
        row(a, 'Over 44', { market: 'Total', line: 44, ev: -0.02, edgePct: 0.04, coverProb: 0.6 }),
        row(b, 'Packers -3', { market: 'Spread', line: -3, ev: -0.01, edgePct: -0.01, coverProb: 0.52 }),
        row(c, 'Jets ML', { market: 'Moneyline', line: null, ev: 0.005, edgePct: 0.02, coverProb: 0.55 }),
      ],
      expectStraights: 1,
      expectParlay: 0,
    },
    {
      label: 'lying-ev-negative-combo',
      pool: [
        row(a, 'Over 41', { market: 'Total', line: 41, ev: 0.2, edgePct: 0.05, coverProb: 0.46 }),
        row(b, 'Packers -1', { market: 'Spread', line: -1, ev: 0.2, edgePct: 0.04, coverProb: 0.46 }),
        row(c, 'Jets +7', { market: 'Spread', line: 7, ev: 0.2, edgePct: 0.03, coverProb: 0.46 }),
      ],
      expectParlay: 0,
    },
    {
      label: 'grade-b-cap',
      pool: [
        row(a, 'Over 47', { market: 'Total', line: 47, ev: 0.05, edgePct: 0.018, coverProb: 0.62 }),
        row(b, 'Packers -3.5', { market: 'Spread', line: -3.5, ev: 0.05, edgePct: 0.018, coverProb: 0.62 }),
        row(c, 'Jets +1', { market: 'Spread', line: 1, ev: 0.05, edgePct: 0.018, coverProb: 0.62 }),
      ],
      expectStraights: 3,
      maxStraightUnits: config.B_GRADE_UNIT_CAP,
    },
    {
      label: 'leans-only',
      pool: [
        row(a, 'Over 43', { market: 'Total', line: 43, ev: 0.012, edgePct: 0.02, coverProb: 0.55 }),
        row(b, 'Packers +3', { market: 'Spread', line: 3, ev: 0.011, edgePct: 0.016, coverProb: 0.54 }),
        row(c, 'Jets ML', { market: 'Moneyline', line: null, odds: 120, ev: 0.01, edgePct: 0.02, coverProb: 0.52 }),
      ],
      expectStraights: 3,
      expectTier: 'lean',
      maxStraightUnits: config.LEAN_MAX_UNITS,
    },
  ];
}

let publishedStraights = 0;
let publishedParlays = 0;
let emptyCards = 0;
let threeLeg = 0;

for (const spec of fixedPools()) {
  const card = assertDeterministic(spec.pool, spec.label);
  if (spec.expectStraights != null) assert.strictEqual(card.picks.length, spec.expectStraights, spec.label);
  if (spec.expectParlay != null) {
    const legs = card.parlayLegs[0] ? card.parlayLegs[0].legs.length : 0;
    assert.strictEqual(legs, spec.expectParlay, spec.label);
  }
  if (spec.expectTier) assert.ok(card.picks.every((p) => p.tier === spec.expectTier), spec.label);
  if (spec.maxStraightUnits != null) {
    for (const pickRow of card.picks) {
      assert.ok(parseU(pickRow.units) <= spec.maxStraightUnits + 1e-9, `${spec.label} ${pickRow.units}`);
    }
  }
  publishedStraights += card.picks.length;
  if (card.parlayLegs.length) {
    publishedParlays += 1;
    if (card.parlayLegs[0].legs.length === 3) threeLeg += 1;
  }
  if (!card.picks.length && !card.parlayLegs.length) emptyCards += 1;
}

const rng = mulberry32(SEED);
for (let i = 0; i < TRIALS; i += 1) {
  const pool = randomPool(rng, i);
  const card = assertDeterministic(pool, `trial ${i}`);
  publishedStraights += card.picks.length;
  if (card.parlayLegs.length) {
    publishedParlays += 1;
    if (card.parlayLegs[0].legs.length === 3) threeLeg += 1;
  } else {
    emptyCards += 1;
  }
}

assert.ok(publishedStraights > 0, 'no straight was published');
assert.ok(publishedParlays > 0, 'no parlay was published');
assert.ok(threeLeg > 0, 'no 3-leg parlay was published');
assert.ok(emptyCards > 0, 'a negative pool still published');

console.log('PASS test-omega-card-invariants');
console.log(JSON.stringify({
  seed: SEED,
  trials: TRIALS,
  publishedStraights,
  publishedParlays,
  threeLeg,
  emptyCards,
}));
