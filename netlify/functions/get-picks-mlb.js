// get-picks-mlb.js
// API endpoint: GET /.netlify/functions/get-picks-mlb
// Returns the latest MLB F5 picks JSON from Netlify Blobs (mlb store).
// Optional query param: ?date=YYYY-MM-DD for historical picks.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedDate = params.date;

    let picksData;

    // Resolve latest-date via API first (durable, site-level), SDK as fallback
    // SDK blobs reset on each deploy, so API is the authoritative source for latest-date
    async function resolveLatestDate() {
      // Try API first (site-level, survives deploys)
      try {
        const token = process.env.NETLIFY_AUTH_TOKEN;
        const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
        if (token) {
          const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb/latest-date`, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          if (resp.ok) { const d = (await resp.text()).trim().replace(/^"|"$/g, ''); if (d) return d; }
        }
      } catch (e) { /* fall through */ }
      // Fallback to SDK (deploy-scoped)
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("edge-picks-mlb");
        const latest = await store.get("latest-date");
        if (latest) return latest.trim();
      } catch (e) { /* fall through */ }
      return null;
    }

    async function readPicks(dateKey) {
      // Try SDK first for picks data (faster)
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("edge-picks-mlb");
        const data = await store.get(`picks-${dateKey}`, { type: "json" });
        if (data) return data;
      } catch (e) { /* fall through */ }
      // Fallback to API
      try {
        const token = process.env.NETLIFY_AUTH_TOKEN;
        const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
        if (token) {
          const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb/picks-${dateKey}`, {
            headers: { "Authorization": `Bearer ${token}` }
          });
          if (resp.ok) return await resp.json();
        }
      } catch (e) { console.error("[get-picks-mlb] API read error:", e.message); }
      return null;
    }

    const dateKey = (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) ? requestedDate : await resolveLatestDate();

    picksData = dateKey ? await readPicks(dateKey) : null;

    if (picksData) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(picksData),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        error: false,
        noPlays: "No MLB F5 picks generated yet. Check back after 10am EST.",
        date: null,
        picks: [],
        rejections: [],
        summary: { totalPicks: 0, totalUnits: "0u", sportsCovered: ["MLB"] },
      }),
    };
  } catch (err) {
    console.error("[get-picks-mlb] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch MLB picks" }),
    };
  }
};
