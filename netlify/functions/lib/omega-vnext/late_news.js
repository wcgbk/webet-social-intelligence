'use strict';

/**
 * Late-news re-checks. Drop or flag only. Never add or swap a pick.
 *
 * MLB: drop a total or side when a stored probable the model used is not the
 * live probable (id match, then samePlayerName). Flag code is sp-changed on
 * the void. A missing or TBD live probable is not a change. An empty name is
 * not a change. Postponed (detailedState /postponed/ or codes D/DR) or
 * suspended (U/US/SU or /suspended/) drops. Mere Delayed, including code DI,
 * does not. Lineups posted are recorded on the ops run and do not themselves
 * drop or flag. A change still drops when it would help the side.
 *
 * NHL: a confirmed starter is boxscore playerByGameStats goalies[] with
 * starter:true. Season-leader goalieComparison is not a confirmation. Flag
 * goalie-changed when a stored goalie is not that starter. Drop only when
 * lateNews.nhl.goalieEdge is true, meaning goalieResidual ran at generate
 * (both confirmed save rates were priced). Unconfirmed or missing starter,
 * or no stored name, is no action.
 *
 * NFL/NCAAF QB: newly out / IR / ruled-out versus the generate-time tag drops
 * (qb-out). Newly doubtful flags only (qb-doubtful). Questionable, an
 * improvement, and an already-priced out or doubtful are no action. Both
 * teams, including totals. loaded === false or a failed fetch is no action.
 * NCAAF uses the same drop/flag rules. Model points stay the documented
 * QB_INJURY.NCAAF table (outMarginPts 3.5, outTotalPts -2.0, doubtfulWeight
 * 0.75). That table is not half of NFL (3.0 / -1.5). Half-weight is the
 * NCAAF rest rule (Tue/Wed/Thu ≤5 days and bye ≥13), not a second scale on
 * QB points. Filling the map activates the existing qbSoftAdjust.
 *
 * Window: commence is strictly in the future and within 90 minutes. Graded
 * picks and games already started are left alone. Forward-only.
 */

const { samePlayerName } = require('../player-name');
const { bindEspnGameByTeamAndTime } = require('./sports/_common');
const { lookupQb } = require('./sports/game_day');

const MAX_CALLS = 30;
const TIMEOUT_MS = 4000;
const WITHIN_MIN = 90;
const NCAAF_INJURY_MAX_AGE_DAYS = 400;

const RULES = Object.freeze({
  mlb: 'Drop a total or side when a stored SP id/name the model used is not the live probable. Void code sp-changed. Missing live probable is not a change. Postponed or suspended drops. Lineups posted are recorded and do not drop.',
  nhl: 'Flag when a stored goalie is not the confirmed boxscore starter. Drop only when lateNews.nhl.goalieEdge is true (goalieResidual ran). Unconfirmed or missing starter is no action. Season-leader goalieComparison is not a confirmation.',
  qb: 'Newly out/IR/ruled-out versus the generate-time tag drops (qb-out). Newly doubtful flags only (qb-doubtful). Questionable and already-priced out/doubtful are no action. NCAAF uses the same drop/flag rules. Model points stay QB_INJURY.NCAAF (3.5 / -2.0), the documented table, not half of NFL.',
  neverAdd: true,
  withinMin: WITHIN_MIN,
  maxCalls: MAX_CALLS,
  timeoutMs: TIMEOUT_MS,
});

const MLB_SCHEDULE = 'https://statsapi.mlb.com/api/v1/schedule';
const NHL_ORIGIN = 'https://api-web.nhle.com/v1';
const ESPN_FB = 'https://site.api.espn.com/apis/site/v2/sports/football';

function noneDecision() {
  return { action: 'none', code: null, reason: null };
}

function dropDecision(code, reason) {
  return { action: 'drop', code, reason };
}

function flagDecision(code, reason) {
  return { action: 'flag', code, reason };
}

function normName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Last-word match only when the word is longer than 3 ("sox" does not collide). */
function teamNamesMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length > 3 && ` ${longer} `.includes(` ${shorter} `)) return true;
  const lastA = na.split(' ').pop();
  const lastB = nb.split(' ').pop();
  if (lastA && lastA.length > 3 && lastA === lastB) return true;
  return false;
}

function etYmd(value) {
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(when);
}

function pickCommenceMs(pick) {
  const raw = pick && (pick.commenceTime || pick.commence_time);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function isSettled(pick) {
  if (!pick || typeof pick !== 'object') return false;
  if (pick.gradedAt) return true;
  const result = String(pick.result || '').toLowerCase();
  return result === 'win' || result === 'loss' || result === 'push';
}

function pickInWindow(pick, now, withinMin = WITHIN_MIN) {
  if (!pick || pick.status === 'void-pregame') return false;
  if (isSettled(pick)) return false;
  const start = pickCommenceMs(pick);
  if (!Number.isFinite(start)) return false;
  const clock = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(clock)) return false;
  const dt = start - clock;
  const limit = Number(withinMin) * 60 * 1000;
  return dt > 0 && dt <= limit;
}

