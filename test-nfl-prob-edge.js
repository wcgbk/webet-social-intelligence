#!/usr/bin/env node
// NFL v1.2-nfl-prob-edge: dog-ML gate, probEdge dual floor, probEdge ranking, max-1-ML, lean fill.
// Reproduces today's (2026-09-13) live 3-dog card and proves the fix collapses it, plus controls.
const assert = require('assert');
const nfl = require('./netlify/functions/generate-picks-nfl-background');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.message); }
}

const cfg = nfl.PHASE_CONFIG.regular;

function cand(o) {
  const cs = Object.prototype.hasOwnProperty.call(o, 'consensusSpread') ? o.consensusSpread : -3;
  return {
    sport: 'NFL', market: o.market, side: o.side,
    homeTeam: o.home, awayTeam: o.away,
    odds: o.odds, coverProb: o.coverProb, ev: o.ev, noVigPrior: o.noVigPrior,
    consensusSpread: cs, consensusSpreadAbs: cs == null ? null : Math.abs(cs),
    kellyUnits: o.kellyUnits != null ? o.kellyUnits : (o.market === 'Moneyline' ? 0.5 : 1),
    predCLV: o.predCLV != null ? o.predCLV : 0,
    commenceTime: o.commenceTime || '2026-09-13T17:00:00Z',
  };
}
const dec = (a) => a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
function ml(o) { return cand({ ...o, market: 'Moneyline', ev: o.coverProb * dec(o.odds) - 1 }); }
function spr(o) { return cand({ ...o, market: 'Spread' }); }
function tot(o) { return cand({ ...o, market: 'Total' }); }

// ── Today's live card (get-picks-nfl, model v1.1.1-nfl) — all three were plus-money dogs ──
const carolina = ml({ side: 'Carolina Panthers ML', home: 'Carolina Panthers', away: 'Chicago Bears',
  odds: 150, coverProb: 0.432, noVigPrior: 0.400, consensusSpread: 3 });   // home dog +3, probEdge 3.2pp
const washington = ml({ side: 'Washington Commanders ML', home: 'Philadelphia Eagles', away: 'Washington Commanders',
  odds: 220, coverProb: 0.336, noVigPrior: 0.313, consensusSpread: -7 });   // away dog, probEdge 2.3pp
const neworleans = ml({ side: 'New Orleans Saints ML', home: 'Detroit Lions', away: 'New Orleans Saints',
  odds: 275, coverProb: 0.281, noVigPrior: 0.267, consensusSpread: -9 });   // away dog, probEdge 1.4pp

console.log('\nNFL v1.3-nfl-sharp');

check('MODEL_VERSION is v1.3-nfl-sharp', () => {
  assert.strictEqual(nfl.MODEL_VERSION, 'v1.3-nfl-sharp');
});

check('sharp config present (dual floor + cover floor + clamp + canonical sigma)', () => {
  assert.strictEqual(cfg.evFloor, 0.03);
  assert.strictEqual(cfg.probEdgeFloor, 0.04);
  assert.strictEqual(cfg.leanEvFloor, 0.015);
  assert.strictEqual(cfg.leanProbEdgeFloor, 0.02);
  assert.strictEqual(cfg.sigmaML, 13.45);
  assert.strictEqual(cfg.coverFloor, 0.52);
  assert.strictEqual(cfg.marginClamp, 4.0);
  assert.strictEqual(cfg.totalClamp, 6.0);
});

check('today\'s live EVs are payout-inflated vs their tiny probEdge (the bug)', () => {
  // Each dog cleared the old 3% EV floor purely on the longshot multiplier.
  assert.ok(carolina.ev > 0.07 && nfl.candProbEdge(carolina) < 0.04);
  assert.ok(washington.ev > 0.07 && nfl.candProbEdge(washington) < 0.04);
  assert.ok(neworleans.ev > 0.05 && nfl.candProbEdge(neworleans) < 0.04);
});

