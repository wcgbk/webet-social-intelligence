'use strict';
/** Synchronous V1 runner/diagnostic (V1-scoped plumbing only).
 *  Calls generateV1Lock directly so errors surface in the response
 *  instead of vanishing in background logs. Default dryRun=true. */
const { generateV1Lock, MODEL_VERSION_V1 } = require('./lib/v1-lock/index-v1');
exports.handler = async (event) => {
  const params = (event && event.queryStringParameters) || {};
  const secret = process.env.PICKS_SECRET_KEY || 'webetai2026';
  const wantsWrite = params.dryRun === 'false';
  if (wantsWrite && params.key !== secret) return { statusCode: 401, body: 'Unauthorized' };
  let body = {};
  if (event && event.body) { try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body; } catch (_) {} }
  const started = Date.now();
  try {
    const result = await generateV1Lock({
      date: body.date || params.date,
      dryRun: body.dryRun != null ? !!body.dryRun : params.dryRun !== 'false',
      boardCutoff: body.boardCutoff || params.boardCutoff,
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, model: MODEL_VERSION_V1, ms: Date.now() - started,
        date: result.date, boardSlot: result.boardSlot, picks: result.picks,
        parlayLegs: result.parlayLegs, noPlays: result.noPlays || null,
        funnel: result.funnel, rejections: result.rejections }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, ms: Date.now() - started, error: err.message }) };
  }
};