function statusAction(live) {
  if (!live || typeof live !== 'object') return null;
  const code = String(live.statusCode || '').trim().toUpperCase();
  const detail = [
    live.detailedState,
    typeof live.status === 'string' ? live.status : '',
    live.gameState,
  ].join(' ');
  const postponedWord = /postponed/i.test(detail);
  const suspendedWord = /suspended/i.test(detail);
  if (code === 'DI') {
    if (postponedWord) return 'postponed';
    if (suspendedWord) return 'suspended';
    return null;
  }
  if (code === 'D' || code === 'DR' || postponedWord) return 'postponed';
  if (code === 'U' || code === 'US' || code === 'SU' || suspendedWord) return 'suspended';
  return null;
}

function pitcherChanged(stored, live) {
  if (!stored || (stored.id == null && !String(stored.name || '').trim())) return false;
  if (!live || live.tbd) return false;
  const liveName = live.name || live.fullName || '';
  if (!String(liveName).trim()) return false;
  if (stored.id != null && live.id != null && String(stored.id) === String(live.id)) return false;
  return !samePlayerName(stored.name, liveName);
}

function goalieChanged(stored, live, confirmed) {
  if (!confirmed) return false;
  if (!stored || !String(stored.name || '').trim()) return false;
  if (!live || !String(live.name || '').trim()) return false;
  if (stored.id != null && live.id != null && String(stored.id) === String(live.id)) return false;
  return !samePlayerName(stored.name, live.name);
}

function qbClass(status) {
  const st = String(status || '').toLowerCase().trim();
  if (!st) return 'none';
  if (/doubtful/.test(st)) return 'doubtful';
  if (/injured reserve|\bir\b|ruled out|\bout\b/.test(st)) return 'out';
  if (/questionable/.test(st)) return 'questionable';
  return 'other';
}

/** 'out' | 'doubtful' | 'none'. Already-priced out/doubtful stays none. */
function qbDelta(storedSide, liveSide) {
  const storedClass = qbClass(storedSide && (storedSide.qbStatus || storedSide.status));
  if (storedClass === 'out' || storedClass === 'doubtful') return 'none';
  if (!liveSide) return 'none';
  const liveClass = qbClass(liveSide.qbStatus || liveSide.status);
  if (liveClass === 'out') return 'out';
  if (liveClass === 'doubtful') return 'doubtful';
  return 'none';
}

function decideLateNews(pick, live) {
  if (!pick || !live) return noneDecision();
  const sport = String(pick.sport || '').toUpperCase();
  const posted = statusAction(live);
  if (posted === 'postponed') {
    return dropDecision('postponed', 'Game postponed before first pitch');
  }
  if (posted === 'suspended') {
    return dropDecision('suspended', 'Game suspended before a result');
  }
  if (sport === 'MLB') {
    const stored = pick.lateNews && pick.lateNews.mlb;
    if (stored && (pitcherChanged(stored.homeSp, live.homeSp) || pitcherChanged(stored.awaySp, live.awaySp))) {
      return dropDecision('sp-changed', 'Probable starter changed from the pitcher the model used');
    }
  }
  if (sport === 'NHL') {
    const stored = pick.lateNews && pick.lateNews.nhl;
    const changed = goalieChanged(stored && stored.home, live.homeGoalie, live.goalieConfirmed)
      || goalieChanged(stored && stored.away, live.awayGoalie, live.goalieConfirmed);
    if (changed) {
      if (stored && stored.goalieEdge) {
        return dropDecision('goalie-changed', 'Confirmed starter changed and the model priced goalie quality');
      }
      return flagDecision('goalie-changed', 'Confirmed starter changed; goalie quality was not in the edge');
    }
  }
  if (sport === 'NFL' || sport === 'NCAAF') {
    const qb = pick.lateNews && pick.lateNews.qb;
    if (!qb || qb.loaded === false || live.qbLoaded === false) return noneDecision();
    const home = qbDelta(qb.home, live.homeQb);
    const away = qbDelta(qb.away, live.awayQb);
    if (home === 'out' || away === 'out') {
      return dropDecision('qb-out', 'Quarterback ruled out after the card was priced');
    }
    if (home === 'doubtful' || away === 'doubtful') {
      return flagDecision('qb-doubtful', 'Quarterback listed doubtful after the card was priced');
    }
  }
  return noneDecision();
}

function pickIdentity(pick) {
  if (!pick || typeof pick !== 'object') return '';
  return [pick.sport, pick.matchup, pick.pick, pick.betType, pick.commenceTime, pick.odds].join('|');
}

/**
 * Move drops to voidedPregame and stamp flags. Does not resize the parlay
 * or the unit cap (the caller does, so this module does not require verify).
 * Refuses a card whose kept picks are not a subset of the picks it was given.
 */
