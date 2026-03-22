// admin-history.js — Netlify Function
// GET /api/admin-history?platform=x|truth|both&from=date&to=date&search=keyword&page=1&limit=20
// Returns paginated post history from Netlify Blobs store 'admin-posts'

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = verifyAuth(event);
  if (!auth) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const platform = params.platform || 'both'; // 'x', 'truth', 'both'
    const fromDate = params.from ? new Date(params.from) : null;
    const toDate = params.to ? new Date(params.to) : null;
    const search = (params.search || '').toLowerCase().trim();
    const page = Math.max(parseInt(params.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(params.limit) || 20, 1), 100);

    const store = getStore('admin-posts');

    // Get the post index
    let index = [];
    try {
      index = await store.get('_index', { type: 'json' }) || [];
    } catch {
      index = [];
    }

    // Sort index by timestamp descending (newest first)
    index.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    // Pre-filter by date range using index timestamps
    let filteredIndex = index;
    if (fromDate) {
      filteredIndex = filteredIndex.filter((entry) => new Date(entry.ts) >= fromDate);
    }
    if (toDate) {
      filteredIndex = filteredIndex.filter((entry) => new Date(entry.ts) <= toDate);
    }

    // Fetch posts (we need to load them for platform/search filtering)
    const posts = [];
    for (const entry of filteredIndex) {
      try {
        const post = await store.get(entry.id, { type: 'json' });
        if (!post) continue;

        // Platform filter
        if (platform === 'x' && !post.xPostId) continue;
        if (platform === 'truth' && !post.truthPostId) continue;

        // Search filter
        if (search) {
          const searchable = [
            post.xText || '',
            post.truthText || '',
            post.sourcePost?.text || '',
            post.sourcePost?.author || '',
            post.sourcePost?.handle || '',
            post.category || '',
          ].join(' ').toLowerCase();

          if (!searchable.includes(search)) continue;
        }

        posts.push(post);
      } catch {}
    }

    // Paginate
    const total = posts.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginated = posts.slice(offset, offset + limit);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        posts: paginated,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      }),
    };
  } catch (err) {
    console.error('[admin-history] error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
