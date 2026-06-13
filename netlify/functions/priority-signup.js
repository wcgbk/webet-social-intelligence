// /api/priority-signup — stores priority access signups in Netlify Blobs
// GET  ?action=count  → returns { count }
// POST { email, phone?, source? } → stores signup, returns { message }

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const store = getStore('priority-signups');

  // GET — return count (or full list with admin key)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    // Admin: full list
    if (params.action === 'list') {
      const key = params.key;
      if (key !== process.env.ADMIN_KEY) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      const index = await loadIndex(store);
      return { statusCode: 200, headers, body: JSON.stringify({ count: index.length, signups: index }) };
    }

    // Public: just count
    const index = await loadIndex(store);
    return { statusCode: 200, headers, body: JSON.stringify({ count: index.length }) };
  }

  // POST — new signup
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const email = (body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || !email.includes('.')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
    }

    const phone = (body.phone || '').trim();
    const source = (body.source || 'direct').trim();

    // Load existing index
    const index = await loadIndex(store);

    // Check duplicate
    if (index.some(s => s.email === email)) {
      return { statusCode: 200, headers, body: JSON.stringify({ message: "You're already on the list! We'll be in touch." }) };
    }

    // Add new signup
    const signup = {
      email,
      phone: phone || null,
      source,
      ts: new Date().toISOString(),
    };
    index.push(signup);

    // Save updated index
    await store.setJSON('index', index);

    console.log(`Priority signup #${index.length}: ${email} (source: ${source})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: "You're on the priority list! We'll notify you before anyone else.",
        position: index.length,
      }),
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

async function loadIndex(store) {
  try {
    return await store.get('index', { type: 'json' }) || [];
  } catch {
    return [];
  }
}
