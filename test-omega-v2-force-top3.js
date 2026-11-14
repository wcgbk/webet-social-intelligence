'use strict';

/**
 * Force-top-3 card: every straight is one of the top 3 plays by
 * quarter-Kelly expected growth, one per game, and the parlay is those
 * straights. Null growth falls back to price EV. Flag off keeps the
 * positive-edge gates.
 */

const assert = require('assert');
const {
  annotateCandidate, selectStraights, selectForcedTop3, kellyGrowth,
} = require('./netlify/functions/lib/omega-v2/select');
const { sizeForcedStraights, sumUnits } = require('./netlify/functions/lib/omega-v2/size');
const { buildForcedParlay } = require('./netlify/functions/lib/omega-v2/parlay');
const { toPick, toParlay, autoCorrectCard, validateCard } = require('./netlify/functions/lib/omega-v2/guards');
const { letterFromPrintedEdge } = require('./netlify/functions/lib/omega-v2/letter');
const { MODEL_VERSION, STRAIGHT_BUDGET, forceTop3Enabled, longshotAdjEnabled } = require('./netlify/functions/lib/omega-v2/constants');
const verify = require('./netlify/functions/verify-picks-omega');

const AS_OF = Date.parse('2026-11-03T16:00:00Z');
const COMMENCE = '2026-11-04T00:00:00Z';
const PREGAME = { pregameAsOfMs: AS_OF };

function raw(over) {
  return {
    sport: over.sport || 'NBA',
    matchup: over.matchup,
    pick: over.pick,
    market: over.market || 'Moneyline',
    odds: over.odds,
    book: over.book || 'draftkings',
    gameKey: over.gameKey || String(over.matchup || '').toLowerCase(),
    commenceTime: over.commenceTime || COMMENCE,
    calibration: over.calibration,
  };
}

function annotate(over, opts) {
  return annotateCandidate(raw(over), opts);
}

const savedForce = process.env.OMEGA_V2_FORCE_TOP3;
const savedAdj = process.env.OMEGA_V2_LONGSHOT_ADJ;

function restoreEnv() {
  if (savedForce == null) delete process.env.OMEGA_V2_FORCE_TOP3;
  else process.env.OMEGA_V2_FORCE_TOP3 = savedForce;
  if (savedAdj == null) delete process.env.OMEGA_V2_LONGSHOT_ADJ;
  else process.env.OMEGA_V2_LONGSHOT_ADJ = savedAdj;
}

process.env.OMEGA_V2_FORCE_TOP3 = '1';
delete process.env.OMEGA_V2_LONGSHOT_ADJ;
assert.strictEqual(forceTop3Enabled(), true);
assert.strictEqual(longshotAdjEnabled(), true);

const negativeRaws = [
  { matchup: 'A1 @ H1', pick: 'Alpha Side', odds: -110, calibration: { pCal: 0.45, pMkt: 0.50, pModel: 0.45 } },
  { matchup: 'A2 @ H2', pick: 'Bravo Side', odds: -110, calibration: { pCal: 0.50, pMkt: 0.52, pModel: 0.50 } },
  { matchup: 'A2 @ H2', pick: 'Bravo Alt', odds: -110, calibration: { pCal: 0.52, pMkt: 0.52, pModel: 0.52 } },
  { matchup: 'A3 @ H3', pick: 'Charlie Side', odds: 100, calibration: { pCal: 0.40, pMkt: 0.48, pModel: 0.40 } },
  { matchup: 'A4 @ H4', pick: 'Delta Side', odds: -105, calibration: { pCal: 0.48, pMkt: 0.50, pModel: 0.48 } },
];

// (a) An all-negative slate still yields 3 picks, one per game.
// Full Kelly is not positive, so growth is null and those rows stay in EV order.
const slate = negativeRaws.map((row) => annotate(row));
assert.ok(slate.every((c) => c.forcePlaceable), slate.map((c) => `${c.pick}:${c.rejectReason}`).join(','));
assert.ok(slate.every((c) => c.edge < 0 && c.ev < 0), 'every price edge and EV is negative');
const top = selectForcedTop3(slate, PREGAME);
assert.deepStrictEqual(top.map((c) => c.pick), ['Bravo Alt', 'Delta Side', 'Alpha Side']);
assert.strictEqual(new Set(top.map((c) => c.gameKey)).size, 3);
assert.ok(top.every((c) => c.kellyGrowth == null));
for (let i = 1; i < top.length; i += 1) assert.ok(top[i - 1].ev >= top[i].ev);

