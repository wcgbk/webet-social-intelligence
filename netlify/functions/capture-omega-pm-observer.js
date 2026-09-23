'use strict';
/**
 * capture-omega-pm-observer.js — scheduled/on-demand PM observer capture.
 *
 * Default (10:15 ET cron, no query): audit log at omega-pm-observer/{date}.
 * ?slot=open (or the 8:30 ET capture-omega-pm-observer-open cron): morning
 * raw-market snap at omega-pm-observer/{date}-open for pmMove at 9:30.
 *
 * Does NOT regenerate the live Omega card. Does NOT mutate locked picks.
 * Soft-fail if PM APIs or blob writes fail.
 */

const config = require('./lib/omega-vnext/config');
const store = require('./lib/omega-vnext/store');
const { runPmObserver, buildPmOpenArtifact } = require('./lib/omega-vnext/pm_observer');

const MODEL_VERSION = config.MODEL_VERSION;
const readPicks = store.readPicks;
const storePmObserver = store.storePmObserver;
const storePmObserverOpen = store.storePmObserverOpen;

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function picksToCandidates(picks) {
  return (picks || []).map((p) => ({
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
}

/**
 * @param {string|null} dateISO
 * @param {{ slot?: 'open'|'post' }} [opts]
 */
async function runCapture(dateISO, opts = {}) {
  const date = dateISO || todayET();
  const slot = opts && opts.slot === 'open' ? 'open' : 'post';
  let picks = [];
  try {
    const card = readPicks ? await readPicks(date) : null;
    picks = (card && Array.isArray(card.picks)) ? card.picks : [];
  } catch (e) {
    console.error(`[pm-observer-capture] readPicks: ${e.message}`);
  }

  const candidates = picksToCandidates(picks);
  const pickCopies = picks.map((p) => ({ ...p }));
  let artifact;
  if (slot === 'open') {
    // Picks usually do not exist yet. Raw markets are the snap 9:30 reads.
    artifact = await buildPmOpenArtifact({
      dateISO: date,
      candidates,
      picks: pickCopies,
      modelVersion: MODEL_VERSION,
    });
  } else {
    artifact = await runPmObserver({
      dateISO: date,
      candidates,
      picks: pickCopies,
      modelVersion: MODEL_VERSION,
    });
  }
  artifact.slot = slot;

  try {
    const key = slot === 'open'
      ? await storePmObserverOpen(date, artifact)
      : await storePmObserver(date, artifact);
    artifact.storeKey = key;
  } catch (e) {
    console.error(`[pm-observer-capture] store soft-fail slot=${slot}: ${e.message}`);
    artifact.storeError = e.message;
  }
  return artifact;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || null;
  const slot = String(qs.slot || '').toLowerCase() === 'open' ? 'open' : 'post';
  console.log(`[pm-observer-capture] start model=${MODEL_VERSION} date=${dateISO || todayET()} slot=${slot}`);
  try {
    const artifact = await runCapture(dateISO, { slot });
    return json(200, {
      ok: true,
      slot,
      date: artifact.date,
      storeKey: artifact.storeKey || null,
      mappedCount: artifact.mappedCount,
      sources: artifact.sources,
      modelVersion: MODEL_VERSION,
      storeError: artifact.storeError || null,
    });
  } catch (e) {
    console.error(`[pm-observer-capture] fatal: ${e.message}`);
    return json(200, { ok: false, slot, error: e.message, modelVersion: MODEL_VERSION });
  }
};

exports.runCapture = runCapture;
exports.picksToCandidates = picksToCandidates;
