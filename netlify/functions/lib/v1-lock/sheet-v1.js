'use strict';
/**
 * Ben's Good Bet Checker sheet — V1 admission floor ONLY.
 * Thresholds imported verbatim from v1/model.js (the sheet, 1685616);
 * check logic imported cleanly from the preserved modern lineage
 * (bet_check_gate.js @ pre-reset-20261018): edge>=2pts, EV>=2%,
 * profit>= $3/1u ROUNDUP (away from zero), ROI>=2%; credibility audit
 * (edge>10 or EV>10% SUSPECT; edge>=24 or EV>=40% IMPLAUSIBLE) is a
 * DO NOT BET - AUDIT, never a silent drop and never a GOOD BET.
 * This module is used by the V1 path only; Omega does not import it.
 */
let THRESHOLDS;
try { THRESHOLDS = require('../../../../v1/model.js').THRESHOLDS; }
catch (_) {
  THRESHOLDS = { minEdgePts: 2, minEv: 0.02, realisticEdgePts: 5, auditEdgePts: 10,
    auditEv: 0.10, implausibleEdgePts: 24, implausibleEv: 0.40, unitDollars: 150,
    minProfitDollars: 3, minRoi: 0.02 };
}
const { americanToDecimal, americanToImplied } = require('../omega-vnext/odds_math');
function quarterKellyUnitsV1(p, odds) {
  const dec = americanToDecimal(odds); if (!(dec > 1)) return 0;
  const ev = p * dec - 1; if (!(ev > 0)) return 0;
  const raw = 0.25 * (ev / (dec - 1)) * 100;
  return Math.min(1.5, Math.round(raw * 4) / 4);
}
function checkSheetV1({ p, odds } = {}) {
  const t = THRESHOLDS;
  const dec = americanToDecimal(odds);
  const implied = americanToImplied(odds);
  const pn = Number(p);
  if (!Number.isFinite(pn) || pn <= 0 || pn >= 1 || dec == null || implied == null) {
    return { verdict: 'NO BET', flagged: false, reason: 'missing-core-input', p: null };
  }
  const edgePts = (pn - implied) * 100;
  const ev = pn * dec - 1;
  const profitPerUnit = Math.sign(ev) * Math.ceil(Math.abs(ev * t.unitDollars) - 1e-9);
  const core = {
    edge: edgePts >= t.minEdgePts, ev: ev >= t.minEv,
    roi: ev >= t.minRoi, profit: profitPerUnit >= t.minProfitDollars,
  };
  const band = edgePts < t.minEdgePts ? 'BELOW BAND'
    : edgePts <= t.realisticEdgePts ? 'IN REALISTIC BAND' : 'ABOVE BAND';
  const credibility = (edgePts >= t.implausibleEdgePts || ev >= t.implausibleEv) ? 'IMPLAUSIBLE'
    : (edgePts > t.auditEdgePts || ev > t.auditEv) ? 'SUSPECT - AUDIT' : 'OK';
  const flagged = credibility !== 'OK';
  let verdict = 'NO BET';
  if (!flagged && core.edge && core.ev && core.roi && core.profit) verdict = 'GOOD BET';
  else if (flagged) verdict = 'DO NOT BET - AUDIT';
  return { verdict, flagged, betCheckFlag: flagged ? credibility : null, band, credibility,
    core, p: pn, edgePts: +edgePts.toFixed(3), ev: +ev.toFixed(4),
    profitPerUnit, kellyUnits: quarterKellyUnitsV1(pn, odds) };
}
module.exports = { THRESHOLDS_V1: THRESHOLDS, checkSheetV1, quarterKellyUnitsV1 };
