// claude-execute.js — Sends a structured prompt to Claude and streams back
// the response. This is the "auto-send to Claude Code" endpoint.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Anthropic API key not configured' }) };
  }

  try {
    const { prompt, mode } = JSON.parse(event.body || '{}');
    if (!prompt) {
      return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Prompt required' }) };
    }

    // Build the system prompt based on mode
    const systemPrompt = mode === 'code'
      ? `You are Claude Code, an expert software engineer. You receive structured prompts distilled from voice conversations and implement them. Write clean, production-ready code. When the prompt includes file paths or project structure, follow them exactly. Output the implementation with clear file markers (e.g., "// filename.js") so the user can create the files.`
      : `You are Claude, an AI assistant by Anthropic. You are receiving a structured prompt distilled from a Grok voice conversation. Provide a thorough, actionable response. If the prompt asks for code, write it. If it asks for analysis, analyze. Be specific and complete.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Claude execute error:', res.status, errText);
      return { statusCode: 502, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Claude API error: ' + res.status }) };
    }

    // Stream the response back as SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text;
            }
          } catch (e) {
            // skip unparseable lines
          }
        }
      }
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: fullText || 'No response from Claude.' }),
    };
  } catch (err) {
    console.error('claude-execute error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Execution failed' }),
    };
  }
};
