// trigger-picks-cfb.js
// Scheduled function — daily at 13:10 UTC (9:10am ET), see netlify.toml.
// ALWAYS fires generate-picks-cfb-background. The generator writes a real card on
// college football game days and "No College Football Games Scheduled For Today" on
// off days so /cfb never shows a stale last-game-day card.

exports.handler = async () => {
  const siteURL = process.env.URL || "https://webetsocial.com";
  console.log("[trigger-picks-cfb] Firing CFB generator (game-day vs no-games decided inside).");
  try {
    const response = await fetch(`${siteURL}/.netlify/functions/generate-picks-cfb-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
    });
    console.log(`[trigger-picks-cfb] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "CFB generation triggered" };
  } catch (err) {
    console.error(`[trigger-picks-cfb] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
