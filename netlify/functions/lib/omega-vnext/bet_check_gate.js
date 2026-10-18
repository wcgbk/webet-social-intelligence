'use strict';
/**
 * Sheet bet-check gates (simplified textbook path, baseline commit ac00dd0).
 * Thresholds are reused verbatim from v1/model.js (the Good Bet Checker
 * sheet implemented in 1685616): do not invent new values here.
 * Design intent (Ben, 2026-10-18):
 *  - Core metrics (edge, EV, model/final probability vs price) decide.
 *  - Secondary variables (steam, PM, lag, movement, uncertainty, placeability
 *    notes) must NOT silently kill a candidate with strong core metrics.
 *  - Implausible / suspect candidates are FLAGGED (betCheckFlag), never
 *    silently dropped by this module. applyBetCheckGate only stamps fields.
 */
let THRESHOLDS;
try { THRESHOLDS = require('../../../../v1/model.js').THRESHOLDS; }
catch (_) {
  THRESHOLDS = { minEdgePts: 2, minEv: 0.02, realisticEdgePts: 5, auditEdgePts: 10,
    auditEv: 0.10, implausibleEdgePts: 24, implausibleEv: 0.40, unitDollars: 150,
    minProfitDollars: 3, minRoi: 0.02 };
}
const { americanToDecimal, americanToImplied } = require('./odds_math');
const { anchorProbability, modelWeightFor } = require('./prob_anchor');

/** Simplified math: final p = w*modelPureP + (1-w)*p_fair, nothing else.
 *  No line-move, DK-lag, PM, steam, personnel or push adjustments. */
function simplifiedProbability(row) {
  const pm = Number(row && (row.modelPureP != null ? row.modelPureP : row.p_model));
  const pf = Number(row && (row.p_fair != null ? row.p_fair : row.fair_sharp_p));
  const w = modelWeightFor(row && row.sport, row && (row.market || row.betType));
  if (!Number.isFinite(pm) || !Number.isFinite(pf) || w == null) return null;
  return anchorProbability(pm, pf, w);
}
function quarterKellyUnitsSimple(p, odds) {
  const dec = americanToDecimal(odds); if (!(dec > 1)) return 0;
  const ev = p * dec - 1; if (!(ev > 0)) return 0;
  const raw = 0.25 * (ev / (dec - 1)) * 100;
  return Math.min(1.5, Math.round(raw * 4) / 4);
}
function checkCandidate(row, opts = {}) {
  const t = THRESHOLDS;
  const odds = row && (row.odds != null ? row.odds : row.oddsStr);
  // Simplified variant uses the anchored core p; caller may pass pOverride
  // (e.g. the already-published final coverProb) to audit a printed card.
  const p = opts.pOverride != null ? Number(opts.pOverride) : simplifiedProbability(row);
  const dec = americanToDecimal(odds);
  const implied = americanToImplied(odds);
  if (p == null || !Number.isFinite(p) || dec == null || implied == null) {
    return { verdict: 'NO BET', flagged: false, reason: 'missing-core-input', p: null };
  }
  const edgePts = (p - implied) * 100;
  const ev = p * dec - 1;
  const profitPerUnit = Math.sign(ev) * Math.ceil(Math.abs(ev * t.unitDollars) - 1e-9); // sheet ROUNDUP = away from zero
  const core = {
    edge: edgePts >= t.minEdgePts, ev: ev >= t.minEv,
    roi: ev >= t.minRoi, profit: profitPerUnit >= t.minProfitDollars,
  };
  const band = edgePts < t.minEdgePts ? 'BELOW BAND'
    : edgePts <= t.realisticEdgePts ? 'IN REALISTIC BAND' : 'ABOVE BAND';
  const credibility = (edgePts >= t.implausibleEdgePts || ev >= t.implausibleEv) ? 'IMPLAUSIBLE'
    : (edgePts > t.auditEdgePts || ev > t.auditEv) ? 'SUSPECT - AUDIT' : 'OK';
  const flagged = credibility !== 'OK';
  // Secondary weakness never changes the verdict; it is only reported.
  const secondaryWeak = !!(opts.secondaryWeak);
  let verdict = 'NO BET';
  if (!flagged && core.edge && core.ev && core.roi && core.profit) verdict = 'GOOD BET';
  else if (flagged) verdict = 'DO NOT BET - AUDIT';
  return { verdict, flagged, betCheckFlag: flagged ? credibility : null,
    band, credibility, core, secondaryWeak,
    p, edgePts: +edgePts.toFixed(3), ev: +ev.toFixed(4),
    profitPerUnit, kellyUnits: quarterKellyUnitsSimple(p, odds) };
}
/** Stamp-only: keeps every candidate, adds bet-check fields. */
function applyBetCheckGate(candidates, opts = {}) {
  return (candidates || []).map((c) => {
    const r = checkCandidate(c, opts);
    return { ...c, betCheck: r, betCheckFlag: r.betCheckFlag || null,
      betCheckVerdict: r.verdict };
  });
}
module.exports = { THRESHOLDS, simplifiedProbability, checkCandidate, applyBetCheckGate };

