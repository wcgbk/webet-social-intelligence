'use strict';
/**
 * grade-boards-omega-background — 15 min worker for grade-boards-omega.
 * Grades prior saved morning boards (before today ET) into the same
 * board-graded cache the card reads. ?dryRun=1 or ?noWrite=1 grades
 * without writing. OMEGA_V2_BOARD_GRADER=off skips. No Odds API call.
 */
const { runBoardGrader, boardGraderEnabled } = require('./lib/omega-v2/board_grader');
const { newsSlateEnabled } = require('./lib/omega-v2/constants');
const { captureNewsSlate, SLATE_BUDGET_MS } = require('./lib/omega-vnext/news_slate');
const { todayET } = require('./lib/omega-live-date');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * Second daily slate snapshot. Runs after grading returns.
 * Writes omega-news-snapshots only. Does not read or change the grader summary.
 * 60s cap. A failure does not change the response.
 */
async function captureSlateAfterGrade(deps) {
  const env = deps && deps.env ? deps.env : process.env;
  let enabled = false;
  try { enabled = newsSlateEnabled(env); } catch (_) { return; }
  if (!enabled) return;
  const capture = deps && deps.captureNewsSlate ? deps.captureNewsSlate : captureNewsSlate;
  const now = deps && deps.now ? deps.now : new Date();
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => capture({
        env,
        dateISO: (deps && deps.dateISO) || todayET(now),
        now,
        timeoutMs: 5000,
        budgetMs: SLATE_BUDGET_MS,
        fetchImpl: deps && deps.fetchImpl,
        store: deps && deps.store,
        blobFetch: deps && deps.blobFetch,
      })).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(resolve, SLATE_BUDGET_MS); }),
    ]);
  } catch (_) {
    // The slate logger records the soft-fail. Grading already finished.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  const env = deps.env || process.env;
  const noWrite = wantsNoWrite(event);
  let response;
  try {
    if (!boardGraderEnabled(env)) {
      const summary = await run({ env, noWrite: true });
      response = json(200, summary);
    } else {
      const summary = await run({
        env,
        noWrite,
        dryRun: noWrite,
        now: deps.now || new Date(),
      });
      response = json(200, summary);
    }
  } catch (err) {
    console.error(`[grade-boards-omega] FATAL ${err && err.message ? err.message : err}`);
    response = json(500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
  await captureSlateAfterGrade(deps);
  return response;
}

exports.handler = (event) => handle(event);
exports.handle = handle;
