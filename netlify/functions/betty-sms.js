// betty-sms.js — Netlify Function
// Receives a phone number from the frontend, sends Betty's intro text via Twilio,
// and stores the conversation in Netlify Blobs for continuity.

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const BETTY_INTRO = `Hi! I'm Betty from WeBetAI — save me in your contacts!`;
const BETTY_HEADSHOT_URL = "https://imagine-public.x.ai/imagine-public/share-images/79ef03da-8e8d-4fc2-8aa7-2d8d645b5b7f.jpg?cache=1";
const BETTY_VCARD_URL = "https://webetsocial.com/betty.vcf";

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('Missing Twilio env vars');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'SMS service not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const phone = body.phone;
    const customMessage = body.message;
    const customMedia = body.mediaUrl;

    if (!phone || !/^\+1\d{10}$/.test(phone)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid US phone number required (+1XXXXXXXXXX)' }) };
    }

    // Send SMS via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const params = new URLSearchParams();
    params.append('To', phone);
    params.append('From', TWILIO_PHONE_NUMBER);
    params.append('Body', customMessage || BETTY_INTRO);
    if (customMedia) {
      params.append('MediaUrl', customMedia);
    } else {
      params.append('MediaUrl', BETTY_HEADSHOT_URL);
      params.append('MediaUrl', BETTY_VCARD_URL);
    }

    const twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!twilioRes.ok) {
      const errData = await twilioRes.json().catch(() => ({}));
      console.error('Twilio error:', twilioRes.status, errData);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Failed to send SMS: ' + (errData.message || twilioRes.status) }) };
    }

    const smsData = await twilioRes.json();

    // Store conversation via REST API
    try {
      const siteId = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
      const blobToken = process.env.NETLIFY_AUTH_TOKEN;
      const convoKey = phone.replace(/\D/g, '');
      const convoUrl = "https://api.netlify.com/api/v1/blobs/" + siteId + "/betty-conversations/" + convoKey;
      const blobHeaders = { "Authorization": "Bearer " + blobToken };

      var convo = { phone, started: new Date().toISOString(), messages: [] };
      try {
        var cResp = await fetch(convoUrl, { headers: blobHeaders });
        if (cResp.ok) { var saved = await cResp.json(); if (saved) convo = saved; }
      } catch (_) {}

      convo.messages.push({ role: 'assistant', content: customMessage || BETTY_INTRO, ts: new Date().toISOString() });
      if (convo.messages.length > 40) convo.messages = convo.messages.slice(-40);

      await fetch(convoUrl, {
        method: "PUT",
        headers: { ...blobHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(convo),
      });
    } catch (blobErr) {
      console.warn('Convo storage skipped:', blobErr.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, sid: smsData.sid }),
    };
  } catch (err) {
    console.error('betty-sms error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Failed to send text' }),
    };
  }
};
