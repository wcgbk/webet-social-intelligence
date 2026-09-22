'use strict';
/**
 * warm-omega-feeds.js — 9:00 ET prefetch of the feeds Omega generate already uses.
 * Writes omega-feed-warm/{date} only. Never picks / latest-date / picks-dates.
 * Soft-fails: always HTTP 200. Does not change selection.
 */

const { storeJson } = require('./lib/omega-vnext/store');
const {
  loadGameDayContext,
  loadSportEngines,
  fetchEspnScoreboard,
  enabledSportLabels,
} = require('./lib/omega-vnext/ingest');
const { etDateISO } = require('./lib/omega-vnext/line_path');

function countKeys(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
}

exports.handler = async (event) => {
  const softErrors = [];
  const now = new Date();
  const qs = (event && event.queryStringParameters) || {};
  const dateISO = qs.date || etDateISO(now);

  let gameDay = { qbStatusBySport: { NFL: {}, NCAAF: {} }, weatherByGame: {} };
  let engines = { mlbPitcherStats: { byId: {}, byTeam: {}, byName: {} } };

  try {
    const labels = enabledSportLabels();
    const parts = await Promise.all(labels.map(async (label) => {
      try {
        return await fetchEspnScoreboard(label, dateISO);
      } catch (e) {
        softErrors.push(`espn:${label}:${e.message}`);
        return { league: label, games: [] };
      }
    }));
    const espnBySport = {};
    for (const part of parts) {
      if (part && part.league) espnBySport[part.league] = part;
    }
    try {
      gameDay = await loadGameDayContext(dateISO, labels, espnBySport);
    } catch (e) {
      softErrors.push(`gameDay:${e.message}`);
    }
    try {
      engines = await loadSportEngines(dateISO);
    } catch (e) {
      softErrors.push(`engines:${e.message}`);
    }
  } catch (e) {
    softErrors.push(`warm:${e.message}`);
  }

  const qb = (gameDay && gameDay.qbStatusBySport) || {};
  const weather = (gameDay && gameDay.weatherByGame) || {};
  const pit = (engines && engines.mlbPitcherStats) || {};
  const blob = {
    date: dateISO,
    warmedAt: now.toISOString(),
    qbStatusBySport: {
      NFL: qb.NFL || {},
      NCAAF: qb.NCAAF || {},
    },
    qbStatusCounts: {
      NFL: countKeys(qb.NFL),
      NCAAF: countKeys(qb.NCAAF),
    },
    weatherByGameCount: countKeys(weather),
    pitcherCounts: {
      byId: countKeys(pit.byId),
      byName: countKeys(pit.byName),
      byTeam: countKeys(pit.byTeam),
    },
    softErrors,
  };

  let stored = false;
  try {
    await storeJson(`omega-feed-warm/${dateISO}`, blob);
    stored = true;
  } catch (e) {
    softErrors.push(`store:${e.message}`);
    blob.softErrors = softErrors;
    console.warn(JSON.stringify({ event: 'omegaFeedWarm', stored: false, error: e.message, date: dateISO }));
  }

  console.log(JSON.stringify({
    event: 'omegaFeedWarm',
    date: dateISO,
    stored,
    weatherByGameCount: blob.weatherByGameCount,
    pitcherCounts: blob.pitcherCounts,
    qbStatusCounts: blob.qbStatusCounts,
    softErrors,
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      softFail: softErrors.length ? softErrors : null,
      stored,
      date: dateISO,
      warmedAt: blob.warmedAt,
      qbStatusCounts: blob.qbStatusCounts,
      weatherByGameCount: blob.weatherByGameCount,
      pitcherCounts: blob.pitcherCounts,
      softErrors,
    }),
  };
};
