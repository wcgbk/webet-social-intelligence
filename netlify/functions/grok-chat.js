// grok-chat.js — Netlify Function
// Proxies chat messages to xAI Grok API for the /ai chat interface
// Supports streaming via chunked responses

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
    const { messages, search } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Messages array required' }) };
    }

    // Detect if this is from the grok-to-code voice interface
    const isVoiceMode = event.queryStringParameters?.voice === '1';

    // Build the system prompt
    const systemMessage = {
      role: 'system',
      content: isVoiceMode
        ? `You are Grok, built by xAI — helping the user brainstorm and refine an idea they want to build with Claude Code. You're a brilliant product thinker and technical collaborator.

Your job is to have a natural conversation that draws out:
- What exactly they want to build
- Key features and requirements
- Technical preferences (stack, APIs, deployment)
- Design and UX details
- Priority order of implementation

Ask clarifying questions. Challenge vague ideas. Suggest improvements. Be conversational, witty, and direct — like a sharp co-founder in a brainstorm session. Keep responses concise (2-4 sentences max) so the conversation flows naturally like a voice call.

When you feel the idea is well-defined, say so and suggest they hit "Send to Claude Code".`
        : `You are Grok, built by xAI — accessed through the WeBetAI Social Intelligence platform. You're helpful, witty, and knowledgeable. You have access to real-time information from X (formerly Twitter) and the web.

When users ask about betting, predictions, sports, politics, crypto, or trending topics, leverage your real-time knowledge to give informed, opinionated takes. Be conversational and engaging — not robotic.

Format your responses with clear paragraphs. Use markdown for emphasis when helpful. Keep responses concise but thorough.`,
    };

    // Build request body — use grok-3 for voice mode, grok-3-mini otherwise
    const reqBody = {
      model: isVoiceMode ? 'grok-3' : 'grok-3-mini',
      messages: [systemMessage, ...messages],
      temperature: 0.7,
      max_tokens: isVoiceMode ? 1024 : 2048,
    };

    // Enable web search if requested
    if (search) {
      reqBody.search_parameters = {
        mode: 'auto',
      };
    }

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('xAI API error:', res.status, errText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Grok API error: ' + res.status }) };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        role: 'assistant',
        content: content || 'No response from Grok.',
      }),
    };
  } catch (err) {
    console.error('grok-chat error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Chat request failed' }),
    };
  }
};
