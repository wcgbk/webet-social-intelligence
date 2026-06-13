// phone-verify.js — Phone number OTP verification via Twilio SMS
// POST /api/phone-verify { action: "send"|"verify", phone, code?, firstName?, lastName? }
// send: generates 6-digit code, texts it via Betty
// verify: checks code, returns success + creates user

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = "+18557644821";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// In-memory code store (lives for function lifetime — ~5 min on cold start)
// For production, use Blobs with TTL
const pendingCodes = {};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  try {
    const { action, phone, code, firstName, lastName, handle } = JSON.parse(event.body || "{}");

    // Normalize phone
    let normalized = (phone || "").replace(/\D/g, "");
    if (normalized.length === 10) normalized = "1" + normalized;
    if (normalized.length !== 11 || !normalized.startsWith("1")) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid phone number" }) };
    }
    const fullPhone = "+" + normalized;

    if (action === "send") {
      // Generate 6-digit code
      const otp = String(Math.floor(100000 + Math.random() * 900000));

      // Store code in Blobs (survives across function invocations)
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("phone-verify");
        await store.setJSON(`otp-${normalized}`, {
          code: otp,
          phone: fullPhone,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000, // 10 min expiry
        });
      } catch (e) {
        console.warn("[phone-verify] Blob store error, using memory:", e.message);
        pendingCodes[normalized] = { code: otp, expiresAt: Date.now() + 10 * 60 * 1000 };
      }

      // Send via Twilio
      const smsBody = `Your WeBetAI verification code is: ${otp}\n\nThis code expires in 10 minutes.`;
      const params = new URLSearchParams({ To: fullPhone, From: TWILIO_FROM, Body: smsBody });

      const smsResp = await fetch(
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

      if (!smsResp.ok) {
        const err = await smsResp.text();
        console.error("[phone-verify] SMS send failed:", err);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to send code" }) };
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, message: "Code sent" }),
      };
    }

    if (action === "verify") {
      if (!code) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Code required" }) };

      // Check code from Blobs first, then memory fallback
      let stored = null;
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("phone-verify");
        stored = await store.get(`otp-${normalized}`, { type: "json" });
      } catch (e) {
        stored = pendingCodes[normalized] || null;
      }

      if (!stored) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No code found. Request a new one." }) };
      }

      if (Date.now() > stored.expiresAt) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Code expired. Request a new one." }) };
      }

      if (stored.code !== code.trim()) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Wrong code. Try again." }) };
      }

      // Code verified — clean up
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("phone-verify");
        await store.delete(`otp-${normalized}`);
      } catch (_) {}
      delete pendingCodes[normalized];

      // Create/update user
      const userHandle = handle || (firstName ? firstName.toLowerCase() : `user${normalized.slice(-4)}`);
      try {
        const { getStore } = await import("@netlify/blobs");
        const store = getStore("p2p-users");
        let user = null;
        try { user = await store.get(`user-${normalized}`, { type: "json" }); } catch (_) {}

        if (!user) {
          user = {
            phone: fullPhone,
            handle: userHandle,
            displayName: [firstName, lastName].filter(Boolean).join(" ") || userHandle,
            firstName: firstName || null,
            lastName: lastName || null,
            loginMethod: "phone",
            createdAt: new Date().toISOString(),
            wins: 0, losses: 0, pushes: 0,
            totalWagered: 0, totalWon: 0,
            currentStreak: 0, bestStreak: 0, allTimePL: 0,
          };
        } else {
          if (firstName) user.firstName = firstName;
          if (lastName) user.lastName = lastName;
          if (firstName || lastName) user.displayName = [firstName, lastName].filter(Boolean).join(" ");
        }

        await store.setJSON(`user-${normalized}`, user);
        await store.set(`handle-${userHandle.toLowerCase()}`, normalized);
      } catch (e) {
        console.warn("[phone-verify] User save error:", e.message);
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          handle: userHandle,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: fullPhone,
        }),
      };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "action must be 'send' or 'verify'" }) };
  } catch (err) {
    console.error("[phone-verify] Error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
