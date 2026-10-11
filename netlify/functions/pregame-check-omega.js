'use strict';

// Schedule stays every 30 minutes from 11:00 through 23:30 ET.
// The published card is final at 11:00. This function does not reprice,
// drop, swap, or write picks. Grading and the kickoff close are the only
// post-publish steps. An empty card still returns "No picks found".

const { rejectUnlessEtSlot, etParts } = require('./lib/et-schedule');
const lateNews = require('./lib/omega-vnext/late_news');
const { storeLateNewsOps } = require('./lib/omega-vnext/store');
const {
  updatePicksBlob,
  fetchBetaPicks,
  resolveLockedParlay,
  enforceOmegaDailyUnitCap,
} = require('./verify-picks-omega');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function unwrapCard(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.data && typeof result.data === 'object' && (Array.isArray(result.data.picks) || Array.isArray(result.data.parlayLegs))) {
    return result.data;
  }
  if (Array.isArray(result.picks) || Array.isArray(result.parlayLegs)) return result;
  return null;
}

async function recordOps(dateKey, late, et, record) {
  const write = record || storeLateNewsOps;
  try {
    await write(dateKey, lateNews.opsFromRun(late, {
      date: dateKey,
      functionName: 'pregame-check-omega',
      et,
    }));
  } catch (e) {
    console.error(`[pregame-check-omega] ops soft-fail: ${e.message}`);
  }
}

exports.handler = async (event, context) => {
  const ctx = context || {};
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const etSkip = rejectUnlessEtSlot('pregame-check-omega', event, now);
  if (etSkip) return etSkip;

  const parts = etParts(now);
  const dateKey = ctx.dateKey || parts.ymd;
  const readCard = ctx.readCard || fetchBetaPicks;
  // Accepted so a caller can still pass them. The published card is not written.
  void (ctx.writeCard || updatePicksBlob);
  void ctx.fetchImpl;

  try {
    const result = await readCard(dateKey);
    const picksData = unwrapCard(result);
    if (!picksData || !Array.isArray(picksData.picks) || picksData.picks.length === 0) {
      const late = { checked: 0, dropped: 0, flagged: 0, httpCalls: 0, actions: [], checks: [], errors: [], withinMin: 90 };
      await recordOps(dateKey, late, parts.et, ctx.recordOps);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ date: dateKey, checked: 0, dropped: 0, flagged: 0, written: false, summary: 'No picks found' }),
      };
    }

    // Published card is final. Do not call runLateNews and do not writeCard.
    const late = {
      checked: picksData.picks.length,
      dropped: 0,
      flagged: 0,
      repriced: 0,
      httpCalls: 0,
      actions: [],
      checks: [],
      errors: [],
      withinMin: 90,
      frozen: true,
      note: 'Published card is final. No post-publish reprice, swap, or card update.',
    };
    await recordOps(dateKey, late, parts.et, ctx.recordOps);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        date: dateKey,
        checked: late.checked || 0,
        dropped: 0,
        flagged: 0,
        repriced: 0,
        httpCalls: 0,
        written: false,
        frozen: true,
        summary: 'Published card is final',
      }),
    };
  } catch (e) {
    console.error(`[pregame-check-omega] soft-fail: ${e.message}`);
    await recordOps(dateKey, {
      checked: 0,
      dropped: 0,
      flagged: 0,
      httpCalls: 0,
      errors: [e.message],
      softFail: true,
      withinMin: 90,
      actions: [],
      checks: [],
    }, parts.et, ctx.recordOps);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ date: dateKey, ok: false, softFail: true, error: e.message }),
    };
  }
};
