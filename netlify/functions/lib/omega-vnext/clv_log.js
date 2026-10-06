'use strict';

const crypto = require('crypto');
const { MODEL_VERSION } = require('./config');

function etTimestamp(d = new Date()) {
  // ISO with explicit ET offset label for logs
  const iso = d.toISOString();
  const etLabel = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return { iso, et: etLabel, timezone: 'America/New_York' };
}

function makePickId(parts) {
  const raw = [
    parts.date || '',
    parts.sport || '',
    parts.matchup || '',
    parts.side || parts.pick || '',
    parts.market || parts.betType || '',
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function parseLineFromPick(pick) {
  if (pick.line != null && Number.isFinite(Number(pick.line))) return Number(pick.line);
  const t = String(pick.pick || pick.side || '');
  const tot = t.match(/(?:over|under)\s*([\d.]+)/i);
  if (tot) return parseFloat(tot[1]);
  const sp = t.match(/([+-]\d+(?:\.\d+)?)/);
  if (sp) return parseFloat(sp[1]);
  return null;
}

function enrichBetTimeFields(p, { modelVersion = MODEL_VERSION, date = null } = {}) {
  const ts = etTimestamp();
  const side = p.pick || p.side || '';
  const market = p.betType || p.market || '';
  const line = parseLineFromPick(p);
  const pickId = p.pickId || makePickId({
    date: date || p.date,
    sport: p.sport,
    matchup: p.matchup,
    side,
    market,
  });
  const odds = p.odds;
  const book = p.book || null;
  return {
    ...p,
    pickId,
    date: date || p.date || null,
    timestamp: ts.iso,
    timestampET: ts.et,
    sport: p.sport,
    market,
    side,
    line,
    odds,
    book,
    p_model: p.p_model != null ? p.p_model : null,
    fair_sharp_p: p.fair_sharp_p != null ? p.fair_sharp_p : null,
    predictedClv: p.predictedClv != null ? p.predictedClv : null,
    modelVersion: p.modelVersion || modelVersion,
    lockSnapshot: p.lockSnapshot || {
      odds,
      line,
      book,
      capturedAt: ts.iso,
      openPrint: p.openPrint || null,
    },
    openPrint: p.openPrint || (p.lockSnapshot && p.lockSnapshot.openPrint) || null,
    steamToward: !!p.steamToward,
    steamAgainst: !!p.steamAgainst,
    predictedResidualClv: p.predictedResidualClv != null ? p.predictedResidualClv : null,
    lineMove: p.lineMove || null,
  };
}

/** Attach bet-time CLV schema fields to straights. */
function attachClvFields(picks, modelVersion = MODEL_VERSION, date = null) {
  return (picks || []).map(p => enrichBetTimeFields(p, { modelVersion, date }));
}

function attachClvToParlay(parlayLegs, modelVersion = MODEL_VERSION, date = null) {
  return (parlayLegs || []).map(pl => ({
    ...pl,
    legs: (pl.legs || []).map(leg => enrichBetTimeFields(leg, { modelVersion, date })),
  }));
}

/** Seed record shape for track-clv-omega compatibility (pick+matchup keys). */
function betTimeClvSeed(pick) {
  const enriched = enrichBetTimeFields(pick);
  return {
    pickId: enriched.pickId,
    pick: enriched.pick || enriched.side,
    matchup: enriched.matchup,
    sport: enriched.sport,
    market: enriched.market,
    side: enriched.side,
    line: enriched.line,
    odds: enriched.odds,
    book: enriched.book || null,
    commenceTime: enriched.commenceTime || '',
    modelVersion: enriched.modelVersion || MODEL_VERSION,
    p_model: enriched.p_model,
    fair_sharp_p: enriched.fair_sharp_p,
    predictedClv: enriched.predictedClv,
    date: enriched.date,
    timestamp: enriched.timestamp,
    timestampET: enriched.timestampET,
    lockSnapshot: enriched.lockSnapshot,
    openPrint: enriched.openPrint || null,
    steamToward: !!enriched.steamToward,
    steamAgainst: !!enriched.steamAgainst,
    predictedResidualClv: enriched.predictedResidualClv != null ? enriched.predictedResidualClv : null,
    capturedAt: enriched.timestamp,
  };
}

/**
 * Generate-time fields for a non-published side. Does not touch a published
 * clv-{date} row. `rejectReason` is 'yes-pool-unselected' or the stored gate reason.
 */
function candidateSideSeed(row, { date = null, rejectReason = null } = {}) {
  const side = (row && (row.side || row.pick)) || '';
  const market = (row && (row.market || row.betType)) || '';
  const edge = row && row.edge != null ? row.edge : (row && row.edgePct != null ? row.edgePct : null);
  let line = null;
  if (row && row.line != null && row.line !== '' && Number.isFinite(Number(row.line))) {
    line = Number(row.line);
  } else if (row) {
    line = parseLineFromPick({ ...row, pick: side, side, market, betType: market });
  }
  return {
    date: date || (row && row.date) || null,
    sport: (row && row.sport) || null,
    matchup: (row && row.matchup) || null,
    market,
    side,
    line,
    odds: row && row.odds != null ? row.odds : null,
    fair_sharp_p: row && row.fair_sharp_p != null ? row.fair_sharp_p : null,
    coverProb: row && row.coverProb != null ? row.coverProb : null,
    edge,
    ev: row && row.ev != null ? row.ev : null,
    rejectReason: rejectReason || (row && (row.rejectReason || row.reason)) || null,
    commenceTime: (row && row.commenceTime) || null,
    predictedClv: row && row.predictedClv != null ? row.predictedClv : null,
    uncertainty: row && row.uncertainty != null ? row.uncertainty : null,
    homeTeam: (row && row.homeTeam) || null,
    awayTeam: (row && row.awayTeam) || null,
    book: (row && row.book) || null,
  };
}

module.exports = {
  attachClvFields,
  attachClvToParlay,
  betTimeClvSeed,
  candidateSideSeed,
  enrichBetTimeFields,
  makePickId,
  etTimestamp,
  parseLineFromPick,
};
