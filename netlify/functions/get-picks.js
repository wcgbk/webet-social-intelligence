// get-picks.js
// API endpoint: GET /.netlify/functions/get-picks
// Returns the latest picks JSON from Netlify Blobs.
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

    // Try to use @netlify/blobs if available
    let latestDate, picksData;

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("edge-picks");

      let dateKey;
      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        dateKey = requestedDate;
      } else {
        latestDate = await store.get("latest-date");
        if (!latestDate) {
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
              error: false,
              noPlays: "No picks generated yet. Check back at 10am EST.",
              date: null,
              picks: [],
              rejections: [],
              summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
            }),
          };
        }
        dateKey = latestDate.trim();
      }

      picksData = await store.get(`picks-${dateKey}`, { type: "json" });

      if (!picksData) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            error: false,
            noPlays: `No picks found for ${dateKey}.`,
            date: dateKey,
            picks: [],
            rejections: [],
            summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(picksData),
      };
    } catch (blobErr) {
      console.error("[get-picks] Blobs SDK error:", blobErr.message);
      console.log("[get-picks] Falling back to Netlify API");

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks`;
        const authHeaders = { "Authorization": `Bearer ${token}` };

        let dateKey = requestedDate;
        if (!dateKey) {
          try {
            const latestResp = await fetch(`${baseUrl}/latest-date`, { headers: authHeaders });
            if (latestResp.ok) {
              dateKey = (await latestResp.text()).trim();
            }
          } catch (e) {
            console.error("[get-picks] Latest date fetch error:", e.message);
          }
        }

        if (dateKey) {
          try {
            const picksResp = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
            if (picksResp.ok) {
              const data = await picksResp.json();
              return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
            }
          } catch (e) {
            console.error("[get-picks] Picks fetch error:", e.message);
          }
        }
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noPlays: "No picks generated yet. Check back at 10am EST.",
          date: null,
          picks: [],
          rejections: [],
          summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        }),
      };
    }
  } catch (err) {
    console.error("[get-picks] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch picks" }),
    };
  }
};
