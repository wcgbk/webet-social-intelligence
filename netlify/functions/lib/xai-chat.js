'use strict';

/**
 * Shared xAI chat completions client (OpenAI-compatible).
 * https://api.x.ai/v1/chat/completions
 * Omega narrate and verify use this. The API key is never logged.
 */

const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions';

// Non-reasoning model already called with XAI_API_KEY in convert-bet and admin
// compose. Copy comes back on choices[0].message.content, which the existing
// JSON parsers read. A reasoning model can leave that field empty and miss the
// 25s verify / 60s narrate timeouts, so the card would publish fallback copy.
const GROK_MODEL = 'grok-4.20-0309-non-reasoning';

function resolveXaiKey(explicit) {
  return explicit
    || process.env.XAI_API_KEY
    || '';
}

function messageText(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('\n');
  }
  return '';
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {string} [opts.system]
 * @param {string} opts.user
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 */
async function xaiChat({ apiKey, model, system, user, maxTokens, timeoutMs } = {}) {
  const key = apiKey || resolveXaiKey();
  if (!key) {
    const err = new Error('xAI HTTP 401: missing XAI_API_KEY');
    err.status = 401;
    throw err;
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = {
    model: model || GROK_MODEL,
    messages,
  };
  if (maxTokens != null) body.max_tokens = maxTokens;

  const resp = await fetch(XAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 60000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(`xAI HTTP ${resp.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const text = messageText(data);
  if (!text) throw new Error('no text in xAI response');
  return text;
}

module.exports = {
  xaiChat,
  resolveXaiKey,
  messageText,
  GROK_MODEL,
  XAI_CHAT_URL,
};