function applyCardActions(picksData, decisions, now) {
  const picks = Array.isArray(picksData && picksData.picks) ? picksData.picks : [];
  const existingVoid = Array.isArray(picksData && picksData.voidedPregame) ? picksData.voidedPregame : [];
  const byIndex = new Map();
  for (const d of decisions || []) {
    if (d && Number.isInteger(d.index)) byIndex.set(d.index, d);
  }
  const when = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  const next = [];
  const addedVoid = [];
  const removed = [];
  const actions = [];
  let dropped = 0;
  let flagged = 0;
  const before = new Set(picks.map(pickIdentity));

  for (let i = 0; i < picks.length; i += 1) {
    const pick = picks[i];
    const decision = byIndex.get(i);
    const action = decision && decision.action;
    if (!decision || (action !== 'drop' && action !== 'flag') || isSettled(pick) || pick.status === 'void-pregame') {
      next.push(pick);
      continue;
    }
    if (action === 'drop') {
      const voidedPick = {
        ...pick,
        status: 'void-pregame',
        voidReason: decision.reason || decision.code,
        voidCode: decision.code,
        voidedAt: when,
      };
      addedVoid.push(voidedPick);
      removed.push(pick.pick);
      dropped += 1;
      actions.push({ action: 'drop', code: decision.code, pick: pick.pick, reason: decision.reason || null });
      continue;
    }
    const flags = Array.isArray(pick.lateFlags) ? pick.lateFlags.slice() : [];
    if (decision.code && flags.includes(decision.code)) {
      next.push(pick);
      continue;
    }
    if (decision.code) flags.push(decision.code);
    next.push({ ...pick, lateFlags: flags, lateFlagReason: decision.reason || decision.code });
    flagged += 1;
    actions.push({ action: 'flag', code: decision.code, pick: pick.pick, reason: decision.reason || null });
  }

  const afterIds = next.map(pickIdentity).concat(addedVoid.map(pickIdentity));
  if (next.length + dropped !== picks.length) {
    throw new Error('[late-news] refused: pick count changed');
  }
  for (const id of afterIds) {
    if (!before.has(id)) throw new Error('[late-news] refused: add');
  }
  if (dropped === 0 && flagged === 0) {
    return { dropped: 0, flagged: 0, removed: [], actions: [] };
  }
  picksData.picks = next;
  picksData.voidedPregame = existingVoid.concat(addedVoid);
  return { dropped, flagged, removed, actions };
}

function commitLateNewsCard(picksData, late, deps) {
  if (!late || late.softFail || !picksData) return { write: false, resized: false, blockStraightRefill: false };
  if (late.dropped > 0) {
    if (!deps || typeof deps.resolveLockedParlay !== 'function') {
      throw new Error('[late-news] resolveLockedParlay required on drop');
    }
    const resolved = deps.resolveLockedParlay(picksData.parlayLegs, {
      removedPicks: late.removed || [],
      straightCard: picksData.picks,
    });
    if (resolved && resolved.rebuilt) {
      throw new Error('[late-news] refused: parlay rebuild is not allowed');
    }
    picksData.parlayLegs = resolved ? resolved.parlayLegs : [];
    if (typeof deps.enforceCap === 'function') deps.enforceCap(picksData);
    picksData.blockStraightRefill = true;
    return { write: true, resized: true, blockStraightRefill: true };
  }
  if (late.flagged > 0) return { write: true, resized: false, blockStraightRefill: false };
  return { write: false, resized: false, blockStraightRefill: false };
}

function spStamp(pitcher) {
  if (!pitcher || typeof pitcher !== 'object') return null;
  const name = pitcher.name || pitcher.fullName || '';
  if (!String(name).trim() && pitcher.id == null) return null;
  return { id: pitcher.id != null ? pitcher.id : null, name: String(name || '') };
}

function goalieStamp(goalie) {
  if (!goalie || typeof goalie !== 'object') return null;
  const rawName = goalie.name || goalie.fullName || (goalie.athlete && goalie.athlete.displayName) || '';
  const name = typeof rawName === 'string' ? rawName : (rawName && rawName.default) || '';
  const id = goalie.id != null ? goalie.id : (goalie.playerId != null ? goalie.playerId : null);
  if (!String(name).trim() && id == null) return null;
  return { id, name: String(name || '') };
}

function bindCandidateGame(candidate, snap) {
  const sport = candidate && candidate.sport;
  const board = snap && snap.espnBySport && snap.espnBySport[sport];
  if (!sport || !board) return null;
  return bindEspnGameByTeamAndTime(sport, {
    home_team: candidate.homeTeam,
    away_team: candidate.awayTeam,
    commence_time: candidate.commenceTime,
  }, board);
}

function qbSide(loaded, map, sport, team, seen) {
  if (!loaded) return null;
  if (!map || typeof map !== 'object' || !Object.keys(map).length) return { qbStatus: null, qbName: null };
  const row = lookupQb(team, map, sport, seen);
  if (!row) return { qbStatus: null, qbName: null };
  return { qbStatus: row.qbStatus || null, qbName: row.qbName || null };
}

