// x-oauth-callback.js — Exchanges X OAuth 2.0 PKCE auth code for access token + user profile
// POST /api/x-oauth-callback { code, codeVerifier, redirectUri }
// Returns: { handle, name, firstName, lastName, profilePic, xId }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  try {
    const { code, codeVerifier, redirectUri } = JSON.parse(event.body || "{}");

    if (!code || !codeVerifier) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "code and codeVerifier required" }) };
    }

    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;

    if (!clientId) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "TWITTER_CLIENT_ID not configured" }) };
    }

    // Exchange auth code for access token
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri || "https://webetsocial.com/handshake",
      code_verifier: codeVerifier,
      client_id: clientId,
    });

    const tokenHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Use client credentials auth if secret is available
    if (clientSecret) {
      tokenHeaders["Authorization"] = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    }

    const tokenResp = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: tokenHeaders,
      body: tokenParams.toString(),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error("[x-oauth] Token exchange failed:", tokenResp.status, errText);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "X auth failed", details: errText }) };
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No access token returned" }) };
    }

    // Fetch user profile
    const userResp = await fetch("https://api.x.com/2/users/me?user.fields=name,username,profile_image_url", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userResp.ok) {
      const errText = await userResp.text();
      console.error("[x-oauth] User fetch failed:", userResp.status, errText);
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Failed to fetch X profile" }) };
    }

    const userData = await userResp.json();
    const user = userData.data;

    if (!user) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No user data returned" }) };
    }

    // Parse first/last name from display name
    const nameParts = (user.name || "").trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Upsert user in p2p-users store
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("p2p-users");

      // Check if user exists by handle
      const existingKey = await store.get(`handle-${user.username.toLowerCase()}`).catch(() => null);
      let existingUser = null;
      if (existingKey) {
        existingUser = await store.get(`user-${existingKey.trim()}`, { type: "json" }).catch(() => null);
      }

      if (!existingUser) {
        // Create new user with X handle (no phone yet)
        const newUser = {
          phone: null,
          handle: user.username,
          displayName: user.name,
          firstName, lastName,
          xId: user.id,
          profilePic: user.profile_image_url,
          createdAt: new Date().toISOString(),
          loginMethod: "x",
          wins: 0, losses: 0, pushes: 0,
          totalWagered: 0, totalWon: 0,
          currentStreak: 0, bestStreak: 0, allTimePL: 0,
        };
        // Store by X ID since we may not have phone
        await store.setJSON(`user-x-${user.id}`, newUser);
        await store.set(`handle-${user.username.toLowerCase()}`, `x-${user.id}`);
      }
    } catch (e) {
      console.warn("[x-oauth] User upsert error:", e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        handle: user.username,
        name: user.name,
        firstName,
        lastName,
        profilePic: user.profile_image_url,
        xId: user.id,
      }),
    };
  } catch (err) {
    console.error("[x-oauth] Error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
