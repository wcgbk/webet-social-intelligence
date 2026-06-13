// funnel-report.js — admin-only aggregation of funnel-events for the founder dashboard.
// GET /.netlify/functions/funnel-report
// 1. Validates the wbai_session cookie against the wbai-users store (same as auth-me).
// 2. Gates on an admin allowlist stored at wbai-users key `admin-allowlist`
//    (JSON array of userIds). If that blob is missing, the list is treated as EMPTY
//    and every caller gets 403 — see admin/funnel/README.md for how to seed it.
// 3. Lists the funnel-events store via the @netlify/blobs SDK (explicit name/siteID/token).
//    NOTE: the SDK and the legacy REST blob APIs are SEPARATE namespaces. funnel-events
//    is written by funnel-event.js via the SDK, so it MUST be read via the SDK here —
//    a REST list of this store returns empty.
// 4. Aggregates counts per event type per day for the last 14 days and returns JSON.

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  str.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

const CORS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SITE_ID = process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

// Event types the report surfaces, in funnel order. Anything else is still counted
// and returned, but the page renders these explicitly.
const TRACKED_EVENTS = [
  'onboard_shown', 'onboard_sports_chosen', 'onboard_edges_shown',
  'onboard_signin_clicked', 'onboard_prefs_saved', 'onboard_skipped',
  'login_view', 'pricing_view', 'checkout_view', 'checkout_paid', 'depth_unlock',
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  const sessionId = parseCookies(event.headers.cookie || event.headers.Cookie || '')['wbai_session'];
  if (!sessionId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const token = process.env.NETLIFY_TOKEN;
    const users = getStore({ name: 'wbai-users', siteID: SITE_ID, token });

    // --- Session -> userId ---
    const session = await users.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
    if (!session || !session.user_id || (session.expires && Date.now() > session.expires)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_session' }) };
    }
    const userId = String(session.user_id);

    // --- Admin gate. Missing allowlist blob => empty list => 403 for everyone. ---
    const allowlist = await users.get('admin-allowlist', { type: 'json' }).catch(() => null);
    const admins = Array.isArray(allowlist) ? allowlist.map(String) : [];
    if (!admins.includes(userId)) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    // --- Last 14 ET days (inclusive of today). Day strings sort lexicographically. ---
    const DAYS = 14;
    const fmt = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    const cutoff = fmt(new Date(today.getTime() - (DAYS - 1) * 86400000));
    const dayList = [];
    for (let i = DAYS - 1; i >= 0; i--) dayList.push(fmt(new Date(today.getTime() - i * 86400000)));

    // --- List funnel-events (SDK namespace), paginating through the cursor. ---
    const store = getStore({ name: 'funnel-events', siteID: SITE_ID, token });
    const keys = [];
    let cursor;
    do {
      const page = await store.list(cursor ? { cursor } : undefined);
      for (const b of (page.blobs || [])) {
        // Key format: evt_<YYYY-MM-DD>_<ts>_<rand>. Filter by the embedded day cheaply.
        const day = (b.key || '').split('_')[1] || '';
        if (day >= cutoff) keys.push(b.key);
      }
      cursor = page.cursor;
    } while (cursor);

    // --- Fetch bodies in bounded batches; aggregate count per event per day. ---
    const counts = {}; // day -> { eventType -> count }
    dayList.forEach(d => { counts[d] = {}; });
    const seenEvents = new Set();
    const BATCH = 50;
    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      const rows = await Promise.all(slice.map(k => store.get(k, { type: 'json' }).catch(() => null)));
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        if (!row || !row.e) continue;
        const day = (slice[j] || '').split('_')[1] || '';
        if (!counts[day]) continue; // out of window (shouldn't happen post-filter)
        counts[day][row.e] = (counts[day][row.e] || 0) + 1;
        seenEvents.add(row.e);
      }
    }

    // Stable event ordering: tracked events first (funnel order), then any extras seen.
    const extras = [...seenEvents].filter(e => !TRACKED_EVENTS.includes(e)).sort();
    const eventOrder = [...TRACKED_EVENTS, ...extras];

    // Totals per event across the window.
    const totals = {};
    eventOrder.forEach(e => {
      totals[e] = dayList.reduce((sum, d) => sum + (counts[d][e] || 0), 0);
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        windowDays: DAYS,
        days: dayList,
        events: eventOrder,
        trackedEvents: TRACKED_EVENTS,
        counts,
        totals,
        eventsScanned: keys.length,
      }),
    };
  } catch (err) {
    console.error('[funnel-report] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
