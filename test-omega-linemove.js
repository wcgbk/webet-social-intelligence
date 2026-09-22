'use strict';
/** Omega v12.1 open→pick line-move — pure unit tests (no network). */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const linePath = require(path.join(root, 'line_path'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const math = require(path.join(root, 'odds_math'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.0-omega-vnext-game-day');
assert.ok(Array.isArray(config.US_BOOK_PRIORITY));
assert.ok(config.US_BOOK_PRIORITY[0] === 'draftkings');
assert.ok(config.LINE_MOVE.rejectSteamAgainstCents === 18);
assert.ok(config.LINE_MOVE.verifyAdverseCents === 20);
assert.ok(config.GATES.rejectAdverseSteam === true);
assert.ok(config.SHRINK_K.Spread >= 0.68);
assert.ok(config.HFA.NFL >= 2.1);

// Day-scope still intact
assert.ok(math.isSameEtDay('2026-09-22T23:05:00Z', '2026-09-22'));
assert.ok(!math.isSameEtDay('2026-09-27T17:00:00Z', '2026-09-22'));

// --- extractGameBooks / gameKey ---
assert.strictEqual(linePath.gameKey('Yankees', 'Red Sox'), 'yankees @ red sox');

const fakeEvent = {
  home_team: 'Kansas City Chiefs',
  away_team: 'Buffalo Bills',
  commence_time: '2026-09-22T23:20:00Z',
  bookmakers: [
    {
      key: 'draftkings',
      markets: [
        { key: 'spreads', outcomes: [
          { name: 'Kansas City Chiefs', point: -3.0, price: -110 },
          { name: 'Buffalo Bills', point: 3.0, price: -110 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', point: 47.5, price: -110 },
          { name: 'Under', point: 47.5, price: -110 },
        ]},
        { key: 'h2h', outcomes: [
          { name: 'Kansas City Chiefs', price: -150 },
          { name: 'Buffalo Bills', price: 130 },
        ]},
      ],
    },
    {
      key: 'pinnacle',
      markets: [
        { key: 'spreads', outcomes: [
          { name: 'Kansas City Chiefs', point: -2.5, price: -105 },
          { name: 'Buffalo Bills', point: 2.5, price: -105 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', point: 47.0, price: -108 },
          { name: 'Under', point: 47.0, price: -108 },
        ]},
        { key: 'h2h', outcomes: [
          { name: 'Kansas City Chiefs', price: -145 },
          { name: 'Buffalo Bills', price: 125 },
        ]},
      ],
    },
  ],
};

const extracted = linePath.extractGameBooks(fakeEvent);
assert.strictEqual(extracted.homeTeam, 'Kansas City Chiefs');
assert.ok(extracted.books.draftkings.spreadHome === -3);
assert.ok(extracted.usConsensus.spreadHome === -3);
assert.ok(extracted.sharpConsensus.spreadHome === -2.5);

// --- Move math: steam toward dog (line moves from +3 to +4) ---
const openGame = {
  ...extracted,
  books: {
    draftkings: {
      spreadHome: -3, spreadHomeOdds: -110, spreadAway: 3, spreadAwayOdds: -110,
      total: 47.5, overOdds: -110, underOdds: -110, mlHome: -150, mlAway: 130,
    },
  },
  capturedAt: '2026-09-22T10:00:00Z',
};
const nowToward = {
  ...extracted,
  books: {
    draftkings: {
      spreadHome: -4, spreadHomeOdds: -110, spreadAway: 4, spreadAwayOdds: -110,
      total: 47.5, overOdds: -110, underOdds: -110, mlHome: -165, mlAway: 145,
    },
  },
};

const billsSpread = {
  market: 'Spread',
  side: 'Buffalo Bills +3',
  homeTeam: 'Kansas City Chiefs',
  awayTeam: 'Buffalo Bills',
  line: 3,
  odds: -110,
  predictedClv: 1.0,
};
const moveToward = linePath.computeOpenToNowMove(billsSpread, openGame, nowToward);
assert.ok(moveToward.steamToward, 'Bills getting more points = steam toward');
assert.ok(!moveToward.steamAgainst);
assert.ok(moveToward.openPrint && moveToward.openPrint.book === 'draftkings');
assert.ok(moveToward.lineMovePts === 1 || moveToward.lineMovePts === 1.0);

// --- Move math: steam against (odds shorten on ML dog) ---
const billsMl = {
  market: 'Moneyline',
  side: 'Buffalo Bills',
  homeTeam: 'Kansas City Chiefs',
  awayTeam: 'Buffalo Bills',
  odds: 130,
  predictedClv: 2.0,
};
const nowAgainstMl = {
  ...extracted,
  books: {
    draftkings: {
      spreadHome: -3, spreadHomeOdds: -110, spreadAway: 3, spreadAwayOdds: -110,
      total: 47.5, overOdds: -110, underOdds: -110, mlHome: -180, mlAway: 105,
    },
  },
};
const moveAgainst = linePath.computeOpenToNowMove(billsMl, openGame, nowAgainstMl);
assert.ok(moveAgainst.steamAgainst, 'ML shortened 130→105 = steam against');
assert.ok(moveAgainst.oddsMoveCents === -25);

const genReject = linePath.adverseSteamReason(moveAgainst, { verify: false });
assert.ok(genReject && /steam_against_odds/.test(genReject), 'generate should reject -25c');

const verifyReject = linePath.adverseSteamReason(moveAgainst, { verify: true });
assert.ok(verifyReject && /steam_against_odds/.test(verifyReject), 'verify should reject -25c');

// Just under generate threshold (-18): -17 should NOT reject at generate
const mild = {
  ...moveAgainst,
  oddsMoveCents: -17,
  steamAgainst: true,
  towardScore: -0.5,
  lineMovePts: null,
  missingOpen: false,
};
assert.strictEqual(linePath.adverseSteamReason(mild, { verify: false }), null);
// But -20 should reject at verify
const atVerify = { ...mild, oddsMoveCents: -20 };
assert.ok(linePath.adverseSteamReason(atVerify, { verify: true }));

// Spread adverse pts at generate threshold (1.0)
const spreadAgainst = linePath.computeOpenToNowMove(
  { ...billsSpread, side: 'Buffalo Bills +3', line: 3 },
  openGame,
  {
    ...extracted,
    books: {
      draftkings: {
        spreadHome: -2, spreadHomeOdds: -110, spreadAway: 2, spreadAwayOdds: -110,
        total: 47.5, overOdds: -110, underOdds: -110, mlHome: -150, mlAway: 130,
      },
    },
  }
);
assert.ok(spreadAgainst.steamAgainst, 'dog points cut 3→2 = against');
const sprReason = linePath.adverseSteamReason(spreadAgainst, { verify: false, market: 'Spread' });
assert.ok(sprReason && /steam_against_line/.test(sprReason), '1.0 pt adverse should reject at gen');

// --- annotateLineMoves + gates ---
const openSnap = {
  hhmm: '0600',
  capturedAt: '2026-09-22T10:00:00Z',
  games: {
    [linePath.gameKey('Buffalo Bills', 'Kansas City Chiefs')]: openGame,
  },
};
const nowSnap = {
  hhmm: '0900',
  games: {
    [linePath.gameKey('Buffalo Bills', 'Kansas City Chiefs')]: nowAgainstMl,
  },
};

const cands = linePath.annotateLineMoves([
  {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    side: 'Buffalo Bills',
    market: 'Moneyline',
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    odds: 105,
    coverProb: 0.55,
    ev: 0.06,
    edgePct: 0.04,
    predictedClv: 2.0,
    liquid: true,
    commenceTime: '2026-09-22T23:20:00Z',
  },
], openSnap, nowSnap);

assert.strictEqual(cands.length, 1);
assert.ok(cands[0].steamAgainst);
assert.ok(cands[0].openPrint);
assert.ok(cands[0]._steamScoreAdj < 0);

const gated = gates.applyGates(cands, { cardDate: '2026-09-22' });
assert.strictEqual(gated.yesPool.length, 0, 'adverse steam ML must be gated out; rejected=' + JSON.stringify(gated.rejected.map(r => r.rejectReason)));
assert.ok(gated.rejected.some(r => /steam_against/.test(r.rejectReason)), 'reasons=' + gated.rejected.map(r => r.rejectReason).join(','));

// Steam toward + still +EV should boost score vs identical without steam
const towardSnap = {
  hhmm: '0900',
  games: {
    [linePath.gameKey('Buffalo Bills', 'Kansas City Chiefs')]: nowToward,
  },
};
const towardCands = linePath.annotateLineMoves([
  {
    sport: 'NFL',
    matchup: 'Buffalo Bills @ Kansas City Chiefs',
    side: 'Buffalo Bills +3',
    market: 'Spread',
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    line: 4,
    odds: -110,
    coverProb: 0.55,
    ev: 0.05,
    edgePct: 0.04,
    predictedClv: 1.5,
    liquid: true,
    commenceTime: '2026-09-22T23:20:00Z',
    uncertainty: 0.15,
  },
], openSnap, towardSnap);
assert.ok(towardCands[0].steamToward);
const scoreWith = select.scoreCandidate(towardCands[0]);
const scorePlain = select.scoreCandidate({
  ...towardCands[0],
  steamToward: false,
  _steamScoreAdj: 0,
  predictedResidualClv: towardCands[0].predictedClv,
});
assert.ok(scoreWith > scorePlain, `steam boost ${scoreWith} vs ${scorePlain}`);

// Unit structure unchanged
assert.strictEqual(config.STRAIGHT_UNIT_BUDGET, 3.5);
assert.strictEqual(config.PARLAY_FIXED_UNITS, 0.5);
assert.strictEqual(config.DAILY_UNIT_CAP, 4.0);
assert.strictEqual(config.LEAN_PAD, false);
assert.strictEqual(config.CLV_KPI_FLOOR, '2026-09-22');

// earliest/latest poll helper
const { earliest, latest } = linePath.earliestAndLatestPolls({
  polls: [
    { hhmm: '0900', games: {} },
    { hhmm: '0600', games: {} },
    { hhmm: '0730', games: {} },
  ],
});
assert.strictEqual(earliest.hhmm, '0600');
assert.strictEqual(latest.hhmm, '0900');

console.log('PASS test-omega-linemove', {
  MODEL_VERSION: config.MODEL_VERSION,
  US_BOOK_PRIORITY: config.US_BOOK_PRIORITY.slice(0, 5),
  rejectSteamAgainstCents: config.LINE_MOVE.rejectSteamAgainstCents,
  verifyAdverseCents: config.LINE_MOVE.verifyAdverseCents,
});