check('Washington +220 rejected (price > +175)', () => {
  const r = nfl.dogMlRejectReason(washington);
  assert.ok(r && /price|coverProb/.test(r), r);
});

check('New Orleans +275 rejected (price > +175 / cover < 38%)', () => {
  const r = nfl.dogMlRejectReason(neworleans);
  assert.ok(r && /price|coverProb/.test(r), r);
});

check('Carolina +150 passes the dog gate but is NOT conviction (probEdge 3.2pp < 4pp)', () => {
  assert.strictEqual(nfl.dogMlRejectReason(carolina), null);          // in-gate: +3 dog, 43% cover, +150
  assert.ok(nfl.candProbEdge(carolina) < cfg.probEdgeFloor);          // fails conviction floor
});

check('the whole live 3-dog card collapses to at most one small lean', () => {
  const { picks } = nfl.selectPicks([carolina, washington, neworleans], cfg);
  assert.ok(picks.length <= 1, 'expected <=1 pick, got ' + picks.length);
  assert.ok(!picks.some(p => /Washington|New Orleans/.test(p.side)), 'long dogs must be gone');
  if (picks.length === 1) {
    assert.strictEqual(picks[0].isLean, true, 'the survivor is a 0.25u lean, not a core play');
    const built = nfl.buildFinalPicks(picks, false, 'regular');
    assert.strictEqual(built[0].units, '0.25u');
    assert.strictEqual(built[0].rating, 'Lean');
  }
});

check('rank by probEdge, not raw EV% — skinny-edge high-EV dog loses to an honest spread', () => {
  const skinnyDog = ml({ side: 'Carolina Panthers ML', home: 'Carolina Panthers', away: 'Chicago Bears',
    odds: 150, coverProb: 0.44, noVigPrior: 0.42, consensusSpread: 3 }); // EV 10%, probEdge 2pp
  const honest = spr({ side: 'Chicago Bears -3', home: 'Carolina Panthers', away: 'Chicago Bears',
    coverProb: 0.56, odds: -110, ev: 0.035, noVigPrior: 0.515, consensusSpread: 3 }); // probEdge 4.5pp
  assert.ok(skinnyDog.ev > honest.ev, 'precondition: skinny dog EV is larger');
  const { picks } = nfl.selectPicks([skinnyDog, honest], cfg);
  assert.strictEqual(picks.length, 1, 'one game, one pick');
  assert.strictEqual(picks[0].market, 'Spread', 'spread with the real probEdge wins the game');
});

check('a genuine value dog ML (short price, model has it FAVORED >=52%) still ships as conviction', () => {
  // +130 "dog" the model thinks actually wins 54% — clears the 52% cover floor and the dog gate.
  const legit = ml({ side: 'Carolina Panthers ML', home: 'Carolina Panthers', away: 'Chicago Bears',
    odds: 130, coverProb: 0.54, noVigPrior: 0.435, consensusSpread: 2.5 }); // probEdge 10.5pp, cover 54%
  assert.strictEqual(nfl.dogMlRejectReason(legit), null);
  const { picks } = nfl.selectPicks([legit], cfg);
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].isLean, false, 'conviction, not lean');
});

check('cover floor 52%: a sub-52% pick is rejected even with a positive probEdge', () => {
  const coin = spr({ side: 'Chicago Bears -1', home: 'Carolina Panthers', away: 'Chicago Bears',
    coverProb: 0.505, odds: -110, ev: 0.05, noVigPrior: 0.46, consensusSpread: 1 }); // probEdge 4.5pp but 50.5% cover
  const { picks } = nfl.selectPicks([coin], cfg);
  assert.strictEqual(picks.length, 0, '50.5% cover is below the 52% floor — not favored to win the bet');
});

