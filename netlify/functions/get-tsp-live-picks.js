// get-tsp-live-picks.js
// API for the PRIVATE /tsp-live page: GET /api/tsp-live-picks?key=<TSP_LIVE_KEY>[&date=YYYY-MM-DD]
// Serves the TSP.Live Hermes card pushed by the Grok Bot into the `tsp-live-picks` store.
//
// HARD-GATED server-side: without the correct key the data never leaves the function (401).
// There is NO public mode — TSP.Live is paid membership content, private to Ben's own use.
// Storage: Netlify Blobs REST API (SDK unavailable on git deploys of this site — see tsp-ingest.js).

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/tsp-live-picks`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function formatDateLong(dateISO) {
  return new Date(dateISO + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const gate = process.env.TSP_LIVE_KEY || process.env.TSP_PAGE_KEY;
  if (!gate) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, status: 'NOT_CONFIGURED', message: 'TSP_LIVE_KEY env var is not set.' }) };
  }
  if (params.key !== gate) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };
  }

  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Storage not configured' }) };
  }
  const authHeaders = { 'Authorization': `Bearer ${token}` };

  async function readDay(dk) {
    const r = await fetch(`${STORE_URL}/picks-${dk}`, { headers: authHeaders });
    if (r.ok) return await r.json().catch(() => null);
    return null;
  }

  try {
    const requested = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : null;
    let dateKey = requested || getEasternDateToday();

    let data = await readDay(dateKey);
    let latestDate = null;

    // If today is empty, fall back to the most recent day the bot pushed.
    if (!data && !requested) {
      const lr = await fetch(`${STORE_URL}/latest-date`, { headers: authHeaders });
      if (lr.ok) {
        const l = (await lr.text()).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(l)) {
          latestDate = l;
          if (l !== dateKey) {
            const d2 = await readDay(l);
            if (d2) { data = d2; dateKey = l; }
          }
        }
      }
    }

    const selections = (data && Array.isArray(data.selections)) ? data.selections : [];

    // Graded record from finalWL (null = still open).
    let w = 0, l = 0, p = 0, units = 0;
    selections.forEach((s) => {
      const res = String(s.finalWL || s.result || '').toUpperCase();
      const u = Number(s.units) || 0;
      if (res === 'W' || res === 'WIN') { w++; units += u; }
      else if (res === 'L' || res === 'LOSS' || res === 'LOSE') { l++; units -= u; }
      else if (res === 'P' || res === 'PUSH') { p++; }
    });

    return {
      statusCode: 200, headers: CORS, body: JSON.stringify({
        error: false,
        date: dateKey,
        dateFormatted: formatDateLong(dateKey),
        source: (data && data.source) || 'TSP.Live · Hermes A.I.',
        fetchedAt: (data && (data.fetchedAt || data.receivedAt)) || null,
        unitSize: (data && data.unitSize) || null,
        selections,
        count: selections.length,
        record: { w, l, p, units: Math.round(units * 100) / 100, graded: w + l + p },
        latestDate,
      }),
    };
  } catch (err) {
    console.error('[get-tsp-live-picks] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to fetch TSP live card' }) };
  }
};