/* ---- Pipeline gating points (2026-10-18 follow-up) ----
 * 1. Card admission (floor straights): verdict must be GOOD BET.
 * 2. Lean fill (Giants-class fix): verdict must be GOOD BET. A positive-EV
 *    candidate failing sheet minimums may NOT publish as a lean.
 * 3. Parlay legs: every leg must be GOOD BET; flagged legs are excluded.
 * Flagged (SUSPECT/IMPLAUSIBLE) candidates are RETAINED with betCheckFlag
 * for audit, never silently dropped. Secondary variables never gate here:
 * only the four core sheet tests + credibility decide.
 * TRUE PROBABILITY is the rank key after gates (Ben 2026-10-18):
 * p used = anchored final p (coverProb), NOT raw modelPureP (p_model).
 * Why: modelPureP today sits 11.9-19.0 pts from Pinnacle fair and fails the
 * sheet credibility audit on its own; the anchored p is the probability the
 * card actually prices, stakes and prints. Edge/EV remain gates + stake
 * inputs, not rank keys. */
function sheetCheckForCandidate(c) {
  if (!c) return { verdict: 'NO BET', flagged: false, reason: 'missing-candidate' };
  // Published picks carry coverProb as a "55.0%" string; candidates as 0.55.
  let p = null;
  if (c.coverProb != null) {
    const raw = String(c.coverProb).trim();
    const n = Number(raw.replace('%', ''));
    p = Number.isFinite(n) ? (raw.includes('%') || n > 1 ? n / 100 : n) : null;
  }
  const odds = c.odds != null ? c.odds : c.oddsStr;
  if (p == null || !Number.isFinite(p)) return { verdict: 'NO BET', flagged: false, reason: 'missing-coverProb' };
  return checkCandidate(c, { pOverride: p });
}
function passesSheetMinimums(c) { return sheetCheckForCandidate(c).verdict === 'GOOD BET'; }
function admissionDecision(c, slot) {
  const r = sheetCheckForCandidate(c);
  return { slot: slot || 'card', publish: r.verdict === 'GOOD BET',
    flagged: !!r.flagged, retained: true, verdict: r.verdict,
    betCheckFlag: r.betCheckFlag || null, check: r };
}
function rankByTrueProbability(rows) {
  // Rank: true probability. Ties: a row whose fair came from a real book
  // pair (anchorFairSource set) beats an unsourced row on the same game,
  // then stake EV. Structural source quality is a tiebreak, not a gate.
  const sourced = (c) => (c && c.anchorFairSource && c.anchorFairSource !== 'none') ? 1 : 0;
  return [...(rows || [])].sort((a, b) =>
    (Number(b.coverProb) - Number(a.coverProb)) || (sourced(b) - sourced(a)) || ((Number(b.ev) || 0) - (Number(a.ev) || 0)));
}
module.exports.sheetCheckForCandidate = sheetCheckForCandidate;
module.exports.passesSheetMinimums = passesSheetMinimums;
module.exports.admissionDecision = admissionDecision;
module.exports.rankByTrueProbability = rankByTrueProbability;
