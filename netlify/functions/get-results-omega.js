// get-results-omega.js
// Returns combined pick history for /alpha track record:
//   - Alpha picks for dates in edge-picks-omega store
//   - Beta picks for dates before alpha started (pre-alpha history)
//   - 0-0 placeholder rows for dates with no picks in either pipeline

const { fetchESPNScores } = require('./lib/espn-scoreboard');
const { cacheIsFresh, cacheControlFor } = require('./lib/kpi-cache');
const { resolveDoubleheader, inheritCommenceTime } = require('../../js/live-score');
const { resolveTeamId, matchSides } = require('./lib/omega-vnext/sports/team_identity');
const omegaGradingRules = require('./lib/omega-grading-rules');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const RESULTS_CACHE_KEY = 'results-omega-cache-v9-ncaaf-state';

function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, '0');
  const d = String(et.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getAllDatesInRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function schoolKey(name) {
  const parts = normalizeTeam(name).split(' ');
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
}

// Equal school keys, or equal once a trailing "state" is removed
// (McNeese State Cowboys vs ESPN "McNeese Cowboys"). Mascots are already gone.
function ncaafSchoolKeysMatch(aName, bName) {
  const a = schoolKey(aName);
  const b = schoolKey(bName);
  if (!a || !b || a.length <= 2 || b.length <= 2) return false;
  if (a === b) return true;
  if (a.endsWith(' state') && a.slice(0, -6) === b) return true;
  if (b.endsWith(' state') && b.slice(0, -6) === a) return true;
  return false;
}

// Michigan State also matches Michigan. When both sides of one game match,
// keep the exact schoolKey. If that does not pick one side, match neither.
// Identity runs only when that logic still has neither side (never overrides a hit).
function ncaafPickedSides(pickTeam, awayTeam, awayAbbr, homeTeam, homeAbbr, sport, awayEspnId, homeEspnId) {
  const pickedAway = teamsMatch(pickTeam, awayTeam, awayAbbr, sport);
  const pickedHome = teamsMatch(pickTeam, homeTeam, homeAbbr, sport);
  if (!(pickedAway && pickedHome && sport === 'NCAAF')) {
    if (!pickedAway && !pickedHome && typeof sidesFromIdentity === 'function') {
      const byId = sidesFromIdentity(pickTeam, awayTeam, homeTeam, sport, awayEspnId, homeEspnId);
      if (byId) return byId;
    }
    return { pickedAway: !!pickedAway, pickedHome: !!pickedHome };
  }
  const pS = schoolKey(pickTeam);
  const awayExact = pS.length > 2 && pS === schoolKey(awayTeam);
  const homeExact = pS.length > 2 && pS === schoolKey(homeTeam);
  if (awayExact && !homeExact) return { pickedAway: true, pickedHome: false };
  if (homeExact && !awayExact) return { pickedAway: false, pickedHome: true };
  if (typeof sidesFromIdentity === 'function') {
    const byId = sidesFromIdentity(pickTeam, awayTeam, homeTeam, sport, awayEspnId, homeEspnId);
    if (byId) return byId;
  }
  return { pickedAway: false, pickedHome: false };
}

// Michigan State @ Iowa and Michigan @ Iowa can both pass a trailing-"state" match.
// Keep the games whose school keys match exactly so the other one is not graded.
function preferExactSchoolGames(pick, games) {
  if (!pick || (pick.sport || '') !== 'NCAAF' || !games || games.length < 2) return games;
  const parts = String(pick.matchup || '').split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  const pickTeam = String(pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const probes = pickTeam ? parts.concat([pickTeam]) : parts;
  let best = -1;
  const scored = games.map(game => {
    let score = 0;
    for (const side of [game.awayTeam, game.homeTeam]) {
      let sideBest = 0;
      for (const probe of probes) {
        const pS = schoolKey(probe);
        const eS = schoolKey(side);
        if (pS.length > 2 && pS === eS) sideBest = 2;
        else if (sideBest < 1 && ncaafSchoolKeysMatch(probe, side)) sideBest = 1;
      }
      score += sideBest;
    }
    if (score > best) best = score;
    return { game, score };
  });
  const top = scored.filter(row => row.score === best).map(row => row.game);
  return top.length ? top : games;
}

function idFirstSport(sport) {
  return sport === 'NFL' || sport === 'MLB' || sport === 'NHL';
}

// Mascot includes. Identity-v2 dates do not last-word a resolved NFL/MLB/NHL
// club. Undated and pre-cutoff callers keep the mascot key.
function mascotKeyAllowed(sport, teamName, dateISO) {
  if (!omegaGradingRules.identityV2(dateISO)) return true;
  if (!idFirstSport(sport)) return true;
  return !resolveTeamId(sport, teamName);
}

function teamsMatch(pickTeam, espnTeam, espnAbbr, sport, dateISO) {
  // Identity-v2 card dates: NFL/MLB/NHL resolved ids win. Two different ids
  // never share a last word (White Sox / Red Sox). Last-word stays only when
  // at least one name does not resolve. No date, or a date before
  // IDENTITY_V2_FROM, keeps the 182e714 matcher. NCAAF stays on school keys.
  // typeof guards keep the vm extract in test-ncaaf-state-suffix on the
  // name body (that extract does not copy the helpers).
  if (typeof omegaGradingRules !== 'undefined' && omegaGradingRules.identityV2(dateISO) &&
      typeof resolveTeamId === 'function' && idFirstSport(sport)) {
    const a = resolveTeamId(sport, pickTeam);
    const b = resolveTeamId(sport, espnTeam);
    if (a && b) return String(a) === String(b);
  }
  const p = normalizeTeam(pickTeam);
  const e = normalizeTeam(espnTeam);
  if (!p || !e) return false;
  if (p === e) return true;
  if (p.includes(e) || e.includes(p)) return true;
  if (espnAbbr && espnAbbr.length >= 2) {
    const a = espnAbbr.toLowerCase();
    const pWords = p.split(' ');
    if (pWords.includes(a)) return true;
  }
  if (sport === 'NCAAF') {
    if (ncaafSchoolKeysMatch(pickTeam, espnTeam)) return true;
    return false;
  }
  const pLast = p.split(' ').pop();
  const eLast = e.split(' ').pop();
  if (pLast.length > 2 && pLast === eLast) return true;
  return false;
}

// Shared DH rule: js/live-score.js (clear commenceTime, else in/post over a skewed pre).
function disambiguateDoubleheader(matches, pick) {
  return resolveDoubleheader(matches, pick);
}

function findGame(pick, games, dateISO) {
  const sport = pick.sport || '';
  const ncaaf = sport === 'NCAAF';
  const matchup = (pick.matchup || '').toLowerCase();
  const matchupParts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  const primary = [];
  for (const g of games) {
    const awayKey = ncaaf ? schoolKey(g.awayTeam) : normalizeTeam(g.awayTeam).split(' ').pop();
    const homeKey = ncaaf ? schoolKey(g.homeTeam) : normalizeTeam(g.homeTeam).split(' ').pop();
    const awayMascot = typeof mascotKeyAllowed !== 'function' || mascotKeyAllowed(sport, g.awayTeam, dateISO);
    const homeMascot = typeof mascotKeyAllowed !== 'function' || mascotKeyAllowed(sport, g.homeTeam, dateISO);
    const awayMatch = matchupParts.some(part => teamsMatch(part, g.awayTeam, g.awayAbbr, sport, dateISO)) ||
                       (awayMascot && awayKey.length > (ncaaf ? 2 : 3) && matchup.includes(awayKey));
    const homeMatch = matchupParts.some(part => teamsMatch(part, g.homeTeam, g.homeAbbr, sport, dateISO)) ||
                       (homeMascot && homeKey.length > (ncaaf ? 2 : 3) && matchup.includes(homeKey));
    if (awayMatch && homeMatch) primary.push(g);
  }
  if (primary.length) return disambiguateDoubleheader(preferExactSchoolGames(pick, primary), pick);
  const pickTeam = (pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  if (pickTeam) {
    const secondary = [];
    for (const g of games) {
      const awayHit = teamsMatch(pickTeam, g.awayTeam, g.awayAbbr, sport, dateISO);
      const homeHit = teamsMatch(pickTeam, g.homeTeam, g.homeAbbr, sport, dateISO);
      if (awayHit || homeHit) {
        const otherTeam = awayHit ? g.homeTeam : g.awayTeam;
        const otherKey = ncaaf ? schoolKey(otherTeam) : normalizeTeam(otherTeam).split(' ').pop();
        const otherMascot = typeof mascotKeyAllowed !== 'function' || mascotKeyAllowed(sport, otherTeam, dateISO);
        if (otherMascot && otherKey.length > (ncaaf ? 2 : 3) && matchup.includes(otherKey)) secondary.push(g);
      }
    }
    if (secondary.length) return disambiguateDoubleheader(preferExactSchoolGames(pick, secondary), pick);
  }
  if (matchupParts.length >= 2) {
    const tertiary = [];
    for (const g of games) {
      if (typeof omegaGradingRules !== 'undefined' && omegaGradingRules.identityV2(dateISO) &&
          idFirstSport(sport) && typeof resolveTeamId === 'function' &&
          (resolveTeamId(sport, g.awayTeam) || resolveTeamId(sport, g.homeTeam))) continue;
      const awayKey = ncaaf ? schoolKey(g.awayTeam) : normalizeTeam(g.awayTeam).split(' ').pop();
      const homeKey = ncaaf ? schoolKey(g.homeTeam) : normalizeTeam(g.homeTeam).split(' ').pop();
      const part0 = ncaaf ? schoolKey(matchupParts[0]) : normalizeTeam(matchupParts[0]);
      const part1 = ncaaf ? schoolKey(matchupParts[1]) : normalizeTeam(matchupParts[1]);
      if ((part0.includes(awayKey) || awayKey.includes(part0)) &&
          (part1.includes(homeKey) || homeKey.includes(part1))) tertiary.push(g);
      else if ((part0.includes(homeKey) || homeKey.includes(part0)) &&
          (part1.includes(awayKey) || awayKey.includes(part1))) tertiary.push(g);
    }
    if (tertiary.length) return disambiguateDoubleheader(preferExactSchoolGames(pick, tertiary), pick);
  }
  // Name match missed. NCAAF/NFL only: one ESPN id-pair, or a doubleheader
  // commenceTime already separates. Never replaces a name hit above.
  if (typeof findGameByIdentity === 'function') return findGameByIdentity(pick, games);
  return null;
}

// Same 75-minute gap js/live-score.js uses before it will pick one doubleheader.
const IDENTITY_CLEAR_MARGIN_MS = 75 * 60 * 1000;

function teamIdentityId(sport, name, espnId) {
  if (typeof resolveTeamId !== 'function') return null;
  if (sport !== 'NCAAF' && sport !== 'NFL') return null;
  const fromName = name ? resolveTeamId(sport, name) : null;
  if (fromName) return String(fromName);
  if (espnId == null || espnId === '') return null;
  return String(espnId);
}

function sidesFromIdentity(pickTeam, awayTeam, homeTeam, sport, awayEspnId, homeEspnId) {
  const id = teamIdentityId(sport, pickTeam);
  if (!id) return null;
  const awayId = teamIdentityId(sport, awayTeam, awayEspnId);
  const homeId = teamIdentityId(sport, homeTeam, homeEspnId);
  const awayHit = !!(awayId && awayId === id);
  const homeHit = !!(homeId && homeId === id);
  if (awayHit === homeHit) return null;
  return { pickedAway: awayHit, pickedHome: homeHit };
}

function identityHits(pick, games) {
  const sport = (pick && pick.sport) || '';
  const parts = String((pick && pick.matchup) || '').split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const id0 = teamIdentityId(sport, parts[0]);
  const id1 = teamIdentityId(sport, parts[1]);
  if (!id0 || !id1 || id0 === id1) return [];
  const seen = new Set();
  const hits = [];
  for (const g of games || []) {
    const awayId = teamIdentityId(sport, g.awayTeam, g.awayId);
    const homeId = teamIdentityId(sport, g.homeTeam, g.homeId);
    if (!awayId || !homeId || awayId === homeId) continue;
    const ordered = awayId === id0 && homeId === id1;
    const swapped = awayId === id1 && homeId === id0;
    if (!ordered && !swapped) continue;
    const key = (g.startISO || '') + '|' + (g.awayAbbr || g.awayTeam || '') + '|' + (g.homeAbbr || g.homeTeam || '');
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(g);
  }
  return hits;
}

function findGameByIdentity(pick, games) {
  const sport = (pick && pick.sport) || '';
  if (sport !== 'NCAAF' && sport !== 'NFL') return null;
  const hits = identityHits(pick, games);
  if (hits.length === 1) return disambiguateDoubleheader(hits, pick);
  if (hits.length < 2) return null;
  const ct = pick && pick.commenceTime ? Date.parse(pick.commenceTime) : NaN;
  if (!Number.isFinite(ct)) return null;
  const diffs = hits.map(g => {
    const gt = g && g.startISO ? Date.parse(g.startISO) : NaN;
    return Number.isFinite(gt) ? Math.abs(gt - ct) : Infinity;
  }).sort((a, b) => a - b);
  if (!(diffs[0] < Infinity && diffs[1] - diffs[0] >= IDENTITY_CLEAR_MARGIN_MS)) return null;
  return disambiguateDoubleheader(hits, pick);
}

// ESPN competitor id when the board has one. Otherwise the display name.
function competitorId(sport, name, espnId) {
  if (espnId != null && espnId !== '') return String(espnId);
  const fromName = name ? resolveTeamId(sport, name) : null;
  return fromName ? String(fromName) : null;
}

// Card dates >= IDENTITY_V2_FROM. Both matchup sides resolved → ESPN id pair
// only. A miss is null so a shared last word cannot grab the other club.
// An unresolved name uses the legacy matcher, then drops a game whose ids
// contradict a side that did resolve.
function findGameIdentityV2(pick, games) {
  const sport = (pick && pick.sport) || '';
  const list = games || [];
  const parts = String((pick && pick.matchup) || '').split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const id0 = resolveTeamId(sport, parts[0]);
    const id1 = resolveTeamId(sport, parts[1]);
    if (id0 && id1 && String(id0) !== String(id1)) {
      const left = String(id0);
      const right = String(id1);
      const hits = [];
      const seen = new Set();
      for (const g of list) {
        const awayId = competitorId(sport, g.awayTeam, g.awayId);
        const homeId = competitorId(sport, g.homeTeam, g.homeId);
        if (!awayId || !homeId || awayId === homeId) continue;
        const ordered = awayId === left && homeId === right;
        const swapped = awayId === right && homeId === left;
        if (!ordered && !swapped) continue;
        const key = String(g.id || g.eventId || '') + '|' + String(g.startISO || '') + '|' + awayId + '|' + homeId;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(g);
      }
      if (hits.length) return disambiguateDoubleheader(hits, pick);
      return null;
    }
  }
  const legacy = findGame(pick, list, omegaGradingRules.IDENTITY_V2_FROM);
  if (!legacy || parts.length < 2) return legacy || null;
  const awayId = competitorId(sport, legacy.awayTeam, legacy.awayId);
  const homeId = competitorId(sport, legacy.homeTeam, legacy.homeId);
  if (idFirstSport(sport)) {
    const sideIds = [awayId, homeId].filter(Boolean);
    if (!sideIds.length) return legacy;
    for (const part of parts) {
      const id = resolveTeamId(sport, part);
      if (id && sideIds.indexOf(String(id)) < 0) return null;
    }
    return legacy;
  }
  if (!awayId || !homeId) return legacy;
  for (const part of parts) {
    const id = resolveTeamId(sport, part);
    if (id && String(id) !== awayId && String(id) !== homeId) return null;
  }
  return legacy;
}

function findGameForDate(pick, games, dateISO) {
  if (omegaGradingRules.identityV2(dateISO)) return findGameIdentityV2(pick, games);
  // Dates before IDENTITY_V2_FROM stay on the name matcher, including last word.
  return findGame(pick, games);
}

function pickSidesForGrade(pick, game, pickTeamRaw, opts) {
  const sport = pick && pick.sport;
  const legacy = ncaafPickedSides(
    pickTeamRaw, game.awayTeam, game.awayAbbr, game.homeTeam, game.homeAbbr, sport, game.awayId, game.homeId
  );
  if (!omegaGradingRules.identityV2(opts && opts.dateISO)) return legacy;
  const byId = matchSides(sport, pickTeamRaw, game.awayTeam, game.homeTeam, game.awayId, game.homeId);
  if (byId.decided) return { pickedAway: byId.pickedAway, pickedHome: byId.pickedHome };
  const pickId = resolveTeamId(sport, pickTeamRaw);
  if (!pickId) return legacy;
  const awayId = competitorId(sport, game.awayTeam, game.awayId);
  const homeId = competitorId(sport, game.homeTeam, game.homeId);
  return {
    pickedAway: !!(legacy.pickedAway && (!awayId || String(awayId) === String(pickId))),
    pickedHome: !!(legacy.pickedHome && (!homeId || String(homeId) === String(pickId))),
  };
}

// Parlay legs are stored WITHOUT commenceTime, so on a doubleheader date findGame falls back to the
// opener and settles the leg against the wrong final — the straight bet (which HAS commenceTime)
// grades correctly while the identical parlay leg does not. Inherit the start time from the straight
// pick naming the same matchup + selection so both sides resolve to the same game.
function withLegCommenceTime(leg, picks) {
  return inheritCommenceTime(leg, picks);
}

// Card date and clock come only from the opts argument. gradePick(pick, game) with
// no opts is the 50d3eb9 path. HTML/vm extracts of gradePick skip this helper via
// typeof, so those callers keep that same pre-v2 body.
function v2GradeParts(pick, game, opts) {
  const gradeOpts = {
    dateISO: opts && opts.dateISO ? opts.dateISO : null,
    now: opts && opts.now != null ? opts.now : null,
  };
  return {
    early: omegaGradingRules.earlyPush(pick, game, gradeOpts),
    snap: omegaGradingRules.mlbSnapshot(pick, game, gradeOpts),
    opts: gradeOpts,
  };
}

function gradePick(pick, game, opts) {
  if (pick && pick.status === 'void-pregame') return 'push';
  const pickStrEarly = (pick.pick || '').trim();
  const betTypeEarly = (pick.betType || '').toLowerCase();
  const isF5 = /\bf5\b|first 5|1st 5|first-5/i.test(pickStrEarly) || betTypeEarly.includes('f5') || /^f5\b/i.test(pickStrEarly);
  const parts = (typeof v2GradeParts === 'function') ? v2GradeParts(pick, game, opts) : null;
  const snap = parts && parts.snap;
  if (parts && parts.early === 'push') return 'push';
  if (!game || game.state !== 'post') return 'pending';
  // Postponed / canceled games are voided by every major US book (no action) — the stake is
  // returned, so we grade them as a push. A push leg is dropped from a parlay and the ticket
  // reprices on the surviving legs (see gradeParlay). ESPN marks these state:'post' with
  // completed:false, so they must be caught BEFORE any score-based grading (0-0 → false "under").
  if (/POSTPONED|CANCELL?ED|SUSPENDED/i.test(game.statusName) || (game.state === 'post' && !game.completed)) return 'push';
  const pickStr = pickStrEarly;
  const betType = betTypeEarly;
  // First-Five-Innings picks settle on the first-5 score, NOT the full game.
  let awayScore = game.awayScore;
  let homeScore = game.homeScore;
  if (isF5) {
    if (snap && snap.f5Mode === 'void') return 'push';
    if (snap && snap.f5Mode === 'partial') {
      awayScore = snap.awayScore;
      homeScore = snap.homeScore;
    } else {
      const aL = game.awayLine || [], hL = game.homeLine || [];
      if (aL.length < 5 || hL.length < 5) return 'pending'; // not enough innings to settle F5
      awayScore = aL.slice(0, 5).reduce((a, b) => a + b, 0);
      homeScore = hL.slice(0, 5).reduce((a, b) => a + b, 0);
    }
  }
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const side = (typeof pickSidesForGrade === 'function')
    ? pickSidesForGrade(pick, game, pickTeamRaw, opts)
    : ncaafPickedSides(pickTeamRaw, game.awayTeam, game.awayAbbr, game.homeTeam, game.homeAbbr, pick.sport, game.awayId, game.homeId);
  const pickedAway = side.pickedAway;
  const pickedHome = side.pickedHome;

  if (betType === 'total' || /over|under/i.test(pickStr)) {
    const totalPoints = awayScore + homeScore;
    const lineMatch = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (lineMatch) {
      const ou = lineMatch[1].toLowerCase();
      const line = parseFloat(lineMatch[2]);
      // Short completed game: only an Over already past the line has action.
      if (snap && !isF5 && !snap.fullOfficial) {
        if (totalPoints > line && ou === 'over') return 'win';
        if (totalPoints > line && ou === 'under') return 'loss';
        return 'push';
      }
      if (totalPoints === line) return 'push';
      const over = totalPoints > line;
      return (ou === 'over' && over) || (ou === 'under' && !over) ? 'win' : 'loss';
    }
  }
  if (betType === 'spread' || betType === 'puck line' || /[+-]\d+(\.\d+)?/.test(pickStr)) {
    const spreadMatch = pickStr.match(/([+-]\d+(\.\d+)?)/);
    if (spreadMatch && (pickedAway || pickedHome)) {
      if (snap && !isF5 && !snap.fullOfficial) return 'push';
      const spread = parseFloat(spreadMatch[1]);
      const pickedScore = pickedAway ? awayScore : homeScore;
      const oppScore = pickedAway ? homeScore : awayScore;
      const adjusted = pickedScore + spread;
      if (adjusted === oppScore) return 'push';
      return adjusted > oppScore ? 'win' : 'loss';
    }
  }
  if (pickedAway || pickedHome) {
    if (snap && !isF5 && !snap.mlOfficial) return 'push';
    const pickedScore = pickedAway ? awayScore : homeScore;
    const oppScore = pickedAway ? homeScore : awayScore;
    if (pickedScore === oppScore) return 'push';
    return pickedScore > oppScore ? 'win' : 'loss';
  }
  if (/draw/i.test(pickStr)) {
    if (snap && !isF5 && !snap.mlOfficial) return 'push';
    return awayScore === homeScore ? 'win' : 'loss';
  }
  return 'pending';
}

function calcWinnings(atRisk, oddsStr) {
  const odds = parseInt((oddsStr || '').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds) || !atRisk) return 0;
  if (odds > 0) return atRisk * (odds / 100);
  return atRisk * (100 / Math.abs(odds));
}

function calcParlayWinnings(risk, legsOdds) {
  let decimalProduct = 1;
  for (const oddsStr of legsOdds) {
    const odds = parseInt((oddsStr || '-110').replace(/[^0-9+-]/g, ''));
    if (isNaN(odds)) { decimalProduct *= 1.909; continue; }
    decimalProduct *= odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
  }
  return risk * (decimalProduct - 1);
}

// Whole-dollar display: round UP to the next dollar so no cents show (37.5 -> 38). The -1e-9
// keeps an already-whole amount whole (avoids 75 -> 76 on float dust).
function wholeUp(n) { return Math.ceil((n || 0) - 1e-9); }

function gradeParlay(pickResults, parlayRisk) {
  // v10.4.3: parlays can now be 2-leg (totals-first construction drops -CLV ML legs), so grade
  // any ticket with >=2 legs. Historical 3-leg tickets are unaffected.
  if (pickResults.length < 2) return { result: 'skip', profit: 0 };
  const results = pickResults.map(p => p.result);
  const anyLoss = results.includes('loss');
  const anyPending = results.includes('pending');
  const allWin = results.every(r => r === 'win');
  if (anyLoss) return { result: 'loss', profit: -parlayRisk };
  if (anyPending) return { result: 'pending', profit: 0 };
  if (allWin) return { result: 'win', profit: wholeUp(calcParlayWinnings(parlayRisk, pickResults.map(p => p.odds))) };
  const nonPushLegs = pickResults.filter(p => p.result !== 'push');
  if (nonPushLegs.length === 0) return { result: 'push', profit: 0 };
  const allNonPushWin = nonPushLegs.every(p => p.result === 'win');
  if (allNonPushWin) return { result: 'win', profit: wholeUp(calcParlayWinnings(parlayRisk, nonPushLegs.map(p => p.odds))) };
  return { result: 'pending', profit: 0 };
}

async function getDatesFromStore(storeUrl, authHeaders) {
  let dates = [];
  try {
    const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) dates = await datesResp.json();
  } catch (e) {}
  if (!Array.isArray(dates) || dates.length === 0) {
    try {
      const latestResp = await fetch(`${storeUrl}/latest-date`, { headers: authHeaders });
      if (latestResp.ok) {
        const latest = (await latestResp.text()).trim();
        if (latest) dates = [latest];
      }
    } catch (e) {}
  }
  return Array.isArray(dates) ? dates : [];
}

