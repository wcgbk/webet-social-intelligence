// get-results-nfl.js
// Returns pick history + clean NFL-only KPIs for the /nfl track record.
// Reads ONLY the edge-picks-nfl store (the NFL model's separate environment) and grades
// lazily against ESPN NFL finals on read — same architecture as get-results-alpha, with a
// brand-new stat line starting from zero for the NFL model.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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

async function fetchESPNScores(dateISO) {
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateParam}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) return null;
      const status = comp.status || ev.status || {};
      return {
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        state: status.type?.state || 'pre',
        statusName: status.type?.name || '',
        completed: !!status.type?.completed,
        startISO: ev.date || comp.date || '',
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function teamsMatch(pickTeam, espnTeam, espnAbbr) {
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
  const pLast = p.split(' ').pop();
  const eLast = e.split(' ').pop();
  if (pLast.length > 2 && pLast === eLast) return true;
  return false;
}

function findGame(pick, games) {
  const matchup = (pick.matchup || '').toLowerCase();
  const matchupParts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  for (const g of games) {
    const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
    const awayMatch = matchupParts.some(part => teamsMatch(part, g.awayTeam, g.awayAbbr)) ||
                       (awayLast.length > 3 && matchup.includes(awayLast));
    const homeMatch = matchupParts.some(part => teamsMatch(part, g.homeTeam, g.homeAbbr)) ||
                       (homeLast.length > 3 && matchup.includes(homeLast));
    if (awayMatch && homeMatch) return g;
  }
  const pickTeam = (pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  if (pickTeam) {
    for (const g of games) {
      if (teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) || teamsMatch(pickTeam, g.homeTeam, g.homeAbbr)) {
        const otherLast = normalizeTeam(
          teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) ? g.homeTeam : g.awayTeam
        ).split(' ').pop();
        if (otherLast.length > 3 && matchup.includes(otherLast)) return g;
      }
    }
  }
  return null;
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  // Postponed / canceled → no action → push (must precede score-based grading: 0-0 ≠ under).
  if (/POSTPONED|CANCELL?ED/i.test(game.statusName) || (game.state === 'post' && !game.completed)) return 'push';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  const awayScore = game.awayScore;
  const homeScore = game.homeScore;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam, game.awayAbbr);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam, game.homeAbbr);

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
  if (betType === 'spread' || /[+-]\d+(\.\d+)?/.test(pickStr)) {
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

// Whole-dollar display: round UP (37.5 -> 38); -1e-9 keeps wholes whole.
function wholeUp(n) { return Math.ceil((n || 0) - 1e-9); }

function gradeParlay(pickResults, parlayRisk) {
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
  if (nonPushLegs.every(p => p.result === 'win')) return { result: 'win', profit: wholeUp(calcParlayWinnings(parlayRisk, nonPushLegs.map(p => p.odds))) };
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

async function gradeDay(dateISO, picksData) {
  const picks = (picksData.picks || []).slice(0, 3);
  if (picks.length === 0) return null;

  const games = await fetchESPNScores(dateISO);

  const dollarPerUnit = 150;
  let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
  let dayWagered = 0, dayProfit = 0;
  const gradedPicks = [];

  for (const pick of picks) {
    const game = findGame(pick, games);
    const result = gradePick(pick, game);
    const units = parseFloat(pick.units) || 1;
    const risk = wholeUp(units * dollarPerUnit);
    const winAmount = wholeUp(calcWinnings(risk, pick.odds || '-110'));
    let profit = 0;
    if (result === 'win') { dayWins++; profit = winAmount; }
    else if (result === 'loss') { dayLosses++; profit = -risk; }
    else if (result === 'push') { dayPushes++; profit = 0; }
    else { dayPending++; }
    if (result === 'win' || result === 'loss') { dayWagered += risk; dayProfit += profit; }
    let scoreStr = null;
    if (game && game.state === 'post' && result === 'push' && (/POSTPONED|CANCELL?ED/i.test(game.statusName) || !game.completed)) {
      scoreStr = 'PPD';
    } else if (game && game.state === 'post') {
      scoreStr = `${game.awayScore}-${game.homeScore}`;
    }
    gradedPicks.push({ sport: pick.sport, matchup: pick.matchup, pick: pick.pick, odds: pick.odds, units: pick.units, rating: pick.rating, result, profit: Math.round(profit), score: scoreStr });
  }

  // Parlay (only exists on 3-game slates; gradeParlay skips <2 legs)
  const apiParlay = (picksData.parlayLegs && picksData.parlayLegs.length > 0) ? picksData.parlayLegs[0] : null;
  const optimizedLegs = (apiParlay && apiParlay.legs) ? apiParlay.legs : null;
  let parlayInput;
  if (optimizedLegs) {
    parlayInput = optimizedLegs.map(leg => {
      const game = findGame(leg, games);
      return { result: gradePick(leg, game), odds: leg.odds || '-110' };
    });
  } else if (picks.length === 3) {
    parlayInput = gradedPicks.map(gp => ({ result: gp.result, odds: gp.odds || '-110' }));
  } else {
    parlayInput = [];
  }
  const anyLean = picks.some(p => p.thinSlate);
  const parlayUnits = anyLean ? 0.25 : 0.5;
  const parlayRisk = wholeUp(parlayUnits * dollarPerUnit);
  const parlayResult = gradeParlay(parlayInput, parlayRisk);
  if (parlayResult.result !== 'pending' && parlayResult.result !== 'skip') {
    dayWagered += parlayRisk;
    dayProfit += parlayResult.profit;
  }
  if (parlayResult.result !== 'skip') {
    const parlayLegsSource = optimizedLegs || picks;
    gradedPicks.push({ sport: 'PARLAY', matchup: parlayLegsSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '), pick: `${parlayInput.length}-Team Parlay`, odds: '', units: `${parlayUnits}u`, rating: 'P', result: parlayResult.result, profit: parlayResult.profit, score: null });
  }

  const decided = dayWins + dayLosses;
  return {
    date: dateISO,
    dateFormatted: picksData.dateFormatted || dateISO,
    source: 'nfl',
    noPlays: false,
    picks: gradedPicks,
    wins: dayWins, losses: dayLosses, pushes: dayPushes, pending: dayPending,
    accuracy: decided > 0 ? ((dayWins / decided) * 100).toFixed(0) : '0',
    wagered: Math.round(dayWagered), profit: Math.round(dayProfit),
    roi: dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '--',
    parlayResult: parlayResult.result, parlayProfit: parlayResult.profit, parlayRisk,
  };
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
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-nfl`;

    // 5-min cache
    try {
      const cacheResp = await fetch(`${storeUrl}/results-nfl-cache-v1`, { headers: authHeaders });
      if (cacheResp.ok) {
        const cached = await cacheResp.json();
        if (Date.now() - (cached.cachedAt || 0) < 300000) {
          return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(cached) };
        }
      }
    } catch (e) {}

    const nflDates = await getDatesFromStore(storeUrl, authHeaders);
    if (nflDates.length === 0) {
      // Clean slate — the NFL model's KPIs start at zero, by design.
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ days: [], cumulative: { wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 }, straight: { wins: 0, losses: 0, accuracy: '0%' }, parlay: { wins: 0, losses: 0, accuracy: '0%' } }) };
    }

    // NFL runs game days only — enumerate ONLY dates that actually have stored cards, not
    // every calendar day (a full-gap calendar would fill the table with off-day rows).
    const allDates = [...nflDates].sort();

    const gradedByDate = await Promise.all(allDates.map(async (dateISO) => {
      let picksData;
      try {
        const picksResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: authHeaders });
        if (!picksResp.ok) return null;
        picksData = await picksResp.json();
      } catch (e) { return null; }
      const day = await gradeDay(dateISO, picksData);
      if (!day) {
        return { date: dateISO, dateFormatted: picksData.dateFormatted || dateISO, source: 'nfl', noPlays: true, picks: [], wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0', wagered: 0, profit: 0, roi: '--', parlayResult: 'skip', parlayProfit: 0 };
      }
      return day;
    }));

    const days = [];
    let cumWins = 0, cumLosses = 0, cumPushes = 0, cumPending = 0;
    let cumWagered = 0, cumProfit = 0;
    let straightWins = 0, straightLosses = 0, straightWagered = 0, straightProfit = 0;
    let parlayWins = 0, parlayLosses = 0, parlayWagered = 0, parlayProfit = 0;

    for (const day of gradedByDate) {
      if (!day) continue;
      cumWins += day.wins; cumLosses += day.losses; cumPushes += day.pushes; cumPending += day.pending;
      cumWagered += day.wagered; cumProfit += day.profit;

      for (const p of day.picks.filter(p => p.sport !== 'PARLAY' && p.result !== 'pending' && p.result !== 'push')) {
        const risk = wholeUp((parseFloat(p.units) || 1) * 150);
        straightWagered += risk;
        straightProfit += p.profit;
        if (p.result === 'win') straightWins++;
        else if (p.result === 'loss') straightLosses++;
      }

      if (day.parlayResult && day.parlayResult !== 'skip' && day.parlayResult !== 'pending') {
        parlayWagered += (day.parlayRisk || 75); parlayProfit += day.parlayProfit;
        if (day.parlayResult === 'win') parlayWins++;
        else if (day.parlayResult === 'loss') parlayLosses++;
      }

      days.push(day);
    }

    const cumDecided = cumWins + cumLosses;
    const straightDecided = straightWins + straightLosses;
    const parlayDecided = parlayWins + parlayLosses;

    const result = {
      days: days.reverse(), // newest first
      cumulative: {
        wins: cumWins, losses: cumLosses, pushes: cumPushes, pending: cumPending,
        accuracy: cumDecided > 0 ? ((cumWins / cumDecided) * 100).toFixed(1) + '%' : '0%',
        roi: cumWagered > 0 ? ((cumProfit / cumWagered) * 100).toFixed(1) + '%' : '0%',
        totalWagered: Math.round(cumWagered), totalProfit: Math.round(cumProfit),
      },
      straight: {
        wins: straightWins, losses: straightLosses,
        accuracy: straightDecided > 0 ? ((straightWins / straightDecided) * 100).toFixed(1) + '%' : '0%',
        totalWagered: Math.round(straightWagered), totalProfit: Math.round(straightProfit),
      },
      parlay: {
        wins: parlayWins, losses: parlayLosses,
        accuracy: parlayDecided > 0 ? ((parlayWins / parlayDecided) * 100).toFixed(1) + '%' : '0%',
        totalWagered: Math.round(parlayWagered), totalProfit: Math.round(parlayProfit),
      },
      cachedAt: Date.now(),
    };

    try {
      await fetch(`${storeUrl}/results-nfl-cache-v1`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) {}

    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[get-results-nfl] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to compute results' }) };
  }
};
