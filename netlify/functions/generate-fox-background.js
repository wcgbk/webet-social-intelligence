// generate-fox-background.js
// FOX — 3-AI Consensus Picks Engine (Standalone)
// Claude + Grok + ChatGPT debate as world-class handicappers, synthesize top 5 picks.
// Background function (15min timeout). Stores to "fox-picks" Netlify Blob store.
// ZERO connection to production /edge pipeline.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Sport keys for The Odds API ──
const ODDS_SPORTS = [
  "basketball_nba", "icehockey_nhl", "basketball_ncaab", "baseball_mlb",
  "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a",
  "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_usa_mls",
  "soccer_uefa_champs_league", "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
];

// ── ESPN sport/league slugs ──
const ESPN_LEAGUES = [
  { sport: "basketball", league: "nba", label: "NBA", homeAdv: 100, kFactor: 20, baseElo: 1500 },
  { sport: "hockey", league: "nhl", label: "NHL", homeAdv: 60, kFactor: 20, baseElo: 1500 },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAAB", homeAdv: 120, kFactor: 32, baseElo: 1500 },
  { sport: "baseball", league: "mlb", label: "MLB", homeAdv: 40, kFactor: 8, baseElo: 1500 },
  { sport: "soccer", league: "eng.1", label: "EPL", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "esp.1", label: "La Liga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ita.1", label: "Serie A", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ger.1", label: "Bundesliga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "fra.1", label: "Ligue 1", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "usa.1", label: "MLS", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.champions", label: "UCL", homeAdv: 60, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.europa", label: "Europa", homeAdv: 60, kFactor: 24, baseElo: 1500 },
];

// ── Constants ──
const SPORT_STD_DEVS = { NBA: 12, NCAAB: 11, NHL: 1.2, MLB: 2.5, EPL: 1.0, "La Liga": 1.0, "Serie A": 1.0, Bundesliga: 1.0, "Ligue 1": 1.0, MLS: 1.0, UCL: 1.0, Europa: 1.0 };
const SPORT_MIN_EDGE = { NBA: 2.0, NCAAB: 2.0, NHL: 0.3, MLB: 0.5, EPL: 0.3, "La Liga": 0.3, "Serie A": 0.3, Bundesliga: 0.3, "Ligue 1": 0.3, MLS: 0.3, UCL: 0.3, Europa: 0.3 };
const LEAGUE_AVG_DRTG = { NBA: 112.0, NCAAB: 100.0, NHL: 100.0 };

const COVER_PROB_CAPS = {
  "NHL_Puck Line": 0.60, "NHL_Total": 0.75,
  "NBA_Spread": 0.72, "NBA_Total": 0.75,
  "NCAAB_Spread": 0.72, "NCAAB_Total": 0.75,
  "MLB_Run Line": 0.60, "MLB_Total": 0.70,
  "EPL_Spread": 0.65, "La Liga_Spread": 0.65, "Serie A_Spread": 0.65,
  "Bundesliga_Spread": 0.65, "Ligue 1_Spread": 0.65, "MLS_Spread": 0.65,
  "UCL_Spread": 0.65, "Europa_Spread": 0.65,
};

const INJURY_IMPACT = {
  "Nikola Jokic": 8.5, "Luka Doncic": 7.5, "Shai Gilgeous-Alexander": 7.0,
  "Giannis Antetokounmpo": 7.5, "Joel Embiid": 7.0, "Jayson Tatum": 6.5,
  "Stephen Curry": 6.5, "Kevin Durant": 6.5, "LeBron James": 6.0,
  "Anthony Davis": 5.5, "Donovan Mitchell": 5.5, "Ja Morant": 5.5,
  "Jimmy Butler": 5.0, "Damian Lillard": 5.0, "Trae Young": 5.0,
  "Anthony Edwards": 5.5, "De'Aaron Fox": 5.0, "Tyrese Haliburton": 5.0,
  "Paolo Banchero": 4.5, "Cade Cunningham": 4.5, "Scottie Barnes": 4.5,
  "Devin Booker": 5.0, "Karl-Anthony Towns": 4.5, "Zion Williamson": 4.5,
  "Jalen Brunson": 5.0, "Darius Garland": 4.0, "Lauri Markkanen": 4.0,
  "Connor McDavid": 0.4, "Auston Matthews": 0.35, "Nathan MacKinnon": 0.35,
  "Nikita Kucherov": 0.3, "Leon Draisaitl": 0.3, "David Pastrnak": 0.3,
  "Cale Makar": 0.25, "Kirill Kaprizov": 0.3, "Jack Hughes": 0.25,
  "Sidney Crosby": 0.25, "Artemi Panarin": 0.25, "Alex Ovechkin": 0.2,
};

// ══════════════════════════════════════════════════════════════
// MATH HELPERS
// ══════════════════════════════════════════════════════════════

function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.sqrt(2))); }
function getCalibratedCoverProb(rawProb, sport, market) {
  const cap = COVER_PROB_CAPS[sport + "_" + market] || 0.75;
  return Math.min(rawProb, cap);
}
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function americanToDecimal(odds) { return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds)); }
function impliedProb(odds) { return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100); }

function computeKelly(coverProb, odds, drawdownActive) {
  const decPayout = americanToDecimal(odds);
  const edge = (coverProb * decPayout) - 1;
  if (edge <= 0) return { kellyFraction: 0, units: 0, ev: edge, decPayout, edge };
  let kellyQuarter = (edge / (decPayout - 1)) * 0.25;
  if (drawdownActive) kellyQuarter *= 0.75;
  let units = kellyQuarter * 10;
  units = Math.round(units * 2) / 2;
  units = Math.max(0.5, Math.min(3.0, units));
  return { kellyFraction: kellyQuarter, units, ev: edge, decPayout, edge };
}

function unitsToRating(u) {
  if (u >= 2.5) return "A+"; if (u >= 1.5) return "A"; if (u >= 1.0) return "A-"; if (u >= 0.5) return "B+"; return "B";
}
function unitsToConfidence(u) {
  if (u >= 2.5) return "aplus"; if (u >= 1.5) return "a"; if (u >= 1.0) return "aminus"; if (u >= 0.5) return "bplus"; return "b";
}
function formatStreak(s) { if (s > 0) return `W${s}`; if (s < 0) return `L${Math.abs(s)}`; return "—"; }

function computeInjuryAdjustment(injuries, sport) {
  if (!injuries || injuries.length === 0) return 0;
  let total = 0;
  for (const inj of injuries) {
    const status = (inj.status || '').toLowerCase();
    if (status === 'out' || status === 'doubtful' || status.includes('out for season')) {
      const impact = INJURY_IMPACT[inj.name] || 0;
      total += impact * (status === 'doubtful' ? 0.7 : 1.0);
    }
  }
  return total;
}

// ══════════════════════════════════════════════════════════════
// DATA FETCHERS
// ══════════════════════════════════════════════════════════════

async function fetchOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;
  const allOdds = [];
  for (const sport of ODDS_SPORTS) {
    try {
      let markets = "h2h,spreads,totals,alternate_spreads,alternate_totals";
      let url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
      let resp = await fetch(url);
      if (!resp.ok && resp.status === 422) {
        markets = "h2h,spreads,totals";
        url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
        resp = await fetch(url);
      }
      if (resp.ok) {
        const data = await resp.json();
        const todayGames = data.filter(g => {
          const gameTime = new Date(g.commence_time);
          const estDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(gameTime);
          const [m, d, y] = estDate.split('/');
          return `${y}-${m}-${d}` === dateISO;
        });
        if (todayGames.length > 0) allOdds.push({ sport, games: todayGames });
      }
    } catch (e) { console.log(`[fox] Odds error ${sport}: ${e.message}`); }
  }
  console.log(`[fox] Fetched odds for ${allOdds.length} sports`);
  return allOdds;
}

