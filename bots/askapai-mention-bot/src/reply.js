/**
 * reply.js — Compose the reply text (concise, CTA in every reply, <=280 chars).
 *
 * Format:
 *   Authenticity: XX/100 · Framing: low|medium|high
 *   Full private analysis: <analyzeUrl>
 *   Follow @AskApai for daily truth scores.
 */

'use strict';

const config = require('./config');

const CTA = `Follow @${config.account.handle} for daily truth scores.`;

function formatReply({ authenticity, framing, analyzeUrl }) {
  // X wraps any URL to 23 chars via t.co, so the length math uses a fixed 23
  // regardless of the real link length.
  const TCO = 23;
  const line1 = `Authenticity: ${authenticity}/100 · Framing: ${framing}`;
  const line2Prefix = 'Full private analysis: ';
  const text = `${line1}\n${line2Prefix}${analyzeUrl}\n${CTA}`;

  const projectedLen = line1.length + 1 + line2Prefix.length + TCO + 1 + CTA.length;
  if (projectedLen <= config.limits.maxReplyLen) return text;

  // Degrade gracefully: drop the CTA line only as a last resort.
  const compact = `${line1}\n${line2Prefix}${analyzeUrl}`;
  return compact;
}

module.exports = { formatReply, CTA };
