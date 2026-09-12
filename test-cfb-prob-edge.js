#!/usr/bin/env node
// CFB v1.1.2-cfb-prob-edge: dog-ML gate, dual floor, probEdge ranking, lean fill, 2-vs-3 parlay.
const assert = require('assert');
const cfb = require('./netlify/functions/generate-picks-cfb-background');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const cfg = cfb.PHASE_CONFIG.regular;

function cand(opts) {
  const consensusSpread = Object.prototype.hasOwnProperty.call(opts, 'consensusSpread')
    ? opts.consensusSpread
    : -6.5;
  return {
    sport: 'NCAAF',
    market: opts.market,
    side: opts.side,
    homeTeam: opts.home,
    awayTeam: opts.away,
    odds: opts.odds,
    coverProb: opts.coverProb,
    ev: opts.ev,
    noVigPrior: opts.noVigPrior,
    consensusSpread,
    consensusSpreadAbs: consensusSpread == null ? null : Math.abs(consensusSpread),
    kellyUnits: opts.kellyUnits != null ? opts.kellyUnits : (opts.market === 'Moneyline' ? 0.5 : 1),
    predCLV: opts.predCLV != null ? opts.predCLV : 0,
    commenceTime: opts.commenceTime || '2026-09-12T19:00:00Z',
  };
}

function tot(side, home, away, cover, odds, ev, extra) {
  return cand({
    market: 'Total', side, home, away, odds, coverProb: cover, ev,
    noVigPrior: extra && extra.noVigPrior,
    consensusSpread: extra && Object.prototype.hasOwnProperty.call(extra, 'consensusSpread') ? extra.consensusSpread : -3,
    ...extra,
  });
}
function spr(side, home, away, cover, odds, ev, extra) {
  return cand({
    market: 'Spread', side, home, away, odds, coverProb: cover, ev,
    noVigPrior: extra && extra.noVigPrior,
    consensusSpread: extra && extra.consensusSpread,
    ...extra,
  });
}

// Trap dogs from the raw-EV% card: huge EV, skinny probability edge, long plus-money.
const memphis = cand({
  market: 'Moneyline',
  side: 'Memphis Tigers ML',
  home: 'Georgia Bulldogs',
  away: 'Memphis Tigers',
  odds: 275,
  coverProb: 0.31,
  ev: 0.31 * (1 + 275 / 100) - 1, // ~16.3% EV — would rank #1 on raw EV%
  noVigPrior: 0.267,
  consensusSpread: -17,
});
const monroe = cand({
  market: 'Moneyline',
  side: 'UL Monroe Warhawks ML',
  home: 'Texas Longhorns',
  away: 'UL Monroe Warhawks',
  odds: 300,
  coverProb: 0.28,
  ev: 0.28 * 4 - 1, // 12% EV
  noVigPrior: 0.25,
  consensusSpread: -21,
});

const gameA = { home: 'Alabama Crimson Tide', away: 'Auburn Tigers' };
const gameB = { home: 'Ohio State Buckeyes', away: 'Penn State Nittany Lions' };
const gameC = { home: 'Oregon Ducks', away: 'Washington Huskies' };
const gameD = { home: 'Michigan Wolverines', away: 'Michigan State Spartans' };

console.log('\nCFB v1.1.2-cfb-prob-edge');

check('MODEL_VERSION is v1.1.2-cfb-prob-edge', () => {
  assert.strictEqual(cfb.MODEL_VERSION, 'v1.1.2-cfb-prob-edge');
});

check('conviction dual floor constants', () => {
  assert.strictEqual(cfg.evFloor, 0.03);
  assert.strictEqual(cfg.probEdgeFloor, 0.04);
  assert.strictEqual(cfg.leanEvFloor, 0.015);
  assert.strictEqual(cfg.leanProbEdgeFloor, 0.02);
  assert.strictEqual(cfg.mlMaxUnits, 0.5);
});

check('Memphis +275 rejected by dog-ML gate (price > +200 and |spread| >= 14 hard-never)', () => {
  const reason = cfb.dogMlRejectReason(memphis);
  assert.ok(reason, 'expected a reject reason');
  assert.ok(/hard-never|price|\|spread\|/.test(reason), reason);
  const { picks } = cfb.selectPicks([memphis], cfg);
  assert.strictEqual(picks.length, 0, 'Memphis +275 must not ship as YES or lean');
});

check('Monroe +300 rejected by dog-ML gate', () => {
  const reason = cfb.dogMlRejectReason(monroe);
  assert.ok(reason, 'expected a reject reason');
  const { picks } = cfb.selectPicks([monroe], cfg);
  assert.strictEqual(picks.length, 0, 'Monroe +300 must not ship as YES or lean');
});

