// get-results-fox.js
// API endpoint: GET /.netlify/functions/get-results-fox
// Returns FOX historical picks graded against ESPN final scores.
// Reads from "fox-picks" blob store (completely separate from edge-picks).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const ESPN_ENDPOINTS = {
  'NBA': 'basketball/nba', 'NHL': 'hockey/nhl', 'NCAAB': 'basketball/mens-college-basketball',
  'MLB': 'baseball/mlb', 'EPL': 'soccer/eng.1', 'La Liga': 'soccer/esp.1',
  'Serie A': 'soccer/ita.1', 'Bundesliga': 'soccer/ger.1', 'Ligue 1': 'soccer/fra.1',
  'MLS': 'soccer/usa.1', 'UCL': 'soccer/uefa.champions', 'Europa': 'soccer/uefa.europa',
};

async function fetchESPNScores(dateISO, sport) {
  const endpoint = ESPN_ENDPOINTS[sport];
  if (!endpoint) return [];
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard?dates=${dateISO.replace(/-/g, '')}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) return null;
      return {
        awayTeam: away.team?.displayName || '', awayAbbr: away.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeTeam: home.team?.displayName || '', homeAbbr: home.team?.abbreviation || '',
        homeScore: parseInt(home.score) || 0,
        state: (comp.status || ev.status || {}).type?.state || 'pre',
      };
    }).filter(Boolean);
  } catch (e) { return []; }
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function teamsMatch(pickTeam, espnTeam, espnAbbr) {
  const p = normalizeTeam(pickTeam), e = normalizeTeam(espnTeam);
  if (!p || !e) return false;
  if (p === e || p.includes(e) || e.includes(p)) return true;
  if (espnAbbr && espnAbbr.length >= 2) {
    if (p.split(' ').includes(espnAbbr.toLowerCase())) return true;
  }
  const pLast = p.split(' ').pop(), eLast = e.split(' ').pop();
  if (pLast.length > 2 && pLast === eLast) return true;
  return false;
}

