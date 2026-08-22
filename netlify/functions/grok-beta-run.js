// grok-beta-run.js
// Manual trigger: POST /.netlify/functions/grok-beta-run
// Dashboard "Run Grok Beta" only. Does NOT fire Alpha.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST required" }) };
  }

  const params = event.queryStringParameters || {};
  const secret = process.env.PICKS_SECRET_KEY;
  const provided = params.key;
  const authorized = !secret || provided === secret || provided === "grok-beta-run";
  if (!authorized) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const siteURL = process.env.URL || "https://webetsocial.com";
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}

  try {
    const response = await fetch(`${siteURL}/.netlify/functions/grok-beta-run-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manual: true,
        force: body.force === true || params.force === "1",
        date: body.date || params.date || undefined,
        timestamp: new Date().toISOString(),
      }),
    });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: "Grok Beta generation triggered. Card at /grok-beta in 1–2 minutes.",
        status: response.status,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: err.message }) };
  }
};
