/**
 * accept-bet.js — Take a side on an existing WeBet bet
 *
 * POST /api/accept-bet
 * Body: {
 *   betId:    "a3xK9",
 *   side:     "yes" | "no",
 *   handle:   "@friendHandle",    // X handle or display name
 *   phone:    "+15551234567",     // optional — for Betty SMS settlement
 *   amount:   150                 // optional — override (defaults to bet amount)
 * }
 *
 * Returns: { success: true, bet: { ...updatedBet } }
 */

const crypto = require("crypto");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

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
    const { betId, side, handle, phone, amount } = body;

    if (!betId || !side || !handle) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "betId, side, and handle are required" }),
      };
    }

    if (!["yes", "no"].includes(side)) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'side must be "yes" or "no"' }),
      };
    }

    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-bets", siteID, token });

    // Fetch the bet
    const bet = await store.get(`bet-${betId}`, { type: "json" });
    if (!bet) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({ error: "Bet not found" }),
      };
    }

    if (bet.status === "resolved") {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "This bet has already been resolved" }),
      };
    }

    // Check if user already took a side
    const alreadyIn =
      bet.sides.yes.some((p) => p.handle === handle) ||
      bet.sides.no.some((p) => p.handle === handle);

    if (alreadyIn) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "You already have a position on this bet" }),
      };
    }

    // Add participant
    const participantId = crypto.randomBytes(4).toString("hex");
    const stakeAmount = amount || bet.amount;

    const participant = {
      id: participantId,
      handle,
      phone: phone || null,
      amount: stakeAmount,
      joinedAt: new Date().toISOString(),
    };

    bet.sides[side].push(participant);
    bet.totalPool += stakeAmount;
    bet.participantCount = bet.sides.yes.length + bet.sides.no.length;

    // Move to "active" once both sides have at least one participant
    if (bet.status === "open" && bet.sides.yes.length > 0 && bet.sides.no.length > 0) {
      bet.status = "active";
    }

    // Save updated bet
    await store.setJSON(`bet-${betId}`, bet);

    // Update the recent-bets index
    try {
      let recentIndex = (await store.get("recent-bets", { type: "json" })) || [];
      const idx = recentIndex.findIndex((b) => b.id === betId);
      if (idx >= 0) {
        recentIndex[idx].participantCount = bet.participantCount;
        recentIndex[idx].status = bet.status;
        await store.setJSON("recent-bets", recentIndex);
      }
    } catch (_) {}

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        participantId,
        side,
        bet: {
          id: bet.id,
          title: bet.title,
          status: bet.status,
          totalPool: bet.totalPool,
          participantCount: bet.participantCount,
          sides: {
            yes: bet.sides.yes.length,
            no: bet.sides.no.length,
          },
        },
      }),
    };
  } catch (err) {
    console.error("[ACCEPT-BET] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
