// trigger-picks.js
// Scheduled function — runs daily at 10:00 AM EDT (14:00 UTC).
// Triggers the background function which does the actual Claude API work.
// Schedule is configured in netlify.toml

exports.handler = async (event) => {
  console.log("[trigger-picks] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    // Trigger the background function — returns 202 immediately
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, refreshRatings: true, timestamp: new Date().toISOString() }),
      }
    );

    console.log(`[trigger-picks] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Triggered" };
  } catch (err) {
    console.error(`[trigger-picks] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