function stampCandidate(candidate, snap, seen) {
  if (!candidate || !candidate.sport) return candidate;
  const sport = String(candidate.sport).toUpperCase();
  const late = { ...(candidate.lateNews || {}) };
  if (sport === 'MLB') {
    const game = bindCandidateGame(candidate, snap);
    late.mlb = {
      homeSp: spStamp(game && game.homeProbable),
      awaySp: spStamp(game && game.awayProbable),
      gamePk: game && game.id != null ? String(game.id) : null,
      lineupsPosted: !!(game && game.lineupsPosted),
    };
  } else if (sport === 'NHL') {
    const game = bindCandidateGame(candidate, snap);
    late.nhl = {
      home: goalieStamp(game && (game.homeGoalie || game.homeGoalieConfirmed)),
      away: goalieStamp(game && (game.awayGoalie || game.awayGoalieConfirmed)),
      goalieEdge: !!(candidate.engineSoft && candidate.engineSoft.goalie),
    };
  } else if (sport === 'NFL' || sport === 'NCAAF') {
    const gameDay = (snap && snap.gameDay) || {};
    const meta = gameDay.qbStatusMeta && gameDay.qbStatusMeta[sport];
    const loaded = !meta || meta.ok !== false;
    const map = (gameDay.qbStatusBySport && gameDay.qbStatusBySport[sport]) || {};
    late.qb = {
      loaded,
      home: qbSide(loaded, map, sport, candidate.homeTeam, seen),
      away: qbSide(loaded, map, sport, candidate.awayTeam, seen),
    };
  } else {
    return candidate;
  }
  return { ...candidate, lateNews: late };
}

function stampCandidates(candidates, snap) {
  const seen = new Set();
  return (candidates || []).map((candidate) => {
    try {
      return stampCandidate(candidate, snap, seen);
    } catch (e) {
      console.error(`[late-news] stamp soft-fail: ${e.message}`);
      return candidate;
    }
  });
}

function statusText(status) {
  if (status == null) return '';
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    return status.description || status.name || status.abbreviation || status.type || '';
  }
  return String(status);
}

function positionText(inj) {
  if (!inj || typeof inj !== 'object') return '';
  const athlete = inj.athlete && typeof inj.athlete === 'object' ? inj.athlete : null;
  const pos = (athlete && athlete.position) || inj.position;
  if (pos && typeof pos === 'object') return pos.abbreviation || pos.name || '';
  if (typeof pos === 'string') return pos;
  return '';
}

function athleteName(inj) {
  const athlete = inj && inj.athlete && typeof inj.athlete === 'object' ? inj.athlete : inj;
  if (!athlete || typeof athlete !== 'object') return null;
  return athlete.displayName || athlete.fullName || null;
}

function injuryDate(inj) {
  if (!inj || typeof inj !== 'object') return null;
  return inj.date || inj.injuryDate || inj.startDate || (inj.details && inj.details.date) || null;
}

function injuryIsCurrent(dateStr, cardDate, maxAgeDays) {
  if (maxAgeDays == null) return true;
  if (dateStr == null || dateStr === '') return true;
  const inj = Date.parse(dateStr);
  if (!Number.isFinite(inj)) return true;
  const card = cardDate ? Date.parse(`${cardDate}T12:00:00Z`) : NaN;
  if (!Number.isFinite(card)) return true;
  const days = (card - inj) / 86400000;
  return days <= maxAgeDays;
}

function qbRank(status) {
  const st = String(status || '').toLowerCase();
  if (/out|ruled out|\bir\b|injured reserve/.test(st)) return 3;
  if (/doubtful/.test(st)) return 2;
  return 1;
}

function isQbPosition(pos) {
  const text = String(pos || '').trim().toLowerCase();
  return text === 'qb' || text === 'quarterback';
}

function teamOfRow(row, parent) {
  const fromTeam = row && row.team && (row.team.displayName || row.team.name);
  if (fromTeam) return fromTeam;
  return parent || '';
}

function parentTeamName(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.team && (data.team.displayName || data.team.name)) return data.team.displayName || data.team.name;
  return '';
}

function blocksFromList(list, parent) {
  if (!Array.isArray(list) || !list.length) return [];
  const nested = list.some((item) => item && (Array.isArray(item.injuries) || Array.isArray(item.athletes)));
  if (!nested) return [{ teamName: parent, rows: list }];
  const blocks = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rows = Array.isArray(item.injuries) ? item.injuries : (Array.isArray(item.athletes) ? item.athletes : null);
    if (rows) {
      const teamName = item.displayName
        || (item.team && (item.team.displayName || item.team.name))
        || item.teamName
        || parent;
      blocks.push({ teamName, rows });
    } else {
      blocks.push({ teamName: teamOfRow(item, parent), rows: [item] });
    }
  }
  return blocks;
}

