// claude-process.js — Takes a Grok conversation transcript and uses Claude
// to distill it into a structured, actionable Claude Code prompt.

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Anthropic API key not configured' }) };
  }

  try {
    const { messages } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Messages array required' }) };
    }

    // Format the conversation transcript
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Grok'}: ${m.content}`)
      .join('\n\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `You are a prompt engineer. Below is a conversation between a user and Grok where they discussed what they want to build. Your job is to distill this into a clean, structured Claude Code prompt that can be sent directly to Claude Code CLI.

Extract:
1. **Project Overview** — What are they building? One paragraph summary.
2. **Requirements** — Numbered list of specific features and functionality discussed.
3. **Technical Constraints** — Stack preferences, APIs mentioned, deployment targets, etc.
4. **Design/UX Notes** — Any visual or interaction details mentioned.
5. **Implementation Steps** — Ordered list of what to build first, second, etc.

Format the output as a clean markdown prompt ready to paste into Claude Code. Start with a one-line instruction, then the structured sections. Be specific and actionable — don't be vague. If the conversation is ambiguous on any point, make a reasonable assumption and note it.

---

CONVERSATION TRANSCRIPT:

${transcript}`
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Claude API error:', res.status, errText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Claude API error: ' + res.status }) };
    }

    const data = await res.json();
    const content = data.content?.[0]?.text;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ prompt: content || 'Failed to generate prompt.' }),
    };
  } catch (err) {
    console.error('claude-process error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Processing failed' }),
    };
  }
};
