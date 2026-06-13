// trigger-kalshi.js
// Scheduled function — runs daily at 15:00 UTC (11:00 AM EDT).
// Runs 1 hour after daily picks are generated (10am EDT) to ensure picks exist.
// Triggers the kalshi-execute-background function.
// Schedule is configured in netlify.toml

exports.handler = async (event) => {
  console.log("[trigger-kalshi] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/kalshi-execute-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );

    console.log(`[trigger-kalshi] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Triggered" };
  } catch (err) {
    console.error(`[trigger-kalshi] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