function parseFootballQbMap(data, opts = {}) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  const parent = parentTeamName(data);
  const lists = [data.injuries, data.teams, data.items, data.athletes].filter(Array.isArray);
  const blocks = [];
  for (const list of lists) blocks.push(...blocksFromList(list, parent));
  const consider = (teamName, inj) => {
    const team = String(teamName || '').trim();
    if (!team || !inj || typeof inj !== 'object') return;
    if (!isQbPosition(positionText(inj))) return;
    const st = String(statusText(inj.status != null ? inj.status : (inj.type != null ? inj.type : inj.injuryStatus))).toLowerCase();
    if (!st) return;
    if (!/(out|doubtful|questionable|injured reserve|\bir\b|ruled out)/i.test(st)) return;
    if (!injuryIsCurrent(injuryDate(inj), opts.cardDate, opts.maxAgeDays)) return;
    const prev = out[team];
    if (prev && qbRank(prev.qbStatus) >= qbRank(st)) return;
    out[team] = { team, qbStatus: st, qbName: athleteName(inj) };
  };
  for (const block of blocks) {
    for (const row of block.rows || []) {
      consider(teamOfRow(row, block.teamName), row);
    }
  }
  return out;
}

function mergeQbMaps(into, extra) {
  for (const [key, row] of Object.entries(extra || {})) {
    if (!row || key === '_meta' || typeof row !== 'object') continue;
    const prev = into[key];
    if (!prev || qbRank(row.qbStatus) > qbRank(prev.qbStatus)) into[key] = row;
  }
  return into;
}

async function defaultFetch(url, opts) {
  return fetch(url, opts);
}

async function budgetedJson(url, budget, fetchImpl) {
  if (budget.calls >= budget.maxCalls) {
    budget.exhausted = true;
    return { skipped: true };
  }
  budget.calls += 1;
  const fetchFn = fetchImpl || defaultFetch;
  try {
    const resp = await fetchFn(url, { signal: AbortSignal.timeout(budget.timeoutMs) });
    if (!resp || resp.ok === false) {
      budget.errors.push(`HTTP ${resp && resp.status != null ? resp.status : 'fail'} ${url.split('?')[0]}`);
      return { ok: false };
    }
    const data = typeof resp.json === 'function' ? await resp.json() : resp;
    return { ok: true, data };
  } catch (e) {
    budget.errors.push(e && e.message ? e.message : 'fetch failed');
    return { ok: false };
  }
}

function datesFor(picks, dateISO) {
  const set = new Set();
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO))) set.add(String(dateISO));
  for (const pick of picks || []) {
    const ymd = etYmd(pick && (pick.commenceTime || pick.commence_time));
    if (ymd) set.add(ymd);
  }
  return [...set].slice(0, 3);
}

function ymdCompact(ymd) {
  return String(ymd || '').replace(/-/g, '');
}

async function fillNcaafQbMap({ map, games, dateISO, fetchImpl, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS } = {}) {
  const seed = map && typeof map === 'object' ? { ...map } : {};
  delete seed._meta;
  const budget = { calls: 0, maxCalls, timeoutMs, errors: [], exhausted: false };
  const out = { ...seed };
  let sawOk = false;
  try {
    const list = Array.isArray(games) ? games : [];
    for (const game of list) {
      const id = game && (game.id || game.eventId);
      if (id == null || id === '') continue;
      const got = await budgetedJson(`${ESPN_FB}/college-football/summary?event=${encodeURIComponent(id)}`, budget, fetchImpl);
      if (got && got.ok) {
        sawOk = true;
        mergeQbMaps(out, parseFootballQbMap(got.data, { maxAgeDays: NCAAF_INJURY_MAX_AGE_DAYS, cardDate: dateISO }));
      }
    }
    const teamIds = [];
    const seenTeams = new Set();
    for (const game of list) {
      for (const id of [game && game.homeId, game && game.awayId]) {
        if (id == null || id === '' || seenTeams.has(String(id))) continue;
        seenTeams.add(String(id));
        teamIds.push(id);
      }
    }
    for (const id of teamIds) {
      const got = await budgetedJson(`${ESPN_FB}/college-football/teams/${encodeURIComponent(id)}/injuries`, budget, fetchImpl);
      if (got && got.ok) {
        sawOk = true;
        mergeQbMaps(out, parseFootballQbMap(got.data, { maxAgeDays: NCAAF_INJURY_MAX_AGE_DAYS, cardDate: dateISO }));
      }
    }
    return {
      map: out, ok: true, sawOk, calls: budget.calls, source: 'espn-ncaaf', errors: budget.errors, exhausted: budget.exhausted,
    };
  } catch (e) {
    return {
      map: seed,
      ok: false,
      sawOk: false,
      calls: budget.calls,
      source: 'espn-ncaaf',
      error: e.message,
      errors: budget.errors,
      exhausted: budget.exhausted,
    };
  }
}

