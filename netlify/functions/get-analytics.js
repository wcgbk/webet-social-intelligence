// get-analytics.js
// API endpoint: GET /.netlify/functions/get-analytics
// Returns comprehensive performance analytics broken down by sport, rating, market type,
// confidence band, day of week, streaks, CLV, parlay performance, and Kelly sizing.
// Cached for 2 hours in Blobs.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const ESPN_ENDPOINTS = {
  'NBA': 'basketball/nba',
  'NHL': 'hockey/nhl',
  'NCAAB': 'basketball/mens-college-basketball',
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

// ── ESPN + Grading (same as get-results.js) ────────────────────────────────

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
        statusName: status.type?.name || '',
        completed: !!status.type?.completed,
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
  const a = normalizeTeam(espnAbbr);
  if (!p || !e) return false;
  if (p === e) return true;
  if (p.includes(e) || e.includes(p)) return true;
  if (a && p.includes(a)) return true;
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
  const pickTeam = (pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
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
  // Postponed / canceled / suspended games are voided (no action) — stake returned, grade as push.
  // Matches the settlement void set in track-clv + get-results-alpha so analytics never counts a
  // voided game as a phantom win/loss off its 0-0/partial final. Catch BEFORE score-based grading.
  if (/POSTPONED|CANCELL?ED|SUSPENDED/i.test(game.statusName || '') || (game.state === 'post' && !game.completed)) return 'push';
  const pickStr = (pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  const awayScore = game.awayScore;
  const homeScore = game.homeScore;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
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

  if (/draw/i.test(pickStr)) {
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

function gradeParlay(pickResults) {
  if (pickResults.length < 3) return { result: 'skip', profit: 0 };
  const results = pickResults.map(p => p.result);
  const anyLoss = results.includes('loss');
  const anyPending = results.includes('pending');
  const allWin = results.every(r => r === 'win');
  const parlayRisk = 75;

  if (anyLoss) return { result: 'loss', profit: -parlayRisk };
  if (anyPending) return { result: 'pending', profit: 0 };
  if (allWin) {
    const legsOdds = pickResults.map(p => p.odds);
    return { result: 'win', profit: calcParlayWinnings(parlayRisk, legsOdds) };
  }
  const nonPushLegs = pickResults.filter(p => p.result !== 'push');
  if (nonPushLegs.length === 0) return { result: 'push', profit: 0 };
  const legsOdds = nonPushLegs.map(p => p.odds);
  const allNonPushWin = nonPushLegs.every(p => p.result === 'win');
  if (allNonPushWin) {
    return { result: 'win', profit: calcParlayWinnings(parlayRisk, legsOdds) };
  }
  return { result: 'pending', profit: 0 };
}

// ── Analytics Helpers ───────────────────────────────────────────────────────

function americanToDecimal(oddsStr) {
  const odds = parseInt((oddsStr || '-110').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds)) return 1.909;
  return odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
}

function parseProbability(probStr) {
  if (!probStr) return null;
  const num = parseFloat(String(probStr).replace('%', ''));
  return isNaN(num) ? null : num;
}

function classifyMarketType(pick) {
  const bt = (pick.betType || '').toLowerCase();
  if (bt === 'total' || /over|under/i.test(pick.pick || '')) return 'Total';
  if (bt === 'puck line') return 'Puck Line';
  if (bt === 'spread') return 'Spread';
  if (bt === 'ml' || bt === 'moneyline') return 'ML';
  if (bt === 'draw') return 'Draw';
  if (bt === 'btts') return 'BTTS';
  if (bt === 'sgp') return 'SGP';
  if (bt === 'asian handicap') return 'Asian Handicap';
  // Infer from pick string
  const ps = (pick.pick || '');
  if (/over|under/i.test(ps)) return 'Total';
  if (/[+-]\d+(\.\d+)?/.test(ps)) return 'Spread';
  if (/ML$/i.test(ps)) return 'ML';
  return 'ML'; // default
}

function confidenceBand(prob) {
  if (prob === null) return 'Unknown';
  if (prob >= 80) return '80%+';
  if (prob >= 70) return '70-79%';
  if (prob >= 60) return '60-69%';
  return '<60%';
}

function dayOfWeek(dateISO) {
  const d = new Date(dateISO + 'T12:00:00Z');
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
}

// Accumulator helper
function addToBucket(map, key, result, profit, wagered) {
  if (!map[key]) map[key] = { wins: 0, losses: 0, pushes: 0, pending: 0, profit: 0, wagered: 0, count: 0 };
  const b = map[key];
  b.count++;
  if (result === 'win') b.wins++;
  else if (result === 'loss') b.losses++;
  else if (result === 'push') b.pushes++;
  else b.pending++;
  if (result !== 'pending') {
    b.wagered += wagered;
    b.profit += profit;
  }
}

function finalizeBucket(b) {
  const decided = b.wins + b.losses;
  return {
    picks: b.count,
    wins: b.wins,
    losses: b.losses,
    pushes: b.pushes,
    pending: b.pending,
    winRate: decided > 0 ? parseFloat(((b.wins / decided) * 100).toFixed(1)) : null,
    roi: b.wagered > 0 ? parseFloat(((b.profit / b.wagered) * 100).toFixed(1)) : null,
    profit: Math.round(b.profit),
    wagered: Math.round(b.wagered),
  };
}

// Kelly criterion: f* = (bp - q) / b
// b = decimal odds - 1 (net payout per dollar), p = win rate, q = 1 - p
function kellyFraction(winRate, avgDecimalOdds) {
  if (!winRate || winRate <= 0 || !avgDecimalOdds || avgDecimalOdds <= 1) return null;
  const p = winRate / 100;
  const q = 1 - p;
  const b = avgDecimalOdds - 1;
  const kelly = (b * p - q) / b;
  return parseFloat(kelly.toFixed(4));
}

// ── Main Handler ────────────────────────────────────────────────────────────

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

    // ── Check analytics cache (2 hours) ─────────────────────────────────
    try {
      const cacheResp = await fetch(`${storeUrl}/analytics-cache`, { headers: authHeaders });
      if (cacheResp.ok) {
        const cached = await cacheResp.json();
        const cacheAge = Date.now() - (cached.cachedAt || 0);
        if (cacheAge < 7200000) { // 2 hours
          return {
            statusCode: 200,
            headers: { ...CORS, 'Cache-Control': 'public, max-age=600' },
            body: JSON.stringify(cached),
          };
        }
      }
    } catch (e) { /* no cache */ }

    // ── Load all pick dates ─────────────────────────────────────────────
    let dates = [];
    try {
      const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
      if (datesResp.ok) dates = await datesResp.json();
    } catch (e) { /* empty */ }

    if (!Array.isArray(dates) || dates.length === 0) {
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
        body: JSON.stringify({ error: false, message: 'No pick data available', analytics: null }),
      };
    }

    // ── Process all dates ───────────────────────────────────────────────
    const dollarPerUnit = 150;
    const parlayRisk = 75;

    // Dimension buckets
    const bySport = {};
    const byRating = {};
    const byMarket = {};
    const byConfidence = {};
    const byDay = {};

    // For Kelly: track decimal odds per rating tier
    const ratingOdds = {}; // rating -> [decimalOdds]

    // Streak tracking (chronological order)
    const allResults = []; // { date, result, pick }

    // Parlay tracking
    const parlayBucket = { wins: 0, losses: 0, pushes: 0, pending: 0, profit: 0, wagered: 0, count: 0 };

    // CLV aggregation
    let clvSum = 0;
    let clvCount = 0;
    let clvBeatingCount = 0;
    let clvTotal = 0;

    // Overall
    let totalWins = 0, totalLosses = 0, totalPushes = 0, totalPending = 0;
    let totalWagered = 0, totalProfit = 0;

    const recentDates = dates.slice(-60); // last 60 days for richer analytics

    for (const dateISO of recentDates) {
      let picksData;
      try {
        const picksResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: authHeaders });
        if (!picksResp.ok) continue;
        picksData = await picksResp.json();
      } catch (e) { continue; }

      const picks = (picksData.picks || []).slice(0, 3);
      if (picks.length === 0) continue;

      // Try loading CLV data for this date
      let clvData = null;
      try {
        const clvResp = await fetch(`${storeUrl}/clv-${dateISO}`, { headers: authHeaders });
        if (clvResp.ok) clvData = await clvResp.json();
      } catch (e) { /* no CLV data */ }

      // Fetch ESPN scores
      const sports = [...new Set(picks.map(p => p.sport).filter(Boolean))];
      const scoresByGames = [];
      for (const sport of sports) {
        const games = await fetchESPNScores(dateISO, sport);
        for (const g of games) { g._sport = sport; scoresByGames.push(g); }
      }

      const dayName = dayOfWeek(dateISO);
      const parlayLegs = [];

      for (let i = 0; i < picks.length; i++) {
        const pick = picks[i];
        const sportGames = scoresByGames.filter(g => g._sport === pick.sport);
        const game = findGame(pick, sportGames);
        const result = gradePick(pick, game);

        const units = parseFloat(pick.units) || 1;
        const risk = units * dollarPerUnit;
        const winAmount = calcWinnings(risk, pick.odds || '-110');

        let profit = 0;
        if (result === 'win') { profit = winAmount; totalWins++; }
        else if (result === 'loss') { profit = -risk; totalLosses++; }
        else if (result === 'push') { totalPushes++; }
        else { totalPending++; }

        if (result !== 'pending') {
          totalWagered += risk;
          totalProfit += profit;
        }

        // Straight pick dimensions (exclude pending from decided stats but include in counts)
        const sport = pick.sport || 'Unknown';
        const rating = pick.rating || 'Unrated';
        const market = classifyMarketType(pick);
        const prob = parseProbability(pick.winProbability);
        const confBand = confidenceBand(prob);
        const decOdds = americanToDecimal(pick.odds);

        addToBucket(bySport, sport, result, profit, risk);
        addToBucket(byRating, rating, result, profit, risk);
        addToBucket(byMarket, market, result, profit, risk);
        addToBucket(byConfidence, confBand, result, profit, risk);
        addToBucket(byDay, dayName, result, profit, risk);

        // Track odds per rating for Kelly
        if (!ratingOdds[rating]) ratingOdds[rating] = [];
        ratingOdds[rating].push(decOdds);

        // Streak tracking
        if (result === 'win' || result === 'loss') {
          allResults.push({ date: dateISO, result, pick: pick.pick });
        }

        // Parlay leg
        parlayLegs.push({ result, odds: pick.odds || '-110' });

        // CLV
        if (clvData && Array.isArray(clvData.picks)) {
          const clvPick = clvData.picks[i];
          if (clvPick && typeof clvPick.clv === 'number') {
            clvSum += clvPick.clv;
            clvCount++;
            clvTotal++;
            if (clvPick.clv > 0) clvBeatingCount++;
          }
        }
      }

      // Grade parlay
      const parlayResult = gradeParlay(parlayLegs);
      if (parlayResult.result !== 'skip') {
        parlayBucket.count++;
        if (parlayResult.result === 'win') { parlayBucket.wins++; }
        else if (parlayResult.result === 'loss') { parlayBucket.losses++; }
        else if (parlayResult.result === 'push') { parlayBucket.pushes++; }
        else { parlayBucket.pending++; }

        if (parlayResult.result !== 'pending') {
          parlayBucket.wagered += parlayRisk;
          parlayBucket.profit += parlayResult.profit;
        }
      }
    }

    // ── Finalize all dimension buckets ──────────────────────────────────

    const sportAnalytics = {};
    for (const [k, v] of Object.entries(bySport)) {
      sportAnalytics[k] = finalizeBucket(v);
    }

    const ratingAnalytics = {};
    for (const [k, v] of Object.entries(byRating)) {
      const fin = finalizeBucket(v);
      // Kelly sizing
      const avgOdds = ratingOdds[k] && ratingOdds[k].length > 0
        ? ratingOdds[k].reduce((a, b) => a + b, 0) / ratingOdds[k].length
        : null;
      const kelly = fin.winRate !== null ? kellyFraction(fin.winRate, avgOdds) : null;
      // Map rating to typical unit sizing
      const typicalUnits = { 'A+': 2, 'A': 1.5, 'A-': 1.25, 'B+': 1, 'B': 0.75 };
      const currentUnits = typicalUnits[k] || 1;
      const kellyUnits = kelly !== null ? parseFloat((kelly * 10).toFixed(2)) : null; // Kelly as units (scaled: Kelly * bankroll / unit)
      fin.avgDecimalOdds = avgOdds ? parseFloat(avgOdds.toFixed(3)) : null;
      fin.kellyFraction = kelly;
      fin.kellyUnits = kellyUnits;
      fin.currentUnits = currentUnits;
      fin.kellySuggestion = kelly !== null
        ? (kelly <= 0 ? 'No edge — avoid'
          : kellyUnits > currentUnits * 1.3 ? 'Increase exposure'
          : kellyUnits < currentUnits * 0.7 ? 'Decrease exposure'
          : 'Sizing appropriate')
        : null;
      ratingAnalytics[k] = fin;
    }

    const marketAnalytics = {};
    for (const [k, v] of Object.entries(byMarket)) {
      marketAnalytics[k] = finalizeBucket(v);
    }

    const confidenceAnalytics = {};
    for (const [k, v] of Object.entries(byConfidence)) {
      confidenceAnalytics[k] = finalizeBucket(v);
    }

    const dayAnalytics = {};
    for (const [k, v] of Object.entries(byDay)) {
      dayAnalytics[k] = finalizeBucket(v);
    }

    // ── Streak Analysis ─────────────────────────────────────────────────

    let currentStreak = { type: null, count: 0 };
    let longestWin = 0, longestLoss = 0;
    let tempWin = 0, tempLoss = 0;

    for (const r of allResults) {
      if (r.result === 'win') {
        tempWin++;
        tempLoss = 0;
        if (tempWin > longestWin) longestWin = tempWin;
      } else {
        tempLoss++;
        tempWin = 0;
        if (tempLoss > longestLoss) longestLoss = tempLoss;
      }
    }

    // Current streak from end
    if (allResults.length > 0) {
      const lastResult = allResults[allResults.length - 1].result;
      let streakCount = 0;
      for (let i = allResults.length - 1; i >= 0; i--) {
        if (allResults[i].result === lastResult) streakCount++;
        else break;
      }
      currentStreak = { type: lastResult, count: streakCount };
    }

    // ── CLV Summary ─────────────────────────────────────────────────────

    const clvSummary = clvCount > 0
      ? {
          avgCLV: parseFloat((clvSum / clvCount).toFixed(2)),
          beatingClosingLine: parseFloat(((clvBeatingCount / clvTotal) * 100).toFixed(1)),
          sampleSize: clvCount,
        }
      : { avgCLV: null, beatingClosingLine: null, sampleSize: 0, note: 'No CLV data available in blobs' };

    // ── Parlay Performance ──────────────────────────────────────────────

    const parlayDecided = parlayBucket.wins + parlayBucket.losses;
    const parlayPerformance = {
      record: `${parlayBucket.wins}-${parlayBucket.losses}${parlayBucket.pushes > 0 ? '-' + parlayBucket.pushes : ''}`,
      pending: parlayBucket.pending,
      winRate: parlayDecided > 0 ? parseFloat(((parlayBucket.wins / parlayDecided) * 100).toFixed(1)) : null,
      roi: parlayBucket.wagered > 0 ? parseFloat(((parlayBucket.profit / parlayBucket.wagered) * 100).toFixed(1)) : null,
      profit: Math.round(parlayBucket.profit),
      wagered: Math.round(parlayBucket.wagered),
      totalParlays: parlayBucket.count,
    };

    // ── Recommended Adjustments ─────────────────────────────────────────

    const recommendations = [];

    // Sport recommendations
    for (const [sport, stats] of Object.entries(sportAnalytics)) {
      const decided = stats.wins + stats.losses;
      if (decided < 3) continue; // Need enough sample
      if (stats.winRate !== null && stats.roi !== null) {
        if (stats.winRate >= 60 && stats.roi > 5) {
          recommendations.push({ type: 'increase', dimension: 'sport', value: sport, reason: `${stats.winRate}% win rate, +${stats.roi}% ROI over ${decided} picks` });
        } else if (stats.winRate < 45 && stats.roi < -10) {
          recommendations.push({ type: 'decrease', dimension: 'sport', value: sport, reason: `${stats.winRate}% win rate, ${stats.roi}% ROI over ${decided} picks` });
        }
      }
    }

    // Market recommendations
    for (const [market, stats] of Object.entries(marketAnalytics)) {
      const decided = stats.wins + stats.losses;
      if (decided < 3) continue;
      if (stats.winRate !== null && stats.roi !== null) {
        if (stats.winRate >= 60 && stats.roi > 5) {
          recommendations.push({ type: 'increase', dimension: 'market', value: market, reason: `${stats.winRate}% win rate, +${stats.roi}% ROI over ${decided} picks` });
        } else if (stats.winRate < 45 && stats.roi < -10) {
          recommendations.push({ type: 'decrease', dimension: 'market', value: market, reason: `${stats.winRate}% win rate, ${stats.roi}% ROI over ${decided} picks` });
        }
      }
    }

    // Confidence band recommendations
    for (const [band, stats] of Object.entries(confidenceAnalytics)) {
      const decided = stats.wins + stats.losses;
      if (decided < 3 || band === 'Unknown') continue;
      if (stats.winRate !== null && stats.winRate < 50) {
        recommendations.push({ type: 'note', dimension: 'confidence', value: band, reason: `Model overconfident — stated ${band} confidence but only ${stats.winRate}% actual win rate` });
      }
    }

    // Rating tier edge check
    for (const [rating, stats] of Object.entries(ratingAnalytics)) {
      if (stats.kellyFraction !== null && stats.kellyFraction <= 0) {
        const decided = stats.wins + stats.losses;
        if (decided >= 3) {
          recommendations.push({ type: 'decrease', dimension: 'rating', value: rating, reason: `Kelly fraction ${stats.kellyFraction} — no statistical edge at current odds` });
        }
      }
    }

    if (recommendations.length === 0) {
      recommendations.push({ type: 'note', dimension: 'general', value: 'Insufficient data', reason: 'Need more graded picks to generate meaningful recommendations' });
    }

    // ── Overall ─────────────────────────────────────────────────────────

    const overallDecided = totalWins + totalLosses;
    const overall = {
      straightPicks: {
        wins: totalWins,
        losses: totalLosses,
        pushes: totalPushes,
        pending: totalPending,
        record: `${totalWins}-${totalLosses}${totalPushes > 0 ? '-' + totalPushes : ''}`,
        winRate: overallDecided > 0 ? parseFloat(((totalWins / overallDecided) * 100).toFixed(1)) : null,
        roi: totalWagered > 0 ? parseFloat(((totalProfit / totalWagered) * 100).toFixed(1)) : null,
        profit: Math.round(totalProfit),
        wagered: Math.round(totalWagered),
      },
      datesAnalyzed: recentDates.length,
    };

    // ── Assemble Response ───────────────────────────────────────────────

    const analytics = {
      overall,
      bySport: sportAnalytics,
      byRating: ratingAnalytics,
      byMarketType: marketAnalytics,
      byConfidenceBand: confidenceAnalytics,
      byDayOfWeek: dayAnalytics,
      streaks: {
        current: currentStreak,
        longestWin,
        longestLoss,
        totalDecidedPicks: allResults.length,
      },
      clv: clvSummary,
      parlays: parlayPerformance,
      recommendations,
      cachedAt: Date.now(),
      generatedAt: new Date().toISOString(),
    };

    // ── Cache the analytics ─────────────────────────────────────────────

    try {
      await fetch(`${storeUrl}/analytics-cache`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(analytics),
      });
    } catch (e) { /* cache write failed, not critical */ }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify(analytics),
    };

  } catch (err) {
    console.error('[get-analytics] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Failed to compute analytics' }),
    };
  }
};
