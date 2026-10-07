// trigger-picks-circa.js
// Circa Million VIII weekly ATS card. Windows are America/Los_Angeles wall times.
// The ET guard drops the other UTC hour. PT and ET switch DST together, so
// 10:15 AM PT stays 1:15 PM ET in both PDT and PST.
//   Thu 10:15 / 10:30 / 10:45 / 11:00 PT — first card + late-PDF catch-up
//   Fri 10:00–10:45 PT — refresh + fixture catch-up
//   Sat 1:00 PM PT — final, well before Sat 4:00 PM PT deadline
//   Holiday Wednesday 10:15 PT (2026-11-25 Thanksgiving, 2026-12-23 Christmas)
// Outside those windows the trigger no-ops (does not POST the generator) unless
// body.force is set. Generator itself no-ops outside the NFL regular season.

const { circaCronSlot } = require("./lib/circa-contest");
const { rejectUnlessEtSlot } = require("./lib/et-schedule");

exports.handler = async (event) => {
  const etSkip = rejectUnlessEtSlot("trigger-picks-circa", event);
  if (etSkip) return etSkip;
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
