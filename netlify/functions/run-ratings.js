// run-ratings.js
// Manual trigger for building ratings.
// POST /api/run-ratings?key=SECRET

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
  }

  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY || "webetai2026";
  if (params.key !== secret) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const siteUrl = process.env.URL || "https://webetsocial.com";

  try {
    const resp = await fetch(`${siteUrl}/.netlify/functions/build-ratings-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    console.log(`[run-ratings] Triggered background function: ${resp.status}`);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ triggered: true, status: resp.status }),
    };
  } catch (err) {
    console.error("[run-ratings] Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
