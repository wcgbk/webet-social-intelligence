// run-matching.js
// Manual trigger: POST /api/run-matching?key=SECRET
// Invokes matching-engine-background as a background function.
//
// Usage:
//   curl -X POST "https://webetsocial.com/api/run-matching?key=YOUR_SECRET"

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || "webet-matching-2026";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  // Auth check
  const params = event.queryStringParameters || {};
  if (params.key !== PIPELINE_SECRET) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    // Invoke the background function
    const siteUrl = process.env.URL || "https://webetsocial.com";
    const res = await fetch(`${siteUrl}/.netlify/functions/matching-engine-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "manual", timestamp: new Date().toISOString() }),
    });

    return {
      statusCode: 202,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: "Matching engine triggered. Results available at /api/get-matching in ~60-90 seconds.",
        status: res.status,
      }),
    };
  } catch (err) {
    console.error("[RUN-MATCHING] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
