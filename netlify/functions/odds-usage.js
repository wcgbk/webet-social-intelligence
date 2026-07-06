// odds-usage.js
// API: GET /.netlify/functions/odds-usage  (also /api/odds-usage)
// Read-only ops diagnostic: reports The Odds API monthly quota + credits remaining/used.
// Reads ODDS_API_KEY server-side (Netlify env) and returns ONLY the usage headers — never the key.
// The /sports endpoint is free (does not consume credits).

exports.handler = async () => {
  const CORS = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  const key = process.env.ODDS_API_KEY;
  if (!key) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: "ODDS_API_KEY not set in this function's env" }) };
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${key}`);
    const remaining = r.headers.get("x-requests-remaining");
    const used = r.headers.get("x-requests-used");
    const lastCost = r.headers.get("x-requests-last");
    const rem = remaining != null ? Number(remaining) : null;
    const usd = used != null ? Number(used) : null;
    const monthlyQuota = (rem != null && usd != null) ? rem + usd : null;
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: r.ok, httpStatus: r.status,
        creditsRemaining: rem, creditsUsed: usd, monthlyQuota,
        lastRequestCost: lastCost != null ? Number(lastCost) : null,
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
