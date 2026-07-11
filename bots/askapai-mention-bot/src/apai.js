/**
 * apai.js — Relay a mentioned post to Apai's EXISTING chat brain.
 *
 * The bot does not score anything itself. When someone @-mentions @AskApai, we
 * take the post they're pointing at and send it to Apai's chat endpoint exactly
 * as if a user typed into her chat window:
 *
 *     "Rate this post for authenticity and manipulation: <post>"
 *
 * ...then post her natural-language reply back to X. This reuses the same
 * authenticity + manipulation logic already built into the daily dose and web
 * chat — one source of truth for Apai's voice and judgment.
 *
 * askApai() never throws: a chat outage falls back to a short honest message so
 * the reply loop can't wedge.
 */

'use strict';

const axios = require('axios');
const config = require('./config');
const log = require('./logger');

const { apai } = config;

// The exact instruction a user would type into Apai's chat window.
const PROMPT_PREFIX = 'Rate this post for authenticity and manipulation.';

function buildPrompt({ url, text }) {
  const parts = [PROMPT_PREFIX, ''];
  if (url) parts.push(`Post: ${url}`);
  if (text) parts.push(`${url ? 'Text' : 'Post'}: "${String(text).trim()}"`);
  return parts.join('\n');
}

// URL extraction — prefer entities.expanded_url; drop X/Twitter status permalinks
// (that's the thread itself, not an external claim). Keep everything else.
const URL_RE = /https?:\/\/[^\s]+/gi;

function extractUrls(text = '', entities = null) {
  const urls = [];
  if (entities && Array.isArray(entities.urls)) {
    for (const u of entities.urls) {
      const v = u.expanded_url || u.unwound_url || u.url;
      if (v) urls.push(v);
    }
  }
  if (!urls.length) {
    const m = String(text).match(URL_RE);
    if (m) urls.push(...m);
  }
  const isStatusPermalink = (u) =>
    /https?:\/\/(?:[\w-]+\.)*(?:x|twitter)\.com\/\w+\/status\//i.test(u);
  return urls.filter((u) => !isStatusPermalink(u));
}

function pickReply(data) {
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object') {
    for (const key of apai.replyFields) {
      const v = data[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      // some chat APIs nest under { data: { reply } } or { choices:[{message:{content}}] }
    }
    if (data.data) return pickReply(data.data);
    if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
      return String(data.choices[0].message.content).trim();
    }
  }
  return null;
}

async function callChat(message, meta) {
  const headers = { 'Content-Type': 'application/json' };
  if (apai.chatKey) headers['x-api-key'] = apai.chatKey;

  const body = { [apai.requestField]: message, source: 'x-mention', ...meta };
  const res = await axios.post(apai.chatUrl, body, {
    headers,
    timeout: apai.timeoutMs,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`apai chat ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const reply = pickReply(res.data);
  if (!reply) throw new Error('apai chat returned no recognizable reply field');
  return reply;
}

// Local stand-in so the bot runs before APAI_CHAT_URL is wired. Chat-style,
// clearly marked — NOT a real judgment.
function stubReply({ url, text }) {
  const subject = url || (text ? `"${String(text).slice(0, 60)}"` : 'that post');
  return `Give me a sec on ${subject} — my authenticity read isn't wired to this account yet. Full breakdown drops the moment it is.`;
}

async function askApai({ url, text, tweetId }) {
  const message = buildPrompt({ url, text });
  if (apai.chatUrl) {
    try {
      const reply = await callChat(message, { url: url || null, tweetId: tweetId || null });
      return { reply, source: 'apai-chat' };
    } catch (err) {
      log.warn('apai.chatFailed.fallbackToStub', { err: err.message });
    }
  }
  return { reply: stubReply({ url, text }), source: 'stub' };
}

function buildAnalyzeUrl({ url, tweetId }) {
  const base = apai.analyzeBase;
  if (url) return `${base}?url=${encodeURIComponent(url)}`;
  return `${base}?tweet=${encodeURIComponent(tweetId)}`;
}

module.exports = { askApai, buildPrompt, extractUrls, buildAnalyzeUrl };
