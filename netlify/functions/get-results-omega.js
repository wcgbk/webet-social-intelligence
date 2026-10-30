// get-results-omega.js
// Returns combined pick history for /alpha track record:
//   - Alpha picks for dates in edge-picks-omega store
//   - Beta picks for dates before alpha started (pre-alpha history)
//   - 0-0 placeholder rows for dates with no picks in either pipeline

const { fetchESPNScores } = require('./lib/espn-scoreboard');
const { cacheIsFresh, cacheControlFor } = require('./lib/kpi-cache');
const { resolveDoubleheader, inheritCommenceTime } = require('../../js/live-score');
const { canonicalSchool, schoolsEqual } = require('./lib/ncaaf-names');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const RESULTS_CACHE_KEY = 'results-omega-cache-v9-kpi1030';
const DOLLAR_PER_UNIT = 150;

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
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Positive stake in units. Missing, blank, and zero are missing — never 1.
function parseStakeUnits(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 ? n : null;
}

function teamsMatch(pickTeam, espnTeam, espnAbbr, sport) {
  const p = normalizeTeam(pickTeam);
  const e = normalizeTeam(espnTeam);
  if (!p || !e) return false;
  if (sport === 'NCAAF') {
    if (schoolsEqual(pickTeam, espnTeam)) return true;
    if (espnAbbr && String(espnAbbr).length >= 2) {
      const a = String(espnAbbr).toLowerCase();
      if (p.split(' ').includes(a)) return true;
    }
    return false;
  }
  if (p === e) return true;
  if (p.includes(e) || e.includes(p)) return true;
  if (espnAbbr && espnAbbr.length >= 2) {
    const a = espnAbbr.toLowerCase();
    const pWords = p.split(' ');
    if (pWords.includes(a)) return true;
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

function findGame(pick, games) {
  const sport = pick.sport || '';
  const ncaaf = sport === 'NCAAF';
  const matchup = (pick.matchup || '').toLowerCase();
  const matchupParts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  const looseKey = (team) => {
    if (ncaaf) return canonicalSchool(team);
    return normalizeTeam(team).split(' ').pop();
  };
  const keyInMatchup = (key) => {
    if (!key) return false;
    if (ncaaf) return matchupParts.some(part => schoolsEqual(part, key) || canonicalSchool(part) === key);
    return key.length > 3 && matchup.includes(key);
  };
  const primary = [];
  for (const g of games) {
    const awayKey = looseKey(g.awayTeam);
    const homeKey = looseKey(g.homeTeam);
    const awayMatch = matchupParts.some(part => teamsMatch(part, g.awayTeam, g.awayAbbr, sport)) ||
                       keyInMatchup(awayKey);
    const homeMatch = matchupParts.some(part => teamsMatch(part, g.homeTeam, g.homeAbbr, sport)) ||
                       keyInMatchup(homeKey);
    if (awayMatch && homeMatch) primary.push(g);
  }
  if (primary.length) return disambiguateDoubleheader(primary, pick);
  const pickTeam = (pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  if (pickTeam && !/^\d/.test(pickTeam)) {
    const secondary = [];
    for (const g of games) {
      const awayHit = teamsMatch(pickTeam, g.awayTeam, g.awayAbbr, sport);
      const homeHit = teamsMatch(pickTeam, g.homeTeam, g.homeAbbr, sport);
      if (awayHit || homeHit) {
        const otherTeam = awayHit ? g.homeTeam : g.awayTeam;
        const otherAbbr = awayHit ? g.homeAbbr : g.awayAbbr;
        const otherOk = ncaaf
          ? matchupParts.some(part => teamsMatch(part, otherTeam, otherAbbr, sport))
          : keyInMatchup(looseKey(otherTeam));
        if (otherOk) secondary.push(g);
      }
    }
    if (secondary.length) return disambiguateDoubleheader(secondary, pick);
  }
  if (matchupParts.length >= 2) {
    const tertiary = [];
    for (const g of games) {
      const awayHit = matchupParts.some(part => teamsMatch(part, g.awayTeam, g.awayAbbr, sport));
      const homeHit = matchupParts.some(part => teamsMatch(part, g.homeTeam, g.homeAbbr, sport));
      if (awayHit && homeHit) tertiary.push(g);
      else if (!ncaaf) {
        const awayKey = looseKey(g.awayTeam);
        const homeKey = looseKey(g.homeTeam);
        const part0 = normalizeTeam(matchupParts[0]);
        const part1 = normalizeTeam(matchupParts[1]);
        if ((part0.includes(awayKey) || awayKey.includes(part0)) &&
            (part1.includes(homeKey) || homeKey.includes(part1))) tertiary.push(g);
        else if ((part0.includes(homeKey) || homeKey.includes(part0)) &&
            (part1.includes(awayKey) || awayKey.includes(part1))) tertiary.push(g);
      }
    }
    if (tertiary.length) return disambiguateDoubleheader(tertiary, pick);
  }
  return null;
}

// Parlay legs are stored WITHOUT commenceTime, so on a doubleheader date findGame falls back to the
// opener and settles the leg against the wrong final — the straight bet (which HAS commenceTime)
// grades correctly while the identical parlay leg does not. Inherit the start time from the straight
// pick naming the same matchup + selection so both sides resolve to the same game.
function withLegCommenceTime(leg, picks) {
  return inheritCommenceTime(leg, picks);
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  // Postponed / canceled games are voided by every major US book (no action) — the stake is
  // returned, so we grade them as a push. A push leg is dropped from a parlay and the ticket
  // reprices on the surviving legs (see gradeParlay). ESPN marks these state:'post' with
  // completed:false, so they must be caught BEFORE any score-based grading (0-0 → false "under").
  if (/POSTPONED|CANCELL?ED/i.test(game.statusName) || (game.state === 'post' && !game.completed)) return 'push';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  // First-Five-Innings picks settle on the first-5 score, NOT the full game.
  const isF5 = /\bf5\b|first 5|1st 5|first-5/i.test(pickStr) || betType.includes('f5') || /^f5\b/i.test(pickStr);
  let awayScore = game.awayScore;
  let homeScore = game.homeScore;
  if (isF5) {
    const aL = game.awayLine || [], hL = game.homeLine || [];
    if (aL.length < 5 || hL.length < 5) return 'pending'; // not enough innings to settle F5
    awayScore = aL.slice(0, 5).reduce((a, b) => a + b, 0);
    homeScore = hL.slice(0, 5).reduce((a, b) => a + b, 0);
  }
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam, game.awayAbbr, pick.sport);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam, game.homeAbbr, pick.sport);

  if (betType === 'total' || /over|under/i.test(pickStr)) {
    const totalPoints = awayScore + homeScore;
    const lineMatch = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (lineMatch) {
      const ou = lineMatch[1].toLowerCase();
      const line = parseFloat(lineMatch[2]);
      if (totalPoints === line) return 'push';
      const over = totalPoints > line;
      return (ou === 'over' && over) || (ou === 'under' && !over) ? 'win' : 'loss';
    }
  }
  if (betType === 'spread' || betType === 'puck line' || /[+-]\d+(\.\d+)?/.test(pickStr)) {
    const spreadMatch = pickStr.match(/([+-]\d+(\.\d+)?)/);
    if (spreadMatch && (pickedAway || pickedHome)) {
      const spread = parseFloat(spreadMatch[1]);
      const pickedScore = pickedAway ? awayScore : homeScore;
      const oppScore = pickedAway ? homeScore : awayScore;
      const adjusted = pickedScore + spread;
      if (adjusted === oppScore) return 'push';
      return adjusted > oppScore ? 'win' : 'loss';
    }
  }
  if (pickedAway || pickedHome) {
    const pickedScore = pickedAway ? awayScore : homeScore;
    const oppScore = pickedAway ? homeScore : awayScore;
    if (pickedScore === oppScore) return 'push';
    return pickedScore > oppScore ? 'win' : 'loss';
  }
  if (/draw/i.test(pickStr)) return awayScore === homeScore ? 'win' : 'loss';
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
// keeps an already-whole amount whole (avoids 75 -> 76 on float dust). A zero magnitude stays
// +0: ceil(0 - 1e-9) is -0, and a push profit must display as 0.
// Losses use the same magnitude, so a 37.5 stake lost shows as -38, not -37.
function wholeUp(n) {
  const v = Math.ceil((Number(n) || 0) - 1e-9);
  return v === 0 ? 0 : v;
}
function wholeUpSigned(n) {
  const x = Number(n) || 0;
  if (x < 0) return -wholeUp(Math.abs(x));
  return wholeUp(x);
}

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

function scoreLine(pick, game, result) {
  if (!game || game.state !== 'post') return null;
  if (result === 'push' && (/POSTPONED|CANCELL?ED/i.test(game.statusName) || !game.completed)) return 'PPD';
  const isF5Pick = /\bf5\b|first 5|1st 5|first-5/i.test(pick.pick || '') || (pick.betType || '').toLowerCase().includes('f5');
  if (isF5Pick && (game.awayLine || []).length >= 5 && (game.homeLine || []).length >= 5) {
    return `${game.awayLine.slice(0, 5).reduce((a, b) => a + b, 0)}-${game.homeLine.slice(0, 5).reduce((a, b) => a + b, 0)} (F5)`;
  }
  return `${game.awayScore}-${game.homeScore}`;
}

function priceStraight(units, odds, result) {
  const risk = wholeUp(units * DOLLAR_PER_UNIT);
  if (result === 'win') return { risk, profit: wholeUp(calcWinnings(risk, odds || '-110')) };
  if (result === 'loss') return { risk, profit: -risk };
  return { risk, profit: 0 };
}

function emptyCounts() {
  return { wins: 0, losses: 0, pushes: 0, pending: 0, bets: 0, wagered: 0, profit: 0, pushWagered: 0 };
}

function addCount(scope, bet) {
  if (!bet) return;
  if (bet.result === 'win' || bet.result === 'loss') {
    if (bet.result === 'win') scope.wins++;
    else scope.losses++;
    scope.bets++;
    scope.wagered += bet.risk;
    scope.profit += bet.profit;
  } else if (bet.result === 'push') {
    scope.pushes++;
    scope.bets++;
    scope.pushWagered += Number(bet.risk) || 0;
  } else if (bet.result === 'pending') {
    scope.pending++;
  }
}

// Record W-L-P and ROI describe the same bets. Pushes stay in the record and
// out of wagered. Pending is counted and not in either. Dollars are whole, rounded up.
function finalizeScope(scope, name) {
  const profit = wholeUpSigned(scope.profit);
  const wagered = wholeUp(scope.wagered);
  const decided = scope.wins + scope.losses;
  return {
    scope: name,
    kpiScope: name,
    record: `${scope.wins}-${scope.losses}-${scope.pushes}`,
    wins: scope.wins,
    losses: scope.losses,
    pushes: scope.pushes,
    pending: scope.pending,
    bets: scope.bets,
    wagered,
    profit,
    totalWagered: wagered,
    totalProfit: profit,
    roi: wagered > 0 ? ((profit / wagered) * 100).toFixed(1) + '%' : '0%',
    accuracy: pct(scope.wins, decided),
    pushWagered: wholeUp(scope.pushWagered || 0),
  };
}

function scopesFromPicks(picks, date) {
  const straight = emptyCounts();
  const parlay = emptyCounts();
  const flags = [];
  const unitsMissing = [];
  for (const pick of picks || []) consumePick(straight, parlay, flags, unitsMissing, pick, date);
  return scopesFromCounts(straight, parlay, flags, unitsMissing);
}

// Production convention for the published overall ROI: push stakes stay in
// wagered (profit 0). Scope blocks (straightsOnly/allIn) exclude them.
function publishedMoney(all) {
  const wagered = all.wagered + (all.pushWagered || 0);
  return { wagered, profit: all.profit, roiNum: wagered > 0 ? (all.profit / wagered) * 100 : null };
}

function stampDay(base, scopes, parlayMeta) {
  // Published shape is unchanged (WeBet 2026-10-30): record/accuracy = straight
  // picks only; wagered/profit/ROI = all bets (straights + parlay).
  const all = scopes.allIn;
  const st = scopes.straightsOnly;
  const decided = st.wins + st.losses;
  return Object.assign({}, base, {
    wins: st.wins,
    losses: st.losses,
    pushes: st.pushes,
    pending: st.pending,
    accuracy: decided > 0 ? ((st.wins / decided) * 100).toFixed(0) : '0',
    wagered: publishedMoney(all).wagered,
    profit: all.profit,
    roi: publishedMoney(all).roiNum != null ? publishedMoney(all).roiNum.toFixed(1) : '--',
    kpiScope: 'record=straightsOnly,roi=allIn',
    recordScope: 'straightsOnly',
    roiScope: 'allIn',
    record: all.record,
    bets: all.bets,
    straightsOnly: scopes.straightsOnly,
    allIn: scopes.allIn,
    parlay: scopes.parlay,
    flags: scopes.flags,
    unitsMissing: scopes.unitsMissing,
    parlayResult: parlayMeta.result,
    parlayProfit: parlayMeta.profit,
    parlayRisk: parlayMeta.risk,
  });
}

async function gradeDay(dateISO, picksData, opts) {
  const picks = (picksData.picks || []).slice(0, 3);
  if (picks.length === 0) return null;

  const apiParlay = (picksData.parlayLegs && picksData.parlayLegs.length > 0) ? picksData.parlayLegs[0] : null;
  const optimizedLegs = (apiParlay && apiParlay.legs) ? apiParlay.legs : null;
  const ticketLegs = optimizedLegs && optimizedLegs.length >= 2 ? optimizedLegs : null;

  let scoresByGames;
  if (opts && Array.isArray(opts.games)) {
    scoresByGames = opts.games.map(g => ({ ...g, _sport: g._sport || null }));
  } else {
    const sports = [...new Set([
      ...picks.map(p => p.sport),
      ...(ticketLegs ? ticketLegs.map(l => l.sport) : []),
    ].filter(Boolean))];
    const sportResults = await Promise.all(sports.map(async sport => {
      const games = await fetchESPNScores(dateISO, sport);
      games.forEach(g => { g._sport = sport; });
      return games;
    }));
    scoresByGames = sportResults.flat();
  }
  const gamesFor = (sport) => scoresByGames.filter(g => !g._sport || g._sport === sport);

  const gradedPicks = [];
  for (const pick of picks) {
    const game = findGame(pick, gamesFor(pick.sport));
    const result = gradePick(pick, game);
    const units = parseStakeUnits(pick.units);
    const missing = units == null;
    const priced = missing ? { risk: 0, profit: 0 } : priceStraight(units, pick.odds, result);
    gradedPicks.push({
      sport: pick.sport,
      matchup: pick.matchup,
      pick: pick.pick,
      odds: pick.odds,
      units: pick.units,
      rating: pick.rating,
      result,
      profit: priced.profit,
      score: scoreLine(pick, game, result),
      unitsMissing: missing,
      stakeDollars: missing ? null : priced.risk,
    });
  }

  let parlayInput = null;
  let parlayLabelSource = null;
  if (ticketLegs) {
    parlayInput = ticketLegs.map(leg => {
      const eleg = withLegCommenceTime(leg, picks);
      const game = findGame(eleg, gamesFor(eleg.sport));
      return { result: gradePick(eleg, game), odds: eleg.odds || '-110' };
    });
    parlayLabelSource = ticketLegs;
  } else if (!apiParlay) {
    parlayInput = gradedPicks.map(gp => ({ result: gp.result, odds: gp.odds || '-110' }));
    parlayLabelSource = picks;
  }
  let parlayMeta = { result: 'skip', profit: 0, risk: null };
  if (parlayInput && parlayInput.length >= 2) {
    const preview = gradeParlay(parlayInput, 0);
    const units = parseStakeUnits(apiParlay && apiParlay.units);
    const missing = units == null;
    if (!missing && preview.result !== 'skip') {
      const risk = wholeUp(units * DOLLAR_PER_UNIT);
      const priced = gradeParlay(parlayInput, risk);
      parlayMeta = { result: priced.result, profit: priced.profit, risk: (priced.result === 'win' || priced.result === 'loss') ? risk : null };
      gradedPicks.push({
        sport: 'PARLAY',
        matchup: parlayLabelSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '),
        pick: `${parlayInput.length}-Team Parlay${ticketLegs ? ' (Optimized)' : ''}`,
        odds: (apiParlay && apiParlay.combinedOdds) || '',
        units: apiParlay.units,
        rating: 'P',
        result: priced.result,
        profit: priced.profit,
        score: null,
        unitsMissing: false,
        stakeDollars: risk,
      });
    } else if (preview.result !== 'skip') {
      parlayMeta = { result: preview.result, profit: 0, risk: null };
      gradedPicks.push({
        sport: 'PARLAY',
        matchup: parlayLabelSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '),
        pick: `${parlayInput.length}-Team Parlay${ticketLegs ? ' (Optimized)' : ''}`,
        odds: (apiParlay && apiParlay.combinedOdds) || '',
        units: (apiParlay && apiParlay.units) || null,
        rating: 'P',
        result: preview.result,
        profit: 0,
        score: null,
        unitsMissing: true,
        stakeDollars: null,
      });
    }
  }

  const scopes = scopesFromPicks(gradedPicks, dateISO);
  return stampDay({
    date: dateISO,
    dateFormatted: picksData.dateFormatted || dateISO,
    source: picksData._source || 'omega',
    noPlays: false,
    picks: gradedPicks,
  }, scopes, parlayMeta);
}

// ── All-versions KPI helpers (2026-09-26) ──
const OMEGA_KPI_START = "2026-09-22";
let LEGACY = { days: [] };
try { LEGACY = require('./lib/kpi-legacy-alpha.json'); } catch (e) { console.error('[get-results-omega] legacy KPI file missing'); }

function legacyDaysBefore(floor) {
  return (LEGACY.days || []).filter(d => d.date < floor).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '0%'; }

function addCounts(into, from) {
  for (const key of Object.keys(into)) into[key] += from[key] || 0;
}

// Record and ROI for a scope are the same bets. A missing stake is not 1u:
// that bet stays out of both the record and the money, and is flagged.
function consumePick(straight, parlay, flags, unitsMissing, pick, date) {
  if (!pick || pick.result === 'skip') return;
  const isParlay = pick.sport === 'PARLAY';
  const units = pick.unitsMissing ? null : parseStakeUnits(pick.units);
  if (units == null) {
    flags.push({
      issue: 'units_missing',
      date: date || null,
      pick: pick.pick || null,
      sport: pick.sport || null,
      result: pick.result || null,
    });
    if (pick.result === 'win' || pick.result === 'loss' || pick.result === 'push') {
      unitsMissing.push({
        date: date || null,
        pick: pick.pick || null,
        sport: pick.sport || null,
        result: pick.result,
      });
    }
    return;
  }
  const risk = Number.isFinite(pick.stakeDollars) ? pick.stakeDollars : wholeUp(units * DOLLAR_PER_UNIT);
  addCount(isParlay ? parlay : straight, {
    result: pick.result,
    risk,
    profit: (pick.result === 'push' || pick.result === 'pending') ? 0 : (Number(pick.profit) || 0),
  });
}

function scopesFromCounts(straight, parlay, flags, unitsMissing) {
  const all = emptyCounts();
  addCounts(all, straight);
  addCounts(all, parlay);
  return {
    straightsOnly: finalizeScope(straight, 'straightsOnly'),
    allIn: finalizeScope(all, 'allIn'),
    parlay: finalizeScope(parlay, 'parlay'),
    flags,
    unitsMissing,
  };
}

// Sum each scope from the picks on the rows. Day-level wagered/wins are not
// reused: those older fields paired a straight record with all-in dollars.
function aggregateDays(list) {
  const straight = emptyCounts();
  const parlay = emptyCounts();
  const flags = [];
  const unitsMissing = [];
  for (const day of list || []) {
    for (const pick of day.picks || []) consumePick(straight, parlay, flags, unitsMissing, pick, day.date);
  }
  const scopes = scopesFromCounts(straight, parlay, flags, unitsMissing);
  return {
    cumulative: {
      wins: scopes.straightsOnly.wins, losses: scopes.straightsOnly.losses,
      pushes: scopes.straightsOnly.pushes, pending: scopes.straightsOnly.pending,
      accuracy: scopes.straightsOnly.accuracy,
      roi: publishedMoney(scopes.allIn).roiNum != null ? publishedMoney(scopes.allIn).roiNum.toFixed(1) + '%' : '0%',
      totalWagered: publishedMoney(scopes.allIn).wagered, totalProfit: scopes.allIn.profit,
      kpiScope: 'record=straightsOnly,roi=allIn', recordScope: 'straightsOnly', roiScope: 'allIn',
    },
    straight: Object.assign({}, scopes.straightsOnly, { kpiScope: 'straightsOnly', recordScope: 'straightsOnly', roiScope: 'straightsOnly' }),
    parlay: scopes.parlay,
    straightsOnly: scopes.straightsOnly,
    allIn: scopes.allIn,
    flags: scopes.flags,
    unitsMissing: scopes.unitsMissing,
    kpiScope: 'record=straightsOnly,roi=allIn',
    recordScope: 'straightsOnly',
    roiScope: 'allIn',
  };
}

function flatSummary(list) {
  const a = aggregateDays(list);
  const st = a.straightsOnly;
  const all = a.allIn;
  return {
    days: list.length,
    wins: st.wins, losses: st.losses, pushes: st.pushes, pending: st.pending,
    accuracy: st.accuracy, profit: all.profit, wagered: publishedMoney(all).wagered,
    roi: publishedMoney(all).roiNum != null ? publishedMoney(all).roiNum.toFixed(1) + '%' : '0%',
    parlayWins: a.parlay.wins, parlayLosses: a.parlay.losses,
    recordScope: 'straightsOnly', roiScope: 'allIn',
    straightsOnly: st,
    allIn: all,
  };
}

function normPickText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findCardStraight(card, ledgerPick) {
  if (!card || !Array.isArray(card.picks) || !ledgerPick) return null;
  const want = normPickText(ledgerPick.pick);
  const matchup = normPickText(ledgerPick.matchup);
  const hits = card.picks.filter((p) => normPickText(p.pick) === want || normPickText(p.side) === want);
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  return hits.find((p) => normPickText(p.matchup) === matchup) || null;
}

function parlayTicket(card) {
  const ticket = card && Array.isArray(card.parlayLegs) ? card.parlayLegs[0] : null;
  if (!ticket || ticket.type === 'no-qualifying-parlay') return null;
  if (!Array.isArray(ticket.legs) || ticket.legs.length < 2) return null;
  return ticket;
}

function storedParlayRisk(day, pick) {
  const result = pick && pick.result;
  const settled = result === 'win' || result === 'loss';
  if (!settled) return 0;
  if (day && day.parlayRisk != null && Number(day.parlayRisk) > 0) return Number(day.parlayRisk);
  if (pick && Number.isFinite(pick.stakeDollars) && pick.stakeDollars > 0) return pick.stakeDollars;
  const units = parseStakeUnits(pick && pick.units);
  return units == null ? 0 : wholeUp(units * DOLLAR_PER_UNIT);
}

// Restake a stored parlay from the card ticket. Straight results are kept.
// A missing ticket stake is flagged and removed from the dollars. It is not 1u or 0.5u.
function recomputeParlayFields(day, card) {
  const next = JSON.parse(JSON.stringify(day || {}));
  const ticket = parlayTicket(card);
  const parlayPick = (next.picks || []).find((p) => p && p.sport === 'PARLAY') || null;
  if (!parlayPick) return next;
  const units = ticket ? parseStakeUnits(ticket.units) : parseStakeUnits(parlayPick.units);
  const missing = units == null;
  const result = parlayPick.result;
  const settled = result === 'win' || result === 'loss';
  const oldProfit = Number(parlayPick.profit) || 0;
  const oldRisk = storedParlayRisk(day, parlayPick);
  let newProfit = oldProfit;
  let newRisk = missing ? 0 : wholeUp(units * DOLLAR_PER_UNIT);
  if (missing) {
    newProfit = 0;
    newRisk = 0;
  } else if (settled && newRisk !== oldRisk) {
    if (result === 'loss') newProfit = -newRisk;
    else if (oldRisk > 0 && oldProfit) newProfit = wholeUpSigned(oldProfit * newRisk / oldRisk);
    else if (ticket && ticket.combinedOdds) newProfit = wholeUp(calcWinnings(newRisk, ticket.combinedOdds));
  } else if (!settled) {
    newProfit = 0;
  }
  parlayPick.unitsMissing = missing;
  parlayPick.profit = newProfit;
  parlayPick.stakeDollars = missing ? null : newRisk;
  if (ticket && !missing && ticket.units != null) parlayPick.units = ticket.units;
  next.parlayResult = result || next.parlayResult || 'skip';
  next.parlayProfit = newProfit;
  next.parlayRisk = (!missing && settled) ? newRisk : null;
  const wageredDelta = (missing || !settled ? 0 : newRisk) - oldRisk;
  next.wagered = (Number(day && day.wagered) || 0) + wageredDelta;
  next.profit = (Number(day && day.profit) || 0) - oldProfit + newProfit;
  if (missing) {
    next.flags = (next.flags || []).concat([{
      issue: 'units_missing',
      date: next.date || null,
      pick: parlayPick.pick || null,
      sport: 'PARLAY',
      result: result || null,
    }]);
  }
  return next;
}

// Settled straight results stay. Pending NCAAF is graded when `games` has the
// final. Stakes come from the card when the card has that bet, otherwise from
// the stored pick. Neither source defaults a blank stake to 1u.
function replayDay(day, card, games) {
  const next = JSON.parse(JSON.stringify(day || {}));
  const board = Array.isArray(games) ? games : [];
  for (const pick of next.picks || []) {
    if (!pick || pick.sport === 'PARLAY') continue;
    const cardPick = findCardStraight(card, pick);
    const originalUnits = parseStakeUnits(pick.units);
    const units = cardPick ? parseStakeUnits(cardPick.units) : originalUnits;
    const before = pick.result;
    if (pick.sport === 'NCAAF' && pick.result === 'pending' && board.length) {
      const game = findGame(pick, board.filter((g) => !g._sport || g._sport === 'NCAAF'));
      const result = gradePick(pick, game);
      if (result !== 'pending') {
        pick.result = result;
        pick.score = scoreLine(pick, game, result);
      }
    }
    if (units == null) {
      pick.unitsMissing = true;
      pick.profit = 0;
      pick.stakeDollars = null;
      continue;
    }
    pick.unitsMissing = false;
    if (cardPick && cardPick.units != null) pick.units = cardPick.units;
    const graded = before === 'pending' && pick.result !== 'pending';
    const unitsChanged = originalUnits !== units;
    if (graded || unitsChanged) {
      const priced = priceStraight(units, pick.odds, pick.result);
      pick.profit = priced.profit;
      pick.stakeDollars = priced.risk;
    } else {
      pick.stakeDollars = wholeUp(units * DOLLAR_PER_UNIT);
    }
  }
  const restaked = recomputeParlayFields(next, card);
  const scopes = scopesFromPicks(restaked.picks, restaked.date);
  return stampDay(restaked, scopes, {
    result: restaked.parlayResult || 'skip',
    profit: restaked.parlayProfit || 0,
    risk: restaked.parlayRisk == null ? null : restaked.parlayRisk,
  });
}

function cardsToMap(cards) {
  if (!cards) return new Map();
  if (cards instanceof Map) return cards;
  if (Array.isArray(cards)) {
    const map = new Map();
    for (const card of cards) if (card && card.date) map.set(card.date, card);
    return map;
  }
  return new Map(Object.entries(cards));
}

function replayKpis(days, cards, games) {
  const map = cardsToMap(cards);
  const board = Array.isArray(games) ? games : [];
  const replayed = (days || []).map((day) => replayDay(day, map.get(day && day.date) || null, board));
  const agg = aggregateDays(replayed);
  agg.days = replayed;
  agg.defaultedTo1u = countDefaultedTo1u(days);
  return agg;
}

// How many settled straights the old `parseFloat(units) || 1` path would have
// invented. Parlay `|| 75` is half a unit, so it is not counted here.
function countDefaultedTo1u(days) {
  let n = 0;
  for (const day of days || []) {
    for (const pick of day.picks || []) {
      if (!pick || pick.sport === 'PARLAY') continue;
      if (pick.result !== 'win' && pick.result !== 'loss') continue;
      if (parseStakeUnits(pick.units) == null) n += 1;
    }
  }
  return n;
}

function annotateStoredDay(day) {
  if (!day) return day;
  if (day.kpiScope === 'allIn' && day.straightsOnly && day.allIn) return day;
  if (!Array.isArray(day.picks) || day.picks.length === 0) return day;
  const scopes = scopesFromPicks(day.picks, day.date);
  return stampDay(day, scopes, {
    result: day.parlayResult == null ? 'skip' : day.parlayResult,
    profit: day.parlayProfit || 0,
    risk: day.parlayRisk == null ? null : day.parlayRisk,
  });
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
    const legacyDays = legacyDaysBefore(OMEGA_KPI_START).map(annotateStoredDay); // oldest first
    const omegaPresented = omegaDays.map(annotateStoredDay);
    const allDays = legacyDays.concat(omegaPresented);
    const all = aggregateDays(allDays);
    const omegaOnly = aggregateDays(omegaPresented);
    const legacy = aggregateDays(legacyDays);

    const result = {
      days: allDays.slice().reverse(), // newest first; respond() trims to ?range (7 default)
      cumulative: all.cumulative,
      straight: all.straight,
      parlay: all.parlay,
      straightsOnly: all.straightsOnly,
      allIn: all.allIn,
      flags: all.flags,
      unitsMissing: all.unitsMissing,
      scope: {
        label: 'All model versions',
        from: allDays.length ? allDays[0].date : null,
        omegaStart: OMEGA_KPI_START,
        legacyThrough: LEGACY.through || null,
        kpiScope: 'record=straightsOnly,roi=allIn',
        recordScope: 'straightsOnly',
        roiScope: 'allIn',
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

exports._test = {
  aggregateDays,
  gradeDay,
  gradePick,
  findGame,
  teamsMatch,
  wholeUp,
  wholeUpSigned,
  parseStakeUnits,
  scopesFromPicks,
  recomputeParlayFields,
  replayDay,
  replayKpis,
  countDefaultedTo1u,
  annotateStoredDay,
  DOLLAR_PER_UNIT,
};
