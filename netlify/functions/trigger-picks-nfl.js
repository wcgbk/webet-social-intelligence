// trigger-picks-nfl.js
// Scheduled function — daily at 15:00 UTC (11am ET), see netlify.toml.
// GATED: fires generate-picks-nfl-background ONLY on days with NFL games (preseason or
// regular season, per the ESPN scoreboard). Quiet no-op on off days — the NFL pipeline
// runs only when there is NFL football.

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

exports.handler = async () => {
  const dateISO = getEasternDateToday();
  console.log(`[trigger-picks-nfl] Scheduled check for ${dateISO}`);

  // Game-day gate — ESPN NFL scoreboard for today (ET). Includes preseason (seasontype 1).
  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateISO.replace(/-/g, "")}`);
    if (resp.ok) {
      const data = await resp.json();
      const count = (data.events || []).length;
      if (count === 0) {
        console.log("[trigger-picks-nfl] No NFL games today — skipping generation.");
        return { statusCode: 200, body: "No NFL games today — skipped" };
      }
      console.log(`[trigger-picks-nfl] ${count} NFL game(s) today — firing generator.`);
    } else {
      console.log(`[trigger-picks-nfl] ESPN check HTTP ${resp.status} — firing generator anyway (it re-checks).`);
    }
  } catch (e) {
    console.log(`[trigger-picks-nfl] ESPN check failed (${e.message}) — firing generator anyway (it re-checks).`);
  }

  const siteURL = process.env.URL || "https://webetsocial.com";
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
