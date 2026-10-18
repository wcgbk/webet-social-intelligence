// trigger-trend-monitor.js
// Scheduled function — runs daily at 01:00 UTC (9pm EDT), after the 23:00 track-clv settle.
// Fires the trend-monitor HTTP function so its ALARM snapshot (trend-monitor-latest blob)
// refreshes every night. Mirrors the trigger-picks-alpha pattern so trend-monitor stays a
// plain HTTP function (reliably reachable on-demand at /api/trend-monitor).

exports.handler = async () => {
  console.log("[trigger-trend-monitor] Scheduled run triggered");
  const siteURL = process.env.URL || "https://webetsocial.com";
  try {
    const response = await fetch(`${siteURL}/.netlify/functions/trend-monitor`, { method: "GET" });
    console.log(`[trigger-trend-monitor] trend-monitor invoked: ${response.status}`);
    return { statusCode: 200, body: "trend-monitor triggered" };
  } catch (err) {
    console.error(`[trigger-trend-monitor] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