function findGame(pick, games) {
  const matchup = (pick.matchup || '').toLowerCase();
  const parts = matchup.split(/\s+(?:@|vs\.?|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  for (const g of games) {
    const awayLast = normalizeTeam(g.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(g.homeTeam).split(' ').pop();
    const am = parts.some(p => teamsMatch(p, g.awayTeam, g.awayAbbr)) || (awayLast.length > 3 && matchup.includes(awayLast));
    const hm = parts.some(p => teamsMatch(p, g.homeTeam, g.homeAbbr)) || (homeLast.length > 3 && matchup.includes(homeLast));
    if (am && hm) return g;
  }
  const pickTeam = (pick.side || pick.pick || '').replace(/[+-]\d.*$/, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
  if (pickTeam) {
    for (const g of games) {
      if (teamsMatch(pickTeam, g.awayTeam, g.awayAbbr) || teamsMatch(pickTeam, g.homeTeam, g.homeAbbr)) return g;
    }
  }
  return null;
}

function gradePick(pick, game) {
  if (!game || game.state !== 'post') return 'pending';
  const pickStr = (pick.side || pick.pick || '').trim();
  const betType = (pick.betType || '').toLowerCase();
  const { awayScore, homeScore } = game;
  const pickTeamRaw = pickStr.replace(/[+-]\d+(\.\d+)?/g, '').replace(/ML$/i, '').replace(/Over|Under/i, '').trim();
  const pickedAway = teamsMatch(pickTeamRaw, game.awayTeam, game.awayAbbr);
  const pickedHome = teamsMatch(pickTeamRaw, game.homeTeam, game.homeAbbr);

  if (betType === 'total' || /over|under/i.test(pickStr)) {
    const total = awayScore + homeScore;
    const m = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (m) {
      const ou = m[1].toLowerCase(), line = parseFloat(m[2]);
      if (total === line) return 'push';
      return (ou === 'over' && total > line) || (ou === 'under' && total < line) ? 'win' : 'loss';
    }
  }

  if (betType === 'spread' || betType === 'puck line' || betType === 'run line' || /[+-]\d+(\.\d+)?/.test(pickStr)) {
    const sm = pickStr.match(/([+-]\d+(\.\d+)?)/);
    if (sm && (pickedAway || pickedHome)) {
      const spread = parseFloat(sm[1]);
      const ps = pickedAway ? awayScore : homeScore;
      const os = pickedAway ? homeScore : awayScore;
      const adj = ps + spread;
      if (adj === os) return 'push';
      return adj > os ? 'win' : 'loss';
    }
  }

  if (pickedAway || pickedHome) {
    const ps = pickedAway ? awayScore : homeScore;
    const os = pickedAway ? homeScore : awayScore;
    if (ps === os) return 'push';
    return ps > os ? 'win' : 'loss';
  }

  return 'pending';
}

function calcWinnings(risk, oddsStr) {
  const odds = parseInt((oddsStr || '').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds) || !risk) return 0;
  return odds > 0 ? risk * (odds / 100) : risk * (100 / Math.abs(odds));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: true, message: 'Not configured' }) };

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/fox-picks`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Check cache
    try {
      const cacheResp = await fetch(`${storeUrl}/results-cache`, { headers: authHeaders });
      if (cacheResp.ok) {
        const cached = await cacheResp.json();
        if (Date.now() - (cached.cachedAt || 0) < 300000) {
          return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(cached) };
        }
      }
    } catch (e) { /* compute fresh */ }

    // Get all pick dates from the dates index
    let dates = [];
    try {
      const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
      if (datesResp.ok) {
        const datesArr = await datesResp.json();
        if (Array.isArray(datesArr)) dates = datesArr.slice(-30); // last 30 days
      }
    } catch (e) { /* empty */ }

    // Fallback: use latest-date and work backwards
    if (dates.length === 0) {
      try {
        const latestResp = await fetch(`${storeUrl}/latest-date`, { headers: authHeaders });
        if (latestResp.ok) {
          const latest = (await latestResp.text()).trim();
          if (latest) {
            const d = new Date(latest + 'T12:00:00-05:00');
            for (let i = 0; i < 30; i++) {
              dates.push(d.toISOString().split('T')[0]);
              d.setDate(d.getDate() - 1);
            }
          }
        }
      } catch (e) { /* empty */ }
    }

    if (dates.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ days: [], cumulative: { wins: 0, losses: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 }, straight: { wins: 0, losses: 0, accuracy: '0%', roi: '0%', totalWagered: 0, totalProfit: 0 } }) };
    }

    const dollarPerUnit = 100; // Fox uses $100/unit
    const days = [];
    let cumWins = 0, cumLosses = 0, cumPushes = 0, cumPending = 0, cumWagered = 0, cumProfit = 0;

    for (const dateISO of dates) {
      let picksData;
      try {
        const resp = await fetch(`${storeUrl}/picks-${dateISO}`, { headers: authHeaders });
        if (!resp.ok) continue;
        picksData = await resp.json();
      } catch (e) { continue; }

      const picks = (picksData.picks || []).slice(0, 5);
      if (picks.length === 0) continue;

      const sports = [...new Set(picks.map(p => p.sport).filter(Boolean))];
      const allGames = [];
      for (const sport of sports) {
        const games = await fetchESPNScores(dateISO, sport);
        for (const g of games) { g._sport = sport; allGames.push(g); }
      }

      let dW = 0, dL = 0, dPu = 0, dPe = 0, dWag = 0, dProf = 0;
      const graded = [];

      for (const pick of picks) {
        const sportGames = allGames.filter(g => g._sport === pick.sport);
        const game = findGame(pick, sportGames);
        const result = gradePick(pick, game);
        const units = parseFloat(String(pick.units || '1').replace(/[^0-9.]/g, ''));
        const risk = units * dollarPerUnit;
        const winAmt = calcWinnings(risk, pick.odds || '-110');
        let profit = 0;
        if (result === 'win') { dW++; profit = winAmt; }
        else if (result === 'loss') { dL++; profit = -risk; }
        else if (result === 'push') { dPu++; }
        else { dPe++; }
        if (result !== 'pending') { dWag += risk; dProf += profit; }

        graded.push({
          sport: pick.sport, matchup: pick.matchup, pick: pick.side || pick.pick,
          odds: pick.odds, units: pick.units, rating: pick.rating,
          consensusLevel: pick.consensusLevel, result, profit: Math.round(profit),
          score: game && game.state === 'post' ? `${game.awayScore}-${game.homeScore}` : null,
        });
      }

      cumWins += dW; cumLosses += dL; cumPushes += dPu; cumPending += dPe;
      cumWagered += dWag; cumProfit += dProf;

      const decided = dW + dL;
      days.push({
        date: dateISO, dateFormatted: picksData.dateFormatted || dateISO,
        picks: graded, wins: dW, losses: dL, pushes: dPu, pending: dPe,
        accuracy: decided > 0 ? ((dW / decided) * 100).toFixed(0) : '--',
        wagered: Math.round(dWag), profit: Math.round(dProf),
        roi: dWag > 0 ? ((dProf / dWag) * 100).toFixed(1) : '--',
      });
    }

    const cumDecided = cumWins + cumLosses;
    const result = {
      days: days.reverse(),
      cumulative: {
        wins: cumWins, losses: cumLosses, pushes: cumPushes, pending: cumPending,
        accuracy: cumDecided > 0 ? ((cumWins / cumDecided) * 100).toFixed(1) + '%' : '0%',
        roi: cumWagered > 0 ? ((cumProfit / cumWagered) * 100).toFixed(1) + '%' : '0%',
        totalWagered: Math.round(cumWagered), totalProfit: Math.round(cumProfit),
      },
      straight: {
        wins: cumWins, losses: cumLosses,
        accuracy: cumDecided > 0 ? ((cumWins / cumDecided) * 100).toFixed(1) + '%' : '0%',
        roi: cumWagered > 0 ? ((cumProfit / cumWagered) * 100).toFixed(1) + '%' : '0%',
        totalWagered: Math.round(cumWagered), totalProfit: Math.round(cumProfit),
      },
      cachedAt: Date.now(),
    };

    // Cache
    try {
      await fetch(`${storeUrl}/results-cache`, {
        method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) { /* non-critical */ }

    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[get-results-fox] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to compute results' }) };
  }
};
