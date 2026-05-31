// get-results-mlb-props.js
// API endpoint: GET /.netlify/functions/get-results-mlb-props
// Returns MLB Strikeout Props historical picks graded against ESPN box scores.
// Grades pitcher K totals from ESPN summary API (starter flag + K stat).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Fetch ESPN scoreboard to get event IDs for a date ──
async function fetchESPNEvents(dateISO) {
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
      return {
        eventId: ev.id,
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        awayScore: parseInt(away.score) || 0,
        homeScore: parseInt(home.score) || 0,
        state: status.type?.state || 'pre',
        completed: status.type?.completed || false,
        inProgress: (status.type?.state === 'in'),
        detail: comp.status?.detail || status.detail || '',
        inning: comp.status?.period || 0,
      };
    }).filter(Boolean);
  } catch (e) {
    console.error(`[results-mlb-props] ESPN events error: ${e.message}`);
    return [];
  }
}

// ── Fetch ESPN summary for a single event — returns starter K totals ──
async function fetchPitcherKs(eventId) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${eventId}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const box = data.boxscore || {};
    const players = box.players || [];
    const pitchers = [];

    for (const team of players) {
      const teamName = team.team?.displayName || '';
      const teamAbbr = team.team?.abbreviation || '';
      for (const statGroup of (team.statistics || [])) {
        const labels = statGroup.labels || [];
        const kIdx = labels.indexOf('K');
        const ipIdx = labels.indexOf('IP');
        if (kIdx < 0) continue;
        // Only look at pitching stats
        if (statGroup.type && statGroup.type !== 'pitching') continue;
        if (statGroup.name && statGroup.name !== 'pitching') continue;

        for (const athlete of (statGroup.athletes || [])) {
          if (!athlete.starter) continue; // Only grade starters
          const name = athlete.athlete?.displayName || '';
          const stats = athlete.stats || [];
          const ks = parseInt(stats[kIdx]) || 0;
          const ip = parseFloat(stats[ipIdx]) || 0;
          pitchers.push({ name, team: teamName, teamAbbr, ks, ip });
        }
      }
    }
    return pitchers;
  } catch (e) {
    console.error(`[results-mlb-props] Summary fetch error for ${eventId}: ${e.message}`);
    return [];
  }
}

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function teamsMatch(pickTeam, espnTeam, espnAbbr) {
  const p = normalizeTeam(pickTeam);
  const e = normalizeTeam(espnTeam);
  const a = (espnAbbr || '').toLowerCase().trim();
  if (!p) return false;
  // Direct abbreviation match (NYM === NYM)
  if (a && p === a) return true;
  if (!e) return false;
  // Exact match
  if (p === e) return true;
  // Only do substring matching for strings longer than 3 chars
  // (avoids "LAD" matching "phiLADelphia", "TEX" matching nothing weird, etc.)
  if (p.length > 3 && (p.includes(e) || e.includes(p))) return true;
  if (e.length > 3 && p.length > 3 && (p.includes(e) || e.includes(p))) return true;
  // Last word match (e.g. "Rangers" === "Rangers")
  const pLast = p.split(' ').pop();
  const eLast = e.split(' ').pop();
  return pLast.length > 3 && pLast === eLast;
}

function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

function namesMatch(pickPitcher, espnPitcher) {
  const p = normalizeName(pickPitcher);
  const e = normalizeName(espnPitcher);
  if (!p || !e) return false;
  if (p === e) return true;
  // Last name match
  const pParts = p.split(' ');
  const eParts = e.split(' ');
  const pLast = pParts[pParts.length - 1];
  const eLast = eParts[eParts.length - 1];
  if (pLast.length > 2 && pLast === eLast) return true;
  // First initial + last name
  if (pParts.length >= 2 && eParts.length >= 2) {
    if (pParts[0][0] === eParts[0][0] && pLast === eLast) return true;
  }
  return false;
}

function calcWinnings(atRisk, oddsStr) {
  const odds = parseInt((oddsStr || '').replace(/[^0-9+-]/g, ''));
  if (isNaN(odds) || !atRisk) return 0;
  if (odds > 0) return atRisk * (odds / 100);
  return atRisk * (100 / Math.abs(odds));
}

