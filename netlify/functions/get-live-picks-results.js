// get-live-picks-results.js
// API for the /live-picks Track Record: GET /api/live-picks-results?key=<LIVE_PICKS_KEY>
// Aggregates every day's card in the `live-picks` store into per-day W/L/P + units summaries
// (newest first) plus a cumulative running total. Same server-side gate as the reader.
// Storage: Netlify Blobs REST API (SDK unavailable on git deploys — see live-ingest.js).

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/live-picks`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=30, s-maxage=30',
};

function summarize(selections) {
  let w = 0, l = 0, p = 0, units = 0, graded = 0, staked = 0;
  (selections || []).forEach((s) => {
    const r = String(s.finalWL || s.result || '').toUpperCase();
    const u = Number(s.units) || 0;
    if (r === 'W' || r === 'WIN') { w++; units += u; graded++; staked += u; }
    else if (r === 'L' || r === 'LOSS' || r === 'LOSE') { l++; units -= u; graded++; staked += u; }
    else if (r === 'P' || r === 'PUSH') { p++; graded++; staked += u; }
  });
  return { w, l, p, units: Math.round(units * 100) / 100, staked: Math.round(staked * 100) / 100, graded, count: (selections || []).length };
}

function etToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et;
}

// Prefer the store's key listing; fall back to walking backward from today.
async function listDates(authHeaders) {
  try {
    const r = await fetch(`${STORE_URL}`, { headers: authHeaders });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const blobs = (j && (j.blobs || j.keys)) || [];
      const dates = blobs
        .map((b) => (typeof b === 'string' ? b : (b && b.key) || ''))
        .filter((k) => /^picks-\d{4}-\d{2}-\d{2}$/.test(k))
        .map((k) => k.replace('picks-', ''));
      if (dates.length) return dates;
    }
  } catch (e) { /* fall through */ }
  const dates = [];
  const et = etToday();
  for (let i = 0; i < 90; i++) {
    const d = new Date(et);
    d.setDate(d.getDate() - i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return dates;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const gate = process.env.LIVE_PICKS_KEY || process.env.PICKS_SECRET_KEY;
  if (!gate) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, message: 'Not configured' }) };
  if (params.key !== gate) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Storage not configured' }) };
  const authHeaders = { 'Authorization': `Bearer ${token}` };

  try {
    const dates = await listDates(authHeaders);
    const rows = await Promise.all(dates.map(async (date) => {
      const r = await fetch(`${STORE_URL}/picks-${date}`, { headers: authHeaders });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      if (!data || !Array.isArray(data.selections) || !data.selections.length) return null;
      return Object.assign({ date }, summarize(data.selections));
    }));

    const days = rows.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
    const cumulative = days.reduce((acc, d) => ({
      w: acc.w + d.w, l: acc.l + d.l, p: acc.p + d.p,
      units: Math.round((acc.units + d.units) * 100) / 100,
      staked: Math.round((acc.staked + (d.staked || 0)) * 100) / 100,
      graded: acc.graded + d.graded, count: acc.count + d.count,
    }), { w: 0, l: 0, p: 0, units: 0, staked: 0, graded: 0, count: 0 });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: false, days, cumulative }) };
  } catch (err) {
    console.error('[get-live-picks-results] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to build results' }) };
  }
};
