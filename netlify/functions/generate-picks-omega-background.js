'use strict';
/**
 * Omega background generator — THIN WRAPPER around lib/omega-vnext.
 * Legacy megascript archived at archive/generate-picks-omega-legacy-v11.js (unused).
 * MODEL_VERSION: v12.0.3-omega-vnext-clv
 *
 * Store: edge-picks-omega → /omega
 * Product: up to 3 straights + 1 optimized parlay; empty OK; no lean force-fill;
 * no self-opt mutation. Claude = verifier/narrator only.
 */
const { generateOmegaVnext, MODEL_VERSION } = require('./lib/omega-vnext');

exports.handler = async (event) => {
  console.log(`[omega-vnext-wrapper] start ${MODEL_VERSION}`);
  try {
    let body = {};
    if (event && event.body) {
      try { body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body; }
      catch (_) { body = {}; }
    }
    const qs = (event && event.queryStringParameters) || {};
    const opts = {
      date: body.date || qs.date,
      force: !!(body.force || qs.force === 'true'),
      simMode: !!(body.simMode || body.sim),
      historicalSnapshot: body.historicalSnapshot,
      dryRun: !!body.dryRun,
    };

    const result = await generateOmegaVnext(opts);
    const n = (result && result.picks && result.picks.length) || 0;
    console.log(`[omega-vnext-wrapper] OK picks=${n} model=${MODEL_VERSION}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        model: MODEL_VERSION,
        date: result.date,
        picks: n,
        parlay: (result.parlayLegs || []).length,
        noPlays: result.noPlays || null,
      }),
    };
  } catch (err) {
    console.error(`[omega-vnext-wrapper] FATAL: ${err.message}`);
    if (err.code === 'OVERWRITE_GUARD') {
      return { statusCode: 409, body: err.message };
    }
    return { statusCode: 500, body: err.message || 'Omega vNext failed' };
  }
};

module.exports.MODEL_VERSION = MODEL_VERSION;
module.exports.generateOmegaVnext = generateOmegaVnext;
