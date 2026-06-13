// trigger-guardian.js
// Scheduled function — runs daily at 13:00 UTC (9am EDT).
// Triggers the Guardian background function for daily digest generation.

exports.handler = async (event) => {
  console.log("[trigger-guardian] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-guardian-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );

    console.log(`[trigger-guardian] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Guardian digest triggered" };
  } catch (err) {
    console.error(`[trigger-guardian] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
