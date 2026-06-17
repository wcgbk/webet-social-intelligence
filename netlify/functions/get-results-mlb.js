// get-results-mlb.js
// API endpoint: GET /.netlify/functions/get-results-mlb
// Returns MLB F5 historical picks graded against ESPN final scores.
// Reads from "edge-picks-mlb" blob store. Live P/L starts from START_DATE (reset 2026-05-31);
// pre-cutoff pick blobs are retained in the store for backend/historical use.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function fetchESPNScores(dateISO) {
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`;
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

      // F5 score from inning-by-inning linescores (first 5 innings)
      const awayLS = away.linescores || [];
      const homeLS = home.linescores || [];
      const awayF5 = awayLS.slice(0, 5).reduce((s, inn) => s + (parseFloat(inn.value) || 0), 0);
      const homeF5 = homeLS.slice(0, 5).reduce((s, inn) => s + (parseFloat(inn.value) || 0), 0);
      // Game must have completed at least 5 innings for F5 grading
      const f5Complete = awayLS.length >= 5 && homeLS.length >= 5;

      return {
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        awayF5: awayF5,
        homeF5: homeF5,
        f5Complete,
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
  // Fallback: strip F5 prefix from pick name and try matching
  const pickTeam = (pick.pick || '').replace(/F5\s*/i, '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
  if (pickTeam) {
    for (const g of games) {
      if (teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) || teamsMatch(pickTeam, g.homeTeam, g.homeAbbr)) {
        return g;
      }
    }
  }
  return null;
}

function gradePick(pick, game) {
  if (!game) return 'pending';
  // F5 bets settle after 5 innings — grade as soon as 5 innings are complete
  if (!game.f5Complete) return 'pending';

  const pickStr = (pick.pick || '').trim();
  const awayScore = game.awayF5;
  const homeScore = game.homeF5;
  const pickTeamRaw = pickStr.replace(/F5\s*/i, '').replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam, game.awayAbbr);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam, game.homeAbbr);

  // Total (Over/Under)
  if (/over|under/i.test(pickStr)) {
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

  // Run Line (spread)
  if (/[+-]\d+(\.\d+)?/.test(pickStr)) {
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

  return 'pending';
}

function calcWinnings(atRisk, oddsStr) {
  const odds = parseInt((oddsStr || '').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds) || !atRisk) return 0;
  if (odds > 0) return atRisk * (odds / 100);
  return atRisk * (100 / Math.abs(odds));
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

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mlb`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Get all pick dates
    let dates = [];
    try {
      const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
      if (datesResp.ok) {
        dates = await datesResp.json();
      }
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

    if (dates.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          days: [],
          cumulative: { wins: 0, losses: 0, pushes: 0, pending: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 },
          straight: { wins: 0, losses: 0, accuracy: '0%', totalProfit: 0 },
        }),
      };
    }

    // Live-page reset: only aggregate picks from this date forward.
    // Historical pick blobs (pre-cutoff) remain intact in edge-picks-mlb for backend use.
    const START_DATE = '2026-06-01';
    const liveDates = dates.filter(d => d >= START_DATE);
    const recentDates = liveDates.slice(-30);
    const dollarPerUnit = 150;
    const days = [];
    let cumWins = 0, cumLosses = 0, cumPushes = 0, cumPending = 0;
    let cumWagered = 0, cumProfit = 0;

    for (const dateISO of recentDates) {
      let picksData;
      try {
        const picksResp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: authHeaders });
        if (!picksResp.ok) continue;
        picksData = await picksResp.json();
      } catch (e) { continue; }

      const picks = picksData.picks || [];
      if (picks.length === 0) continue;

      // Get ESPN scores for this date
      const games = await fetchESPNScores(dateISO);

      let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
      let dayProfit = 0, dayWagered = 0;
      const dayPicks = [];

      for (const pick of picks) {
        const game = findGame(pick, games);
        const result = gradePick(pick, game);
        const units = parseFloat(pick.units) || 1;
        const risk = units * dollarPerUnit;
        dayWagered += risk;

        let profit = 0;
        if (result === 'win') {
          profit = calcWinnings(risk, pick.odds || '-110');
          dayWins++;
        } else if (result === 'loss') {
          profit = -risk;
          dayLosses++;
        } else if (result === 'push') {
          dayPushes++;
        } else {
          dayPending++;
        }
        dayProfit += profit;

        dayPicks.push({
          pick: pick.pick,
          matchup: pick.matchup,
          odds: pick.odds,
          units: pick.units,
          result,
          profit: Math.round(profit),
          score: game && game.f5Complete ? `${game.awayF5}-${game.homeF5} (F5)` : null,
        });
      }

      cumWins += dayWins;
      cumLosses += dayLosses;
      cumPushes += dayPushes;
      cumPending += dayPending;
      cumWagered += dayWagered;
      cumProfit += dayProfit;

      const decided = dayWins + dayLosses;
      days.push({
        date: dateISO,
        wins: dayWins,
        losses: dayLosses,
        pushes: dayPushes,
        pending: dayPending,
        accuracy: decided > 0 ? Math.round((dayWins / decided) * 100) : 0,
        profit: Math.round(dayProfit),
        wagered: Math.round(dayWagered),
        roi: dayWagered > 0 ? (dayProfit / dayWagered * 100).toFixed(1) : null,
        picks: dayPicks,
      });
    }

    days.reverse(); // Most recent first

    const totalDecided = cumWins + cumLosses;
    const accuracy = totalDecided > 0 ? Math.round((cumWins / totalDecided) * 100) + '%' : '0%';
    const roi = cumWagered > 0 ? (cumProfit / cumWagered * 100).toFixed(1) + '%' : '0%';

    const result = {
      days,
      cumulative: {
        wins: cumWins,
        losses: cumLosses,
        pushes: cumPushes,
        pending: cumPending,
        accuracy,
        roi,
        totalWagered: Math.round(cumWagered),
        totalProfit: Math.round(cumProfit),
      },
      straight: {
        wins: cumWins,
        losses: cumLosses,
        accuracy,
        totalProfit: Math.round(cumProfit),
      },
    };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[get-results-mlb] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Failed to fetch MLB results' }),
    };
  }
};
