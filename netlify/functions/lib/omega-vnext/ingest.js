'use strict';

const {
  SPORTS_ENABLED, ODDS_SPORT_KEYS, ESPN_LEAGUES,
  ncaafGpFixEnabled, teamExactOnly,
} = require('./config');
const { parseWinLossRecord } = require('./sports/_common');
const { resolveTeamId } = require('./sports/team_identity');
const { sportsForCard } = require('./season_calendar');
const { isSameEtDay, etCalendarDate } = require('./odds_math');
const { buildPitcherIndex, emptyPitcherIndex, mlbSeasonFromDate } = require('./sports/mlb_env');
const { memoFetchJson, memoValue, slateOddsGate } = require('./fetch_memo');

const ODDS_REGIONS = 'us,us2,eu';
const ODDS_MARKETS = 'h2h,spreads,totals';

function enabledSportLabels(dateISO) {
  if (!dateISO) return Object.keys(SPORTS_ENABLED).filter(s => SPORTS_ENABLED[s]);
  return sportsForCard(dateISO);
}

async function fetchJson(url, timeoutMs = 12000) {
  return memoFetchJson(url, timeoutMs);
}

/**
 * Odds API multi-sport snapshot. Timestamped. Does not burn extras beyond one pass/sport.
 */
async function fetchOddsMultiSport(dateISO, opts = {}) {
  const apiKey = process.env.ODDS_API_KEY;
  const out = { bySport: {}, fetchedAt: new Date().toISOString(), snapshotNote: 'live', oddsErrors: [] };
  if (!apiKey) {
    console.log('[omega-vnext/ingest] No ODDS_API_KEY — skipping odds');
    return out;
  }

  const sports = enabledSportLabels(dateISO);
  for (const label of sports) {
    const key = ODDS_SPORT_KEYS[label];
    if (!key) continue;
    try {
      let url;
      if (opts.historicalSnapshot) {
        out.snapshotNote = `historical:${opts.historicalSnapshot}`;
        url = `https://api.the-odds-api.com/v4/historical/sports/${key}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}&date=${encodeURIComponent(opts.historicalSnapshot)}`;
      } else {
        const gate = await slateOddsGate({ sportKey: key, apiKey, dateISO });
        if (gate.skip) {
          out.bySport[label] = [];
          console.log(`[omega-vnext/ingest] ${label}: skip Odds API (${gate.reason}, events=${gate.events})`);
          continue;
        }
        url = `https://api.the-odds-api.com/v4/sports/${key}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
      }
      const data = await fetchJson(url, 15000);
      // historical endpoint wraps in { data: [...] }
      const rawEvents = Array.isArray(data) ? data : (data && data.data) || [];
      const events = filterEventsSameEtDay(rawEvents, dateISO);
      out.bySport[label] = events;
      const remaining = null; // header not available via fetch easily
      console.log(`[omega-vnext/ingest] ${label}: ${events.length}/${rawEvents.length} events (same-ET-day ${dateISO || 'n/a'})`);
    } catch (e) {
      console.error(`[omega-vnext/ingest] Odds ${label} failed: ${e.message}`);
      out.bySport[label] = [];
      out.oddsErrors.push(oddsFailureRecord(label, e));
    }
  }
  return out;
}

function oddsFailureRecord(sport, err) {
  const status = err && err.status != null && err.status !== '' ? Number(err.status) : null;
  let message = String((err && err.message) || 'odds fetch failed');
  message = message.replace(/https?:\/\/\S+/gi, '');
  message = message.replace(/apiKey=[^&\s]*/gi, '');
  message = message.replace(/\bapi[_-]?key\b/gi, '');
  message = message.replace(/\s+/g, ' ').trim();
  const creditHint = (status === 401 || status === 429 || /quota|credit/i.test(message)) ? 'quota_or_auth' : null;
  return {
    sport,
    status: Number.isFinite(status) ? status : null,
    message,
    creditHint,
  };
}

function dateParamET(dateISO) {
  return String(dateISO || '').replace(/-/g, '');
}

/** Keep only events whose commence_time falls on cardDateISO (ET calendar day). */
function filterEventsSameEtDay(events, dateISO) {
  if (!dateISO) return events || [];
  const kept = [];
  let dropped = 0;
  for (const ev of events || []) {
    const t = ev.commence_time || ev.commenceTime || ev.date;
    if (t && isSameEtDay(t, dateISO)) kept.push(ev);
    else dropped += 1;
  }
  if (dropped) {
    console.log(`[omega-vnext/ingest] day-scope drop ${dropped} event(s) not on ${dateISO} ET`);
  }
  return kept;
}



function extractProbable(competitor) {
  if (!competitor) return null;
  const probs = competitor.probables || competitor.probablePitchers || [];
  if (Array.isArray(probs) && probs.length) {
    const p = probs[0];
    const name = (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || p.displayName || p.name || null;
    if (name) return { name, id: (p.athlete && p.athlete.id) || p.id || null };
  }
  // Some scoreboards nest under competitor.athletes / roster hints — skip if absent
  return null;
}

/**
 * ESPN season.type is either a number (1 = preseason) or { type, name }.
 * slug/name "preseason" also counts. Other sports ignore these fields.
 */
function scoreboardSeasonFields(ev) {
  const season = (ev && ev.season) || {};
  const typeObj = season.type && typeof season.type === 'object' ? season.type : null;
  const raw = typeObj ? (typeObj.type != null ? typeObj.type : typeObj.id) : season.type;
  const seasonTypeNum = Number(raw);
  const seasonType = Number.isFinite(seasonTypeNum) ? seasonTypeNum : null;
  const label = `${season.slug || ''} ${typeObj ? (typeObj.name || '') : ''} ${typeObj ? (typeObj.abbreviation || '') : ''}`;
  return {
    seasonType,
    preseason: seasonType === 1 || /preseason/i.test(label),
  };
}

async function fetchEspnScoreboard(label, dateISO) {
  const cfg = ESPN_LEAGUES[label];
  if (!cfg) return { league: label, games: [] };
  const dates = dateParamET(dateISO);
  let url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/scoreboard`;
  if (dates) url += `?dates=${dates}`;
  // CFB often needs groups; keep simple for v1
  try {
    const data = await fetchJson(url, 10000);
    const games = (data.events || []).map(ev => {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
      const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
      const homeProb = extractProbable(home);
      const awayProb = extractProbable(away);
      return {
        id: ev.id,
        name: ev.name,
        shortName: ev.shortName,
        commenceTime: ev.date || comp.date,
        status: (comp.status && comp.status.type && comp.status.type.state) || 'pre',
        homeTeam: (home.team && (home.team.displayName || home.team.name)) || '',
        awayTeam: (away.team && (away.team.displayName || away.team.name)) || '',
        homeAbbr: (home.team && home.team.abbreviation) || '',
        awayAbbr: (away.team && away.team.abbreviation) || '',
        homeScore: home.score != null ? Number(home.score) : null,
        awayScore: away.score != null ? Number(away.score) : null,
        homeProbable: homeProb,
        awayProbable: awayProb,
        weather: extractWeather(comp),
        indoor: !!(comp.venue && comp.venue.indoor === true),
        neutralSite: comp.neutralSite === true,
        ...scoreboardSeasonFields(ev),
      };
    });
    const sameDay = games.filter(g => !dateISO || !g.commenceTime || isSameEtDay(g.commenceTime, dateISO));
    if (sameDay.length !== games.length) {
      console.log(`[omega-vnext/ingest] ESPN ${label}: day-scope ${sameDay.length}/${games.length} on ${dateISO}`);
    }
    const seasonYear = data && data.season && data.season.year != null ? Number(data.season.year) : null;
    const weekNumber = data && data.week && data.week.number != null ? Number(data.week.number) : null;
    const calendar = (data && data.leagues && data.leagues[0] && data.leagues[0].calendar) || null;
    return {
      league: label,
      games: sameDay,
      seasonYear: Number.isInteger(seasonYear) ? seasonYear : null,
      weekNumber: Number.isInteger(weekNumber) ? weekNumber : null,
      calendar: Array.isArray(calendar) ? calendar : null,
    };
  } catch (e) {
    console.error(`[omega-vnext/ingest] ESPN ${label}: ${e.message}`);
    return { league: label, games: [], seasonYear: null, weekNumber: null, calendar: null };
  }
}

/**
 * Home, away, road, division, and conference slices. The overall column
 * has type pointsfor / total, not one of these prefixes. A stat with no
 * type is kept (callers that pass a bare {name, value} stay on that row).
 */
function isSplitStat(stat) {
  const type = String((stat && stat.type) || '').toLowerCase().replace(/[\s._-]+/g, '');
  if (!type || type === 'total' || type === 'overall') return false;
  if (type.startsWith('home') || type.startsWith('away') || type.startsWith('road')) return true;
  if (type.includes('homerecord') || type.includes('awayrecord') || type.includes('roadrecord')) return true;
  if (type.startsWith('vs')) return true;
  return false;
}

function espnStat(stats, names) {
  const want = new Set(names.map(n => String(n).toLowerCase()));
  for (const s of stats || []) {
    if (isSplitStat(s)) continue;
    const name = String((s && s.name) || '').toLowerCase();
    if (!want.has(name)) continue;
    const v = Number(s.value);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Exact stat name, overall/total slice only. First hit. No substring. */
function findExactStat(stats, name) {
  const want = String(name);
  for (const s of stats || []) {
    if (!s || isSplitStat(s)) continue;
    if (s.name === want) return s;
  }
  return null;
}

function statNumber(stat) {
  return stat ? Number(stat.value) : null;
}

/**
 * Season pointsFor / pointsAgainst / winPercent by exact name.
 * avgPointsFor is not a stand-in for either column (it is a substring of
 * the old pointsFor regex and used to bind both pf and winPct).
 * runsFor / runsAgainst count only when the points column is absent.
 * A home-only slice is not a fallback.
 */
function standingNumbers(stats) {
  const winPct = findExactStat(stats, 'winPercent');
  const pf = findExactStat(stats, 'pointsFor') || findExactStat(stats, 'runsFor');
  const pa = findExactStat(stats, 'pointsAgainst') || findExactStat(stats, 'runsAgainst');
  const wins = findExactStat(stats, 'wins');
  const losses = findExactStat(stats, 'losses');
  return {
    winPct: statNumber(winPct),
    pf: statNumber(pf),
    pa: statNumber(pa),
    wins: statNumber(wins),
    losses: statNumber(losses),
  };
}

function collectStandingsEntries(data) {
  const entries = [];
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node.standings && node.standings.entries)) {
      entries.push(...node.standings.entries);
    }
    if (Array.isArray(node.entries)) entries.push(...node.entries);
    (node.children || []).forEach(walk);
  }
  if (data && data.standings && data.standings.entries) entries.push(...data.standings.entries);
  walk(data);
  return entries;
}

function ratingsFromStandingsEntries(entries, label) {
  const ratings = {};
  for (const e of entries || []) {
    const team = (e.team && (e.team.displayName || e.team.name)) || '';
    if (!team) continue;
    const stats = e.stats || [];
    ratings[team] = standingNumbers(stats);
    if (label === 'NHL') applyNhlStandingStats(ratings[team], stats);
    else if (label === 'NFL' || label === 'NCAAF') applyFootballStandingExtras(ratings[team], stats);
    else if (label === 'NBA') applyNbaStandingExtras(ratings[team], stats);
  }
  return ratings;
}

function normStatLabel(value) {
  return String(value || '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ESPN NHL Goals For/Against. The live table names the column pointsFor
 * with displayName "Goals For" and abbreviation GF (same for Against / GA).
 * An explicit goalsFor name wins. displayName "Goals For" is that same
 * column. Abbreviation GF/GA counts only on pointsFor/pointsAgainst.
 * Other sports do not call this.
 */
function nhlGoalTotal(stats, side) {
  const seasonNames = side === 'for' ? ['goalsfor'] : ['goalsagainst'];
  const avgNames = side === 'for' ? ['avggoalsfor'] : ['avggoalsagainst'];
  const displayNames = side === 'for'
    ? ['goals for', 'avg goals for']
    : ['goals against', 'avg goals against'];
  const abbr = side === 'for' ? 'gf' : 'ga';
  const pointsName = side === 'for' ? 'pointsfor' : 'pointsagainst';
  let byDisplay = null;
  let byAbbr = null;
  for (const s of stats || []) {
    if (!s || typeof s !== 'object') continue;
    const v = Number(s.value);
    if (!Number.isFinite(v)) continue;
    const name = normStatLabel(s.name).replace(/ /g, '');
    const display = normStatLabel(s.displayName);
    const ab = normStatLabel(s.abbreviation);
    // goalsFor is a season total. avgGoalsFor is already per game.
    if (seasonNames.includes(name)) return { value: v, season: true };
    if (avgNames.includes(name)) return { value: v, season: false };
    if (byDisplay == null && displayNames.includes(display)) {
      byDisplay = { value: v, season: display.indexOf('avg ') !== 0 };
    }
    if (byAbbr == null && ab === abbr && name === pointsName) byAbbr = { value: v, season: true };
  }
  if (byDisplay != null) return byDisplay;
  return byAbbr;
}

/**
 * NHL standings extras. Prefer Goals For/Against (name or displayName).
 * A bare pointsFor is standings points (2*W+OTL) only when it sits on
 * `points` AND the per-game rate looks like standings points (≤ ~2.05).
 * A rate in the goal band (~1.8–6) is goals, even when GF ≈ Pts
 * (Florida 6/4, and the other early GF≈Pts clubs once labeled Goals For).
 * Otherwise clear pf/pa so the projector stays on the 6.2 / HFA baseline.
 * Other sports do not call this.
 */
function applyNhlStandingStats(row, stats) {
  const team = row && typeof row === 'object' ? row : {};
  const gp = espnStat(stats, ['gamesPlayed', 'games']);
  const otl = espnStat(stats, ['otLosses', 'overtimeLosses', 'otl']);
  const ties = espnStat(stats, ['ties']);
  if (gp != null && gp > 0) team.games = gp;
  if (otl != null) team.otLosses = otl;
  if (ties != null) team.ties = ties;
  if (!(Number(team.games) > 0) && otl != null && Number.isFinite(team.wins) && Number.isFinite(team.losses)) {
    team.games = team.wins + team.losses + otl + (Number.isFinite(team.ties) ? team.ties : 0);
  }

  const gfStat = nhlGoalTotal(stats, 'for');
  const gaStat = nhlGoalTotal(stats, 'against');
  const gf = gfStat ? gfStat.value : null;
  const ga = gaStat ? gaStat.value : null;
  const pf = espnStat(stats, ['pointsFor']);
  const pa = espnStat(stats, ['pointsAgainst']);
  const avgF = espnStat(stats, ['avgPointsFor']);
  const avgA = espnStat(stats, ['avgPointsAgainst']);
  const pts = espnStat(stats, ['points']);
  const wins = Number.isFinite(Number(team.wins)) ? Number(team.wins) : espnStat(stats, ['wins']);
  const games = Number(team.games);

  let scoring = null;
  if (gf != null && ga != null && gf > 0 && ga > 0) {
    scoring = { pf: gf, pa: ga };
  } else if (avgF != null && avgA != null && avgF >= 1.8 && avgF <= 6 && avgA >= 1.8 && avgA <= 6) {
    scoring = { pf: avgF, pa: avgA };
  } else if (pf != null && pa != null && pf > 0 && pa > 0) {
    const rate = games > 0 ? pf / games : pf;
    const inGoalBand = rate >= 1.8 && rate <= 6;
    const standingsPpg = rate <= 2.05;
    const closeToPts = pts != null && Math.abs(pf - pts) <= Math.max(2, Math.abs(pts) * 0.08);
    // Standings-points duplicate only. Never when the rate is already a goal rate.
    const dupPoints = closeToPts && standingsPpg && !inGoalBand;
    const guessPts = Number.isFinite(wins) && wins >= 0
      ? (2 * wins + (otl != null ? otl : 0))
      : null;
    const nearGuess = guessPts != null && guessPts >= 8
      && Math.abs(pf - guessPts) <= Math.max(3, guessPts * 0.12)
      && !inGoalBand;
    const implied = games > 0 && pf > 6 ? pf / games : pf;
    const impliedGoal = implied >= 1.8 && implied <= 6 && (games > 0 || pf <= 6);
    const aheadOfPoints = pts == null || pf > pts * 1.5;
    if (!dupPoints && !nearGuess && (inGoalBand || (impliedGoal && aheadOfPoints))) scoring = { pf, pa };
  }
  if (scoring) {
    team.pf = scoring.pf;
    team.pa = scoring.pa;
    // ESPN "Goals For" is a season sum, even when week-1 totals still sit
    // inside the per-game band. Avg columns stay rates (flag omitted).
    if (gfStat && gaStat && gfStat.season && gaStat.season) team.nhlSeasonGoals = true;
  } else {
    team.pf = null;
    team.pa = null;
    team.nhlSeasonGoals = false;
  }

  const wp = espnStat(stats, ['pointPercent', 'pointsPercentage', 'winPercent', 'winPct']);
  if (wp != null && wp >= 0 && wp <= 1) team.winPct = wp;
  else if (wp != null && wp > 1 && wp <= 100) team.winPct = wp / 100;
  else if (!(team.winPct >= 0 && team.winPct <= 1)) team.winPct = null;

  const sf = espnStat(stats, ['shotsFor', 'avgShotsFor', 'shotsPerGame']);
  const sa = espnStat(stats, ['shotsAgainst', 'avgShotsAgainst']);
  const sv = espnStat(stats, ['savePct', 'savePercentage']);
  const sh = espnStat(stats, ['shootingPct', 'shootingPercentage']);
  if (sf != null) team.shotsFor = sf;
  if (sa != null) team.shotsAgainst = sa;
  if (sv != null) team.savePct = sv;
  if (sh != null) team.shootingPct = sh;
  return team;
}

/**
 * NFL/NCAAF only. Additive. ESPN pointsFor stays the season sum.
 * gamesPlayed/games is stored when that stat exists. avgPointsFor is stored
 * only under that per-game name, and only as a pair. Other sports do not call this.
 */
/**
 * NBA only. Additive. avgPointsFor/Against stay per-game and are never
 * divided here. pointsFor/Against are copied as ESPN sent them. The
 * projector splits a season sum from a rate. Pace and ratings are copied
 * when the standings row has them. Other sports do not call this.
 */
function applyNbaStandingExtras(row, stats) {
  const team = row && typeof row === 'object' ? row : {};
  const gp = espnStat(stats, ['gamesPlayed', 'games']);
  if (gp != null && gp > 0) {
    team.gamesPlayed = gp;
    team.games = gp;
  }
  const avgF = espnStat(stats, ['avgPointsFor']);
  const avgA = espnStat(stats, ['avgPointsAgainst']);
  if (avgF != null) team.avgPointsFor = avgF;
  if (avgA != null) team.avgPointsAgainst = avgA;
  const pf = espnStat(stats, ['pointsFor']);
  const pa = espnStat(stats, ['pointsAgainst']);
  if (pf != null) team.pointsFor = pf;
  if (pa != null) team.pointsAgainst = pa;
  const pace = espnStat(stats, ['pace', 'paceFactor', 'avgPace']);
  if (pace != null) team.pace = pace;
  const off = espnStat(stats, ['offensiveRating', 'offRtg', 'avgOffensiveRating']);
  const def = espnStat(stats, ['defensiveRating', 'defRtg', 'avgDefensiveRating']);
  if (off != null) team.offRtg = off;
  if (def != null) team.defRtg = def;
  return team;
}

/**
 * ESPN `overall` is type "total" with value null and displayValue "W-L" or
 * "W-L-T". College rows omit losses and gamesPlayed. Fill those only when
 * the field is actually missing — never write losses 0 because the stat
 * was absent, and never overwrite an explicit NFL loss or game count.
 * OMEGA_NCAAF_GP_FIX=0 leaves the row untouched beyond the numeric extras.
 */
function espnOverallRecord(stats) {
  for (const s of stats || []) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || '').toLowerCase();
    if (name !== 'overall' && name !== 'overallrecord') continue;
    const parsed = parseWinLossRecord(s.displayValue || s.summary || s.value);
    if (parsed) return parsed;
  }
  return null;
}

function fillFootballRecord(team, stats) {
  if (!ncaafGpFixEnabled()) return team;
  const parsed = espnOverallRecord(stats);
  if (!parsed) return team;
  const lossesMissing = team.losses == null;
  const gamesMissing = !(Number(team.gamesPlayed) > 0) && !(Number(team.games) > 0);
  if (team.record == null) team.record = parsed.text;
  if (team.wins == null) team.wins = parsed.wins;
  if (lossesMissing) team.losses = parsed.losses;
  if (team.ties == null) team.ties = parsed.ties;
  if (gamesMissing) {
    team.gamesPlayed = parsed.games;
    team.games = parsed.games;
  }
  return team;
}

function applyFootballStandingExtras(row, stats) {
  const team = row && typeof row === 'object' ? row : {};
  const gp = espnStat(stats, ['gamesPlayed', 'games']);
  if (gp != null && gp > 0) {
    team.gamesPlayed = gp;
    team.games = gp;
  }
  const avgF = espnStat(stats, ['avgPointsFor']);
  const avgA = espnStat(stats, ['avgPointsAgainst']);
  if (avgF != null && avgA != null) {
    team.avgPointsFor = avgF;
    team.avgPointsAgainst = avgA;
  }
  return fillFootballRecord(team, stats);
}

async function fetchEspnStandings(label) {
  return memoValue(`espn-standings:${label}`, () => loadEspnStandings(label));
}

async function loadEspnStandings(label) {
  const cfg = ESPN_LEAGUES[label];
  if (!cfg) return {};
  // NFL / CFB / MLB standings endpoints differ; best-effort
  const urls = [
    `https://site.api.espn.com/apis/v2/sports/${cfg.sport}/${cfg.league}/standings`,
    `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/standings`,
  ];
  for (const url of urls) {
    try {
      const data = await fetchJson(url, 10000);
      const ratings = ratingsFromStandingsEntries(collectStandingsEntries(data), label);
      if (Object.keys(ratings).length) return ratings;
    } catch (_) { /* try next */ }
  }
  return {};
}

function stripMeta(table) {
  const out = {};
  if (!table || typeof table !== 'object' || Array.isArray(table)) return out;
  for (const [k, v] of Object.entries(table)) {
    if (!k || k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function readTalentFile() {
  try {
    return require('./sports/data/cfb-talent-seed.json');
  } catch (e) {
    console.error(`[omega-vnext/ingest] CFB talent seed soft-fail: ${e.message}`);
    return null;
  }
}

function loadTalentSeed() {
  return stripMeta(readTalentFile() || {});
}

function talentSeedMeta() {
  const raw = readTalentFile();
  return (raw && raw._meta && typeof raw._meta === 'object') ? raw._meta : {};
}

/**
 * Attach optional talent/spPlus onto EPA rows without wiping EPA fields.
 * Exact team identity (same ESPN id) when OMEGA_TEAM_EXACT_ONLY is on.
 * A mascot match is never a merge: Kentucky does not take Arizona's talent.
 * The toggle off keeps the old exact display-name key. scale is 'centered'
 * or 'pct_0_100' from the seed meta.
 */
function talentValueFor(team, talent) {
  if (!teamExactOnly()) {
    if (!Object.prototype.hasOwnProperty.call(talent, team)) return undefined;
    return talent[team];
  }
  const id = resolveTeamId('NCAAF', team);
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(talent, team)) return talent[team];
  for (const [key, value] of Object.entries(talent)) {
    if (!key || key.startsWith('_')) continue;
    if (resolveTeamId('NCAAF', key) === id) return value;
  }
  return undefined;
}

function mergeTalentIntoEfficiency(epaTable, talentTable, scale) {
  const out = { ...(epaTable || {}) };
  const talent = talentTable || {};
  const talentScale = scale === 'pct_0_100' ? 'pct_0_100' : 'centered';
  for (const [team, row] of Object.entries(out)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const t = talentValueFor(team, talent);
    if (t === undefined) continue;
    let talentVal = null;
    let spPlus = null;
    if (t != null && typeof t === 'object') {
      spPlus = t.spPlus != null ? t.spPlus : null;
      talentVal = t.talent != null ? t.talent : spPlus;
    } else if (Number.isFinite(Number(t))) {
      talentVal = Number(t);
    }
    if (!Number.isFinite(Number(talentVal))) continue;
    const next = { ...row, talent: Number(talentVal), talentScale };
    if (spPlus != null && Number.isFinite(Number(spPlus))) next.spPlus = Number(spPlus);
    out[team] = next;
  }
  return out;
}

function loadEfficiencySeeds() {
  const nfl = require('./sports/data/nfl-epa-seed.json');
  const cfb = require('./sports/data/cfb-epa-seed.json');
  const talent = loadTalentSeed();
  // centerSeed recomputes d from the raw file. _meta.centered is a note, not an input.
  const { centerSeed, talentScaleMode } = require('./sports/epa');
  let scale = 'centered';
  try {
    scale = talentScaleMode(talentSeedMeta());
  } catch (e) {
    console.error(`[omega-vnext/ingest] talent scale soft-fail: ${e.message}`);
  }
  return {
    NFL: centerSeed(stripMeta(nfl)),
    NCAAF: mergeTalentIntoEfficiency(centerSeed(stripMeta(cfb)), talent, scale),
  };
}

function loadParkFactors() {
  return stripMeta(require('./sports/data/mlb-park-factors.json'));
}

/**
 * One StatsAPI pull per generate. Player lines preferred; team rates are a
 * fallback index only. Any failure returns an empty index — never throws.
 */
async function fetchMlbPitcherStats(dateISO) {
  const empty = emptyPitcherIndex();
  try {
    const season = mlbSeasonFromDate(dateISO);
    const playerUrl = `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${season}&sportId=1&playerPool=all&limit=2000&gameType=R`;
    const teamUrl = `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&sportId=1&group=pitching&stats=season&gameType=R`;
    const [playerRes, teamRes] = await Promise.allSettled([
      fetchJson(playerUrl, 8000),
      fetchJson(teamUrl, 8000),
    ]);
    if (playerRes.status === 'rejected') {
      console.error(`[omega-vnext/ingest] MLB player stats failed: ${playerRes.reason && playerRes.reason.message}`);
    }
    if (teamRes.status === 'rejected') {
      console.error(`[omega-vnext/ingest] MLB team pitching failed: ${teamRes.reason && teamRes.reason.message}`);
    }
    const players = playerRes.status === 'fulfilled' ? playerRes.value : null;
    const teams = teamRes.status === 'fulfilled' ? teamRes.value : null;
    if (!players && !teams) return empty;
    const idx = buildPitcherIndex(players, teams);
    console.log(`[omega-vnext/ingest] MLB pitcher stats season=${season} players=${Object.keys(idx.byId).length} teams=${Object.keys(idx.byTeam).length}`);
    return idx;
  } catch (e) {
    console.error(`[omega-vnext/ingest] MLB pitcher stats failed (standings fallback): ${e.message}`);
    return empty;
  }
}

/**
 * EPA seeds + park table + optional StatsAPI. Each piece fails soft to {}.
 * deps is for tests — production calls the real loaders.
 */

const { prevEtDate, restMapFromScoreboard } = require('./sports/game_day');
const { loadFootballRestSchedules, scheduleDir } = require('./sports/rest_schedule');

/** Soft QB out/doubtful/questionable map from ESPN injuries (football). */
async function fetchFootballQbStatusMap(leagueSlug) {
  const out = {};
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/${leagueSlug}/injuries`;
    const data = await fetchJson(url, 8000);
    const apply = (teamName, pos, status, athleteName) => {
      if ((pos || '').toUpperCase() !== 'QB') return;
      const st = String(status || '').toLowerCase();
      if (!st) return;
      if (!/(out|doubtful|questionable|injured reserve|\bir\b|ruled out)/i.test(st)) return;
      const key = teamName;
      // Prefer worse status if multiple
      const rank = (s) => (/out|ruled out|ir|injured reserve/.test(s) ? 3 : /doubtful/.test(s) ? 2 : 1);
      const prev = out[key];
      if (prev && rank(String(prev.qbStatus)) >= rank(st)) return;
      out[key] = { team: teamName, qbStatus: st, qbName: athleteName || null };
    };
    for (const team of (data.injuries || data.teams || [])) {
      const teamName = team.displayName || (team.team && team.team.displayName) || '';
      for (const inj of (team.injuries || team.athletes || [])) {
        apply(
          teamName,
          (inj.athlete && inj.athlete.position && inj.athlete.position.abbreviation) || inj.position,
          inj.status || inj.type,
          (inj.athlete && inj.athlete.displayName) || inj.displayName
        );
      }
    }
  } catch (e) {
    console.log(`[omega-vnext/ingest] QB status ${leagueSlug} soft-fail: ${e.message}`);
  }
  return out;
}

function extractWeather(comp) {
  if (!comp) return null;
  const w = comp.weather || comp.situation && comp.situation.weather || null;
  if (!w || typeof w !== 'object') return null;
  const temp = w.temperature != null ? Number(w.temperature) : (w.temp != null ? Number(w.temp) : null);
  const wind = w.windSpeed != null ? Number(String(w.windSpeed).replace(/[^\d.]/g, '')) : null;
  return {
    tempF: Number.isFinite(temp) ? temp : null,
    condition: w.condition || w.displayValue || w.type || null,
    windMph: Number.isFinite(wind) ? wind : null,
    windDir: w.windDirection || w.displayValue || null,
  };
}

async function loadGameDayContext(dateISO, labels, espnBySport) {
  const gameDay = {
    restByTeam: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} },
    qbStatusBySport: { NFL: {}, NCAAF: {} },
    weatherByGame: {},
  };
  const prev = prevEtDate(dateISO);
  if (prev) {
    for (const label of labels) {
      if (!['MLB', 'NFL', 'NCAAF', 'NHL'].includes(label) && label !== 'NBA') continue;
      try {
        const board = await fetchEspnScoreboard(label, prev);
        const map = restMapFromScoreboard((board && board.games) || [], prev);
        gameDay.restByTeam[label] = map;
        console.log(`[omega-vnext/ingest] rest ${label} playedYesterday=${Object.keys(map).length} (from ${prev})`);
      } catch (e) {
        console.error(`[omega-vnext/ingest] rest ${label} soft-fail: ${e.message}`);
        gameDay.restByTeam[label] = {};
      }
    }
  }
  try {
    if (labels.includes('NFL')) gameDay.qbStatusBySport.NFL = await fetchFootballQbStatusMap('nfl');
  } catch (e) {
    console.error(`[omega-vnext/ingest] NFL QB soft-fail: ${e.message}`);
  }
  try {
    if (labels.includes('NCAAF')) gameDay.qbStatusBySport.NCAAF = await fetchFootballQbStatusMap('college-football');
  } catch (e) {
    console.error(`[omega-vnext/ingest] CFB QB soft-fail: ${e.message}`);
  }
  const footballLabels = labels.filter((l) => l === 'NFL' || l === 'NCAAF');
  if (footballLabels.length) {
    try {
      gameDay.restSchedule = await loadFootballRestSchedules(dateISO, {
        labels: footballLabels,
        boards: espnBySport || {},
      });
    } catch (e) {
      console.error(`[omega-vnext/ingest] rest-days soft-fail: ${e.message}`);
      gameDay.restSchedule = {};
      for (const sport of footballLabels) {
        gameDay.restSchedule[sport] = {
          sport,
          loaded: false,
          fetchFailed: true,
          games: [],
          weeks: [],
          calls: 0,
          source: null,
          error: e.message,
        };
      }
    }
  }
  // Weather from today's MLB ESPN board already fetched
  const mlbBoard = espnBySport && espnBySport.MLB;
  for (const g of (mlbBoard && mlbBoard.games) || []) {
    // weather may not be on our mapped games — leave empty unless present
    if (g.weather) {
      const key = `${g.awayTeam || ''}|${g.homeTeam || ''}`;
      gameDay.weatherByGame[key] = g.weather;
    }
  }
  return gameDay;
}

/**
 * Season label on the shipped EPA seeds vs the card date.
 * Warns when appliesToSeason is not the card date's calendar year.
 * The flag is diagnostic. It does not change efficiency rows or projections.
 */
function buildEngineMeta(dateISO) {
  const { seedSeasonStatus } = require('./sports/epa');
  const out = { seedSeasonStale: false, NFL: null, NCAAF: null };
  let nflMeta = {};
  let cfbMeta = {};
  try {
    nflMeta = (require('./sports/data/nfl-epa-seed.json')._meta) || {};
    cfbMeta = (require('./sports/data/cfb-epa-seed.json')._meta) || {};
  } catch (e) {
    console.error(`[omega-vnext/ingest] EPA seed meta unreadable: ${e.message}`);
    return out;
  }
  out.NFL = seedSeasonStatus(nflMeta, dateISO);
  out.NCAAF = seedSeasonStatus(cfbMeta, dateISO);
  for (const sport of ['NFL', 'NCAAF']) {
    const row = out[sport];
    if (row && row.seedSeasonStale) {
      console.warn(
        `[omega-vnext/ingest] EPA seed season stale sport=${sport} season=${row.season} appliesToSeason=${row.appliesToSeason} cardSeason=${row.cardSeasonYear} date=${dateISO}`
      );
    }
  }
  out.seedSeasonStale = !!(out.NFL && out.NFL.seedSeasonStale) || !!(out.NCAAF && out.NCAAF.seedSeasonStale);
  return out;
}

async function loadSportEngines(dateISO, deps) {
  const loadSeeds = (deps && deps.loadSeeds) || loadEfficiencySeeds;
  const loadParks = (deps && deps.loadParks) || loadParkFactors;
  const fetchPitchers = (deps && deps.fetchPitchers) || ((d) => fetchMlbPitcherStats(d));
  let efficiencyBySport = { NFL: {}, NCAAF: {} };
  let parkFactors = {};
  let mlbPitcherStats = emptyPitcherIndex();
  try {
    const seeds = await loadSeeds();
    efficiencyBySport = {
      NFL: stripMeta(seeds && seeds.NFL),
      NCAAF: stripMeta(seeds && (seeds.NCAAF || seeds.CFB)),
    };
  } catch (e) {
    console.error(`[omega-vnext/ingest] EPA/efficiency load failed (standings fallback): ${e.message}`);
    efficiencyBySport = { NFL: {}, NCAAF: {} };
  }
  try {
    parkFactors = stripMeta(await loadParks());
  } catch (e) {
    console.error(`[omega-vnext/ingest] park factors load failed (neutral fallback): ${e.message}`);
    parkFactors = {};
  }
  try {
    const fetched = await fetchPitchers(dateISO);
    mlbPitcherStats = fetched && typeof fetched === 'object'
      ? fetched
      : emptyPitcherIndex();
    if (!mlbPitcherStats.byId || !mlbPitcherStats.byName || !mlbPitcherStats.byTeam) {
      mlbPitcherStats = {
        byId: (mlbPitcherStats && mlbPitcherStats.byId) || {},
        byName: (mlbPitcherStats && mlbPitcherStats.byName) || {},
        byTeam: (mlbPitcherStats && mlbPitcherStats.byTeam) || {},
      };
    }
  } catch (e) {
    console.error(`[omega-vnext/ingest] MLB pitcher stats failed (standings fallback): ${e.message}`);
    mlbPitcherStats = emptyPitcherIndex();
  }
  const nNfl = Object.keys(efficiencyBySport.NFL || {}).length;
  const nCfb = Object.keys(efficiencyBySport.NCAAF || {}).length;
  const nParks = Object.keys(parkFactors || {}).length;
  const nPit = Object.keys((mlbPitcherStats && mlbPitcherStats.byId) || {}).length;
  const engineMeta = buildEngineMeta(dateISO);
  console.log(`[omega-vnext/ingest] engines epa NFL=${nNfl} NCAAF=${nCfb} parks=${nParks} pitchers=${nPit} seedSeasonStale=${engineMeta.seedSeasonStale}`);
  return { efficiencyBySport, parkFactors, mlbPitcherStats, engineMeta };
}

async function ingest(dateISO, opts = {}) {
  if (process.env.OMEGA_FROZEN_SNAP) {
    const frozen = require(process.env.OMEGA_FROZEN_SNAP);
    const engines = await loadSportEngines(dateISO);
    let gameDay = frozen.gameDay;
    // Replay reads odds, ESPN, and injuries from the snap. Rest still
    // comes from OMEGA_REST_SCHEDULE_DIR so the gate can price rest days
    // without a sandbox patch and without a live scoreboard call.
    if (scheduleDir()) {
      const footballLabels = enabledSportLabels(dateISO).filter((l) => l === 'NFL' || l === 'NCAAF');
      gameDay = Object.assign({}, frozen.gameDay || {});
      try {
        gameDay.restSchedule = await loadFootballRestSchedules(dateISO, {
          labels: footballLabels,
          boards: frozen.espnBySport || {},
        });
      } catch (e) {
        console.error(`[omega-vnext/ingest] frozen rest-days soft-fail: ${e.message}`);
        gameDay.restSchedule = {};
        for (const sport of footballLabels) {
          gameDay.restSchedule[sport] = {
            sport,
            loaded: false,
            fetchFailed: true,
            games: [],
            weeks: [],
            calls: 0,
            source: null,
            error: e.message,
          };
        }
      }
    }
    console.log('[omega-vnext/ingest] FROZEN SNAP replay (no live odds/standings/injuries)');
    return {
      dateISO,
      oddsBySport: frozen.oddsBySport,
      espnBySport: frozen.espnBySport || {},
      standingsBySport: frozen.standingsBySport,
      efficiencyBySport: engines.efficiencyBySport,
      mlbPitcherStats: engines.mlbPitcherStats,
      parkFactors: engines.parkFactors,
      gameDay,
      fetchedAt: frozen.fetchedAt || new Date().toISOString(),
      snapshotNote: 'frozen-replay',
    };
  }

  const labels = enabledSportLabels(dateISO);
  // Also fetch standings for disabled sports? No — only enabled.
  const [odds, espnParts, standingsList, engines] = await Promise.all([
    fetchOddsMultiSport(dateISO, opts),
    Promise.all(labels.map(l => fetchEspnScoreboard(l, dateISO))),
    Promise.all(labels.map(async (l) => ({ label: l, ratings: await fetchEspnStandings(l) }))),
    loadSportEngines(dateISO),
  ]);
  const espnBySport = {};
  for (const part of espnParts) espnBySport[part.league] = part;
  const standingsBySport = {};
  for (const row of standingsList) standingsBySport[row.label] = row.ratings;

  let gameDay = { restByTeam: { MLB: {}, NFL: {}, NCAAF: {}, NHL: {}, NBA: {} }, qbStatusBySport: { NFL: {}, NCAAF: {} }, weatherByGame: {} };
  try {
    gameDay = await loadGameDayContext(dateISO, labels, espnBySport);
  } catch (e) {
    console.error(`[omega-vnext/ingest] gameDay soft-fail: ${e.message}`);
  }

  return {
    dateISO,
    oddsBySport: odds.bySport,
    espnBySport,
    standingsBySport,
    efficiencyBySport: engines.efficiencyBySport,
    mlbPitcherStats: engines.mlbPitcherStats,
    parkFactors: engines.parkFactors,
    gameDay,
    fetchedAt: odds.fetchedAt,
    snapshotNote: odds.snapshotNote,
    oddsErrors: odds.oddsErrors || [],
  };
}

module.exports = {
  loadTalentSeed,
  talentSeedMeta,
  mergeTalentIntoEfficiency,
  ingest,
  fetchOddsMultiSport,
  fetchEspnScoreboard,
  fetchEspnStandings,
  fetchMlbPitcherStats,
  loadEfficiencySeeds,
  loadParkFactors,
  loadSportEngines,
  loadGameDayContext,
  applyNhlStandingStats,
  oddsFailureRecord,
  applyFootballStandingExtras,
  applyNbaStandingExtras,
  isSplitStat,
  findExactStat,
  standingNumbers,
  collectStandingsEntries,
  ratingsFromStandingsEntries,
  scoreboardSeasonFields,
  fetchFootballQbStatusMap,
  loadFootballRestSchedules,
  enabledSportLabels,
  filterEventsSameEtDay,
  etCalendarDate,
  isSameEtDay,
};
