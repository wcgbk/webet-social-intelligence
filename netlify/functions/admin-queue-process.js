// admin-queue-process.js — Netlify Scheduled Function
// Runs every 15 minutes
// Checks queue for posts with scheduledAt <= now and status 'scheduled'
// Publishes each one and updates status

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// ── Scheduled function config ────────────────────────────────────────────────
exports.config = { schedule: '*/15 * * * *' };

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

// ── Post to X (Twitter API v2) ──────────────────────────────────────────────

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

// ── Post to Truth Social ────────────────────────────────────────────────────

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
  console.log('[admin-queue-process] Checking queue for due posts');

  const queueStore = getStore('admin-queue');
  const postsStore = getStore('admin-posts');
  const now = new Date();

  // Get queue index
  let queueIndex = [];
  try {
    queueIndex = await queueStore.get('_index', { type: 'json' }) || [];
  } catch {
    queueIndex = [];
  }

  if (queueIndex.length === 0) {
    console.log('[admin-queue-process] Queue is empty');
    return { statusCode: 200, body: 'Queue empty' };
  }

  let published = 0;
  let failed = 0;
  const processedIds = [];

  for (const entry of queueIndex) {
    try {
      const item = await queueStore.get(entry.id, { type: 'json' });
      if (!item) continue;

      // Only process 'scheduled' items that are due
      if (item.status !== 'scheduled') continue;
      if (!item.scheduledAt) continue;

      const scheduledTime = new Date(item.scheduledAt);
      if (scheduledTime > now) continue; // Not due yet

      console.log(`[admin-queue-process] Publishing: ${entry.id}`);

      const platforms = item.platforms || ['x', 'truth'];
      let xPostId = null;
      let truthPostId = null;
      const errors = [];

      // Publish to X
      if (platforms.includes('x') && item.xText) {
        try {
          xPostId = await postToX(item.xText);
          console.log(`[admin-queue-process] Published to X: ${xPostId}`);
        } catch (err) {
          console.error(`[admin-queue-process] X publish failed:`, err.message);
          errors.push({ platform: 'x', error: err.message });
        }
      }

      // Publish to Truth Social
      if (platforms.includes('truth') && item.truthText) {
        try {
          truthPostId = await postToTruthSocial(item.truthText);
          console.log(`[admin-queue-process] Published to Truth Social: ${truthPostId}`);
        } catch (err) {
          console.error(`[admin-queue-process] Truth Social publish failed:`, err.message);
          errors.push({ platform: 'truth', error: err.message });
        }
      }

      // Determine status
      let status;
      if (xPostId && truthPostId) {
        status = 'published_both';
      } else if (xPostId) {
        status = 'published_x';
      } else if (truthPostId) {
        status = 'published_truth';
      } else {
        status = 'failed';
        failed++;
      }

      if (status !== 'failed') published++;

      // Save to posts store
      const postRecord = {
        id: item.id,
        xText: item.xText || '',
        truthText: item.truthText || '',
        platforms,
        xPostId,
        truthPostId,
        status,
        sourcePost: item.sourcePost || null,
        markets: item.markets || [],
        category: item.category || 'trending',
        publishedAt: new Date().toISOString(),
        createdAt: item.createdAt,
        scheduledAt: item.scheduledAt,
        engagement: {
          x: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
          truth: { likes: 0, reblogs: 0, replies: 0 },
        },
        publishErrors: errors.length > 0 ? errors : undefined,
      };

      await postsStore.setJSON(item.id, postRecord);

      // Update posts index
      await updatePostIndex(postsStore, item.id, postRecord.publishedAt);

      // Update queue item status (mark as processed)
      item.status = status;
      item.xPostId = xPostId;
      item.truthPostId = truthPostId;
      item.processedAt = new Date().toISOString();
      await queueStore.setJSON(entry.id, item);

      processedIds.push(entry.id);
    } catch (err) {
      console.error(`[admin-queue-process] Error processing ${entry.id}:`, err.message);
      failed++;
    }
  }

  // Clean processed items from queue index
  if (processedIds.length > 0) {
    const updatedIndex = queueIndex.filter((entry) => !processedIds.includes(entry.id));
    await queueStore.setJSON('_index', updatedIndex);

    // Delete processed items from queue store
    for (const id of processedIds) {
      try {
        await queueStore.delete(id);
      } catch {}
    }
  }

  console.log(`[admin-queue-process] Done: ${published} published, ${failed} failed`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      published,
      failed,
      processed: processedIds.length,
      timestamp: new Date().toISOString(),
    }),
  };
};

// ── Post index management ────────────────────────────────────────────────────

async function updatePostIndex(store, postId, timestamp) {
  try {
    let index = [];
    try {
      index = await store.get('_index', { type: 'json' }) || [];
    } catch {}

    index.unshift({ id: postId, ts: timestamp });
    if (index.length > 500) index = index.slice(0, 500);

    await store.setJSON('_index', index);
  } catch (err) {
    console.error('[admin-queue-process] index update failed:', err.message);
  }
}
