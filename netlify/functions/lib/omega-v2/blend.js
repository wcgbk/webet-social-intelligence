'use strict';

/**
 * Logit blend of the Pinnacle power no-vig and the sport model.
 * p = logistic((1 - w) * logit(pPin) + w * logit(pModel)).
 * w = 0 returns pPin. A missing side stays null.
 * The output clamp is the same post-trim bet-probability floor as select.js.
 */

const { clampWinProb, BLEND_W_CAP, FORMULA_BLEND_W } = require('./constants');

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

/**
 * NCAAM has a projection only when the sport engine built a standings
 * margin. The sharp-anchor path copies the market and is not a model.
 */
function ncaamHasProjection(row) {
  if (!row || row.sharpAnchor === true) return false;
  const method = String(row.projMethod || '');
  if (!method || method === 'ncaam-sharp-anchor') return false;
  return method === 'ncaam-standings' || /ncaam/i.test(method);
}

/**
 * Projection probability for the formula.
 * p_model is calibration.pCal from the sport model (spread and total
 * already went through that sport's margin or total distribution).
 * NCAAM is null unless a projection is on the row. A probability that
 * never left the market is not a model.
 */
function formulaModelProb(row, origPMkt) {
  const cal = (row && row.calibration) || {};
  const pCal = unitProb(cal.pCal);
  if (canonSport(row && row.sport) === 'NCAAM') {
    if (!ncaamHasProjection(row)) return null;
    return pCal;
  }
  if (pCal == null) return null;
  const raw = unitProb(cal.pModel != null ? cal.pModel : (row && row.pModel));
  const mkt = unitProb(origPMkt != null ? origPMkt : cal.pMkt);
  if (raw != null && mkt != null && Math.abs(raw - mkt) <= 1e-6) return null;
  if (mkt != null && Math.abs(pCal - mkt) <= 1e-6) return null;
  return pCal;
}

/**
 * Formula weight. 0.35 for every sport that has a p_model, including
 * NCAAM. OMEGA_V2_BLEND_W_<SPORT> still overrides. Cap stays 0.35.
 * Callers pass w = 0 when p_model is null.
 */
function formulaBlendWeight(sport, env) {
  const name = canonSport(sport);
  const source = env == null ? process.env : env;
  const raw = source[`OMEGA_V2_BLEND_W_${name}`];
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(BLEND_W_CAP, Math.max(0, n));
  }
  const fitted = Number(FORMULA_BLEND_W);
  if (!Number.isFinite(fitted)) return 0;
  return Math.min(BLEND_W_CAP, Math.max(0, fitted));
}

module.exports = {
  clampProb,
  unitProb,
  logit,
  logistic,
  blendProb,
  canonSport,
  modelProbForBlend,
  ncaamHasProjection,
  formulaModelProb,
  formulaBlendWeight,
};
