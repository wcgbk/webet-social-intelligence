// get-picks-premium.js — WeBit-gated Sharp Depth (Product Loop: premium gate v1)
// POST with wbai_session cookie. Idempotent daily unlock: first call charges
// UNLOCK_COST_WEBITS (audit event in webit-ledger, one blob per event), repeat calls
// for the same day are free. Returns premium-only fields the public endpoints strip.
// READ-ONLY on edge-picks-alpha. Never writes to any edge-picks* store.

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
const UNLOCK_COST_WEBITS = 1; // founder-editable (charter spend rate: 1 WeBit = today's full depth)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionId = cookies['wbai_session'];
  if (!sessionId) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_TOKEN;
    const users = getStore({ name: 'wbai-users', siteID, token });

    const sessionData = await users.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
    if (!sessionData || !sessionData.user_id) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_session' }) };
    }
    if (sessionData.expires && Date.now() > sessionData.expires) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'session_expired' }) };
    }
    const userId = sessionData.user_id;
    const userRecord = await users.get(`user_${userId}`, { type: 'json' }).catch(() => null);
    if (!userRecord) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'user_not_found' }) };

    // Today's picks (READ-ONLY on the alpha store)
    const picksStore = getStore('edge-picks-alpha');
    let dateKey = null;
    const params = event.queryStringParameters || {};
    if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) dateKey = params.date;
    else {
      const latest = await picksStore.get('latest-date');
      dateKey = latest ? latest.trim() : null;
    }
    if (!dateKey) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'no_picks' }) };
    const picksData = await picksStore.get(`picks-${dateKey}`, { type: 'json' }).catch(() => null);
    if (!picksData || !(picksData.picks || []).length) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'no_picks', date: dateKey }) };
    }

    // Idempotent daily unlock: one charge per user per day, ever.
    const ledger = getStore({ name: 'webit-ledger', siteID, token });
    const unlockKey = `evt_${userId}_unlock_${dateKey}`;
    const already = await ledger.get(unlockKey, { type: 'json' }).catch(() => null);
    let balance = userRecord.credit_balance ?? 1000;

    if (!already) {
      if (balance < UNLOCK_COST_WEBITS) {
        return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_webits', balance, cost: UNLOCK_COST_WEBITS }) };
      }
      await ledger.setJSON(unlockKey, { userId, delta: -UNLOCK_COST_WEBITS, reason: 'sharp_depth_unlock', date: dateKey, ts: new Date().toISOString() });
      balance = balance - UNLOCK_COST_WEBITS;
      userRecord.credit_balance = balance;
      await users.setJSON(`user_${userId}`, userRecord);
      console.log(`[premium] ${userId} unlocked ${dateKey} (-${UNLOCK_COST_WEBITS}, bal ${balance})`);
    }

    // Premium-only depth per pick — exactly the fields the public endpoints strip.
    const depth = (picksData.picks || []).map(p => ({
      pick: p.pick,
      matchup: p.matchup,
      kellyCalc: p.kellyCalc || null,
      zScore: p.zScore != null ? p.zScore : null,
      evRaw: p.evRaw != null ? p.evRaw : null,
      coverProb: p.coverProb || null,
      modelEdge: p.modelEdge || null,
      whatLoses: p.whatLoses || null,
      clvExpectation: p.clvExpectation || null,
    }));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, date: dateKey, unlocked: true, alreadyUnlocked: !!already, cost: already ? 0 : UNLOCK_COST_WEBITS, balance, depth }),
    };
  } catch (err) {
    console.error('[premium] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
