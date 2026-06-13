/**
 * get-bet.js — Fetch a bet by ID from Netlify Blobs
 *
 * GET /api/get-bet?id=a3xK9
 * GET /api/get-bet?recent=true  → returns recent bets index
 */

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
    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-bets", siteID, token });

    // Return recent bets index
    if (params.recent === "true") {
      const recentIndex = await store.get("recent-bets", { type: "json" });
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ bets: recentIndex || [] }),
      };
    }

    // Return a specific bet
    const betId = params.id;
    if (!betId) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "id parameter required" }),
      };
    }

    const bet = await store.get(`bet-${betId}`, { type: "json" });
    if (!bet) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: "Bet not found", betId }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(bet),
    };
  } catch (err) {
    console.error("[GET-BET] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
