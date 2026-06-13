// p2p-challenge.js — Pick3P2P Challenge Engine
// Handles: create challenge, get challenge, respond to challenge, list user challenges
// Blob store: p2p-challenges (keyed by challenge ID)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

async function blobGet(store, key) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

async function blobPut(store, key, data) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${key}`;
  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function blobList(store, prefix) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}?prefix=${prefix || ''}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.blobs || [];
  } catch { return []; }
}

function generateId() {
  return 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function upsertUser(store, phone, name, handle) {
  const digits = phone.replace(/\D/g, '');
  const key = 'user-' + digits;
  let user = await blobGet(store, key);
  if (!user) {
    user = {
      phone: digits,
      handle: handle || null,
      displayName: name || null,
      wins: 0, losses: 0, pushes: 0,
      totalWagered: 0, totalWon: 0, allTimePL: 0,
      currentStreak: 0, bestStreak: 0,
      createdAt: new Date().toISOString(),
    };
  }
  if (name && !user.displayName) user.displayName = name;
  if (handle && !user.handle) user.handle = handle;
  await blobPut(store, key, user);
  // Maintain handle index for lookups
  if (user.handle) {
    await blobPut(store, 'handle-' + user.handle.toLowerCase(), digits);
  }
  return user;
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function sendSMS(phone, message) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) return false;

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams();
  params.append('To', phone);
  params.append('From', TWILIO_PHONE_NUMBER);
  params.append('Body', message);

  const resp = await fetch(twilioUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return resp.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // GET — fetch challenge or list user challenges
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    // Get single challenge
    if (params.id) {
      const challenge = await blobGet('p2p-challenges', params.id);
      if (!challenge) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Challenge not found' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(challenge) };
    }

    // List challenges for a phone number
    if (params.phone) {
      const phone = normalizePhone(params.phone);
      if (!phone) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid phone' }) };
      }
      // Get user's challenge index
      const index = await blobGet('p2p-challenges', 'index-' + phone.replace(/\D/g, ''));
      if (!index || !index.challenges) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ challenges: [] }) };
      }
      // Fetch each challenge
      const challenges = [];
      for (const id of index.challenges.slice(0, 20)) {
        const ch = await blobGet('p2p-challenges', id);
        if (ch) challenges.push(ch);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ challenges }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide ?id= or ?phone=' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const action = body.action;

  // ── CREATE CHALLENGE ──
  if (action === 'create') {
    const { challengerPhone, challengerHandle, challengerName, picks, friendPhone, wager } = body;
    // deliver: 'sms' (default — we text the friend) | 'link' (challenger shares via X DM etc.)
    const deliver = body.deliver === 'link' ? 'link' : 'sms';

    if (!challengerPhone || !picks || !Array.isArray(picks) || picks.length !== 3) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Need challengerPhone and 3 picks' }) };
    }
    // Link mode: challenger identity may be a wbai account id (X users without a phone)
    const isWbaiId = /^wbai:/.test(String(challengerPhone));
    const normChallenger = isWbaiId ? String(challengerPhone).slice(0, 40) : normalizePhone(challengerPhone);
    const normFriend = deliver === 'link' ? null : normalizePhone(friendPhone);
    if (!normChallenger || (deliver === 'sms' && !normFriend)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid phone number(s)' }) };
    }

    const challengeId = generateId();
    const today = new Date().toISOString().slice(0, 10);

    const challenge = {
      id: challengeId,
      date: today,
      status: 'pending', // pending → active → graded
      wager: parseInt(wager) || 50,
      challenger: {
        phone: normChallenger,
        handle: challengerHandle || null,
        name: challengerName || null,
        picks: picks.map(p => ({
          sport: p.sport || '',
          matchup: p.matchup || '',
          side: p.sideName || p.side || '',
          type: p.type || 'avail',
          result: null,
        })),
      },
      opponent: {
        phone: normFriend,
        handle: null,
        name: null,
        picks: [],
      },
      deliver,
      created: new Date().toISOString(),
      responded: null,
      graded: null,
    };

    // Save challenge
    await blobPut('p2p-challenges', challengeId, challenge);

    // Create/update user records in p2p-users store
    await upsertUser('p2p-users', normChallenger, challengerName, challengerHandle);
    if (normFriend) await upsertUser('p2p-users', normFriend, null, null);

    // Update challenge indexes (friend only when known)
    for (const phone of [normChallenger, normFriend].filter(Boolean)) {
      const indexKey = 'index-' + phone.replace(/\D/g, '');
      const existing = await blobGet('p2p-challenges', indexKey) || { challenges: [] };
      existing.challenges.unshift(challengeId);
      existing.challenges = existing.challenges.slice(0, 50); // keep last 50
      await blobPut('p2p-challenges', indexKey, existing);
    }

    // Invite link lands on the unified same-domain experience (session + WeBits flow)
    const inviteUrl = `https://webetsocial.com/pick3p2p/?challenge=${challengeId}`;
    const picksText = picks.map((p, i) => `${i + 1}. ${p.sideName || p.side} (${p.sport})`).join('\n');
    const stakeLabel = challenge.wager > 0 ? `${challenge.wager} WeBits` : 'bragging rights';

    if (deliver === 'sms') {
      const smsMessage = `${challengerName || 'Someone'} challenged you on Pick3P2P for ${stakeLabel}!\n\nTheir picks:\n${picksText}\n\nPick your 3 and lock them in:\n${inviteUrl}`;
      await sendSMS(normFriend, smsMessage);
      // Confirm to challenger (only when they have a real phone)
      if (!isWbaiId) await sendSMS(normChallenger, `Challenge sent for ${stakeLabel}! Your picks:\n${picksText}\n\nYou'll get a text when they respond.`);
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ success: true, challengeId, challenge, inviteUrl }),
    };
  }

  // ── RESPOND TO CHALLENGE ──
  if (action === 'respond') {
    const { challengeId, responderPhone, responderHandle, responderName, picks } = body;

    if (!challengeId || !responderPhone || !picks || !Array.isArray(picks) || picks.length !== 3) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Need challengeId, responderPhone, and 3 picks' }) };
    }

    const challenge = await blobGet('p2p-challenges', challengeId);
    if (!challenge) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Challenge not found' }) };
    }
    if (challenge.status !== 'pending') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Challenge already responded to' }) };
    }

    const normResponder = normalizePhone(responderPhone);
    if (!normResponder) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid phone' }) };
    }

    // Update challenge with opponent's picks
    challenge.opponent.phone = normResponder;
    challenge.opponent.handle = responderHandle || null;
    challenge.opponent.name = responderName || null;
    challenge.opponent.picks = picks.map(p => ({
      sport: p.sport || '',
      matchup: p.matchup || '',
      side: p.sideName || p.side || '',
      type: p.type || 'avail',
      result: null,
    }));
    challenge.status = 'active';
    challenge.responded = new Date().toISOString();

    await blobPut('p2p-challenges', challengeId, challenge);

    // Update responder's user record
    await upsertUser('p2p-users', normResponder, responderName, responderHandle);

    // Notify both users
    const opponentPicks = challenge.opponent.picks.map((p, i) => `${i + 1}. ${p.side} (${p.sport})`).join('\n');
    const challengerPicks = challenge.challenger.picks.map((p, i) => `${i + 1}. ${p.side} (${p.sport})`).join('\n');

    // Notify challenger that opponent responded
    await sendSMS(challenge.challenger.phone,
      `${responderName || 'Your opponent'} accepted your $${challenge.wager} Pick3P2P!\n\nTheir picks:\n${opponentPicks}\n\nYour picks:\n${challengerPicks}\n\nGame on! Results post after final scores.\nhttps://pick3p2p.com/?challenge=${challengeId}`
    );

    // Confirm to responder
    await sendSMS(normResponder,
      `Locked in! $${challenge.wager} Pick3P2P vs ${challenge.challenger.name || 'opponent'}.\n\nYour picks:\n${opponentPicks}\n\nTheir picks:\n${challengerPicks}\n\nResults post after final scores.\nhttps://pick3p2p.com/?challenge=${challengeId}`
    );

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ success: true, challenge }),
    };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action. Use create or respond.' }) };
};
