// get-picks-alpha-sim.js
// Returns the latest simulation picks (hindsight-free historical runs).
// Reads from picks-sim-{date} keys — never touches production picks.
// Usage: GET /api/get-picks-alpha-sim?date=2026-05-31

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
    const dateKey = params.date || new Date().toISOString().slice(0, 10);

    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha`;

    if (token) {
      const resp = await fetch(`${storeUrl}/picks-sim-${dateKey}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
      }
    }

    // Fallback: @netlify/blobs
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("edge-picks-alpha");
      const data = await store.get(`picks-sim-${dateKey}`, { type: "json" });
      if (data) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
      }
    } catch (e) {}

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        noPlays: `No simulation found for ${dateKey}. Run a simulation first via /api/run-picks-alpha with snapshotTime.`,
        date: dateKey, picks: [],
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
