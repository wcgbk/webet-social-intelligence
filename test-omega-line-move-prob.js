'use strict';
/**
 * Pinnacle-led blend-weight shift. Fixtures only. No network.
 * Grade, edge, and stake EV share one adjusted probability.
 * Missing 3:00 or 10:00 logs and adjusts 0. Morning snaps are not used.
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, 'netlify/functions/lib/omega-vnext');
const config = require(path.join(root, 'config'));
const {
  adjustCandidate, applyLineMoveProb, bookDelta, weightFor,
} = require(path.join(root, 'line_move_prob'));
const { shapeOfficialLinePath } = require(path.join(root, 'line_path'));
const { toPickObject } = require(path.join(root, 'select'));
const { qualityToRating } = require(path.join(root, 'odds_math'));
const { gateReason } = require(path.join(root, 'gates'));

function close(actual, expected, eps = 1e-4) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

const HOME = 'Philadelphia Eagles';
const AWAY = 'Dallas Cowboys';
const KEY = 'dallas cowboys @ philadelphia eagles';
const PIN_FLAT = { mlHome: -110, mlAway: -110 };
const PIN_LONG = { mlHome: 182, mlAway: 218 };

function game(books) {
  return { awayTeam: AWAY, homeTeam: HOME, books };
}

function poll(slot, books) {
  return { hhmm: slot, slot, games: { [KEY]: game(books) } };
}

function meta(polls) {
  return {
    source: 'test',
    path: { polls },
    earliest: polls.find((p) => p.hhmm === '0300' || p.hhmm === 'open') || null,
    latest: polls.find((p) => p.hhmm === '1000') || null,
  };
}

function ml(over) {
  return Object.assign({
    sport: 'NFL',
    market: 'Moneyline',
    side: HOME,
    homeTeam: HOME,
    awayTeam: AWAY,
    matchup: `${AWAY} @ ${HOME}`,
    odds: -110,
    coverProb: 0.55,
    p_model: 0.62,
    fair_sharp_p: 0.52,
    calibK: 0.73,
  }, over || {});
}

function pair(books3, books10, booksOpen) {
  const polls = [poll('0300', books3), poll('1000', books10)];
  if (booksOpen) polls.push(poll('open', booksOpen));
  return meta(polls);
}

const warns = [];
const origWarn = console.warn;
const origLog = console.log;
console.warn = (msg) => { warns.push(String(msg)); };
console.log = () => {};

try {
  assert.strictEqual(config.LINE_MOVE_PROB.maxAbsProbAdj, 0.015);
  assert.strictEqual(config.LINE_MOVE_PROB.adverseDropProb, 0.020);
  assert.strictEqual(config.LINE_MOVE_PROB.noise, 0.005);
  assert.strictEqual(config.LINE_MOVE_PROB.scale, 0.030);
  assert.strictEqual(config.LINE_MOVE_PROB.maxK, 0.90);
  assert.strictEqual(weightFor(config.LINE_MOVE_PROB, 'NFL', 'Moneyline'), 0.35);
  assert.strictEqual(weightFor(config.LINE_MOVE_PROB, 'NFL', 'Spread'), 0.45);
  assert.strictEqual(weightFor(config.LINE_MOVE_PROB, 'NHL', 'Total'), 0.20);
  assert.strictEqual(weightFor(config.LINE_MOVE_PROB, 'NBA', 'Spread'), 0.20);
  assert.strictEqual(weightFor(config.LINE_MOVE_PROB, 'MLB', 'Moneyline'), 0.15);

  const moved = adjustCandidate(ml(), pair({ pinnacle: PIN_FLAT }, { pinnacle: PIN_LONG }));
  const info = Math.min(1, Math.max(0, (Math.abs(moved.movementDeltaP) - 0.005) / 0.025));
  assert.ok(info > 0.95, `info ${info} delta ${moved.movementDeltaP}`);
  const K = 0.73;
  const extra = 0.35 * info;
  const Keff = Math.min(0.90, K + (1 - K) * extra);
  const raw = (Keff - K) * (0.52 - 0.62);
  const adj = Math.max(-0.015, Math.min(0.015, raw));
  close(moved.movementK, K, 1e-6);
  close(moved.movementKEff, Keff, 1e-4);
  close(moved.movementAdj, adj, 1e-4);
  close(moved.coverProb, 0.55 + adj, 1e-4);
  close(moved.edgePct, moved.coverProb - 0.52, 1e-4);
  close(moved.ev, moved.coverProb * (1 + 100 / 110) - 1, 5e-4);
  assert.strictEqual(moved.fair_sharp_p, 0.52);
  assert.strictEqual(moved.p_model, 0.62);
  assert.strictEqual(moved.movementDrop, false);
  assert.strictEqual(moved.movementDkLag, false);
  assert.ok(Math.abs(moved.movementAdj) < 0.015);
  assert.ok(Math.abs(moved.movementAdj) > 0.005);

  const capCfg = JSON.parse(JSON.stringify(config.LINE_MOVE_PROB));
  capCfg.weights.NFL.Moneyline = 1;
  const capped = adjustCandidate(ml({
    calibK: 0.58,
    p_model: 0.70,
    fair_sharp_p: 0.50,
    coverProb: 0.60,
  }), pair({ pinnacle: PIN_FLAT }, { pinnacle: PIN_LONG }), capCfg);
  close(capped.movementKEff, 0.90, 1e-4);
  close(capped.movementAdj, -0.015, 1e-6);
  close(capped.coverProb, 0.585, 1e-4);
  close(capped.edgePct, 0.585 - 0.50, 1e-4);

  const highK = adjustCandidate(ml({ calibK: 0.95 }), pair(
    { pinnacle: PIN_FLAT },
    { pinnacle: PIN_LONG },
  ));
  close(highK.movementKEff, 0.95, 1e-6);
  close(highK.movementAdj, 0, 1e-9);
  close(highK.coverProb, 0.55, 1e-9);

  const dropped = adjustCandidate(ml({
    p_model: 0.55,
    fair_sharp_p: 0.55,
    coverProb: 0.55,
  }), pair({ pinnacle: PIN_LONG }, { pinnacle: PIN_FLAT }));
  close(dropped.movementAdj, 0, 1e-9);
  close(dropped.coverProb, 0.55, 1e-9);
  assert.ok(dropped.movementDeltaP <= -0.020);
  assert.strictEqual(dropped.movementDrop, true);
  assert.ok(/sharp_prob_against/.test(dropped.movementDropReason));

  const disagree = ml({ coverProb: 0.55, p_model: 0.40, fair_sharp_p: 0.55, calibK: 0.50 });
  const pinOnly = adjustCandidate(disagree, pair({ pinnacle: PIN_FLAT }, { pinnacle: PIN_LONG }));
  const circaIgnored = adjustCandidate(disagree, pair(
    { pinnacle: PIN_FLAT, circa: PIN_FLAT },
    { pinnacle: PIN_LONG, circa: PIN_FLAT },
  ));
  assert.strictEqual(circaIgnored.movementCirca, false);
  assert.strictEqual(circaIgnored.movementExtraSharp, false);
  close(circaIgnored.movementAdj, pinOnly.movementAdj, 1e-6);

  const blendCfg = JSON.parse(JSON.stringify(config.LINE_MOVE_PROB));
  blendCfg.extraSharpBooks = ['bookmaker'];
  const withBook = adjustCandidate(disagree, pair(
    { pinnacle: PIN_FLAT, bookmaker: PIN_FLAT },
    { pinnacle: PIN_LONG, bookmaker: PIN_FLAT },
  ), blendCfg);
  assert.strictEqual(withBook.movementExtraSharp, true);
  assert.strictEqual(withBook.movementCirca, false);
  assert.ok(Math.abs(withBook.movementAdj) < Math.abs(pinOnly.movementAdj) - 1e-4);

  const oneEnd = adjustCandidate(disagree, pair(
    { pinnacle: PIN_FLAT, bookmaker: PIN_FLAT },
    { pinnacle: PIN_LONG },
  ), blendCfg);
  assert.strictEqual(oneEnd.movementExtraSharp, false);
  assert.strictEqual(oneEnd.movementCirca, false);
  close(oneEnd.movementAdj, pinOnly.movementAdj, 1e-6);

  const circaOnly = adjustCandidate(ml({
    p_model: 0.55,
    fair_sharp_p: 0.55,
    coverProb: 0.55,
  }), pair(
    { pinnacle: PIN_FLAT, circa: PIN_LONG },
    { pinnacle: PIN_FLAT, circa: PIN_FLAT },
  ));
  assert.strictEqual(circaOnly.movementDrop, false);
  assert.strictEqual(circaOnly.movementExtraSharp, false);
  assert.strictEqual(circaOnly.movementCirca, false);

  const opposed = adjustCandidate(disagree, pair(
    { pinnacle: PIN_FLAT, hardrockbet: PIN_LONG },
    { pinnacle: PIN_LONG, hardrockbet: PIN_FLAT },
  ));
  assert.ok(Math.abs(opposed.movementAdj) < Math.abs(pinOnly.movementAdj) - 1e-4);
  assert.ok(Math.abs(opposed.movementAdj) > 0);

  const lagged = adjustCandidate(ml(), pair(
    { pinnacle: PIN_FLAT, draftkings: PIN_FLAT },
    { pinnacle: PIN_LONG, draftkings: PIN_FLAT },
  ));
  assert.strictEqual(lagged.movementDkLag, true);
  assert.ok(lagged.movementKEff > moved.movementKEff);
  assert.ok(Math.abs(lagged.movementAdj) > Math.abs(moved.movementAdj));
  assert.ok(Math.abs(lagged.movementAdj) <= 0.015);
  assert.strictEqual(moved.movementDkLag, false);
  const noQuote = adjustCandidate(ml(), pair(
    { pinnacle: PIN_FLAT },
    { pinnacle: PIN_LONG, draftkings: PIN_FLAT },
  ));
  assert.strictEqual(noQuote.movementDkLag, false, 'a missing 3:00 DraftKings quote is not a lag');

  const before = warns.length;
  const missing = adjustCandidate(ml(), meta([
    poll('0600', { pinnacle: PIN_LONG }),
    poll('0730', { pinnacle: PIN_FLAT }),
    poll('0900', { pinnacle: PIN_LONG }),
    poll('0915', { pinnacle: PIN_FLAT }),
    poll('open', { pinnacle: PIN_LONG }),
  ]));
  assert.strictEqual(missing.movementAdj, 0);
  assert.strictEqual(missing.movementAdjusted, true);
  assert.strictEqual(missing.movementDrop, false);
  close(missing.coverProb, 0.55, 1e-9);
  assert.deepStrictEqual(missing.movementMissing, ['0300', '1000']);
  const logged = warns.slice(before).join('\n');
  assert.ok(logged.includes('line-move-snapshot-missing'), logged);
  assert.ok(logged.includes('0600'), logged);

  const onlyOpen = adjustCandidate(ml(), meta([
    poll('0300', { pinnacle: PIN_FLAT }),
    poll('open', { pinnacle: PIN_LONG }),
  ]));
  assert.deepStrictEqual(onlyOpen.movementMissing, ['1000']);
  assert.strictEqual(onlyOpen.movementAdj, 0);
  close(onlyOpen.coverProb, 0.55, 1e-9);

  const off = applyLineMoveProb([ml()], pair({ pinnacle: PIN_FLAT }, { pinnacle: PIN_LONG }), {
    enabled: false,
  });
  assert.strictEqual(off[0].movementAdjusted, undefined);
  assert.strictEqual(off[0].coverProb, 0.55);

  function spreadRow(homePoint) {
    return {
      spreadHome: homePoint,
      spreadHomeOdds: -110,
      spreadAway: -homePoint,
      spreadAwayOdds: -110,
    };
  }
  function spreadCand(line) {
    return {
      sport: 'NFL',
      market: 'Spread',
      side: `${HOME} ${line}`,
      homeTeam: HOME,
      awayTeam: AWAY,
      line,
      odds: -110,
    };
  }
  // Default quote is the plain normal (PMF lost the 855-row ML log-loss), so a 1-point move through 3 matches one through 8.
  delete process.env.OMEGA_KEY_MASS;
  const keyOn = bookDelta(
    game({ pinnacle: spreadRow(-2.5) }),
    game({ pinnacle: spreadRow(-3.5) }),
    null,
    spreadCand(-3.5),
    ['pinnacle'],
  );
  const awayFromThree = bookDelta(
    game({ pinnacle: spreadRow(-7.5) }),
    game({ pinnacle: spreadRow(-8.5) }),
    null,
    spreadCand(-8.5),
    ['pinnacle'],
  );
  assert.ok(keyOn && awayFromThree);
  close(keyOn.d310, awayFromThree.d310, 1e-12);
  process.env.OMEGA_KEY_MASS = '1';
  const keyed = bookDelta(
    game({ pinnacle: spreadRow(-2.5) }),
    game({ pinnacle: spreadRow(-3.5) }),
    null,
    spreadCand(-3.5),
    ['pinnacle'],
  );
  delete process.env.OMEGA_KEY_MASS;
  assert.ok(keyed);
  assert.ok(Math.abs(keyed.p3 - keyOn.p3) <= 0.03 + 1e-9, `p3 rail ${keyed.p3 - keyOn.p3}`);
  assert.ok(Math.abs(keyed.p10 - keyOn.p10) <= 0.03 + 1e-9, `p10 rail ${keyed.p10 - keyOn.p10}`);
  assert.ok(Math.abs(keyed.d310 - keyOn.d310) <= 0.06 + 1e-9);

  const pick = toPickObject(moved);
  assert.strictEqual(pick.edgeBasis, 'calibrated-edge-vs-pinnacle-no-vig');
  assert.strictEqual(pick.evBasis, 'stake-ev-at-best-us-price');
  assert.strictEqual(pick.gradeBasis, pick.edgeBasis);
  assert.ok(/%$/.test(pick.edgePct));
  assert.ok(/%$/.test(pick.ev));
  assert.notStrictEqual(pick.ev, pick.edgePct);
  assert.strictEqual(pick.rating, qualityToRating(moved.edgePct, null, null));
  assert.notStrictEqual(pick.evRaw, moved.edgePct);
  assert.ok(pick.movement);
  assert.strictEqual(pick.movement.drop, false);

  const zeroEv = toPickObject(ml({ ev: 0, edgePct: 0.023, coverProb: 0.543 }));
  assert.strictEqual(zeroEv.ev, '0.0%');
  assert.strictEqual(zeroEv.evRaw, 0);
  assert.notStrictEqual(zeroEv.ev, zeroEv.edgePct);
  const noEv = toPickObject(ml({ ev: null, edgePct: 0.023 }));
  assert.strictEqual(noEv.ev, null);
  assert.strictEqual(noEv.evRaw, null);

  const reason = gateReason({
    sport: 'NFL',
    market: 'Moneyline',
    odds: -110,
    liquid: true,
    coverProb: 0.60,
    ev: 0.08,
    edgePct: 0.05,
    uncertainty: 0.12,
    movementDrop: true,
    movementDropReason: 'sharp_prob_against: -0.0300 (threshold 0.02)',
  });
  assert.ok(String(reason).indexOf('sharp_prob_against') === 0, reason);

  const shaped = shapeOfficialLinePath([
    { hhmm: '0600', games: { a: 1 } },
    { hhmm: '0915', games: { a: 1 } },
    { hhmm: '0300', games: { a: 1 } },
    { hhmm: 'open', games: { a: 1 } },
  ], '2026-10-13');
  assert.strictEqual(shaped.earliest.hhmm, '0300');
  assert.strictEqual(shaped.latest, null);
  assert.ok(shaped.missingSlots.includes('1000'));
  assert.ok(!shaped.path.polls.some((p) => p.hhmm === '0600' || p.hhmm === '0915'));
  assert.strictEqual(shaped.source, 'missing-0300-1000');

  const full = shapeOfficialLinePath([
    { hhmm: '0300', games: {} },
    { hhmm: '1000', games: {} },
    { hhmm: '0600', games: {} },
  ], '2026-10-13');
  assert.strictEqual(full.latest.hhmm, '1000');
  assert.strictEqual(full.earliest.hhmm, '0300');
  assert.strictEqual(full.source, 'pull-0300-1000');
  assert.ok(!full.path.polls.some((p) => p.hhmm === '0600'));
} finally {
  console.warn = origWarn;
  console.log = origLog;
}

console.log('test-omega-line-move-prob: ok');
