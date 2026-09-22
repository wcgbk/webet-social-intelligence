'use strict';
/**
 * trigger-omega-shadow.js — 9:05 ET shadow dry-run.
 * POSTs generate-picks-omega-background with shadow:true.
 * That path writes ONLY omega-shadow/* inside edge-picks-omega.
 * It does not update latest-date, picks-dates, or live picks-{date}.
 * See docs/OMEGA-SHADOW-DRYRUN.md.
 */

exports.handler = async () => {
  console.log('[trigger-omega-shadow] Scheduled shadow dry-run (isolated omega-shadow/*)');
  const siteURL = process.env.URL || 'https://webetsocial.com';
  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/generate-picks-omega-background`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shadow: true,
          scheduled: true,
          force: true,
          skipNarrate: true,
          timestamp: new Date().toISOString(),
        }),
      }
    );
    console.log(`[trigger-omega-shadow] upstream status=${response.status}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, shadow: true, upstream: response.status }),
    };
  } catch (err) {
    console.error(`[trigger-omega-shadow] Failed: ${err.message}`);
    return { statusCode: 500, body: err.message };
  }
};
