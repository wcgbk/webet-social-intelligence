// trigger-picks-alpha.js
// Scheduled function — runs daily at 9:00 AM EDT (13:00 UTC).
// Fires generate-picks-alpha-background — the improved Alpha model.
// 1hr earlier than beta/production for maximum CLV runway.

exports.handler = async (event) => {
  console.log("[trigger-picks-alpha] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-alpha-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduled: true,
          refreshRatings: true,
          timestamp: new Date().toISOString(),
        }),
      }
    );

    console.log(`[trigger-picks-alpha] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Alpha triggered" };
  } catch (err) {
    console.error(`[trigger-picks-alpha] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
