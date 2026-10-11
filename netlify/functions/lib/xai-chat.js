'use strict';

/**
 * Shared xAI chat completions client (OpenAI-compatible).
 * https://api.x.ai/v1/chat/completions
 * Omega narrate and verify use this. The API key is never logged.
 *
 * grok-4.3 is the default. On 2026-10-11 a full narrate body (max_tokens 5800)
 * produced no text before the 60s abort on grok-4.7 and grok-4.6. grok-4.5
 * returned 200 for narrate (38–56s) but timed out on the 25s sharp-review
 * call. grok-4.3 returned JSON in ~15s (narrate) and ~11s (sharp review).
 * generate-picks-omega-background is a 15-minute background function.
 * verify-picks-omega is scheduled (30s platform limit; the call uses 25s).
 * Fallbacks run only after HTTP 429/5xx and share that same timeout budget,
 * so a slow primary cannot stack another full wait onto verify.
 */

const { currentAudit } = require('./omega-vnext/audit_log');

const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions';

const GROK_MODEL = 'grok-4.3';

// Next models that also returned narrate + sharp-review JSON inside both budgets.
const GROK_FALLBACK_MODELS = [
  'grok-4-1-fast-reasoning',
  'grok-4-fast-non-reasoning',
  'grok-4.20-0309-non-reasoning',
];

function resolveXaiKey(explicit) {
  return explicit
    || process.env.XAI_API_KEY
    || '';
}

function parseModelList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Primary is the explicit argument, then XAI_MODEL, then GROK_MODEL.
 * Fallbacks are XAI_FALLBACK_MODELS when that env var is set (empty disables
 * them), otherwise GROK_FALLBACK_MODELS. Duplicates are dropped.
 */
function resolveModelChain(explicit) {
  const fromEnv = process.env.XAI_MODEL && String(process.env.XAI_MODEL).trim();
  const primary = (explicit && String(explicit).trim()) || fromEnv || GROK_MODEL;
  const fallbacks = process.env.XAI_FALLBACK_MODELS != null
    ? parseModelList(process.env.XAI_FALLBACK_MODELS)
    : GROK_FALLBACK_MODELS.slice();
  const chain = [];
  for (const id of [primary, ...fallbacks]) {
    if (id && !chain.includes(id)) chain.push(id);
  }
  return chain;
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

function statusShouldFallback(err) {
  const status = Number(err && err.status);
  return status === 429 || (status >= 500 && status <= 599);
}

function usageTokens(data) {
  const u = data && data.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  if (prompt == null && completion == null && total == null) return null;
  return { prompt, completion, total };
}

function responseBytes(resp) {
  if (!resp || !resp.headers || typeof resp.headers.get !== 'function') return null;
  const n = Number(resp.headers.get('content-length'));
  return Number.isFinite(n) ? n : null;
}

function hideSecret(message, secret) {
  if (message == null) return null;
  let s = String(message);
  if (secret && String(secret).length >= 8) s = s.split(String(secret)).join('REDACTED');
  return s;
}

async function xaiChatOnce({ key, model, system, user, maxTokens, timeoutMs, attempt, auditLog }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const body = { model, messages };
  if (maxTokens != null) body.max_tokens = maxTokens;

  const started = Date.now();
  const log = auditLog || currentAudit();
  let recorded = false;
  function recordModel(extra) {
    if (recorded || !log) return;
    recorded = true;
    const row = {
      kind: 'model',
      provider: 'xai',
      method: 'POST',
      url: XAI_CHAT_URL,
      model,
      attempt: attempt == null ? 0 : attempt,
      ms: Date.now() - started,
      ...extra,
    };
    if (row.error) row.error = hideSecret(row.error, key);
    try { log.record(row); }
    catch (err) { console.error(`[omega-audit] model record soft-fail: ${err && err.message}`); }
  }

  let resp;
  try {
    resp = await fetch(XAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    recordModel({
      status: err && err.status != null ? err.status : null,
      bytes: null,
      ok: false,
      modelAnswered: null,
      tokens: null,
      error: (err && err.message) || 'xAI chat failed',
    });
    throw err;
  }
  const bytes = responseBytes(resp);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(`xAI HTTP ${resp.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
    err.status = resp.status;
    recordModel({
      status: resp.status,
      bytes,
      ok: false,
      modelAnswered: null,
      tokens: null,
      error: err.message,
    });
    throw err;
  }
  const data = await resp.json();
  const text = messageText(data);
  const answered = data && data.model ? String(data.model) : model;
  const tokens = usageTokens(data);
  if (!text) {
    const err = new Error('no text in xAI response');
    recordModel({
      status: resp.status,
      bytes,
      ok: false,
      modelAnswered: answered,
      tokens,
      error: err.message,
    });
    throw err;
  }
  recordModel({
    status: resp.status,
    bytes,
    ok: true,
    modelAnswered: answered,
    tokens,
    error: null,
  });
  return text;
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model] primary model; overrides XAI_MODEL
 * @param {string} [opts.system]
 * @param {string} opts.user
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs] budget for the whole model chain
 * @param {object} [opts.auditLog] per-run log; otherwise the current-run context
 * @returns {Promise<string>}
 */
async function xaiChat({ apiKey, model, system, user, maxTokens, timeoutMs, auditLog } = {}) {
  const key = apiKey || resolveXaiKey();
  if (!key) {
    const err = new Error('xAI HTTP 401: missing XAI_API_KEY');
    err.status = 401;
    throw err;
  }
  const chain = resolveModelChain(model);
  const budget = timeoutMs || 60000;
  const deadline = Date.now() + budget;
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const remaining = deadline - Date.now();
    if (i > 0 && remaining < 1000) break;
    try {
      const text = await xaiChatOnce({
        key,
        model: chain[i],
        system,
        user,
        maxTokens,
        timeoutMs: Math.max(1, remaining),
        attempt: i,
        auditLog,
      });
      console.log(`[xai-chat] ok model=${chain[i]}`);
      return text;
    } catch (err) {
      lastErr = err;
      const more = i < chain.length - 1 && remaining > 1000;
      if (!more || !statusShouldFallback(err)) throw err;
      console.error(`[xai-chat] ${chain[i]} HTTP ${err.status} — trying ${chain[i + 1]}`);
    }
  }
  throw lastErr || new Error('xAI chat failed');
}

module.exports = {
  xaiChat,
  resolveXaiKey,
  resolveModelChain,
  messageText,
  GROK_MODEL,
  GROK_FALLBACK_MODELS,
  XAI_CHAT_URL,
};
