'use strict';

const { normalizeTeamName } = require('./team_normalize');
const { teamExactOnly } = require('../config');
const ncaafTable = require('./data/ncaaf-team-ids.json');
const nflTable = require('./data/nfl-team-ids.json');
const nbaTable = require('./data/nba-team-ids.json');
const mlbTable = require('./data/mlb-team-ids.json');
const nhlTable = require('./data/nhl-team-ids.json');
const explicitAliases = require('./data/football-explicit-aliases.json');

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

const ALIAS_BY_SPORT = {};

/**
 * Explicit aliases, normalized once. A key already in the id lookup is
 * ignored so this table cannot move a school that already resolves.
 */
function explicitAliasId(sport, key) {
  const bucket = sport === 'CFB' ? 'NCAAF' : sport;
  if (!ALIAS_BY_SPORT[bucket]) {
    const built = {};
    const raw = (explicitAliases && explicitAliases[bucket]) || {};
    const table = tableFor(bucket);
    for (const [name, id] of Object.entries(raw)) {
      const norm = normalizeTeamName(name);
      if (!norm || id == null || id === '') continue;
      if (table && table.lookup && table.lookup[norm]) continue;
      built[norm] = String(id);
    }
    ALIAS_BY_SPORT[bucket] = built;
  }
  return ALIAS_BY_SPORT[bucket][key] || null;
}

/**
 * Exact ESPN id. Lookup first, then the explicit alias table.
 * Unknown names return null. No substring, last-word, or mascot fallback.
 */
function resolveTeamId(sport, name) {
  const table = tableFor(sport);
  if (!table || !table.lookup) return null;
  const key = normalizeTeamName(name);
  if (!key) return null;
  const id = table.lookup[key];
  if (id) return String(id);
  return explicitAliasId(sport, key);
}

function teamRecord(sport, id) {
  const table = tableFor(sport);
  if (!table || !id) return null;
  return (table.teams && table.teams[String(id)]) || null;
}

/**
 * FBS membership is the ESPN-id division on ncaaf-team-ids (built from
 * ESPN groups 80). Scoreboard competitors have conferenceId and a game-level
 * groups object, not an isFBS flag, and conference ids are not a division.
 * Counting teams on ≥50% of the loaded groups=80 weeks mislabels Howard:
 * the Bison are on the week-2 and week-4 FBS boards (2 of 3) with a 13-day
 * gap, which is the phantom bye. Missing and non-fbs rows are not FBS.
 */
function isFbsTeamId(id) {
  const rec = teamRecord('NCAAF', id);
  return !!(rec && rec.division === 'fbs');
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
 * ESPN id a table row belongs to. A stamped espnId wins, even when the
 * key would resolve to a different school. A numeric key is an id when
 * that id is in the team table. Otherwise the key is a name.
 */
function rowBoundId(sport, key, row) {
  if (row && row.espnId != null && String(row.espnId) !== '') {
    const stamped = String(row.espnId);
    if (/^\d+$/.test(stamped)) return stamped;
  }
  const keyText = String(key);
  if (/^\d+$/.test(keyText) && teamRecord(sport, keyText)) return keyText;
  return resolveTeamId(sport, key);
}

// NFL, NCAAF, and NHL model inputs do not fuzzy. MLB still does.
const EXACT_MODEL_SPORTS = new Set(['NFL', 'NCAAF', 'CFB', 'NHL']);

/**
 * Standings / park / quality row. Identity first: the row whose key resolves
 * to the same ESPN id. fuzzyTeam runs only when the name does not resolve,
 * or when a table key does not resolve, and only for sports outside
 * EXACT_MODEL_SPORTS (or opts.allowFuzzy). Those sports log a miss once
 * and return null.
 * Logs once per sport+name when `fallbackSeen` is a Set on opts (no module-level memory).
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
    const kind = EXACT_MODEL_SPORTS.has(sport) && !(opts && opts.allowFuzzy) ? 'miss' : 'fallback';
    console.warn(`[omega-team-identity] ${kind} sport=${sport} name=${label}`);
  }
  // NFL/NCAAF/NHL stay exact. allowFuzzy is only the OMEGA_TEAM_EXACT_ONLY=0
  // path: a resolved name still refuses a different resolved school, and
  // fuzzy runs only when the name or a table key does not resolve.
  if (EXACT_MODEL_SPORTS.has(sport) && !(opts && opts.allowFuzzy)) return null;
  return fuzzy(teamName, table);
}

function lazyFuzzy(name, ratings) {
  const { fuzzyTeam } = require('./_common');
  return fuzzyTeam(name, ratings);
}

const refusedFuzzyLogged = new Set();

function logRefusedFuzzy(sport, name) {
  const token = String(sport || '') + '\0' + String(name == null ? '' : name);
  if (refusedFuzzyLogged.has(token)) return;
  refusedFuzzyLogged.add(token);
  console.warn(`[omega-team-identity] exact_only refused fuzzy sport=${sport} name=${name}`);
}

/**
 * Model-input row for NFL/NCAAF. Exact ESPN id only when OMEGA_TEAM_EXACT_ONLY
 * is on (the default). A miss is null — the centered prior — never another
 * school's row. The toggle off restores the older fallback: fuzzyTeam runs
 * only when the name does not resolve, or a table key does not resolve.
 * rowByIdentityOrFuzzy itself still refuses that fuzzy for NFL/NCAAF/NHL,
 * so the off path passes allowFuzzy. Two resolved schools never share a
 * row. MLB/NHL callers keep rowByIdentityOrFuzzy. Grading does not use this.
 */
function modelRow(sport, table, teamName, opts) {
  const football = sport === 'NFL' || sport === 'NCAAF';
  if (!football) return rowByIdentityOrFuzzy(sport, table, teamName, opts);
  if (!teamExactOnly()) {
    return rowByIdentityOrFuzzy(sport, table, teamName, Object.assign({}, opts, { allowFuzzy: true }));
  }
  const id = resolveTeamId(sport, teamName);
  const row = id ? rowByIdentity(sport, table, teamName) : null;
  if (row) return row;
  const { fuzzyTeamKey } = require('./_common');
  const fuzzyKey = fuzzyTeamKey(teamName, table);
  if (!fuzzyKey) return null;
  const fuzzyRow = table[fuzzyKey];
  if (!isLookupRow(fuzzyKey, fuzzyRow)) {
    logRefusedFuzzy(sport, teamName);
    return null;
  }
  const fuzzyId = resolveTeamId(sport, fuzzyKey);
  // Both names are real schools. The mascot collision is not a miss.
  if (id && fuzzyId && id !== fuzzyId) return null;
  if (id && fuzzyId && id === fuzzyId) return fuzzyRow;
  logRefusedFuzzy(sport, teamName);
  return null;
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
    if (!isLookupRow(key, row)) continue;
    if (rowBoundId(sport, key, row) === id) return row;
  }
  return null;
}

