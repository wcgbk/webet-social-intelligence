// challenge-sms.js — Netlify Function
// Sends a Pick3P2P challenge text to a friend via Twilio

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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
    const { challengerName, friendPhone, wager } = JSON.parse(event.body || '{}');

    if (!challengerName || !challengerName.trim()) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Your name is required' }) };
    }
    if (!friendPhone || !/^\+1\d{10}$/.test(friendPhone)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid US phone number required (+1XXXXXXXXXX)' }) };
    }

    const wagerAmount = parseInt(wager) || 50;
    const name = challengerName.trim();

    const message = `${name} just challenged you to a Pick3P2P! Each of you picks 3 games, best record wins $${wagerAmount}. Make your picks now: https://pick3p2p.com`;

    // Send SMS via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const params = new URLSearchParams();
    params.append('To', friendPhone);
    params.append('From', TWILIO_PHONE_NUMBER);
    params.append('Body', message);

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

    // Store challenge in Netlify Blobs
    try {
      const store = getStore('p2p-challenges');
      const challengeId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await store.setJSON(challengeId, {
        id: challengeId,
        challenger: name,
        friendPhone,
        wager: wagerAmount,
        status: 'sent',
        created: new Date().toISOString(),
        smsSid: smsData.sid,
      });
    } catch (blobErr) {
      console.warn('Blobs storage skipped:', blobErr.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, sid: smsData.sid }),
    };
  } catch (err) {
    console.error('challenge-sms error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Failed to send challenge' }),
    };
  }
};
