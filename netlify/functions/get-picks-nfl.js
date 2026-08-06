// get-picks-nfl.js
// API endpoint: GET /api/get-picks-nfl
// Returns the latest NFL picks JSON from Netlify Blobs (edge-picks-nfl store — the NFL
// model's own environment, fully separate from alpha).
// Optional: ?date=YYYY-MM-DD for historical picks.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Same server-side depth policy as alpha: these fields are never rendered on the free page.
const PREMIUM_FIELDS = ['kellyCalc', 'kellyFraction', 'zScore'];
function stripPremium(picksData) {
  if (!picksData || !Array.isArray(picksData.picks)) return picksData;
  return { ...picksData, picks: picksData.picks.map(p => {
    const pub = { ...p };
    PREMIUM_FIELDS.forEach(f => { delete pub[f]; });
    return pub;
  }) };
}

const EMPTY = {
  error: false,
  noPlays: "No NFL picks yet. Cards generate on NFL game days at 11am ET.",
  date: null, picks: [], rejections: [],
  summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
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
      const store = getStore("edge-picks-nfl");

      let dateKey;
      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        dateKey = requestedDate;
      } else {
        const latestDate = await store.get("latest-date");
        if (!latestDate) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY) };
        }
        dateKey = latestDate.trim();
      }

      const picksData = await store.get(`picks-${dateKey}`, { type: "json" });
      if (!picksData) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ ...EMPTY, noPlays: `No NFL picks found for ${dateKey}.`, date: dateKey }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(stripPremium(picksData)),
      };

    } catch (blobErr) {
      console.error("[get-picks-nfl] Blobs SDK error:", blobErr.message);

      // REST fallback — SDK store reads can return null in the fn runtime (known alpha gotcha)
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-nfl`;
        const authHeaders = { "Authorization": `Bearer ${token}` };
        let dateKey = requestedDate;
        if (!dateKey) {
          try {
            const lr = await fetch(`${baseUrl}/latest-date`, { headers: authHeaders });
            if (lr.ok) dateKey = (await lr.text()).trim();
          } catch (e) {}
        }
        if (dateKey) {
          try {
            const pr = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
            if (pr.ok) {
              const data = await pr.json();
              return { statusCode: 200, headers: CORS, body: JSON.stringify(stripPremium(data)) };
            }
          } catch (e) {}
        }
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY) };
    }
  } catch (err) {
    console.error("[get-picks-nfl] Error:", err.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch NFL picks" }),
    };
  }
};
