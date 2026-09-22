'use strict';
/** Omega v12.1 open→pick line-move — pure unit tests (no network). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const linePath = require(path.join(root, 'line_path'));
const gates = require(path.join(root, 'gates'));
const select = require(path.join(root, 'select'));
const math = require(path.join(root, 'odds_math'));

assert.strictEqual(config.MODEL_VERSION, 'v12.3.3-omega-vnext-espn-copy');
assert.ok(config.LINE_MOVE.captureSlotsET.includes('0915'));
assert.deepStrictEqual(config.LINE_MOVE.captureSlotsET, ['0600', '0730', '0900', '0915']);
assert.deepStrictEqual(config.LINE_MOVE.captureSlotsUtcEDT, ['1000', '1130', '1300', '1315']);
assert.ok(/9:15 ET line snap/.test(config.MODEL_NOTES));
assert.ok(/blockStraightRefill/.test(config.MODEL_NOTES));
assert.ok(/qualityToRating/.test(config.MODEL_NOTES));
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

// Pregame gate compares commenceTime to Date.now(). Keep the kickoff ahead
// of the clock and pass that ET date as cardDate so the steam assertion
// is what fails the candidate, not a started game.
const kickoff = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const cardDay = math.etCalendarDate(kickoff);
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
    commenceTime: kickoff,
  },
], openSnap, nowSnap);

assert.strictEqual(cands.length, 1);
assert.ok(cands[0].steamAgainst);
assert.ok(cands[0].openPrint);
assert.ok(cands[0]._steamScoreAdj < 0);

const gated = gates.applyGates(cands, { cardDate: cardDay });
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
    commenceTime: kickoff,
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

const emptyHealth = linePath.assessCaptureHealth('2026-09-22', { path: { polls: [] } }, {
  retriedCapture: true,
  retryOk: false,
});
assert.strictEqual(emptyHealth.hardFail, true);
assert.strictEqual(emptyHealth.ok, false);
assert.strictEqual(emptyHealth.usableSnapCount, 0);
assert.ok(emptyHealth.missingSlotsET.includes('0915'));
assert.strictEqual(emptyHealth.reason, 'CAPTURE_HEALTH: zero usable morning line snaps for 2026-09-22 after retry');

const partialHealth = linePath.assessCaptureHealth('2026-09-22', {
  path: { polls: [
    { hhmm: '0600', gameCount: 4, games: { a: { homeTeam: 'A' } } },
    { hhmm: '0730', gameCount: 0, games: {} },
  ] },
});
assert.strictEqual(partialHealth.hardFail, false);
assert.strictEqual(partialHealth.ok, false);
assert.strictEqual(partialHealth.usableSnapCount, 1);
assert.deepStrictEqual(partialHealth.presentSlotsET, ['0600']);
assert.ok(partialHealth.missingSlotsET.includes('0915'));
assert.ok(partialHealth.warning);
assert.strictEqual(partialHealth.reason, null);

const fullHealth = linePath.assessCaptureHealth('2026-09-22', {
  path: { polls: ['0600', '0730', '0900', '0915'].map((hhmm) => ({
    hhmm, gameCount: 2, games: { a: 1, b: 1 },
  })) },
});
assert.strictEqual(fullHealth.ok, true);
assert.strictEqual(fullHealth.hardFail, false);
assert.strictEqual(fullHealth.warning, null);
assert.strictEqual(fullHealth.usableSnapCount, 4);
assert.deepStrictEqual(fullHealth.missingSlotsET, []);
// 13:05Z = 9:05am EDT. 0915 has not come due; 0600 has.
assert.deepStrictEqual(
  linePath.missingDueSlots(['0600', '0915'], new Date('2026-09-22T13:05:00Z')),
  ['0600']
);
assert.deepStrictEqual(
  linePath.missingDueSlots(['0915'], new Date('2026-09-22T13:30:00Z')),
  ['0915']
);

const toml = fs.readFileSync(path.join(__dirname, 'netlify.toml'), 'utf8');
assert.ok(/\[functions\."capture-omega-lines"\]\s*\n\s*schedule = "0,30 10,11 \* \* \*"/.test(toml));
assert.ok(/\[functions\."capture-omega-lines-late"\]\s*\n\s*schedule = "0,15 13 \* \* \*"/.test(toml));
assert.ok(/\[functions\."warm-omega-feeds"\]\s*\n\s*schedule = "0 13 \* \* \*"/.test(toml));
assert.ok(/\[functions\."trigger-omega-shadow"\]\s*\n\s*schedule = "5 13 \* \* \*"/.test(toml));
const tspBlock = toml.split('[functions."fetch-tsp-live"]')[1].split('\n[functions.')[0];
assert.ok(/^\s*schedule = "\*\/15 \* \* \* \*"/m.test(tspBlock));

const captureSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-omega-lines.js'), 'utf8');
assert.ok(captureSrc.includes("'1315'"));
assert.ok(/'1315': '0915'/.test(captureSrc));
const lateSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/capture-omega-lines-late.js'), 'utf8');
assert.ok(/capture-omega-lines/.test(lateSrc));

for (const f of ['index.js', 'select.js', 'gates.js', 'ingest.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(!/fetch-tsp-live/.test(src), `${f} must not require fetch-tsp-live`);
  assert.ok(!/['"]tsp-live['"]/.test(src), `${f} must not name the tsp-live store`);
}
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
assert.ok(/CAPTURE_HEALTH/.test(indexSrc));
assert.ok(/storeShadowPicks/.test(indexSrc));
assert.ok(!/storePmObserver\(dateISO/.test(indexSrc.slice(indexSrc.indexOf('if (!dryRun && shadow)'), indexSrc.indexOf('} else if (!dryRun && !simMode)'))));

const bgSrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/generate-picks-omega-background.js'), 'utf8');
assert.ok(/CAPTURE_HEALTH/.test(bgSrc));
assert.ok(/statusCode: 503/.test(bgSrc));
assert.ok(/shadow/.test(bgSrc));

// C1: adverse steam drop sets blockStraightRefill so TARGET_PICKS backfill does not run.
{
  const verifySrc = fs.readFileSync(path.join(__dirname, 'netlify/functions/verify-picks-omega.js'), 'utf8');
  const steamAt = verifySrc.indexOf('let droppedSteam = 0');
  const steamEnd = verifySrc.indexOf('Step 3: Sharp handicapper review', steamAt);
  assert.ok(steamAt > 0 && steamEnd > steamAt, 'steam drop block present');
  const steamRegion = verifySrc.slice(steamAt, steamEnd);
  assert.ok(
    /steamDropBlocksStraightRefill\(\s*droppedSteam\s*,\s*steamCheck\.failed\s*\)/.test(steamRegion),
    'steam drop pass consults droppedSteam before refill'
  );
  assert.ok(/blockStraightRefill\s*=\s*true/.test(steamRegion), 'steam drop sets blockStraightRefill');
  assert.ok(
    /Placeability soft-veto and adverse steam drops do not refill/.test(verifySrc),
    'backfill comment gates placeability and steam'
  );
  assert.ok(/if\s*\(\s*!blockStraightRefill\s*&&/.test(verifySrc), 'straight refill is gated by blockStraightRefill');
  const verify = require('./netlify/functions/verify-picks-omega');
  assert.strictEqual(verify.steamDropBlocksStraightRefill(1, 0), true, 'dropped steam blocks refill');
  assert.strictEqual(verify.steamDropBlocksStraightRefill(0, 2), true, 'earlier steam hard-fails block refill');
  assert.strictEqual(verify.steamDropBlocksStraightRefill(0, 0), false, 'clean card may still refill');
}

console.log('PASS test-omega-linemove', {
  MODEL_VERSION: config.MODEL_VERSION,
  US_BOOK_PRIORITY: config.US_BOOK_PRIORITY.slice(0, 5),
  rejectSteamAgainstCents: config.LINE_MOVE.rejectSteamAgainstCents,
  verifyAdverseCents: config.LINE_MOVE.verifyAdverseCents,
});
