// auth-sms-verify.js — SMS login step 2: verify code, mint session (loop-c5)
// POST {phone, code}. Mirrors auth-x-callback's session pattern exactly:
// user_{id} + session_{sessionId} in wbai-users, wbai_session cookie (30d).
// SMS-first accounts get provider:'sms', 1,000 WeBit, phone-masked handle.
// (Linking an SMS account to an X account = canonical-identity backlog item.)

const { createHmac, randomBytes } = require('crypto');
const CORS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const MAX_ATTEMPTS = 8;

function normPhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d;
  const digits = d.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!tok) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'sms_not_configured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const phone = normPhone(body.phone);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_input' }) };

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'wbai-users', siteID: process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606', token: process.env.NETLIFY_TOKEN });
    const otpKey = `sms_otp_${phone}`;
    const otp = await store.get(otpKey, { type: 'json' }).catch(() => null);
    const now = Date.now();

    if (!otp || !otp.codeHash) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'no_code_requested' }) };
    if (now > (otp.expires || 0)) { await store.delete(otpKey).catch(() => {}); return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'code_expired' }) }; }
    if ((otp.attempts || 0) >= MAX_ATTEMPTS) { await store.delete(otpKey).catch(() => {}); return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'too_many_attempts' }) }; }

    const expected = otp.codeHash;
    const got = createHmac('sha256', tok).update(code + ':' + phone).digest('hex');
    if (got !== expected) {
      otp.attempts = (otp.attempts || 0) + 1;
      await store.setJSON(otpKey, otp);
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'wrong_code', attemptsLeft: MAX_ATTEMPTS - otp.attempts }) };
    }
    await store.delete(otpKey).catch(() => {});

    // Find-or-create the SMS-first user (id keyed on digits; phone stored for display/linking)
    const userId = 'sms_' + phone.replace(/\D/g, '');
    const nowISO = new Date().toISOString();
    const existing = await store.get(`user_${userId}`, { type: 'json' }).catch(() => null);
    const userRecord = existing || {
      id: userId,
      name: 'WeBetAI Member',
      handle: '•••' + phone.slice(-4),
      phone,
      avatar_url: null,
      provider: 'sms',
      credit_balance: 1000,
      welcome_grant: true,
      created_at: nowISO,
    };
    if (!userRecord.welcome_grant) {
      const bal = Number(userRecord.credit_balance);
      userRecord.credit_balance = Number.isFinite(bal) ? Math.max(bal, 1000) : 1000;
      userRecord.welcome_grant = true;
    }
    userRecord.last_seen = nowISO;
    userRecord.phone = phone;
    await store.setJSON(`user_${userId}`, userRecord);

    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await store.setJSON(`session_${sessionId}`, { user_id: userId, expires: sessionExpiry });

    const sessionCookie = `wbai_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
    console.log(`[auth-sms-verify] login ok for ${phone.slice(0, 5)}••• (${existing ? 'returning' : 'new'} user)`);
    return {
      statusCode: 200,
      multiValueHeaders: { 'Set-Cookie': [sessionCookie] },
      headers: CORS,
      body: JSON.stringify({ ok: true, newUser: !existing }),
    };
  } catch (err) {
    console.error('[auth-sms-verify] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
