// get-results.js
// API endpoint: GET /.netlify/functions/get-results
// Returns historical picks graded against ESPN final scores.
// Fetches all pick dates from Blobs, loads each day's picks, checks ESPN for final scores.

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

// Fetch ESPN scores for a specific date and sport
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
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        state: status.type?.state || 'pre',
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Team name matching
function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function teamsMatch(pickTeam, espnTeam, espnAbbr) {
  const p = normalizeTeam(pickTeam);
  const e = normalizeTeam(espnTeam);
  if (!p || !e) return false;
  if (p === e) return true;
  if (p.includes(e) || e.includes(p)) return true;
  // Abbreviation match: exact word-token only (no substring — "ORL" in "orleans" is a false positive)
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
  // Split matchup into team parts (e.g., "Detroit @ Washington" -> ["Detroit", "Washington"])
  const matchupParts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);

  for (const g of games) {
    // Check if any matchup part matches each team
    const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
    const awayMatch = matchupParts.some(part => teamsMatch(part, g.awayTeam, g.awayAbbr)) ||
                       (awayLast.length > 3 && matchup.includes(awayLast));
    const homeMatch = matchupParts.some(part => teamsMatch(part, g.homeTeam, g.homeAbbr)) ||
                       (homeLast.length > 3 && matchup.includes(homeLast));
    if (awayMatch && homeMatch) return g;
  }
  // Fallback: match by pick team name
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
  // Last resort: match on both team last-words from matchup parts
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

// Grade a pick against a game result
function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';

  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  const awayScore = game.awayScore;
  const homeScore = game.homeScore;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/\b(Over|Under)\b/gi, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam, game.awayAbbr);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam, game.homeAbbr);

  // Total (Over/Under)
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

  // Spread / Puck Line
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

  // Moneyline
  if (pickedAway || pickedHome) {
    const pickedScore = pickedAway ? awayScore : homeScore;
    const oppScore = pickedAway ? homeScore : awayScore;
    if (pickedScore === oppScore) return 'push';
    return pickedScore > oppScore ? 'win' : 'loss';
  }

  // Draw
  if (/draw/i.test(pickStr)) {
    return awayScore === homeScore ? 'win' : 'loss';
  }

  return 'pending';
}

// Calculate winnings from American odds
function calcWinnings(atRisk, oddsStr) {
  const odds = parseInt((oddsStr || '').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds) || !atRisk) return 0;
  if (odds > 0) return atRisk * (odds / 100);
  return atRisk * (100 / Math.abs(odds));
}

