'use strict';

const { normalizeTeamName } = require('./team_normalize');
const ncaafTable = require('./data/ncaaf-team-ids.json');
const nflTable = require('./data/nfl-team-ids.json');
const nbaTable = require('./data/nba-team-ids.json');
const mlbTable = require('./data/mlb-team-ids.json');
const nhlTable = require('./data/nhl-team-ids.json');

const TABLES = {
  NFL: nflTable,
  NCAAF: ncaafTable,
  NBA: nbaTable,
  MLB: mlbTable,
  NHL: nhlTable,
};

const REPORT_SPORTS = ['NFL', 'NCAAF', 'MLB', 'NHL', 'NBA'];

function tableFor(sport) {
  if (sport === 'NFL') return TABLES.NFL;
  if (sport === 'NCAAF' || sport === 'CFB') return TABLES.NCAAF;
  if (sport === 'NBA') return TABLES.NBA;
  if (sport === 'MLB') return TABLES.MLB;
  if (sport === 'NHL') return TABLES.NHL;
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

/** Both names resolve to one ESPN id. Unknown or split ids are false. */
function sameTeam(sport, nameA, nameB) {
  const a = resolveTeamId(sport, nameA);
  const b = resolveTeamId(sport, nameB);
  return !!(a && b && a === b);
}

/**
 * ESPN id for one competitor. A resolved name wins. Else the display name.
 * Else the competitor id already on the scoreboard.
 */
function resolveEspnSide(sport, name, espnId, espnDisplayName) {
  const fromName = name ? resolveTeamId(sport, name) : null;
  if (fromName) return String(fromName);
  if (espnDisplayName && espnDisplayName !== name) {
    const fromDisp = resolveTeamId(sport, espnDisplayName);
    if (fromDisp) return String(fromDisp);
  }
  if (espnId != null && espnId !== '') return String(espnId);
  return null;
}

/**
 * Which side of one game the pick names. decided:false means a name did not
 * resolve and the caller should use its legacy matcher. When both clubs
 * resolve and neither is the pick, decided:true and both sides are false so
 * a shared last word cannot grab the other club.
 * Game-side ids prefer the ESPN competitor id, then the display name.
 */
function matchSides(sport, pickTeam, awayName, homeName, awayEspnId, homeEspnId) {
  const pickId = resolveTeamId(sport, pickTeam);
  const awayId = (awayEspnId != null && awayEspnId !== '')
    ? String(awayEspnId)
    : (resolveTeamId(sport, awayName) || null);
  const homeId = (homeEspnId != null && homeEspnId !== '')
    ? String(homeEspnId)
    : (resolveTeamId(sport, homeName) || null);
  if (pickId && awayId && pickId === awayId && pickId !== homeId) {
    return { pickedAway: true, pickedHome: false, decided: true };
  }
  if (pickId && homeId && pickId === homeId && pickId !== awayId) {
    return { pickedAway: false, pickedHome: true, decided: true };
  }
  if (pickId && awayId && homeId && pickId !== awayId && pickId !== homeId) {
    return { pickedAway: false, pickedHome: false, decided: true };
  }
  return { pickedAway: false, pickedHome: false, decided: false };
}

function isLookupRow(key, row) {
  if (!key || String(key).startsWith('_')) return false;
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return false;
  return true;
}

/**
 * Standings / park / quality row. Identity first: the row whose key resolves
 * to the same ESPN id. fuzzyTeam runs only when the name does not resolve,
 * or when a table key does not resolve. Logs once per sport+name when `fallbackSeen`
 * is a Set on opts (no module-level memory).
 */
function rowByIdentityOrFuzzy(sport, table, teamName, opts) {
  const fuzzy = (opts && opts.fuzzyTeam) || lazyFuzzy;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const nameId = resolveTeamId(sport, teamName);
  if (nameId) {
    for (const [key, row] of Object.entries(table)) {
      if (!isLookupRow(key, row)) continue;
      const keyId = resolveTeamId(sport, key);
      if (keyId && keyId === nameId) return row;
    }
  }
  let keyMissing = false;
  if (nameId) {
    for (const [key, row] of Object.entries(table)) {
      if (!isLookupRow(key, row)) continue;
      if (!resolveTeamId(sport, key)) { keyMissing = true; break; }
    }
  }
  if (nameId && !keyMissing) return null;
  const label = String(teamName == null ? '' : teamName);
  const seen = opts && opts.fallbackSeen;
  const token = String(sport || '') + '\0' + label;
  if (!seen || !seen.has(token)) {
    if (seen && typeof seen.add === 'function') seen.add(token);
    console.warn(`[omega-team-identity] fallback sport=${sport} name=${label}`);
  }
  return fuzzy(teamName, table);
}

function lazyFuzzy(name, ratings) {
  const { fuzzyTeam } = require('./_common');
  return fuzzyTeam(name, ratings);
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

/** Unique names that do not resolve, sorted. Does not log. */
function collectUnresolved(sport, names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    if (name == null || name === '') continue;
    const label = String(name);
    if (seen.has(label)) continue;
    seen.add(label);
    if (!resolveTeamId(sport, label)) out.push(label);
  }
  out.sort();
  return out;
}

/** Unique names that do not resolve, sorted. Each is logged once. */
function listUnresolved(sport, names) {
  const out = collectUnresolved(sport, names);
  for (const label of out) logUnknownTeam(sport, label);
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
  const bySport = {};
  let count = 0;
  for (const sport of REPORT_SPORTS) {
    const names = namesFromEvents(oddsBySport && oddsBySport[sport]);
    bySport[sport] = listUnresolved(sport, names);
    count += bySport[sport].length;
  }
  return {
    date: dateISO,
    generatedAt: generatedAt || new Date().toISOString(),
    bySport,
    count,
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
  sameTeam,
  resolveEspnSide,
  matchSides,
  rowByIdentity,
  rowByIdentityOrFuzzy,
  unresolvedKeys,
  logUnknownTeam,
  listUnresolved,
  collectUnresolved,
  buildUnmatchedReport,
  unmatchedBlobKey,
  persistUnmatchedReport,
  REPORT_SPORTS,
};
