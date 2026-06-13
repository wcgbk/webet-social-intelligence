// get-results-props.js
// API endpoint: GET /.netlify/functions/get-results-props
// Returns player props historical picks graded against ESPN box score data.
// Reads from "edge-picks-props" blob store.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── ESPN sport paths ──
const ESPN_SPORTS = {
  'NBA': 'basketball/nba',
  'MLB': 'baseball/mlb',
  'NHL': 'hockey/nhl',
};

// ── Map prop market keys to ESPN box score stat labels ──
const STAT_MAP = {
  player_points: { label: 'PTS' },
  player_rebounds: { label: 'REB' },
  player_assists: { label: 'AST' },
  player_threes: { label: '3PT', parseMode: 'made' },
  player_steals: { label: 'STL' },
  player_blocks: { label: 'BLK' },
  player_points_rebounds_assists: { composite: ['PTS', 'REB', 'AST'] },
  player_goals: { label: 'G' },
  player_shots_on_goal: { label: 'SOG' },
  pitcher_strikeouts: { label: 'K' },
  batter_hits: { label: 'H' },
  batter_total_bases: { label: 'TB' },
  batter_rbis: { label: 'RBI' },
  batter_runs: { label: 'R' },
  batter_home_runs: { label: 'HR' },
};

function parseStatVal(raw, parseMode) {
  if (raw === undefined || raw === null || raw === '--' || raw === '') return null;
  if (parseMode === 'made') {
    const parts = String(raw).split('-');
    return parseInt(parts[0]) || 0;
  }
  return parseFloat(raw) || 0;
}

// ── Fetch ESPN scoreboard to get event IDs ──
async function fetchEventIds(sport, dateISO) {
  const espnPath = ESPN_SPORTS[sport];
  if (!espnPath) return [];
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${dateParam}`;
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
        eventId: ev.id,
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        state: (comp.status || ev.status || {}).type?.state || 'pre',
      };
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ── Fetch ESPN box score for a specific event ──
async function fetchBoxScore(eventId, sport) {
  const espnPath = ESPN_SPORTS[sport];
  if (!espnPath || !eventId) return null;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/summary?event=${eventId}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const bs = data.boxscore || {};
    const players = {};
    for (const team of (bs.players || [])) {
      for (const cat of (team.statistics || [])) {
        const labels = cat.labels || [];
        for (const ath of (cat.athletes || [])) {
          const name = (ath.athlete || {}).displayName || '';
          if (!name) continue;
          const stats = ath.stats || [];
          if (!players[name]) players[name] = {};
          labels.forEach((l, i) => { players[name][l] = stats[i]; });
        }
      }
    }
    return players;
  } catch (e) { return null; }
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Find the ESPN event for a pick's matchup ──
function findEventForPick(pick, events) {
  const matchup = (pick.matchup || '').toLowerCase();
  for (const ev of events) {
    const awayLast = normalizeTeam(ev.awayTeam).split(' ').pop();
    const homeLast = normalizeTeam(ev.homeTeam).split(' ').pop();
    if (matchup.includes(awayLast) && matchup.includes(homeLast)) return ev;
  }
  return null;
}

// ── Grade a prop pick against box score data ──
function gradeProp(pick, boxScore) {
  if (!boxScore) return { result: 'pending', actual: null };
  const playerName = pick.playerName || '';
  const marketKey = pick.marketKey || '';
  const line = parseFloat(pick.line) || 0;
  const direction = pick.direction || 'Over';
  const mapping = STAT_MAP[marketKey];
  if (!mapping) return { result: 'pending', actual: null };

  // Find player in box score (fuzzy match on last name)
  const playerLast = playerName.split(' ').pop().toLowerCase();
  let playerStats = null;
  for (const [name, stats] of Object.entries(boxScore)) {
    if (name.toLowerCase().includes(playerLast) || playerLast.includes(name.split(' ').pop().toLowerCase())) {
      playerStats = stats;
      break;
    }
  }
  if (!playerStats) return { result: 'pending', actual: null };

  let actual;
  if (mapping.composite) {
    actual = mapping.composite.reduce((sum, lbl) => {
      const v = parseStatVal(playerStats[lbl], null);
      return sum + (v !== null ? v : 0);
    }, 0);
  } else {
    actual = parseStatVal(playerStats[mapping.label], mapping.parseMode);
  }
  if (actual === null) return { result: 'pending', actual: null };

  if (actual === line) return { result: 'push', actual };
  if (direction === 'Over') {
    return { result: actual > line ? 'win' : 'loss', actual };
  } else {
    return { result: actual < line ? 'win' : 'loss', actual };
  }
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

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-props`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // Get all pick dates
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

    const recentDates = dates.slice(-30);
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

      // Determine which sports are in this day's picks
      const sportSet = new Set(picks.map(p => p.sportLabel || 'NBA'));

      // Fetch ESPN events for each sport
      const allEvents = [];
      for (const sport of sportSet) {
        const events = await fetchEventIds(sport, dateISO);
        allEvents.push(...events);
      }

      // Fetch box scores for completed games that match our picks
      const boxScoreCache = {};
      for (const pick of picks) {
        const ev = findEventForPick(pick, allEvents);
        if (ev && ev.state === 'post' && !boxScoreCache[ev.eventId]) {
          const sport = pick.sportLabel || 'NBA';
          boxScoreCache[ev.eventId] = await fetchBoxScore(ev.eventId, sport);
        }
      }

      let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
      let dayProfit = 0, dayWagered = 0;
      const dayPicks = [];

      for (const pick of picks) {
        const ev = findEventForPick(pick, allEvents);
        const boxScore = ev ? boxScoreCache[ev.eventId] : null;
        const isGameFinal = ev && ev.state === 'post';

        let gradeResult;
        if (isGameFinal && boxScore) {
          gradeResult = gradeProp(pick, boxScore);
        } else {
          gradeResult = { result: 'pending', actual: null };
        }

        const units = parseFloat(pick.units) || 1;
        const risk = units * dollarPerUnit;
        dayWagered += risk;

        let profit = 0;
        if (gradeResult.result === 'win') {
          profit = calcWinnings(risk, pick.odds || '-110');
          dayWins++;
        } else if (gradeResult.result === 'loss') {
          profit = -risk;
          dayLosses++;
        } else if (gradeResult.result === 'push') {
          dayPushes++;
        } else {
          dayPending++;
        }
        dayProfit += profit;

        const actualStr = gradeResult.actual !== null
          ? `${gradeResult.actual} ${pick.statType || ''} (${pick.direction} ${pick.line})`
          : null;

        dayPicks.push({
          pick: pick.pick,
          playerName: pick.playerName,
          matchup: pick.matchup,
          odds: pick.odds,
          units: pick.units,
          result: gradeResult.result,
          profit: Math.round(profit),
          actual: actualStr,
          statValue: gradeResult.actual,
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
    console.error('[get-results-props] Error:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Failed to fetch props results' }),
    };
  }
};