async function fetchESPNData(dateISO) {
  const dateParam = dateISO.replace(/-/g, "");
  const results = [];
  for (const { sport, league, label } of ESPN_LEAGUES) {
    try {
      const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateParam}`);
      if (!resp.ok) continue;
      const scoreData = await resp.json();
      const events = scoreData.events || [];
      if (events.length === 0) continue;
      const games = [];
      for (const event of events) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        if ((event.status?.type?.state || "pre") !== "pre") continue;
        const home = comp.competitors?.find(c => c.homeAway === "home");
        const away = comp.competitors?.find(c => c.homeAway === "away");
        const gameInfo = {
          name: event.name || event.shortName, date: event.date,
          venue: comp.venue?.fullName || "",
          home: home?.team?.displayName || "TBD", away: away?.team?.displayName || "TBD",
          homeRecord: home?.records?.[0]?.summary || "", awayRecord: away?.records?.[0]?.summary || "",
          homeId: home?.team?.id, awayId: away?.team?.id,
        };
        for (const [side, team] of [["home", home], ["away", away]]) {
          if (team?.team?.id) {
            try {
              const injResp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${team.team.id}/injuries`);
              if (injResp.ok) {
                const injData = await injResp.json();
                gameInfo[`${side}Injuries`] = (injData.items || []).slice(0, 10).map(i => ({
                  name: i.athlete?.displayName || "Unknown", status: i.status || "Unknown", detail: i.details?.detail || "",
                }));
              }
            } catch (e) { /* skip */ }
          }
        }
        games.push(gameInfo);
      }
      if (games.length > 0) results.push({ league: label, games });
    } catch (e) { console.log(`[fox] ESPN error ${label}: ${e.message}`); }
  }
  console.log(`[fox] ESPN: ${results.length} leagues`);
  return results;
}

async function fetchTeamStats(espnData) {
  const teamStats = {};
  for (const leagueData of (espnData || [])) {
    const cfg = ESPN_LEAGUES.find(l => l.label === leagueData.league);
    if (!cfg) continue;
    const teamIds = new Set();
    for (const g of leagueData.games) { if (g.homeId) teamIds.add(g.homeId); if (g.awayId) teamIds.add(g.awayId); }
    for (const teamId of teamIds) {
      try {
        const [statsResp, teamResp] = await Promise.all([
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams/${teamId}/statistics`).catch(() => null),
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams/${teamId}`).catch(() => null),
        ]);
        const stats = {};
        if (statsResp?.ok) {
          const data = await statsResp.json();
          for (const cat of (data.results?.stats?.categories || data.splits?.categories || [])) {
            for (const s of (cat.stats || [])) { if (s.name) stats[s.name] = s.value; }
          }
          for (const s of (data.statistics || [])) { if (s.name && s.value !== undefined) stats[s.name] = s.value; }
        }
        let ppgFor = null, ppgAgainst = null;
        if (teamResp?.ok) {
          const teamData = await teamResp.json();
          for (const item of (teamData.team?.record?.items || [])) {
            if (item.type === 'total') {
              for (const s of (item.stats || [])) {
                if (s.name === 'avgPointsFor') ppgFor = s.value;
                if (s.name === 'avgPointsAgainst') ppgAgainst = s.value;
                if (s.name === 'avgGoalsFor') ppgFor = s.value;
                if (s.name === 'avgGoalsAgainst') ppgAgainst = s.value;
              }
              break;
            }
          }
        }
        let teamName = null;
        for (const g of leagueData.games) {
          if (String(g.homeId) === String(teamId)) { teamName = g.home; break; }
          if (String(g.awayId) === String(teamId)) { teamName = g.away; break; }
        }
        if (teamName) {
          const ppg = stats.avgPoints || ppgFor || null;
          const pa = ppgAgainst || null;
          if (cfg.sport === 'hockey') {
            const gp = stats.games || 82;
            teamStats[teamName] = {
              sport: 'hockey',
              shotsFor: stats.shotsTotal ? Math.round((stats.shotsTotal / gp) * 10) / 10 : null,
              shotsAgainst: stats.shotsAgainst ? Math.round((stats.shotsAgainst / gp) * 10) / 10 : null,
              savePct: stats.savePct ? Math.round(stats.savePct * 1000) / 1000 : null,
              shootingPct: stats.shootingPct ? Math.round(stats.shootingPct * 10) / 1000 : null,
              pointsPerGame: stats.goals ? Math.round((stats.goals / gp) * 100) / 100 : ppg,
              pointsAllowed: stats.avgGoalsAgainst || pa,
            };
          } else if (cfg.sport === 'baseball') {
            const era = stats.ERA || null, whip = stats.WHIP || null;
            const obp = stats.onBasePct || null, slg = stats.slugAvg || null;
            const gp = stats.teamGamesPlayed || 1;
            teamStats[teamName] = {
              sport: 'baseball', era, whip, ops: (obp && slg) ? Math.round((obp + slg) * 1000) / 1000 : null,
              pointsPerGame: stats.runs ? Math.round((stats.runs / gp) * 10) / 10 : ppg,
              pointsAllowed: pa,
            };
          } else if (cfg.sport === 'soccer') {
            const sog = stats.shotsOnTarget || stats.shotsOnGoal || null;
            const conv = (sog && ppg && sog > 0) ? ppg / sog : null;
            teamStats[teamName] = {
              sport: 'soccer',
              shotsOnGoal: sog ? Math.round(sog * 10) / 10 : null,
              conversionRate: conv ? Math.round(conv * 1000) / 1000 : null,
              pointsPerGame: ppg ? Math.round(ppg * 10) / 10 : null,
              pointsAllowed: pa ? Math.round(pa * 10) / 10 : null,
            };
          } else {
            const fga = stats.avgFieldGoalsAttempted || null, fta = stats.avgFreeThrowsAttempted || null;
            const to = stats.avgTurnovers || null, oreb = stats.avgOffensiveRebounds || null;
            let pace = (fga && fta && to && oreb) ? fga + 0.44 * fta + to - oreb : null;
            let ortg = null, drtg = null;
            if (pace && pace > 0) { if (ppg) ortg = Math.round((ppg / pace) * 1000) / 10; if (pa) drtg = Math.round((pa / pace) * 1000) / 10; }
            teamStats[teamName] = {
              sport: 'basketball',
              offensiveRating: ortg, defensiveRating: drtg,
              pace: pace ? Math.round(pace * 10) / 10 : null,
              pointsPerGame: ppg ? Math.round(ppg * 10) / 10 : null,
              pointsAllowed: pa ? Math.round(pa * 10) / 10 : null,
            };
          }
        }
      } catch (e) { /* continue */ }
    }
  }
  console.log(`[fox] Team stats: ${Object.keys(teamStats).length} teams`);
  return teamStats;
}

