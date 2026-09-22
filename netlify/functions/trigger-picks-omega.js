// trigger-picks-omega.js
// Scheduled — 9:30 AM ET (13:30 UTC during EDT) → generate-picks-omega-background (omega-vnext).
// Verify at 10:30am ET; public /omega live target ~11:00am ET.
// force:true — morning run must rebuild even if an early/overnight same-day card exists
// (OVERWRITE_GUARD otherwise keeps last night's picks and ignores 6/7:30/9 line snaps).

exports.handler = async (event) => {
  console.log("[trigger-picks-omega] Scheduled run triggered (omega-vnext)");

  const siteURL = process.env.URL || "https://webetsocial.com";

  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-omega-background`,
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

    console.log(`[trigger-picks-omega] Background function triggered: ${response.status}`);
    return { statusCode: 200, body: "Omega vNext triggered" };
  } catch (err) {
    console.error(`[trigger-picks-omega] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