check('Memphis +275 still rejected when spread is close (price cap +200)', () => {
  const close = { ...memphis, consensusSpread: -7, consensusSpreadAbs: 7, coverProb: 0.38, noVigPrior: 0.32 };
  delete close.probEdge;
  const reason = cfb.dogMlRejectReason(close);
  assert.ok(reason, 'expected reject');
  assert.ok(/price/.test(reason) && /\+275/.test(reason), reason);
});

check('Monroe +300 still rejected when spread is close (price cap +200)', () => {
  const close = { ...monroe, consensusSpread: -6, consensusSpreadAbs: 6, coverProb: 0.38, noVigPrior: 0.30 };
  delete close.probEdge;
  const reason = cfb.dogMlRejectReason(close);
  assert.ok(reason, 'expected reject');
  assert.ok(/price/.test(reason) && /\+300/.test(reason), reason);
});

check('unknown consensus spread skips dog ML', () => {
  const unknown = cand({
    market: 'Moneyline', side: 'Memphis Tigers ML',
    home: 'Georgia Bulldogs', away: 'Memphis Tigers',
    odds: 165, coverProb: 0.42, ev: 0.08, noVigPrior: 0.37,
    consensusSpread: null,
  });
  const reason = cfb.dogMlRejectReason(unknown);
  assert.ok(/unknown/.test(reason), reason);
});

check('hard-never |spread| >= 14 even inside +200', () => {
  const wide = cand({
    market: 'Moneyline', side: 'Memphis Tigers ML',
    home: 'Georgia Bulldogs', away: 'Memphis Tigers',
    odds: 180, coverProb: 0.40, ev: 0.12, noVigPrior: 0.34,
    consensusSpread: -14,
  });
  const reason = cfb.dogMlRejectReason(wide);
  assert.ok(/hard-never/.test(reason) && /14/.test(reason), reason);
});

check('hard-never price > +425', () => {
  const lotto = cand({
    market: 'Moneyline', side: 'Memphis Tigers ML',
    home: 'Georgia Bulldogs', away: 'Memphis Tigers',
    odds: 450, coverProb: 0.22, ev: 0.21, noVigPrior: 0.18,
    consensusSpread: -7,
  });
  const reason = cfb.dogMlRejectReason(lotto);
  assert.ok(/hard-never/.test(reason) && /425/.test(reason), reason);
});

check('qualifying dog ML (spread <= 10, cover >= 0.35, price <= +200) is allowed', () => {
  const ok = cand({
    market: 'Moneyline', side: 'Auburn Tigers ML',
    home: 'Alabama Crimson Tide', away: 'Auburn Tigers',
    odds: 155, coverProb: 0.42, ev: 0.42 * 2.55 - 1, noVigPrior: 0.37,
    consensusSpread: -6.5,
  });
  assert.strictEqual(cfb.dogMlRejectReason(ok), null);
  const { picks } = cfb.selectPicks([ok], cfg);
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].side, 'Auburn Tigers ML');
  assert.strictEqual(picks[0].kellyUnits, 0.5);
});

check('dog ML coverProb < 0.35 rejected', () => {
  const thin = cand({
    market: 'Moneyline', side: 'Auburn Tigers ML',
    home: 'Alabama Crimson Tide', away: 'Auburn Tigers',
    odds: 155, coverProb: 0.34, ev: 0.10, noVigPrior: 0.30,
    consensusSpread: -6.5,
  });
  const reason = cfb.dogMlRejectReason(thin);
  assert.ok(/coverProb/.test(reason), reason);
});

check('failing dog MLs are not used as leans', () => {
  const leanTotal = tot('Over 52.5', gameA.home, gameA.away, 0.53, -110, 0.018, { noVigPrior: 0.51 });
  const { picks } = cfb.selectPicks([memphis, monroe, leanTotal], cfg);
  assert.ok(!picks.some(p => /Memphis|Monroe/.test(p.side)));
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].side, 'Over 52.5');
  assert.strictEqual(picks[0].isLean, true);
});

check('empty card if nothing qualifies (only trap dog MLs)', () => {
  const { picks } = cfb.selectPicks([memphis, monroe], cfg);
  assert.strictEqual(picks.length, 0);
});

