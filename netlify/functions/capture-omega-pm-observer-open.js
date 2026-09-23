'use strict';
/**
 * capture-omega-pm-observer-open.js — morning PM snap, 8:30am ET.
 * Netlify allows one cron per function. Writes omega-pm-observer/{date}-open
 * so 9:30 generate can compute pmMove. Does not race trigger-picks-omega
 * (13:30 UTC). Does not write the live card.
 */
const { runCapture } = require('./capture-omega-pm-observer');
const config = require('./lib/omega-vnext/config');

const MODEL_VERSION = config.MODEL_VERSION;

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  console.log(`[pm-observer-open] start model=${MODEL_VERSION} date=${dateISO || todayET()}`);
  try {
    const artifact = await runCapture(dateISO, { slot: 'open' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        slot: 'open',
        date: artifact.date,
        storeKey: artifact.storeKey || null,
        mappedCount: artifact.mappedCount,
        marketCount: {
          polymarket: artifact.polyMarkets ? artifact.polyMarkets.length : 0,
          kalshi: artifact.kalshiMarkets ? artifact.kalshiMarkets.length : 0,
        },
        sources: artifact.sources,
        modelVersion: MODEL_VERSION,
        storeError: artifact.storeError || null,
      }),
    };
  } catch (e) {
    console.error(`[pm-observer-open] fatal: ${e.message}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, slot: 'open', error: e.message, modelVersion: MODEL_VERSION }),
    };
  }
};

exports.runCapture = runCapture;