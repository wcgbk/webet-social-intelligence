// admin-auto-draft.js — Netlify Scheduled Function
// Runs daily at 7 AM ET (12:00 UTC)
// 1. Searches across categories: trending, politics, sports, crypto
// 2. Calls convert-bet for each post
// 3. Picks top 5-8 by bettability score
// 4. Calls Betty to compose posts
// 5. Saves to queue with status 'needs_review'

const crypto = require('crypto')
const { getStore } = require('@netlify/blobs');

// ── Scheduled function config ────────────────────────────────────────────────
exports.config = { schedule: '0 12 * * *' }; // 12:00 UTC = 7/8 AM ET

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

const CATEGORY_QUERIES = {
  trending: 'trending news predictions bold takes',
  politics: 'politics policy election prediction bold claim',
  sports: 'sports betting prediction bold take upset',
  crypto: 'crypto bitcoin ethereum prediction market bold take',
};

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('[admin-auto-draft] Starting daily auto-draft run');

  const siteURL = process.env.URL || 'https://webetsocial.com';
  const xaiKey = process.env.XAI_API_KEY;
  const queueStore = getStore('admin-queue');

  const allCandidates = [];

  // ── Step 1: Search across categories ──────────────────────────────────

  for (const [category, query] of Object.entries(CATEGORY_QUERIES)) {
    try {
      console.log(`[admin-auto-draft] Searching category: ${category}`);

      const searchRes = await fetch(`${siteURL}/.netlify/functions/search-x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, liveSearch: true }),
      });

      if (!searchRes.ok) {
        console.error(`[admin-auto-draft] search-x failed for ${category}: ${searchRes.status}`);
        continue;
      }

      const searchData = await searchRes.json();
      const posts = (searchData.posts || []).slice(0, 3); // Top 3 per category

      // ── Step 2: Convert each post to bet markets ──────────────────────
      for (const post of posts) {
        try {
          const convertRes = await fetch(`${siteURL}/.netlify/functions/convert-bet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: post.text,
              author: post.author,
              handle: post.handle,
              url: post.url,
            }),
          });

          if (!convertRes.ok) continue;
          const betData = await convertRes.json();

          // Calculate composite bettability score
          const topMarket = (betData.markets || [])[0];
          const bettabilityScore = topMarket?.bettabilityScore || 0;
          const engagement = (post.likes || 0) + (post.retweets || 0) * 2;

          allCandidates.push({
            category,
            post,
            markets: betData.markets || [],
            aiBet: betData.aiBet || null,
            bettabilityScore,
            engagement,
            compositeScore: bettabilityScore * 0.6 + Math.min(engagement / 10000, 1) * 40,
          });
        } catch (err) {
          console.error(`[admin-auto-draft] convert-bet failed:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[admin-auto-draft] category ${category} failed:`, err.message);
    }
  }

  console.log(`[admin-auto-draft] Found ${allCandidates.length} candidates`);

  if (allCandidates.length === 0) {
    console.log('[admin-auto-draft] No candidates found, exiting');
    return { statusCode: 200, body: 'No candidates found' };
  }

  // ── Step 3: Pick top 5-8 by composite score ───────────────────────────

  allCandidates.sort((a, b) => b.compositeScore - a.compositeScore);
  const topCandidates = allCandidates.slice(0, 8);

  // De-duplicate by ensuring varied categories
  const seen = new Set();
  const diversified = [];
  for (const c of topCandidates) {
    const key = `${c.category}-${c.post.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diversified.push(c);
    if (diversified.length >= 6) break;
  }

  console.log(`[admin-auto-draft] Selected ${diversified.length} for drafting`);

  // ── Step 4: Compose posts with Betty ──────────────────────────────────

  let queueIndex = [];
  try {
    queueIndex = await queueStore.get('_index', { type: 'json' }) || [];
  } catch {}

  let drafted = 0;

  for (const candidate of diversified) {
    const { category, post, markets, aiBet } = candidate;

    let composed = null;
    if (xaiKey && markets.length > 0) {
      composed = await composeBettyPost(post, markets, xaiKey);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const queueItem = {
      id,
      xText: composed?.xVersion || '',
      truthText: composed?.truthVersion || '',
      platforms: ['x', 'truth'],
      scheduledAt: null,
      status: 'needs_review',
      queuePosition: drafted + 1,
      sourcePost: {
        text: post.text,
        author: post.author,
        handle: post.handle,
        url: post.url,
        likes: post.likes || 0,
        retweets: post.retweets || 0,
      },
      markets: markets.slice(0, 3),
      aiBet,
      category,
      composed: composed || null,
      bettabilityScore: candidate.bettabilityScore,
      createdAt: now,
      updatedAt: now,
      autoDrafted: true,
    };

    await queueStore.setJSON(id, queueItem);
    queueIndex.push({ id, ts: now });
    drafted++;

    console.log(`[admin-auto-draft] Drafted: ${composed?.headline || post.text.slice(0, 50)}...`);
  }

  // Save updated index
  await queueStore.setJSON('_index', queueIndex);

  console.log(`[admin-auto-draft] Completed: ${drafted} posts drafted`);

  return {
    statusCode: 200,
    body: JSON.stringify({ drafted, timestamp: new Date().toISOString() }),
  };
};

// ── Betty compose helper ─────────────────────────────────────────────────────

async function composeBettyPost(post, markets, apiKey) {
  try {
    const marketSummary = markets.slice(0, 3).map((m) => {
      return `- ${m.question || m.betClaim} | ${m.yesPrice || '?'}% YES | $${formatVolume(m.volume)} volume`;
    }).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [
          { role: 'system', content: BETTY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `TRENDING X POST by @${post.handle}:
"${post.text}"

Engagement: ${post.likes || 0} likes, ${post.retweets || 0} retweets

MATCHED POLYMARKET DATA:
${marketSummary}

Compose the social posts now.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error('[admin-auto-draft] Grok compose error:', res.status);
      return null;
    }

    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').trim();

    let cleaned = content;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[admin-auto-draft] compose error:', err.message);
    return null;
  }
}

function formatVolume(vol) {
  const n = parseFloat(vol) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}
