'use strict';
/** V1 card endpoint: GET /api/get-picks-v1 — reads ONLY edge-picks-v1lock. */
const { readCardV1, readJsonFromStore } = require('./lib/v1-lock/store-v1');
const { BLOB_STORE_V1 } = require('./lib/v1-lock/config-v1');
const { todayET, liveTryDates, stickyTryDates, resolveCard, resolveLiveCard, hasRealPicks, isISODate } = require('./lib/omega-live-date');
const { normalizeEmptyCard } = require('./lib/no-plays');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
function emptyPayload(dateKey, message) {
  return { error: false, noPlays: message, date: dateKey, picks: [], parlayLegs: [], rejections: [],
    summary: { totalPicks: 0, totalUnits: '0u', aplusLocks: 0, sportsCovered: [] } };
}
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const params = event.queryStringParameters || {};
    const requestedDate = params.date;
    const historical = isISODate(requestedDate);
    let dates = [];
    try { const d = await readJsonFromStore(BLOB_STORE_V1, 'picks-dates'); if (Array.isArray(d)) dates.push(...d); } catch (_) {}
    try { const l = await readJsonFromStore(BLOB_STORE_V1, 'latest-date'); if (l) dates.push(String(l).trim()); } catch (_) {}
    const load = async (d) => readCardV1(d);
    const ok = (data) => ({ statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300, must-revalidate' },
      body: JSON.stringify(normalizeEmptyCard(data, 'omega')) });
    if (historical) {
      const resolved = await resolveCard(stickyTryDates(dates, requestedDate), load, { requirePicks: true });
      if (resolved && hasRealPicks(resolved.picksData)) return ok(resolved.picksData);
      if (resolved && resolved.dateKey === requestedDate) return ok(resolved.picksData);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(emptyPayload(requestedDate, `No V1 picks found for ${requestedDate}.`)) };
    }
    const resolved = await resolveLiveCard(liveTryDates(dates), load);
    if (resolved) return ok(resolved.picksData);
    return { statusCode: 200, headers: CORS, body: JSON.stringify(emptyPayload(todayET(), "Today's V1 card is generating.")) };
  } catch (err) {
    console.error('[get-picks-v1] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to fetch V1 picks' }) };
  }
};
