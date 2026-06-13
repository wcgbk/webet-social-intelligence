// get-picks-mvp.js
// API endpoint: GET /.netlify/functions/get-picks-mvp
// Returns the latest MVP picks JSON from Netlify Blobs (mvp store).
// Optional: ?date=YYYY-MM-DD for historical picks.

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

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("edge-picks-mvp");

      let dateKey;
      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        dateKey = requestedDate;
      } else {
        const latestDate = await store.get("latest-date");
        if (!latestDate) {
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
              error: false,
              noPlays: "No MVP picks generated yet. Check back at 8am ET.",
              date: null, picks: [], rejections: [],
              summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
            }),
          };
        }
        dateKey = latestDate.trim();
      }

      const picksData = await store.get(`picks-${dateKey}`, { type: "json" });

      if (!picksData) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            error: false,
            noPlays: `No MVP picks found for ${dateKey}.`,
            date: dateKey, picks: [], rejections: [],
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
      console.error("[get-picks-mvp] Blobs SDK error:", blobErr.message);

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mvp`;
        const authHeaders = { "Authorization": `Bearer ${token}` };

        let dateKey = requestedDate;
        if (!dateKey) {
          try {
            const lr = await fetch(`${baseUrl}/latest-date`, { headers: authHeaders });
            if (lr.ok) dateKey = (await lr.text()).trim();
          } catch(e) {}
        }

        if (dateKey) {
          try {
            const pr = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
            if (pr.ok) {
              const data = await pr.json();
              return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
            }
          } catch(e) {}
        }
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noPlays: "No MVP picks available. Check back at 8am ET.",
          date: null, picks: [], rejections: [],
          summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        }),
      };
    }
  } catch (err) {
    console.error("[get-picks-mvp] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch MVP picks" }),
    };
  }
};
