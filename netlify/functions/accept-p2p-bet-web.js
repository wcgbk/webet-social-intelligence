// accept-p2p-bet-web.js
// Web-based P2P bet acceptance/decline
// POST /api/accept-p2p-bet-web
// Actions: accept, decline, counter

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  try {
    const { getStore } = await import("@netlify/blobs");
    const storeOpts = {};
    if (process.env.NETLIFY_AUTH_TOKEN && process.env.SITE_ID) {
      storeOpts.siteID = process.env.SITE_ID;
      storeOpts.token = process.env.NETLIFY_AUTH_TOKEN;
    }
    const body = JSON.parse(event.body || "{}");

    const { betId, action, responderName, responderPhone, responderHandle, counterAmount } = body;

    if (!betId || !action) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing betId or action" }) };
    }

    const betsStore = getStore({ name: "p2p-bets", ...storeOpts });
    let bet;
    try {
      bet = await betsStore.get(`bet-${betId}`, { type: "json" });
    } catch (_) {}

    if (!bet) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Bet not found" }) };
    }

    if (bet.status !== "pending") {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Bet is already ${bet.status}` }) };
    }

    // Check expiry
    if (bet.expiresAt && new Date(bet.expiresAt) < new Date()) {
      bet.status = "expired";
      bet.events.push({ type: "expired", ts: new Date().toISOString() });
      await betsStore.setJSON(`bet-${betId}`, bet);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bet has expired" }) };
    }

    const now = new Date().toISOString();

    if (action === "accept") {
      bet.status = "active";
      bet.acceptedAt = now;
      bet.counterpartyName = responderName || bet.counterpartyName || "Opponent";
      bet.counterpartyPhone = responderPhone || bet.counterpartyPhone;
      bet.counterpartyHandle = responderHandle || bet.counterpartyHandle;
      bet.events.push({ type: "accepted", actor: responderName || "web", ts: now });

      await betsStore.setJSON(`bet-${betId}`, bet);

      // Send SMS notification to initiator if we have their phone
      if (bet.initiatorPhone) {
        try {
          await sendSMS(
            bet.initiatorPhone,
            `🔒 BET LOCKED!\n\n${bet.counterpartyName || "Your opponent"} accepted!\n\n${bet.initiatorName}: ${bet.initiatorSide}\n${bet.counterpartyName}: ${bet.counterpartySide}\n\nWager: $${bet.amountDisplay}\n\nI'll text you when it's final.\n${bet.shareUrl}`
          );
        } catch (_) {}
      }

      // Update recent index
      await updateRecentIndex(betsStore, betId, "active");

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, action: "accepted", bet }),
      };
    }

    if (action === "decline") {
      bet.status = "declined";
      bet.events.push({ type: "declined", actor: responderName || "web", ts: now });
      await betsStore.setJSON(`bet-${betId}`, bet);

      // Notify initiator
      if (bet.initiatorPhone) {
        try {
          await sendSMS(bet.initiatorPhone, `${bet.counterpartyName || "Your opponent"} declined the bet on ${bet.matchup}. Challenge someone else!`);
        } catch (_) {}
      }

      await updateRecentIndex(betsStore, betId, "declined");

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, action: "declined", bet }),
      };
    }

    if (action === "counter") {
      if (!counterAmount || counterAmount <= 0) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Counter amount required" }) };
      }
      bet.counterAmount = Math.round(counterAmount * 100);
      bet.counterpartyName = responderName || bet.counterpartyName;
      bet.counterpartyPhone = responderPhone || bet.counterpartyPhone;
      bet.events.push({ type: "countered", actor: responderName || "web", amount: counterAmount, ts: now });
      await betsStore.setJSON(`bet-${betId}`, bet);

      // Notify initiator of counter
      if (bet.initiatorPhone) {
        try {
          await sendSMS(
            bet.initiatorPhone,
            `${bet.counterpartyName || "Your opponent"} countered your bet!\n\nOriginal: $${bet.amountDisplay}\nCounter: $${counterAmount}\n\nReply ACCEPT or PASS\n${bet.shareUrl}`
          );
        } catch (_) {}
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, action: "countered", bet }),
      };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error("[accept-p2p-bet-web] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: err.message }),
    };
  }
};

async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM || "+18557644821";

  if (!accountSid || !authToken) return;

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: fromNumber, To: to, Body: body });

  await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

async function updateRecentIndex(store, betId, newStatus) {
  try {
    let recent = [];
    try {
      const r = await store.get("recent-index", { type: "json" });
      if (r) recent = r;
    } catch (_) {}
    const idx = recent.findIndex((b) => b.id === betId);
    if (idx >= 0) {
      recent[idx].status = newStatus;
      await store.setJSON("recent-index", recent);
    }
  } catch (_) {}
}