check('rank by probEdge, not raw EV% — high-EV skinny edge loses to dual floor', () => {
  const skinnyEv = tot('Over 55.5', gameA.home, gameA.away, 0.52, 150, 0.30, { noVigPrior: 0.50 }); // EV 30%, probEdge 2pp
  const honest = spr('Penn State Nittany Lions +3.5', gameB.home, gameB.away, 0.56, -110, 0.035, { noVigPrior: 0.51, consensusSpread: 3.5 });
  assert.ok(skinnyEv.ev > honest.ev, 'precondition: skinny EV is larger');
  assert.ok(cfb.candProbEdge(skinnyEv) < 0.04, 'precondition: skinny fails 4pp');
  assert.ok(cfb.candProbEdge(honest) >= 0.04);
  const { picks } = cfb.selectPicks([skinnyEv, honest, memphis], cfg);
  assert.ok(picks.some(p => p.side === 'Penn State Nittany Lions +3.5'));
  assert.ok(!picks.some(p => p.side === 'Over 55.5' && !p.isLean), 'skinny EV must not be conviction YES');
  assert.ok(!picks.some(p => /Memphis/.test(p.side)));
});

check('prefer Spread/Total over ML on the same game', () => {
  const ml = cand({
    market: 'Moneyline', side: 'Auburn Tigers ML',
    home: gameA.home, away: gameA.away,
    odds: 155, coverProb: 0.45, ev: 0.15, noVigPrior: 0.37,
    consensusSpread: -6.5,
  });
  const spread = spr('Auburn Tigers +6.5', gameA.home, gameA.away, 0.55, -110, 0.04, { noVigPrior: 0.51, consensusSpread: 6.5 });
  const { picks } = cfb.selectPicks([ml, spread], cfg);
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].market, 'Spread');
  assert.strictEqual(picks[0].side, 'Auburn Tigers +6.5');
});

check('max 1 Moneyline on the 3-pick card', () => {
  const ml1 = cand({
    market: 'Moneyline', side: 'Auburn Tigers ML',
    home: gameA.home, away: gameA.away,
    odds: 155, coverProb: 0.42, ev: 0.07, noVigPrior: 0.37, consensusSpread: -6.5,
  });
  const ml2 = cand({
    market: 'Moneyline', side: 'Penn State Nittany Lions ML',
    home: gameB.home, away: gameB.away,
    odds: 140, coverProb: 0.44, ev: 0.06, noVigPrior: 0.39, consensusSpread: -4,
  });
  const ml3 = cand({
    market: 'Moneyline', side: 'Washington Huskies ML',
    home: gameC.home, away: gameC.away,
    odds: 130, coverProb: 0.43, ev: 0.05, noVigPrior: 0.38, consensusSpread: -3,
  });
  const { picks } = cfb.selectPicks([ml1, ml2, ml3], cfg);
  assert.strictEqual(picks.filter(p => p.market === 'Moneyline').length, 1);
  assert.ok(picks.length <= 1, 'no other markets to fill with — do not force extra MLs');
});

check('home dog ML is soft-penalized in ranking', () => {
  const homeDog = cand({
    market: 'Moneyline', side: 'Alabama Crimson Tide ML',
    home: gameA.home, away: gameA.away,
    odds: 150, coverProb: 0.42, ev: 0.05, noVigPrior: 0.37, consensusSpread: 3.5,
  });
  const awayDog = cand({
    market: 'Moneyline', side: 'Penn State Nittany Lions ML',
    home: gameB.home, away: gameB.away,
    odds: 150, coverProb: 0.42, ev: 0.05, noVigPrior: 0.37, consensusSpread: -3.5,
  });
  assert.ok(cfb.rankScore(awayDog) > cfb.rankScore(homeDog));
  assert.ok(cfb.rankScore(homeDog) < cfb.candProbEdge(homeDog));
  assert.ok(Math.abs((cfb.candProbEdge(homeDog) - cfb.rankScore(homeDog)) - cfb.HOME_DOG_ML_RANK_PENALTY) < 1e-9);
});

check('lean fill-to-3: 1 conviction + 2 leans (0.25u, rating Lean, thinSlate)', () => {
  const yes = spr('Auburn Tigers +3.5', gameA.home, gameA.away, 0.56, -110, 0.05, { noVigPrior: 0.51, consensusSpread: 3.5, kellyUnits: 1 });
  const lean1 = tot('Over 48.5', gameB.home, gameB.away, 0.53, -110, 0.018, { noVigPrior: 0.51 });
  const lean2 = tot('Under 51.5', gameC.home, gameC.away, 0.535, -110, 0.020, { noVigPrior: 0.51 });
  const { picks } = cfb.selectPicks([yes, lean1, lean2, memphis], cfg);
  assert.strictEqual(picks.length, 3);
  assert.strictEqual(picks.filter(p => !p.isLean).length, 1);
  assert.strictEqual(picks.filter(p => p.isLean).length, 2);
  const built = cfb.buildFinalPicks(picks, false, 'regular');
  const leans = built.filter(p => p.rating === 'Lean');
  assert.strictEqual(leans.length, 2);
  assert.ok(leans.every(p => p.units === '0.25u' && p.thinSlate === true && p.confidence === 'lean'));
  assert.ok(!built.some(p => /Memphis/.test(p.pick)));
});

