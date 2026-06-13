// get-guardian.js
// API endpoint: GET /api/get-guardian
// Returns the latest Guardian digest from Netlify Blobs.
// Optional query param: ?date=YYYY-MM-DD for historical digests.

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

    let digestData;

    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("guardian-digest");

      if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        digestData = await store.get(`digest-${requestedDate}`, { type: "json" });
        if (!digestData) {
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
              error: false,
              noDigest: `No Guardian digest found for ${requestedDate}.`,
              date: requestedDate,
              digest: [],
              stats: { verified: 0, developing: 0, checkSources: 0, avgAuthenticityScore: 0 },
            }),
          };
        }
      } else {
        // Get latest
        digestData = await store.get("latest", { type: "json" });
        if (!digestData) {
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
              error: false,
              noDigest: "No Guardian digest generated yet. Check back after 9am EDT.",
              date: null,
              digest: [],
              stats: { verified: 0, developing: 0, checkSources: 0, avgAuthenticityScore: 0 },
            }),
          };
        }
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Cache-Control': 'public, max-age=300, s-maxage=300' },
        body: JSON.stringify(digestData),
      };
    } catch (blobErr) {
      console.error("[get-guardian] Blobs SDK error:", blobErr.message);

      // Fallback to Netlify API
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

      if (token) {
        const baseUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/guardian-digest`;
        const authHeaders = { "Authorization": `Bearer ${token}` };

        const key = requestedDate ? `digest-${requestedDate}` : "latest";
        try {
          const resp = await fetch(`${baseUrl}/${key}`, { headers: authHeaders });
          if (resp.ok) {
            const data = await resp.json();
            return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
          }
        } catch (e) {
          console.error("[get-guardian] API fallback error:", e.message);
        }
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          noDigest: "No Guardian digest generated yet. Check back after 9am EDT.",
          date: null,
          digest: [],
          stats: { verified: 0, developing: 0, checkSources: 0, avgAuthenticityScore: 0 },
        }),
      };
    }
  } catch (err) {
    console.error("[get-guardian] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch Guardian digest" }),
    };
  }
};
