'use strict';

// Pregame late-news. Every 30 minutes from 11:00 through 23:30 ET.
// For picks whose game starts within 90 minutes: MLB probable, NHL starter,
// NFL/NCAAF QB. Drop or flag only. Never add or swap a pick. Never grade.

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
  const writeCard = ctx.writeCard || updatePicksBlob;
  const fetchImpl = ctx.fetchImpl;

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

    const late = await lateNews.runLateNews({
      picksData,
      dateISO: dateKey,
      now,
      withinMin: 90,
      fetchImpl,
    });
    let written = false;
    try {
      const plan = lateNews.commitLateNewsCard(picksData, late, {
        resolveLockedParlay,
        enforceCap: enforceOmegaDailyUnitCap,
      });
      if (plan.write) {
        const wrote = await writeCard(dateKey, picksData);
        written = wrote !== false;
      }
    } catch (e) {
      console.error(`[pregame-check-omega] write soft-fail: ${e.message}`);
      late.errors = (late.errors || []).concat(e.message);
    }
    await recordOps(dateKey, late, parts.et, ctx.recordOps);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        date: dateKey,
        checked: late.checked || 0,
        dropped: late.dropped || 0,
        flagged: late.flagged || 0,
        httpCalls: late.httpCalls || 0,
        written,
        softFail: !!late.softFail,
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
