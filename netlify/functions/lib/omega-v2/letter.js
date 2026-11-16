'use strict';

/**
 * Printed edge in percentage points, rounded to the tenth the card shows.
 * "5.4%" and 0.054 both become 5.4. A percent string stays in points, so
 * "1.0%" is 1.0. toFixed rounds an exact half away from zero.
 */
function shownEdgePoints(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const points = Math.abs(raw) > 1 ? raw : raw * 100;
    return Number(points.toFixed(1));
  }
  const text = String(raw).trim();
  if (!text) return null;
  const n = parseFloat(text.replace(/[−–]/g, '-').replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  const points = /%/.test(text) || Math.abs(n) > 1 ? n : n * 100;
  return Number(points.toFixed(1));
}

/**
 * Standing letter from the printed edge tenth.
 * A+ ≥ 5.0, A ≥ 3.5, A− ≥ 2.0, else B. An exact boundary takes the higher letter.
 */
function letterFromPrintedEdge(raw) {
  const shown = shownEdgePoints(raw);
  if (shown == null) return null;
  if (shown >= 5) return 'aplus';
  if (shown >= 3.5) return 'a';
  if (shown >= 2) return 'aminus';
  return 'b';
}

/**
 * Standing letter from price EV when the blend is on the row.
 * A >= 3% EV, B >= 1% and under 3%, C under 1% (including negative).
 * An exact boundary takes the higher letter. The edge ladder does not run.
 */
function letterFromEv(raw) {
  const shown = shownEdgePoints(raw);
  if (shown == null) return null;
  if (shown >= 3) return 'a';
  if (shown >= 1) return 'b';
  return 'c';
}

/**
 * Confidence for a printed letter. C is 45. Every other letter uses the
 * frozen price map. That map has no C entry, and the price file stays unchanged.
 */
function confidenceForLetter(letter) {
  if (letter === 'c') return 45;
  const { ratingToConfidence } = require('../omega-vnext/odds_math');
  return ratingToConfidence(letter);
}

module.exports = { shownEdgePoints, letterFromPrintedEdge, letterFromEv, confidenceForLetter };
