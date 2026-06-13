// get-p2p-bet.js — GET /api/get-p2p-bet?id=xxxxx
// Returns a single P2P bet by ID from Blobs.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const id = (event.queryStringParameters || {}).id;
  if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "id required" }) };

  try {
    const { getStore } = await import("@netlify/blobs");
    const storeOpts = {};
    if (process.env.NETLIFY_AUTH_TOKEN && process.env.SITE_ID) {
      storeOpts.siteID = process.env.SITE_ID;
      storeOpts.token = process.env.NETLIFY_AUTH_TOKEN;
    }
    const store = getStore({ name: "p2p-bets", ...storeOpts });
    const bet = await store.get(`bet-${id}`, { type: "json" });
    if (!bet) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Bet not found" }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify(bet) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
