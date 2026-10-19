'use strict';
/**
 * V1 config — governed by "The Lock — Unified Spec v2.0"
 * (NFL, NCAAF, NHL, NBA, NCAAM, MLB), plus the WeBet stake caps below.
 * Original Lock v1.0 (Mar 2026) grading bands, extended per Spec §6/§14:
 *  points sports (NBA/NCAAM + NFL/NCAAF) and low-scoring (NHL + MLB).
 *
 * Stake caps (WeBet, 1u = $150). No straight tier is above 1.5u:
 *   A+ 1.5u, A / A- / B+ 1.0u, B 0.5u.
 * Fallback fills stay 0.5u. The 3-leg parlay stays its fixed 0.5u stake.
 *
 * Heavy-favorite guard: a straight priced shorter than -250 (American
 * odds < -250; -250 itself is not shorter) cannot be graded above A-.
 * Win-probability bands treat a -425 chalk as an A+ the same way they
 * treat an 80% plus-money side, which inflates heavy favorites. Selection
 * prefers the next qualifying straight that is not shorter than -250 when
 * one exists. A heavy favorite fills a remaining straight slot only at
 * A- or lower.
 */
const MODEL_VERSION_V1 = 'v1-lock-2.0';
const ENGINE_V1 = 'v1-lock';
const SPORTS_V1 = ['NFL','NCAAF','NHL','NBA','NCAAM','MLB'];
const POINTS_SPORTS_V1 = ['NBA','NCAAM','NFL','NCAAF'];
const LOW_SPORTS_V1 = ['NHL','MLB'];
const BLOB_STORE_V1 = 'edge-picks-v1lock';
const OMEGA_BOARD_STORE = 'edge-picks-omega'; // read-only stored board (shared low-level source)
const MAX_STRAIGHT_UNITS_V1 = 1.5;
const HEAVY_FAVORITE_AMERICAN_V1 = -250;
const GRADE_RANK_V1 = { 'B':1, 'B+':2, 'A-':3, 'A':4, 'A+':5 };

function gradeForV1(sport, p) {
  if (p == null || !Number.isFinite(p)) return null;
  const low = LOW_SPORTS_V1.includes(String(sport||'').toUpperCase());
  const bands = low
    ? [['A+',0.70],['A',0.65],['A-',0.62],['B+',0.60],['B',0.58]]
    : [['A+',0.80],['A',0.75],['A-',0.70],['B+',0.65],['B',0.60]];
  for (const [g, floor] of bands) if (p >= floor) return g;
  return null;
}
function floorForV1(sport){ return LOW_SPORTS_V1.includes(String(sport||'').toUpperCase()) ? 0.58 : 0.60; }
function isHeavyFavoritePriceV1(american){
  const a = Number(american);
  return Number.isFinite(a) && a < HEAVY_FAVORITE_AMERICAN_V1;
}
function capGradeForPriceV1(grade, american){
  if (!grade || !isHeavyFavoritePriceV1(american)) return grade || null;
  if ((GRADE_RANK_V1[grade] || 0) > GRADE_RANK_V1['A-']) return 'A-';
  return grade;
}
function unitsForGradeV1(grade){
  let u = 0;
  if (grade==='A+') u = 1.5;
  else if (grade==='A'||grade==='A-'||grade==='B+') u = 1.0;
  else if (grade==='B') u = 0.5;
  if (u > MAX_STRAIGHT_UNITS_V1) u = MAX_STRAIGHT_UNITS_V1;
  return u;
}
module.exports = { MODEL_VERSION_V1, ENGINE_V1, SPORTS_V1, POINTS_SPORTS_V1, LOW_SPORTS_V1,
  BLOB_STORE_V1, OMEGA_BOARD_STORE, MAX_STRAIGHT_UNITS_V1, HEAVY_FAVORITE_AMERICAN_V1,
  gradeForV1, floorForV1, unitsForGradeV1, isHeavyFavoritePriceV1, capGradeForPriceV1 };
