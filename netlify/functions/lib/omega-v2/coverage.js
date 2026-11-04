'use strict';

/**
 * Pre-publish sport coverage for the five model sports.
 * Logs board / candidate counts and the mean (pCal - Pinnacle no-vig).
 * Auto-corrects and still publishes:
 *   - a fitted map on a sport under its sample floor is dropped back to
 *     the sharp-anchored shrink (pShrink)
 *   - a slate of 3+ scored rows whose mean gap vs no-vig is past 10pp
 *     is re-scored at k = 1 (full sharp anchor)
 * One fat row is left to the per-bet 10pp screen. A prior-shrink edge
 * inside that screen is a bet, not a calibration failure.
 * A sport with no board is recorded and is not a failure.
 */

const { MODEL_SPORTS, MIN_SPORT } = require('./constants');

/** Mean |pCal - no-vig| on a real slate that falls back to k = 1. */
const BIAS_LIMIT = 0.10;
/** One or two rows are the per-bet screen. A sport correction needs a slate. */
const MIN_SLATE = 3;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function countOf(map, sport) {
  if (!map || typeof map !== 'object') return 0;
  const n = num(map[sport]);
  return n == null ? 0 : n;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Mutates calibration on `prepared` when a sport must fall back.
 * Returns the report to store on the card. Does not drop the publish.
 */
function applySportCoverage(prepared, stageCounts) {
  const stages = stageCounts || {};
  const rows = [];
  const corrected = [];
  for (const sport of MODEL_SPORTS) {
    const mine = (prepared || []).filter((c) => String(c.sport || '').toUpperCase() === sport);
    const biases = [];
    for (const cand of mine) {
      const cal = cand.calibration;
      if (!cal) continue;
      const pCal = num(cal.pCal);
      const pMkt = num(cal.pMkt);
      if (pCal != null && pMkt != null) biases.push(pCal - pMkt);
    }
    const meanBias = mean(biases);
    let action = 'none';
    const board = countOf(stages.board, sport);
    const raw = countOf(stages.raw, sport);
    const leakedMap = mine.some((cand) => {
      const cal = cand.calibration;
      if (!cal || !cal.mapApplied) return false;
      const floor = num(cal.sportFloor);
      const trainN = num(cal.trainN);
      return trainN == null || trainN < (floor == null ? MIN_SPORT : floor);
    });
    const slateBlowout = mine.length >= MIN_SLATE && meanBias != null && Math.abs(meanBias) > BIAS_LIMIT;
    if (board === 0 && raw === 0 && mine.length === 0) action = 'no-board';
    else if (mine.length === 0) action = 'no-score';
    else if (leakedMap || slateBlowout) {
      action = 'sharp-anchor';
      corrected.push(sport);
      for (const cand of mine) {
        const cal = cand.calibration;
        if (!cal || num(cal.pMkt) == null) continue;
        const pMkt = num(cal.pMkt);
        const pShrink = num(cal.pShrink);
        // A leaked map falls back to the shrink. A slate already past 10pp
        // after the shrink goes all the way to the no-vig number.
        const anchor = slateBlowout || pShrink == null ? pMkt : pShrink;
        cand.calibration = {
          ...cal,
          pCal: anchor,
          shrinkK: anchor === pMkt ? 1 : cal.shrinkK,
          method: 'sharp-anchor',
          mapApplied: false,
          corrected: true,
        };
      }
    }
    const after = mine
      .map((c) => (c.calibration ? num(c.calibration.pCal) - num(c.calibration.pMkt) : null))
      .filter((v) => v != null && Number.isFinite(v));
    rows.push({
      sport,
      board,
      raw,
      afterMiscal: countOf(stages.afterMiscal, sport),
      gated: countOf(stages.gated, sport),
      scored: mine.length,
      meanBias,
      meanBiasAfter: mean(after),
      action,
    });
  }
  return {
    sports: MODEL_SPORTS.slice(),
    biasLimit: BIAS_LIMIT,
    corrected,
    rows,
  };
}

function stampQualified(report, annotated) {
  if (!report || !Array.isArray(report.rows)) return report;
  for (const row of report.rows) {
    row.qualified = (annotated || []).filter((c) => (
      String(c.sport || '').toUpperCase() === row.sport && (c.qualified || c.parlayQualified)
    )).length;
  }
  return report;
}

module.exports = {
  BIAS_LIMIT,
  MIN_SLATE,
  applySportCoverage,
  stampQualified,
};
