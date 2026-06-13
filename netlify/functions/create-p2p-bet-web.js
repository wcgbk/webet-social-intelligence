// create-p2p-bet-web.js
// Web-based P2P bet creation from /p2p-sports dashboard
// POST /api/create-p2p-bet-web
// Creates bet in p2p-bets store, optionally sends SMS challenge

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

    const {
      initiatorName,
      initiatorPhone,
      initiatorHandle,
      counterpartyName,
      counterpartyPhone,
      counterpartyHandle,
      event: eventName,
      league,
      pick,        // e.g. "Lakers Spread +5.5" or "Lakers ML"
      odds,        // American odds number
      amount,      // dollar amount
      matchup,     // "Team A vs Team B"
      gameDate,    // ISO string or date
    } = body;

    if (!pick || !odds || !amount || !eventName) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing required fields: pick, odds, amount, event" }) };
    }

    // Generate bet ID
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let betId = "";
    for (let i = 0; i < 6; i++) betId += chars[Math.floor(Math.random() * chars.length)];

    const amountCents = Math.round((amount || 20) * 100);
    const now = new Date().toISOString();

    // Calculate payout
    const oddsNum = parseFloat(odds);
    let payout = 0;
    if (oddsNum >= 0) payout = amount * (oddsNum / 100);
    else payout = amount * (100 / Math.abs(oddsNum));

    // Determine initiator side & counterparty side from the pick
    const initiatorSide = pick;
    // Try to determine opposite side from matchup
    let counterpartySide = "Opposite";
    if (matchup) {
      const parts = matchup.split(/\s+(?:vs\.?|at|@)\s+/i);
      if (parts.length === 2) {
        const team1 = parts[0].trim();
        const team2 = parts[1].trim();
        // If pick contains team1, counterparty is team2, and vice versa
        if (pick.toLowerCase().includes(team1.toLowerCase().split(" ").pop())) {
          counterpartySide = team2;
        } else {
          counterpartySide = team1;
        }
      }
    }

    const oppLabel = (counterpartyHandle || counterpartyName || "Friend").replace(/^@/, "");
    const webetString = `@${oppLabel} WeBet $${amount} ${pick}`;

    const bet = {
      id: betId,
      source: "web",  // distinguish from SMS-created bets
      initiatorPhone: initiatorPhone || null,
      initiatorHandle: initiatorHandle || null,
      initiatorName: initiatorName || initiatorHandle || "Anonymous",
      counterpartyPhone: counterpartyPhone || null,
      counterpartyHandle: counterpartyHandle || null,
      counterpartyName: counterpartyName || counterpartyHandle || null,
      sport: league || "Unknown",
      gameId: null,
      homeTeam: null,
      awayTeam: null,
      matchup: matchup || eventName,
      gameDate: gameDate || null,
      betText: `${pick} at ${fmtOdds(oddsNum)}`,
      proposition: pick,
      initiatorSide: initiatorSide,
      counterpartySide: counterpartySide,
      odds: oddsNum,
      amount: amountCents,
      amountDisplay: amount,
      payout: Math.round(payout * 100) / 100,
      webetString: webetString,
      category: "sports",
      status: "pending",
      result: null,
      winnerPhone: null,
      loserPhone: null,
      finalScore: null,
      resolutionSource: "espn",
      settlementStatus: "unsettled",
      counterAmount: null,
      createdAt: now,
      acceptedAt: null,
      resolvedAt: null,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48hr expiry
      events: [{ type: "created", actor: initiatorName || "web", ts: now }],
      shareUrl: `https://webetsocial.com/p2p-sports/bet/?id=${betId}`,
    };

    // Store to Blobs
    const betsStore = getStore({ name: "p2p-bets", ...storeOpts });
    await betsStore.setJSON(`bet-${betId}`, bet);

    // Update recent bets index
    try {
      let recent = [];
      try {
        const r = await betsStore.get("recent-index", { type: "json" });
        if (r) recent = r;
      } catch (_) {}
      recent.unshift({
        id: betId,
        matchup: bet.matchup,
        sport: bet.sport,
        pick: bet.proposition,
        odds: bet.odds,
        amount: bet.amountDisplay,
        status: "pending",
        createdAt: bet.createdAt,
      });
      if (recent.length > 100) recent = recent.slice(0, 100);
      await betsStore.setJSON("recent-index", recent);
    } catch (_) {}

    // If counterparty phone provided, send SMS challenge
    if (counterpartyPhone) {
      try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_FROM || "+18557644821";

        if (accountSid && authToken) {
          const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
          const smsBody = [
            `🤝 ${initiatorName || initiatorHandle || "Someone"} challenged you!`,
            ``,
            `${webetString}`,
            ``,
            `${pick} at ${fmtOdds(oddsNum)}`,
            `Wager: $${amount}`,
            ``,
            `Accept or decline:`,
            `${bet.shareUrl}`,
          ].join("\n");

          const params = new URLSearchParams({
            From: fromNumber,
            To: counterpartyPhone,
            Body: smsBody,
          });

          await fetch(twilioUrl, {
            method: "POST",
            headers: {
              Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params.toString(),
          });

          bet.events.push({ type: "sms_sent", to: counterpartyPhone, ts: new Date().toISOString() });
          await betsStore.setJSON(`bet-${betId}`, bet);

          // Set pending for SMS reply routing
          const pendingKey = `pending-${counterpartyPhone.replace(/\D/g, "")}`;
          await betsStore.set(pendingKey, betId);
        }
      } catch (smsErr) {
        console.error("[create-p2p-bet-web] SMS error:", smsErr.message);
        // Non-fatal — bet still created
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        betId: betId,
        shareUrl: bet.shareUrl,
        bet: bet,
      }),
    };
  } catch (err) {
    console.error("[create-p2p-bet-web] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: err.message }),
    };
  }
};

function fmtOdds(odds) {
  const n = Math.round(odds);
  return n >= 0 ? `+${n}` : `${n}`;
}