async function fetchRatings() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`, { headers: { "Authorization": `Bearer ${token}` } });
    if (resp.ok) { const data = await resp.json(); console.log(`[fox] Ratings loaded`); return data; }
  } catch (e) { console.log(`[fox] Ratings fetch failed: ${e.message}`); }
  return null;
}

async function fetchPredictionMarkets() {
  const markets = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const tomorrow = now + 86400;
    const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?status=open&min_close_ts=${now}&max_close_ts=${tomorrow}&limit=200`);
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data.markets || [])) {
        const title = (m.title || m.subtitle || '').toLowerCase();
        if (/nba|nhl|mlb|ncaa|soccer|basketball|hockey|baseball|over|under|spread|win/.test(title)) {
          const yb = m.yes_bid_dollars || m.yes_bid || 0, ya = m.yes_ask_dollars || m.yes_ask || 0;
          markets.push({ source: 'Kalshi', title: m.title || '', yesPrice: (yb > 0 && ya > 0) ? (yb + ya) / 2 : (m.last_price_dollars || 0.5), volume: parseFloat(m.volume_24h_fp || m.volume_24h) || 0 });
        }
      }
    }
  } catch (e) { console.log(`[fox] Kalshi failed: ${e.message}`); }
  try {
    const now = new Date(), tom = new Date(now.getTime() + 86400000);
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false&end_date_min=${now.toISOString()}&end_date_max=${tom.toISOString()}`);
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data || [])) {
        const q = (m.question || '').toLowerCase();
        if (/nba|nhl|mlb|ncaa|soccer|over|under|spread|win|playoff/.test(q)) {
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          markets.push({ source: 'Polymarket', title: m.question || '', yesPrice: parseFloat(prices[0]) || 0.5, volume: parseFloat(m.volume24hr) || 0 });
        }
      }
    }
  } catch (e) { console.log(`[fox] Polymarket failed: ${e.message}`); }
  console.log(`[fox] Prediction markets: ${markets.length}`);
  return markets;
}

// ══════════════════════════════════════════════════════════════
// CONSENSUS LINE BUILDER + EDGE COMPUTATION
// ══════════════════════════════════════════════════════════════

function normalizeTeamName(name) {
  return name.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\./g, "").replace(/\s+/g, " ");
}

function buildConsensusLookup(oddsData) {
  const lookup = {};
  if (!oddsData) return lookup;
  for (const sportOdds of oddsData) {
    for (const game of sportOdds.games) {
      const homeTeam = game.home_team, awayTeam = game.away_team;
      const entry = { homeTeam, awayTeam, sport: sportOdds.sport, commenceTime: game.commence_time };
      const allSpreads = [], allTotals = [], spreadOdds = {}, totalOdds = { Over: [], Under: [] }, allH2H = {};
      for (const book of (game.bookmakers || [])) {
        for (const mkt of (book.markets || [])) {
          if (mkt.key === 'spreads') { for (const o of mkt.outcomes) { if (o.point !== undefined) { allSpreads.push({ team: o.name, spread: o.point }); if (!spreadOdds[o.name]) spreadOdds[o.name] = []; spreadOdds[o.name].push(o.price); } } }
          if (mkt.key === 'totals') { for (const o of mkt.outcomes) { if (o.point !== undefined) { if (o.name === 'Over') { allTotals.push(o.point); totalOdds.Over.push(o.price); } if (o.name === 'Under') { totalOdds.Under.push(o.price); } } } }
          if (mkt.key === 'h2h') { for (const o of mkt.outcomes) { if (!allH2H[o.name]) allH2H[o.name] = []; allH2H[o.name].push(o.price); } }
        }
      }
      const homeSpreads = allSpreads.filter(s => s.team === homeTeam).map(s => s.spread);
      if (homeSpreads.length > 0) { homeSpreads.sort((a, b) => a - b); entry.homeSpread = homeSpreads[Math.floor(homeSpreads.length / 2)]; entry.awaySpread = -entry.homeSpread; }
      for (const [team, prices] of Object.entries(spreadOdds)) { prices.sort((a, b) => a - b); const med = prices[Math.floor(prices.length / 2)]; if (team === homeTeam) entry.homeSpreadOdds = med; else if (team === awayTeam) entry.awaySpreadOdds = med; }
      if (allTotals.length > 0) { allTotals.sort((a, b) => a - b); entry.total = allTotals[Math.floor(allTotals.length / 2)]; if (totalOdds.Over.length) { totalOdds.Over.sort((a, b) => a - b); entry.overOdds = totalOdds.Over[Math.floor(totalOdds.Over.length / 2)]; } if (totalOdds.Under.length) { totalOdds.Under.sort((a, b) => a - b); entry.underOdds = totalOdds.Under[Math.floor(totalOdds.Under.length / 2)]; } }
      for (const [team, prices] of Object.entries(allH2H)) { prices.sort((a, b) => a - b); const med = prices[Math.floor(prices.length / 2)]; if (team === homeTeam) entry.homeML = med; else if (team === awayTeam) entry.awayML = med; }
      lookup[homeTeam.toLowerCase()] = entry; lookup[awayTeam.toLowerCase()] = entry;
      const hLast = homeTeam.toLowerCase().split(/\s+/).pop(), aLast = awayTeam.toLowerCase().split(/\s+/).pop();
      if (hLast.length > 3 && !lookup[hLast]) lookup[hLast] = entry;
      if (aLast.length > 3 && !lookup[aLast]) lookup[aLast] = entry;
    }
  }
  return lookup;
}

function findConsensusLine(lookup, teamName) {
  if (!teamName || !lookup) return null;
  const lower = normalizeTeamName(teamName);
  if (lookup[lower]) return lookup[lower];
  for (const [key, val] of Object.entries(lookup)) { if (normalizeTeamName(key) === lower) return val; }
  const lastWord = lower.split(/\s+/).pop();
  if (lastWord.length > 3) { for (const [key, val] of Object.entries(lookup)) { if (normalizeTeamName(key).split(/\s+/).pop() === lastWord) return val; } }
  for (const [key, val] of Object.entries(lookup)) { const nk = normalizeTeamName(key); if (nk.includes(lower) || lower.includes(nk)) return val; }
  return null;
}

function findTeam(teams, name) {
  if (!name || !teams) return null;
  if (teams[name]) return teams[name];
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(teams)) {
    if (key.toLowerCase() === lower) return val;
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
    const lw = lower.split(/\s+/).pop(), kw = key.toLowerCase().split(/\s+/).pop();
    if (lw === kw && lw.length > 3) return val;
  }
  return null;
}

function computeProjection(game, leagueName, leagueConfig, homeRating, awayRating, teamStats) {
  const homeStats = teamStats?.[game.home], awayStats = teamStats?.[game.away];
  const sportType = leagueConfig ? leagueConfig.sport : null;
  const projections = [];

  // Elo-based — v1.2: sport-appropriate fallback defaults
  const defaultScore = sportType === 'soccer' ? 1.3 : sportType === 'hockey' ? 2.8 : sportType === 'baseball' ? 4.5 : 100;
  const eloHome = ((homeRating.homeAvgScored || homeRating.avgScored10 || defaultScore) + (awayRating.awayAvgAllowed || awayRating.avgAllowed10 || defaultScore)) / 2;
  const eloAway = ((awayRating.awayAvgScored || awayRating.avgScored10 || defaultScore) + (homeRating.homeAvgAllowed || homeRating.avgAllowed10 || defaultScore)) / 2;
  if (eloHome > 0 && eloAway > 0) projections.push({ home: eloHome, away: eloAway, weight: 1.0, method: "elo-historical" });

  // Sport-specific efficiency
  if (sportType === 'hockey' && homeStats?.sport === 'hockey' && awayStats?.sport === 'hockey' && homeStats.shotsFor && awayStats.shotsFor) {
    const hShots = (homeStats.shotsFor + (awayStats.shotsAgainst || homeStats.shotsFor)) / 2;
    const aShots = (awayStats.shotsFor + (homeStats.shotsAgainst || awayStats.shotsFor)) / 2;
    const hSF = awayStats.savePct ? (1 - awayStats.savePct) / 0.095 : 1.0;
    const aSF = homeStats.savePct ? (1 - homeStats.savePct) / 0.095 : 1.0;
    projections.push({ home: Math.max(hShots * (homeStats.shootingPct || 0.10) * hSF, 1.0), away: Math.max(aShots * (awayStats.shootingPct || 0.10) * aSF, 1.0), weight: 1.5, method: "nhl-shot-efficiency" });
  } else if (sportType === 'baseball' && homeStats?.sport === 'baseball' && awayStats?.sport === 'baseball' && homeStats.pointsPerGame) {
    if (homeStats.era && awayStats.era) {
      projections.push({ home: Math.max(homeStats.pointsPerGame * (awayStats.era / 4.00), 1.5), away: Math.max(awayStats.pointsPerGame * (homeStats.era / 4.00), 1.5), weight: 1.5, method: "mlb-pitching" });
    } else {
      projections.push({ home: (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2, away: (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2, weight: 1.2, method: "mlb-runs" });
    }
  } else if (sportType === 'soccer' && homeStats?.sport === 'soccer' && awayStats?.sport === 'soccer' && homeStats.pointsPerGame) {
    if (homeStats.shotsOnGoal && homeStats.conversionRate) {
      const sot = (homeStats.shotsOnGoal + awayStats.shotsOnGoal) / 2;
      projections.push({ home: Math.max(sot * homeStats.conversionRate, 0.3), away: Math.max(sot * awayStats.conversionRate, 0.3), weight: 1.5, method: "soccer-shot-eff" });
    } else {
      projections.push({ home: (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2, away: (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2, weight: 1.2, method: "soccer-goal-avg" });
    }
  } else if (homeStats?.offensiveRating && homeStats?.pace && awayStats?.offensiveRating && awayStats?.pace) {
    const avgP = (homeStats.pace + awayStats.pace) / 2;
    const lgD = LEAGUE_AVG_DRTG[leagueName] || 110;
    projections.push({ home: avgP * (homeStats.offensiveRating / 100) * (awayStats.defensiveRating / lgD), away: avgP * (awayStats.offensiveRating / 100) * (homeStats.defensiveRating / lgD), weight: 1.5, method: "pace-adjusted" });
  }

  // PPG fallback
  if (homeStats?.pointsPerGame && homeStats?.pointsAllowed && awayStats?.pointsPerGame && awayStats?.pointsAllowed && !projections.find(p => p.method.includes('eff') || p.method.includes('pitch') || p.method.includes('pace'))) {
    projections.push({ home: (homeStats.pointsPerGame + awayStats.pointsAllowed) / 2, away: (awayStats.pointsPerGame + homeStats.pointsAllowed) / 2, weight: 1.2, method: "ppg-average" });
  }

  let projHomeScore, projAwayScore, projMethod;
  if (projections.length === 1) { projHomeScore = projections[0].home; projAwayScore = projections[0].away; projMethod = projections[0].method; }
  else if (projections.length >= 2) {
    const tw = projections.reduce((s, p) => s + p.weight, 0);
    projHomeScore = projections.reduce((s, p) => s + p.home * p.weight, 0) / tw;
    projAwayScore = projections.reduce((s, p) => s + p.away * p.weight, 0) / tw;
    projMethod = "ensemble(" + projections.map(p => p.method).join("+") + ")";
  } else { projHomeScore = 100; projAwayScore = 100; projMethod = "fallback"; }

  // Injury adjustment
  const hi = computeInjuryAdjustment(game.homeInjuries, sportType);
  const ai = computeInjuryAdjustment(game.awayInjuries, sportType);
  projHomeScore -= hi; projAwayScore -= ai;
  if (hi > 0 || ai > 0) projMethod += ` [inj: h-${hi.toFixed(1)}, a-${ai.toFixed(1)}]`;

  let effectiveHomeAdv = leagueConfig?.homeAdv || 80;
  if (leagueName === 'NCAAB' && game.venue) {
    const mo = new Date().getMonth() + 1;
    if ((mo === 3 && new Date().getDate() >= 15) || mo === 4) effectiveHomeAdv = 0;
  }

  const homeEloAdj = homeRating.elo + effectiveHomeAdv;
  return { projHomeScore, projAwayScore, projSpread: -(projHomeScore - projAwayScore), projTotal: projHomeScore + projAwayScore, projMethod, homeWinProb: eloExpected(homeEloAdj, awayRating.elo), homeEloAdj, effectiveHomeAdv };
}

// ── v1.1: Rest risk detection — flag games with heavy rest/tank dynamics ──
function detectRestRisk(game, homeRecord, awayRecord, homeInjuries, awayInjuries, league) {
  if (league !== 'NBA' && league !== 'NCAAB') return { restRisk: false, restWarning: '' };

  // Count OUT/Doubtful players from injury list
  const homeOut = (homeInjuries || []).filter(i => {
    const s = (i.status || '').toLowerCase();
    return s === 'out' || s === 'doubtful' || s.includes('out for season');
  });
  const awayOut = (awayInjuries || []).filter(i => {
    const s = (i.status || '').toLowerCase();
    return s === 'out' || s === 'doubtful' || s.includes('out for season');
  });

  // Check for star players in OUT list
  const starNames = Object.keys(INJURY_IMPACT);
  const homeStarsOut = homeOut.filter(i => starNames.includes(i.name)).map(i => i.name);
  const awayStarsOut = awayOut.filter(i => starNames.includes(i.name)).map(i => i.name);

  // High rest risk if 3+ players out or any star out
  const warnings = [];
  if (homeOut.length >= 3) warnings.push(`${game.home} has ${homeOut.length} players OUT`);
  if (awayOut.length >= 3) warnings.push(`${game.away} has ${awayOut.length} players OUT`);
  if (homeStarsOut.length > 0) warnings.push(`${game.home} missing: ${homeStarsOut.join(', ')}`);
  if (awayStarsOut.length > 0) warnings.push(`${game.away} missing: ${awayStarsOut.join(', ')}`);

  // Check if late in season (April) with lopsided records suggesting rest
  const now = new Date();
  const isLateSeasonNBA = league === 'NBA' && (now.getMonth() === 3 || (now.getMonth() === 2 && now.getDate() >= 20));
  if (isLateSeasonNBA) {
    // Parse W-L records to detect clinched/eliminated teams
    const parseRecord = (rec) => {
      const m = (rec || '').match(/(\d+)-(\d+)/);
      return m ? { w: parseInt(m[1]), l: parseInt(m[2]) } : null;
    };
    const hr = parseRecord(homeRecord), ar = parseRecord(awayRecord);
    if (hr && ar) {
      // Teams with 55+ wins or 55+ losses likely resting or tanking
      if (hr.w >= 55) warnings.push(`${game.home} has ${hr.w} wins — likely resting starters`);
      if (ar.w >= 55) warnings.push(`${game.away} has ${ar.w} wins — likely resting starters`);
      if (hr.l >= 55) warnings.push(`${game.home} has ${hr.l} losses — tank risk`);
      if (ar.l >= 55) warnings.push(`${game.away} has ${ar.l} losses — tank risk`);
    }
  }

  return { restRisk: warnings.length > 0, restWarning: warnings.join('; '), homeStarsOut, awayStarsOut, homeOutCount: homeOut.length, awayOutCount: awayOut.length };
}

function computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup) {
  const candidates = [];
  if (!espnData || !ratingsData) return candidates;
  for (const league of espnData) {
    const cfg = ESPN_LEAGUES.find(l => l.label === league.league);
    if (!cfg) continue;
    const lr = ratingsData?.leagues?.[league.league];
    if (!lr?.teams) continue;
    for (const game of league.games) {
      const hr = findTeam(lr.teams, game.home), ar = findTeam(lr.teams, game.away);
      if (!hr || !ar) continue;
      const proj = computeProjection(game, league.league, cfg, hr, ar, teamStats);
      const gd = findConsensusLine(consensusLookup, game.home);
      if (!gd || gd.homeSpread === undefined) continue;
      const std = SPORT_STD_DEVS[league.league] || 12, minE = SPORT_MIN_EDGE[league.league] || 2.0;

      // v1.1: Rest risk detection
      const restInfo = detectRestRisk(game, game.homeRecord, game.awayRecord, game.homeInjuries, game.awayInjuries, league.league);

      const base = {
        matchup: `${game.away} @ ${game.home}`, sport: league.league,
        homeTeam: game.home, awayTeam: game.away, commenceTime: gd.commenceTime || game.date,
        homeElo: hr.elo, awayElo: ar.elo, homeWinProb: +(proj.homeWinProb * 100).toFixed(1),
        projHomeScore: +proj.projHomeScore.toFixed(1), projAwayScore: +proj.projAwayScore.toFixed(1), projMethod: proj.projMethod,
        homeStreak: hr.streak || 0, awayStreak: ar.streak || 0,
        homeRest: hr.daysSinceLastGame, awayRest: ar.daysSinceLastGame,
        homeRecord: game.homeRecord, awayRecord: game.awayRecord,
        homeLast5: hr.last5 ? hr.last5.map(g => g.result).join("") : "",
        awayLast5: ar.last5 ? ar.last5.map(g => g.result).join("") : "",
        homeInjuries: game.homeInjuries || [], awayInjuries: game.awayInjuries || [],
        homeStats: teamStats?.[game.home] || null, awayStats: teamStats?.[game.away] || null,
        // v1.1: Rest risk metadata
        restRisk: restInfo.restRisk, restWarning: restInfo.restWarning,
        homeStarsOut: restInfo.homeStarsOut || [], awayStarsOut: restInfo.awayStarsOut || [],
      };

      // Spread candidate
      const sEdge = Math.abs(proj.projSpread - gd.homeSpread);
      if (sEdge >= minE) {
        const sZ = sEdge / std;
        let betType = "Spread"; if (league.league === "NHL") betType = "Puck Line"; else if (league.league === "MLB") betType = "Run Line";
        const cp = getCalibratedCoverProb(normalCDF(sZ), league.league, betType);
        const isHome = proj.projSpread < gd.homeSpread;
        const side = isHome ? `${game.home} ${gd.homeSpread > 0 ? '+' : ''}${gd.homeSpread}` : `${game.away} ${gd.awaySpread > 0 ? '+' : ''}${gd.awaySpread}`;
        const odds = isHome ? (gd.homeSpreadOdds || -110) : (gd.awaySpreadOdds || -110);
        if (odds >= -250) {
          const k = computeKelly(cp, odds, false);
          if (k.ev > 0.03) candidates.push({ ...base, market: betType, side, odds, modelProjection: +proj.projSpread.toFixed(1), consensusLine: gd.homeSpread, edge: +sEdge.toFixed(1), zScore: +sZ.toFixed(3), coverProb: +cp.toFixed(4), ev: +k.ev.toFixed(4), kellyUnits: k.units, kellyCalcStr: `coverProb=${cp.toFixed(3)}, decPayout=${k.decPayout.toFixed(3)}, edge=${k.ev.toFixed(3)}, kelly_quarter=${k.kellyFraction.toFixed(4)}, units=${k.units}u` });
        }
      }

      // Total candidate — v1.1: blowout total adjustment
      if (gd.total) {
        // When spread > 12 pts (NBA), reduce projected total by 8-12 pts to account for garbage time
        let adjustedProjTotal = proj.projTotal;
        const absSpread = Math.abs(gd.homeSpread);
        if (league.league === 'NBA' && absSpread >= 12) {
          const blowoutReduction = Math.min(12, (absSpread - 10) * 1.5);
          adjustedProjTotal -= blowoutReduction;
          console.log(`[fox-v1.1] Blowout adjustment: ${game.away} @ ${game.home} spread=${gd.homeSpread}, total reduced by ${blowoutReduction.toFixed(1)} (${proj.projTotal.toFixed(1)} → ${adjustedProjTotal.toFixed(1)})`);
        }
        const tEdge = Math.abs(adjustedProjTotal - gd.total);
        const tMin = league.league === "NHL" ? 0.5 : league.league === "MLB" ? 0.8 : 3.0;
        if (tEdge >= tMin) {
          const tZ = tEdge / std;
          const tcp = getCalibratedCoverProb(normalCDF(tZ), league.league, "Total");
          const isOver = adjustedProjTotal > gd.total;
          const tSide = `${isOver ? "Over" : "Under"} ${gd.total}`;
          const tOdds = isOver ? (gd.overOdds || -110) : (gd.underOdds || -110);
          if (tOdds >= -250) {
            const k = computeKelly(tcp, tOdds, false);
            if (k.ev > 0.03) candidates.push({ ...base, market: "Total", side: tSide, odds: tOdds, modelProjection: +adjustedProjTotal.toFixed(1), consensusLine: gd.total, edge: +tEdge.toFixed(1), zScore: +tZ.toFixed(3), coverProb: +tcp.toFixed(4), ev: +k.ev.toFixed(4), kellyUnits: k.units, kellyCalcStr: `coverProb=${tcp.toFixed(3)}, decPayout=${k.decPayout.toFixed(3)}, edge=${k.ev.toFixed(3)}, kelly_quarter=${k.kellyFraction.toFixed(4)}, units=${k.units}u` });
          }
        }
      }
    }
  }
  candidates.sort((a, b) => b.zScore - a.zScore);
  candidates.forEach((c, i) => { c.rank = i + 1; });
  return candidates;
}

// ══════════════════════════════════════════════════════════════
// FOX CANDIDATE TABLE (for LLM prompts)
// ══════════════════════════════════════════════════════════════

function formatFoxCandidateTable(candidates, dateISO, dateFormatted) {
  let p = `TODAY: ${dateFormatted} (${dateISO})\n\n`;
  p += `${candidates.length} edge candidates found across all sports. Analyze each and select your TOP 5 ranked by projected profitability, accuracy, and expected value.\n\n`;
  for (const c of candidates) {
    p += `━━━ #${c.rank} | ${c.sport} ${c.market} | z=${c.zScore.toFixed(2)} ━━━\n`;
    p += `  ${c.matchup}\n`;
    p += `  PICK: ${c.side} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds} | Edge: ${c.edge}${c.market === 'Total' ? 'pts' : c.sport === 'NHL' ? ' goals' : 'pts'}\n`;
    p += `  Cover%: ${(c.coverProb * 100).toFixed(1)}% | Kelly: ${c.kellyUnits}u | EV: ${(c.ev * 100).toFixed(1)}%\n`;
    p += `  Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge}\n`;
    p += `  Elo: ${c.homeTeam} ${c.homeElo} / ${c.awayTeam} ${c.awayElo} | WinProb: ${c.homeTeam} ${c.homeWinProb}%\n`;
    p += `  Score Proj: ${c.homeTeam} ${c.projHomeScore} - ${c.awayTeam} ${c.projAwayScore} [${c.projMethod}]\n`;
    p += `  Rest: ${c.homeTeam} ${c.homeRest !== undefined ? c.homeRest + 'd' : '?'} / ${c.awayTeam} ${c.awayRest !== undefined ? c.awayRest + 'd' : '?'}\n`;
    p += `  Streaks: ${c.homeTeam} ${formatStreak(c.homeStreak)} / ${c.awayTeam} ${formatStreak(c.awayStreak)}\n`;
    if (c.homeRecord) p += `  Records: ${c.homeTeam} ${c.homeRecord} / ${c.awayTeam} ${c.awayRecord}\n`;
    const hInj = (c.homeInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    const aInj = (c.awayInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    if (hInj.length) p += `  ${c.homeTeam} injuries: ${hInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;
    if (aInj.length) p += `  ${c.awayTeam} injuries: ${aInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;
    // v1.1: Rest risk warnings
    if (c.restRisk) p += `  ⚠️ REST RISK: ${c.restWarning}\n`;
    if (c.homeStarsOut?.length) p += `  🔴 ${c.homeTeam} STARS OUT: ${c.homeStarsOut.join(', ')} — projections may not reflect actual roster\n`;
    if (c.awayStarsOut?.length) p += `  🔴 ${c.awayTeam} STARS OUT: ${c.awayStarsOut.join(', ')} — projections may not reflect actual roster\n`;
    p += `\n`;
  }
  return p;
}

// ══════════════════════════════════════════════════════════════
// LLM CALLS — CLAUDE, GROK, CHATGPT
// ══════════════════════════════════════════════════════════════

const FOX_JSON_FORMAT = `Return ONLY valid JSON (no text before or after):
{
  "picks": [
    {
      "rank": 1,
      "candidateRank": 3,
      "side": "Boston Celtics -4.5",
      "matchup": "Miami Heat @ Boston Celtics",
      "sport": "NBA",
      "units": "1.5u",
      "reasoning": "3-5 sentences explaining your analysis",
      "confidence": 85,
      "profitabilityScore": 8.5,
      "accuracyScore": 7.2,
      "evScore": 9.1
    }
  ],
  "passedOn": [
    { "candidateRank": 1, "reason": "Brief reason" }
  ]
}`;

async function callClaudeFox(candidatePrompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No ANTHROPIC_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 6000, temperature: 0.3,
        system: `You are FOX ANALYST: CLAUDE — a world-class sportsbook handicapper specializing in statistical edge analysis.

CRITICAL LESSON FROM DAY 1 (0-5 LOSS): On April 10 2026 FOX went 0-5 because:
1. Teams were resting starters (OKC sat SGA + entire starting 5) but Elo/PPG reflected full-strength rosters
2. Blowout games (spreads 12-15+) suppressed totals via garbage time — model projected 232, actual was 207
3. All 3 LLMs validated bad projections instead of independently verifying lineups
4. PHX @ LAL projected 230 total, actual was 174 — Booker was OUT

YOU MUST NOW:
- Use web search to verify CONFIRMED STARTERS for every pick. If stars are resting, SKIP that game.
- Games flagged with ⚠️ REST RISK require extra scrutiny — verify via web search before selecting.
- Prefer games where BOTH teams have something to play for (playoff races, seeding battles).
- AVOID games with spreads > 12 points — these indicate non-competitive matchups.
- AVOID totals in blowout-risk games — garbage time distorts scoring.
- When in doubt, PASS. It is better to return 3 high-conviction picks than 5 questionable ones.

Score each pick on profitability (1-10), accuracy (1-10), and EV (1-10). Be disciplined.`,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        messages: [{ role: "user", content: candidatePrompt + "\n\n" + FOX_JSON_FORMAT }],
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${await resp.text()}`);
    const result = await resp.json();
    let raw = ""; for (const b of result.content) { if (b.type === "text") raw += b.text; }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in Claude response");
    return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } finally { clearTimeout(timeout); }
}

async function callGrokFox(candidatePrompt) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("No XAI_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    // v1.1: Use Responses API with web_search tool for real-time verification
    const resp = await fetch("https://api.x.ai/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "grok-3-mini",
        instructions: `You are FOX ANALYST: GROK — a world-class sportsbook handicapper specializing in real-time intelligence from X/Twitter.

CRITICAL LESSON FROM DAY 1 (0-5 LOSS): On April 10 2026 FOX went 0-5 because:
1. Teams resting starters (OKC sat SGA + starters) — model used full-strength Elo ratings
2. Blowouts suppressed totals (projected 232, actual 207; projected 230, actual 174)
3. No one verified who was actually playing before making picks
4. End-of-season rest patterns made season averages meaningless

YOU MUST NOW:
- Use web search to check X/Twitter for lineup confirmations, rest announcements, and load management
- Flag ANY game where a team's star players are sitting or on minutes restrictions
- Games marked ⚠️ REST RISK need real-time verification before selection
- Prioritize games with genuine motivation: play-in races, seeding battles, rivalry games
- AVOID rest/tank games and blowout-risk matchups (spread > 12 pts)
- When in doubt, PASS. Return fewer picks if the slate is compromised by rest.

Score each pick on profitability (1-10), accuracy (1-10), and EV (1-10).`,
        input: [{ role: "user", content: candidatePrompt + "\n\n" + FOX_JSON_FORMAT }],
        tools: [{ type: "web_search" }],
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`[fox] Grok Responses API failed (${resp.status}), falling back to chat completions`);
      // Fallback to chat completions without web search
      return await callGrokFoxFallback(candidatePrompt);
    }
    const data = await resp.json();
    // Parse response from Responses API format
    let text = '';
    const output = data.output || [];
    for (const item of output) {
      if (item.type === 'message') {
        for (const c of (item.content || [])) { if (c.type === 'output_text' || c.type === 'text') text += c.text || ''; }
      }
    }
    if (!text) text = typeof data.output === 'string' ? data.output : JSON.stringify(data.output || '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in Grok response");
    return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } finally { clearTimeout(timeout); }
}

// Fallback if Responses API not available
async function callGrokFoxFallback(candidatePrompt) {
  const key = process.env.XAI_API_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "grok-3-mini", max_tokens: 4000, temperature: 0.3,
        messages: [
          { role: "system", content: "You are FOX ANALYST: GROK — verify lineups and rest status before picking. AVOID games with resting stars. Score picks on profitability, accuracy, EV (1-10 each)." },
          { role: "user", content: candidatePrompt + "\n\n" + FOX_JSON_FORMAT },
        ],
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Grok fallback ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in Grok fallback");
    return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } finally { clearTimeout(timeout); }
}

async function callChatGPTFox(candidatePrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("No OPENAI_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    // v1.1: Use gpt-4o-search-preview for built-in web search
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-search-preview", max_tokens: 4000, temperature: 0.3,
        web_search_options: {},
        messages: [
          { role: "system", content: `You are FOX ANALYST: CHATGPT — a world-class sportsbook handicapper specializing in market analysis and prediction markets.

CRITICAL LESSON FROM DAY 1 (0-5 LOSS): On April 10 2026 FOX went 0-5 because:
1. Model found "huge edges" that were artifacts of stale data — Elo ratings for full-strength teams applied to bench lineups
2. All 3 LLMs validated the same bad projections without checking who was actually playing
3. Totals were wildly wrong (projected 232, actual 207; projected 230, actual 174)
4. End-of-season rest made statistical models unreliable

YOU MUST NOW:
- Use web search to verify injury reports, confirmed lineups, and rest announcements for EVERY pick
- Treat massive model edges (>10 pts) with EXTREME skepticism — they likely reflect rest/lineup changes
- Cross-reference prediction market pricing: if Kalshi/Polymarket disagree with our model by >15%, trust the market
- Look for games where the LINE is reasonable (spread < 10 pts) suggesting both teams are competitive
- Prefer games with real stakes: playoff positioning, play-in tournament races
- AVOID any game with ⚠️ REST RISK unless verified that starters are playing
- When in doubt, PASS. 3 good picks beat 5 questionable ones.

Score each pick on profitability (1-10), accuracy (1-10), and EV (1-10).` },
          { role: "user", content: candidatePrompt + "\n\n" + FOX_JSON_FORMAT },
        ],
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[fox] gpt-4o-search-preview failed (${resp.status}), falling back to gpt-4o`);
      return await callChatGPTFoxFallback(candidatePrompt);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in ChatGPT response");
    return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } finally { clearTimeout(timeout); }
}

