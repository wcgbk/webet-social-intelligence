/**
 * check-resolution.js — Polls prediction markets for bet resolution
 *
 * Scheduled function (cron). Checks all active bets against their
 * linked prediction market. When a market resolves, updates the bet
 * and notifies participants via Betty SMS.
 *
 * Schedule: Every 6 hours (configured in netlify.toml)
 */

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = "+18557644821"; // Betty - WeBetAI

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Check Polymarket resolution status ──
async function checkPolymarketResolution(marketId) {
  try {
    // Polymarket Gamma API — free, no auth
    const res = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
    if (!res.ok) return null;

    const data = await res.json();

    // Check if market has resolved
    if (data.resolved || data.closed) {
      // Determine winning side
      const outcomes = data.outcomes || [];
      const prices = data.outcomePrices || [];

      let resolution = null;
      if (prices.length >= 2) {
        // Price of 1.0 = resolved to that outcome
        const yesPrice = parseFloat(prices[0]);
        const noPrice = parseFloat(prices[1]);
        if (yesPrice >= 0.95) resolution = "yes";
        else if (noPrice >= 0.95) resolution = "no";
      }

      if (data.resolution) {
        resolution = data.resolution.toLowerCase();
      }

      return {
        resolved: true,
        resolution,
        source: "Polymarket",
        resolvedAt: data.endDate || new Date().toISOString(),
      };
    }

    return { resolved: false };
  } catch (err) {
    console.warn(`[RESOLUTION] Polymarket check failed for ${marketId}:`, err.message);
    return null;
  }
}

// ── Send Betty SMS ──
async function sendBettySMS(to, message) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !to) return false;

  try {
    const params = new URLSearchParams({
      To: to,
      From: TWILIO_FROM,
      Body: message,
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    return res.ok;
  } catch (err) {
    console.warn("[RESOLUTION] SMS send failed:", err.message);
    return false;
  }
}

exports.handler = async (event) => {
  console.log("[RESOLUTION] ═══ Starting resolution check ═══");

  try {
    const { getStore } = await import("@netlify/blobs");
    const siteID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN || "";
    const store = getStore({ name: "webet-bets", siteID, token });

    // Get all recent bets
    const recentIndex = (await store.get("recent-bets", { type: "json" })) || [];

    // Filter to active/open bets that have a market ID
    const activeBets = recentIndex.filter(
      (b) => b.status === "active" || b.status === "open"
    );

    console.log(`[RESOLUTION] Checking ${activeBets.length} active bets...`);

    let resolvedCount = 0;

    for (const indexEntry of activeBets) {
      const bet = await store.get(`bet-${indexEntry.id}`, { type: "json" });
      if (!bet || !bet.marketId) continue;

      // Check resolution based on platform
      let result = null;
      if (bet.platform === "Polymarket" || bet.marketId.startsWith("poly")) {
        result = await checkPolymarketResolution(bet.marketId);
      }
      // Add Kalshi, Metaculus etc. checkers here as needed

      if (!result || !result.resolved || !result.resolution) continue;

      // Market resolved — update the bet
      console.log(`[RESOLUTION] Bet ${bet.id} resolved: ${result.resolution}`);
      bet.status = "resolved";
      bet.resolution = result.resolution;
      bet.resolvedAt = result.resolvedAt;
      bet.resolutionSource = result.source;

      await store.setJSON(`bet-${bet.id}`, bet);
      resolvedCount++;

      // Determine winners and losers
      const winners = bet.sides[result.resolution] || [];
      const loserSide = result.resolution === "yes" ? "no" : "yes";
      const losers = bet.sides[loserSide] || [];

      const siteUrl = process.env.URL || "https://webetsocial.com";

      // Notify winners via Betty
      for (const winner of winners) {
        if (winner.phone) {
          await sendBettySMS(
            winner.phone,
            `🎉 You won! "${bet.title}" resolved ${result.resolution.toUpperCase()}. ` +
              `You won $${winner.amount} on your WeBet. ` +
              `See results: ${siteUrl}/bet/${bet.id}`
          );
        }
      }

      // Notify losers via Betty
      for (const loser of losers) {
        if (loser.phone) {
          await sendBettySMS(
            loser.phone,
            `📉 "${bet.title}" resolved ${result.resolution.toUpperCase()}. ` +
              `You owe $${loser.amount}. Pay up or bet again: ${siteUrl}/bet/${bet.id}`
          );
        }
      }

      // Small delay between resolution checks
      await new Promise((r) => setTimeout(r, 300));
    }

    // Update the recent index with resolved statuses
    const updatedIndex = await Promise.all(
      recentIndex.map(async (entry) => {
        if (entry.status === "active" || entry.status === "open") {
          const freshBet = await store.get(`bet-${entry.id}`, { type: "json" });
          if (freshBet) {
            entry.status = freshBet.status;
          }
        }
        return entry;
      })
    );
    await store.setJSON("recent-bets", updatedIndex);

    console.log(`[RESOLUTION] ═══ Done. ${resolvedCount} bets resolved. ═══`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        checked: activeBets.length,
        resolved: resolvedCount,
      }),
    };
  } catch (err) {
    console.error("[RESOLUTION] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
