// get-picks-alpha.js
// API endpoint: GET /.netlify/functions/get-picks-alpha
// Returns the latest Alpha picks JSON from Netlify Blobs (alpha store).
// Optional: ?date=YYYY-MM-DD for historical picks.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Premium gate v1: these fields are WeBit-gated Sharp Depth, served only by
// get-picks-premium (session + balance validated). They were never rendered on the
// free page, so stripping them changes nothing visible — client-side hiding alone
// is forbidden per the product charter.
const PREMIUM_FIELDS = ['kellyCalc', 'kellyFraction', 'zScore'];
function stripPremium(picksData) {
  if (!picksData || !Array.isArray(picksData.picks)) return picksData;
  const clone = { ...picksData, picks: picksData.picks.map(p => {
    const pub = { ...p };
    PREMIUM_FIELDS.forEach(f => { delete pub[f]; });
    return pub;
  }) };
  return clone;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedDate = params.date;

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("edge-picks-alpha");

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
              noPlays: "No Alpha picks generated yet. Check back at 9am ET.",
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
            noPlays: `No Alpha picks found for ${dateKey}.`,
            date: dateKey, picks: [], rejections: [],
            summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(stripPremium(picksData)),
      };

    } catch (blobErr) {
      console.error("[get-picks-alpha] Blobs SDK error:", blobErr.message);

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-alpha`;
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
              return { statusCode: 200, headers: CORS, body: JSON.stringify(stripPremium(data)) };
            }
          } catch(e) {}
        }
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noPlays: "No Alpha picks available. Check back at 9am ET.",
          date: null, picks: [], rejections: [],
          summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        }),
      };
    }
  } catch (err) {
    console.error("[get-picks-alpha] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch Alpha picks" }),
    };
  }
};
