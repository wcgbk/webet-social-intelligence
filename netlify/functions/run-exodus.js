/**
 * run-exodus.js — Manual trigger for Authentic Press briefing generation
 *
 * POST /api/run-exodus?key=SECRET
 *
 * Allows manual trigger of a briefing outside the cron schedule.
 * Useful for testing and on-demand generation.
 */

const ADMIN_SECRET = process.env.PICKS_SECRET_KEY || process.env.ADMIN_SECRET;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };
  }

  // Auth check
  const key = (event.queryStringParameters || {}).key;
  if (!key || key !== ADMIN_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  console.log("[EXODUS-RUN] Manual briefing trigger fired");

  try {
    // Call the background function directly
    const siteUrl = process.env.URL || "https://webetsocial.com";
    const res = await fetch(`${siteUrl}/.netlify/functions/exodus-scan-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "manual", ts: Date.now() }),
    });

    console.log(`[EXODUS-RUN] Background function status: ${res.status}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        message: "Exodus briefing generation started. Check /exodus in ~60 seconds.",
        ts: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error("[EXODUS-RUN] Error:", e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
