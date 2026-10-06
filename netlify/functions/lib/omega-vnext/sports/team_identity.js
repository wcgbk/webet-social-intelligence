'use strict';

const { normalizeTeamName } = require('./team_normalize');
const ncaafTable = require('./data/ncaaf-team-ids.json');
const nflTable = require('./data/nfl-team-ids.json');

const TABLES = {
  NFL: nflTable,
  NCAAF: ncaafTable,
};

function tableFor(sport) {
  if (sport === 'NFL') return TABLES.NFL;
  if (sport === 'NCAAF' || sport === 'CFB') return TABLES.NCAAF;
  return null;
}

/**
 * Exact ESPN id. Normalized alias → id. Unknown names return null.
 * No substring, last-word, or mascot fallback.
 */
function resolveTeamId(sport, name) {
  const table = tableFor(sport);
  if (!table || !table.lookup) return null;
  const key = normalizeTeamName(name);
  if (!key) return null;
  const id = table.lookup[key];
  return id ? String(id) : null;
}

function teamRecord(sport, id) {
  const table = tableFor(sport);
  if (!table || !id) return null;
  return (table.teams && table.teams[String(id)]) || null;
}

/**
 * Standings or seed row whose key resolves to the same ESPN id.
 * A name with no id returns null (unknown). An id with no row returns null
 * (known program, no row — standings fallback, not unknown).
 */
function rowByIdentity(sport, table, teamName) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const id = resolveTeamId(sport, teamName);
  if (!id) return null;
  for (const [key, row] of Object.entries(table)) {
    if (!key || key.startsWith('_') || row == null || typeof row !== 'object') continue;
    if (resolveTeamId(sport, key) === id) return row;
  }
  return null;
}

function unresolvedKeys(sport, table) {
  const out = [];
  for (const key of Object.keys(table || {})) {
    if (!key || key.startsWith('_')) continue;
    if (!resolveTeamId(sport, key)) out.push(key);
  }
  return out;
}

function logUnknownTeam(sport, name) {
  console.warn(`[omega-team-identity] unknown_team sport=${sport} name=${name}`);
}

/** Unique names that do not resolve, sorted. Each is logged once. */
function listUnresolved(sport, names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    if (name == null || name === '') continue;
    const label = String(name);
    if (seen.has(label)) continue;
    seen.add(label);
    if (!resolveTeamId(sport, label)) {
      out.push(label);
      logUnknownTeam(sport, label);
    }
  }
  out.sort();
  return out;
}

function namesFromEvents(events) {
  const names = [];
  for (const ev of events || []) {
    if (!ev) continue;
    if (ev.home_team) names.push(ev.home_team);
    if (ev.away_team) names.push(ev.away_team);
  }
  return names;
}

function buildUnmatchedReport(dateISO, oddsBySport, generatedAt) {
  const bySport = {
    NFL: listUnresolved('NFL', namesFromEvents(oddsBySport && oddsBySport.NFL)),
    NCAAF: listUnresolved('NCAAF', namesFromEvents(oddsBySport && oddsBySport.NCAAF)),
  };
  return {
    date: dateISO,
    generatedAt: generatedAt || new Date().toISOString(),
    bySport,
    count: bySport.NFL.length + bySport.NCAAF.length,
  };
}

function unmatchedBlobKey(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`omega-unmatched refused bad date: ${dateISO}`);
  }
  return `omega-unmatched-${d}`;
}

/**
 * Private diagnostics blob. dryRun writes nothing.
 * store(key, data) defaults to the omega store helper.
 */
async function persistUnmatchedReport({ dryRun, dateISO, report, store } = {}) {
  const key = unmatchedBlobKey(dateISO);
  if (dryRun) return { wrote: false, key };
  const write = store || (async (k, data) => {
    const { storeJson } = require('../store');
    return storeJson(k, data);
  });
  await write(key, report);
  return { wrote: true, key };
}

module.exports = {
  normalizeTeamName,
  resolveTeamId,
  teamRecord,
  rowByIdentity,
  unresolvedKeys,
  logUnknownTeam,
  listUnresolved,
  buildUnmatchedReport,
  unmatchedBlobKey,
  persistUnmatchedReport,
};
