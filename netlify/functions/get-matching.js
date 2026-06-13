// get-matching.js
// API endpoint: GET /.netlify/functions/get-matching
// Returns the latest matching engine results from Netlify Blobs.
// Optional query param: ?key=YYYY-MM-DD-HHmm for specific cycle.
//
// Usage:
//   /api/get-matching          → latest feed
//   /api/get-matching?key=2026-03-31-1400  → specific cycle

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    const params = event.queryStringParameters || {};
    const requestedKey = params.key;

    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-matching", siteID, token });

    let feedData;

    if (requestedKey) {
      feedData = await store.get(`feed-${requestedKey}`, { type: "json" });
    } else {
      feedData = await store.get("feed-latest", { type: "json" });
    }

    if (!feedData) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          error: false,
          empty: true,
          message: "No matching data yet. Run the matching engine first.",
          topics: [],
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(feedData),
    };
  } catch (err) {
    console.error("[GET-MATCHING] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
