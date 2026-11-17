'use strict';

/**
 * Logit blend of the Pinnacle power no-vig and the sport model.
 * p = logistic((1 - w) * logit(pPin) + w * logit(pModel)).
 * w = 0 returns pPin. A missing side stays null.
 * The output clamp is the same post-trim bet-probability floor as select.js.
 */

const { clampWinProb } = require('./constants');

function clampProb(p, env) {
  return clampWinProb(p, env);
}

function unitProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0 && n < 1)) return null;
  return n;
}

function logit(p) {
  const x = unitProb(p);
  if (x == null) return null;
  return Math.log(x / (1 - x));
}

function logistic(z) {
  const x = Number(z);
  if (!Number.isFinite(x)) return null;
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

function blendProb(pPin, pModel, w, env) {
  const pin = unitProb(pPin);
  if (pin == null) return null;
  const ww = Number(w);
  if (!(ww > 0)) return clampProb(pin, env);
  const a = logit(pin);
  const b = logit(pModel);
  if (a == null || b == null) return null;
  return clampProb(logistic(((1 - ww) * a) + (ww * b)), env);
}

function canonSport(sport) {
  const s = String(sport || '').toUpperCase();
  if (s === 'NCAAB' || s === 'BASKETBALL_NCAAB') return 'NCAAM';
  if (s === 'BASKETBALL_NBA') return 'NBA';
  if (s === 'AMERICANFOOTBALL_NFL') return 'NFL';
  if (s === 'AMERICANFOOTBALL_NCAAF') return 'NCAAF';
  if (s === 'ICEHOCKEY_NHL') return 'NHL';
  if (s === 'BASEBALL_MLB') return 'MLB';
  return s;
}

/**
 * Calibrated model probability for this side.
 * NCAAM has no model. A missing probability, or a model that equals the
 * pre-Pinnacle market, stays on the Pinnacle number (return null).
 * The blend input is calibration.pCal (replay boards: pCalRaw, else coverProb).
 * Raw calibration.pModel is only the market-equality check.
 */
function modelProbForBlend(row, origPMkt) {
  if (canonSport(row && row.sport) === 'NCAAM') return null;
  const cal = (row && row.calibration) || {};
  const raw = unitProb(cal.pModel != null ? cal.pModel : (row && row.pModel));
  const mkt = unitProb(origPMkt);
  const pCal = unitProb(cal.pCal);
  if (raw != null && mkt != null && Math.abs(raw - mkt) <= 1e-6) return null;
  if (pCal == null) return null;
  if (mkt != null && Math.abs(pCal - mkt) <= 1e-6) return null;
  return pCal;
}

module.exports = {
  clampProb,
  unitProb,
  logit,
  logistic,
  blendProb,
  canonSport,
  modelProbForBlend,
};