// Higher price EV at +150 still ranks under a -110 with higher growth.
function growthAt(p, decimal) {
  const b = decimal - 1;
  const full = (b * p - (1 - p)) / b;
  const f = 0.25 * full;
  return full > 0 ? p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f) : null;
}
const plus150 = annotate({
  matchup: 'Dog A @ Dog B',
  pick: 'Plus One Fifty',
  odds: 150,
  calibration: { pCal: 0.46, pMkt: 0.40, pModel: 0.46 },
});
const minus110 = annotate({
  matchup: 'Fav A @ Fav B',
  pick: 'Minus One Ten',
  odds: -110,
  calibration: { pCal: 0.60, pMkt: 0.52, pModel: 0.60 },
});
assert.strictEqual(plus150.pBet, 0.46);
assert.strictEqual(minus110.pBet, 0.60);
const gPlus = growthAt(plus150.pBet, plus150.decimal);
const gMinus = growthAt(minus110.pBet, minus110.decimal);
assert.ok(plus150.ev > minus110.ev, `+150 EV ${plus150.ev} -110 EV ${minus110.ev}`);
assert.ok(gPlus != null && gMinus != null && gPlus < gMinus, `+150 growth ${gPlus} -110 growth ${gMinus}`);
assert.ok(Math.abs(kellyGrowth(plus150.pBet, plus150.decimal) - gPlus) < 1e-12);
assert.ok(Math.abs(kellyGrowth(minus110.pBet, minus110.decimal) - gMinus) < 1e-12);
const growthRank = selectForcedTop3([plus150, minus110], PREGAME);
assert.deepStrictEqual(growthRank.map((c) => c.pick), ['Minus One Ten', 'Plus One Fifty']);
assert.ok(Math.abs(growthRank[0].kellyGrowth - gMinus) < 1e-12);
assert.ok(Math.abs(growthRank[1].kellyGrowth - gPlus) < 1e-12);

// (b) Longshot penalty keeps a +2000 dog under a -110 coin flip.
const longRaw = {
  matchup: 'College A @ College B',
  pick: 'College Dog',
  odds: 2000,
  calibration: { pCal: 0.05, pMkt: 0.05, pModel: 0.05 },
};
const coinRaw = {
  matchup: 'Coin A @ Coin B',
  pick: 'Coin Flip',
  odds: -110,
  calibration: { pCal: 0.50, pMkt: 0.50, pModel: 0.50 },
};
const longshot = annotate(longRaw);
const coin = annotate(coinRaw);
assert.ok(Math.abs(longshot.pBet - (0.05 - 0.032896)) < 1e-12, `pBet ${longshot.pBet}`);
assert.ok(longshot.ev < coin.ev, `longshot EV ${longshot.ev} coin ${coin.ev}`);
assert.strictEqual(selectForcedTop3([longshot, coin], PREGAME)[0].pick, 'Coin Flip');
process.env.OMEGA_V2_LONGSHOT_ADJ = 'off';
assert.strictEqual(longshotAdjEnabled(), false);
const longOff = annotate(longRaw);
const coinOff = annotate(coinRaw);
assert.strictEqual(longOff.pBet, 0.05);
assert.ok(longOff.ev > coinOff.ev, 'without the haircut the longshot outranks the coin flip');
delete process.env.OMEGA_V2_LONGSHOT_ADJ;

// (c) 0.25u floor, B cap 0.5u, 2u cap, and the 3.5u trim never goes under 0.25u.
const floored = sizeForcedStraights([annotate({
  matchup: 'F @ G',
  pick: 'Floor',
  odds: -110,
  calibration: { pCal: 0.40, pMkt: 0.50, pModel: 0.40 },
})])[0];
assert.strictEqual(floored.units, 0.25);
assert.strictEqual(floored.stakeUsd, 38);
assert.strictEqual(letterFromPrintedEdge(floored.edge), 'b');

const bee = sizeForcedStraights([annotate({
  matchup: 'B @ C',
  pick: 'Bee Cap',
  odds: -200,
  calibration: { pCal: 0.68, pMkt: 0.66, pModel: 0.68 },
})])[0];
assert.strictEqual(letterFromPrintedEdge(bee.edge), 'b');
assert.strictEqual(bee.units, 0.5);
assert.strictEqual(bee.stakeUsd, 75);