// Fallback if search model not available
async function callChatGPTFoxFallback(candidatePrompt) {
  const key = process.env.OPENAI_API_KEY;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o", max_tokens: 4000, temperature: 0.3,
        messages: [
          { role: "system", content: "You are FOX ANALYST: CHATGPT — verify lineups and rest status before picking. AVOID games with resting stars. Score picks on profitability, accuracy, EV (1-10 each)." },
          { role: "user", content: candidatePrompt + "\n\n" + FOX_JSON_FORMAT },
        ],
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`ChatGPT fallback ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in ChatGPT fallback");
    return JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } finally { clearTimeout(timeout); }
}

// ══════════════════════════════════════════════════════════════
// CONSENSUS SYNTHESIS
// ══════════════════════════════════════════════════════════════

async function synthesizeConsensus(claudeResult, grokResult, chatgptResult, allCandidates) {
  const analysts = [];
  if (claudeResult.status === 'fulfilled') analysts.push({ name: 'claude', picks: claudeResult.value.picks || [] });
  if (grokResult.status === 'fulfilled') analysts.push({ name: 'grok', picks: grokResult.value.picks || [] });
  if (chatgptResult.status === 'fulfilled') analysts.push({ name: 'chatgpt', picks: chatgptResult.value.picks || [] });

  if (analysts.length < 2) {
    // Not enough analysts — use whatever we have + fill from candidates
    const available = analysts.length === 1 ? analysts[0].picks.slice(0, 5) : [];
    return buildFallbackConsensus(available, allCandidates, analysts);
  }

  // v1.2: Build synthesis prompt with candidateRank + matchup for precise matching
  let synthPrompt = `You are the FOX CONSENSUS ENGINE. Three world-class handicappers have independently analyzed today's games. Your job: find the TOP 5 picks they agree on most, ranked by consensus strength and composite score.\n\nIMPORTANT: Each pick includes a candidateRank number. Use this to identify the SAME pick across analysts. Two picks are the SAME if they have the same candidateRank OR the same side+matchup.\n\n`;

  for (const a of analysts) {
    synthPrompt += `━━━ ${a.name.toUpperCase()} PICKS ━━━\n`;
    for (const p of a.picks) {
      synthPrompt += `  candidateRank=${p.candidateRank || '?'} | ${p.side} | ${p.matchup || 'unknown matchup'} (${p.sport}) | Conf: ${p.confidence}/100 | Profit: ${p.profitabilityScore}/10 | Acc: ${p.accuracyScore}/10 | EV: ${p.evScore}/10\n`;
      synthPrompt += `    Reasoning: ${p.reasoning}\n`;
    }
    synthPrompt += `\n`;
  }

  // Also include the candidate reference table so synthesis can look up matchup names
  synthPrompt += `━━━ CANDIDATE REFERENCE (for matchup names) ━━━\n`;
  for (const c of allCandidates.slice(0, 20)) {
    synthPrompt += `  #${c.rank}: ${c.side} | ${c.matchup} | ${c.sport} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds} | Edge: ${c.edge}\n`;
  }
  synthPrompt += `\n`;

  synthPrompt += `INSTRUCTIONS:
1. Match picks across analysts by candidateRank number (most reliable) or by side+sport
2. Rank by: agreement level (3/3 > 2/3), then by average composite score
3. Select final TOP 5. If fewer than 5 have 2+ support, include highest-confidence single-analyst picks.
4. For EACH pick, you MUST include the FULL matchup from the candidate reference table (e.g. "Dallas Stars @ New York Rangers", NOT "NHL Game")
5. Synthesize the best reasoning from all analysts who selected each pick
6. Assign consensusLevel: "UNANIMOUS" (3/3), "STRONG" (2/3 + avg confidence > 75), "MAJORITY" (2/3)

Return ONLY valid JSON:
{
  "picks": [
    {
      "rank": 1,
      "candidateRank": 3,
      "side": "Boston Celtics -4.5",
      "matchup": "Miami Heat @ Boston Celtics",
      "sport": "NBA",
      "units": "1.5u",
      "consensusLevel": "UNANIMOUS",
      "analystsFor": ["claude", "grok", "chatgpt"],
      "synthesizedReasoning": "Combined analysis from all agreeing analysts...",
      "avgConfidence": 85,
      "avgProfitability": 8.5,
      "avgAccuracy": 7.5,
      "avgEV": 8.8,
      "compositeScore": 8.3
    }
  ],
  "debateHighlights": ["Key insight 1", "Key insight 2"],
  "foxSummary": "1-2 sentence editorial summary of today's consensus."
}`;

  const key = process.env.ANTHROPIC_API_KEY;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 5000, temperature: 0.2,
        messages: [{ role: "user", content: synthPrompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Synthesis ${resp.status}`);
    const result = await resp.json();
    let raw = ""; for (const b of result.content) { if (b.type === "text") raw += b.text; }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in synthesis");
    const parsed = JSON.parse(match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));

    // v1.2: Enrich picks with individual analyst reasoning — match by candidateRank first, then by side+sport
    for (const pick of (parsed.picks || [])) {
      const pickCR = pick.candidateRank;
      const pickSideLower = (pick.side || '').toLowerCase();
      const pickSport = (pick.sport || '').toLowerCase();

      for (const a of analysts) {
        // Match analyst pick by candidateRank (most precise), then side+sport, then side alone
        const analystMatch = a.picks.find(p => {
          if (pickCR && p.candidateRank && p.candidateRank === pickCR) return true;
          const pSide = (p.side || '').toLowerCase();
          const pSport = (p.sport || '').toLowerCase();
          if (pSide === pickSideLower && pSport === pickSport) return true;
          // Fuzzy: same side text and same sport
          if (pSport === pickSport && (pSide.includes(pickSideLower) || pickSideLower.includes(pSide))) return true;
          return false;
        });
        if (analystMatch) {
          pick[`${a.name}Reasoning`] = analystMatch.reasoning;
          pick[`${a.name}Confidence`] = analystMatch.confidence;
        }
      }

      // Match to candidate for Kelly/edge data — candidateRank first, then side+sport
      let cand = null;
      if (pickCR) cand = allCandidates.find(c => c.rank === pickCR);
      if (!cand) {
        cand = allCandidates.find(c => {
          const cSide = c.side.toLowerCase();
          const cSport = c.sport.toLowerCase();
          return cSide === pickSideLower && cSport === pickSport;
        });
      }
      if (!cand) {
        // Last resort: match by side text within same sport
        cand = allCandidates.find(c => {
          return c.sport.toLowerCase() === pickSport && c.side.toLowerCase().includes(pickSideLower.replace(/[+-]\d.*/, '').trim());
        });
      }
      if (cand) {
        pick.matchup = pick.matchup || cand.matchup; // Fill missing matchup from candidate
        pick.kellyCalc = cand.kellyCalcStr;
        pick.coverProb = cand.coverProb;
        pick.ev = cand.ev;
        pick.modelEdge = `Model: ${cand.modelProjection}, Line: ${cand.consensusLine}, Edge: ${cand.edge}`;
        pick.odds = `${cand.odds > 0 ? '+' : ''}${cand.odds}`;
        pick.betType = cand.market;
        pick.commenceTime = cand.commenceTime;
        if (!pick.units) pick.units = `${cand.kellyUnits}u`;
        console.log(`[fox] Matched pick "${pick.side}" to candidate #${cand.rank}: ${cand.matchup}`);
      } else {
        console.log(`[fox] WARNING: No candidate match for pick "${pick.side}" (${pick.sport})`);
      }
    }

    return { ...parsed, analystRawOutputs: Object.fromEntries(analysts.map(a => [a.name, { picks: a.picks }])) };
  } catch (e) {
    console.error(`[fox] Synthesis failed: ${e.message}`);
    return buildFallbackConsensus(analysts.length > 0 ? analysts[0].picks : [], allCandidates, analysts);
  }
}

