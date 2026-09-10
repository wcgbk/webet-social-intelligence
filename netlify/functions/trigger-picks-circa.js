// trigger-picks-circa.js
// Circa Million VIII weekly ATS card. See netlify.toml for UTC crons (PT comments).
// Intended windows (Sep = PDT = UTC-7):
//   Thu 17:15 UTC (10:15 AM PT) — first card after Circa lines post ~10:00 AM PT
//   Fri 17:00 UTC (10:00 AM PT) — refresh
//   Sat 20:00 UTC (1:00 PM PT)  — final, well before Sat 4:00 PM PT deadline
// Holiday TODO / implemented via the Wed slot in the union cron:
//   Thanksgiving week Wed Nov 25 2026 17:15 UTC
//   Christmas week    Wed Dec 23 2026 17:15 UTC
// Outside those windows the trigger no-ops (does not POST the generator) unless
// body.force is set. Generator itself no-ops outside the NFL regular season.

const { circaCronSlot } = require("./lib/circa-contest");

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const now = new Date();
  const slot = circaCronSlot(now);
  if (!body.force && !slot) {
    console.log(`[trigger-picks-circa] Outside contest cron window (${now.toISOString()}) — no-op.`);
    return { statusCode: 200, body: "Circa trigger no-op (outside Thu/Fri/Sat contest window)" };
  }

  const siteURL = process.env.URL || "https://webetsocial.com";
  console.log(`[trigger-picks-circa] Firing Circa generator (slot=${slot || "force"}).`);
  try {
    const response = await fetch(`${siteURL}/.netlify/functions/generate-picks-circa-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduled: true,
        slot: slot || "manual",
        timestamp: now.toISOString(),
        force: !!body.force,
        week: body.week || undefined,
      }),
    });
    console.log(`[trigger-picks-circa] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: `Circa generation triggered (${slot || "force"})` };
  } catch (err) {
    console.error(`[trigger-picks-circa] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
