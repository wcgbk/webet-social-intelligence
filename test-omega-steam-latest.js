'use strict';
/**
 * Steam selection uses the latest 3:00/10:00 snapshot, not a morning snap.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const {
  quotesFromEvent, selectionPollsFromDoc, linePathForSelection,
} = require(path.join(root, 'pinnacle_line_move'));
const { annotateLineMoves, adverseSteamReason } = require(path.join(root, 'line_path'));
const { baselinePolls, BASELINE_SLOTS } = require(path.join(root, 'dk_lag'));

const HOME = 'Kansas City Chiefs';
const AWAY = 'Buffalo Bills';
const DATE = '2026-10-13';

function board(book, prices) {
  return {
    id: 'ev1',
    commence_time: '2026-10-13T23:00:00Z',
    home_team: HOME,
    away_team: AWAY,
    bookmakers: [{
      key: book,
      markets: [
        { key: 'h2h', outcomes: [
          { name: HOME, price: prices.home },
          { name: AWAY, price: prices.away },
        ] },
        { key: 'spreads', outcomes: [
          { name: HOME, price: -110, point: prices.homePoint },
          { name: AWAY, price: -110, point: prices.awayPoint },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: prices.total },
          { name: 'Under', price: -110, point: prices.total },
        ] },
      ],
    }],
  };
}

function quotes(book, prices, at) {
  return quotesFromEvent(board(book, prices), 'NFL', { at, dateISO: DATE }, book);
}

function doc(dkNow) {
  const at3 = '2026-10-13T07:00:00Z';
  const at10 = '2026-10-13T14:00:00Z';
  const base = { home: -110, away: -110, homePoint: -3, awayPoint: 3, total: 47.5 };
  return {
    schema: 'omega-pinnacle-line-moves-v1',
    sport: 'NFL',
    eventId: 'ev1',
    homeTeam: HOME,
    awayTeam: AWAY,
    date: DATE,
    checks: [
      {
        slot: '0300',
        at: at3,
        books: {
          pinnacle: quotes('pinnacle', base, at3),
          draftkings: quotes('draftkings', base, at3),
        },
      },
      {
        slot: '1000',
        at: at10,
        books: {
          pinnacle: quotes('pinnacle', { ...base, homePoint: -3.5, awayPoint: 3.5 }, at10),
          draftkings: quotes('draftkings', dkNow, at10),
        },
      },
    ],
  };
}

function homeMl() {
  return {
    sport: 'NFL',
    market: 'Moneyline',
    side: HOME,
    homeTeam: HOME,
    awayTeam: AWAY,
    odds: -130,
    line: null,
  };
}

const polls = selectionPollsFromDoc(doc({ home: -130, away: 110, homePoint: -3.5, awayPoint: 3.5, total: 47.5 }), { dateISO: DATE });
assert.strictEqual(polls.earliest.hhmm, '0300');
assert.strictEqual(polls.latest.hhmm, '1000');
assert.ok(polls.latest.gameCount > 0);

const annotated = annotateLineMoves([homeMl()], polls.earliest, polls.latest);
assert.strictEqual(annotated[0].lineMove.missingOpen, false);
assert.ok(annotated[0].lineMove.oddsMoveCents <= -18, String(annotated[0].lineMove.oddsMoveCents));
const reason = adverseSteamReason(annotated[0].lineMove, { market: 'Moneyline' });
assert.ok(reason && reason.indexOf('steam_against_odds') === 0, reason);
assert.ok(annotated[0]._steamScoreAdj < 0);

const toward = annotateLineMoves(
  [{ ...homeMl(), odds: 100 }],
  polls.earliest,
  selectionPollsFromDoc(doc({ home: 100, away: -120, homePoint: -2.5, awayPoint: 2.5, total: 47.5 }), { dateISO: DATE }).latest,
);
assert.strictEqual(toward[0].steamToward, true);
assert.ok(toward[0]._steamScoreAdj > 0);

const morning = {
  path: { polls: [{ hhmm: '0600', games: { old: { books: {} } } }] },
  earliest: { hhmm: '0600', slot: '0600', games: { old: {} } },
  latest: { hhmm: '0915', slot: '0915', games: { old: {} } },
};
const chosen = linePathForSelection(morning, doc({ home: -130, away: 110, homePoint: -3.5, awayPoint: 3.5, total: 47.5 }), { dateISO: DATE });
assert.strictEqual(chosen.source, 'pinnacle-latest');
assert.strictEqual(chosen.latest.hhmm, '1000');
assert.notStrictEqual(chosen.latest.hhmm, '0915');

const kept = linePathForSelection(morning, null, { dateISO: DATE });
assert.strictEqual(kept.source, 'morning-line-path');
assert.strictEqual(kept.latest.hhmm, '0915');

const baseFirst = baselinePolls(
  [{ hhmm: '0600', games: { a: 1 } }, { hhmm: '0300', games: { b: 1 } }, { hhmm: '1000', games: { c: 1 } }],
  { hhmm: '0600', games: { a: 1 } },
);
assert.deepStrictEqual(baseFirst.map((p) => p.hhmm), ['0300']);
assert.ok(BASELINE_SLOTS.includes('0300'));

const legacy = baselinePolls([{ hhmm: '0600', games: { a: 1 } }, { hhmm: '0915', games: { a: 1 } }], null);
assert.deepStrictEqual(legacy.map((p) => p.hhmm), ['0600', '0915']);

console.log('test-omega-steam-latest: ok');