function buildFallbackConsensus(availablePicks, allCandidates, analysts) {
  const picks = [];
  const used = new Set();
  // Use available LLM picks first
  for (const p of availablePicks.slice(0, 5)) {
    const cand = allCandidates.find(c => c.side.toLowerCase().includes((p.side || '').toLowerCase().split(' ')[0]));
    picks.push({
      rank: picks.length + 1, side: p.side, matchup: p.matchup || (cand ? cand.matchup : ''), sport: p.sport || (cand ? cand.sport : ''),
      units: p.units || (cand ? `${cand.kellyUnits}u` : '1.0u'), consensusLevel: "SINGLE",
      analystsFor: analysts.filter(a => a.picks.some(ap => (ap.side || '').toLowerCase() === (p.side || '').toLowerCase())).map(a => a.name),
      synthesizedReasoning: p.reasoning || "Auto-generated from model edge.",
      avgConfidence: p.confidence || 70, compositeScore: ((p.profitabilityScore || 7) + (p.accuracyScore || 7) + (p.evScore || 7)) / 3,
      odds: cand ? `${cand.odds > 0 ? '+' : ''}${cand.odds}` : '-110', betType: cand?.market || 'Spread',
      kellyCalc: cand?.kellyCalcStr || '', ev: cand?.ev || 0, coverProb: cand?.coverProb || 0,
      modelEdge: cand ? `Model: ${cand.modelProjection}, Line: ${cand.consensusLine}, Edge: ${cand.edge}` : '',
      commenceTime: cand?.commenceTime,
    });
    if (cand) used.add(cand.rank);
  }
  // Fill remaining from candidates
  for (const c of allCandidates) {
    if (picks.length >= 5) break;
    if (used.has(c.rank)) continue;
    picks.push({
      rank: picks.length + 1, side: c.side, matchup: c.matchup, sport: c.sport,
      units: `${c.kellyUnits}u`, consensusLevel: "MODEL", analystsFor: [],
      synthesizedReasoning: `FOX model projects ${c.modelProjection} vs the line at ${c.consensusLine}, creating a ${c.edge}-point edge with ${(c.coverProb * 100).toFixed(0)}% cover probability.`,
      avgConfidence: Math.round(c.coverProb * 100), compositeScore: Math.round(c.ev * 100) / 10,
      odds: `${c.odds > 0 ? '+' : ''}${c.odds}`, betType: c.market,
      kellyCalc: c.kellyCalcStr, ev: c.ev, coverProb: c.coverProb,
      modelEdge: `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge}`,
      commenceTime: c.commenceTime,
    });
  }
  return { picks, debateHighlights: ["Fallback mode — not enough LLM analysts responded"], foxSummary: "FOX ran in fallback mode today.", analystRawOutputs: Object.fromEntries(analysts.map(a => [a.name, { picks: a.picks }])) };
}

