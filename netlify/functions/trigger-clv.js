// trigger-clv.js
// Scheduled function — runs twice daily to capture closing lines for CLV tracking.
// 17:00 UTC (1pm EDT) for afternoon games, 23:00 UTC (7pm EDT) for evening games.
// Second run merges with first run — already-tracked picks are preserved.
// Schedule configured in netlify.toml: cron = "0 17,23 * * *"

exports.handler = async (event) => {
  const now = new Date();
  const hour = now.getUTCHours();
  const window = hour < 20 ? 'afternoon' : 'evening';
  console.log(`[trigger-clv] ${window} capture window — capturing closing lines`);

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(`${siteURL}/.netlify/functions/track-clv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled: true, window }),
    });

    const data = await response.json();
    console.log(`[trigger-clv] ${window}: ${data.totalTracked || 0}/${data.totalPicks || 0} picks tracked, avg CLV: ${data.avgCLVCents || 0} cents`);

    // NFL CLV is a sibling store (edge-picks-nfl). Fire-and-forget so an NFL miss
    // never blocks the hashed alpha tracker.
    try {
      const nfl = await fetch(`${siteURL}/.netlify/functions/track-clv-nfl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled: true, window }),
      });
      console.log(`[trigger-clv] NFL CLV: HTTP ${nfl.status}`);
    } catch (nflErr) {
      console.log(`[trigger-clv] NFL CLV skipped: ${nflErr.message}`);
    }

    return { statusCode: 200, body: `CLV ${window}: ${data.totalTracked}/${data.totalPicks} tracked` };
  } catch (err) {
    console.error(`[trigger-clv] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
