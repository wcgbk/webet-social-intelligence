// trigger-picks-omega.js
// Scheduled — 9:30 AM ET → generate-picks-omega-background (omega-vnext).
// Both UTC hours fire; etGuard keeps the 9:30 ET one. A scheduler invoke skips
// only when picks-{ET date} already has generatedAt on that ET date at/after
// 09:20 ET (09:30 minus the guard tolerance) — the morning run already wrote it.
// An earlier same-day card (overnight or pre-window) still force-rebuilds.
// Manual/HTTP still force-triggers. Verify at 10:30am ET; public /omega ~11:00am ET.

const { rejectUnlessEtSlot, morningCardIdempotency, idempotencySkipResponse } = require('./lib/et-schedule');

async function readCardBlob(dateET) {
  const { readPicks } = require('./lib/omega-vnext/store');
  return readPicks(dateET);
}

exports.handler = async (event, context) => {
  const now = (context && context.now instanceof Date) ? context.now : new Date();
  const etSkip = rejectUnlessEtSlot('trigger-picks-omega', event, now);
  if (etSkip) return etSkip;
  const readCard = (context && typeof context.readCard === 'function') ? context.readCard : readCardBlob;
  const idem = await morningCardIdempotency(event, now, readCard);
  if (idem.skip) return idempotencySkipResponse(idem);

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
