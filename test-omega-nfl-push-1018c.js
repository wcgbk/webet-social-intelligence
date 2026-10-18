'use strict';
// NFL empirical push mass and rating SD at n = 0 (2026-10-18).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const km = require('./netlify/functions/lib/omega-vnext/key_mass');
const config = require('./netlify/functions/lib/omega-vnext/config');
const { ratingSeOf } = require('./netlify/functions/lib/omega-vnext/prob_anchor');
const { pushAwareEv, pushAwareKelly } = require('./netlify/functions/lib/omega-vnext/push_ev');
const { evAtOdds, kellyFraction } = require('./netlify/functions/lib/omega-vnext/odds_math');
const cfb = require('./netlify/functions/lib/omega-vnext/sports/cfb');

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a} (Δ ${a - b})`);
}

function wilson95(count, n) {
  const z = 1.959963984540054;
  const phat = count / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / den;
  const half = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n)) / den;
  return { p: phat, lo: center - half, hi: center + half, center };
}

function loadFinals() {
  const abs = [];
  for (let k = 0; k <= 21; k++) abs[k] = 0;
  const totals = {};
  let n = 0;
  let ties = 0;
  let totalSum = 0;
  const types = {};
  for (const year of [2022, 2023, 2024, 2025]) {
    const rows = JSON.parse(fs.readFileSync(`/workspace/fix-1017/allsports/nfl-hist/${year}.json`, 'utf8'));
    for (const g of rows) {
      if (!Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore)) continue;
      types[g.seasonType] = (types[g.seasonType] || 0) + 1;
      const margin = g.homeScore - g.awayScore;
      const total = g.homeScore + g.awayScore;
      const k = Math.abs(margin);
      if (k <= 21) abs[k] += 1;
      totals[total] = (totals[total] || 0) + 1;
      if (margin === 0) ties += 1;
      totalSum += total;
      n += 1;
    }
  }
  return { abs, totals, n, ties, totalSum, types };
}

const finals = loadFinals();
assert.strictEqual(finals.n, 1139);
assert.strictEqual(finals.ties, 3);
assert.strictEqual(finals.types[2], 1087);
assert.strictEqual(finals.types[3], 52);
assert.strictEqual(km.NFL_FINALS_N, finals.n);
assert.strictEqual(km.NFL_TIE_COUNT, finals.ties);
assert.deepStrictEqual([...km.NFL_ABS_MARGIN_COUNTS], finals.abs);
assert.strictEqual(km.NFL_ABS_MARGIN_COUNTS[0], 3);
assert.strictEqual(km.NFL_ABS_MARGIN_COUNTS[3], 175);
assert.strictEqual(km.NFL_ABS_MARGIN_COUNTS[7], 92);
assert.strictEqual(km.NFL_TOTAL_SUM, finals.totalSum);
assert.deepStrictEqual({ ...km.NFL_TOTAL_COUNTS }, finals.totals);
assert.strictEqual(km.NFL_PUSH_PSEUDO, 16);

const rate = finals.ties / finals.n;
const wilson = wilson95(finals.ties, finals.n);
near(km.NFL_TIE_WILSON.p, rate, 0);
near(km.NFL_TIE_WILSON.lo, wilson.lo, 1e-15, 'Wilson lo');
near(km.NFL_TIE_WILSON.hi, wilson.hi, 1e-15, 'Wilson hi');
assert.ok(wilson.lo < rate && rate < wilson.hi);
assert.ok(wilson.hi < 0.01, 'tie CI stays under 1%');
assert.ok(rate < km.normalBin(0, 13.2, 0) / 5, 'tie rate is far under the normal atom');

const src = fs.readFileSync(path.join(__dirname, 'netlify/functions/lib/omega-vnext/key_mass.js'), 'utf8');
const fittedAt = src.indexOf('FITTED NFL finals');
const assumedAt = src.indexOf('ASSUMED pseudo-count');
assert.ok(fittedAt > 0, 'FITTED provenance on the counts');
assert.ok(assumedAt > fittedAt, 'ASSUMED pseudo-count follows the fitted counts');
assert.ok(assumedAt - fittedAt < 4000, 'provenance stays on the count block');
assert.ok(src.slice(fittedAt, assumedAt + 400).includes('1139'));
assert.ok(Math.abs(src.indexOf('const NFL_PUSH_PSEUDO') - assumedAt) < 500);

const table = fs.readFileSync('/workspace/fix-1017/prev/nfl-margin-freq.txt', 'utf8');
assert.ok(table.includes('1139'));
assert.ok(table.includes('175'));
assert.ok(table.includes('FITTED'));
assert.ok(table.includes('ASSUMED'));
assert.ok(/3\/1139|3 \/ 1139|ties: 3/.test(table));

function conditionalCover(mean, std, k) {
  const atom = km.normalBin(mean, std, k);
  const tail = 1 - km.normCdfOpen((k + 0.5 - mean) / std);
  if (atom > 1e-15 && atom < 1) return tail / (1 - atom);
  return tail;
}

{
  const std = 13.2;
  const home = km.spreadQuote(3, -3, 'NFL', std);
  near(home.pPush, km.nflSpreadPush(3, 3, std), 1e-12, 'spread push helper');
  near(home.coverProb, conditionalCover(3, std, 3), 1e-9, 'key cover stays the conditional normal');
  near(home.pWin, home.coverProb * (1 - home.pPush), 1e-9, 'pWin is (1-pPush) times cover');
  near(home.pWin + home.pPush + home.pLoss, 1, 1e-9);
  assert.ok(home.pPush > km.normalBin(3, std, 3) * 2, '3 is fatter than the normal bin');
  assert.ok(home.pPush > 0.07 && home.pPush < 0.09, `3-push ${home.pPush}`);
  const seven = km.spreadQuote(7, -7, 'NFL', std);
  assert.ok(seven.pPush > km.normalBin(7, std, 7) * 1.4, '7 is fatter than the normal bin');
  near(seven.coverProb, conditionalCover(7, std, 7), 1e-9);
  const dog = km.spreadQuote(-3, 3, 'NFL', std);
  near(home.coverProb + dog.coverProb, 1, 1e-9);
  const blowout = km.spreadQuote(40, -3, 'NFL', std);
  assert.ok(blowout.pPush < home.pPush / 10, 'a blowout does not keep the at-the-number push');
  near(blowout.coverProb, conditionalCover(40, std, 3), 1e-9);
  const far = km.spreadQuote(25, -25, 'NFL', std);
  near(far.pPush, km.normalBin(25, std, 25), 1e-12, '|k|>21 stays the normal atom');
  assert.strictEqual(km.nflMarginPushMult(25), 1);
  assert.strictEqual(km.spreadQuote(3, -3.5, 'NFL', std).pPush, 0);
  assert.strictEqual(km.spreadQuote(1.5, 0, 'NCAAF', 16).pPush, 0);
  near(km.spreadQuote(4, -3, 'NCAAF', 16).pPush, km.normalBin(4, 16, 3), 1e-12, 'NCAAF keeps the normal atom');
  assert.strictEqual(km.spreadQuote(3, -3, 'NBA', 12), null);
}

{
  const std = 13.2;
  const tied = km.mlQuote(0, 'NFL', std);
  assert.strictEqual(tied.pPush, rate);
  const blow = km.mlQuote(18, 'NFL', std);
  assert.strictEqual(blow.pPush, rate, 'ML tie mass does not move with the mean');
  near(tied.coverProb, 0.5, 1e-6);
  near(tied.pWin, tied.coverProb * (1 - tied.pPush), 1e-9);
  near(tied.pWin + tied.pPush + tied.pLoss, 1, 1e-9);
  const p0 = km.normalBin(0, std, 0);
  const pPos = 1 - km.normCdfOpen((0.5 - 0) / std);
  const normalCover = pPos / (1 - p0);
  near(tied.coverProb, normalCover, 1e-9, 'ML cover stays the conditional normal');
  assert.strictEqual(km.mlQuote(0, 'NCAAF', 16).pPush, 0);
  assert.strictEqual(km.mlQuote(0, 'MLB', 4), null);
}

{
  const std = 10.5;
  const at44 = km.totalQuote(44, 44, 'Over', 'NFL', std);
  near(at44.pPush, km.nflTotalPush(44, 44, std), 1e-12);
  near(at44.coverProb, conditionalCover(44, std, 44), 1e-9, 'total cover stays the conditional normal');
  near(at44.pWin, at44.coverProb * (1 - at44.pPush), 1e-9);
  const under = km.totalQuote(44, 44, 'Under', 'NFL', std);
  near(at44.coverProb + under.coverProb, 1, 1e-9);
  near(at44.pPush, under.pPush, 1e-12);
  const at37 = km.totalQuote(37, 37, 'Over', 'NFL', std);
  assert.ok(at37.pPush > km.normalBin(37, std, 37), '37 is fatter than the normal total bin');
  const rare = km.totalQuote(3, 3, 'Over', 'NFL', std);
  near(rare.pPush, km.normalBin(3, std, 3), 1e-12, 'a far observed total stays the normal atom');
  assert.strictEqual(km.nflTotalPushMult(3), 1);
  const unseen = km.totalQuote(100, 100, 'Over', 'NFL', std);
  near(unseen.pPush, km.normalBin(100, std, 100), 1e-12, 'an unseen total stays the normal atom');
  assert.strictEqual(km.nflTotalPushMult(100), 1);
  assert.strictEqual(km.totalQuote(44, 44.5, 'Over', 'NFL', std).pPush, 0);
  assert.strictEqual(km.totalQuote(44, 44, 'Over', 'NCAAF', 13.5), null);
}

{
  const pPush = km.spreadQuote(3, -3, 'NFL', 13.2).pPush;
  const naive = evAtOdds(0.55, -110);
  near(pushAwareEv(0.55, -110, pPush), naive * (1 - pPush), 1e-12, 'key push scales EV');
  assert.strictEqual(pushAwareKelly(0.55, -110, 0.25, pPush), kellyFraction(0.55, -110, 0.25));
  assert.strictEqual(pushAwareKelly(0.55, -110, 0.25, pPush), pushAwareKelly(0.55, -110, 0.25, 0));
  const tie = km.mlQuote(0, 'NFL', 13.2).pPush;
  near(pushAwareEv(0.52, -110, tie), evAtOdds(0.52, -110) * (1 - tie), 1e-12, 'tie mass scales EV');
}

{
  const full = 4;
  const at6 = 4 * Math.sqrt(16 / 22);
  near(config.ratingErrorSd('NFL', 'margin', 0), full, 1e-12, 'n=0 is the full base');
  near(config.ratingErrorSd('NFL', 'margin'), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'margin', undefined), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'margin', NaN), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'margin', -1), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'margin', null), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'margin', ''), at6, 1e-12);
  near(config.ratingErrorSd('NFL', 'total', 0), 6, 1e-12);
  near(config.ratingErrorSd('NFL', 'total', 6), 6, 1e-12);
  near(config.ratingErrorSd('NCAAF', 'margin', 0), 8, 1e-12);
  near(config.ratingErrorSd('NCAAF', 'margin'), 8, 1e-12);
  near(config.ratingErrorSd('NHL', 'margin', 0), config.ratingErrorSd('NHL', 'margin', 6), 1e-12);
  assert.strictEqual(config.ratingGamesN(0, 0), 0);
  assert.strictEqual(config.ratingGamesN(0, 6), 3);
  assert.strictEqual(config.ratingGamesN(undefined, 5), undefined);
  assert.strictEqual(config.ratingGamesN(null, 5), undefined);
  assert.strictEqual(config.ratingGamesN('', 5), undefined);
  assert.strictEqual(config.ratingGamesN(-1, 4), undefined);
  const se0 = ratingSeOf({ sport: 'NFL', market: 'Spread', modelPureP: 0.6, ratingN: 0 });
  const se6 = ratingSeOf({ sport: 'NFL', market: 'Spread', modelPureP: 0.6, ratingN: 6 });
  const seMiss = ratingSeOf({ sport: 'NFL', market: 'Spread', modelPureP: 0.6 });
  assert.ok(se0 > se6, 'known zero games widens the NFL margin SE');
  near(seMiss, se6, 1e-12, 'missing n stays on N0');
  near(ratingSeOf({ sport: 'NFL', market: 'Spread', modelPureP: 0.6, ratingN: null, nGames: 0 }), se0, 1e-12);
}

{
  const ev = {
    home_team: 'Georgia Bulldogs',
    away_team: 'Alabama Crimson Tide',
    commence_time: '2026-10-18T20:00:00Z',
    bookmakers: [{
      key: 'draftkings',
      markets: [{
        key: 'h2h',
        outcomes: [
          { name: 'Georgia Bulldogs', price: -150 },
          { name: 'Alabama Crimson Tide', price: 130 },
        ],
      }],
    }],
  };
  const missing = cfb.project({ oddsEvents: [ev], standings: {}, efficiency: {} });
  assert.ok(missing.length > 0, 'NCAAF candidate');
  assert.ok(missing.every((row) => row.ratingN == null), 'a standings miss is not n=0');
  const zero = { wins: 0, losses: 0, pf: 0, pa: 0 };
  const known = cfb.project({
    oddsEvents: [ev],
    standings: { 'Georgia Bulldogs': zero, 'Alabama Crimson Tide': { ...zero } },
    efficiency: {},
  });
  assert.ok(known.length > 0);
  assert.ok(known.every((row) => row.ratingN === 0), 'a known 0-0 is n=0');
}

console.log('test-omega-nfl-push-1018c ok');
