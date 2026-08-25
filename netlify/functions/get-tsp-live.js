// get-tsp-live.js
// API for the PRIVATE /live-ai page: GET /api/get-tsp-live?key=<TSP_PAGE_KEY>[&date=YYYY-MM-DD]
// Serves the parsed TSP.Live Hermes selections from the "tsp-live" blob store.
//
// HARD-GATED server-side: without the correct key the data never leaves the function.
// This endpoint intentionally has NO public mode — TSP.Live is paid membership
// content, private to Ben's own use.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const params = event.queryStringParameters || {};
  const gate = process.env.TSP_PAGE_KEY;
  if (!gate) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, status: "NOT_CONFIGURED", message: "TSP_PAGE_KEY env var is not set." }) };
  }
  if (params.key !== gate) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: "Unauthorized" }) };
  }

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("tsp-live");
    const key = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? `day-${params.date}` : "latest";
    const data = await store.get(key, { type: "json" });
    if (!data) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: "EMPTY", message: "No TSP data captured yet — the fetcher has not run.", selections: [] }) };
    }
    return { statusCode: 200, headers: { ...CORS, "Cache-Control": "no-store" }, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: e.message }) };
  }
};
