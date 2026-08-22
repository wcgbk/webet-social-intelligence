// get-picks-omega.js
// API endpoint: GET /.netlify/functions/get-picks-omega
// Returns TODAY's Omega picks (ET) from Netlify Blobs (alpha store).
// Optional: ?date=YYYY-MM-DD for historical picks.
// Default path never falls back to yesterday — that painted last-night W/L onto
// the morning card while the 9am generator was still running.

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
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function liveCacheHeaders(isGenerating) {
  const age = isGenerating ? 10 : 30;
  return { ...CORS, 'Cache-Control': `public, max-age=${age}, s-maxage=${age}, must-revalidate` };
}
function generatingPayload(dateKey) {
  return {
    error: false,
    noPlays: "Today's card is generating. Check back at 9am ET.",
    date: dateKey, picks: [], rejections: [],
    summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
  };
}
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
      const store = getStore("edge-picks-omega");

      const historical = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
      const dateKey = historical ? requestedDate : todayET();

      const picksData = await store.get(`picks-${dateKey}`, { type: "json" });

      if (!picksData) {
        return {
          statusCode: 200,
          headers: liveCacheHeaders(!historical),
          body: JSON.stringify(historical
            ? {
                error: false,
                noPlays: `No Omega picks found for ${dateKey}.`,
                date: dateKey, picks: [], rejections: [],
                summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
              }
            : generatingPayload(dateKey)),
        };
      }

      return {
        statusCode: 200,
        headers: liveCacheHeaders(false),
        body: JSON.stringify(stripPremium(picksData)),
      };

    } catch (blobErr) {
      console.error("[get-picks-omega] Blobs SDK error:", blobErr.message);

      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-omega`;
        const authHeaders = { "Authorization": `Bearer ${token}` };

        const historical = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
        const dateKey = historical ? requestedDate : todayET();
        try {
          const pr = await fetch(`${baseUrl}/picks-${dateKey}`, { headers: authHeaders });
          if (pr.ok) {
            const data = await pr.json();
            return { statusCode: 200, headers: liveCacheHeaders(false), body: JSON.stringify(stripPremium(data)) };
          }
        } catch(e) {}
        return {
          statusCode: 200,
          headers: liveCacheHeaders(!historical),
          body: JSON.stringify(historical
            ? { error: false, noPlays: `No Omega picks found for ${dateKey}.`, date: dateKey, picks: [], rejections: [], summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] } }
            : generatingPayload(dateKey)),
        };
      }

      return {
        statusCode: 200,
        headers: liveCacheHeaders(true),
        body: JSON.stringify(generatingPayload(todayET())),
      };
    }
  } catch (err) {
    console.error("[get-picks-omega] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch Omega picks" }),
    };
  }
};
