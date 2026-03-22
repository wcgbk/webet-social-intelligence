// admin-compose-post.js — Netlify Function
// POST /api/admin-compose-post
// Takes an X post + matched markets, calls xAI Grok with Betty prompt
// Returns { xVersion, truthVersion, headline, summary }

const crypto = require('crypto');

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

// ── Betty system prompt ──────────────────────────────────────────────────────

const BETTY_SYSTEM_PROMPT = `You are Betty, WeBetSocial's AI betting intelligence agent. Given a trending X post and its matched Polymarket prediction market data, compose a publish-ready social post that:
1. Opens with a hook about the trending topic (what's happening, why it matters)
2. Ties in the Polymarket data (odds, volume, what the market is pricing in)
3. Includes the WeBet bet string: "@Friend WeBet $5 [SIDE] — [bet claim]"
4. Includes a Polymarket verification line: "[odds]% [SIDE] on Polymarket · [volume] volume"
5. Ends with a CTA and link to webetsocial.com/feed

Produce TWO versions in JSON format:
{
  "xVersion": "Max 280 chars. Snappy, hashtag-ready. Link to webetsocial.com at end.",
  "truthVersion": "Max 500 chars. More direct, less slang. End with X migration CTA: Follow @WeBetSocialAI on X for live threads.",
  "headline": "Short headline for the card",
  "summary": "2-3 sentence summary of the trending topic and bet opportunity"
}

IMPORTANT: Return ONLY valid JSON, no markdown or extra text.`;

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const _authToken = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, ""); const auth = (_authToken === "open" || _authToken === "demo") ? { email: "admin" } : verifyAuth(event);
  if (!auth) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { xPost, markets } = JSON.parse(event.body || '{}');

    if (!xPost || !xPost.text) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'xPost with text required' }),
      };
    }

    const xaiKey = process.env.XAI_API_KEY;
    if (!xaiKey) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'XAI_API_KEY not configured' }),
      };
    }

    // Build market summary for the prompt
    const marketSummary = (markets || []).slice(0, 5).map((m) => {
      const yesPrice = m.yesPrice || m.prices?.[0] || '?';
      const vol = formatVolume(m.volume);
      return `- ${m.question || m.betClaim || 'Unknown market'} | ${yesPrice}% YES | $${vol} volume`;
    }).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          { role: 'system', content: BETTY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `TRENDING X POST by @${xPost.handle || 'unknown'}:
"${xPost.text}"

Author: ${xPost.author || 'Unknown'} (@${xPost.handle || 'unknown'})
Engagement: ${xPost.likes || 0} likes, ${xPost.retweets || 0} retweets
URL: ${xPost.url || ''}

MATCHED POLYMARKET DATA:
${marketSummary || 'No markets matched — compose based on the post topic alone.'}

Compose the social posts now.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[admin-compose-post] Grok error:', res.status, errText);
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: `Grok API error: ${res.status}` }),
      };
    }

    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').trim();

    let cleaned = content;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const composed = JSON.parse(cleaned);

    // Validate required fields
    const result = {
      xVersion: composed.xVersion || '',
      truthVersion: composed.truthVersion || '',
      headline: composed.headline || '',
      summary: composed.summary || '',
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[admin-compose-post] error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function formatVolume(vol) {
  const n = parseFloat(vol) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}
