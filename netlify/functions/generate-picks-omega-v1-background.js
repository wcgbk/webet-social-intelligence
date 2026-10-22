'use strict';
/**
 * Omega V1 A/B duplicate generator (sharp-desk fixes). Separate env.
 * Reads Omega's stored card picks-{date} READ-ONLY (same projections, same
 * 3 AM/10 AM odds-master board, no Odds API call). Writes edge-picks-omega-v1ab only.
 * Never writes edge-picks-omega, edge-picks-v1lock, or any live Omega key.
 */
const S = require('./lib/omega-v1ab/sharp');

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}
async function stores() {
  const { getStore } = await import('@netlify/blobs');
  return { omega: getStore('edge-picks-omega'), ab: getStore(S.V1AB_STORE) };
}

async function buildCard(omegaCard, { dateISO, nowMs = Date.now() } = {}) {
  const pool = (omegaCard && omegaCard.parlayPool) || [];
  const sel = S.selectSharp(pool, { nowMs });
  const omegaPicks = (omegaCard && omegaCard.picks) || [];
  const picks = sel.picks.map(p => {
    const twin = omegaPicks.find(o => o.matchup === p.matchup && o.pick === p.pick);
    return { ...p, coreReasoning: twin && twin.coreReasoning ? twin.coreReasoning : p.modelEdge, alsoOnOmega: !!twin };
  });
  const parlayLegs = S.buildParlay(picks);
  const label = S.shortCardLabel(picks.length);
  const units = picks.reduce((s, p) => s + p.unitsNum, 0) + (parlayLegs.length ? S.SHARP.parlayUnits : 0);
  return {
    date: dateISO,
    dateFormatted: omegaCard && omegaCard.dateFormatted,
    model: S.V1AB_MODEL_VERSION,
    environment: 'omega-v1ab',
    baseModel: omegaCard && omegaCard.model,
    picks,
    parlayLegs,
    noPlays: picks.length ? null : label,
    shortCard: label,
    edgeSummary: label || `${picks.length} picks cleared every sharp minimum.`,
    summary: { totalPicks: picks.length, totalUnits: `${units}u`, sportsCovered: [...new Set(picks.map(p => p.sport))] },
    sharpConfig: S.SHARP,
    sharpQualified: sel.qualified.map(x => ({ rank: x.sharpRank, matchup: x.matchup, side: x.side, odds: x.odds, book: x.book, pSharp: x.pSharp, fair: x.fair, calEdge: x.calEdge, ev: x.evSharp })),
    rejections: sel.rejected.map(x => ({ matchup: x.matchup, side: x.side, market: x.market, odds: x.odds, reason: x.reason })),
    poolSize: pool.length,
    sourceKey: `edge-picks-omega/picks-${dateISO}`,
    sourceGeneratedAt: omegaCard && omegaCard.generatedAt,
    generatedAt: new Date(nowMs).toISOString(),
    kpiStart: S.V1AB_KPI_START,
  };
}

exports.handler = async (event) => {
  let body = {};
  try { body = event && event.body ? JSON.parse(event.body) : {}; } catch (_) {}
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = body.date || qs.date || todayET();
  const dryRun = !!(body.dryRun || qs.dryRun === 'true');
  try {
    const { omega, ab } = await stores();
    const omegaCard = await omega.get(`picks-${dateISO}`, { type: 'json' });
    if (!omegaCard || !Array.isArray(omegaCard.parlayPool)) {
      return { statusCode: 503, body: JSON.stringify({ ok: false, error: `Omega card picks-${dateISO} not ready` }) };
    }
    const nowMs = body.asOf ? Date.parse(body.asOf) : Date.now();
    const card = await buildCard(omegaCard, { dateISO, nowMs });
    if (!dryRun) {
      await ab.setJSON(`picks-${dateISO}`, card);
      await ab.set('latest-date', dateISO);
      let dates = (await ab.get('picks-dates', { type: 'json' })) || [];
      if (!dates.includes(dateISO)) { dates.push(dateISO); dates.sort(); await ab.setJSON('picks-dates', dates); }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun, date: dateISO, picks: card.picks.length, parlay: card.parlayLegs.length }) };
  } catch (e) {
    console.error(`[omega-v1ab] ${e.message}`);
    return { statusCode: 500, body: e.message };
  }
};
module.exports.buildCard = buildCard;
