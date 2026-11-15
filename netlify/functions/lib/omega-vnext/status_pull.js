'use strict';

/**
 * Public ESPN pulls for the v2 status vetoes.
 * NBA injuries: site.api.espn.com .../basketball/nba/injuries (one call).
 * Importance: site.web.api.espn.com .../statistics/byathlete, limit=400.
 * Verified 2026-11-15: one page, 324 qualified players. general.avgMinutes
 * is values[1]. offensive.avgPoints is values[0]. Team displayName is on
 * athlete.teams[0]. Important = top 3 by minutes or top 3 by points on
 * that team. The public roster has no starter flag. Depth charts are
 * ordered but have no starter boolean and are one call per team, so they
 * are not the fallback. A missing rate file is a soft-fail (no veto).
 * NHL goalies are added behind OMEGA_V2_NHL_GOALIE in a later commit.
 */

const NBA_INJURY_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const NBA_RATES_URL = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=400&sort=general.avgMinutes:desc';
const NBA_INJURY_TIMEOUT_MS = 5000;

function normTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\bsaint louis\b/g, 'st louis')
    .replace(/\bst\s+louis\b/g, 'st louis')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normPlayerName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isoStamp(now) {
  if (now == null) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/**
 * Uncertain at build time. Announced Out / IR / suspension is null:
 * the market already has that news. Probable is not in the veto list.
 */
function uncertainStatus(status) {
  const s = String(status || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (s === 'gtd' || s.includes('game time decision') || s.includes('game time')) return 'game-time-decision';
  if (s.includes('day to day') || s === 'dtd') return 'day-to-day';
  if (s.includes('questionable')) return 'questionable';
  if (s.includes('doubtful')) return 'doubtful';
  return null;
}

function rawInjuryStatus(inj) {
  if (!inj || typeof inj !== 'object') return '';
  if (typeof inj.status === 'string') return inj.status;
  if (inj.status && typeof inj.status === 'object') {
    return inj.status.description || inj.status.type || inj.status.name || '';
  }
  const fantasy = inj.details && inj.details.fantasyStatus;
  if (fantasy && (fantasy.description || fantasy.abbreviation)) {
    return fantasy.description || fantasy.abbreviation;
  }
  if (typeof inj.type === 'string') return inj.type;
  return '';
}

function injuryAthleteName(inj) {
  const athlete = inj && inj.athlete;
  if (athlete && typeof athlete === 'object') {
    return athlete.displayName || athlete.fullName || athlete.shortName || '';
  }
  return inj.displayName || inj.name || '';
}

function parseInjuryRows(data) {
  const out = [];
  const blocks = []
    .concat((data && data.injuries) || [])
    .concat((data && data.teams) || []);
  const push = (teamName, teamId, inj) => {
    const name = injuryAthleteName(inj);
    const key = normPlayerName(name);
    if (!key) return;
    const status = rawInjuryStatus(inj);
    out.push({
      team: teamName || '',
      teamKey: normTeamName(teamName),
      teamId: teamId != null ? String(teamId) : '',
      name,
      nameKey: key,
      status,
      uncertain: uncertainStatus(status),
    });
  };
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const teamName = block.displayName || (block.team && block.team.displayName) || block.teamName || '';
    const teamId = block.id || (block.team && block.team.id) || '';
    const list = block.injuries || block.athletes || [];
    if (Array.isArray(list) && list.length && (block.injuries || block.displayName)) {
      for (const inj of list) push(teamName, teamId, inj);
    } else if (block.athlete || block.status) {
      push(teamName, teamId, block);
    }
  }
  if (!out.length && data && Array.isArray(data.items)) {
    for (const item of data.items) {
      const team = item && item.team;
      push((team && team.displayName) || '', team && team.id, item);
    }
  }
  return out;
}

function statIndex(categories, catName, statName) {
  const cat = (categories || []).find((c) => c && c.name === catName);
  if (!cat || !Array.isArray(cat.names)) return -1;
  return cat.names.indexOf(statName);
}

function valueAt(row, catName, index) {
  if (index < 0) return null;
  const block = (row.categories || []).find((c) => c && c.name === catName);
  const values = block && (block.values || block.totals);
  if (!Array.isArray(values) || index >= values.length) return null;
  const n = Number(values[index]);
  return Number.isFinite(n) ? n : null;
}

function parseRatePlayers(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.players)) {
    return data.players.map((p) => ({
      team: p.team || '',
      teamKey: normTeamName(p.team),
      teamId: p.teamId != null ? String(p.teamId) : '',
      name: p.name || '',
      nameKey: normPlayerName(p.name),
      mpg: Number.isFinite(Number(p.mpg)) ? Number(p.mpg) : null,
      ppg: Number.isFinite(Number(p.ppg)) ? Number(p.ppg) : null,
    })).filter((p) => p.nameKey && p.teamKey);
  }
  const categories = data.categories || [];
  const mpgIdx = statIndex(categories, 'general', 'avgMinutes');
  const ppgIdx = statIndex(categories, 'offensive', 'avgPoints');
  const out = [];
  for (const row of data.athletes || []) {
    const athlete = row && row.athlete;
    if (!athlete) continue;
    const teamObj = (athlete.teams && athlete.teams[0]) || {};
    const team = teamObj.displayName || athlete.teamName || '';
    const name = athlete.displayName || athlete.fullName || '';
    out.push({
      team,
      teamKey: normTeamName(team),
      teamId: teamObj.id != null ? String(teamObj.id) : (athlete.teamId != null ? String(athlete.teamId) : ''),
      name,
      nameKey: normPlayerName(name),
      mpg: valueAt(row, 'general', mpgIdx),
      ppg: valueAt(row, 'offensive', ppgIdx),
    });
  }
  return out.filter((p) => p.nameKey && p.teamKey);
}