function parseMlbSchedule(data) {
  const games = [];
  for (const day of (data && data.dates) || []) {
    for (const game of (day && day.games) || []) {
      const status = (game && game.status) || {};
      const teams = (game && game.teams) || {};
      const home = teams.home || {};
      const away = teams.away || {};
      const lineups = game && game.lineups;
      let lineupsPosted = false;
      if (lineups && typeof lineups === 'object') {
        for (const value of Object.values(lineups)) {
          if (Array.isArray(value) && value.length) lineupsPosted = true;
        }
      }
      games.push({
        id: game.gamePk,
        start: game.gameDate,
        detailedState: status.detailedState || '',
        statusCode: status.statusCode || status.codedGameState || '',
        homeTeam: home.team && (home.team.name || home.team.teamName),
        awayTeam: away.team && (away.team.name || away.team.teamName),
        homeSp: spStamp(home.probablePitcher),
        awaySp: spStamp(away.probablePitcher),
        lineupsPosted,
      });
    }
  }
  return games;
}

function nhlTeamName(team) {
  if (!team) return '';
  if (typeof team === 'string') return team;
  const place = team.placeName && (team.placeName.default || team.placeName);
  const common = team.commonName && (team.commonName.default || team.commonName);
  if (place && common && typeof place === 'string' && typeof common === 'string') return `${place} ${common}`;
  const name = team.name && (team.name.default || team.name);
  return typeof name === 'string' ? name : '';
}

function parseNhlSchedule(data, dateISO) {
  const games = [];
  const days = (data && (data.gameWeek || data.gameWeeks)) || [];
  const push = (game) => {
    if (!game) return;
    const start = game.startTimeUTC || game.startTime || game.gameDate;
    const day = etYmd(start);
    if (dateISO && day && day !== dateISO) return;
    games.push({
      id: game.id,
      start,
      gameState: game.gameState || game.gameScheduleState || '',
      detailedState: game.gameState || game.gameScheduleState || '',
      homeTeam: nhlTeamName(game.homeTeam),
      awayTeam: nhlTeamName(game.awayTeam),
      homeGoalie: null,
      awayGoalie: null,
      boxFetched: false,
    });
  };
  if (days.length) {
    for (const day of days) {
      if (dateISO && day && day.date && day.date !== dateISO) {
        for (const game of day.games || []) {
          const start = game && (game.startTimeUTC || game.startTime);
          if (etYmd(start) === dateISO) push(game);
        }
        continue;
      }
      for (const game of (day && day.games) || []) push(game);
    }
  }
  for (const game of (data && data.games) || []) push(game);
  return games;
}

function parseStarterGoalie(goalies) {
  const list = Array.isArray(goalies) ? goalies : [];
  const starter = list.find((goalie) => goalie && (goalie.starter === true || goalie.starter === 'true'));
  if (!starter) return null;
  const raw = starter.name && (starter.name.default || starter.name);
  const name = typeof raw === 'string' ? raw : '';
  if (!name) return null;
  return { id: starter.playerId != null ? starter.playerId : (starter.id != null ? starter.id : null), name };
}

function parseNhlBox(data) {
  const stats = data && (data.playerByGameStats
    || (data.boxscore && data.boxscore.playerByGameStats)
    || null);
  if (!stats) return { homeGoalie: null, awayGoalie: null };
  return {
    awayGoalie: parseStarterGoalie(stats.awayTeam && stats.awayTeam.goalies),
    homeGoalie: parseStarterGoalie(stats.homeTeam && stats.homeTeam.goalies),
  };
}

