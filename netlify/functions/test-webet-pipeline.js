/**
 * test-webet-pipeline.js — Debug endpoint for WeBet content pipeline
 * GET /api/test-webet-pipeline
 * Runs each stage synchronously and returns results/errors for debugging.
 */

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const log = [];
  const push = (msg) => { log.push(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${msg}`); console.log(msg); };
  const start = Date.now();

  push('Pipeline test started');

  const xaiKey = process.env.XAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  push(`XAI_API_KEY: ${xaiKey ? 'set (' + xaiKey.slice(0, 8) + '...)' : 'MISSING'}`);
  push(`ANTHROPIC_API_KEY: ${anthropicKey ? 'set (' + anthropicKey.slice(0, 8) + '...)' : 'MISSING'}`);
  push(`OPENAI_API_KEY: ${openaiKey ? 'set (' + openaiKey.slice(0, 8) + '...)' : 'MISSING'}`);

  // Stage 1: Test Grok trending
  let topics = [];
  try {
    push('Stage 1: Testing Grok x_search...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-4-fast-non-reasoning',
        stream: false,
        tools: [{ type: 'x_search' }],
        input: [{
          role: 'user',
          content: `Search X right now for the 2 most contested political topics people are arguing about. For each, find a viral post with a real URL.

Return ONLY a JSON array:
[{
  "topic": "2-5 word topic",
  "claim": "Bettable outcome claim",
  "deadline": "6/30/26",
  "sideA": "One side",
  "sideB": "Other side",
  "xPost": { "text": "post text", "author": "Name", "handle": "username", "url": "https://x.com/user/status/123", "likes": 1000 },
  "contention": 85,
  "category": "politics"
}]`
        }],
      }),
    });

    clearTimeout(timeout);
    push(`Grok response status: ${res.status}`);

    if (res.ok) {
      const data = await res.json();
      let content = '';
      for (const item of data.output || []) {
        if (item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text' && c.text) { content = c.text; break; }
          }
        }
        if (content) break;
      }
      push(`Grok content length: ${content.length} chars`);
      if (content) {
        let cleaned = content.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        topics = JSON.parse(cleaned);
        push(`Parsed ${topics.length} topics: ${topics.map(t => t.topic).join(', ')}`);
      }
    } else {
      const errText = await res.text();
      push(`Grok error: ${errText.slice(0, 300)}`);
    }
  } catch (e) {
    push(`Stage 1 FAILED: ${e.message}`);
  }

  // Stage 3: Test Polymarket
  let markets = {};
  if (topics.length > 0) {
    try {
      push('Stage 3: Testing Polymarket...');
      const keywords = (topics[0].entities || []).concat(topics[0].topic.split(' ')).slice(0, 3).join(' ');
      const res = await fetch(`https://gamma-api.polymarket.com/markets?_limit=2&closed=false&order=volume&ascending=false&tag=${encodeURIComponent(keywords)}`);
      push(`Polymarket status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        push(`Polymarket results: ${data.length} markets`);
        markets = data.slice(0, 2).map(m => ({ title: m.question, prob: m.bestBid }));
      }
    } catch (e) {
      push(`Stage 3 FAILED: ${e.message}`);
    }
  }

  // Stage 4: Test multi-agent (just Claude quick check)
  if (topics.length > 0 && anthropicKey) {
    try {
      push('Stage 4: Testing Claude verification...');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 100,
          messages: [{ role: 'user', content: `In under 80 chars, assess likelihood: ${topics[0].claim}` }],
        }),
      });
      push(`Claude status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        push(`Claude verdict: ${data.content?.[0]?.text || 'empty'}`);
      } else {
        push(`Claude error: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      push(`Stage 4 FAILED: ${e.message}`);
    }
  }

  // Test full pipeline write (if topics found)
  if (topics.length > 0) {
    try {
      push('Testing FULL pipeline: create bet + generate post + write blob...');
      const betId = crypto.randomBytes(3).toString('hex');
      const betUrl = `https://webetsocial.com/bet/${betId}`;
      const webetString = `@AP WeBet $1 ${topics[0].claim} By ${topics[0].deadline || '?'}`;

      // Generate a simple truth social post via Grok
      let truthPost = `${topics[0].claim}\n\n@AP WeBet $1\n\n${betUrl}`;
      try {
        const grokPostRes = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
          body: JSON.stringify({
            model: 'grok-3-mini',
            messages: [
              { role: 'system', content: 'Write a 300 char max neutral Truth Social post about a trending topic. End with the WeBet string.' },
              { role: 'user', content: `Topic: ${topics[0].topic}\nClaim: ${topics[0].claim}\nWeBet: ${webetString}\nBet URL: ${betUrl}` },
            ],
            max_tokens: 200,
          }),
        });
        if (grokPostRes.ok) {
          const grokPostData = await grokPostRes.json();
          const postText = grokPostData.choices?.[0]?.message?.content || '';
          if (postText) truthPost = `${postText.slice(0, 380)}\n\n${betUrl}`;
          push(`Grok post generated: ${truthPost.length} chars`);
        }
      } catch (e) { push(`Grok post fallback: ${e.message}`); }

      const post = {
        id: `wtp-test-${Date.now()}`,
        topic: topics[0].topic,
        claim: topics[0].claim,
        deadline: topics[0].deadline,
        category: topics[0].category || 'politics',
        guardianScore: { contention: topics[0].contention || 80, authenticity: 75 },
        sides: { sideA: topics[0].sideA, sideB: topics[0].sideB },
        xSourcePost: topics[0].xPost || null,
        markets: markets[topics[0].topic] || [],
        agents: {},
        blog: null,
        betId,
        betUrl,
        webetString,
        truthPost,
        truthReply: truthPost,
        xLongPost: '',
        opposingUsers: [],
        posted: { truth: false, x: false, blog: false },
      };

      const payload = { generatedAt: new Date().toISOString(), pipeline: { runtime: `${((Date.now() - start) / 1000).toFixed(1)}s`, topicsFound: topics.length, postsGenerated: 1 }, posts: [post] };

      const { getStore: gs } = await import('@netlify/blobs');
      const s = gs({ name: 'webet-truth-posts', siteID: process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606', token: process.env.NETLIFY_AUTH_TOKEN || '' });
      await s.setJSON('latest-posts', payload);
      push('FULL PIPELINE TEST: wrote 1 post to blob successfully!');

      // Verify read-back
      const readBack = await s.get('latest-posts', { type: 'json' });
      push(`Read-back: ${readBack?.posts?.length || 0} posts, generated ${readBack?.generatedAt || 'null'}`);
    } catch (e) {
      push(`Full pipeline test FAILED: ${e.message}`);
    }
  }

  // Test blob write
  try {
    push('Testing blob write...');
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const blobToken = process.env.NETLIFY_AUTH_TOKEN || '';
    push(`NETLIFY_AUTH_TOKEN: ${blobToken ? 'set (' + blobToken.slice(0, 8) + '...)' : 'MISSING'}`);
    push(`SITE_ID: ${siteID}`);
    const store = getStore({ name: 'webet-truth-posts', siteID, token: blobToken });
    await store.setJSON('test-key', { test: true, ts: Date.now() });
    const readBack = await store.get('test-key', { type: 'json' });
    push(`Blob write/read: ${readBack ? 'SUCCESS' : 'FAILED'}`);
  } catch (e) {
    push(`Blob FAILED: ${e.message}`);
  }

  push(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ log, topics: topics.slice(0, 2), markets }, null, 2),
  };
};