// Parlay helpers
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
  // pickResults = array of { result: 'win'|'loss'|'push'|'pending', odds: string }
  if (pickResults.length < 3) return { result: 'skip', profit: 0 };

  const results = pickResults.map(p => p.result);
  const anyLoss = results.includes('loss');
  const anyPending = results.includes('pending');
  const allWin = results.every(r => r === 'win');

  const parlayRisk = 75; // 0.5u * $150

  if (anyLoss) return { result: 'loss', profit: -parlayRisk };
  if (anyPending) return { result: 'pending', profit: 0 };
  if (allWin) {
    const legsOdds = pickResults.map(p => p.odds);
    return { result: 'win', profit: calcParlayWinnings(parlayRisk, legsOdds) };
  }
  // All decided, no losses — has pushes
  const nonPushLegs = pickResults.filter(p => p.result !== 'push');
  if (nonPushLegs.length === 0) return { result: 'push', profit: 0 };
  // Reduced parlay: only count non-push legs
  const legsOdds = nonPushLegs.map(p => p.odds);
  const allNonPushWin = nonPushLegs.every(p => p.result === 'win');
  if (allNonPushWin) {
    return { result: 'win', profit: calcParlayWinnings(parlayRisk, legsOdds) };
  }
  return { result: 'pending', profit: 0 };
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

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Check for cached results first (cache for 1 hour)
    let cachedResults = null;
    try {
      const cacheResp = await fetch(`${storeUrl}/results-cache`, { headers: authHeaders });
      if (cacheResp.ok) {
        cachedResults = await cacheResp.json();
        const cacheAge = Date.now() - (cachedResults.cachedAt || 0);
        if (cacheAge < 300000) { // 5 minutes
          return {
            statusCode: 200,
            headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
            body: JSON.stringify(cachedResults),
          };
        }
      }
    } catch (e) { /* no cache, compute fresh */ }

    // Get all pick dates
    let dates = [];
    try {
      const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
      if (datesResp.ok) {
        dates = await datesResp.json();
      }
    } catch (e) { /* empty */ }

    if (!Array.isArray(dates) || dates.length === 0) {
      // Fallback: try to find dates by checking latest-date
      try {
        const latestResp = await fetch(`${storeUrl}/latest-date`, { headers: authHeaders });
        if (latestResp.ok) {
          const latest = (await latestResp.text()).trim();
          if (latest) dates = [latest];
        }
      } catch (e) { /* nothing */ }
    }

    if (dates.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ days: [], cumulative: { wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 } }),
      };
    }

    // Fetch picks for all dates (full all-time history)
    const recentDates = dates;
    const dollarPerUnit = 150;
    const days = [];
    let cumWins = 0, cumLosses = 0, cumPushes = 0, cumPending = 0;
    let cumWagered = 0, cumProfit = 0;
    // Separate straight vs parlay tracking
    let straightWins = 0, straightLosses = 0, straightWagered = 0, straightProfit = 0;
    let parlayWins = 0, parlayLosses = 0, parlayWagered = 0, parlayProfit = 0;

    for (const dateISO of recentDates) {
      let picksData;
      try {
        const picksResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: authHeaders });
        if (!picksResp.ok) continue;
        picksData = await picksResp.json();
      } catch (e) { continue; }

      const picks = (picksData.picks || []).slice(0, 3); // Top 3 straight picks only
      if (picks.length === 0) continue;

      // Check for optimized parlay legs
      const apiParlay = (picksData.parlayLegs && picksData.parlayLegs.length > 0) ? picksData.parlayLegs[0] : null;
      const optimizedLegs = (apiParlay && apiParlay.legs && apiParlay.legs.length >= 3) ? apiParlay.legs : null;

      // Collect all sports needed (straight picks + any parlay-only legs)
      const sports = [...new Set([
        ...picks.map(p => p.sport),
        ...(optimizedLegs ? optimizedLegs.map(l => l.sport) : []),
      ].filter(Boolean))];

      // Fetch ESPN scores for each sport in parallel
      const sportResults = await Promise.all(sports.map(async sport => {
        const games = await fetchESPNScores(dateISO, sport);
        games.forEach(g => { g._sport = sport; });
        return games;
      }));
      const scoresByGames = sportResults.flat();

      // Grade each pick
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

        if (result !== 'pending') {
          dayWagered += risk;
          dayProfit += profit;
          straightWagered += risk;
          straightProfit += profit;
          if (result === 'win') straightWins++;
          else if (result === 'loss') straightLosses++;
        }

        gradedPicks.push({
          sport: pick.sport,
          matchup: pick.matchup,
          pick: pick.pick,
          odds: pick.odds,
          units: pick.units,
          rating: pick.rating,
          result,
          profit: Math.round(profit),
          score: game && game.state === 'post' ? `${game.awayScore}-${game.homeScore}` : null,
        });
      }

      // Grade parlay using optimized legs if available, otherwise straight picks
      let parlayInput;
      if (optimizedLegs) {
        parlayInput = optimizedLegs.map(leg => {
          const sportGames = scoresByGames.filter(g => g._sport === leg.sport);
          const game = findGame(leg, sportGames);
          const result = gradePick(leg, game);
          return { result, odds: leg.odds || '-110' };
        });
      } else {
        parlayInput = gradedPicks.map(gp => ({ result: gp.result, odds: gp.odds || '-110' }));
      }
      const parlayResult = gradeParlay(parlayInput);
      const parlayRisk = 75; // 0.5u * $150

      // Parlay does NOT count in record/accuracy — only in P/L and ROI
      if (parlayResult.result === 'win') { parlayWins++; }
      else if (parlayResult.result === 'loss') { parlayLosses++; }

      if (parlayResult.result !== 'pending' && parlayResult.result !== 'skip') {
        dayWagered += parlayRisk;
        dayProfit += parlayResult.profit;
        parlayWagered += parlayRisk;
        parlayProfit += parlayResult.profit;
      }

      cumWins += dayWins;
      cumLosses += dayLosses;
      cumPushes += dayPushes;
      cumPending += dayPending;
      cumWagered += dayWagered;
      cumProfit += dayProfit;

      const decided = dayWins + dayLosses;
      const dayAccuracy = decided > 0 ? ((dayWins / decided) * 100).toFixed(0) : '--';
      const dayROI = dayWagered > 0 ? ((dayProfit / dayWagered) * 100).toFixed(1) : '--';

      // Add parlay to graded picks list for display
      if (parlayResult.result !== 'skip') {
        const parlayLegsSource = optimizedLegs || picks;
        gradedPicks.push({
          sport: 'PARLAY',
          matchup: parlayLegsSource.map(p => (p.pick || '').split(/\s/)[0]).join(' / '),
          pick: optimizedLegs ? '3-Team Parlay (Optimized)' : '3-Team Parlay',
          odds: '',
          units: '0.5u',
          rating: 'P',
          result: parlayResult.result,
          profit: Math.round(parlayResult.profit),
          score: null,
        });
      }

      days.push({
        date: dateISO,
        dateFormatted: picksData.dateFormatted || dateISO,
        picks: gradedPicks,
        wins: dayWins,
        losses: dayLosses,
        pushes: dayPushes,
        pending: dayPending,
        accuracy: dayAccuracy,
        wagered: Math.round(dayWagered),
        profit: Math.round(dayProfit),
        roi: dayROI,
      });
    }

    const cumDecided = cumWins + cumLosses;
    const cumAccuracy = cumDecided > 0 ? ((cumWins / cumDecided) * 100).toFixed(1) : '0';
    const cumROI = cumWagered > 0 ? ((cumProfit / cumWagered) * 100).toFixed(1) : '0';

    const straightDecided = straightWins + straightLosses;
    const straightAccuracy = straightDecided > 0 ? ((straightWins / straightDecided) * 100).toFixed(1) : '0';
    const straightROI = straightWagered > 0 ? ((straightProfit / straightWagered) * 100).toFixed(1) : '0';
    const parlayDecided = parlayWins + parlayLosses;
    const parlayAccuracy = parlayDecided > 0 ? ((parlayWins / parlayDecided) * 100).toFixed(1) : '0';
    const parlayROI = parlayWagered > 0 ? ((parlayProfit / parlayWagered) * 100).toFixed(1) : '0';

    const result = {
      days: days.reverse(), // most recent first
      cumulative: {
        wins: cumWins,
        losses: cumLosses,
        pushes: cumPushes,
        pending: cumPending,
        accuracy: cumAccuracy + '%',
        roi: cumROI + '%',
        totalWagered: Math.round(cumWagered),
        totalProfit: Math.round(cumProfit),
      },
      straight: {
        wins: straightWins,
        losses: straightLosses,
        accuracy: straightAccuracy + '%',
        roi: straightROI + '%',
        totalWagered: Math.round(straightWagered),
        totalProfit: Math.round(straightProfit),
      },
      parlay: {
        wins: parlayWins,
        losses: parlayLosses,
        accuracy: parlayAccuracy + '%',
        roi: parlayROI + '%',
        totalWagered: Math.round(parlayWagered),
        totalProfit: Math.round(parlayProfit),
      },
      cachedAt: Date.now(),
    };

    // Cache the results
    try {
      await fetch(`${storeUrl}/results-cache`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) { /* cache write failed, not critical */ }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('[get-results] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Failed to compute results' }),
    };
  }
};
