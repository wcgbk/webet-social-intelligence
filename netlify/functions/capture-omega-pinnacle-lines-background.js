'use strict';
/** Repaired 2026-10-18: previously failed to load (missing
 *  pinnacle_line_move). Now delegates to the authorized odds-master pull;
 *  requires the picks secret because a background invoke spends credits. */
const crypto = require('crypto');
const { handler } = require('./capture-omega-pinnacle-lines');
function secretOk(given, secret) {
  if (!given || !secret) return false;
  const a = crypto.createHash('sha256').update(String(given).replace(/^Bearer\s+/i, '')).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}
exports.handler = async (event) => {
  const given = (event && event.headers && (event.headers['x-picks-secret'] || event.headers.authorization)) || '';
  if (!secretOk(given, process.env.PICKS_SECRET_KEY)) return { statusCode: 401, body: 'Unauthorized' };
  return handler(event);
};
exports.secretOk = secretOk;
