// trigger-picks-mvp.js
// Scheduled function — runs daily at 12:00 UTC (8:00 AM ET).
// 1 hour before alpha (13:00 UTC) for maximum CLV runway comparison.
// Fires generate-picks-mvp-background — v11.0 test model.

exports.handler = async (event) => {
  console.log("[trigger-picks-mvp] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-mvp-background`,
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

    console.log(`[trigger-picks-mvp] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "MVP triggered" };
  } catch (err) {
    console.error(`[trigger-picks-mvp] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
