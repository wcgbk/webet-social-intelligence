'use strict';
/**
 * GET /.netlify/functions/get-omega-clv-report
 * READ ONLY weekly / window observer for Omega realized CLV.
 * Banner: OBSERVER ONLY — no auto-steer.
 * Dates floor: 2026-09-22 (v12 KPI cutover).
 */
const {
  summarizeBySportMarket,
  etIsoWeekKey,
} = require('./lib/omega-vnext/clv_grade');
const { CLV_KPI_FLOOR, BLOB_STORE, SITE_ID } = require('./lib/omega-vnext/config');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const BANNER = 'OBSERVER ONLY — no auto-steer.';

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dateRange(from, to) {
  const dates = [];
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const floor = CLV_KPI_FLOOR || '2026-09-22';
  let from = (params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from)) ? params.from : floor;
  if (from < floor) from = floor;
  const to = (params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to)) ? params.to : todayET();
  const wantLatestWeekly = params.weekly !== '0';

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(BLOB_STORE);

    if (wantLatestWeekly && !params.from && !params.to) {
      const latest = await store.get('omega-clv-weekly-latest', { type: 'json' });
      if (latest) {
        return {
          statusCode: 200,
          headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
          body: JSON.stringify({
            ...latest,
            banner: BANNER,
            observerOnly: true,
            autoSteer: false,
            source: 'omega-clv-weekly-latest',
          }),
        };
      }
    }

    const dates = dateRange(from, to).filter(d => d >= floor);
    const allPicks = [];
    let daysWithClv = 0;
    await Promise.all(dates.map(async (d) => {
      try {
        const blob = await store.get(`clv-${d}`, { type: 'json' });
        if (!blob || !Array.isArray(blob.picks)) return;
        daysWithClv++;
        for (const p of blob.picks) allPicks.push({ ...p, date: p.date || d });
      } catch (_) { /* skip */ }
    }));

    const summary = summarizeBySportMarket(allPicks, { floorDate: floor });
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
      body: JSON.stringify({
        banner: BANNER,
        observerOnly: true,
        autoSteer: false,
        weekKey: etIsoWeekKey(),
        from,
        to,
        floorDate: floor,
        daysWithClv,
        daysRequested: dates.length,
        ...summary,
        source: 'clv-blobs-aggregate',
      }),
    };
  } catch (sdkErr) {
    // REST fallback
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || SITE_ID;
    if (!token) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          banner: BANNER,
          observerOnly: true,
          autoSteer: false,
          n: 0,
          note: 'not configured',
        }),
      };
    }
    const authHeaders = { Authorization: `Bearer ${token}` };
    const base = `https://api.netlify.com/api/v1/blobs/${siteId}/${BLOB_STORE}`;

    if (wantLatestWeekly && !params.from && !params.to) {
      try {
        const r = await fetch(`${base}/omega-clv-weekly-latest`, { headers: authHeaders });
        if (r.ok) {
          const latest = await r.json();
          return {
            statusCode: 200,
            headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
            body: JSON.stringify({ ...latest, banner: BANNER, observerOnly: true, autoSteer: false, source: 'omega-clv-weekly-latest' }),
          };
        }
      } catch (_) { /* fall through */ }
    }

    const dates = dateRange(from, to).filter(d => d >= floor);
    const allPicks = [];
    let daysWithClv = 0;
    await Promise.all(dates.map(async (d) => {
      try {
        const r = await fetch(`${base}/clv-${d}`, { headers: authHeaders });
        if (!r.ok) return;
        const blob = await r.json();
        if (!blob || !Array.isArray(blob.picks)) return;
        daysWithClv++;
        for (const p of blob.picks) allPicks.push({ ...p, date: p.date || d });
      } catch (_) { /* skip */ }
    }));
    const summary = summarizeBySportMarket(allPicks, { floorDate: floor });
    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
      body: JSON.stringify({
        banner: BANNER,
        observerOnly: true,
        autoSteer: false,
        weekKey: etIsoWeekKey(),
        from, to, floorDate: floor,
        daysWithClv,
        daysRequested: dates.length,
        ...summary,
        source: 'clv-blobs-aggregate-rest',
        sdkNote: sdkErr.message,
      }),
    };
  }
};
