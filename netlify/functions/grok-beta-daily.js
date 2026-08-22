// grok-beta-daily.js
// Scheduled 12:30 UTC = 08:30 America/New_York during EDT.
// Independent of trigger-picks-alpha. First automatic fire: Sun Aug 23, 2026.

exports.handler = async () => {
  const siteURL = process.env.URL || "https://webetsocial.com";
  console.log("[grok-beta-daily] Firing Grok Beta generator.");
  try {
    const response = await fetch(`${siteURL}/.netlify/functions/grok-beta-run-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
    });
    console.log(`[grok-beta-daily] background status ${response.status}`);
    return { statusCode: 200, body: "Grok Beta daily generation triggered" };
  } catch (err) {
    console.error(`[grok-beta-daily] ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
