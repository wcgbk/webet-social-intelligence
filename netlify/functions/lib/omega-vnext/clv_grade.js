'use strict';

/**
 * Realized CLV grade helpers (pure, no network).
 * CLV = noVig(close) − noVig(bet); positive ⇒ beat the close.
 */

function americanToImplied(american) {
  const a = parseInt(american, 10);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

/**
 * @param {number|string} betAmerican
 * @param {number|string} closeAmerican
 * @param {number} overround - market sum of raw implied (e.g. 1.045)
 * @returns {{ clv, clvCents, clvPct, beatClose, pickTimeNoVig, closingNoVig }|null}
 */
function gradeNoVigClv(betAmerican, closeAmerican, overround) {
  const betRaw = americanToImplied(betAmerican);
  const closeRaw = americanToImplied(closeAmerican);
  const ov = Number(overround);
  if (betRaw == null || closeRaw == null || !Number.isFinite(ov) || ov <= 0) return null;
  const pickTimeNoVig = +(betRaw / ov).toFixed(4);
  const closingNoVig = +(closeRaw / ov).toFixed(4);
  const clv = +(closingNoVig - pickTimeNoVig).toFixed(4);
  return {
    clv,
    clvCents: +(clv * 100).toFixed(2),
    clvPct: +(clv * 100).toFixed(4),
    beatClose: clv > 0,
    pickTimeNoVig,
    closingNoVig,
  };
}

/** Attach realized-close aliases onto an existing track-clv record (mutates + returns). */
function attachRealizedAliases(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (rec.beatClosing != null && rec.beatClose == null) rec.beatClose = rec.beatClosing;
  if (rec.beatClose != null && rec.beatClosing == null) rec.beatClosing = rec.beatClose;
  if (rec.clv != null && Number.isFinite(rec.clv)) {
    if (rec.clvCents == null) rec.clvCents = +(rec.clv * 100).toFixed(2);
    if (rec.clvPct == null) rec.clvPct = +(rec.clv * 100).toFixed(4);
    if (rec.realizedClvCents == null) rec.realizedClvCents = rec.clvCents;
  }
  if (rec.closeSnapshotAt && !rec.realizedCloseAt) rec.realizedCloseAt = rec.closeSnapshotAt;
  if (rec.anchorBook && !rec.closeBook) rec.closeBook = rec.anchorBook;
  return rec;
}

/**
 * Summarize CLV rows by sport + market (observer artifact).
 * @param {Array} picks - CLV pick records with clv / beatClose
 */
function summarizeBySportMarket(picks, { floorDate = '2026-09-22' } = {}) {
  const bySport = {};
  const byMarket = {};
  let n = 0;
  let clvSum = 0;
  let beats = 0;
  for (const p of picks || []) {
    if (p.date && p.date < floorDate) continue;
    const cents = typeof p.clvCents === 'number' ? p.clvCents
      : (typeof p.realizedClvCents === 'number' ? p.realizedClvCents
        : (typeof p.clv === 'number' ? +(p.clv * 100).toFixed(2) : null));
    if (cents == null || !Number.isFinite(cents)) continue;
    const beat = p.beatClose === true || p.beatClosing === true;
    n++;
    clvSum += cents;
    if (beat) beats++;
    const s = p.sport || 'unknown';
    const m = p.market || p.betType || 'unknown';
    if (!bySport[s]) bySport[s] = { n: 0, clvSum: 0, beats: 0 };
    bySport[s].n++; bySport[s].clvSum += cents; if (beat) bySport[s].beats++;
    if (!byMarket[m]) byMarket[m] = { n: 0, clvSum: 0, beats: 0 };
    byMarket[m].n++; byMarket[m].clvSum += cents; if (beat) byMarket[m].beats++;
  }
  const finalize = (bucket) => {
    const out = {};
    for (const [k, v] of Object.entries(bucket)) {
      out[k] = {
        n: v.n,
        meanClvCents: v.n ? +((v.clvSum / v.n).toFixed(2)) : null,
        meanClvPct: v.n ? +((v.clvSum / v.n).toFixed(2)) : null,
        beatClosePct: v.n ? +((v.beats / v.n) * 100).toFixed(1) : null,
      };
    }
    return out;
  };
  return {
    n,
    meanClvCents: n ? +((clvSum / n).toFixed(2)) : null,
    meanClvPct: n ? +((clvSum / n).toFixed(2)) : null,
    beatClosePct: n ? +((beats / n) * 100).toFixed(1) : null,
    bySport: finalize(bySport),
    byMarket: finalize(byMarket),
  };
}

/** ISO week key America/New_York: YYYY-Www */
function etIsoWeekKey(d = new Date()) {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay() || 7;
  et.setDate(et.getDate() + 4 - day);
  const yearStart = new Date(et.getFullYear(), 0, 1);
  const week = Math.ceil((((et - yearStart) / 86400000) + 1) / 7);
  return `${et.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isSundayET(d = new Date()) {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getDay() === 0;
}

module.exports = {
  americanToImplied,
  gradeNoVigClv,
  attachRealizedAliases,
  summarizeBySportMarket,
  etIsoWeekKey,
  isSundayET,
};
