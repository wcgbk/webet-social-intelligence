'use strict';

/**
 * Build committed NFL / NCAAF ESPN id tables.
 *
 *   ODDS_API_KEY=... node scripts/build-football-team-ids.js
 *
 * ESPN teams (FBS group 80 + FCS group 81, plus any other ESPN college team
 * an Odds API participant name or a hand alias names) and The Odds API
 * participants (1 credit per sport). Runtime does not fetch.
 * The key is never printed.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTeamName } = require('../netlify/functions/lib/omega-vnext/sports/team_normalize');

const ROOT = path.join(__dirname, '..');
const ALIAS_PATH = path.join(__dirname, 'data', 'football-team-aliases.json');
const OUT = {
  NFL: path.join(ROOT, 'netlify/functions/lib/omega-vnext/sports/data/nfl-team-ids.json'),
  NCAAF: path.join(ROOT, 'netlify/functions/lib/omega-vnext/sports/data/ncaaf-team-ids.json'),
};
const SEEDS = {
  NFL: path.join(ROOT, 'netlify/functions/lib/omega-vnext/sports/data/nfl-epa-seed.json'),
  NCAAF: path.join(ROOT, 'netlify/functions/lib/omega-vnext/sports/data/cfb-epa-seed.json'),
};

function redact(err) {
  return String((err && err.message) || err).replace(/apiKey=[^&\s]+/gi, 'apiKey=[redacted]');
}

async function getJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'webet-omega-team-ids/1.0' } });
  const credits = {
    last: resp.headers.get('x-requests-last'),
    used: resp.headers.get('x-requests-used'),
    remaining: resp.headers.get('x-requests-remaining'),
  };
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url.split('?')[0]}`);
  }
  const data = await resp.json();
  return { data, credits };
}

function espnTeams(data) {
  const leagues = data && data.sports && data.sports[0] && data.sports[0].leagues;
  const wrappers = (leagues && leagues[0] && leagues[0].teams) || [];
  return wrappers.map((w) => w.team || w).filter((t) => t && t.id && t.displayName);
}

function walkStandingsIds(node, into) {
  if (!node || typeof node !== 'object') return;
  const buckets = [];
  if (node.standings && Array.isArray(node.standings.entries)) buckets.push(...node.standings.entries);
  if (Array.isArray(node.entries)) buckets.push(...node.entries);
  for (const entry of buckets) {
    const id = entry && entry.team && entry.team.id;
    if (id) into.add(String(id));
  }
  for (const child of node.children || []) walkStandingsIds(child, into);
}

function mascotOf(team) {
  return team.name || '';
}

function stateSwaps(raw) {
  const n = normalizeTeamName(raw);
  if (!n) return [];
  const out = [];
  if (/\bstate\b/.test(n)) out.push(n.replace(/\bstate\b/g, 'st'));
  if (/\bst\b/.test(n)) out.push(n.replace(/\bst\b/g, 'state'));
  return out;
}

function endsWithState(raw) {
  return /\bstate$/.test(normalizeTeamName(raw));
}

function recordFromEspn(team, division) {
  return {
    espnId: String(team.id),
    division: division || 'other',
    displayName: team.displayName || '',
    shortDisplayName: team.shortDisplayName || '',
    abbreviation: team.abbreviation || '',
    location: team.location || '',
    nickname: team.nickname || '',
    name: team.name || '',
    oddsNames: [],
    aliases: [],
  };
}

function buildLookup(teams, handByDisplay) {
  const byId = new Map(teams.map((t) => [t.espnId, t]));
  const lookup = new Map();

  function claim(id, raw, mode) {
    const key = normalizeTeamName(raw);
    if (!key || key.length < 2) return;
    const team = byId.get(id);
    const mascot = normalizeTeamName(mascotOf(team));
    if (mascot && key === mascot) return;
    const prev = lookup.get(key);
    if (!prev) {
      lookup.set(key, { id, mode });
      return;
    }
    if (prev.id == null) {
      if (mode === 'hand' || mode === 'display') {
        prev.id = id;
        prev.mode = mode;
      }
      return;
    }
    if (prev.id === id) {
      if (mode === 'display' || mode === 'hand') prev.mode = mode;
      return;
    }
    if (mode === 'display' || prev.mode === 'display') {
      throw new Error(`displayName collision "${key}" ids ${prev.id} and ${id}`);
    }
    if (mode === 'hand' || prev.mode === 'hand') {
      throw new Error(`hand alias collision "${raw}" → "${key}" ids ${prev.id} and ${id}`);
    }
    prev.id = null;
    prev.mode = 'ambiguous';
  }

  for (const team of teams) {
    claim(team.espnId, team.displayName, 'display');
  }
  for (const team of teams) {
    const mascot = team.name || '';
    const parts = [
      team.location,
      team.shortDisplayName,
      team.abbreviation,
    ];
    if (team.location && mascot) parts.push(`${team.location} ${mascot}`);
    if (team.shortDisplayName && mascot) parts.push(`${team.shortDisplayName} ${mascot}`);
    if (team.location && mascot && !endsWithState(team.location)) {
      parts.push(`${team.location} State ${mascot}`);
      parts.push(`${team.location} St ${mascot}`);
    }
    for (const raw of parts) {
      claim(team.espnId, raw, 'auto');
      for (const swapped of stateSwaps(raw)) claim(team.espnId, swapped, 'auto');
    }
    for (const swapped of stateSwaps(team.displayName)) claim(team.espnId, swapped, 'auto');
  }
  for (const [displayName, aliases] of Object.entries(handByDisplay || {})) {
    const target = teams.find((t) => t.displayName === displayName);
    if (!target) {
      throw new Error(`hand alias target not in ESPN set: ${displayName}`);
    }
    for (const raw of aliases || []) claim(target.espnId, raw, 'hand');
  }

  const clean = new Map();
  for (const [key, row] of lookup) {
    if (row.id) clean.set(key, row.id);
  }
  return clean;
}

function applyOddsNames(teams, lookup, oddsNames) {
  const byId = new Map(teams.map((t) => [t.espnId, t]));
  const unresolved = [];
  for (const name of oddsNames) {
    const id = lookup.get(normalizeTeamName(name));
    if (!id) {
      unresolved.push(name);
      continue;
    }
    const team = byId.get(id);
    if (team && !team.oddsNames.includes(name)) team.oddsNames.push(name);
  }
  for (const team of teams) team.oddsNames.sort();
  return unresolved.sort();
}

function attachHandAliases(teams, handByDisplay) {
  for (const team of teams) {
    const list = handByDisplay[team.displayName] || [];
    team.aliases = [...list].sort();
  }
}

function seedKeys(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.keys(raw).filter((k) => k && !k.startsWith('_'));
}

function mustResolve(lookup, label, names) {
  const missing = names.filter((n) => !lookup.get(normalizeTeamName(n)));
  if (missing.length) {
    throw new Error(`${label} orphaned (${missing.length}): ${missing.join('; ')}`);
  }
}

function assertDistinct(lookup, a, b, label) {
  const ia = lookup.get(normalizeTeamName(a));
  const ib = lookup.get(normalizeTeamName(b));
  if (!ia || !ib || ia === ib) {
    throw new Error(`${label}: "${a}" (${ia}) vs "${b}" (${ib})`);
  }
}

function pack(sport, meta, teams, lookup) {
  const teamObj = {};
  const ids = teams.map((t) => t.espnId).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
  for (const id of ids) {
    const team = teams.find((t) => t.espnId === id);
    teamObj[id] = team;
  }
  const lookupObj = {};
  for (const key of [...lookup.keys()].sort()) lookupObj[key] = lookup.get(key);
  return {
    _meta: {
      ...meta,
      sport,
      teamCount: ids.length,
      lookupCount: Object.keys(lookupObj).length,
      matching: 'normalize (lowercase, strip accents, delete okina/apostrophes, collapse punctuation) then exact lookup. No substring, last-word, or mascot fallback.',
    },
    teams: teamObj,
    lookup: lookupObj,
  };
}

async function loadCollege() {
  const list = await getJson('https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000');
  const byId = new Map();
  for (const team of espnTeams(list.data)) byId.set(String(team.id), team);

  const fbsIds = new Set();
  const fcsIds = new Set();
  const fbs = await getJson('https://site.api.espn.com/apis/v2/sports/football/college-football/standings?group=80');
  const fcs = await getJson('https://site.api.espn.com/apis/v2/sports/football/college-football/standings?group=81');
  walkStandingsIds(fbs.data, fbsIds);
  walkStandingsIds(fcs.data, fcsIds);

  const missing = [...fbsIds, ...fcsIds].filter((id) => !byId.has(id));
  for (const id of missing) {
    const one = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${id}`);
    const team = one.data.team || one.data;
    if (team && team.id) byId.set(String(team.id), team);
  }
  return { byId, fbsIds, fcsIds };
}

function selectCollege(allById, fbsIds, fcsIds, oddsNames, handByDisplay) {
  const selected = new Map();
  function add(team, division) {
    if (!team || !team.id) return;
    const id = String(team.id);
    const prev = selected.get(id);
    const div = division || (fbsIds.has(id) ? 'fbs' : (fcsIds.has(id) ? 'fcs' : 'other'));
    if (!prev) selected.set(id, recordFromEspn(team, div));
  }
  for (const id of fbsIds) add(allById.get(id), 'fbs');
  for (const id of fcsIds) add(allById.get(id), 'fcs');

  const oddsNorm = new Set(oddsNames.map(normalizeTeamName));
  for (const team of allById.values()) {
    if (oddsNorm.has(normalizeTeamName(team.displayName))) add(team, null);
  }
  for (const displayName of Object.keys(handByDisplay || {})) {
    const team = [...allById.values()].find((t) => t.displayName === displayName);
    if (!team) throw new Error(`hand alias target missing from ESPN: ${displayName}`);
    add(team, null);
  }
  return [...selected.values()];
}

async function main() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error('ODDS_API_KEY is not set');
    process.exit(1);
  }
  const aliasFile = JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8'));
  const allow = new Set(aliasFile.allowUnresolved || []);
  const credits = [];

  const nflEspn = await getJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=100');
  const college = await loadCollege();

  async function oddsParticipants(sportKey) {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/participants?apiKey=${encodeURIComponent(apiKey)}`;
    try {
      const res = await getJson(url);
      credits.push({ sport: sportKey, last: res.credits.last, remaining: res.credits.remaining });
      const names = (res.data || []).map((row) => row.full_name || row.name).filter(Boolean);
      return names;
    } catch (err) {
      throw new Error(redact(err));
    }
  }

  const nflOdds = await oddsParticipants('americanfootball_nfl');
  const ncaafOdds = await oddsParticipants('americanfootball_ncaaf');

  const nflTeams = espnTeams(nflEspn.data).map((t) => recordFromEspn(t, 'nfl'));
  const ncaafTeams = selectCollege(college.byId, college.fbsIds, college.fcsIds, ncaafOdds, aliasFile.NCAAF || {});

  const built = {
    NFL: { teams: nflTeams, hand: aliasFile.NFL || {}, odds: nflOdds },
    NCAAF: { teams: ncaafTeams, hand: aliasFile.NCAAF || {}, odds: ncaafOdds },
  };

  const generatedAt = new Date().toISOString();
  for (const sport of ['NFL', 'NCAAF']) {
    const { teams, hand, odds } = built[sport];
    const lookup = buildLookup(teams, hand);
    attachHandAliases(teams, hand);
    const unresolved = applyOddsNames(teams, lookup, odds);
    const unexpected = unresolved.filter((n) => !allow.has(n));
    if (unexpected.length) {
      throw new Error(`${sport} Odds names unresolved (${unexpected.length}): ${unexpected.join('; ')}`);
    }
    mustResolve(lookup, `${sport} seed`, seedKeys(SEEDS[sport]));
    if (sport === 'NFL') {
      if (teams.length !== 32) throw new Error(`NFL team count ${teams.length}`);
      mustResolve(lookup, 'NFL display', teams.map((t) => t.displayName));
    }
    if (sport === 'NCAAF') {
      assertDistinct(lookup, 'Georgia State Panthers', 'Georgia Bulldogs', 'Georgia State');
      assertDistinct(lookup, 'Georgia State', 'Georgia', 'Georgia State school');
      assertDistinct(lookup, 'Georgia State Panthers', 'Pittsburgh Panthers', 'Georgia State/Pitt');
      assertDistinct(lookup, 'Miami (OH) RedHawks', 'Miami Hurricanes', 'Miami OH');
      assertDistinct(lookup, 'Miami (OH)', 'Miami', 'Miami OH short');
      assertDistinct(lookup, 'Kentucky Wildcats', 'Kansas State Wildcats', 'Kentucky');
      assertDistinct(lookup, 'Army Black Knights', 'UCF Knights', 'Army');
      assertDistinct(lookup, 'Western Michigan Broncos', 'Boise State Broncos', 'WMU');
      assertDistinct(lookup, 'UNLV Rebels', 'Ole Miss Rebels', 'UNLV');
      assertDistinct(lookup, 'Central Arkansas Bears', 'Baylor Bears', 'Central Arkansas');
      const mcneeseA = lookup.get(normalizeTeamName('McNeese'));
      const mcneeseB = lookup.get(normalizeTeamName('McNeese State Cowboys'));
      if (!mcneeseA || mcneeseA !== mcneeseB) throw new Error('McNeese alias mismatch');
      for (const mascot of ['Wildcats', 'Panthers', 'Bears', 'Rebels', 'Knights', 'Broncos', 'Tigers']) {
        if (lookup.get(normalizeTeamName(mascot))) {
          throw new Error(`mascot key leaked into NCAAF lookup: ${mascot}`);
        }
      }
    }
    const body = pack(sport, {
      generatedAt,
      source: 'ESPN site teams API + The Odds API participants',
      oddsSport: sport === 'NFL' ? 'americanfootball_nfl' : 'americanfootball_ncaaf',
      groups: sport === 'NCAAF' ? { fbs: '80', fcs: '81' } : null,
      allowUnresolved: unresolved.filter((n) => allow.has(n)),
    }, teams, lookup);
    fs.writeFileSync(OUT[sport], `${JSON.stringify(body, null, 2)}\n`);
    console.log(`${sport} teams=${teams.length} lookup=${lookup.size} odds=${odds.length} unresolved=${unresolved.length}`);
    if (unresolved.length) console.log(`  allowUnresolved: ${unresolved.join('; ')}`);
  }

  const spent = credits.reduce((s, row) => s + (Number(row.last) || 0), 0);
  console.log(`odds_credits_this_run=${spent}`);
  for (const row of credits) {
    console.log(`  ${row.sport} last=${row.last} remaining=${row.remaining}`);
  }
}

main().catch((err) => {
  console.error(redact(err));
  process.exit(1);
});
