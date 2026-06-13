// send-bet-sms.js — Netlify Function
// Sends a WeBet challenge via Twilio SMS (same pattern as challenge-sms.js)

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
    const body = JSON.parse(event.body || '{}');
    const { senderName, friendName, friendPhone, claim, stake, side, betString } = body;

    if (!friendPhone) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Phone number is required' }) };
    }

    // Normalize phone: strip everything except digits, ensure +1 prefix
    let phone = friendPhone.replace(/\D/g, '');
    if (phone.length === 10) phone = '1' + phone;
    if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
    else phone = '+1' + phone.slice(-10);

    if (!/^\+1\d{10}$/.test(phone)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid US phone number required' }) };
    }

    const friend = (friendName || '').trim();
    const betUrl = body.betUrl || null;
    const betId = body.betId || null;
    const betLink = betUrl || (betId ? `https://webetsocial.com/bet/${betId}` : 'https://webetsocial.com/bet');

    // Build the SMS message
    let message;
    if (betString) {
      // New format: use the full Grok-generated WeBet string directly
      const greeting = friend ? `Hey ${friend}! ` : 'Hey! ';
      message = `${greeting}You've been challenged!\n\n` +
        `${betString}\n\n` +
        `No real money — just bragging rights. Accept, reject, or counter the bet here:\n${betLink}\n\n` +
        `— Betty from WeBetAI`;
    } else {
      // Legacy format fallback
      const sender = (senderName || 'Someone').trim();
      const betClaim = (claim || 'an outcome').trim();
      const betStake = parseInt(stake) || 5;
      const betSide = side || 'YES';
      const greeting = friend ? `Hey ${friend}! ` : '';
      message = `${greeting}${sender} sent you a WeBet!\n\n` +
        `${betSide} — ${betClaim}\n` +
        `Stake: ${betStake} AI Credits\n\n` +
        `No real money — just bragging rights.\n\n` +
        `Accept, Reject, or Counter:\n${betLink}`;
    }

    // Send via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const params = new URLSearchParams();
    params.append('To', phone);
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

    // Store bet record in Netlify Blobs
    try {
      const store = getStore('webet-sms-bets');
      const recordId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await store.setJSON(recordId, {
        id: recordId,
        betString: betString || null,
        friendName: friend || null,
        friendPhone: phone,
        betUrl: betLink,
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
    console.error('send-bet-sms error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Failed to send bet' }),
    };
  }
};
