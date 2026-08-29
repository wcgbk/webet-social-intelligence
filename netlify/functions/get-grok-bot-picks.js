// get-grok-bot-picks.js
// API endpoint: GET /api/grok-bot-picks
// Returns today's Grok bot picks from the `grok-bot-picks` store (day-keyed, ET).
// Short cache (10s) so the /grokbot page stays live. Optional ?date=YYYY-MM-DD.
// When today is empty, includes latestDate so the page can say when the bot last posted.
// Storage: Netlify Blobs REST API (SDK unavailable on git deploys of this site — see
// grok-bot-webhook.js).

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/grok-bot-picks`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=10, s-maxage=10',
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedDate = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : null;
    const today = getEasternDateToday();
    const dateKey = requestedDate || today;

    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Storage not configured' }) };
    }
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    let data = null;
    const resp = await fetch(`${STORE_URL}/picks-${dateKey}`, { headers: authHeaders });
    if (resp.ok) data = await resp.json().catch(() => null);

    const payload = {
      error: false,
      date: dateKey,
      dateFormatted: formatDateLong(dateKey),
      picks: (data && Array.isArray(data.picks)) ? data.picks : [],
      updatedAt: (data && data.updatedAt) || null,
    };
    payload.count = payload.picks.length;

    if (!payload.count && !requestedDate) {
      const latestResp = await fetch(`${STORE_URL}/latest-date`, { headers: authHeaders });
      if (latestResp.ok) {
        const latest = (await latestResp.text()).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(latest)) payload.latestDate = latest;
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(payload) };
  } catch (err) {
    console.error('[get-grok-bot-picks] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to fetch Grok bot picks' }) };
  }
};
