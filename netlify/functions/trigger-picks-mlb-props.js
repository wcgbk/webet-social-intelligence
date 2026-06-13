// trigger-picks-mlb-props.js
// Scheduled function — runs daily at 10:00 AM EDT (14:00 UTC).
// Triggers the MLB Strikeout Props background function.

exports.handler = async (event) => {
  console.log("[trigger-picks-mlb-props] Scheduled run triggered");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-mlb-props-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );

    console.log(`[trigger-picks-mlb-props] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Triggered" };
  } catch (err) {
    console.error(`[trigger-picks-mlb-props] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
