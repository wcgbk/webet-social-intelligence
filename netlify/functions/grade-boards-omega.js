'use strict';
/**
 * 11:30 ET daily. Cron "30 15,16 * * *". DST-proof via etGuard.
 * Fires grade-boards-omega-background, which grades saved morning boards
 * into the board-graded cache. OMEGA_V2_BOARD_GRADER=off skips.
 * Does not build the card and does not call The Odds API.
 * Also posts the daily ops check. That call has its own timeout.
 * OMEGA_DAILY_CHECK=off skips it. A failure there does not change this response.
 */
const { rejectUnlessEtSlot } = require('./lib/et-schedule');
const { boardGraderEnabled } = require('./lib/omega-v2/board_grader');

const DAILY_CHECK_TIMEOUT_MS = 2500;

function dailyQuery(event) {
  const qs = (event && event.queryStringParameters) || {};
  const params = new URLSearchParams();
  if (qs.dryRun != null && String(qs.dryRun) !== '') params.set('dryRun', String(qs.dryRun));
  if (qs.date) params.set('date', String(qs.date));
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function fireDailyCheck(event) {
  let enabled = true;
  try {
    const { dailyCheckEnabled } = require('./lib/omega-vnext/daily_check');
    enabled = dailyCheckEnabled(process.env);
  } catch (err) {
    console.error(`[grade-boards-omega] daily-check trigger failed: ${err && err.message ? err.message : err}`);
    return;
  }
  if (!enabled) return;
  const siteURL = process.env.URL || 'https://webetsocial.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DAILY_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/check-omega-daily-background${dailyQuery(event)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
        signal: controller.signal,
      }
    );
    if (response && response.status !== 202 && !response.ok) {
      console.error(`[grade-boards-omega] daily-check trigger HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`[grade-boards-omega] daily-check trigger failed: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const skip = rejectUnlessEtSlot('grade-boards-omega', event, new Date());
  if (skip) return skip;
  await fireDailyCheck(event);
  if (!boardGraderEnabled()) {
    console.log('[grade-boards-omega] datesGraded=0 rows=0 skipped=0 kill-switch=off');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, skipped: 'kill-switch' }),
    };
  }
  const siteURL = process.env.URL || 'https://webetsocial.com';
  try {
    const response = await fetch(
      `${siteURL}/.netlify/functions/grade-boards-omega-background`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled: true, timestamp: new Date().toISOString() }),
      }
    );
    if (response.status !== 202 && !response.ok) {
      console.error(`[grade-boards-omega] background trigger HTTP ${response.status}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: `background trigger HTTP ${response.status}` }),
      };
    }
    console.log(`[grade-boards-omega] background triggered: ${response.status}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, queued: true, status: response.status }),
    };
  } catch (err) {
    console.error(`[grade-boards-omega] failed: ${err.message}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
