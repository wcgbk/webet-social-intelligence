'use strict';
/**
 * DraftKings lags Pinnacle. Fixtures only. No network.
 * lagEdge is marketEv when the one-book no-vig moved at least +1.0pp
 * toward the side and DraftKings implied moved less than half of that.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const edge = require(path.join(root, 'edge'));
const dk = require(path.join(root, 'dk_lag'));
const ledger = require(path.join(root, 'candidate_ledger'));
const { americanToDecimal, americanToImplied, evAtOdds } = require(path.join(root, 'odds_math'));

function close(actual, expected, eps = 1e-9) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

function mlGame(pinHome, pinAway, dkHome, dkAway, extraBooks) {
  return {
    awayTeam: 'Dallas Cowboys',
    homeTeam: 'Philadelphia Eagles',
    books: Object.assign({
      pinnacle: { mlHome: pinHome, mlAway: pinAway },
      draftkings: { mlHome: dkHome, mlAway: dkAway },
    }, extraBooks || {}),
  };
}

function poll(hhmm, game) {
  return {
    hhmm,
    slot: hhmm,
    games: { 'dallas cowboys @ philadelphia eagles': game },
  };
}

function side(over) {
  return Object.assign({
    sport: 'NFL',
    market: 'Moneyline',
    side: 'Philadelphia Eagles',
    homeTeam: 'Philadelphia Eagles',
    awayTeam: 'Dallas Cowboys',
    matchup: 'Dallas Cowboys @ Philadelphia Eagles',
    book: 'draftkings',
    odds: -110,
    line: null,
    coverProb: 0.50,
    fair_sharp_p: 0.55,
    pinnacleNoVigP: 0.55,
    sharpAnchorBook: 'pinnacle',
  }, over || {});
}

function prices(book, american) {
  return [{ book, american }];
}

{
  assert.strictEqual(config.MODEL_VERSION, 'v12.3.61-omega-vnext-price-lock');
  assert.strictEqual(config.DK_LAG.minPinMovePp, 1.0);
  assert.strictEqual(config.DK_LAG.maxDkFollowRatio, 0.5);
  assert.ok(/OMEGA_DK_LAG=0/.test(config.MODEL_NOTES));
  assert.ok(/DraftKings lags Pinnacle/.test(config.MODEL_NOTES));
  assert.ok(/Offline eval 2026-09-26\.\.10-10: n lag \d+/.test(config.MODEL_NOTES));
  assert.ok(/all-candidate LL off /.test(config.MODEL_NOTES));
  assert.ok(!/placeholder/.test(config.MODEL_NOTES));
  assert.strictEqual(dk.dkLagEnabled({}), true);
  assert.strictEqual(dk.dkLagEnabled({ OMEGA_DK_LAG: '' }), true);
  assert.strictEqual(dk.dkLagEnabled({ OMEGA_DK_LAG: '0' }), false);
  assert.strictEqual(dk.dkLagEnabled({ OMEGA_DK_LAG: 'off' }), false);
}

{
  const dec = americanToDecimal(-110);
  const fired = dk.lagDecision({
    pinNow: 0.55,
    pinBase: 0.53,
    dkNow: americanToImplied(-110),
    dkBase: americanToImplied(-110),
    dkDecimal: dec,
    enabled: true,
  });
  close(fired.pinMove, 0.02);
  close(fired.dkMove, 0);
  close(fired.marketEv, 0.05);
  close(fired.lagEdge, 0.05);

  const half = dk.lagDecision({
    pinNow: 0.55,
    pinBase: 0.53,
    dkNow: 0.51,
    dkBase: 0.50,
    dkDecimal: dec,
    enabled: true,
  });
  assert.strictEqual(half.lagEdge, null);
  close(half.pinMove, 0.02);
  close(half.dkMove, 0.01);

  const followed = dk.lagDecision({
    pinNow: 0.55,
    pinBase: 0.53,
    dkNow: americanToImplied(-110),
    dkBase: americanToImplied(100),
    dkDecimal: dec,
    enabled: true,
  });
  assert.ok(followed.dkMove > followed.pinMove * 0.5);
  assert.strictEqual(followed.lagEdge, null);

  const small = dk.lagDecision({
    pinNow: 0.55,
    pinBase: 0.545,
    dkNow: 0.52,
    dkBase: 0.52,
    dkDecimal: dec,
    enabled: true,
  });
  assert.strictEqual(small.lagEdge, null);
  close(small.pinMove, 0.005);

  const negative = dk.lagDecision({
    pinNow: 0.52,
    pinBase: 0.50,
    dkNow: 0.52,
    dkBase: 0.52,
    dkDecimal: dec,
    enabled: true,
  });
  assert.ok(negative.marketEv < 0);
  assert.strictEqual(negative.lagEdge, null);

  const away = dk.lagDecision({
    pinNow: 0.50,
    pinBase: 0.53,
    dkNow: 0.50,
    dkBase: 0.50,
    dkDecimal: dec,
    enabled: true,
  });
  assert.ok(away.pinMove < 0);
  assert.strictEqual(away.lagEdge, null);

  const off = dk.lagDecision({
    pinNow: 0.55,
    pinBase: 0.53,
    dkNow: americanToImplied(-110),
    dkBase: americanToImplied(-110),
    dkDecimal: dec,
    enabled: false,
  });
  assert.strictEqual(off.lagEdge, null);
  close(off.pinMove, 0.02);
  close(off.marketEv, 0.05);
}

{
  const morning = poll('0600', mlGame(182, 218, -110, -110));
  const base = morning.games['dallas cowboys @ philadelphia eagles'];
  const pinBase = dk.probsFromRow(base.books.pinnacle, 'ML', 'home');
  close(pinBase.noVig, 0.53);

  const input = side();
  const before = JSON.stringify(input);
  const [fired] = dk.applyDkLag([input], { polls: [morning], opener: null, enabled: true });
  assert.strictEqual(JSON.stringify(input), before);
  close(fired.coverProb, 0.55);
  close(fired.ev, +evAtOdds(0.55, -110).toFixed(4));
  close(fired.edgePct, 0.05);
  close(fired.lagEdge, 0.05);
  close(fired.pinMove, 0.02);
  close(fired.dkMove, 0);
  close(fired.marketEv, 0.05);

  const higher = side({ coverProb: 0.60, edgePct: 0.05, fair_sharp_p: 0.55 });
  const [kept] = dk.applyDkLag([higher], { polls: [morning], opener: null, enabled: true });
  close(kept.coverProb, 0.60);
  close(kept.edgePct, 0.10);
  close(kept.ev, +evAtOdds(0.60, -110).toFixed(4));
  close(kept.lagEdge, 0.05);

  const [again] = dk.applyDkLag([fired], { polls: [morning], opener: null, enabled: true });
  close(again.coverProb, fired.coverProb);
  close(again.edgePct, fired.edgePct);
  close(again.lagEdge, fired.lagEdge);

  const [disabled] = dk.applyDkLag([side({ edgePct: -0.05 })], {
    polls: [morning],
    opener: null,
    env: { OMEGA_DK_LAG: '0' },
  });
  assert.strictEqual(disabled.lagEdge, null);
  close(disabled.coverProb, 0.50);
  close(disabled.edgePct, -0.05);
  close(disabled.pinMove, 0.02);
  assert.ok(disabled.marketEv > 0);

  const follow = poll('0600', mlGame(182, 218, 100, 100));
  const [chased] = dk.applyDkLag([side()], { polls: [follow], opener: null, enabled: true });
  assert.strictEqual(chased.lagEdge, null);
  close(chased.coverProb, 0.50);
  assert.ok(chased.dkMove > chased.pinMove * 0.5);
}

{
  const morning = poll('0600', mlGame(182, 218, -110, -110));
  const opener = poll('0500', mlGame(150, -180, 150, -180));
  const [usedMorning] = dk.applyDkLag([side()], { polls: [morning], opener, enabled: true });
  close(usedMorning.pinMove, 0.02);
  assert.ok(usedMorning.lagEdge > 0);

  const emptyMorning = poll('0600', {
    awayTeam: 'Dallas Cowboys',
    homeTeam: 'Philadelphia Eagles',
    books: { pinnacle: { total: 45.5, overOdds: -110, underOdds: -110 } },
  });
  const [usedOpener] = dk.applyDkLag([side({ pinnacleNoVigP: 0.55 })], {
    polls: [emptyMorning],
    opener,
    enabled: true,
  });
  assert.ok(usedOpener.pinMove > 0.1);
  assert.strictEqual(usedOpener.lagEdge, null);

  const circaOnly = poll('0730', {
    awayTeam: 'Dallas Cowboys',
    homeTeam: 'Philadelphia Eagles',
    books: {
      circa: { mlHome: 182, mlAway: 218 },
      draftkings: { mlHome: -110, mlAway: -110 },
    },
  });
  const [noBorrow] = dk.applyDkLag([side()], { polls: [circaOnly], opener: null, enabled: true });
  assert.strictEqual(noBorrow.pinMove, null);
  assert.strictEqual(noBorrow.lagEdge, null);

  const [circaAnchor] = dk.applyDkLag([side({ sharpAnchorBook: 'circa' })], {
    polls: [circaOnly],
    opener: null,
    enabled: true,
  });
  close(circaAnchor.pinMove, 0.02);
  close(circaAnchor.lagEdge, 0.05);
}

{
  const home = { side: 'Home Team', point: null, prices: prices('pinnacle', -110) };
  const awayMixed = { side: 'Away Team', point: null, prices: prices('circa', -110) };
  assert.strictEqual(edge.pairedSharpNoVig([home, awayMixed], home), null);

  const awayPin = { side: 'Away Team', point: null, prices: prices('pinnacle', -110) };
  const paired = edge.pairedSharpNoVig([home, awayPin], home);
  assert.strictEqual(paired.book, 'pinnacle');
  close(paired.p, 0.5);

  const circaHome = { side: 'Home Team', point: null, prices: prices('circa', -110) };
  const circaAway = { side: 'Away Team', point: null, prices: prices('circa', -110) };
  const circa = edge.pairedSharpNoVig([circaHome, circaAway], circaHome);
  assert.strictEqual(circa.book, 'circa');
  close(circa.p, 0.5);

  const oneSide = {
    home_team: 'Home Team',
    away_team: 'Away Team',
    bookmakers: [{
      key: 'pinnacle',
      markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 45.5 }] }],
    }],
  };
  assert.strictEqual(dk.quoteEventSide(oneSide, 'pinnacle', 'total', 'over', 45.5), null);

  const both = {
    home_team: 'Home Team',
    away_team: 'Away Team',
    bookmakers: [
      {
        key: 'pinnacle',
        markets: [{
          key: 'totals',
          outcomes: [
            { name: 'Over', price: -115, point: 45.5 },
            { name: 'Under', price: -105, point: 45.5 },
            { name: 'Over', price: -110, point: 46.5 },
            { name: 'Under', price: -110, point: 46.5 },
          ],
        }],
      },
      {
        key: 'circa',
        markets: [{
          key: 'totals',
          outcomes: [
            { name: 'Over', price: -110, point: 45.5 },
            { name: 'Under', price: -110, point: 45.5 },
          ],
        }],
      },
    ],
  };
  const atLine = dk.lockAnchor(both, 'total', 'over', 45.5);
  assert.strictEqual(atLine.book, 'pinnacle');
  assert.ok(atLine.p > 0.5);
  assert.strictEqual(dk.lockAnchor(both, 'total', 'over', 44), null);
  const circaEvent = {
    home_team: 'Home Team',
    away_team: 'Away Team',
    bookmakers: both.bookmakers.filter((b) => b.key === 'circa'),
  };
  const circaLock = dk.lockAnchor(circaEvent, 'total', 'over', 45.5);
  assert.strictEqual(circaLock.book, 'circa');
  close(circaLock.p, 0.5);
}

{
  const row = ledger.buildCandidateLedger({
    generatedAt: '2026-10-04T14:30:00.000Z',
    yesPool: [side({ lagEdge: 0.05, pinMove: 0.02, dkMove: 0 })],
    leanPool: [side({
      matchup: 'Other @ Host',
      side: 'Other',
      homeTeam: 'Host',
      awayTeam: 'Other',
      lagEdge: 0.02,
      pinMove: 0.03,
      dkMove: 0.004,
    })],
    rejected: [],
    picks: [],
    parlayLegs: [],
  });
  assert.strictEqual(row.candidates.length, 2);
  const yes = row.candidates.find((c) => c.reason === 'yes');
  const lean = row.candidates.find((c) => c.reason === 'lean');
  close(yes.lagEdge, 0.05);
  close(yes.pinMove, 0.02);
  close(yes.dkMove, 0);
  close(lean.lagEdge, 0.02);
  close(lean.pinMove, 0.03);
  close(lean.dkMove, 0.004);
  const absent = ledger.buildCandidateLedger({
    generatedAt: '2026-10-04T14:30:00.000Z',
    yesPool: [side()],
    rejected: [],
    picks: [],
    parlayLegs: [],
  });
  assert.strictEqual(absent.candidates[0].lagEdge, null);
  assert.strictEqual(absent.candidates[0].pinMove, null);
  assert.strictEqual(absent.candidates[0].dkMove, null);
}

{
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const lagAt = indexSrc.indexOf('applyDkLag(');
  const gateAt = indexSrc.indexOf('applyGates(');
  assert.ok(lagAt > 0);
  assert.ok(gateAt > lagAt);
  assert.ok(indexSrc.includes('leanPool'));
  const selectSrc = fs.readFileSync(path.join(root, 'select.js'), 'utf8');
  assert.ok(/passesLeanFill/.test(selectSrc));
  assert.ok(!/lagEdge/.test(selectSrc));
}

console.log('PASS test-omega-dklag');
