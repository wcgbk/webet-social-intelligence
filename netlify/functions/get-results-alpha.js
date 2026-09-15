// get-results-alpha.js
// Returns combined pick history for /alpha track record:
//   - Alpha picks for dates in edge-picks-alpha store
//   - Beta picks for dates before alpha started (pre-alpha history)
//   - 0-0 placeholder rows for dates with no picks in either pipeline

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const ESPN_ENDPOINTS = {
  'NBA': 'basketball/nba',
  'NHL': 'hockey/nhl',
  'NCAAB': 'basketball/mens-college-basketball',
  'MLB': 'baseball/mlb',
  'EPL': 'soccer/eng.1',
  'La Liga': 'soccer/esp.1',
  'Serie A': 'soccer/ita.1',
  'Bundesliga': 'soccer/ger.1',
  'Ligue 1': 'soccer/fra.1',
  'MLS': 'soccer/usa.1',
  'UCL': 'soccer/uefa.champions',
  'UEL': 'soccer/uefa.europa',
  'Europa': 'soccer/uefa.europa',
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

async function fetchESPNScores(dateISO, sport) {
  const endpoint = ESPN_ENDPOINTS[sport];
  if (!endpoint) return [];
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard?dates=${dateParam}`;
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
        awayLine: (away.linescores || []).map(x => parseInt(x.value) || 0),
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        homeLine: (home.linescores || []).map(x => parseInt(x.value) || 0),
        state: status.type?.state || 'pre',
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
  if (matchupParts.length >= 2) {
    for (const g of games) {
      const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
      const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
      const part0 = normalizeTeam(matchupParts[0]);
      const part1 = normalizeTeam(matchupParts[1]);
      if ((part0.includes(awayLast) || awayLast.includes(part0)) &&
          (part1.includes(homeLast) || homeLast.includes(part1))) return g;
      if ((part0.includes(homeLast) || homeLast.includes(part0)) &&
          (part1.includes(awayLast) || awayLast.includes(part1))) return g;
    }
  }
  return null;
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();

  // F5 (first-5-innings) bets settle on the score THROUGH 5 innings, not the full game.
  // The base 6/29 grader scored F5 on the full-game total (e.g. an F5 that ended 1-1 but
  // the game finished 4-3 was mis-scored a win instead of a push). F5-only fix — non-F5
  // grading below is unchanged. (Ben-directed 2026-08-22.)
  const isF5 = betType.includes('f5') || /\bf5\b|first 5( innings)?/i.test(pickStr);
  let awayScore = game.awayScore;
  let homeScore = game.homeScore;
  if (isF5) {
    const al = game.awayLine || [], hl = game.homeLine || [];
    // Require 5 recorded innings per side; otherwise the F5 result isn't settled yet.
    if (al.length < 5 || hl.length < 5) return 'pending';
    awayScore = al.slice(0, 5).reduce((s, v) => s + v, 0);
    homeScore = hl.slice(0, 5).reduce((s, v) => s + v, 0);
  }

  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/\bF5\b/gi, '').replace(/first 5( innings)?/gi, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
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

function gradeParlay(pickResults) {
  if (pickResults.length < 3) return { result: 'skip', profit: 0 };
  const results = pickResults.map(p => p.result);
  const anyLoss = results.includes('loss');
  const anyPending = results.includes('pending');
  const allWin = results.every(r => r === 'win');
  const parlayRisk = 75;
  if (anyLoss) return { result: 'loss', profit: -parlayRisk };
  if (anyPending) return { result: 'pending', profit: 0 };
  if (allWin) return { result: 'win', profit: calcParlayWinnings(parlayRisk, pickResults.map(p => p.odds)) };
  const nonPushLegs = pickResults.filter(p => p.result !== 'push');
  if (nonPushLegs.length === 0) return { result: 'push', profit: 0 };
  const allNonPushWin = nonPushLegs.every(p => p.result === 'win');
  if (allNonPushWin) return { result: 'win', profit: calcParlayWinnings(parlayRisk, nonPushLegs.map(p => p.odds)) };
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

  const apiParlay = (picksData.parlayLegs && picksData.parlayLegs.length > 0) ? picksData.parlayLegs[0] : null;
  const optimizedLegs = (apiParlay && apiParlay.legs) ? apiParlay.legs : null;

  const sports = [...new Set([
    ...picks.map(p => p.sport),
    ...(optimizedLegs ? optimizedLegs.map(l => l.sport) : []),
  ].filter(Boolean))];

  const sportResults = await Promise.all(sports.map(async sport => {
    const games = await fetchESPNScores(dateISO, sport);
    games.forEach(g => { g._sport = sport; });
    return games;
  }));
  const scoresByGames = sportResults.flat();

  const dollarPerUnit = 150;
  let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
  let dayWagered = 0, dayProfit = 0;
  const gradedPicks = [];

  for (const pick of picks) {
    const sportGames = scoresByGames.filter(g => g._sport === pick.sport);
    const game = findGame(pick, sportGames);
    const result = gradePick(pick, game);
    const units = parseFloat(pick.units) || 1;
    const risk = units * dollarPerUnit;
    const winAmount = calcWinnings(risk, pick.odds || '-110');
    let profit = 0;
    if (result === 'win') { dayWins++; profit = winAmount; }
    else if (result === 'loss') { dayLosses++; profit = -risk; }
    else if (result === 'push') { dayPushes++; profit = 0; }
    else { dayPending++; }
    if (result !== 'pending') { dayWagered += risk; dayProfit += profit; }
    gradedPicks.push({ sport: pick.sport, matchup: pick.matchup, pick: pick.pick, odds: pick.odds, units: pick.units, rating: pick.rating, result, profit: Math.round(profit), score: game && game.state === 'post' ? `${game.awayScore}-${game.homeScore}` : null });
  }

  let parlayInput;
  if (optimizedLegs) {
    parlayInput = optimizedLegs.map(leg => {
      const sportGames = scoresByGames.filter(g => g._sport === leg.sport);
      const game = findGame(leg, sportGames);
      return { result: gradePick(leg, game), odds: leg.odds || '-110' };
    });
  } else {
    parlayInput = gradedPicks.map(gp => ({ result: gp.result, odds: gp.odds || '-110' }));
  }
  const parlayResult = gradeParlay(parlayInput);
  const parlayRisk = 75;
  if (parlayResult.result !== 'pending' && parlayResult.result !== 'skip') {
    dayWagered += parlayRisk;
    dayProfit += parlayResult.profit;
  }
  if (parlayResult.result !== 'skip') {
    const parlayLegsSource = optimizedLegs || picks;
    gradedPicks.push({ sport: 'PARLAY', matchup: parlayLegsSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '), pick: optimizedLegs ? '3-Team Parlay (Optimized)' : '3-Team Parlay', odds: '', units: '0.5u', rating: 'P', result: parlayResult.result, profit: Math.round(parlayResult.profit), score: null });
  }

  const decided = dayWins + dayLosses;
  return {
    date: dateISO,
    dateFormatted: picksData.dateFormatted || dateISO,
    source: picksData._source || 'alpha',
    noPlays: false,
    picks: gradedPicks,
    wins: dayWins, losses: dayLosses, pushes: dayPushes, pending: dayPending,
    accuracy: decided > 0 ? ((dayWins / decided) * 100).toFixed(0) : '0',
    wagered: Math.round(dayWagered), profit: Math.round(dayProfit),
    roi: dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '--',
    parlayResult: parlayResult.result, parlayProfit: Math.round(parlayResult.profit),
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
    const alphaStoreUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-alpha`;
    const betaStoreUrl  = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-beta`;

    // Check cache (5-min TTL, v2 key to bust stale cache)
    try {
      const cacheResp = await fetch(`${alphaStoreUrl}/results-alpha-cache-v5`, { headers: authHeaders });
      if (cacheResp.ok) {
        const cached = await cacheResp.json();
        if (Date.now() - (cached.cachedAt || 0) < 300000) {
          return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(cached) };
        }
      }
    } catch (e) {}

    // Get dates from both stores in parallel
    const [alphaDates, betaDates] = await Promise.all([
      getDatesFromStore(alphaStoreUrl, authHeaders),
      getDatesFromStore(betaStoreUrl, authHeaders),
    ]);

    const alphaDateSet = new Set(alphaDates);
    const minAlphaDate = alphaDates.length > 0 ? [...alphaDates].sort()[0] : null;

    // Beta dates strictly before earliest alpha date
    const betaDatesToInclude = minAlphaDate
      ? betaDates.filter(d => d < minAlphaDate)
      : betaDates;
    const betaDateSet = new Set(betaDatesToInclude);

    // Build lookup: date → {store, url}
    const picksLookup = new Map([
      ...alphaDates.map(d => [d, { store: 'alpha', url: alphaStoreUrl }]),
      ...betaDatesToInclude.map(d => [d, { store: 'beta', url: betaStoreUrl }]),
    ]);

    if (picksLookup.size === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ days: [], cumulative: { wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 }, straight: { wins: 0, losses: 0, accuracy: '0%' }, parlay: { wins: 0, losses: 0, accuracy: '0%' } }) };
    }

    // Enumerate every calendar date from earliest to today (ET)
    const allDates = [...picksLookup.keys()].sort();
    const earliestDate = allDates[0];
    const todayET = getEasternDateToday();
    const fullDateRange = getAllDatesInRange(earliestDate, todayET);

    const days = [];
    let cumWins = 0, cumLosses = 0, cumPushes = 0, cumPending = 0;
    let cumWagered = 0, cumProfit = 0;
    let straightWins = 0, straightLosses = 0, straightWagered = 0, straightProfit = 0;
    let parlayWins = 0, parlayLosses = 0, parlayWagered = 0, parlayProfit = 0;

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

    for (const day of gradedByDate) {
      if (!day) continue;
      cumWins += day.wins; cumLosses += day.losses; cumPushes += day.pushes; cumPending += day.pending;
      cumWagered += day.wagered; cumProfit += day.profit;

      // Straight pick KPIs (exclude parlay row)
      for (const p of day.picks.filter(p => p.sport !== 'PARLAY' && p.result !== 'pending')) {
        const risk = (parseFloat(p.units) || 1) * 150;
        straightWagered += risk;
        straightProfit += p.profit;
        if (p.result === 'win') straightWins++;
        else if (p.result === 'loss') straightLosses++;
      }

      if (day.parlayResult && day.parlayResult !== 'skip' && day.parlayResult !== 'pending') {
        parlayWagered += 75; parlayProfit += day.parlayProfit;
        if (day.parlayResult === 'win') parlayWins++;
        else if (day.parlayResult === 'loss') parlayLosses++;
      }

      days.push(day);
    }

    const cumDecided = cumWins + cumLosses;
    const straightDecided = straightWins + straightLosses;
    const parlayDecided = parlayWins + parlayLosses;

    const result = {
      days: days.reverse(), // newest first for display
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
      await fetch(`${alphaStoreUrl}/results-alpha-cache-v5`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) {}

    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(result) };

  } catch (err) {
    console.error('[get-results-alpha] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to compute results' }) };
  }
};
