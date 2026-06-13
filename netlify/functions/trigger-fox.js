// trigger-fox.js
// Scheduled function — runs daily at 10:30 AM EDT (14:30 UTC).
// Triggers the FOX 3-AI consensus background function.
// Schedule configured in netlify.toml

exports.handler = async (event) => {
  console.log("[trigger-fox] Scheduled run triggered");
  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-fox-background`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );
    console.log(`[trigger-fox] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Triggered" };
  } catch (err) {
    console.error(`[trigger-fox] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
