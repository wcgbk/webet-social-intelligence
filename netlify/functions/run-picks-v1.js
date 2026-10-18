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
  if (params.probe === 'true') {
    const out = { tokenPresent: !!process.env.NETLIFY_AUTH_TOKEN, siteIdPresent: !!process.env.SITE_ID };
    try { const { getStore } = await import('@netlify/blobs'); out.sdkImport = true;
      try { const s = getStore('edge-picks-omega'); const v = await s.get('omega-line-snap-2026-10-18-1000', { type: 'json' }); out.sdkSnap = v ? Object.keys(v) : null; } catch (e) { out.sdkSnapError = e.message; }
      try { const s2 = getStore('edge-picks-omega'); const v2 = await s2.get('omega-ops/capture-health-latest', { type: 'json' }); out.sdkHealth = v2 ? Object.keys(v2) : null; } catch (e) { out.sdkHealthError = e.message; }
    } catch (e) { out.sdkImport = false; out.sdkError = e.message; }
    try { const token = process.env.NETLIFY_AUTH_TOKEN; const sid = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
      const r = await fetch(`https://api.netlify.com/api/v1/blobs/${sid}/edge-picks-omega/omega-line-snap-2026-10-18-1000`, { headers: { Authorization: `Bearer ${token}` } });
      out.restSnapStatus = r.status; } catch (e) { out.restError = e.message; }
    for (const k of ['picks-2026-10-18','omega-ops/capture-health-latest','omega-line-path/2026-10-18','latest-date']) {
      try { const token = process.env.NETLIFY_AUTH_TOKEN; const sid = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
        const r = await fetch(`https://api.netlify.com/api/v1/blobs/${sid}/edge-picks-omega/${k}`, { headers: { Authorization: `Bearer ${token}` } });
        out['rest:'+k] = r.status; } catch (e) { out['rest:'+k] = e.message; }
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
  }
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
