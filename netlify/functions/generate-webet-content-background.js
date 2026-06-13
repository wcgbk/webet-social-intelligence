/**
 * generate-webet-content-background.js — Core WeBet content pipeline
 * Background function (15-min timeout)
 *
 * Pipeline:
 *   1. Grok x_search for trending topics (politics + culture)
 *   2. Guardian-style authenticity scoring
 *   3. Polymarket cross-reference for live odds
 *   4. Multi-agent verification (Grok + Claude + ChatGPT)
 *   5. Content generation (blog article, Truth Social post, X post)
 *   6. Opposition matching (find X users with opposing takes)
 *   7. Create $1 bets + store everything
 *
 * Writes to "webet-truth-posts" blob store.
 */

const crypto = require('crypto');

const SITE_URL = process.env.URL || 'https://webetsocial.com';
const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

// ── Bet ID generator (from create-bet.js) ──
function generateBetId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(5);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ── Strip Grok citation tags ──
function stripGrokTags(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/<grok:render[^>]*>.*?<\/grok:render>/gs, '')
    .replace(/<\/?grok:[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

// ── Fetch with timeout ──
async function fetchWithTimeout(url, opts, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── STAGE 1: Discover trending topics via Grok x_search ──
async function discoverTopics(xaiKey) {
  console.log('[WEBET-CONTENT] Stage 1: Discovering trending topics...');
  const categories = ['politics', 'culture'];
  const allTopics = [];

  for (const cat of categories) {
    try {
      const res = await fetchWithTimeout('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
        body: JSON.stringify({
          model: 'grok-4-fast-non-reasoning',
          stream: false,
          tools: [{ type: 'x_search' }],
          input: [{
            role: 'user',
            content: `Search X right now for the 4 most CONTESTED and argued-about conversations in ${cat === 'politics' ? 'US politics — elections, tariffs, Supreme Court, legislation, government actions' : 'culture wars, social debates, viral controversies, hot takes people are fighting about'}.

For each topic:
1. Find the most viral/ratioed post about it (high replies = disagreement)
2. Identify both sides of the argument
3. Frame a specific, bettable claim with a deadline
4. The claim should be NEUTRAL — not left or right — just "will X happen by Y date?"

Return ONLY a JSON array:
[{
  "topic": "2-5 word topic name",
  "claim": "Specific bettable outcome statement",
  "deadline": "M/D/YY",
  "sideA": "One side's position",
  "sideB": "Opposing position",
  "xPost": { "text": "post text", "author": "Display Name", "handle": "username", "url": "https://x.com/username/status/REAL_ID", "likes": 5000, "retweets": 1200 },
  "sentiment": "split",
  "entities": ["Entity1", "Entity2"],
  "contention": 85,
  "category": "${cat}"
}]`
          }],
        }),
      }, 20000);

      if (!res.ok) { console.error(`[WEBET-CONTENT] Grok ${cat} error:`, res.status); continue; }

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

      if (content) {
        let cleaned = content.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        try {
          const topics = JSON.parse(cleaned);
          if (Array.isArray(topics)) allTopics.push(...topics.slice(0, 4));
        } catch (e) { console.error(`[WEBET-CONTENT] Parse error for ${cat}:`, e.message); }
      }
    } catch (e) {
      console.error(`[WEBET-CONTENT] Topic discovery ${cat} failed:`, e.message);
    }
  }

  console.log(`[WEBET-CONTENT] Stage 1 complete: ${allTopics.length} topics found`);
  return allTopics;
}

// ── STAGE 3: Polymarket cross-reference ──
async function findPolymarkets(topics) {
  console.log('[WEBET-CONTENT] Stage 3: Polymarket cross-reference...');
  const results = {};

  for (const topic of topics) {
    const keywords = (topic.entities || []).concat(topic.topic.split(' ')).slice(0, 3).join(' ');
    try {
      const res = await fetchWithTimeout(
        `https://gamma-api.polymarket.com/markets?_limit=3&closed=false&order=volume&ascending=false&tag=${encodeURIComponent(keywords)}`,
        {}, 8000
      );
      if (res.ok) {
        const markets = await res.json();
        results[topic.topic] = (markets || []).slice(0, 2).map(m => ({
          title: m.question || m.title || '',
          probability: Math.round((m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : m.bestBid || 0) * 100),
          volume: m.volume || 0,
          url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
          embedUrl: m.slug ? `https://embed.polymarket.com/market.html?market=${m.conditionId || m.slug}&features=volume&theme=dark` : null,
        }));
      }
    } catch (e) {
      console.log(`[WEBET-CONTENT] Polymarket lookup failed for "${keywords}":`, e.message);
    }
  }

  console.log(`[WEBET-CONTENT] Stage 3 complete: ${Object.keys(results).length} topics matched`);
  return results;
}

// ── STAGE 4: Multi-agent verification (Grok + Claude + ChatGPT) ──
async function verifyWithAgents(topic, xaiKey, anthropicKey, openaiKey) {
  const claimText = `Topic: ${topic.topic}\nClaim: ${topic.claim}\nSide A: ${topic.sideA}\nSide B: ${topic.sideB}`;
  const results = {};

  const agentCalls = [];

  // Grok (real-time X context)
  if (xaiKey) {
    agentCalls.push(
      fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
        body: JSON.stringify({
          model: 'grok-3-mini',
          messages: [
            { role: 'system', content: 'You analyze claims using real-time social data. Give a 1-sentence verdict (under 100 chars) and confidence level. Be neutral and data-driven.' },
            { role: 'user', content: claimText },
          ],
          max_tokens: 150,
        }),
      }, 12000)
        .then(r => r.json())
        .then(d => {
          const text = d.choices?.[0]?.message?.content || '';
          results.grok = { verdict: text.slice(0, 100), confidence: text.toLowerCase().includes('likely') ? 'high' : 'medium' };
        })
        .catch(e => { results.grok = { verdict: 'Unavailable', confidence: 'low' }; })
    );
  }

  // Claude (statistical analysis)
  if (anthropicKey) {
    agentCalls.push(
      fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{ role: 'user', content: `As a statistical analyst, give a 1-sentence neutral verdict (under 100 chars) on this claim's likelihood based on data:\n\n${claimText}` }],
        }),
      }, 12000)
        .then(r => r.json())
        .then(d => {
          const text = d.content?.[0]?.text || '';
          results.claude = { verdict: text.slice(0, 100), confidence: 'medium' };
        })
        .catch(e => { results.claude = { verdict: 'Unavailable', confidence: 'low' }; })
    );
  }

  // ChatGPT (market consensus)
  if (openaiKey) {
    agentCalls.push(
      fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You provide market consensus analysis. Give a 1-sentence verdict (under 100 chars) and confidence.' },
            { role: 'user', content: claimText },
          ],
          max_tokens: 150,
        }),
      }, 12000)
        .then(r => r.json())
        .then(d => {
          const text = d.choices?.[0]?.message?.content || '';
          results.chatgpt = { verdict: text.slice(0, 100), confidence: 'medium' };
        })
        .catch(e => { results.chatgpt = { verdict: 'Unavailable', confidence: 'low' }; })
    );
  }

  await Promise.allSettled(agentCalls);
  return results;
}

