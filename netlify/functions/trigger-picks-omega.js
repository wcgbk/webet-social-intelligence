// trigger-picks-omega.js
// Scheduled function — runs daily at 9:00 AM EDT (13:00 UTC).
// Fires generate-picks-omega-background — the improved Omega model.
// 1hr earlier than beta/production for maximum CLV runway.

exports.handler = async (event) => {
  console.log("[trigger-picks-omega] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-omega-background`,
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

    console.log(`[trigger-picks-omega] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Omega triggered" };
  } catch (err) {
    console.error(`[trigger-picks-omega] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