// ── Grade a K prop pick ──
// pick.line = "O 6.5" or "U 5.5"
// actualKs = integer strikeouts by the pitcher
function gradeKPick(pick, actualKs) {
  const lineStr = (pick.line || '').trim();
  const match = lineStr.match(/^(O|U)\s*([\d.]+)$/i);
  if (!match) return 'pending'; // Can't parse line

  const side = match[1].toUpperCase(); // O or U
  const kLine = parseFloat(match[2]);

  if (side === 'O') {
    if (actualKs > kLine) return 'win';
    if (actualKs === kLine) return 'push';
    return 'loss';
  } else {
    if (actualKs < kLine) return 'win';
    if (actualKs === kLine) return 'push';
    return 'loss';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';

    if (!token) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: true, message: 'Not configured' }) };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb-props`;
    const authHeaders = { 'Authorization': `Bearer ${token}` };

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

      // Fetch ESPN events for this date
      const espnEvents = await fetchESPNEvents(dateISO);

      // Find which events match our picks and fetch box scores for completed/in-progress games
      // Helper to check if a pick matches an ESPN event
      function pickMatchesEvent(pick, ev) {
        return teamsMatch(pick.team, ev.awayTeam, ev.awayAbbr) || teamsMatch(pick.team, ev.homeTeam, ev.homeAbbr) ||
               teamsMatch(pick.opponent, ev.awayTeam, ev.awayAbbr) || teamsMatch(pick.opponent, ev.homeTeam, ev.homeAbbr);
      }

      const relevantEventIds = new Set();
      for (const pick of picks) {
        for (const ev of espnEvents) {
          if ((ev.completed || ev.inProgress) && pickMatchesEvent(pick, ev)) {
            relevantEventIds.add(ev.eventId);
          }
        }
      }

      // Fetch pitcher K data for relevant events (batch in groups of 5)
      const allPitcherKs = [];
      const eventIdArr = [...relevantEventIds];
      for (let i = 0; i < eventIdArr.length; i += 5) {
        const batch = eventIdArr.slice(i, i + 5);
        const results = await Promise.all(batch.map(id => fetchPitcherKs(id)));
        for (const pitchers of results) {
          allPitcherKs.push(...pitchers);
        }
      }

      let dayWins = 0, dayLosses = 0, dayPushes = 0, dayPending = 0;
      let dayProfit = 0, dayWagered = 0;
      const dayPicks = [];

      for (const pick of picks) {
        const units = parseFloat(pick.units) || 1;
        const risk = units * dollarPerUnit;
        dayWagered += risk;

        // Find matching pitcher in box score data
        let result = 'pending';
        let actualKs = null;
        let profit = 0;

        // Check if game is complete or in progress
        const matchedEvent = espnEvents.find(ev => pickMatchesEvent(pick, ev));

        if (matchedEvent && (matchedEvent.completed || matchedEvent.inProgress)) {
          // Find the pitcher's K total
          const matchedPitcher = allPitcherKs.find(p =>
            namesMatch(pick.pitcher, p.name)
          );

          if (matchedPitcher) {
            actualKs = matchedPitcher.ks;

            if (matchedEvent.completed) {
              // Game is final — grade it
              result = gradeKPick(pick, actualKs);
            } else if (matchedEvent.inProgress && matchedPitcher.ip > 0) {
              // Game in progress — show live K count but keep as "live"
              result = 'live';
            }
          }
        }

        if (result === 'win') {
          dayWins++;
          profit = calcWinnings(risk, pick.odds);
        } else if (result === 'loss') {
          dayLosses++;
          profit = -risk;
        } else if (result === 'push') {
          dayPushes++;
          profit = 0;
        } else {
          dayPending++;
        }

        dayProfit += profit;

        // Game score & status info
        let gameScore = null;
        let gameDetail = null;
        let pitcherIP = null;
        if (matchedEvent) {
          gameScore = `${matchedEvent.awayAbbr} ${matchedEvent.awayScore} - ${matchedEvent.homeAbbr} ${matchedEvent.homeScore}`;
          gameDetail = matchedEvent.detail; // e.g. "Bottom 3rd", "Final"
        }
        if (matchedEvent && (matchedEvent.completed || matchedEvent.inProgress)) {
          const mp = allPitcherKs.find(p => namesMatch(pick.pitcher, p.name));
          if (mp) pitcherIP = mp.ip;
        }

        // Progress toward K line
        let kProgress = null;
        const lineMatch = (pick.line || '').match(/^(O|U)\s*([\d.]+)$/i);
        if (lineMatch && actualKs != null) {
          const side = lineMatch[1].toUpperCase();
          const kLine = parseFloat(lineMatch[2]);
          const target = side === 'O' ? Math.ceil(kLine + 0.01) : Math.floor(kLine - 0.01); // Ks needed to win
          kProgress = {
            side,
            kLine,
            actual: actualKs,
            target,
            needed: side === 'O' ? Math.max(0, target - actualKs) : null,
            pct: side === 'O' ? Math.min(100, Math.round((actualKs / target) * 100)) : Math.min(100, Math.round(((kLine - actualKs) / kLine) * 100)),
          };
        }

        dayPicks.push({
          pick: pick.pick,
          matchup: pick.matchup,
          odds: pick.odds,
          units: pick.units,
          result,
          profit: Math.round(profit),
          line: pick.line,
          pitcher: pick.pitcher,
          actualKs,
          gameScore,
          gameDetail,
          pitcherIP,
          kProgress,
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

    days.reverse();

    const totalDecided = cumWins + cumLosses;
    const accuracy = totalDecided > 0 ? Math.round((cumWins / totalDecided) * 100) + '%' : '0%';
    const roi = cumWagered > 0 ? (cumProfit / cumWagered * 100).toFixed(1) + '%' : '0%';

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        days,
        cumulative: { wins: cumWins, losses: cumLosses, pushes: cumPushes, pending: cumPending, accuracy, roi, totalWagered: Math.round(cumWagered), totalProfit: Math.round(cumProfit) },
        straight: { wins: cumWins, losses: cumLosses, accuracy, totalProfit: Math.round(cumProfit) },
      }),
    };
  } catch (err) {
    console.error('[get-results-mlb-props] Error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Failed to fetch props results' }) };
  }
};
