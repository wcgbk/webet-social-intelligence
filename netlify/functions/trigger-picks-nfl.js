// trigger-picks-nfl.js
// Scheduled function — daily at 15:00 UTC (11am ET), see netlify.toml.
// ALWAYS fires generate-picks-nfl-background. The generator writes a real card on
// NFL game days and "No NFL Games Scheduled For Today" on off days so /nfl never
// shows a stale last-game-day card.

exports.handler = async () => {
  const siteURL = process.env.URL || "https://webetsocial.com";
  console.log("[trigger-picks-nfl] Firing NFL generator (game-day vs no-games decided inside).");
  try {
    const response = await fetch(`${siteURL}/.netlify/functions/generate-picks-nfl-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
    });
    console.log(`[trigger-picks-nfl] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "NFL generation triggered" };
  } catch (err) {
    console.error(`[trigger-picks-nfl] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
