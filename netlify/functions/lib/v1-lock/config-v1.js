'use strict';
/**
 * V1 config — governed ONLY by "The Lock — Unified Spec v2.0"
 * (NFL, NCAAF, NHL, NBA, NCAAM, MLB). No other rule source.
 * Original Lock v1.0 (Mar 2026) grading bands, extended per Spec §6/§14:
 *  points sports (NBA/NCAAM + NFL/NCAAF) and low-scoring (NHL + MLB).
 */
const MODEL_VERSION_V1 = 'v1-lock-2.0';
const ENGINE_V1 = 'v1-lock';
const SPORTS_V1 = ['NFL','NCAAF','NHL','NBA','NCAAM','MLB'];
const POINTS_SPORTS_V1 = ['NBA','NCAAM','NFL','NCAAF'];
const LOW_SPORTS_V1 = ['NHL','MLB'];
const BLOB_STORE_V1 = 'edge-picks-v1lock';
const OMEGA_BOARD_STORE = 'edge-picks-omega'; // read-only stored board (shared low-level source)

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
function unitsForGradeV1(grade){
  if (grade==='A+') return 2.0;
  if (grade==='A'||grade==='A-'||grade==='B+') return 1.0;
  if (grade==='B') return 0.5;
  return 0;
}
module.exports = { MODEL_VERSION_V1, ENGINE_V1, SPORTS_V1, POINTS_SPORTS_V1, LOW_SPORTS_V1,
  BLOB_STORE_V1, OMEGA_BOARD_STORE, gradeForV1, floorForV1, unitsForGradeV1 };