// ══════════════════════════════════════════════════════════════
// BLOB STORAGE
// ══════════════════════════════════════════════════════════════

async function storeFoxPicks(dateISO, picksData) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) { console.error("[fox] No NETLIFY_AUTH_TOKEN"); return; }
  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/fox-picks`;
  const authHeaders = { "Authorization": `Bearer ${token}` };
  try {
    const put = await fetch(`${storeUrl}/picks-${dateISO}`, {
      method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (!put.ok) console.error(`[fox] Blob PUT failed ${put.status}: ${(await put.text()).substring(0, 200)}`);
    else console.log("[fox] Picks stored");
    await fetch(`${storeUrl}/latest-date`, { method: "PUT", headers: { ...authHeaders, "Content-Type": "text/plain" }, body: dateISO });

    // v1.1: Maintain dates index for proper results tracking
    try {
      let datesArr = [];
      const getDates = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
      if (getDates.ok) datesArr = await getDates.json();
      if (!Array.isArray(datesArr)) datesArr = [];
      if (!datesArr.includes(dateISO)) {
        datesArr.push(dateISO);
        datesArr.sort();
        await fetch(`${storeUrl}/picks-dates`, {
          method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(datesArr),
        });
        console.log(`[fox] Added ${dateISO} to picks-dates index (${datesArr.length} total)`);
      }
    } catch (e) { console.error(`[fox] picks-dates index error: ${e.message}`); }

    // v1.1: Clear results cache so P/L updates immediately
    try {
      await fetch(`${storeUrl}/results-cache`, { method: "DELETE", headers: authHeaders });
    } catch (e) { /* non-critical */ }
  } catch (e) { console.error(`[fox] Store error: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  console.log("[fox] Background function started — 3-AI Consensus Engine");
  const startTime = Date.now();

  const now = new Date();
  let dateISO, dateFormatted;
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      dateISO = body.date;
      const d = new Date(body.date + 'T12:00:00-05:00');
      dateFormatted = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
    }
  } catch (e) { /* ignore */ }

  if (!dateISO) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    dateISO = `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
    dateFormatted = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now);
  }
  console.log(`[fox] Generating picks for ${dateISO}`);

  // ── PHASE 1: DATA ASSEMBLY ──
  const [oddsData, espnData, ratingsData, predictionMarkets] = await Promise.all([
    fetchOdds(dateISO), fetchESPNData(dateISO), fetchRatings(), fetchPredictionMarkets(),
  ]);
  const teamStats = await fetchTeamStats(espnData);
  const consensusLookup = buildConsensusLookup(oddsData);
  const allCandidates = computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup);

  console.log(`[fox] Phase 1 complete: ${allCandidates.length} candidates in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  if (allCandidates.length === 0) {
    await storeFoxPicks(dateISO, {
      date: dateISO, dateFormatted, model: "fox-v1.2-consensus",
      picks: [], foxSummary: "No edge candidates found today.", debateHighlights: [],
      summary: { totalPicks: 0, totalUnits: "0u", unanimousPicks: 0, sportsCovered: [], modelVersion: "fox-v1.2-consensus" },
      generatedAt: now.toISOString(),
    });
    return { statusCode: 200, body: "No candidates" };
  }

  // ── PHASE 2: 3-AI DEBATE (parallel) ──
  const top20 = allCandidates.slice(0, 20);
  const candidatePrompt = formatFoxCandidateTable(top20, dateISO, dateFormatted);
  console.log(`[fox] Sending ${top20.length} candidates to 3 AI analysts (${candidatePrompt.length} chars)`);

  const [claudeResult, grokResult, chatgptResult] = await Promise.allSettled([
    callClaudeFox(candidatePrompt),
    callGrokFox(candidatePrompt),
    callChatGPTFox(candidatePrompt),
  ]);

  const llmTimings = {};
  const phase2Time = Date.now() - startTime;
  console.log(`[fox] Phase 2 complete in ${(phase2Time / 1000).toFixed(1)}s — Claude: ${claudeResult.status}, Grok: ${grokResult.status}, ChatGPT: ${chatgptResult.status}`);
  if (claudeResult.status === 'rejected') console.error(`[fox] Claude failed: ${claudeResult.reason}`);
  if (grokResult.status === 'rejected') console.error(`[fox] Grok failed: ${grokResult.reason}`);
  if (chatgptResult.status === 'rejected') console.error(`[fox] ChatGPT failed: ${chatgptResult.reason}`);

  // ── PHASE 3: CONSENSUS SYNTHESIS ──
  const consensus = await synthesizeConsensus(claudeResult, grokResult, chatgptResult, allCandidates);
  const picks = (consensus.picks || []).slice(0, 5);

  // Assign ratings based on units
  for (const p of picks) {
    const u = parseFloat(String(p.units || '1').replace(/[^0-9.]/g, ''));
    p.rating = unitsToRating(u);
    p.confidence_badge = unitsToConfidence(u);
    p.winProbability = p.coverProb ? `${(p.coverProb * 100).toFixed(0)}%` : `${p.avgConfidence || 70}%`;
  }

  const totalUnits = picks.reduce((s, p) => s + parseFloat(String(p.units || '0').replace(/[^0-9.]/g, '')), 0);
  const sportsCovered = [...new Set(picks.map(p => p.sport).filter(Boolean))];

  const picksData = {
    date: dateISO, dateFormatted, model: "fox-v1.2-consensus",
    picks,
    foxSummary: consensus.foxSummary || "",
    debateHighlights: consensus.debateHighlights || [],
    analystRawOutputs: consensus.analystRawOutputs || {},
    summary: {
      totalPicks: picks.length,
      totalUnits: `${totalUnits.toFixed(1)}u`,
      unanimousPicks: picks.filter(p => p.consensusLevel === "UNANIMOUS").length,
      strongPicks: picks.filter(p => p.consensusLevel === "STRONG").length,
      majorityPicks: picks.filter(p => p.consensusLevel === "MAJORITY").length,
      sportsCovered,
      modelVersion: "fox-v1.2-consensus",
    },
    generatedAt: now.toISOString(),
    edgeCandidatesCount: allCandidates.length,
    llmStatus: {
      claude: claudeResult.status, grok: grokResult.status, chatgpt: chatgptResult.status,
    },
    totalTimeMs: Date.now() - startTime,
  };

  await storeFoxPicks(dateISO, picksData);
  console.log(`[fox] SUCCESS: ${picks.length} consensus picks in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return { statusCode: 200, body: "OK" };
};
