'use strict';
/**
 * capture-omega-pm-observer.js — scheduled/on-demand PM observer capture.
 * OBSERVER ONLY. Writes omega-pm-observer/{date} (+ pm-sidecar-{date}).
 * Does NOT regenerate the live Omega card. Does NOT mutate picks.
 */

const config = require('./lib/omega-vnext/config');
const store = require('./lib/omega-vnext/store');
const { runPmObserver } = require('./lib/omega-vnext/pm_observer');

const MODEL_VERSION = config.MODEL_VERSION || config.MODEL_VERSION;
const readPicks = store.readPicks || store.readPicks;
const storePmObserver = store.storePmObserver;

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function runCapture(dateISO) {
  const date = dateISO || todayET();
  let picks = [];
  try {
    const card = readPicks ? await readPicks(date) : null;
    picks = (card && Array.isArray(card.picks)) ? card.picks : [];
  } catch (e) {
    console.error(`[pm-observer-capture] readPicks: ${e.message}`);
  }

  const candidates = picks.map((p) => ({
    sport: p.sport,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    side: p.pick || p.side,
    market: p.betType || p.market || 'Moneyline',
    matchup: p.matchup,
    rating: p.rating,
    units: p.units,
    edgePct: p.edgePct,
    ev: p.ev,
    coverProb: p.coverProb,
  }));

  const artifact = await runPmObserver({
    dateISO: date,
    candidates,
    picks: picks.map((p) => ({ ...p })),
    modelVersion: MODEL_VERSION,
  });

  try {
    await storePmObserver(date, artifact);
  } catch (e) {
    console.error(`[pm-observer-capture] store soft-fail: ${e.message}`);
    artifact.storeError = e.message;
  }
  return artifact;
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  console.log(`[pm-observer-capture] start model=${MODEL_VERSION} date=${dateISO || todayET()}`);
  try {
    const artifact = await runCapture(dateISO);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        date: artifact.date,
        mappedCount: artifact.mappedCount,
        sources: artifact.sources,
        modelVersion: MODEL_VERSION,
      }),
    };
  } catch (e) {
    console.error(`[pm-observer-capture] fatal: ${e.message}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, modelVersion: MODEL_VERSION }),
    };
  }
};

exports.runCapture = runCapture;
