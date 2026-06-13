// auth-sms-start.js — SMS login step 1: send a 6-digit code (loop-c5, charter /login gateway)
// POST {phone}. Uses the existing Twilio Messages API (Betty's number) — no Verify service
// needed. OTP state lives server-side in wbai-users (sms_otp_{phone}); code never returned.
// Rate limits: 3 sends/phone/hour, 10 sends/IP/hour (OTP-pumping fraud is a real Twilio cost).

const { createHmac, randomInt } = require('crypto');

const CORS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const SEND_LIMIT_PHONE = 3, SEND_LIMIT_IP = 10, WINDOW_MS = 60 * 60 * 1000, OTP_TTL_MS = 10 * 60 * 1000;

function normPhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d;
  const digits = d.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;            // US default
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !tok || !from) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'sms_not_configured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const phone = normPhone(body.phone);
  if (!phone) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid_phone' }) };
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'wbai-users', siteID: process.env.NETLIFY_SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606', token: process.env.NETLIFY_TOKEN });
    const now = Date.now();

    // Rate limit: per IP
    const ipKey = `sms_ip_${ip.replace(/[^a-zA-Z0-9.:]/g, '')}`;
    const ipRec = (await store.get(ipKey, { type: 'json' }).catch(() => null)) || { sends: [] };
    ipRec.sends = (ipRec.sends || []).filter(t => now - t < WINDOW_MS);
    if (ipRec.sends.length >= SEND_LIMIT_IP) return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'too_many_requests' }) };

    // Rate limit: per phone (reuse otp record)
    const otpKey = `sms_otp_${phone}`;
    const prev = (await store.get(otpKey, { type: 'json' }).catch(() => null)) || {};
    const sends = (prev.sends || []).filter(t => now - t < WINDOW_MS);
    if (sends.length >= SEND_LIMIT_PHONE) return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'too_many_codes', retryMinutes: 60 }) };

    const code = String(randomInt(100000, 1000000));
    const codeHash = createHmac('sha256', tok).update(code + ':' + phone).digest('hex');
    sends.push(now);
    await store.setJSON(otpKey, { codeHash, expires: now + OTP_TTL_MS, attempts: 0, sends, ip });
    ipRec.sends.push(now);
    await store.setJSON(ipKey, ipRec);

    // Send via Twilio Messages API
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: `WeBetAI code: ${code}\nExpires in 10 minutes. Never share this code.` }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error('[auth-sms-start] Twilio error:', resp.status, t.slice(0, 200));
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'sms_send_failed' }) };
    }
    console.log(`[auth-sms-start] code sent to ${phone.slice(0, 5)}•••`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[auth-sms-start] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_error' }) };
  }
};