function parseScoreboardEvents(data) {
  const events = (data && data.events) || [];
  return events.map((event) => {
    const comp = (event.competitions && event.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((row) => row.homeAway === 'home') || {};
    const away = competitors.find((row) => row.homeAway === 'away') || {};
    return {
      id: event.id,
      start: event.date || comp.date,
      homeTeam: home.team && (home.team.displayName || home.team.name),
      awayTeam: away.team && (away.team.displayName || away.team.name),
      homeId: home.id || (home.team && home.team.id) || null,
      awayId: away.id || (away.team && away.team.id) || null,
    };
  }).filter((row) => row.homeTeam || row.awayTeam);
}

function matchGame(pick, games) {
  const hits = [];
  for (const game of games || []) {
    if (!game) continue;
    const homeOk = teamNamesMatch(pick.homeTeam, game.homeTeam);
    const awayOk = teamNamesMatch(pick.awayTeam, game.awayTeam);
    if (homeOk && awayOk) hits.push(game);
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const start = pickCommenceMs(pick);
  const ranked = hits.map((game) => {
    const gt = game.start ? Date.parse(game.start) : NaN;
    const diff = Number.isFinite(start) && Number.isFinite(gt) ? Math.abs(gt - start) : Infinity;
    return { game, diff };
  }).sort((a, b) => a.diff - b.diff);
  if (ranked[0].diff <= 75 * 60 * 1000 && (ranked.length === 1 || ranked[1].diff - ranked[0].diff >= 75 * 60 * 1000)) {
    return ranked[0].game;
  }
  return null;
}

function groupBySport(picks) {
  const out = {};
  for (const pick of picks || []) {
    const sport = String(pick && pick.sport || '').toUpperCase();
    if (!sport) continue;
    if (!out[sport]) out[sport] = [];
    out[sport].push(pick);
  }
  return out;
}

async function loadLiveContext({ picks, dateISO, fetchImpl, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS } = {}) {
  const budget = { calls: 0, maxCalls, timeoutMs, errors: [], exhausted: false };
  const bySport = groupBySport(picks);
  const dates = datesFor(picks, dateISO);
  const mlbGames = [];
  const nhlGames = [];
  const qb = {
    NFL: { map: {}, loaded: false },
    NCAAF: { map: {}, loaded: false },
  };

  if (bySport.MLB) {
    for (const ymd of dates) {
      const url = `${MLB_SCHEDULE}?sportId=1&date=${encodeURIComponent(ymd)}&hydrate=probablePitcher,lineups`;
      const got = await budgetedJson(url, budget, fetchImpl);
      if (got && got.ok) mlbGames.push(...parseMlbSchedule(got.data));
    }
  }
  const nhlMatched = [];
  if (bySport.NHL) {
    for (const ymd of dates) {
      const got = await budgetedJson(`${NHL_ORIGIN}/schedule/${ymd}`, budget, fetchImpl);
      if (got && got.ok) nhlGames.push(...parseNhlSchedule(got.data, ymd));
    }
    const seen = new Set();
    for (const pick of bySport.NHL) {
      const game = matchGame(pick, nhlGames);
      if (!game || game.id == null || seen.has(String(game.id))) continue;
      seen.add(String(game.id));
      nhlMatched.push(game);
    }
  }
  if (bySport.NFL) {
    const got = await budgetedJson(`${ESPN_FB}/nfl/injuries`, budget, fetchImpl);
    if (got && got.ok) {
      qb.NFL = { map: parseFootballQbMap(got.data, { cardDate: dateISO }), loaded: true };
    }
  }
  const ncaafMap = {};
  let ncaafLoaded = false;
  if (bySport.NCAAF) {
    const got = await budgetedJson(`${ESPN_FB}/college-football/injuries`, budget, fetchImpl);
    if (got && got.ok) {
      mergeQbMaps(ncaafMap, parseFootballQbMap(got.data, { maxAgeDays: NCAAF_INJURY_MAX_AGE_DAYS, cardDate: dateISO }));
      ncaafLoaded = true;
    }
  }
  for (const game of nhlMatched) {
    const got = await budgetedJson(`${NHL_ORIGIN}/gamecenter/${encodeURIComponent(game.id)}/boxscore`, budget, fetchImpl);
    game.boxFetched = !!(got && (got.ok || got.skipped));
    if (got && got.ok) {
      const goalies = parseNhlBox(got.data);
      game.homeGoalie = goalies.homeGoalie;
      game.awayGoalie = goalies.awayGoalie;
    }
  }
  if (bySport.NCAAF) {
    const map = ncaafMap;
    let loaded = ncaafLoaded;
    let events = [];
    const board = await budgetedJson(
      `${ESPN_FB}/college-football/scoreboard?dates=${ymdCompact(dateISO || dates[0])}&groups=80&limit=100`,
      budget,
      fetchImpl,
    );
    if (board && board.ok) events = parseScoreboardEvents(board.data);
    const unmatched = (bySport.NCAAF || []).filter((pick) => !matchGame(pick, events));
    if (unmatched.length && !budget.exhausted) {
      const fcs = await budgetedJson(
        `${ESPN_FB}/college-football/scoreboard?dates=${ymdCompact(dateISO || dates[0])}&groups=90&limit=100`,
        budget,
        fetchImpl,
      );
      if (fcs && fcs.ok) events = events.concat(parseScoreboardEvents(fcs.data));
    }
    const summaries = [];
    const seenEvents = new Set();
    const teamIds = [];
    const seenTeams = new Set();
    for (const pick of bySport.NCAAF) {
      const event = matchGame(pick, events);
      if (!event) continue;
      if (event.id != null && !seenEvents.has(String(event.id))) {
        seenEvents.add(String(event.id));
        summaries.push(event);
      }
      for (const id of [event.homeId, event.awayId]) {
        if (id == null || id === '' || seenTeams.has(String(id))) continue;
        seenTeams.add(String(id));
        teamIds.push(id);
      }
    }
    for (const event of summaries) {
      const summary = await budgetedJson(
        `${ESPN_FB}/college-football/summary?event=${encodeURIComponent(event.id)}`,
        budget,
        fetchImpl,
      );
      if (summary && summary.ok) {
        mergeQbMaps(map, parseFootballQbMap(summary.data, { maxAgeDays: NCAAF_INJURY_MAX_AGE_DAYS, cardDate: dateISO }));
        loaded = true;
      }
    }
    for (const id of teamIds) {
      const team = await budgetedJson(
        `${ESPN_FB}/college-football/teams/${encodeURIComponent(id)}/injuries`,
        budget,
        fetchImpl,
      );
      if (team && team.ok) {
        mergeQbMaps(map, parseFootballQbMap(team.data, { maxAgeDays: NCAAF_INJURY_MAX_AGE_DAYS, cardDate: dateISO }));
        loaded = true;
      }
    }
    qb.NCAAF = { map, loaded };
  }

  function forPick(pick) {
    const sport = String(pick && pick.sport || '').toUpperCase();
    if (sport === 'MLB') {
      const game = matchGame(pick, mlbGames);
      if (!game) return { matched: false };
      return {
        matched: true,
        detailedState: game.detailedState,
        statusCode: game.statusCode,
        status: game.detailedState,
        lineupsPosted: !!game.lineupsPosted,
        homeSp: game.homeSp,
        awaySp: game.awaySp,
      };
    }
    if (sport === 'NHL') {
      const game = matchGame(pick, nhlGames);
      if (!game) return { matched: false, goalieConfirmed: false };
      const homeGoalie = game.homeGoalie || null;
      const awayGoalie = game.awayGoalie || null;
      return {
        matched: true,
        detailedState: game.detailedState,
        gameState: game.gameState,
        status: game.gameState,
        homeGoalie,
        awayGoalie,
        goalieConfirmed: !!(homeGoalie || awayGoalie),
      };
    }
    if (sport === 'NFL' || sport === 'NCAAF') {
      const pack = qb[sport];
      if (!pack || pack.loaded !== true) return { qbLoaded: false, matched: false };
      const seen = new Set();
      const side = (team) => {
        if (!pack.map || !Object.keys(pack.map).length) return { qbStatus: null };
        return lookupQb(team, pack.map, sport, seen) || { qbStatus: null };
      };
      return {
        qbLoaded: true,
        matched: true,
        homeQb: side(pick.homeTeam),
        awayQb: side(pick.awayTeam),
      };
    }
    return { matched: false };
  }

  return {
    forPick,
    httpCalls: budget.calls,
    exhausted: budget.exhausted,
    errors: budget.errors,
  };
}

function checkRow(pick, live, decision) {
  const row = {
    pick: pick && pick.pick,
    sport: pick && pick.sport,
    action: decision.action,
    code: decision.code,
    matched: !!live.matched,
  };
  if (live.lineupsPosted != null) row.lineupsPosted = !!live.lineupsPosted;
  if (live.goalieConfirmed != null) row.goalieConfirmed = !!live.goalieConfirmed;
  return row;
}

function emptyRun(extra) {
  return {
    dropped: 0,
    flagged: 0,
    removed: [],
    actions: [],
    checks: [],
    checked: 0,
    httpCalls: 0,
    exhausted: false,
    errors: [],
    withinMin: WITHIN_MIN,
    softFail: false,
    ...extra,
  };
}

async function runLateNews({ picksData, now, fetchImpl, withinMin = WITHIN_MIN, dateISO, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS } = {}) {
  const clock = now instanceof Date ? now : new Date(now || Date.now());
  try {
    const picks = (picksData && picksData.picks) || [];
    const indexed = picks.map((pick, index) => ({ pick, index }));
    const inWindow = indexed.filter(({ pick }) => pickInWindow(pick, clock, withinMin));
    if (!inWindow.length) {
      return emptyRun({ checked: 0, withinMin });
    }
    const live = await loadLiveContext({
      picks: inWindow.map((row) => row.pick),
      dateISO: dateISO || etYmd(clock),
      fetchImpl,
      maxCalls,
      timeoutMs,
    });
    const decisions = [];
    const checks = [];
    for (const row of inWindow) {
      const ctx = live.forPick(row.pick) || { matched: false };
      const decision = decideLateNews(row.pick, ctx);
      decisions.push({ index: row.index, ...decision });
      checks.push(checkRow(row.pick, ctx, decision));
    }
    const applied = applyCardActions(picksData, decisions, clock);
    return {
      ...applied,
      checks,
      checked: inWindow.length,
      httpCalls: live.httpCalls,
      exhausted: live.exhausted,
      errors: live.errors,
      withinMin,
      softFail: false,
    };
  } catch (e) {
    return emptyRun({
      softFail: true,
      errors: [e && e.message ? e.message : 'late-news failed'],
      withinMin,
    });
  }
}

function opsFromRun(late, meta) {
  const src = late || {};
  return {
    at: new Date().toISOString(),
    date: meta && meta.date,
    function: meta && meta.functionName,
    et: meta && meta.et,
    withinMin: src.withinMin || WITHIN_MIN,
    httpCalls: src.httpCalls || 0,
    timeoutMs: TIMEOUT_MS,
    maxCalls: MAX_CALLS,
    checked: src.checked || 0,
    dropped: src.dropped || 0,
    flagged: src.flagged || 0,
    errors: src.errors || [],
    exhausted: !!src.exhausted,
    actions: src.actions || [],
    checks: src.checks || [],
  };
}

module.exports = {
  RULES,
  MAX_CALLS,
  TIMEOUT_MS,
  WITHIN_MIN,
  NCAAF_INJURY_MAX_AGE_DAYS,
  stampCandidate,
  stampCandidates,
  decideLateNews,
  pickInWindow,
  applyCardActions,
  commitLateNewsCard,
  parseFootballQbMap,
  fillNcaafQbMap,
  loadLiveContext,
  runLateNews,
  opsFromRun,
  teamNamesMatch,
  statusAction,
};