const capped = sizeForcedStraights([annotate({
  matchup: 'C @ D',
  pick: 'Two Cap',
  odds: 100,
  calibration: { pCal: 0.67, pMkt: 0.58, pModel: 0.67 },
})])[0];
assert.strictEqual(letterFromPrintedEdge(capped.edge), 'aplus');
assert.strictEqual(capped.units, 2);
assert.strictEqual(capped.stakeUsd, 300);

const heavy = sizeForcedStraights(['North', 'East', 'West'].map((name, i) => annotate({
  matchup: `N${i} @ S${i}`,
  pick: name,
  odds: 100,
  calibration: { pCal: 0.67, pMkt: 0.58, pModel: 0.67 },
})));
assert.strictEqual(heavy.length, 3);
assert.ok(Math.abs(sumUnits(heavy) - STRAIGHT_BUDGET) < 1e-9, `budget ${sumUnits(heavy)}`);
assert.ok(heavy.every((row) => row.units >= 0.25));

// (d) p = 0.55 at -110. Penalty is 0 because pMkt is above 0.37.
const worked = annotate({
  matchup: 'Worked A @ Worked B',
  pick: 'Worked',
  odds: -110,
  calibration: { pCal: 0.55, pMkt: 0.52, pModel: 0.55 },
});
assert.ok(Math.abs(worked.implied - 0.52381) < 1e-5, `implied ${worked.implied}`);
assert.strictEqual(worked.pBet, 0.55);
assert.ok(Math.abs(worked.edge * 100 - 2.619047619) < 1e-6, `edge ${worked.edge}`);
assert.strictEqual(letterFromPrintedEdge(worked.edge), 'aminus');
assert.ok(Math.abs(worked.ev - 0.05) < 1e-9, `ev ${worked.ev}`);
assert.ok(Math.abs(worked.edgeNovig - 0.03) < 1e-12);
const workedSized = sizeForcedStraights([worked])[0];
assert.strictEqual(workedSized.units, 1.5);
assert.strictEqual(workedSized.stakeUsd, 225);
const workedPick = toPick(workedSized);
assert.strictEqual(workedPick.rating, 'aminus');
assert.strictEqual(workedPick.edgePct, '2.6%');
assert.strictEqual(workedPick.priceEdgePct, '2.6%');
assert.strictEqual(workedPick.units, '1.5u');
assert.strictEqual(workedPick.stakeUsd, 225);
assert.ok(Math.abs(workedPick.edgeNovig - 0.03) < 1e-12);
assert.strictEqual(workedPick.coverProb, '55.0%');

// (e) Parlay legs are those straights. Stake floors at 0.25u and caps at 1u.
const negSized = sizeForcedStraights(top);
const negParlay = buildForcedParlay(negSized);
assert.strictEqual(negParlay.publish, true);
assert.strictEqual(negParlay.legs.length, 3);
assert.deepStrictEqual(negParlay.legs.map((leg) => leg.pick), negSized.map((row) => row.pick));
assert.strictEqual(negParlay.units, 0.25);
assert.strictEqual(negParlay.stakeUsd, 38);
assert.ok(negParlay.combinedOdds);
const negTicket = toParlay(negParlay, slate.length);
assert.strictEqual(negTicket.length, 1);
assert.strictEqual(negTicket[0].legs.length, 3);
assert.strictEqual(negTicket[0].units, '0.25u');

const rich = ['One', 'Two', 'Three'].map((name, i) => annotate({
  matchup: `R${i} @ S${i}`,
  pick: name,
  odds: -110,
  calibration: { pCal: 0.60, pMkt: 0.55, pModel: 0.60 },
}));
const richParlay = buildForcedParlay(sizeForcedStraights(rich));
assert.strictEqual(richParlay.publish, true);
assert.strictEqual(richParlay.units, 1);
assert.strictEqual(richParlay.stakeUsd, 150);
assert.strictEqual(buildForcedParlay(negSized.slice(0, 2)).legs.length, 2);
assert.strictEqual(buildForcedParlay(negSized.slice(0, 1)).publish, false);