// ── STAGE 5: Generate content (blog + Truth Social post + X post) ──
async function generateContent(topic, betId, betUrl, markets, agents, anthropicKey, xaiKey) {
  const marketContext = (markets || []).map(m => `${m.title}: ${m.probability}% (${m.url || ''})`).join('\n');
  const agentContext = Object.entries(agents || {}).map(([name, a]) => `${name}: ${a.verdict}`).join('\n');
  const blogUrl = `${SITE_URL}/betty/blog/${slugify(topic.topic)}`;

  const result = { blog: null, truthPost: '', truthReply: '', xLongPost: '' };

  // Blog article via Claude — generates article body HTML only (template wraps it)
  if (anthropicKey) {
    try {
      const xSourceRef = topic.xPost?.url ? `Source X post: ${topic.xPost.handle} — "${(topic.xPost.text || '').slice(0, 150)}" (${topic.xPost.url})` : '';
      const blogRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2500,
          messages: [{
            role: 'user',
            content: `Write a 500-700 word blog article body for WeBetAI's Authentic Press blog. You are Betty - WeBetAI. Neutral, data-driven, middle of the road. Be concise.

TOPIC: ${topic.topic}
CLAIM: ${topic.claim}
SIDE A: ${topic.sideA}
SIDE B: ${topic.sideB}
DEADLINE: ${topic.deadline}
${xSourceRef}

PREDICTION MARKET DATA:
${marketContext || 'No market data available'}

AI ANALYST VERDICTS:
${agentContext || 'No agent data'}

REQUIREMENTS:
- Present BOTH sides fairly with data — not partisan
- Reference Polymarket odds: "According to Polymarket traders, there's a X% probability..."
- Reference the source X post if available
- Written by Betty - WeBetAI (first person "I" is fine)
- Use <h2> for section headings, <p> for paragraphs, <strong> for emphasis, <ul>/<li> for lists
- Use <div class="callout"><div class="callout-label">Key Insight</div><p>...</p></div> for important callouts
- Do NOT include h1, title, meta, or page wrapper — just the article body paragraphs
- Do NOT include a WeBet box (the template adds it automatically)
- End with a brief editorial note from Betty

Return ONLY a JSON object:
{
  "title": "Engaging neutral article title",
  "tag": "Politics or Culture or Technology or Social Intelligence",
  "excerpt": "1-2 sentence excerpt for card previews",
  "articleBodyHtml": "<p>First paragraph...</p><h2>Section...</h2><p>More content...</p>"
}`
          }],
        }),
      }, 60000);

      console.log(`[WEBET-CONTENT] Blog Claude response: ${blogRes.status}`);
      if (blogRes.ok) {
        const blogData = await blogRes.json();
        const text = blogData.content?.[0]?.text || '';
        console.log(`[WEBET-CONTENT] Blog text length: ${text.length}`);
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        try {
          const parsed = JSON.parse(cleaned);
          result.blog = {
            title: parsed.title || topic.topic,
            slug: slugify(parsed.title || topic.topic),
            tag: parsed.tag || topic.category || 'Analysis',
            excerpt: parsed.excerpt || '',
            articleBodyHtml: parsed.articleBodyHtml || '',
          };
          console.log(`[WEBET-CONTENT] Blog parsed: "${result.blog.title}" (${result.blog.articleBodyHtml.length} chars)`);
        } catch (e) {
          console.error('[WEBET-CONTENT] Blog parse error:', e.message, text.slice(0, 200));
        }
      } else {
        const errText = await blogRes.text().catch(() => '');
        console.error(`[WEBET-CONTENT] Blog Claude error: ${blogRes.status} ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      console.error('[WEBET-CONTENT] Blog generation failed:', e.message);
    }
  }

  // Truth Social post via Grok (max 470 chars + 30 for URL)
  if (xaiKey) {
    try {
      const truthRes = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
        body: JSON.stringify({
          model: 'grok-3-mini',
          messages: [
            { role: 'system', content: `You write Truth Social posts for @AP (Authentic Press, 42K followers). Tone: neutral, data-driven, engaging. NOT partisan — designed so Truth Social users can challenge people on X with these bets. Both sides should feel the post is fair. Max 300 characters for the post text (we add links after).` },
            { role: 'user', content: `Write TWO versions of a Truth Social post about this topic:

TOPIC: ${topic.topic}
CLAIM: ${topic.claim}
SIDE A: ${topic.sideA}
SIDE B: ${topic.sideB}
${marketContext ? `POLYMARKET: ${marketContext}` : ''}
WEBET: @AP WeBet $1 ${topic.claim} By ${topic.deadline}

The post will have these links appended automatically — do NOT include URLs in your text:
- Blog article link
- $1 bet link
- Source X post link

Return ONLY JSON:
{
  "postText": "Post text (max 300 chars). Reference the data. End with the WeBet string.",
  "replyText": "Reply version (max 300 chars). Punchier. Starts with the data point."
}` },
          ],
          max_tokens: 500,
        }),
      }, 12000);

      if (truthRes.ok) {
        const truthData = await truthRes.json();
        const text = truthData.choices?.[0]?.message?.content || '';
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        try {
          const parsed = JSON.parse(cleaned);
          // Build link block: blog + bet + source X post
          const xUrl = topic.xPost?.url || '';
          const links = [blogUrl, betUrl, xUrl].filter(Boolean).join('\n');
          result.truthPost = `${(parsed.postText || '').slice(0, 300)}\n\n${links}`;
          result.truthReply = `${(parsed.replyText || '').slice(0, 300)}\n\n${links}`;
        } catch (e) {
          const xUrl = topic.xPost?.url || '';
          const links = [blogUrl, betUrl, xUrl].filter(Boolean).join('\n');
          result.truthPost = `${topic.claim}\n\n@AP WeBet $1 on it.\n\n${links}`;
          result.truthReply = result.truthPost;
        }
      }
    } catch (e) {
      const xUrl = topic.xPost?.url || '';
      const links = [blogUrl, betUrl, xUrl].filter(Boolean).join('\n');
      result.truthPost = `${topic.claim}\n\n@AP WeBet $1 on it.\n\n${links}`;
      result.truthReply = result.truthPost;
    }
  }

  // X long-form post via Claude
  if (anthropicKey) {
    try {
      const xRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: `Write a 1500-2500 character X post (thread-style) about this topic. Neutral, data-driven, references prediction market odds. Ends with the WeBet challenge.

TOPIC: ${topic.topic}
CLAIM: ${topic.claim}
SIDES: ${topic.sideA} vs ${topic.sideB}
${marketContext ? `POLYMARKET: ${marketContext}` : ''}
WEBET: @AP WeBet $1 ${topic.claim} By ${topic.deadline}
BET: ${betUrl}
ARTICLE: ${blogUrl}

Return ONLY the post text, no JSON wrapping.`
          }],
        }),
      }, 15000);

      if (xRes.ok) {
        const xData = await xRes.json();
        result.xLongPost = (xData.content?.[0]?.text || '').slice(0, 5000);
      }
    } catch (e) {
      console.error('[WEBET-CONTENT] X post generation failed:', e.message);
    }
  }

  return result;
}

// ── STAGE 6: Find opposing X users ──
async function findOpposition(topic, xaiKey) {
  if (!xaiKey) return [];
  try {
    const res = await fetchWithTimeout('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-4-fast-non-reasoning',
        stream: false,
        tools: [{ type: 'x_search' }],
        input: [{
          role: 'user',
          content: `Search X for 3-5 users who posted OPPOSING takes on this topic: "${topic.topic}" — specifically people who disagree with this claim: "${topic.claim}"

Look for users who:
- Have strong opposing opinions with engagement
- Posted in the last 24-48 hours
- Have real followers (not bots)

Return ONLY a JSON array:
[{ "handle": "username", "name": "Display Name", "opposingTake": "their position in 1 sentence", "postUrl": "https://x.com/username/status/REAL_ID" }]`
        }],
      }),
    }, 15000);

    if (!res.ok) return [];
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
    if (!content) return [];

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const users = JSON.parse(cleaned);
    return Array.isArray(users) ? users.slice(0, 5).map(u => ({
      handle: stripGrokTags((u.handle || '').replace(/^@/, '')),
      name: stripGrokTags(u.name || ''),
      opposingTake: stripGrokTags(u.opposingTake || ''),
      postUrl: u.postUrl || '',
    })) : [];
  } catch (e) {
    console.error('[WEBET-CONTENT] Opposition matching failed:', e.message);
    return [];
  }
}

function slugify(text) {
  return (text || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ── MAIN HANDLER ──
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('[WEBET-CONTENT] Pipeline started');

  const xaiKey = process.env.XAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!xaiKey) {
    console.error('[WEBET-CONTENT] XAI_API_KEY not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'XAI_API_KEY required' }) };
  }

  try {
    // ── Stage 1: Discover topics ──
    const topics = await discoverTopics(xaiKey);
    if (!topics.length) {
      console.error('[WEBET-CONTENT] No topics found');
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'No topics found' }) };
    }

    // ── Stage 3: Polymarket (parallel with nothing, runs fast) ──
    const polymarkets = await findPolymarkets(topics);

    // ── Process each topic ──
    const posts = [];

    for (let i = 0; i < Math.min(topics.length, 6); i++) {
      const topic = topics[i];
      const topicStart = Date.now();
      console.log(`[WEBET-CONTENT] Processing topic ${i + 1}/${topics.length}: ${topic.topic}`);

      try {
      // Create $1 bet
      const betId = generateBetId();
      const betUrl = `${SITE_URL}/bet/${betId}`;
      const webetString = `@AP WeBet $1 ${topic.claim} By ${topic.deadline || '?'}`;

      // Stage 4: Multi-agent verification (parallel)
      const agents = await verifyWithAgents(topic, xaiKey, anthropicKey, openaiKey);

      // Stage 5: Content generation
      const markets = polymarkets[topic.topic] || [];
      const content = await generateContent(topic, betId, betUrl, markets, agents, anthropicKey, xaiKey);

      // Stage 6: Opposition matching
      const opposingUsers = await findOpposition(topic, xaiKey);

      // Stage 6.5: Auto-publish blog article
      let blogUrl = null;
      if (content.blog && content.blog.articleBodyHtml) {
        try {
          console.log(`[WEBET-CONTENT] Auto-publishing blog: ${content.blog.slug}`);
          const publishRes = await fetchWithTimeout(`${SITE_URL}/api/publish-blog-post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: content.blog.slug,
              title: content.blog.title,
              tag: content.blog.tag,
              articleBodyHtml: content.blog.articleBodyHtml,
              excerpt: content.blog.excerpt,
              description: content.blog.excerpt,
              betUrl,
              webetString,
            }),
          }, 15000);
          if (publishRes.ok) {
            const pubData = await publishRes.json();
            blogUrl = pubData.url;
            content.blog.url = blogUrl;
            content.blog.published = true;
            console.log(`[WEBET-CONTENT] Blog published: ${blogUrl}`);
          }
        } catch (e) {
          console.error(`[WEBET-CONTENT] Blog publish failed: ${e.message}`);
        }
      }

      // Stage 7: Create bet in blob store
      try {
        const { getStore } = await import('@netlify/blobs');
        const siteID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
        const blobToken = process.env.NETLIFY_AUTH_TOKEN || '';
        const betStore = getStore({ name: 'webet-bets', siteID, token: blobToken });
        const bet = {
          id: betId,
          betString: webetString,
          title: topic.claim,
          category: topic.category || 'politics',
          options: [{ name: 'Yes', probability: 50 }, { name: 'No', probability: 50 }],
          amount: 1,
          createdBy: '@AP',
          status: 'open',
          createdAt: new Date().toISOString(),
          sides: { yes: [], no: [] },
          totalPool: 0,
          participantCount: 0,
          resolvedAt: null,
          resolution: null,
          resolutionSource: null,
        };
        await betStore.setJSON(`bet-${betId}`, bet);

        // Update recent index
        let recentIndex = [];
        try { recentIndex = (await betStore.get('recent-bets', { type: 'json' })) || []; } catch (_) {}
        recentIndex.unshift({ id: betId, title: bet.title, betString: webetString, category: bet.category, createdAt: bet.createdAt, createdBy: '@AP', amount: 1, participantCount: 0, status: 'open' });
        if (recentIndex.length > 200) recentIndex = recentIndex.slice(0, 200);
        await betStore.setJSON('recent-bets', recentIndex);
      } catch (e) {
        console.error(`[WEBET-CONTENT] Bet creation failed for ${betId}:`, e.message);
      }

      posts.push({
        id: `wtp-${Date.now()}-${i}`,
        topic: stripGrokTags(topic.topic),
        claim: stripGrokTags(topic.claim),
        deadline: topic.deadline || null,
        category: topic.category || 'politics',
        guardianScore: {
          contention: topic.contention || 0,
          authenticity: Math.round(((topic.contention || 70) + 70) / 2),
        },
        sides: { sideA: stripGrokTags(topic.sideA), sideB: stripGrokTags(topic.sideB) },
        xSourcePost: topic.xPost ? {
          text: stripGrokTags(topic.xPost.text),
          author: stripGrokTags(topic.xPost.author),
          handle: (topic.xPost.handle || '').replace(/^@/, ''),
          url: topic.xPost.url,
          likes: topic.xPost.likes || 0,
          retweets: topic.xPost.retweets || 0,
        } : null,
        markets,
        agents,
        blog: content.blog ? {
          title: content.blog.title,
          slug: content.blog.slug || slugify(topic.topic),
          tag: content.blog.tag || topic.category || 'Analysis',
          excerpt: content.blog.excerpt || '',
          articleBodyHtml: content.blog.articleBodyHtml || '',
          url: blogUrl || `${SITE_URL}/betty/blog/${content.blog.slug || slugify(topic.topic)}`,
          published: !!blogUrl,
        } : null,
        betId,
        betUrl,
        webetString,
        xSourceUrl: topic.xPost?.url || null,
        truthPost: content.truthPost || `${topic.claim}\n\n@AP WeBet $1\n\n${[blogUrl, betUrl, topic.xPost?.url].filter(Boolean).join('\n')}`,
        truthReply: content.truthReply || content.truthPost || '',
        xLongPost: content.xLongPost || '',
        opposingUsers,
        posted: { truth: false, x: false, blog: !!blogUrl },
      });

      console.log(`[WEBET-CONTENT] Topic ${i + 1} done in ${((Date.now() - topicStart) / 1000).toFixed(1)}s`);
      } catch (topicErr) {
        console.error(`[WEBET-CONTENT] Topic ${i + 1} "${topic.topic}" FAILED:`, topicErr.message);
      }
    }

    // ── Store everything ──
    const payload = {
      generatedAt: new Date().toISOString(),
      pipeline: {
        runtime: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        topicsFound: topics.length,
        postsGenerated: posts.length,
      },
      posts,
    };

    const { getStore } = await import('@netlify/blobs');
    const siteID2 = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const blobToken2 = process.env.NETLIFY_AUTH_TOKEN || '';
    const store = getStore({ name: 'webet-truth-posts', siteID: siteID2, token: blobToken2 });
    await store.setJSON('latest-posts', payload);

    console.log(`[WEBET-CONTENT] Pipeline complete: ${posts.length} posts in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, postsGenerated: posts.length, runtime: `${((Date.now() - startTime) / 1000).toFixed(1)}s` }),
    };
  } catch (err) {
    console.error('[WEBET-CONTENT] Pipeline error:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
