/**
 * reply.js — Turn Apai's chat reply into a postable X reply.
 *
 * Apai's reply is the body — we post her voice, not a rigid template. We only:
 *   - clamp to X's limit (her chat can run longer than 280),
 *   - if we had to truncate, append the analyze link so the full read is reachable,
 *   - optionally append the follow CTA when there's still room.
 */

'use strict';

const config = require('./config');

const CTA = `Follow @${config.account.handle} for daily truth scores.`;
const TCO = 23; // X wraps any URL to 23 chars

function clampAtWord(str, max) {
  if (str.length <= max) return str;
  const cut = str.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * @param {string} apaiReply  Apai's natural-language reply.
 * @param {string} analyzeUrl Deep link to the full private analysis.
 * @returns {string} reply text ready for POST /2/tweets (<= maxReplyLen).
 */
function buildReply(apaiReply, analyzeUrl) {
  const max = config.limits.maxReplyLen;
  const body = String(apaiReply || '').trim();

  // Case 1: her reply already fits. Optionally append the CTA if there's room.
  if (body.length <= max) {
    if (config.apai.appendCta) {
      const withCta = `${body}\n\n${CTA}`;
      if (withCta.length <= max) return withCta;
    }
    return body;
  }

  // Case 2: too long — truncate and hand off to the full analysis link so
  // nothing is lost. Reserve room for "\n" + t.co link.
  const reserve = 1 + TCO;
  const trimmed = clampAtWord(body, max - reserve);
  return `${trimmed}\n${analyzeUrl}`;
}

module.exports = { buildReply, CTA };
