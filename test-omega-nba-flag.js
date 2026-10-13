'use strict';
/**
 * NBA daily module is off unless OMEGA_NBA=1.
 * Off: zero NBA candidates and the card matches a slate with no NBA games.
 * On: a fixture slate prices NBA on the Pinnacle no-vig anchor and DraftKings.
 * Aliases resolve. London Lions does not. No network.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const id = require(path.join(root, 'sports/team_identity'));
const client = require('./js/omega-team-identity');
const cal = require(path.join(root, 'season_calendar'));
const { projectAll } = require(path.join(root, 'index'));
const { applyExecutionBook } = require(path.join(root, 'selection_pass'));
const { calibrateAll } = require(path.join(root, 'calibrate'));
const { attachEv } = require(path.join(root, 'edge'));
const { applyGates } = require(path.join(root, 'gates'));
const { selectStraights, toPickObject, applyDailyUnitCap } = require(path.join(root, 'select'));
const { optimizeParlay } = require(path.join(root, 'parlay'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.40-omega-vnext-price-lock');
assert.ok(String(config.MODEL_NOTES).startsWith('v12.3.40-omega-vnext-price-lock:'));
assert.ok(/OMEGA_NBA=1/.test(config.MODEL_NOTES));
assert.strictEqual(config.SPORTS_ENABLED.NBA, false);
assert.strictEqual(config.NBA_CARD_LIVE, false);
assert.strictEqual(config.nbaModuleEnabled({}), false);
assert.strictEqual(config.nbaModuleEnabled({ OMEGA_NBA: '0' }), false);
assert.strictEqual(config.nbaModuleEnabled({ OMEGA_NBA: '1' }), true);

const ALIASES = [
  ['NFL', 'LA Rams', 'Los Angeles Rams'],
  ['NFL', 'LA Chargers', 'Los Angeles Chargers'],
  ['NFL', 'NY Giants', 'New York Giants'],
  ['NFL', 'NY Jets', 'New York Jets'],
  ['NCAAF', 'UL Lafayette', "Louisiana Ragin' Cajuns"],
  ['NBA', 'Sixers', 'Philadelphia 76ers'],
  ['NBA', 'Portland Trailblazers', 'Portland Trail Blazers'],
];

for (const [sport, alias, full] of ALIASES) {
  const fullId = id.resolveTeamId(sport, full);
  assert.ok(fullId, `${sport} ${full}`);
  assert.strictEqual(id.resolveTeamId(sport, alias), fullId, alias);
  assert.strictEqual(client.resolveTeamId(sport, alias), fullId, `client ${alias}`);
  assert.strictEqual(id.sameTeam(sport, alias, full), true, alias);
}

for (const sport of ['NBA', 'NFL', 'NCAAF', 'MLB', 'NHL']) {
  assert.strictEqual(id.resolveTeamId(sport, 'London Lions'), null, sport);
  assert.strictEqual(client.resolveTeamId(sport, 'London Lions'), null, `client ${sport}`);
}
assert.strictEqual(id.resolveTeamId('NBA', 'LA'), null);
assert.strictEqual(id.resolveTeamId('NBA', 'Trail Blazers'), null);
assert.strictEqual(id.resolveTeamId('NBA', '76ers'), null);

const CARD_DATE = '2026-10-21';
const AS_OF = Date.parse('2026-10-21T16:00:00Z');

function oddsEvent(home, away, opts) {
  const spread = opts.spread;
  const total = opts.total;
  const homeMl = opts.homeMl != null ? opts.homeMl : -130;
  const awayMl = opts.awayMl != null ? opts.awayMl : 110;
  const price = opts.price != null ? opts.price : -110;
  return {
    home_team: home,
    away_team: away,
    commence_time: opts.commence || '2026-10-21T23:30:00Z',
    bookmakers: ['pinnacle', 'draftkings', 'fanduel'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
        { key: 'spreads', outcomes: [
          { name: home, price, point: spread },
          { name: away, price, point: -spread },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price, point: total },
          { name: 'Under', price, point: total },
        ] },
      ],
    })),
  };
}

function slate(withNba) {
  return {
    oddsBySport: {
      MLB: [],
      NFL: [],
      NCAAF: [],
      NHL: [oddsEvent('Colorado Avalanche', 'Dallas Stars', { spread: -1.5, total: 6.5 })],
      NBA: withNba
        ? [oddsEvent('Boston Celtics', 'New York Knicks', { spread: -2.5, total: 231.5 })]
        : [],
    },
    standingsBySport: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} },
    espnBySport: {
      NHL: { games: [{ homeTeam: 'Colorado Avalanche', awayTeam: 'Dallas Stars', seasonType: 2 }] },
      NBA: {
        games: [{
          homeTeam: 'Boston Celtics',
          awayTeam: 'New York Knicks',
          seasonType: 2,
          preseason: false,
        }],
      },
    },
    efficiencyBySport: { NFL: {}, NCAAF: {} },
    parkFactors: {},
    mlbPitcherStats: { byId: {}, byName: {}, byTeam: {} },
    gameDay: { restByTeam: { NHL: {}, NBA: {} } },
  };
}

function cardOf(candidates) {
  const execution = applyExecutionBook(candidates);
  const gated = applyGates(calibrateAll(execution.candidates).map(attachEv), {
    cardDate: CARD_DATE,
    asOfMs: AS_OF,
  });
  const selected = selectStraights(gated.yesPool, config.MAX_STRAIGHTS, gated.leanPool);
  const picks = selected.map((c) => toPickObject(c, { modelVersion: config.MODEL_VERSION }));
  const parlay = optimizeParlay(gated.yesPool, picks, { cardDate: CARD_DATE });
  const capped = applyDailyUnitCap(picks, parlay);
  return {
    picks: (capped.picks || []).map((p) => ({
      sport: p.sport,
      pick: p.pick,
      betType: p.betType,
      odds: p.odds,
      book: p.book,
      line: p.line == null ? null : p.line,
      units: p.units,
    })),
    parlay: (capped.parlayLegs || []).map((ticket) => ({
      units: ticket.units,
      legs: (ticket.legs || []).map((leg) => ({
        sport: leg.sport,
        pick: leg.pick,
        betType: leg.betType,
        odds: leg.odds,
        book: leg.book,
      })),
    })),
  };
}

const offSports = cal.sportsForCard(CARD_DATE, { env: {} });
const onSports = cal.sportsForCard(CARD_DATE, { env: { OMEGA_NBA: '1' } });
assert.ok(offSports.indexOf('NBA') === -1);
assert.ok(onSports.indexOf('NBA') !== -1);
assert.deepStrictEqual(onSports.filter((s) => s !== 'NBA'), offSports);
assert.strictEqual(cal.isCardEligible('NBA', '2026-10-19', { env: { OMEGA_NBA: '1' } }).eligible, false);
assert.strictEqual(cal.isCardEligible('NBA', CARD_DATE, { env: {} }).reason, 'nba-live-off');
assert.strictEqual(cal.isCardEligible('NHL', CARD_DATE, { env: { OMEGA_NBA: '1' } }).eligible, true);

const prev = process.env.OMEGA_NBA;
try {
  delete process.env.OMEGA_NBA;
  const withNba = projectAll(slate(true), CARD_DATE);
  const withoutNba = projectAll(slate(false), CARD_DATE);
  assert.ok(withNba.length > 0, 'other sports still price');
  assert.ok(!withNba.some((c) => c.sport === 'NBA'));
  assert.deepStrictEqual(withNba, withoutNba);
  assert.deepStrictEqual(cardOf(withNba), cardOf(withoutNba));
  assert.ok(cardOf(withNba).picks.every((p) => p.sport !== 'NBA'));

  for (const value of ['', '0', 'off', 'false', 'no', 'true']) {
    process.env.OMEGA_NBA = value;
    assert.ok(!projectAll(slate(true), CARD_DATE).some((c) => c.sport === 'NBA'), value);
  }

  process.env.OMEGA_NBA = '1';
  const live = projectAll(slate(true), CARD_DATE);
  const nba = live.filter((c) => c.sport === 'NBA');
  const rest = live.filter((c) => c.sport !== 'NBA');
  assert.ok(nba.length >= 6, `priced NBA rows ${nba.length}`);
  assert.deepStrictEqual(rest, withoutNba);
  assert.ok(nba.every((c) => c.gameDay && c.gameDay.nba && c.gameDay.nba.season === '2025-26'));
  assert.ok(nba.every((c) => Number.isFinite(c.pinnacleNoVig) && c.pinnacleNoVig > 0 && c.pinnacleNoVig < 1));
  assert.ok(nba.every((c) => c.sharpAnchorBook === 'pinnacle'));
  assert.ok(nba.every((c) => Number.isFinite(c.fair_sharp_p)));
  const execution = applyExecutionBook(nba);
  assert.strictEqual(execution.excluded.length, 0);
  assert.ok(execution.candidates.length === nba.length);
  assert.ok(execution.candidates.every((c) => c.book === 'draftkings' && c.executionBook === 'draftkings'));
  assert.ok(execution.candidates.every((c) => Number.isFinite(Number(c.odds))));
  const gated = applyGates(calibrateAll(execution.candidates).map(attachEv), {
    cardDate: CARD_DATE,
    asOfMs: AS_OF,
  });
  const seen = gated.yesPool.concat(gated.leanPool || [], gated.rejected);
  assert.strictEqual(seen.length, execution.candidates.length);
  assert.ok(seen.every((c) => c.sport === 'NBA'));

  const undated = projectAll(slate(true));
  assert.ok(undated.some((c) => c.sport === 'NBA'));
  delete process.env.OMEGA_NBA;
  assert.ok(!projectAll(slate(true)).some((c) => c.sport === 'NBA'));
} finally {
  if (prev == null) delete process.env.OMEGA_NBA;
  else process.env.OMEGA_NBA = prev;
}

console.log('test-omega-nba-flag ok');
