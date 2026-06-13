// get-picks-v2.js
// API endpoint: GET /.netlify/functions/get-picks-v2
// Returns optimized v2 picks from the "edge-picks-v2" blob store.

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

    const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN;

    if (!token) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noPlays: "V2 picks not configured yet.",
          date: null, picks: [], rejections: [],
          summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        }),
      };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-v2`;
    const authHeaders = { "Authorization": `Bearer ${token}` };

    let dateKey = requestedDate;
    if (!dateKey) {
      try {
        const latestResp = await fetch(`${storeUrl}/latest-date`, { headers: authHeaders });
        if (latestResp.ok) {
          dateKey = (await latestResp.text()).trim();
        }
      } catch (e) { /* nothing */ }
    }

    if (!dateKey) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noPlays: "No v2 picks generated yet. Trigger generation first.",
          date: null, picks: [], rejections: [],
          summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        }),
      };
    }

    try {
      const picksResp = await fetch(`${storeUrl}/picks-${dateKey}`, { headers: authHeaders });
      if (picksResp.ok) {
        const data = await picksResp.json();
        return {
          statusCode: 200,
          headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
          body: JSON.stringify(data),
        };
      }
    } catch (e) { /* fall through */ }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        error: false,
        noPlays: `No v2 picks found for ${dateKey}.`,
        date: dateKey, picks: [], rejections: [],
        summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
      }),
    };
  } catch (err) {
    console.error("[get-picks-v2] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch v2 picks" }),
    };
  }
};
