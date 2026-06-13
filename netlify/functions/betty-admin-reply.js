// betty-admin-reply.js — Admin endpoint: send a message as Betty to a user via SMS
// POST /api/betty-admin-reply
// Body: { phone, message, key }
// Sends SMS via Twilio and stores in conversation history blob

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { phone, message, key } = body;

    // Auth
    const secret = process.env.PICKS_SECRET_KEY;
    if (secret && key !== secret) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const mediaUrl = body.mediaUrl || '';

    if (!phone || (!message && !mediaUrl)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'phone and message or mediaUrl required' }) };
    }

    // Normalize phone
    let toPhone = phone.replace(/\D/g, '');
    if (toPhone.length === 10) toPhone = '1' + toPhone;
    if (!toPhone.startsWith('+')) toPhone = '+' + toPhone;

    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Twilio not configured' }) };
    }

    // Send SMS via Twilio
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', toPhone);
    params.append('From', TWILIO_PHONE_NUMBER);
    if (message) params.append('Body', message);
    if (mediaUrl) params.append('MediaUrl', mediaUrl);

    const twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!twilioRes.ok) {
      const err = await twilioRes.json().catch(() => ({}));
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'SMS failed: ' + (err.message || twilioRes.status) }) };
    }

    const smsData = await twilioRes.json();

    // Store in conversation history
    const convoKey = toPhone.replace(/\D/g, '');
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const convoUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/betty-conversations/${convoKey}`;
    const blobHeaders = { 'Authorization': `Bearer ${token}` };

    let convo = { phone: toPhone, started: new Date().toISOString(), messages: [] };
    try {
      const cResp = await fetch(convoUrl, { headers: blobHeaders });
      if (cResp.ok) {
        const saved = await cResp.json();
        if (saved) convo = saved;
      }
    } catch (_) {}

    convo.messages.push({ role: 'assistant', content: message || (mediaUrl ? '[Image]' : ''), mediaUrl: mediaUrl || undefined, ts: new Date().toISOString() });
    if (convo.messages.length > 40) convo.messages = convo.messages.slice(-40);

    try {
      await fetch(convoUrl, {
        method: 'PUT',
        headers: { ...blobHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(convo),
      });
    } catch (_) {}

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ success: true, sid: smsData.sid }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
