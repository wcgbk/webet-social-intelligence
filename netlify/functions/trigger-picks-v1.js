'use strict';
/** Daily V1 trigger (Lock Spec v2.0) — 10:35 AM ET.
 *  Fires the V1 background generator (its own store/endpoint; Omega untouched).
 *  Cron in netlify.toml is UTC: "35 14 * * *" = 10:35 EDT. On the EST shift
 *  (Nov 1) it becomes 9:35 ET until moved to "35 15 * * *" — same prepared
 *  shift as the Omega clocks documented in netlify.toml. */
exports.handler = async () => {
  const base = process.env.URL || 'https://webetsocial.com';
  try {
    const r = await fetch(`${base}/.netlify/functions/generate-picks-v1-background`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'daily-trigger-v1' }) });
    return { statusCode: 200, body: JSON.stringify({ ok: true, triggered: r.status }) };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) }; }
};