async function gradeDay(dateISO, picksData, opts) {
  return gradeDayBody(dateISO, picksData, opts);
}

async function gradeDayBody(dateISO, picksData, opts) {
  const picks = (picksData.picks || []).slice(0, 3);
  if (picks.length === 0) return null;

  const apiParlay = (picksData.parlayLegs && picksData.parlayLegs.length > 0) ? picksData.parlayLegs[0] : null;
  const optimizedLegs = (apiParlay && apiParlay.legs) ? apiParlay.legs : null;

  const sports = [...new Set([
    ...picks.map(p => p.sport),
    ...(optimizedLegs ? optimizedLegs.map(l => l.sport) : []),
  ].filter(Boolean))];

  // opts.games may be the board, a promise (tests yield between dates), or
  // (dateISO) => board|Promise. Absent means the live ESPN scoreboard.
  let scoresByGames;
  if (opts && typeof opts.games === 'function') {
    scoresByGames = await opts.games(dateISO);
  } else if (opts && opts.games && typeof opts.games.then === 'function') {
    scoresByGames = await opts.games;
  } else if (opts && Array.isArray(opts.games)) {
    scoresByGames = opts.games;
  } else {
    const sportResults = await Promise.all(sports.map(async sport => {
      const games = await fetchESPNScores(dateISO, sport);
      games.forEach(g => { g._sport = sport; });
      return games;
    }));
    scoresByGames = sportResults.flat();
  }
  if (!Array.isArray(scoresByGames)) scoresByGames = [];

  const dollarPerUnit = 150;
  let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
  let dayWagered = 0, dayProfit = 0;
  const gradedPicks = [];
  const gradeOpts = { dateISO: dateISO, now: opts && opts.now != null ? opts.now : null };

  for (const pick of picks) {
    const sportGames = scoresByGames.filter(g => g._sport === pick.sport);
    const game = findGameForDate(pick, sportGames, dateISO);
    const result = gradePick(pick, game, gradeOpts);
    const units = parseFloat(pick.units) || 1;
    const risk = wholeUp(units * dollarPerUnit);
    const winAmount = wholeUp(calcWinnings(risk, pick.odds || '-110'));
    let profit = 0;
    if (result === 'win') { dayWins++; profit = winAmount; }
    else if (result === 'loss') { dayLosses++; profit = -risk; }
    else if (result === 'push') { dayPushes++; profit = 0; }
    else { dayPending++; }
    // Pushes return the stake (no action) — exclude from wagered so ROI isn't diluted.
    // (profit is already 0 for push/pending, so dayProfit is unaffected either way.)
    if (result === 'win' || result === 'loss') { dayWagered += risk; dayProfit += profit; }
    const isF5Pick = /\bf5\b|first 5|1st 5|first-5/i.test(pick.pick || '') || (pick.betType || '').toLowerCase().includes('f5');
    let scoreStr = null;
    if (game && result === 'push' && omegaGradingRules.isPpdScore(pick, game, gradeOpts)) {
      scoreStr = 'PPD';
    } else if (game && game.state === 'post') {
      if (isF5Pick && (game.awayLine || []).length >= 5 && (game.homeLine || []).length >= 5) {
        scoreStr = `${game.awayLine.slice(0, 5).reduce((a, b) => a + b, 0)}-${game.homeLine.slice(0, 5).reduce((a, b) => a + b, 0)} (F5)`;
      } else {
        scoreStr = `${game.awayScore}-${game.homeScore}`;
      }
    }
    gradedPicks.push({ sport: pick.sport, matchup: pick.matchup, pick: pick.pick, odds: pick.odds, units: pick.units, rating: pick.rating, result, profit: Math.round(profit), score: scoreStr });
  }

  let parlayInput;
  if (optimizedLegs) {
    parlayInput = optimizedLegs.map(leg => {
      const eleg = withLegCommenceTime(leg, picks);
      const sportGames = scoresByGames.filter(g => g._sport === eleg.sport);
      const game = findGameForDate(eleg, sportGames, dateISO);
      return { result: gradePick(eleg, game, gradeOpts), odds: eleg.odds || '-110' };
    });
  } else {
    parlayInput = gradedPicks.map(gp => ({ result: gp.result, odds: gp.odds || '-110' }));
  }
  // Parlay stake drops to 0.25u whenever a lean pick is on the card, else 0.5u.
  const anyLean = picks.some(p => p.thinSlate);
  const parlayUnits = anyLean ? 0.25 : 0.5;
  const parlayRisk = wholeUp(parlayUnits * dollarPerUnit);
  const parlayResult = gradeParlay(parlayInput, parlayRisk);
  // From GRADING_RULES_V2_FROM, an all-push parlay returns the stake (same as a straight push).
  const parlayPushFree = omegaGradingRules.rulesV2(dateISO) && parlayResult.result === 'push';
  if (parlayResult.result !== 'pending' && parlayResult.result !== 'skip' && !parlayPushFree) {
    dayWagered += parlayRisk;
    dayProfit += parlayResult.profit;
  }
  if (parlayResult.result !== 'skip') {
    const parlayLegsSource = optimizedLegs || picks;
    gradedPicks.push({ sport: 'PARLAY', matchup: parlayLegsSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '), pick: `${parlayInput.length}-Team Parlay${optimizedLegs ? ' (Optimized)' : ''}`, odds: '', units: `${parlayUnits}u`, rating: 'P', result: parlayResult.result, profit: parlayResult.profit, score: null });
  }

  const decided = dayWins + dayLosses;
  return {
    date: dateISO,
    dateFormatted: picksData.dateFormatted || dateISO,
    source: picksData._source || 'omega',
    noPlays: false,
    picks: gradedPicks,
    wins: dayWins, losses: dayLosses, pushes: dayPushes, pending: dayPending,
    accuracy: decided > 0 ? ((dayWins / decided) * 100).toFixed(0) : '0',
    wagered: Math.round(dayWagered), profit: Math.round(dayProfit),
    roi: dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '--',
    parlayResult: parlayResult.result, parlayProfit: parlayResult.profit, parlayRisk,
  };
}

// ── All-versions KPI helpers (2026-09-26) ──
const OMEGA_KPI_START = "2026-09-22";
let LEGACY = { days: [] };
try { LEGACY = require('./lib/kpi-legacy-alpha.json'); } catch (e) { console.error('[get-results-omega] legacy KPI file missing'); }

function legacyDaysBefore(floor) {
  return (LEGACY.days || []).filter(d => d.date < floor).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '0%'; }

// Same rules the Omega page has always used: Record/Accuracy = straight picks (pushes excluded);
// P/L + ROI = all bets (straights + parlay).
function aggregateDays(list) {
  let cw = 0, cl = 0, cp = 0, cpe = 0, cwag = 0, cpr = 0;
  let sw = 0, sl = 0, swag = 0, spr = 0;
  let pw = 0, pl = 0, pwag = 0, ppr = 0;
  for (const day of list) {
    cw += day.wins || 0; cl += day.losses || 0; cp += day.pushes || 0; cpe += day.pending || 0;
    cwag += day.wagered || 0; cpr += day.profit || 0;
    for (const p of (day.picks || [])) {
      if (p.sport === 'PARLAY' || p.result === 'pending' || p.result === 'push') continue;
      swag += wholeUp((parseFloat(p.units) || 1) * 150);
      spr += p.profit || 0;
      if (p.result === 'win') sw++; else if (p.result === 'loss') sl++;
    }
    if (day.parlayResult && day.parlayResult !== 'skip' && day.parlayResult !== 'pending') {
      // All-push parlays on v2 cards add nothing. Earlier days, including frozen legacy rows, stay put.
      const parlayPushFree = omegaGradingRules.rulesV2(day.date) && day.parlayResult === 'push';
      if (!parlayPushFree) {
        pwag += (day.parlayRisk || 75); ppr += day.parlayProfit || 0;
      }
      if (day.parlayResult === 'win') pw++; else if (day.parlayResult === 'loss') pl++;
    }
  }
  return {
    cumulative: {
      wins: cw, losses: cl, pushes: cp, pending: cpe,
      accuracy: pct(cw, cw + cl),
      roi: cwag > 0 ? ((cpr / cwag) * 100).toFixed(1) + '%' : '0%',
      totalWagered: Math.round(cwag), totalProfit: Math.round(cpr),
    },
    straight: { wins: sw, losses: sl, accuracy: pct(sw, sw + sl), totalWagered: Math.round(swag), totalProfit: Math.round(spr) },
    parlay: { wins: pw, losses: pl, accuracy: pct(pw, pw + pl), totalWagered: Math.round(pwag), totalProfit: Math.round(ppr) },
  };
}

function flatSummary(list) {
  const a = aggregateDays(list);
  return {
    days: list.length,
    wins: a.straight.wins, losses: a.straight.losses, pushes: a.cumulative.pushes, pending: a.cumulative.pending,
    accuracy: a.straight.accuracy, profit: a.cumulative.totalProfit, wagered: a.cumulative.totalWagered, roi: a.cumulative.roi,
    parlayWins: a.parlay.wins, parlayLosses: a.parlay.losses,
  };
}

function shiftDate(iso, deltaDays) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Last N ET calendar days including today.
function aggregateWindow(list, n) {
  const today = getEasternDateToday();
  const from = shiftDate(today, -(n - 1));
  return { from, through: today, ...flatSummary(list.filter(d => d.date >= from && d.date <= today)) };
}

// Newest month first, current month included (it can overlap the 30-day window).
function monthlyTotals(list) {
  const byMonth = new Map();
  for (const d of list) {
    const m = d.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(d);
  }
  return [...byMonth.keys()].sort().reverse().map(m => {
    const label = new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return { month: m, label, ...flatSummary(byMonth.get(m)) };
  });
}

// ?range=7 (default, page load) | 30 (dropdown) | all. Totals/months are always included and tiny;
// only the per-day pick rows are trimmed, which is what keeps the first paint light.
function respond(full, event) {
  const params = (event && event.queryStringParameters) || {};
  const range = params.range === 'all' ? 'all' : (params.range === '30' ? 30 : 7);
  let days = full.days || [];
  if (range !== 'all') {
    const from = shiftDate(getEasternDateToday(), -(range - 1));
    days = days.filter(d => d.date >= from);
  }
  const body = { ...full, days, range: String(range), totalDays: (full.days || []).length };
  return { statusCode: 200, headers: { ...CORS, 'Cache-Control': cacheControlFor(full) }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: true, message: 'Not configured' }) };
    }

    const authHeaders = { 'Authorization': `Bearer ${token}` };
    const alphaStoreUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-omega`;

    // Adaptive cache: 30s while any pick is pending (settle promptly after final),
    // 5 min once the ET day is fully decided. v3 busts the pre-NFL/NCAAF endpoint cache.
    try {
      const cacheResp = await fetch(`${alphaStoreUrl}/${RESULTS_CACHE_KEY}`, { headers: authHeaders });
      if (cacheResp.ok) {
        const cached = await cacheResp.json();
        if (cacheIsFresh(cached, event)) {
          return respond(cached, event);
        }
      }
    } catch (e) {}

    // OMEGA: KPIs reset to start 2026-09-22 for v12.0.0-omega-vnext-clv cutover.
    // Omega store ONLY — no alpha/beta back-merge. Daily + cumulative ignore any pre-floor blob dates.
    // Optional ?from=YYYY-MM-DD can raise the floor further; default stays 2026-09-22 (v12 MAIN reset).
    const params = event.queryStringParameters || {};
    const KPI_START = OMEGA_KPI_START; // "2026-09-22" — Omega store floor; earlier dates come from the frozen legacy file
    const alphaDatesRaw = await getDatesFromStore(alphaStoreUrl, authHeaders);
    const alphaDates = alphaDatesRaw.filter(d => d >= KPI_START);

    const alphaDateSet = new Set(alphaDates);
    const betaDateSet = new Set();

    // Build lookup: date → {store, url}
    const picksLookup = new Map(
      alphaDates.map(d => [d, { store: 'omega', url: alphaStoreUrl }])
    );

    // Enumerate every calendar date from the Omega epoch to today (ET)
    const earliestDate = OMEGA_KPI_START;
    const todayET = getEasternDateToday();
    const fullDateRange = getAllDatesInRange(earliestDate, todayET);


    // PERF (2026-06-18): grade all dates in PARALLEL — was sequential await per date (~15s cold for
    // ~19 days). ESPN score fetches now overlap; cumulative stats are accumulated AFTER, in date order
    // (identical result). Cold load ~15s -> ~1-2s. Placeholder/no-play rows carry zero stats so they
    // accumulate harmlessly.
    const gradedByDate = await Promise.all(fullDateRange.map(async (dateISO) => {
      const entry = picksLookup.get(dateISO);
      if (!entry) {
        return { date: dateISO, dateFormatted: dateISO, source: 'no-picks', noPlays: true, picks: [], wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0', wagered: 0, profit: 0, roi: '--', parlayResult: 'skip', parlayProfit: 0 };
      }
      let picksData;
      try {
        const picksResp = await fetch(`${entry.url}/picks-${dateISO}`, { headers: authHeaders });
        if (!picksResp.ok) return null;
        picksData = await picksResp.json();
        picksData._source = entry.store;
      } catch (e) { return null; }
      const day = await gradeDay(dateISO, picksData);
      if (!day) {
        return { date: dateISO, dateFormatted: picksData.dateFormatted || dateISO, source: entry.store, noPlays: true, picks: [], wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0', wagered: 0, profit: 0, roi: '--', parlayResult: 'skip', parlayProfit: 0 };
      }
      return day;
    }));

    const omegaDays = gradedByDate.filter(Boolean); // oldest first

    // ALL VERSIONS (founder, 2026-09-26): the public track record is one cumulative line for the
    // algo — Beta + Alpha history frozen through the day before the Omega KPI epoch, then Omega.
    // Legacy rows come from lib/kpi-legacy-alpha.json (scripts/build-kpi-legacy.js), never regraded.
    const legacyDays = legacyDaysBefore(OMEGA_KPI_START); // oldest first
    const allDays = legacyDays.concat(omegaDays);
    const all = aggregateDays(allDays);
    const omegaOnly = aggregateDays(omegaDays);
    const legacy = aggregateDays(legacyDays);

    const result = {
      days: allDays.slice().reverse(), // newest first; respond() trims to ?range (7 default)
      cumulative: all.cumulative,
      straight: all.straight,
      parlay: all.parlay,
      scope: {
        label: 'All model versions',
        from: allDays.length ? allDays[0].date : null,
        omegaStart: OMEGA_KPI_START,
        legacyThrough: LEGACY.through || null,
      },
      omegaOnly,
      legacy,
      months: monthlyTotals(allDays),
      windows: {
        last7: aggregateWindow(allDays, 7),
        last30: aggregateWindow(allDays, 30),
      },
      cachedAt: Date.now(),
    };

    try {
      const { summarizeClvFromStore } = require('./lib/clv-summary');
      result.clv = await summarizeClvFromStore({
        storeUrl: alphaStoreUrl,
        authHeaders,
        dates: alphaDates,
      });
    } catch (e) {
      result.clv = { available: false, n: 0, meanCents: null, beatClosePct: null, byFamily: {}, note: 'clv summary unavailable' };
    }

    try {
      await fetch(`${alphaStoreUrl}/${RESULTS_CACHE_KEY}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) {}

    return respond(result, event);

  } catch (err) {
    console.error('[get-results-omega] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to compute results' }) };
  }
};

// Test-only. Netlify invokes exports.handler; this does not change the response.
exports._test = {
  findGame: findGameForDate,
  gradePick,
  gradeParlay,
  gradeDay,
  aggregateDays,
  withLegCommenceTime,
  ncaafPickedSides,
  teamsMatch,
  calcWinnings,
  wholeUp,
  GRADING_RULES_V2_FROM: omegaGradingRules.GRADING_RULES_V2_FROM,
  IDENTITY_V2_FROM: omegaGradingRules.IDENTITY_V2_FROM,
};
