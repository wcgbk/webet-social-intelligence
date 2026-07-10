// admin-sniper.js — Netlify Function
// POST /api/admin-sniper
// Generates an engaging WeBet reply for a trending post using xAI Grok

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SNIPER_PROMPT = `You are WeBetAI's Comment Sniper — a sharp, witty social media engagement agent. Your job is to craft a reply to a trending post that:

1. Opens by tagging the original author with a WeBet challenge: "@[handle] WeBet $100 [Bet Claim Title Case]"
2. References the prediction market data (odds, volume) to add credibility
3. Creates FOMO — makes it irresistible for the author AND their followers to engage
4. Encourages others to challenge the author to the same bet or share it
5. Ends with a call-to-action and @WeBetSocialAI tag

TONE: Confident but not arrogant. Provocative but respectful. Like a friend who knows something you don't and wants you to put your money where your mouth is.

RULES:
- Max 280 characters for the core reply (X limit)
- The bet string MUST be on its own line: @[handle] WeBet $100 [Bet Claim]
- Include the odds line: [X]% Yes on [Source] · [volume] vol
- End with webetsocial.com/feed
- No emojis. No hashtags in the first line. One or two hashtags max at the end only if they fit.
- Write like a world-class copywriter — every word earns its place.

Return ONLY the reply text, no JSON, no markdown, no quotes.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Skip auth for open/demo tokens
  const authToken = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (authToken !== 'open' && authToken !== 'demo') {
    // Could add real auth here later
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { handle, postText, betClaim, yesPct, sourceLabel, volume } = body;

    if (!handle || !betClaim) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing handle or betClaim' }) };
    }

    const xaiKey = process.env.XAI_API_KEY;
    if (!xaiKey) {
      // Return a well-crafted fallback
      const reply = buildFallback(handle, betClaim, yesPct, sourceLabel, volume);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning',
        messages: [
          { role: 'system', content: SNIPER_PROMPT },
          {
            role: 'user',
            content: `ORIGINAL POST by @${handle}:
"${postText}"

MATCHED BET:
- Bet claim: ${betClaim}
- Odds: ${yesPct}% Yes
- Source: ${sourceLabel}
- Volume: ${volume}

Craft the reply now.`,
          },
        ],
        temperature: 0.8,
        max_tokens: 400,
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error('[admin-sniper] Grok error:', res.status);
      const reply = buildFallback(handle, betClaim, yesPct, sourceLabel, volume);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };
    }

    const data = await res.json();
    let reply = (data.choices?.[0]?.message?.content || '').trim();

    // Strip any markdown wrapping
    reply = reply.replace(/^["'`]+|["'`]+$/g, '');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ reply }),
    };

  } catch (err) {
    console.error('[admin-sniper] error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function buildFallback(handle, betClaim, yesPct, sourceLabel, volume) {
  return `@${handle} WeBet $100 ${betClaim}

${yesPct}% of ${sourceLabel} says this happens. ${volume} in volume.

Think you know better? Take the bet.

Built with @WeBetSocialAI
webetsocial.com/feed`;
}