check('predCLV < 0 is dropped (must beat the sharp close)', () => {
  const beatsClose = spr({ side: 'Chicago Bears -3', home: 'Carolina Panthers', away: 'Chicago Bears',
    coverProb: 0.56, odds: -110, ev: 0.06, noVigPrior: 0.515, consensusSpread: 3 });
  beatsClose.predCLV = 0.02;   // +2pp CLV
  const losesClose = { ...beatsClose, side: 'Carolina Panthers +3', predCLV: -0.015 }; // fails the close
  assert.ok(nfl.selectPicks([beatsClose], cfg).picks.length === 1);
  assert.strictEqual(nfl.selectPicks([losesClose], cfg).picks.length, 0);
});

check('CLV promotion: a sub-4pp probEdge pick that beats the close by >=1.5pp ships as CONVICTION', () => {
  // probEdge 3pp (below the 4pp floor) but predCLV +2pp and cover 54% → promoted to conviction.
  const clvEdge = spr({ side: 'Chicago Bears -3', home: 'Carolina Panthers', away: 'Chicago Bears',
    coverProb: 0.54, odds: -110, ev: 0.031, noVigPrior: 0.51, consensusSpread: 3 });
  clvEdge.predCLV = 0.02;
  assert.ok(nfl.candProbEdge(clvEdge) < cfg.probEdgeFloor, 'precondition: below 4pp');
  assert.ok(nfl.clvPromotes(clvEdge, cfg.leanProbEdgeFloor));
  const { picks } = nfl.selectPicks([clvEdge], cfg);
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].isLean, false, 'CLV-promoted → conviction, not lean');
});

check('site-specific HFA: loud/altitude venues > base > LA venues', () => {
  assert.ok(nfl.siteHfa('Seattle Seahawks', 1.8) > 1.8);
  assert.ok(nfl.siteHfa('Kansas City Chiefs', 1.8) > 1.8);
  assert.ok(nfl.siteHfa('Los Angeles Chargers', 1.8) < 1.8);
  assert.ok(nfl.siteHfa('Unknown Team', 1.8) === 1.8);
});

check('favorite ML is never dog-gated', () => {
  const fav = ml({ side: 'Detroit Lions ML', home: 'Detroit Lions', away: 'New Orleans Saints',
    odds: -260, coverProb: 0.73, noVigPrior: 0.69, consensusSpread: -9 });
  assert.strictEqual(nfl.dogMlRejectReason(fav), null);
});

check('spread/total preferred over ML on the same game; max 1 ML on the card', () => {
  const g1ml = ml({ side: 'Carolina Panthers ML', home: 'Carolina Panthers', away: 'Chicago Bears',
    odds: 130, coverProb: 0.48, noVigPrior: 0.435, consensusSpread: 2.5 });
  const g1sp = spr({ side: 'Carolina Panthers +2.5', home: 'Carolina Panthers', away: 'Chicago Bears',
    coverProb: 0.55, odds: -110, ev: 0.05, noVigPrior: 0.505, consensusSpread: 3 });
  const g2ml = ml({ side: 'Green Bay Packers ML', home: 'Green Bay Packers', away: 'Minnesota Vikings',
    odds: 120, coverProb: 0.50, noVigPrior: 0.455, consensusSpread: 1.5 });
  const { picks } = nfl.selectPicks([g1ml, g1sp, g2ml], cfg);
  assert.ok(picks.find(p => p.homeTeam === 'Carolina Panthers').market === 'Spread', 'spread beats ML same game');
  assert.ok(picks.filter(nfl.isMoneyline).length <= 1, 'at most one ML on the card');
});

check('home dog ML is soft-penalized vs an identical away dog ML in ranking', () => {
  const homeDog = ml({ side: 'Carolina Panthers ML', home: 'Carolina Panthers', away: 'Chicago Bears',
    odds: 140, coverProb: 0.44, noVigPrior: 0.40, consensusSpread: 3 });
  const awayDog = ml({ side: 'Minnesota Vikings ML', home: 'Green Bay Packers', away: 'Minnesota Vikings',
    odds: 140, coverProb: 0.44, noVigPrior: 0.40, consensusSpread: -3 });
  assert.ok(nfl.rankScore(awayDog) > nfl.rankScore(homeDog));
});

if (failed) { console.error('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
