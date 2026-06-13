// get-fox-picks.js
// API endpoint: GET /.netlify/functions/get-fox-picks
// Returns the latest FOX consensus picks JSON from Netlify Blobs.
// Optional query param: ?date=YYYY-MM-DD for historical picks.
// Reads from "fox-picks" blob store (completely separate from edge-picks).

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

    // Try @netlify/blobs SDK first
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("fox-picks");

      let dateKey;
      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        dateKey = requestedDate;
      } else {
        const latestDate = await store.get("latest-date");
        if (!latestDate) {
          return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify({
              error: false,
              noPlays: "No FOX picks generated yet. Check back after 10:30am EST.",
              date: null, picks: [],
              summary: { totalPicks: 0, totalUnits: "0u", unanimousPicks: 0, sportsCovered: [] },
            }),
          };
        }
        dateKey = latestDate.trim();
      }

      const picksData = await store.get(`picks-${dateKey}`, { type: "json" });
      if (!picksData) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            error: false, noPlays: `No FOX picks found for ${dateKey}.`,
            date: dateKey, picks: [],
            summary: { totalPicks: 0, totalUnits: "0u", unanimousPicks: 0, sportsCovered: [] },
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(picksData),
      };
    } catch (blobErr) {
      console.error("[get-fox-picks] Blobs SDK error:", blobErr.message);
      console.log("[get-fox-picks] Falling back to Netlify API");

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/fox-picks`;
        const authHeaders = { "Authorization": `Bearer ${token}` };

        let dateKey = requestedDate;
        if (!dateKey) {
          try {
            const latestResp = await fetch(`${baseUrl}/latest-date`, { headers: authHeaders });
            if (latestResp.ok) dateKey = (await latestResp.text()).trim();
          } catch (e) { console.error("[get-fox-picks] Latest date fetch error:", e.message); }
        }

        if (dateKey) {
          try {
            const picksResp = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
            if (picksResp.ok) {
              const data = await picksResp.json();
              return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
            }
          } catch (e) { console.error("[get-fox-picks] Picks fetch error:", e.message); }
        }
      }

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          error: false, noPlays: "No FOX picks generated yet. Check back after 10:30am EST.",
          date: null, picks: [],
          summary: { totalPicks: 0, totalUnits: "0u", unanimousPicks: 0, sportsCovered: [] },
        }),
      };
    }
  } catch (err) {
    console.error("[get-fox-picks] Error:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: "Failed to fetch FOX picks" }) };
  }
};
