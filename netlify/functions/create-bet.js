/**
 * create-bet.js — Creates a new WeBet bet and stores it in Netlify Blobs
 *
 * POST /api/create-bet
 * Body: {
 *   betString:    "@cryptoKing WeBet $150 Bitcoin Exceeds $100K By 6/30/26",
 *   title:        "Bitcoin Exceeds $100K",
 *   category:     "media",                    // from webet-string-spec categories
 *   options:      [{ name: "Yes", probability: 62 }, { name: "No", probability: 38 }],
 *   marketUrl:    "https://polymarket.com/...", // optional — links to settlement source
 *   marketId:     "polymarket-btc-100k",        // optional — for auto-resolution
 *   platform:     "Polymarket",                 // optional
 *   createdBy:    "@cryptoKing",                // who proposed the bet
 *   tweetId:      "1234567890",                 // optional — source tweet
 *   amount:       150                           // dollar amount from the bet string
 * }
 *
 * Returns: { success: true, betId: "a3xK9", betUrl: "https://webetsocial.com/bet/a3xK9" }
 */

const crypto = require("crypto");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function generateBetId() {
  // 5-char alphanumeric ID (62^5 = ~916M combinations)
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(5);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // Validate required fields
    if (!body.betString || !body.title) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "betString and title are required" }),
      };
    }

    const betId = generateBetId();
    const now = new Date();

    const bet = {
      id: betId,
      betString: body.betString,
      title: body.title,
      category: body.category || "media",
      options: body.options || [],
      marketUrl: body.marketUrl || null,
      marketId: body.marketId || null,
      platform: body.platform || null,
      amount: body.amount || 100,
      createdBy: body.createdBy || "@anonymous",
      tweetId: body.tweetId || null,
      status: "open", // open → active → resolved
      createdAt: now.toISOString(),
      expiresAt: body.expiresAt || null,

      // Participants
      sides: {
        yes: [],
        no: [],
      },
      totalPool: 0,
      participantCount: 0,

      // Resolution
      resolvedAt: null,
      resolution: null, // "yes" | "no" | "void"
      resolutionSource: null,
    };

    // Store to Netlify Blobs
    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-bets", siteID, token });

    await store.setJSON(`bet-${betId}`, bet);

    // Also maintain an index of recent bets for the leaderboard
    let recentIndex = [];
    try {
      recentIndex = (await store.get("recent-bets", { type: "json" })) || [];
    } catch (_) {}

    recentIndex.unshift({
      id: betId,
      title: bet.title,
      betString: bet.betString,
      category: bet.category,
      createdAt: bet.createdAt,
      createdBy: bet.createdBy,
      amount: bet.amount,
      participantCount: 0,
      status: "open",
    });

    // Keep last 200 bets in the index
    if (recentIndex.length > 200) recentIndex = recentIndex.slice(0, 200);
    await store.setJSON("recent-bets", recentIndex);

    const siteUrl = process.env.URL || "https://webetsocial.com";

    return {
      statusCode: 201,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        betId,
        betUrl: `${siteUrl}/bet/${betId}`,
        bet,
      }),
    };
  } catch (err) {
    console.error("[CREATE-BET] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
