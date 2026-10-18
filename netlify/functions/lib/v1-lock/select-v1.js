'use strict';
/**
 * V1 selection (Lock §5/§6/§8): mandatory passes first, then Ben's sheet
 * as the sole admission floor, Grade A only for the verified standard bet,
 * rank by anchored true probability, no leans, no fills.
 * Pass order: missing formula (project-v1) -> missing Pinnacle receipt at
 * the bet line -> missing named bet-book price -> QB unknown replacement
 * -> sheet verdict != GOOD BET.
 */
const { checkSheetV1, quarterKellyUnitsV1 } = require('./sheet-v1');
const { americanToDecimal, decimalToAmerican, formatAmerican, formatMoneylinePick } = require('../omega-vnext/odds_math');
const { MAX_STRAIGHTS_V1, PARLAY_UNITS_V1, CORR_HAIRCUT_V1, MODEL_VERSION_V1 } = require('./config-v1');

function fmtPct(p, digits = 1) { return p == null || !Number.isFinite(p) ? null : `${(p * 100).toFixed(digits)}%`; }
function kickoffET(iso) {
  if (!iso) return 'TBD';
  try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; }
  catch (_) { return String(iso); }
}
function whatLosesV1(c) {
  if (c.market === 'Total') return /^over/i.test(c.side)
    ? `The game stays under ${c.line} total points.`
    : `The game goes over ${c.line} total points.`;
  if (c.market === 'Spread') return `${c.side} fails to cover ${c.line != null ? c.line : ''} against the final margin.`;
  return `${c.side} loses the game outright.`;
}
function receiptV1(c, check) {
  const pickLabel = formatMoneylinePick(c.side, c.market);
  return {
    game: `${c.matchup}, ${kickoffET(c.commenceTime)}`,
    pick: pickLabel,
    grade: 'A',
    confirmedLine: `${c.book} ${c.oddsStr}`,
    trueWinProbability: fmtPct(c.coverProb),
    formulaSpreadHome: c.formulaSpreadHome,
    formulaTotal: c.formulaTotal,
    receiptSpreadHome: c.receiptSpreadHome != null ? c.receiptSpreadHome : null,
    receiptTotal: c.receiptTotal != null ? c.receiptTotal : null,
    pinnacleAtBetLine: c.pinnacleReceipt ? { point: c.pinnacleReceipt.point,
      american: c.pinnacleReceipt.american, oppAmerican: c.pinnacleReceipt.oppAmerican } : null,
    availabilityFlags: c.qbFlag || 'no QB flag on file',
    coreReasoning: `Formula line (home margin ${c.formulaSpreadHome}, total ${c.formulaTotal}) prices ${pickLabel} at ${(c.modelPureP * 100).toFixed(1)}% before market contact; Pinnacle power de-vig fair is ${(c.pFair * 100).toFixed(1)}%; anchored p (w=${c.anchorWeight}) is ${(c.coverProb * 100).toFixed(1)}% vs ${(check.edgePts >= 0 ? '+' : '')}${check.edgePts.toFixed(1)} pts of edge and ${(check.ev * 100).toFixed(1)}% EV at ${c.book} ${c.oddsStr}.`,
    unitSize: 'sheet quarter-Kelly (preserved bet_check_gate quarterKellyUnitsSimple), cap 1.5u',
    whatLoses: whatLosesV1(c),
  };
}
function toPickV1(c, check) {
  const units = Math.max(0.25, check.kellyUnits || quarterKellyUnitsV1(c.coverProb, c.odds));
  const pickLabel = formatMoneylinePick(c.side, c.market);
  return {
    sport: c.sport, matchup: c.matchup, homeTeam: c.homeTeam, awayTeam: c.awayTeam,
    pick: pickLabel, pickDisplay: pickLabel, betType: c.market,
    odds: c.oddsStr, units: `${units}u`, rating: 'a', lockGrade: 'A',
    confidence: 82, commenceTime: c.commenceTime,
    winProbability: fmtPct(c.coverProb), coverProb: fmtPct(c.coverProb),
    edgePct: fmtPct(check.edgePts / 100), ev: fmtPct(check.ev),
    book: c.book, displayBook: c.book, executionBook: c.book,
    source: 'v1-lock', model: MODEL_VERSION_V1,
    modelEdge: `Anchored p: ${fmtPct(c.coverProb)}, model ${(c.modelPureP * 100).toFixed(1)}%, Pinnacle fair ${(c.pFair * 100).toFixed(1)}%, edge ${check.edgePts.toFixed(1)} pts`,
    coreReasoning: receiptV1(c, check).coreReasoning,
    lockFormulaLine: { spreadHome: c.formulaSpreadHome, total: c.formulaTotal },
    lockReceiptLine: { spreadHome: c.receiptSpreadHome, total: c.receiptTotal, point: c.pinnacleReceipt.point },
    lockAvailability: c.qbFlag || 'no QB flag on file',
    lockReceipt: receiptV1(c, check),
    sheetCheck: { verdict: check.verdict, edgePts: check.edgePts, ev: check.ev,
      profitPerUnit: check.profitPerUnit, band: check.band, credibility: check.credibility },
  };
}
function comboV1(legs) {
  let dec = 1, p = 1;
  for (const l of legs) { dec *= americanToDecimal(l.odds); p *= l.coverProb; }
  if (legs.length > 1) p *= Math.pow(CORR_HAIRCUT_V1, legs.length - 1);
  return { combinedDecimal: dec, combinedProb: p, ev: p * dec - 1 };
}
function buildParlayV1(goodPool, picks) {
  const pool = [...goodPool].sort((a, b) => b.coverProb - a.coverProb).slice(0, 24);
  const combos = (n) => {
    const out = []; const idx = [...Array(n).keys()];
    const rec = (start, cur) => {
      if (cur.length === n) { out.push([...cur]); return; }
      for (let i = start; i < pool.length; i++) { cur.push(pool[i]); rec(i + 1, cur); cur.pop(); }
    };
    if (pool.length >= n) rec(0, []);
    return out;
  };
  for (const n of [3, 2]) {
    let best = null;
    for (const legs of combos(n)) {
      if (new Set(legs.map(l => l.matchup)).size !== n) continue;
      const st = comboV1(legs);
      if (st.ev <= 0) continue; // Lock: parlay only if EV>0 after haircut
      if (!best || st.combinedProb > best.st.combinedProb) best = { legs, st };
    }
    if (best) {
      const am = decimalToAmerican(best.st.combinedDecimal);
      return [{ type: `${n}-leg-parlay-v1-lock`, units: `${PARLAY_UNITS_V1}u`,
        combinedOdds: am != null ? formatAmerican(am) : '',
        combinedDecimal: +best.st.combinedDecimal.toFixed(4),
        combinedProb: fmtPct(best.st.combinedProb), ev: fmtPct(best.st.ev),
        uniqueGames: n, uniqueSports: new Set(best.legs.map(l => l.sport)).size,
        independent: true, legMarkets: best.legs.map(l => l.market),
        correlationNote: `0.95 haircut per extra leg applied (${CORR_HAIRCUT_V1}^${n - 1})`,
        source: 'v1-lock',
        legs: best.legs.map(l => toPickV1(l.c, l.check)) }];
    }
  }
  return [];
}
function selectV1(candidates, formulaPasses = []) {
  const funnel = { candidates: (candidates || []).length, formulaPassGames: formulaPasses.length,
    missingReceipt: 0, missingBetPrice: 0, qbUnknown: 0, sheetFail: 0, sheetAudit: 0, good: 0 };
  const rejections = formulaPasses.map(p => ({ matchup: p.matchup, sport: p.sport, reason: p.reason }));
  const good = [];
  for (const c of candidates || []) {
    if (!c.pinnacleReceipt || c.pFair == null) { funnel.missingReceipt++;
      rejections.push({ matchup: c.matchup, side: c.side, reason: 'lock-missing-receipt' }); continue; }
    if (c.odds == null || !c.book) { funnel.missingBetPrice++;
      rejections.push({ matchup: c.matchup, side: c.side, reason: 'lock-missing-bet-price' }); continue; }
    if (c.qbUnknownReplacement) { funnel.qbUnknown++;
      rejections.push({ matchup: c.matchup, side: c.side, reason: 'lock-qb-unknown-replacement' }); continue; }
    if (c.coverProb == null) { funnel.missingReceipt++;
      rejections.push({ matchup: c.matchup, side: c.side, reason: 'lock-missing-anchor' }); continue; }
    const check = checkSheetV1({ p: c.coverProb, odds: c.odds });
    if (check.verdict !== 'GOOD BET') {
      if (check.flagged) funnel.sheetAudit++; else funnel.sheetFail++;
      rejections.push({ matchup: c.matchup, side: c.side,
        reason: check.flagged ? `sheet-audit:${check.betCheckFlag}` : 'sheet-fail',
        edgePts: check.edgePts, ev: check.ev });
      continue;
    }
    funnel.good++;
    good.push({ c, check });
  }
  // Rank by anchored true probability (preserved rule), ties by EV. One per game.
  good.sort((a, b) => (b.c.coverProb - a.c.coverProb) || (b.check.ev - a.check.ev));
  const picks = []; const used = new Set();
  for (const g of good) {
    if (picks.length >= MAX_STRAIGHTS_V1) break;
    if (used.has(g.c.matchup)) continue;
    used.add(g.c.matchup);
    picks.push(toPickV1(g.c, g.check));
  }
  const parlayLegs = picks.length ? buildParlayV1(good, picks) : [];
  return { picks, parlayLegs, funnel, rejections, goodPoolSize: good.length };
}
module.exports = { selectV1, receiptV1, comboV1, buildParlayV1, whatLosesV1 };
