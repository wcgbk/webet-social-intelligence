// trigger-picks-omega-v1.js — 10:45 AM ET: rebuild the Omega V1 A/B card from the 10:15 Omega card (read-only).

exports.handler = async (event) => {
  console.log("[trigger-picks-omega-v1] Scheduled run triggered (omega-vnext)");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-omega-v1-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduled: true,
          force: true,
          refreshRatings: true,
          timestamp: new Date().toISOString(),
        }),
      }
    );

    console.log(`[trigger-picks-omega-v1] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Omega V1 A/B triggered" };
  } catch (err) {
    console.error(`[trigger-picks-omega-v1] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
