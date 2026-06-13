// xai-analyze.js — Netlify Function
// Uses xAI Grok to generate AI-powered bet analysis and enhanced bet strings
// Accepts a market question + odds and returns Betty's take

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'xAI API key not configured' }) };
  }

  try {
    const { question, odds_yes, odds_no, volume, category, endDate } = JSON.parse(event.body || '{}');
    if (!question) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Market question required' }) };
    }

    const oddsStr = odds_yes != null ? `${odds_yes}% YES / ${odds_no}% NO` : 'Unknown odds';
    const volStr = volume || 'Unknown';
    const dateStr = endDate ? new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Open-ended';

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [
          {
            role: 'system',
            content: `You are Betty, the WeBetAI social intelligence companion. You're witty, sharp, and opinionated — like a sports betting analyst crossed with a meme-savvy friend. You analyze prediction markets and trending topics to help friends make fun bets with each other.

You MUST return valid JSON only — no markdown, no explanation, no code fences. Return a single JSON object with these fields:

- "insight": A punchy 1-2 sentence take on this market (60-120 chars). Be opinionated. Use real-time knowledge if you have it. Example: "Fed's holding firm — Powell basically said 'not yet' last week. Easy NO."
- "betTaunt": A fun, trash-talk-style message to send to a friend challenging them on this bet (80-140 chars). Make it personal and playful. Example: "You really think the Fed is cutting? Put your money where your mouth is 💰"
- "confidence": Your confidence level in the current market odds being correct: "high", "medium", or "low"
- "hotTake": A bold prediction or contrarian angle in one sentence (40-80 chars). Example: "Markets are sleeping on a surprise cut."
- "xContext": Brief summary of what people on X are saying about this topic right now (60-120 chars). Use your real-time X access. Example: "X is split — crypto Twitter wants cuts, econ Twitter says no chance."`,
          },
          {
            role: 'user',
            content: `Analyze this prediction market and give me Betty's take:

Market: ${question}
Current Odds: ${oddsStr}
Volume: ${volStr}
Category: ${category || 'General'}
Resolves: ${dateStr}

Use your real-time knowledge from X/Twitter to inform your analysis.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('xAI API error:', res.status, errText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'xAI API error: ' + res.status }) };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Empty response from xAI' }) };
    }

    // Parse JSON — handle potential markdown fences
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const analysis = JSON.parse(cleaned);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        insight: analysis.insight || '',
        betTaunt: analysis.betTaunt || '',
        confidence: analysis.confidence || 'medium',
        hotTake: analysis.hotTake || '',
        xContext: analysis.xContext || '',
      }),
    };
  } catch (err) {
    console.error('xai-analyze error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Analysis failed' }),
    };
  }
};
