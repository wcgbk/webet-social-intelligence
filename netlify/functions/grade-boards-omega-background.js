'use strict';
/**
 * grade-boards-omega-background — 15 min worker for grade-boards-omega.
 * Grades prior saved morning boards (before today ET) into the same
 * board-graded cache the card reads. ?dryRun=1 or ?noWrite=1 grades
 * without writing. OMEGA_V2_BOARD_GRADER=off skips. No Odds API call.
 */
const { runBoardGrader, boardGraderEnabled } = require('./lib/omega-v2/board_grader');

function readBody(event) {
  if (!event || event.body == null || event.body === '') return {};
  if (typeof event.body === 'object') return event.body;
  try { return JSON.parse(event.body); } catch (_) { return {}; }
}

function wantsNoWrite(event) {
  const q = (event && event.queryStringParameters) || {};
  if (q.dryRun === '1' || q.dryRun === 'true' || q.noWrite === '1' || q.noWrite === 'true') return true;
  const body = readBody(event);
  if (body && (body.dryRun || body.noWrite || body.shadow)) return true;
  if (process.env.OMEGA_REPLAY_NO_WRITE === '1') return true;
  return false;
}

async function handle(event, deps = {}) {
  const run = deps.run || runBoardGrader;
  const noWrite = wantsNoWrite(event);
  if (!boardGraderEnabled(deps.env || process.env)) {
    const summary = await run({ env: deps.env || process.env, noWrite: true });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary),
    };
  }
  try {
    const summary = await run({
      env: deps.env || process.env,
      noWrite,
      dryRun: noWrite,
      now: deps.now || new Date(),
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary),
    };
  } catch (err) {
    console.error(`[grade-boards-omega] FATAL ${err && err.message ? err.message : err}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }),
    };
  }
}

exports.handler = (event) => handle(event);
exports.handle = handle;
