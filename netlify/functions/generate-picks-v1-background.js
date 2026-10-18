'use strict';
/** V1 LOCK generator (separate backend; never writes Omega keys). */
const { generateV1Lock, MODEL_VERSION_V1 } = require('./lib/v1-lock/index-v1');
exports.handler = async (event) => {
  try {
    let body = {};
    if (event && event.body) { try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body; } catch (_) {} }
    const qs = (event && event.queryStringParameters) || {};
    const result = await generateV1Lock({
      date: body.date || qs.date,
      dryRun: !!(body.dryRun || qs.dryRun === 'true'),
      boardCutoff: body.boardCutoff || qs.boardCutoff,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, model: MODEL_VERSION_V1,
      date: result.date, picks: (result.picks || []).length,
      parlay: (result.parlayLegs || []).length, noPlays: result.noPlays || null,
      funnel: result.funnel, boardSlot: result.boardSlot }) };
  } catch (err) {
    console.error(`[v1-lock] FATAL: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
module.exports.MODEL_VERSION_V1 = MODEL_VERSION_V1;
