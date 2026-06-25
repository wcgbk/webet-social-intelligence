// webit-mock-pay.js — TEST-MODE WeBit pack purchase (Product Loop charter P0 item 3)
// Mock processor: validates the wbai session, credits the pack idempotently, writes an
// audit event to the `webit-ledger` store (one blob per event), and increments the
// canonical balance on the user record in `wbai-users` (the field /dashboard reads).
// Swaps to Stripe Checkout + signature-verified webhook when founder supplies keys (item 3b).

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

// Pack catalog mirrors /credits (founder-designed economy). Founder-editable.
const PACKS = {
  contributor: { credits: 5000,  label: 'Contributor',      price: '$100' },
  partner:     { credits: 10000, label: 'Liquidity Partner', price: '$200' },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* fallthrough */ }
  const pack = PACKS[body.pack];
  const idem = String(body.idem || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!pack) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'unknown_pack' }) };
  if (!idem || idem.length < 8) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing_idempotency_key' }) };

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

    // Idempotency: one blob per event, keyed on userId + client idem key.
    const ledger = getStore({ name: 'webit-ledger', siteID, token });
    const evtKey = `evt_${userId}_${idem}`;
    const existing = await ledger.get(evtKey, { type: 'json' }).catch(() => null);
    if (existing) {
      const bal = (await users.get(`user_${userId}`, { type: 'json' }).catch(() => null))?.credit_balance ?? userRecord.credit_balance ?? 1000;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, alreadyProcessed: true, credited: 0, newBalance: bal, mode: 'TEST' }) };
    }

    // Audit event first (append-only), then balance update on the canonical record.
    const evt = { userId, pack: body.pack, delta: pack.credits, price: pack.price, mode: 'TEST_MOCK_PROCESSOR', ts: new Date().toISOString() };
    await ledger.setJSON(evtKey, evt);

    const newBalance = (userRecord.credit_balance ?? 1000) + pack.credits;
    userRecord.credit_balance = newBalance;
    await users.setJSON(`user_${userId}`, userRecord);

    console.log(`[webit-mock-pay] TEST credit: ${userId} +${pack.credits} (${body.pack}) → ${newBalance}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, credited: pack.credits, newBalance, pack: pack.label, mode: 'TEST' }) };
  } catch (err) {
    console.error('[webit-mock-pay] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