/**
 * FBS (or all 32 NFL) display names against one EPA or standings table.
 * idMisses: the display name does not resolve to that ESPN id.
 * rowMisses: a row is bound to the id and rowByIdentity does not return it.
 * fuzzyCrossSchool: no exact row, and the mascot match is a different
 * resolved school. Those are not resolution misses.
 */
function footballResolutionReport(sport, table) {
  const idTable = tableFor(sport);
  const idMisses = [];
  const rowMisses = [];
  const fuzzyCrossSchool = [];
  const fuzzyStillLogged = [];
  let teams = 0;
  const src = (idTable && idTable.teams) || {};
  for (const [espnId, rec] of Object.entries(src)) {
    if (!rec || !rec.displayName) continue;
    if (sport === 'NCAAF' && rec.division !== 'fbs') continue;
    if (sport !== 'NCAAF' && sport !== 'NFL') continue;
    teams += 1;
    const want = String(espnId);
    const resolved = resolveTeamId(sport, rec.displayName);
    if (resolved !== want) {
      idMisses.push({ displayName: rec.displayName, espnId: want, resolved: resolved || null });
    }
    let bound = false;
    for (const [key, row] of Object.entries(table || {})) {
      if (!isLookupRow(key, row)) continue;
      if (rowBoundId(sport, key, row) === want) { bound = true; break; }
    }
    if (bound && !rowByIdentity(sport, table, rec.displayName)) {
      rowMisses.push({ displayName: rec.displayName, espnId: want });
    }
  }
  const { fuzzyTeamKey } = require('./_common');
  for (const [espnId, rec] of Object.entries(src)) {
    if (!rec || !rec.displayName) continue;
    if (sport === 'NCAAF' && rec.division !== 'fbs') continue;
    if (sport !== 'NCAAF' && sport !== 'NFL') continue;
    if (rowByIdentity(sport, table, rec.displayName)) continue;
    const key = fuzzyTeamKey(rec.displayName, table || {});
    if (!key || !isLookupRow(key, (table || {})[key])) continue;
    const queryId = resolveTeamId(sport, rec.displayName);
    const fuzzyId = resolveTeamId(sport, key);
    if (queryId && fuzzyId && queryId !== fuzzyId) {
      fuzzyCrossSchool.push({
        name: rec.displayName, fuzzyKey: key, queryId, fuzzyId, espnId: String(espnId),
      });
    } else if (!(queryId && fuzzyId && queryId === fuzzyId)) {
      fuzzyStillLogged.push({ name: rec.displayName, fuzzyKey: key, espnId: String(espnId) });
    }
  }
  return {
    sport,
    teams,
    idMisses,
    rowMisses,
    unresolvedKeys: unresolvedKeys(sport, table),
    fuzzyCrossSchool,
    fuzzyStillLogged,
  };
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
  isFbsTeamId,
  sameTeam,
  resolveEspnSide,
  matchSides,
  rowByIdentity,
  rowByIdentityOrFuzzy,
  modelRow,
  unresolvedKeys,
  footballResolutionReport,
  logUnknownTeam,
  listUnresolved,
  collectUnresolved,
  buildUnmatchedReport,
  unmatchedBlobKey,
  persistUnmatchedReport,
  REPORT_SPORTS,
};