// (f) Price-fair mismatch rejects. A longshot outside the band does not.
const mispaired = annotate({
  matchup: 'Fair A @ Fair B',
  pick: 'Mispaired',
  odds: -110,
  calibration: { pCal: 0.45, pMkt: 0.40, pModel: 0.45 },
});
assert.strictEqual(mispaired.rejectReason, 'price-fair-mismatch');
assert.strictEqual(mispaired.forcePlaceable, false);
assert.strictEqual(mispaired.qualified, false);
assert.strictEqual(mispaired.parlayQualified, false);
const outside = annotate({
  matchup: 'Dog A @ Dog B',
  pick: 'Outside Band',
  odds: 2000,
  calibration: { pCal: 0.08, pMkt: 0.20, pModel: 0.08 },
});
assert.strictEqual(outside.rejectReason, null);
assert.strictEqual(outside.forcePlaceable, true);

// (g) Flag off: the same all-negative slate publishes nothing.
process.env.OMEGA_V2_FORCE_TOP3 = 'off';
assert.strictEqual(forceTop3Enabled(), false);
const offSlate = negativeRaws.map((row) => annotate(row));
assert.ok(offSlate.every((c) => c.qualified === false), offSlate.map((c) => c.rejectReason).join(','));
assert.ok(offSlate.every((c) => c.forcePlaceable == null && c.pBet == null));
assert.strictEqual(selectStraights(offSlate, PREGAME).length, 0);
process.env.OMEGA_V2_FORCE_TOP3 = '0';
assert.strictEqual(selectStraights(negativeRaws.map((row) => annotate(row)), PREGAME).length, 0);
process.env.OMEGA_V2_FORCE_TOP3 = 'false';
assert.strictEqual(selectStraights(negativeRaws.map((row) => annotate(row)), PREGAME).length, 0);

// Forced verify keeps a negative-EV straight, and QA does not dust-drop it
// or reject the parlay for a non-positive leg edge.
process.env.OMEGA_V2_FORCE_TOP3 = '1';
const negPick = toPick(negSized[0]);
const forcedMath = verify.runMathChecks(negPick, { selectionRule: 'force-top3' });
assert.notStrictEqual(forcedMath.severity, 'critical');
assert.ok(forcedMath.warnings.some((w) => /Negative EV/.test(w)));
assert.ok(!forcedMath.errors.some((e) => /CRITICAL: Negative EV/.test(e)));
assert.strictEqual(verify.runMathChecks(negPick).severity, 'critical');
const dustCard = {
  modelVersion: MODEL_VERSION,
  leakageChecked: true,
  selectionRule: 'force-top3',
  picks: [{ ...negPick, units: '0.1u', unitsNum: 0.1, stakeUsd: 15 }],
  parlayLegs: [{
    type: '2-leg',
    units: '0.25u',
    unitsNum: 0.25,
    stakeUsd: 38,
    legs: negSized.slice(0, 2).map((row) => toPick(row)),
    combinedOdds: negParlay.combinedOdds,
    decimal: 1,
  }],
  parlayPool: [],
};
const corrected = autoCorrectCard(dustCard, PREGAME);
assert.strictEqual(corrected.picks.length, 1);
assert.strictEqual(corrected.picks[0].unitsNum, 0.25);
assert.strictEqual(corrected.parlayLegs.length, 1);
assert.ok(corrected.parlayLegs[0].unitsNum >= 0.25);
const qaErrors = validateCard(corrected);
assert.ok(!qaErrors.some((e) => /parlay leg edge is not positive/.test(e)), qaErrors.join('; '));
assert.ok(!qaErrors.some((e) => /floors sub-0\.25u quarter-Kelly/.test(e)), qaErrors.join('; '));

const kept = {
  picks: [negPick, toPick(negSized[1])],
  parlayLegs: [{
    type: '2-leg',
    units: '0.25u',
    unitsNum: 0.25,
    legs: negSized.slice(0, 2).map((row) => ({ ...toPick(row), edgeNovig: -0.02 })),
  }],
  selectionRule: 'force-top3',
};
const reports = kept.picks.map((p) => {
  const math = verify.runMathChecks(p, { forceTop3: true });
  return { mathSeverity: math.severity, errors: math.errors, warnings: math.warnings, pick: `${p.pick} ${p.odds}` };
});
verify.autoFixPicks(kept, reports).then((fix) => {
  assert.strictEqual(fix.replacements.length, 0);
  assert.strictEqual(kept.picks.length, 2);
  const resolved = verify.resolveLockedParlay(kept.parlayLegs, {
    removedPicks: [],
    forceTop3: true,
    selectionRule: 'force-top3',
  });
  assert.strictEqual(resolved.action, 'preserved');
  assert.strictEqual(resolved.parlayLegs.length, 1);
  restoreEnv();
  console.log('PASS test-omega-v2-force-top3');
}).catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
