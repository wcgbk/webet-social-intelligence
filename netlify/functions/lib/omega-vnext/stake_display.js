'use strict';

/**
 * Summary stake display removed from odds_math.js in 61b9152.
 * Semantics from d9d53c6. odds_math.js stays frozen.
 * Whole dollars round up per stake, then those dollars sum.
 */
const { UNIT_DOLLARS } = require('./config');

function wholeUpNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const up = Math.ceil(x - 1e-9);
  return Object.is(up, -0) ? 0 : up;
}

function parseStakeUnits(units) {
  if (units == null || units === '') return null;
  const n = parseFloat(String(units).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Whole dollars at risk. 0.75u is $113. 0.25u is $38. */
function stakeDollars(units) {
  const n = typeof units === 'number' && Number.isFinite(units) ? units : parseStakeUnits(units);
  if (n == null) return 0;
  return wholeUpNumber(n * UNIT_DOLLARS);
}

/** Profit if the stake wins, rounded up to a whole dollar. Risk is already ceiled. */
function toWinDollars(units, american) {
  const risk = stakeDollars(units);
  if (!risk) return 0;
  const a = Number(String(american == null ? '' : american).replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(a) || a === 0) return 0;
  const profit = a > 0 ? risk * (a / 100) : risk * (100 / Math.abs(a));
  return wholeUpNumber(profit);
}

function isPublishedParlay(pl) {
  if (!pl || typeof pl !== 'object') return false;
  if (pl.qualifying === false) return false;
  if (pl.status === 'no qualifying parlay') return false;
  if (pl.type === 'no-qualifying-parlay') return false;
  return true;
}

/**
 * Summary display. Real unit stakes are summed and the parlay counts once.
 * Each stake's dollars round up on their own, then those dollars sum.
 * pick.units is left as the real stake.
 */
function summaryStakeDisplay(picks, parlayLegs) {
  let units = 0;
  let dollars = 0;
  const add = (raw) => {
    const n = parseStakeUnits(raw);
    if (n == null) return;
    units += n;
    dollars += stakeDollars(n);
  };
  for (const p of picks || []) add(p && p.units);
  const legs = (parlayLegs || []).filter(isPublishedParlay);
  if (legs.length) {
    const n = legs.map(l => parseStakeUnits(l.units)).find(v => v != null);
    if (n != null) add(n);
  }
  units = Math.round(units * 100) / 100;
  return { units, dollars, totalUnits: `${units}u`, totalDollars: dollars };
}

function writeSummaryStakeDisplay(summary, picks, parlayLegs) {
  if (!summary || typeof summary !== 'object') return null;
  const shown = summaryStakeDisplay(picks, parlayLegs);
  summary.totalUnits = shown.totalUnits;
  summary.totalDollars = shown.totalDollars;
  return shown;
}

module.exports = {
  wholeUpNumber,
  parseStakeUnits,
  stakeDollars,
  toWinDollars,
  summaryStakeDisplay,
  writeSummaryStakeDisplay,
};
