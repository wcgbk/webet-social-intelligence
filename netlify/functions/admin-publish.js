// admin-publish.js — Netlify Function
// POST /api/admin-publish
// Publishes posts to X (Twitter API v2) and/or Truth Social
// Supports immediate publish or scheduling to queue

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Auth helper ──────────────────────────────────────────────────────────────

function verifyAuth(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const secret = process.env.ADMIN_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, hmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  if (hmac.length !== expectedHmac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload.email || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── OAuth 1.0a for X API v2 ─────────────────────────────────────────────────

function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function generateOAuthSignature(method, baseUrl, params, consumerSecret, tokenSecret) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`).join('&');
  const signatureBase = `${method}&${encodeRFC3986(baseUrl)}&${encodeRFC3986(paramString)}`;
  const signingKey = `${encodeRFC3986(consumerSecret)}&${encodeRFC3986(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

async function postToX(text) {
  const consumerKey = process.env.TWITTER_CONSUMER_KEY;
  const consumerSecret = process.env.TWITTER_CONSUMER_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error('Twitter OAuth credentials not configured');
  }

  const baseUrl = 'https://api.twitter.com/2/tweets';

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const signature = generateOAuthSignature('POST', baseUrl, oauthParams, consumerSecret, accessTokenSecret);
  oauthParams.oauth_signature = signature;

  const authHeader = 'OAuth ' + Object.keys(oauthParams).sort().map((k) =>
    `${encodeRFC3986(k)}="${encodeRFC3986(oauthParams[k])}"`
  ).join(', ');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const res = await fetch(baseUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`X API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  return data.data?.id || null;
}

// ── Truth Social posting ────────────────────────────────────────────────────

async function postToTruthSocial(text) {
  const token = process.env.TRUTH_SOCIAL_TOKEN;
  if (!token) {
    throw new Error('TRUTH_SOCIAL_TOKEN not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const res = await fetch('https://truthsocial.com/api/v1/statuses', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: text }),
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Truth Social API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  return data.id || null;
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = verifyAuth(event);
  if (!auth) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      postId,
      xText,
      truthText,
      platforms = [],
      publishNow = true,
      scheduledAt,
      sourcePost,
      markets,
      category,
    } = body;

    if (!xText && !truthText) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'At least xText or truthText required' }),
      };
    }

    const id = postId || crypto.randomUUID();
    const now = new Date().toISOString();

    // ── If scheduling for later, save to queue ──────────────────────────
    if (!publishNow && scheduledAt) {
      const queueStore = getStore('admin-queue');
      const queueItem = {
        id,
        xText: xText || '',
        truthText: truthText || '',
        platforms,
        scheduledAt,
        status: 'scheduled',
        queuePosition: 0,
        sourcePost: sourcePost || null,
        markets: markets || [],
        category: category || 'trending',
        createdAt: now,
        updatedAt: now,
      };

      await queueStore.setJSON(id, queueItem);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ postId: id, status: 'scheduled', scheduledAt }),
      };
    }

    // ── Publish now ─────────────────────────────────────────────────────
    const results = {
      postId: id,
      xPostId: null,
      truthPostId: null,
      status: 'published',
      errors: [],
    };

    // Publish to X
    if (platforms.includes('x') && xText) {
      try {
        results.xPostId = await postToX(xText);
        console.log(`[admin-publish] Published to X: ${results.xPostId}`);
      } catch (err) {
        console.error('[admin-publish] X publish failed:', err.message);
        results.errors.push({ platform: 'x', error: err.message });
      }
    }

    // Publish to Truth Social
    if (platforms.includes('truth') && truthText) {
      try {
        results.truthPostId = await postToTruthSocial(truthText);
        console.log(`[admin-publish] Published to Truth Social: ${results.truthPostId}`);
      } catch (err) {
        console.error('[admin-publish] Truth Social publish failed:', err.message);
        results.errors.push({ platform: 'truth', error: err.message });
      }
    }

    // Determine final status
    if (results.xPostId && results.truthPostId) {
      results.status = 'published_both';
    } else if (results.xPostId) {
      results.status = 'published_x';
    } else if (results.truthPostId) {
      results.status = 'published_truth';
    } else if (results.errors.length > 0) {
      results.status = 'failed';
    }

    // ── Save post record ────────────────────────────────────────────────
    const postsStore = getStore('admin-posts');
    const postRecord = {
      id,
      xText: xText || '',
      truthText: truthText || '',
      platforms,
      xPostId: results.xPostId,
      truthPostId: results.truthPostId,
      status: results.status,
      sourcePost: sourcePost || null,
      markets: markets || [],
      category: category || 'trending',
      publishedAt: now,
      createdAt: now,
      engagement: {
        x: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
        truth: { likes: 0, reblogs: 0, replies: 0 },
      },
    };

    await postsStore.setJSON(id, postRecord);

    // Also maintain an index for listing
    await updatePostIndex(postsStore, id, now);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(results),
    };
  } catch (err) {
    console.error('[admin-publish] error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Post index management ────────────────────────────────────────────────────

async function updatePostIndex(store, postId, timestamp) {
  try {
    let index = [];
    try {
      index = await store.get('_index', { type: 'json' }) || [];
    } catch {}

    index.unshift({ id: postId, ts: timestamp });

    // Keep last 500 entries
    if (index.length > 500) index = index.slice(0, 500);

    await store.setJSON('_index', index);
  } catch (err) {
    console.error('[admin-publish] index update failed:', err.message);
  }
}
