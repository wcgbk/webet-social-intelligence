/**
 * scan-ap-mentions.js — Scan Truth Social for @AP mentions
 *
 * Uses the Mastodon-compatible API to find people tagging @AP.
 * These are people who think they're talking to the Associated Press.
 *
 * GET /api/scan-ap-mentions?key=SECRET
 * Returns recent mentions with user info and content.
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const TRUTH_API = 'https://truthsocial.com/api/v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const authKey = event.queryStringParameters?.key;
  const secret = process.env.PICKS_SECRET || process.env.TRUTH_SECRET;
  if (secret && authKey !== secret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const token = process.env.TRUTH_SOCIAL_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'TRUTH_SOCIAL_TOKEN not configured',
        setup: 'Authenticate with Truth Social and set the bearer token in Netlify env vars',
      }),
    };
  }

  try {
    // Fetch notifications (mentions) from Truth Social
    const res = await fetch(`${TRUTH_API}/notifications?types[]=mention&limit=20`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ error: 'Truth Social API error', detail: errText }),
      };
    }

    const notifications = await res.json();

    // Also fetch our own timeline to see what we've already replied to
    let repliedIds = new Set();
    try {
      const verifyRes = await fetch(`${TRUTH_API}/accounts/verify_credentials`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (verifyRes.ok) {
        const account = await verifyRes.json();
        const statusesRes = await fetch(`${TRUTH_API}/accounts/${account.id}/statuses?limit=40`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (statusesRes.ok) {
          const statuses = await statusesRes.json();
          statuses.forEach(s => {
            if (s.in_reply_to_id) repliedIds.add(s.in_reply_to_id);
          });
        }
      }
    } catch (e) {
      console.log('Could not fetch reply history:', e.message);
    }

    // Process mentions
    const mentions = notifications
      .filter(n => n.type === 'mention' && n.status)
      .map(n => {
        const s = n.status;
        const account = s.account || {};
        // Strip HTML from content
        const text = (s.content || '').replace(/<[^>]+>/g, '').trim();

        return {
          id: s.id,
          text,
          author: account.display_name || account.username || 'Unknown',
          handle: account.acct || account.username || '',
          avatar: account.avatar,
          createdAt: s.created_at,
          url: s.url || s.uri,
          inReplyToId: s.in_reply_to_id,
          alreadyReplied: repliedIds.has(s.id),
          // Categorize the complaint
          category: categorizeComplaint(text),
        };
      })
      .filter(m => !m.alreadyReplied); // Only show unreplied mentions

    // Cache for dashboard
    try {
      const store = getStore('truth-mentions');
      await store.setJSON('latest', {
        scanned: new Date().toISOString(),
        mentions,
        total: notifications.length,
        unreplied: mentions.length,
      });
    } catch (e) {
      console.log('Cache write skipped:', e.message);
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'private, max-age=60' },
      body: JSON.stringify({
        scanned: new Date().toISOString(),
        mentions,
        total: notifications.length,
        unreplied: mentions.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function categorizeComplaint(text) {
  const t = text.toLowerCase();
  if (/left out|didn't mention|omit|missing|didn't report|failed to|forgot to/.test(t)) return 'omission';
  if (/word choice|framing|spin|narrative|mislead|manipulat/.test(t)) return 'framing';
  if (/fake|lie|liar|wrong|false|incorrect|misinform|disinform/.test(t)) return 'accuracy';
  if (/bias|lean|partisan|one-sided|slant/.test(t)) return 'bias';
  if (/remember when|last time|always do|every time|track record/.test(t)) return 'receipts';
  return 'general';
}
