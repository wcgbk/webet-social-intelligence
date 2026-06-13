// bettoredge-auth.js
// BettorEdge API authentication utility.
// Supports two auth modes:
//   1. BETTOREDGE_USERNAME + BETTOREDGE_PASSWORD — auto-refreshing (preferred)
//   2. BETTOREDGE_TOKEN — static Bearer token (fallback only)
// For a permanent solution, request an API key from james@bettoredge.com.

let cachedToken = null;
let tokenExpiry = 0;

async function getBettorEdgeToken() {
  // Priority 1: Cached token (still valid)
  if (cachedToken && Date.now() < tokenExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }

  // Priority 2: Auto-refreshing username/password auth
  const username = process.env.BETTOREDGE_USERNAME;
  const password = process.env.BETTOREDGE_PASSWORD;

  if (username && password) {
    const resp = await fetch("https://api.players.bettoredge.com/v1/players/player/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (resp.ok) {
      const data = await resp.json();
      cachedToken = data.access_token;

      if (data.expire_datetime) {
        tokenExpiry = new Date(data.expire_datetime).getTime();
      } else {
        tokenExpiry = Date.now() + 60 * 60 * 1000;
      }

      console.log("[bettoredge-auth] Authenticated successfully, token expires:", data.expire_datetime || "~1hr");
      return cachedToken;
    }

    console.warn("[bettoredge-auth] Username/password auth failed, trying static token fallback...");
  }

  // Priority 3: Static token fallback
  const staticToken = process.env.BETTOREDGE_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  throw new Error("BETTOREDGE_USERNAME+BETTOREDGE_PASSWORD or BETTOREDGE_TOKEN env vars required");
}

// Fetch wrapper that auto-injects Bearer token and retries on 401
async function bettoredgeFetch(url, options = {}) {
  const token = await getBettorEdgeToken();

  const resp = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "Authorization": `Bearer ${token}`,
    },
  });

  if (resp.status === 401) {
    console.log("[bettoredge-auth] Got 401, forcing re-authentication...");
    cachedToken = null;
    tokenExpiry = 0;
    const newToken = await getBettorEdgeToken();
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${newToken}`,
      },
    });
  }

  return resp;
}

module.exports = { getBettorEdgeToken, bettoredgeFetch };