check('do not fill a 3rd slot with a failing dog ML', () => {
  const yes = spr('Auburn Tigers +3.5', gameA.home, gameA.away, 0.56, -110, 0.05, { noVigPrior: 0.51, consensusSpread: 3.5 });
  const lean1 = tot('Over 48.5', gameB.home, gameB.away, 0.53, -110, 0.018, { noVigPrior: 0.51 });
  const { picks } = cfb.selectPicks([yes, lean1, memphis, monroe], cfg);
  assert.strictEqual(picks.length, 2);
  assert.ok(!picks.some(p => /Memphis|Monroe/.test(p.side)));
});

check('parlay 3-leg wins when true EV is clearly better', () => {
  const a = tot('Under 48.5', gameA.home, gameA.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const b = tot('Under 51.5', gameB.home, gameB.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const c = tot('Over 54.5', gameC.home, gameC.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const { picks } = cfb.selectPicks([a, b, c], cfg);
  const built = cfb.buildFinalPicks(picks, false, 'regular');
  const parlays = cfb.buildPublishedParlay(built, [a, b, c]);
  assert.ok(parlays[0], 'expected a parlay');
  assert.strictEqual(parlays[0].legs.length, 3);
  assert.strictEqual(parlays[0].type, '3-leg-parlay-optimized');
  assert.strictEqual(parlays[0].units, '0.5u');
});

check('parlay 2-leg wins when its true EV is higher', () => {
  const a = tot('Under 48.5', gameA.home, gameA.away, 0.62, -150, 0.04, { noVigPrior: 0.55 });
  const b = tot('Under 51.5', gameB.home, gameB.away, 0.60, -140, 0.04, { noVigPrior: 0.54 });
  const c = tot('Over 54.5', gameC.home, gameC.away, 0.41, -200, 0.01, { noVigPrior: 0.40 });
  const legs2 = [
    { side: a.side, market: 'Total', oddsNum: -150, coverProbNum: 0.62, matchup: 'Auburn Tigers vs. Alabama Crimson Tide', sport: 'NCAAF' },
    { side: b.side, market: 'Total', oddsNum: -140, coverProbNum: 0.60, matchup: 'Penn State Nittany Lions vs. Ohio State Buckeyes', sport: 'NCAAF' },
  ];
  const legs3 = legs2.concat([{
    side: c.side, market: 'Total', oddsNum: -200, coverProbNum: 0.41,
    matchup: 'Washington Huskies vs. Oregon Ducks', sport: 'NCAAF',
  }]);
  const s2 = cfb.parlayComboStats(legs2);
  const s3 = cfb.parlayComboStats(legs3);
  assert.ok(s2.ev > s3.ev, `precondition 2-leg EV ${s2.ev} vs 3-leg ${s3.ev}`);
  const chosen = cfb.chooseParlay2or3(legs2, legs3);
  assert.strictEqual(chosen.length, 2);
});

check('parlay drops Memphis +275 / Monroe +300 legs (odds >= +200)', () => {
  const a = tot('Under 48.5', gameA.home, gameA.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const b = tot('Under 51.5', gameB.home, gameB.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const { picks } = cfb.selectPicks([a, b, memphis, monroe], cfg);
  const built = cfb.buildFinalPicks(picks, false, 'regular');
  const parlays = cfb.buildPublishedParlay(built, [a, b, memphis, monroe]);
  assert.ok(parlays[0]);
  const legs = parlays[0].legs.map(l => l.pick).join(' ');
  assert.ok(!/Memphis|Monroe/.test(legs), legs);
  assert.ok(parlays[0].legs.every(l => {
    const n = parseInt(String(l.odds).replace(/[^0-9+-]/g, ''), 10);
    return n < 200;
  }));
});

check('parlay max 1 dog ML leg', () => {
  const totA = tot('Under 48.5', gameA.home, gameA.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const totB = tot('Under 51.5', gameB.home, gameB.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const dog1 = cand({
    market: 'Moneyline', side: 'Michigan State Spartans ML',
    home: gameD.home, away: gameD.away,
    odds: 155, coverProb: 0.42, ev: 0.07, noVigPrior: 0.37, consensusSpread: -6.5,
  });
  const dog2 = cand({
    market: 'Moneyline', side: 'Washington Huskies ML',
    home: gameC.home, away: gameC.away,
    odds: 160, coverProb: 0.41, ev: 0.066, noVigPrior: 0.36, consensusSpread: -5.5,
  });
  const parlays = cfb.buildPublishedParlay(
    cfb.buildFinalPicks(cfb.selectPicks([totA, totB, dog1, dog2], cfg).picks, false, 'regular'),
    [totA, totB, dog1, dog2]
  );
  assert.ok(parlays[0]);
  const dogLegs = parlays[0].legs.filter(l => l.betType === 'Moneyline' && parseInt(String(l.odds).replace(/[^0-9+-]/g, ''), 10) > 0);
  assert.ok(dogLegs.length <= 1, 'max 1 dog ML parlay leg, got ' + dogLegs.length);
});

check('parlay stake 0.25u when a lean is on the card', () => {
  const yes = spr('Auburn Tigers +3.5', gameA.home, gameA.away, 0.56, -110, 0.05, { noVigPrior: 0.51, consensusSpread: 3.5, kellyUnits: 1 });
  const lean1 = tot('Over 48.5', gameB.home, gameB.away, 0.53, -110, 0.018, { noVigPrior: 0.51 });
  const lean2 = tot('Under 51.5', gameC.home, gameC.away, 0.535, -110, 0.020, { noVigPrior: 0.51 });
  const { picks } = cfb.selectPicks([yes, lean1, lean2], cfg);
  const built = cfb.buildFinalPicks(picks, false, 'regular');
  const parlays = cfb.buildPublishedParlay(built, [yes, lean1, lean2]);
  assert.ok(parlays[0]);
  assert.strictEqual(parlays[0].units, '0.25u');
  assert.strictEqual(parlays[0].stake, 0.25);
});

check('parlay one leg per game', () => {
  const spread = spr('Auburn Tigers +3.5', gameA.home, gameA.away, 0.56, -110, 0.05, { noVigPrior: 0.51, consensusSpread: 3.5 });
  const total = tot('Over 52.5', gameA.home, gameA.away, 0.57, -110, 0.06, { noVigPrior: 0.51 });
  const other = tot('Under 51.5', gameB.home, gameB.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const third = tot('Over 48.5', gameC.home, gameC.away, 0.56, -110, 0.04, { noVigPrior: 0.52 });
  const parlays = cfb.buildPublishedParlay(
    cfb.buildFinalPicks(cfb.selectPicks([spread, total, other, third], cfg).picks, false, 'regular'),
    [spread, total, other, third]
  );
  assert.ok(parlays[0]);
  const games = new Set(parlays[0].legs.map(l => l.matchup));
  assert.strictEqual(games.size, parlays[0].legs.length);
});

check('favorite ML is not gated; still max 1 ML on the card', () => {
  const fav = cand({
    market: 'Moneyline', side: 'Alabama Crimson Tide ML',
    home: gameA.home, away: gameA.away,
    odds: -180, coverProb: 0.68, ev: 0.057, noVigPrior: 0.63, consensusSpread: -6.5, kellyUnits: 0.5,
  });
  assert.strictEqual(cfb.dogMlRejectReason(fav), null);
  const spreadB = spr('Penn State Nittany Lions +3.5', gameB.home, gameB.away, 0.55, -110, 0.04, { noVigPrior: 0.51, consensusSpread: 3.5 });
  const { picks } = cfb.selectPicks([fav, spreadB], cfg);
  assert.ok(picks.some(p => p.market === 'Spread'));
  assert.strictEqual(picks.filter(p => p.market === 'Moneyline').length <= 1, true);
});

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');

// ── v1.1.2 team match + delayed-game gate notes ──
const { cfbTeamsMatch: _cfm } = require("./netlify/functions/generate-picks-cfb-background.js");
function assertMatch(a,b,yes) {
  const m = _cfm(a,b) || _cfm(b,a);
  if (!!m !== !!yes) throw new Error(`cfbTeamsMatch(${a},${b}) expected ${yes} got ${m}`);
}
assertMatch("Georgia", "Georgia Tech", false);
assertMatch("Oregon", "Oregon State", false);
assertMatch("Oklahoma", "Oklahoma State", false);
assertMatch("Miami", "Miami OH", false);
assertMatch("UCF Knights", "Central Florida Knights", true);
assertMatch("Pittsburgh Panthers", "Pitt", true);
console.log("cfbTeamsMatch false positives / aliases: PASS");