function rankMap(rows, field) {
  const sorted = rows
    .filter((r) => Number.isFinite(r[field]))
    .slice()
    .sort((a, b) => (b[field] - a[field]) || String(a.name).localeCompare(String(b.name)));
  const map = new Map();
  sorted.forEach((row, i) => {
    if (!map.has(row.nameKey)) map.set(row.nameKey, i + 1);
  });
  return map;
}

function emptyNbaReport(pulledAt, extra) {
  return {
    ok: false,
    softFail: true,
    pulledAt: pulledAt || null,
    source: NBA_INJURY_URL,
    importanceSource: NBA_RATES_URL,
    importance: 'top3-mpg-or-ppg',
    teams: {},
    uncertainPlayers: 0,
    error: 'soft-fail',
    ...(extra || {}),
  };
}

/**
 * Join injuries to team rates. Out is omitted. A Day-To-Day / Questionable /
 * Doubtful / GTD player is included only when he is top 3 in minutes or
 * points. Ties break by player name. Rank is 1-based on the whole team.
 */
function buildNbaReport(injuryPayload, ratePayload, meta) {
  const pulledAt = meta && meta.pulledAt ? meta.pulledAt : null;
  let injuries;
  let rates;
  try {
    injuries = parseInjuryRows(injuryPayload);
    rates = parseRatePlayers(ratePayload);
  } catch (_) {
    return emptyNbaReport(pulledAt);
  }
  if (!injuries.length || !rates.length) {
    return emptyNbaReport(pulledAt, { error: 'empty' });
  }
  const byTeam = new Map();
  for (const rate of rates) {
    if (!byTeam.has(rate.teamKey)) byTeam.set(rate.teamKey, []);
    byTeam.get(rate.teamKey).push(rate);
  }
  const ranks = new Map();
  for (const [teamKey, rows] of byTeam) {
    ranks.set(teamKey, { mpg: rankMap(rows, 'mpg'), ppg: rankMap(rows, 'ppg') });
  }
  const teams = {};
  const seen = new Set();
  let uncertainPlayers = 0;
  for (const inj of injuries) {
    if (!inj.uncertain || !inj.teamKey) continue;
    const rank = ranks.get(inj.teamKey);
    if (!rank) continue;
    const mpgRank = rank.mpg.get(inj.nameKey) || null;
    const ppgRank = rank.ppg.get(inj.nameKey) || null;
    const important = (mpgRank != null && mpgRank <= 3) || (ppgRank != null && ppgRank <= 3);
    if (!important) continue;
    const dedupe = `${inj.teamKey}|${inj.nameKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (!teams[inj.teamKey]) teams[inj.teamKey] = { team: inj.team, uncertain: [] };
    teams[inj.teamKey].uncertain.push({
      name: inj.name,
      status: inj.uncertain,
      mpgRank,
      ppgRank,
    });
    uncertainPlayers += 1;
  }
  return {
    ok: true,
    softFail: false,
    pulledAt,
    source: NBA_INJURY_URL,
    importanceSource: NBA_RATES_URL,
    importance: 'top3-mpg-or-ppg',
    teams,
    uncertainPlayers,
    error: null,
  };
}

function pullJson(url, timeoutMs, fetchImpl) {
  const pull = fetchImpl || globalThis.fetch;
  const ms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : NBA_INJURY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (typeof pull !== 'function') {
      reject(new Error('no-fetch'));
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('timeout'));
    }, ms);
    Promise.resolve()
      .then(() => pull(url, { signal: AbortSignal.timeout(ms) }))
      .then(async (resp) => {
        if (!resp || resp.ok === false) throw new Error('http');
        if (typeof resp.json === 'function') return resp.json();
        return resp;
      })
      .then((body) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(body);
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('soft-fail'));
      });
  });
}

/**
 * One injuries call and one rate call, in parallel, each capped at timeoutMs.
 * Any failure returns a soft-fail report. Callers must not throw on it.
 */
async function fetchNbaInjuryReport(opts) {
  const timeoutMs = opts && Number.isFinite(Number(opts.timeoutMs))
    ? Number(opts.timeoutMs)
    : NBA_INJURY_TIMEOUT_MS;
  const pulledAt = isoStamp(opts && opts.now);
  const fetchImpl = opts && opts.fetchImpl;
  try {
    const [injuries, rates] = await Promise.all([
      pullJson(NBA_INJURY_URL, timeoutMs, fetchImpl),
      pullJson(NBA_RATES_URL, timeoutMs, fetchImpl),
    ]);
    const report = buildNbaReport(injuries, rates, { pulledAt });
    if (!report.ok) report.pulledAt = pulledAt;
    return report;
  } catch (_) {
    return emptyNbaReport(pulledAt);
  }
}

module.exports = {
  NBA_INJURY_URL,
  NBA_RATES_URL,
  NBA_INJURY_TIMEOUT_MS,
  normTeamName,
  normPlayerName,
  uncertainStatus,
  parseInjuryRows,
  parseRatePlayers,
  buildNbaReport,
  fetchNbaInjuryReport,
};
