/**
 * trigger-exodus.js — Scheduled trigger for Authentic Press briefings
 *
 * Cron: 0 14,18,0 * * * (10am, 2pm, 8pm EDT)
 * Calls the exodus-scan-background function to generate a new briefing.
 *
 * Isolated from all other triggers — only touches exodus blob stores.
 */

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

exports.handler = async (event) => {
  console.log("[EXODUS-TRIGGER] ========== BRIEFING TRIGGER FIRED ==========");
  console.log("[EXODUS-TRIGGER] Time:", new Date().toISOString());

  try {
    // Invoke the background function
    const token = process.env.NETLIFY_AUTH_TOKEN;

    if (token) {
      // Use Netlify API to invoke background function
      const invokeUrl = `https://api.netlify.com/api/v1/sites/${SITE_ID}/functions/exodus-scan-background`;
      const res = await fetch(invokeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trigger: "scheduled", ts: Date.now() }),
      });

      console.log(`[EXODUS-TRIGGER] Background function invoked: ${res.status}`);
    } else {
      // Direct invocation fallback — call via site URL
      const siteUrl = process.env.URL || "https://webetsocial.com";
      const res = await fetch(`${siteUrl}/.netlify/functions/exodus-scan-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "scheduled", ts: Date.now() }),
      });

      console.log(`[EXODUS-TRIGGER] Direct invocation: ${res.status}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "Exodus briefing generation triggered",
        ts: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error("[EXODUS-TRIGGER] Error:", e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
