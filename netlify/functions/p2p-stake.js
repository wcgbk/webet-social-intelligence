// p2p-stake.js — escrow WeBit on a Pick3P2P challenge (loop-c6, Pick3P2P integration v1)
// POST {challengeId, stake} with wbai_session cookie. Idempotent per user+challenge:
// one ledger debit event evt_{userId}_p2pstake_{challengeId} in webit-ledger, balance
// updated on the canonical wbai-users record. Payout/refund resolution reads these
// escrow events by challengeId (wired with check-resolution in a later cycle).

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
const ALLOWED_STAKES = new Set([50, 100, 250]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const stake = parseInt(body.stake, 10);
  const challengeId = String(body.challengeId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!ALLOWED_STAKES.has(stake)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_stake' }) };
  if (!challengeId || challengeId.length < 4) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_challenge' }) };

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionId = cookies['wbai_session'];
  if (!sessionId) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'not_authenticated' }) };

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_TOKEN;
    const users = getStore({ name: 'wbai-users', siteID, token });

    const sessionData = await users.get(`session_${sessionId}`, { type: 'json' }).catch(() => null);
    if (!sessionData || !sessionData.user_id) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid_session' }) };
    if (sessionData.expires && Date.now() > sessionData.expires) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'session_expired' }) };
    const userId = sessionData.user_id;
    const userRecord = await users.get(`user_${userId}`, { type: 'json' }).catch(() => null);
    if (!userRecord) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'user_not_found' }) };

    const ledger = getStore({ name: 'webit-ledger', siteID, token });
    const evtKey = `evt_${userId}_p2pstake_${challengeId}`;
    const existing = await ledger.get(evtKey, { type: 'json' }).catch(() => null);
    if (existing) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, alreadyEscrowed: true, stake: existing.delta ? -existing.delta : stake, balance: userRecord.credit_balance ?? 1000 }) };
    }

    const balance = userRecord.credit_balance ?? 1000;
    if (balance < stake) return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_webits', balance, stake }) };

    await ledger.setJSON(evtKey, { userId, delta: -stake, reason: 'p2p_stake_escrow', challengeId, ts: new Date().toISOString() });
    const newBalance = balance - stake;
    userRecord.credit_balance = newBalance;
    await users.setJSON(`user_${userId}`, userRecord);

    console.log(`[p2p-stake] ${userId} escrowed ${stake} on ${challengeId} (bal ${newBalance})`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stake, balance: newBalance, challengeId }) };
  } catch (err) {
    console.error('[p2p-stake] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
