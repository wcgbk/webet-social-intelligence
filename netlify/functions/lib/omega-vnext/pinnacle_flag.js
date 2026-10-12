'use strict';

/**
 * Pre-publish check against Pinnacle's paired no-vig. A wide probability
 * gap or a wide spread/total point gap sets dataReviewFlag. Nothing is
 * dropped and nothing is repriced.
 */

const { currentAudit } = require('./audit_log');

const PROB_GAP = 0.12;
const POINT_GAP = { NFL: 7, NCAAF: 10, NHL: 1.5, MLB: 2 };

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function modelProbOf(row) {
  if (!row || typeof row !== 'object') return null;
  const cover = row.coverProb;
  if (typeof cover !== 'string') {
    const numeric = finite(cover);
    if (numeric != null) return numeric;
  }
  const calibrated = finite(row.p_cal);
  if (calibrated != null) return calibrated;
  if (typeof cover === 'string' && /%$/.test(cover.trim())) {
    const parsed = finite(cover.replace('%', ''));
    if (parsed != null) return parsed / 100;
  }
  return finite(row.modelRawP);
}

function roundTo(value, digits) {
  if (value == null) return null;
  return +Number(value).toFixed(digits);
}

function reviewFlag(row) {
  if (!row || typeof row !== 'object') return null;
  const sport = String(row.sport || '').toUpperCase();
  const market = String(row.market || row.betType || '');
  const modelProb = modelProbOf(row);
  const pin = finite(row.pinnacleNoVig);
  const probGap = modelProb != null && pin != null ? Math.abs(modelProb - pin) : null;
  const modelLine = finite(row.modelProjection != null ? row.modelProjection : row.modelLine);
  const pinLine = finite(row.pinnaclePoint != null ? row.pinnaclePoint : row.pinnacleLine);
  const isTotal = /total/i.test(market);
  const isSpread = /spread/i.test(market);
  let pointGap = null;
  if (modelLine != null && pinLine != null && isTotal) pointGap = Math.abs(modelLine - pinLine);
  if (modelLine != null && pinLine != null && isSpread) pointGap = Math.abs(modelLine + pinLine);
  const pointCap = Object.prototype.hasOwnProperty.call(POINT_GAP, sport) ? POINT_GAP[sport] : null;
  const probTrip = probGap != null && probGap > PROB_GAP + 1e-9;
  const pointTrip = pointGap != null && pointCap != null && pointGap > pointCap + 1e-9;
  if (!probTrip && !pointTrip) return null;
  return {
    flagged: true,
    reason: 'pinnacle-sanity',
    sport,
    market,
    probGap: roundTo(probGap, 4),
    modelProb: roundTo(modelProb, 4),
    pinnacleNoVig: roundTo(pin, 4),
    pointGap: roundTo(pointGap, 2),
    modelLine: roundTo(modelLine, 2),
    pinnacleLine: roundTo(pinLine, 2),
    pointThreshold: pointCap,
    probThreshold: PROB_GAP,
  };
}

function flagNote(flag) {
  return [
    'dataReviewFlag',
    `probGap=${flag.probGap}`,
    `pointGap=${flag.pointGap}`,
    `modelProb=${flag.modelProb}`,
    `pinnacleNoVig=${flag.pinnacleNoVig}`,
    `modelLine=${flag.modelLine}`,
    `pinnacleLine=${flag.pinnacleLine}`,
  ].join(' ');
}

function logReviewFlags(picks, parlayLegs, audit) {
  const rows = [];
  for (const pick of picks || []) {
    if (pick && pick.dataReviewFlag) rows.push(pick);
  }
  for (const ticket of parlayLegs || []) {
    for (const leg of (ticket && ticket.legs) || []) {
      if (leg && leg.dataReviewFlag) rows.push(leg);
    }
  }
  const target = audit || currentAudit();
  for (const row of rows) {
    const note = flagNote(row.dataReviewFlag);
    console.log(`[omega-vnext] dataReviewFlag ${row.sport || ''} ${row.matchup || ''} ${row.pick || ''} ${note}`);
    if (target && typeof target.record === 'function') {
      target.record({
        kind: 'http',
        provider: 'other',
        method: 'GET',
        url: `omega://data-review/${row.sport || 'na'}/${row.betType || row.market || 'na'}`,
        status: 200,
        ok: true,
        error: null,
        note,
      });
    }
  }
  return rows.length;
}

module.exports = {
  reviewFlag,
  logReviewFlags,
  PROB_GAP,
  POINT_GAP,
};
