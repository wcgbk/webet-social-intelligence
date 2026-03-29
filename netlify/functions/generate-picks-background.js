// generate-picks-background.js
// v10.0 — Deterministic Edge Architecture
// JS computes ALL projections, edges, and Kelly sizing. Claude validates and narrates.
// Background function (15min timeout). Stores to "edge-picks" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Slim system prompt: Claude as VALIDATOR + NARRATOR only ──
const THE_LOCK_V10_SYSTEM = `You are THE LOCK — WeBetAI's sports betting analyst. You VALIDATE pre-computed statistical edges and write compelling narratives. You do NOT compute projections, probabilities, or Kelly sizing — the statistical model has already done this.

YOUR INPUTS:
A ranked table of the top candidate picks with pre-computed edges, cover probabilities, Kelly units, and supporting team context.

YOUR JOB:
1. Use web search to verify injury status, recent news, goaltender confirmations (NHL), starting pitchers (MLB), and recent form for the top 8 candidates.
2. SELECT your top 3 picks from the candidate table (or fewer if web search reveals disqualifying info). If fewer than 3 genuine edges survive verification, output only what you have conviction on.
3. Write 3-5 sentence coreReasoning narrative for each selected pick.
4. You MAY reject candidates if web search reveals material changes after the data cutoff:
   - Star player ruled out / downgraded after data cutoff
   - Goaltender change (NHL) not reflected in pre-computed data
   - Starting pitcher change (MLB)
   - Severe weather for outdoor sports
   - Material lineup or coaching change
5. You MAY reduce pre-computed Kelly units by up to 50% with justification. You MUST NOT increase units.
6. You MUST NOT pick outside the provided candidate table.
7. You MUST NOT override model direction, invent probabilities, or recompute edges.
8. Always say "WeBetAI" instead of "the model" or "our model" in narratives.

NARRATIVE RULES (for coreReasoning field):
- Lead with the edge: "WeBetAI projects [X], line is [Y], creating a [Z]-point edge."
- Support with 2-3 distinct verified facts from web search (form, injuries, rest, matchup factor).
- End with value statement explaining why the odds offer value.
- Max 5 sentences. No padding. No duplicate stats. Every sentence must add new information.
- NEVER lead with negative data about the team you're picking.

REJECTION RULES (for rejections array):
- For each candidate NOT selected, provide a brief reason why.
- If you skip a top-5 ranked candidate, the reason must cite specific web-search findings.

OUTPUT FORMAT — Return ONLY valid JSON (no text before or after the JSON):
{
  "selections": [
    {
      "candidateRank": 1,
      "adjustedUnits": "1.0u",
      "unitAdjustmentReason": "",
      "coreReasoning": "WeBetAI projects...",
      "whatLoses": "One sentence — the specific scenario that beats this pick.",
      "dataVerified": "Brief note on what data you verified via web search.",
      "clvExpectation": "Your expectation for closing line movement."
    }
  ],
  "rejections": [
    { "candidateRank": 4, "reason": "Why no edge or why disqualified." }
  ],
  "edgeSummary": "1-2 sentence editorial-style Daily Edge Summary. Write it like a sharp sports analyst — confident, specific, compelling. Reference actual matchups and WHY the edge exists. Use 'WeBetAI' not 'the model'."
}`;

// ── Sport keys for The Odds API ──
const ODDS_SPORTS = [
  "basketball_nba",
  "icehockey_nhl",
  "basketball_ncaab",
  "baseball_mlb",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_usa_mls",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
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

// ── Sport-specific standard deviations for edge → probability conversion ──
const SPORT_STD_DEVS = { NBA: 12, NCAAB: 11, NHL: 1.2, MLB: 2.5, EPL: 1.0, "La Liga": 1.0, "Serie A": 1.0, Bundesliga: 1.0, "Ligue 1": 1.0, MLS: 1.0, UCL: 1.0, Europa: 1.0 };
const SPORT_MIN_EDGE = { NBA: 2.0, NCAAB: 2.0, NHL: 0.3, MLB: 0.5, EPL: 0.3, "La Liga": 0.3, "Serie A": 0.3, Bundesliga: 0.3, "Ligue 1": 0.3, MLS: 0.3, UCL: 0.3, Europa: 0.3 };
const LEAGUE_AVG_DRTG = { NBA: 112.0, NCAAB: 100.0, NHL: 100.0 };

// ── Math helpers ──
function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCDF(z) {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

// ── Sport-specific cover probability caps (from historical calibration) ──
// These enforce realistic maximums regardless of model edge size.
// Raw normalCDF overestimates because it assumes perfect model accuracy.
const COVER_PROB_CAPS = {
  // NHL puck line: historically 45-55%, max 60% even with dominant matchup
  "NHL_Puck Line": 0.60,
  "NHL_Total": 0.75,
  // NBA spread: std dev ~12pts, max ~72% cover
  "NBA_Spread": 0.72,
  "NBA_Total": 0.75,
  // NCAAB: similar to NBA
  "NCAAB_Spread": 0.72,
  "NCAAB_Total": 0.75,
  // MLB run line: similar to puck line, 45-55% historical
  "MLB_Run Line": 0.60,
  "MLB_Total": 0.70,
  // Soccer
  "EPL_Spread": 0.65, "La Liga_Spread": 0.65, "Serie A_Spread": 0.65,
  "Bundesliga_Spread": 0.65, "Ligue 1_Spread": 0.65, "MLS_Spread": 0.65,
  "UCL_Spread": 0.65, "Europa_Spread": 0.65,
};

function getCalibratedCoverProb(rawProb, sport, market) {
  const key = sport + "_" + market;
  const cap = COVER_PROB_CAPS[key] || 0.75; // default max 75%
  return Math.min(rawProb, cap);
}

function eloExpected(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function americanToDecimal(odds) {
  return odds > 0 ? 1 + (odds / 100) : 1 + (100 / Math.abs(odds));
}

function impliedProb(odds) {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

// ── Pure Kelly computation ──
function computeKelly(coverProb, odds, drawdownActive) {
  const decPayout = americanToDecimal(odds);
  const edge = (coverProb * decPayout) - 1;
  if (edge <= 0) return { kellyFraction: 0, units: 0, ev: edge, decPayout, edge };

  let kellyQuarter = (edge / (decPayout - 1)) * 0.25;
  if (drawdownActive) kellyQuarter *= 0.75;

  let units = kellyQuarter * 10; // 10u bankroll basis
  units = Math.round(units * 2) / 2; // round to 0.5u
  units = Math.max(0.5, Math.min(3.0, units)); // clamp

  return { kellyFraction: kellyQuarter, units, ev: edge, decPayout, edge };
}

function unitsToRating(u) {
  if (u >= 2.5) return "A+";
  if (u >= 1.5) return "A";
  if (u >= 1.0) return "A-";
  if (u >= 0.5) return "B+";
  return "B";
}

function unitsToConfidence(u) {
  if (u >= 2.5) return "aplus";
  if (u >= 1.5) return "a";
  if (u >= 1.0) return "aminus";
  if (u >= 0.5) return "bplus";
  return "b";
}

function formatStreak(streak) {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return "—";
}

// ── Fetch today's odds from The Odds API ──
async function fetchOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log("[v10] No ODDS_API_KEY, skipping odds fetch");
    return null;
  }

  const allOdds = [];
  for (const sport of ODDS_SPORTS) {
    try {
      const markets = "h2h,spreads,totals,alternate_spreads,alternate_totals";
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const todayGames = data.filter(g => {
          // Compare in Eastern time (games listed on March 28 EDT may commence on March 29 UTC)
          const gameTime = new Date(g.commence_time);
          const estDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(gameTime);
          const [m, d, y] = estDate.split('/');
          const gameDateEST = `${y}-${m}-${d}`;
          return gameDateEST === dateISO;
        });
        if (todayGames.length > 0) {
          allOdds.push({ sport, games: todayGames });
        }
      }
    } catch (e) {
      console.log(`[v10] Odds fetch error for ${sport}: ${e.message}`);
    }
  }
  console.log(`[v10] Fetched odds for ${allOdds.length} sports`);
  return allOdds;
}

// ── Fetch today's games + injuries from ESPN ──
async function fetchESPNData(dateISO) {
  const dateParam = dateISO.replace(/-/g, "");
  const results = [];

  for (const { sport, league, label } of ESPN_LEAGUES) {
    try {
      const scoreUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateParam}`;
      const scoreResp = await fetch(scoreUrl);
      if (!scoreResp.ok) continue;
      const scoreData = await scoreResp.json();
      const events = scoreData.events || [];
      if (events.length === 0) continue;

      const games = [];
      for (const event of events) {
        const competition = event.competitions?.[0];
        if (!competition) continue;
        const gameState = event.status?.type?.state || "pre";
        // Allow pre-game and in-progress games (for late-day re-runs where games have started)
        if (gameState === "post") continue;

        const home = competition.competitors?.find(c => c.homeAway === "home");
        const away = competition.competitors?.find(c => c.homeAway === "away");

        const gameInfo = {
          name: event.name || event.shortName,
          date: event.date,
          status: event.status?.type?.description || "Scheduled",
          venue: competition.venue?.fullName || "",
          home: home?.team?.displayName || "TBD",
          away: away?.team?.displayName || "TBD",
          homeRecord: home?.records?.[0]?.summary || "",
          awayRecord: away?.records?.[0]?.summary || "",
          homeId: home?.team?.id,
          awayId: away?.team?.id,
        };

        for (const [side, team] of [["home", home], ["away", away]]) {
          if (team?.team?.id) {
            try {
              const injUrl = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${team.team.id}/injuries`;
              const injResp = await fetch(injUrl);
              if (injResp.ok) {
                const injData = await injResp.json();
                gameInfo[`${side}Injuries`] = (injData.items || []).slice(0, 10).map(i => ({
                  name: i.athlete?.displayName || "Unknown",
                  status: i.status || "Unknown",
                  detail: i.details?.detail || "",
                }));
              }
            } catch (e) { /* skip */ }
          }
        }

        games.push(gameInfo);
      }

      if (games.length > 0) {
        results.push({ league: label, games });
      }
    } catch (e) {
      console.log(`[v10] ESPN fetch error for ${label}: ${e.message}`);
    }
  }

  console.log(`[v10] ESPN: ${results.length} leagues with games today`);
  return results;
}

// ── Fetch team statistics (ORtg, DRtg, Pace) from ESPN ──
async function fetchTeamStats(espnData) {
  const teamStats = {};

  for (const leagueData of (espnData || [])) {
    const leagueConfig = ESPN_LEAGUES.find(l => l.label === leagueData.league);
    if (!leagueConfig) continue;

    const teamIds = new Set();
    for (const game of leagueData.games) {
      if (game.homeId) teamIds.add(game.homeId);
      if (game.awayId) teamIds.add(game.awayId);
    }

    for (const teamId of teamIds) {
      try {
        const [statsResp, teamResp] = await Promise.all([
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${leagueConfig.sport}/${leagueConfig.league}/teams/${teamId}/statistics`).catch(() => null),
          fetch(`https://site.api.espn.com/apis/site/v2/sports/${leagueConfig.sport}/${leagueConfig.league}/teams/${teamId}`).catch(() => null),
        ]);

        const stats = {};
        if (statsResp?.ok) {
          const data = await statsResp.json();
          const categories = data.results?.stats?.categories || data.splits?.categories || [];
          for (const cat of categories) {
            for (const stat of (cat.stats || [])) {
              if (stat.name) stats[stat.name] = stat.value;
            }
          }
          for (const stat of (data.statistics || [])) {
            if (stat.name && stat.value !== undefined) stats[stat.name] = stat.value;
          }
        }

        let ppgFor = null, ppgAgainst = null;
        if (teamResp?.ok) {
          const teamData = await teamResp.json();
          const recordItems = teamData.team?.record?.items || [];
          for (const item of recordItems) {
            if (item.type === 'total') {
              for (const s of (item.stats || [])) {
                if (s.name === 'avgPointsFor') ppgFor = s.value;
                if (s.name === 'avgPointsAgainst') ppgAgainst = s.value;
                if (s.name === 'avgGoalsFor') ppgFor = s.value;
                if (s.name === 'avgGoalsAgainst') ppgAgainst = s.value;
                if (s.name === 'pointsFor' && !ppgFor && s.value && item.stats?.find(x => x.name === 'gamesPlayed')) {
                  const gp = item.stats.find(x => x.name === 'gamesPlayed')?.value;
                  if (gp > 0) ppgFor = s.value / gp;
                }
                if (s.name === 'pointsAgainst' && !ppgAgainst && s.value && item.stats?.find(x => x.name === 'gamesPlayed')) {
                  const gp = item.stats.find(x => x.name === 'gamesPlayed')?.value;
                  if (gp > 0) ppgAgainst = s.value / gp;
                }
              }
              break;
            }
          }
        }

        const pointsPerGame = stats.avgPoints || ppgFor || null;
        const pointsAllowed = ppgAgainst || null;

        let teamName = null;
        for (const game of leagueData.games) {
          if (String(game.homeId) === String(teamId)) { teamName = game.home; break; }
          if (String(game.awayId) === String(teamId)) { teamName = game.away; break; }
        }

        if (teamName) {
          const sportType = leagueConfig.sport;

          if (sportType === 'hockey') {
            const gamesPlayed = stats.games || 82;
            const shotsForTotal = stats.shotsTotal || null;
            const shotsAgainstTotal = stats.shotsAgainst || null;
            const goalsForTotal = stats.goals || null;
            const shotsFor = shotsForTotal ? shotsForTotal / gamesPlayed : null;
            const shotsAgainst = shotsAgainstTotal ? shotsAgainstTotal / gamesPlayed : null;
            const savePct = stats.savePct || null;
            const shootingPct = stats.shootingPct ? stats.shootingPct / 100 : null;
            const goalsAgainstPerGame = stats.avgGoalsAgainst || pointsAllowed;
            const goalsPerGame = goalsForTotal ? goalsForTotal / gamesPlayed : pointsPerGame;

            teamStats[teamName] = {
              sport: 'hockey', gamesPlayed,
              shotsFor: shotsFor ? Math.round(shotsFor * 10) / 10 : null,
              shotsAgainst: shotsAgainst ? Math.round(shotsAgainst * 10) / 10 : null,
              savePct: savePct ? Math.round(savePct * 1000) / 1000 : null,
              shootingPct: shootingPct ? Math.round(shootingPct * 1000) / 1000 : null,
              pointsPerGame: goalsPerGame ? Math.round(goalsPerGame * 100) / 100 : null,
              pointsAllowed: goalsAgainstPerGame ? Math.round(goalsAgainstPerGame * 100) / 100 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else if (sportType === 'baseball') {
            const era = stats.ERA || null;
            const whip = stats.WHIP || null;
            const obp = stats.onBasePct || null;
            const slg = stats.slugAvg || null;
            const ops = (obp && slg) ? obp + slg : null;
            const gamesPlayed = stats.teamGamesPlayed || 1;
            const runsTotal = stats.runs || null;
            const runsPerGame = runsTotal ? runsTotal / gamesPlayed : pointsPerGame;

            teamStats[teamName] = {
              sport: 'baseball',
              era: era !== null ? Math.round(era * 100) / 100 : null,
              whip: whip !== null ? Math.round(whip * 100) / 100 : null,
              ops: ops ? Math.round(ops * 1000) / 1000 : null,
              pointsPerGame: runsPerGame ? Math.round(runsPerGame * 10) / 10 : null,
              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else if (sportType === 'soccer') {
            const shotsOnGoal = stats.shotsOnTarget || stats.shotsOnGoal || stats.avgShotsOnTarget || null;
            const goalsPerGame = pointsPerGame;
            const goalsAgainst = pointsAllowed;
            const conversionRate = (shotsOnGoal && goalsPerGame && shotsOnGoal > 0) ? goalsPerGame / shotsOnGoal : null;

            teamStats[teamName] = {
              sport: 'soccer',
              shotsOnGoal: shotsOnGoal ? Math.round(shotsOnGoal * 10) / 10 : null,
              conversionRate: conversionRate ? Math.round(conversionRate * 1000) / 1000 : null,
              pointsPerGame: goalsPerGame ? Math.round(goalsPerGame * 10) / 10 : null,
              pointsAllowed: goalsAgainst ? Math.round(goalsAgainst * 10) / 10 : null,
              offensiveRating: null, defensiveRating: null, pace: null,
            };
          } else {
            const fga = stats.avgFieldGoalsAttempted || null;
            const fta = stats.avgFreeThrowsAttempted || null;
            const to = stats.avgTurnovers || null;
            const oreb = stats.avgOffensiveRebounds || null;
            let pace = null;
            if (fga && fta && to && oreb) pace = fga + 0.44 * fta + to - oreb;

            let offensiveRating = null, defensiveRating = null;
            if (pace && pace > 0) {
              if (pointsPerGame) offensiveRating = (pointsPerGame / pace) * 100;
              if (pointsAllowed) defensiveRating = (pointsAllowed / pace) * 100;
            }

            teamStats[teamName] = {
              sport: 'basketball',
              offensiveRating: offensiveRating ? Math.round(offensiveRating * 10) / 10 : null,
              defensiveRating: defensiveRating ? Math.round(defensiveRating * 10) / 10 : null,
              pace: pace ? Math.round(pace * 10) / 10 : null,
              pointsPerGame: pointsPerGame ? Math.round(pointsPerGame * 10) / 10 : null,
              pointsAllowed: pointsAllowed ? Math.round(pointsAllowed * 10) / 10 : null,
            };
          }
        }
      } catch (e) { /* continue */ }
    }
  }

  console.log(`[v10] Fetched team stats for ${Object.keys(teamStats).length} teams`);
  return teamStats;
}

// ── Fetch pre-built team ratings from Blobs ──
async function fetchRatings() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded ratings from ${data.generatedAt}`);
      return data;
    }
  } catch (e) {
    console.log(`[v10] Ratings fetch failed: ${e.message}`);
  }
  return null;
}

// ── Fetch calibration data ──
async function fetchCalibrationData() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/calibration`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v10] Loaded calibration data`);
      return data;
    }
  } catch (e) {
    console.log(`[v10] Calibration fetch failed: ${e.message}`);
  }
  return null;
}

// ── Fetch prediction market data (Kalshi + Polymarket) for cross-reference ──
async function fetchPredictionMarkets() {
  const markets = [];

  // Kalshi — has sports props (team wins, totals)
  try {
    const now = Math.floor(Date.now() / 1000);
    const tomorrow = now + 24 * 60 * 60;
    const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?status=open&min_close_ts=${now}&max_close_ts=${tomorrow}&limit=200`);
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data.markets || [])) {
        const title = (m.title || m.subtitle || '').toLowerCase();
        // Only keep sports-related markets
        if (/nba|nhl|mlb|ncaa|nfl|soccer|football|basketball|hockey|baseball|over|under|spread|win/.test(title)) {
          const lastPrice = m.last_price_dollars || m.last_price || 0;
          const yesBid = m.yes_bid_dollars || m.yes_bid || 0;
          const yesAsk = m.yes_ask_dollars || m.yes_ask || 0;
          const yesPrice = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : lastPrice || 0.5;
          markets.push({
            source: 'Kalshi',
            title: m.title || m.subtitle || '',
            yesPrice, // implied probability
            noPrice: 1 - yesPrice,
            volume: parseFloat(m.volume_24h_fp || m.volume_24h) || 0,
            ticker: m.ticker || '',
          });
        }
      }
    }
  } catch (e) {
    console.log(`[v10] Kalshi fetch failed: ${e.message}`);
  }

  // Polymarket — broader but less sports-specific
  try {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false&end_date_min=${now.toISOString()}&end_date_max=${tomorrow.toISOString()}`);
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data || [])) {
        const q = (m.question || m.groupItemTitle || '').toLowerCase();
        if (/nba|nhl|mlb|ncaa|nfl|soccer|over|under|spread|win|playoff|series/.test(q)) {
          const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
          markets.push({
            source: 'Polymarket',
            title: m.question || m.groupItemTitle || '',
            yesPrice: parseFloat(prices[0]) || 0.5,
            noPrice: parseFloat(prices[1]) || 0.5,
            volume: parseFloat(m.volume24hr) || 0,
            ticker: m.slug || '',
          });
        }
      }
    }
  } catch (e) {
    console.log(`[v10] Polymarket fetch failed: ${e.message}`);
  }

  console.log(`[v10] Prediction markets: ${markets.length} sports markets found`);
  return markets;
}

// ── Match prediction market to a candidate and compute agreement signal ──
function getPredictionMarketSignal(candidate, predictionMarkets) {
  if (!predictionMarkets || predictionMarkets.length === 0) return null;

  const homeNorm = candidate.homeTeam.toLowerCase();
  const awayNorm = candidate.awayTeam.toLowerCase();
  const homeLast = homeNorm.split(' ').pop();
  const awayLast = awayNorm.split(' ').pop();

  for (const pm of predictionMarkets) {
    const title = pm.title.toLowerCase();
    // Match by team name (last word — "bucks", "leafs", etc.)
    const matchesHome = title.includes(homeLast) && homeLast.length > 3;
    const matchesAway = title.includes(awayLast) && awayLast.length > 3;
    if (!matchesHome && !matchesAway) continue;

    // Found a matching market — compare implied probability
    // pm.yesPrice is the implied probability of the "yes" outcome
    // We need to determine if the market agrees with our pick direction
    const ourCoverProb = candidate.coverProb;
    const marketProb = pm.yesPrice; // rough proxy

    // Agreement: market and model within 10% → confirming signal
    // Disagreement: market and model differ by 15%+ → caution signal
    const gap = Math.abs(ourCoverProb - marketProb);

    return {
      source: pm.source,
      title: pm.title,
      marketProb: +marketProb.toFixed(3),
      modelProb: +ourCoverProb.toFixed(3),
      gap: +gap.toFixed(3),
      agrees: gap < 0.10,
      disagrees: gap > 0.15,
      volume: pm.volume,
    };
  }
  return null;
}

// ── Apply prediction market confidence adjustment to Kelly units ──
function applyPredictionMarketAdjustment(candidate, signal) {
  if (!signal) return candidate.kellyUnits; // no matching market — no change

  let adjustedUnits = candidate.kellyUnits;

  if (signal.agrees && signal.volume > 1000) {
    // Market confirms our edge — boost units by 0.5u (max)
    adjustedUnits = Math.min(candidate.kellyUnits + 0.5, 3.0);
    console.log(`[v10-pm] CONFIRMING: ${candidate.side} — ${signal.source} agrees (model=${signal.modelProb}, market=${signal.marketProb}). Units: ${candidate.kellyUnits}u → ${adjustedUnits}u`);
  } else if (signal.disagrees && signal.volume > 1000) {
    // Market disagrees — reduce units by 0.5u (min 0.5)
    adjustedUnits = Math.max(candidate.kellyUnits - 0.5, 0.5);
    console.log(`[v10-pm] CAUTION: ${candidate.side} — ${signal.source} disagrees (model=${signal.modelProb}, market=${signal.marketProb}). Units: ${candidate.kellyUnits}u → ${adjustedUnits}u`);
  }

  return adjustedUnits;
}

// ── Refresh ratings if stale ──
async function refreshRatingsIfNeeded() {
  const siteURL = process.env.URL || "https://webetsocial.com";
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;

  // Check age of current ratings
  let ratingsAge = Infinity;
  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.generatedAt) {
        ratingsAge = Date.now() - new Date(data.generatedAt).getTime();
      }
    }
  } catch (e) { /* treat as stale */ }

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (ratingsAge < SIX_HOURS) {
    console.log(`[v10] Ratings are fresh (${Math.round(ratingsAge / 60000)}min old), skipping refresh`);
    return;
  }

  console.log(`[v10] Ratings are stale (${Math.round(ratingsAge / 60000)}min old), triggering refresh...`);
  try {
    await fetch(`${siteURL}/.netlify/functions/build-ratings-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manual: true, timestamp: new Date().toISOString() }),
    });

    // Poll for freshness (max 3 minutes)
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const checkResp = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
          { headers: { "Authorization": `Bearer ${token}` } }
        );
        if (checkResp.ok) {
          const checkData = await checkResp.json();
          if (checkData.generatedAt) {
            const age = Date.now() - new Date(checkData.generatedAt).getTime();
            if (age < 5 * 60 * 1000) { // < 5 min old
              console.log(`[v10] Ratings refreshed successfully`);
              return;
            }
          }
        }
      } catch (e) { /* continue polling */ }
    }
    console.log(`[v10] Ratings refresh timed out, continuing with existing data`);
  } catch (e) {
    console.log(`[v10] Ratings refresh trigger failed: ${e.message}`);
  }
}

// ── Build consensus lines lookup from odds data ──
function buildConsensusLookup(oddsData) {
  const lookup = {};
  if (!oddsData) return lookup;

  for (const sportOdds of oddsData) {
    for (const game of sportOdds.games) {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const entry = { homeTeam, awayTeam, sport: sportOdds.sport };

      const allSpreads = [], allTotals = [], spreadOdds = {}, totalOdds = { Over: [], Under: [] }, allH2H = {};
      for (const book of (game.bookmakers || [])) {
        for (const mkt of (book.markets || [])) {
          if (mkt.key === 'spreads') {
            for (const o of mkt.outcomes) {
              if (o.point !== undefined) {
                allSpreads.push({ team: o.name, spread: o.point });
                if (!spreadOdds[o.name]) spreadOdds[o.name] = [];
                spreadOdds[o.name].push(o.price);
              }
            }
          }
          if (mkt.key === 'totals') {
            for (const o of mkt.outcomes) {
              if (o.point !== undefined) {
                if (o.name === 'Over') { allTotals.push(o.point); totalOdds.Over.push(o.price); }
                if (o.name === 'Under') { totalOdds.Under.push(o.price); }
              }
            }
          }
          if (mkt.key === 'h2h') {
            for (const o of mkt.outcomes) {
              if (!allH2H[o.name]) allH2H[o.name] = [];
              allH2H[o.name].push(o.price);
            }
          }
        }
      }

      // Median home spread + odds
      const homeSpreads = allSpreads.filter(s => s.team === homeTeam).map(s => s.spread);
      if (homeSpreads.length > 0) {
        homeSpreads.sort((a, b) => a - b);
        entry.homeSpread = homeSpreads[Math.floor(homeSpreads.length / 2)];
        entry.awaySpread = -entry.homeSpread;
      }
      for (const [team, prices] of Object.entries(spreadOdds)) {
        prices.sort((a, b) => a - b);
        const medianPrice = prices[Math.floor(prices.length / 2)];
        if (team === homeTeam) entry.homeSpreadOdds = medianPrice;
        else if (team === awayTeam) entry.awaySpreadOdds = medianPrice;
      }

      // Median total + odds
      if (allTotals.length > 0) {
        allTotals.sort((a, b) => a - b);
        entry.total = allTotals[Math.floor(allTotals.length / 2)];
        if (totalOdds.Over.length > 0) {
          totalOdds.Over.sort((a, b) => a - b);
          entry.overOdds = totalOdds.Over[Math.floor(totalOdds.Over.length / 2)];
        }
        if (totalOdds.Under.length > 0) {
          totalOdds.Under.sort((a, b) => a - b);
          entry.underOdds = totalOdds.Under[Math.floor(totalOdds.Under.length / 2)];
        }
      }

      // Median ML
      for (const [team, prices] of Object.entries(allH2H)) {
        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        if (team === homeTeam) entry.homeML = median;
        else if (team === awayTeam) entry.awayML = median;
      }

      lookup[homeTeam.toLowerCase()] = entry;
      lookup[awayTeam.toLowerCase()] = entry;
      const homeLast = homeTeam.toLowerCase().split(/\s+/).pop();
      const awayLast = awayTeam.toLowerCase().split(/\s+/).pop();
      if (homeLast.length > 3 && !lookup[homeLast]) lookup[homeLast] = entry;
      if (awayLast.length > 3 && !lookup[awayLast]) lookup[awayLast] = entry;
    }
  }
  return lookup;
}

function normalizeTeamName(name) {
  // Strip accents (é→e, ñ→n, etc.) and normalize punctuation
  return name.toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function findConsensusLine(lookup, teamName) {
  if (!teamName || !lookup) return null;
  const lower = normalizeTeamName(teamName);
  // Direct match
  if (lookup[lower]) return lookup[lower];
  // Try normalized against all keys
  for (const [key, val] of Object.entries(lookup)) {
    const normKey = normalizeTeamName(key);
    if (normKey === lower) return val;
  }
  // Last word match
  const lastWord = lower.split(/\s+/).pop();
  if (lastWord.length > 3) {
    for (const [key, val] of Object.entries(lookup)) {
      const keyLast = normalizeTeamName(key).split(/\s+/).pop();
      if (keyLast === lastWord) return val;
    }
  }
  // Partial match
  for (const [key, val] of Object.entries(lookup)) {
    const normKey = normalizeTeamName(key);
    if (normKey.includes(lower) || lower.includes(normKey)) return val;
  }
  return null;
}

function findTeam(teams, name) {
  if (!name || !teams) return null;
  if (teams[name]) return teams[name];
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(teams)) {
    if (key.toLowerCase() === lower) return val;
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
    const lastWord = lower.split(/\s+/).pop();
    const keyLast = key.toLowerCase().split(/\s+/).pop();
    if (lastWord === keyLast && lastWord.length > 3) return val;
    if (val.abbr && val.abbr.toLowerCase() === lower) return val;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// PHASE 1: DETERMINISTIC COMPUTATION PIPELINE
// All projections, edges, and Kelly sizing computed in JS.
// Ensemble projection: averages multiple methods per sport.
// ══════════════════════════════════════════════════════��═══════

// ── Star player injury impact (points/goals per game shift when OUT) ──
// Positive = team scores fewer points without this player
const INJURY_IMPACT = {
  // NBA — top impact players (estimated PPG swing when out)
  "Nikola Jokic": 8.5, "Luka Doncic": 7.5, "Shai Gilgeous-Alexander": 7.0,
  "Giannis Antetokounmpo": 7.5, "Joel Embiid": 7.0, "Jayson Tatum": 6.5,
  "Stephen Curry": 6.5, "Kevin Durant": 6.5, "LeBron James": 6.0,
  "Anthony Davis": 5.5, "Donovan Mitchell": 5.5, "Ja Morant": 5.5,
  "Jimmy Butler": 5.0, "Damian Lillard": 5.0, "Trae Young": 5.0,
  "Anthony Edwards": 5.5, "De'Aaron Fox": 5.0, "Tyrese Haliburton": 5.0,
  "Paolo Banchero": 4.5, "Cade Cunningham": 4.5, "Scottie Barnes": 4.5,
  "Devin Booker": 5.0, "Karl-Anthony Towns": 4.5, "Zion Williamson": 4.5,
  "Jalen Brunson": 5.0, "Darius Garland": 4.0, "Lauri Markkanen": 4.0,
  // NHL — top impact players (estimated goals/game swing when out)
  "Connor McDavid": 0.4, "Auston Matthews": 0.35, "Nathan MacKinnon": 0.35,
  "Nikita Kucherov": 0.3, "Leon Draisaitl": 0.3, "David Pastrnak": 0.3,
  "Cale Makar": 0.25, "Kirill Kaprizov": 0.3, "Jack Hughes": 0.25,
  "Mika Zibanejad": 0.2, "Matthew Tkachuk": 0.25, "Sidney Crosby": 0.25,
  "Artemi Panarin": 0.25, "Tage Thompson": 0.25, "Alex Ovechkin": 0.2,
  // NCAAB — top impact players (estimated PPG swing)
  "Cooper Flagg": 5.0, "Dylan Harper": 4.5, "Ace Bailey": 4.5,
  "Kasparas Jakucionis": 4.0, "Johni Broome": 4.5, "Mark Sears": 4.0,
  "RJ Davis": 4.0, "Hunter Dickinson": 4.0, "Caleb Love": 3.5,
};

function computeInjuryAdjustment(injuries, sport) {
  if (!injuries || injuries.length === 0) return 0;
  let totalImpact = 0;
  for (const inj of injuries) {
    // Only count players who are OUT or Doubtful
    const status = (inj.status || '').toLowerCase();
    if (status === 'out' || status === 'doubtful' || status.includes('out for season')) {
      const impact = INJURY_IMPACT[inj.name] || 0;
      // Doubtful = 70% chance out, Out = 100%
      const factor = status === 'doubtful' ? 0.7 : 1.0;
      totalImpact += impact * factor;
    }
  }
  return totalImpact;
}

// ── Ensemble projection: runs multiple methods and averages ──
function computeProjection(game, leagueName, leagueConfig, homeRating, awayRating, teamStats) {
  const homeStats = teamStats?.[game.home];
  const awayStats = teamStats?.[game.away];
  const sportType = leagueConfig ? leagueConfig.sport : null;

  // Collect all available projection methods
  const projections = []; // Array of { home, away, weight, method }

  // ── METHOD 1: Elo-based historical averages (always available) ──
  // Uses home/away splits from ratings blob
  const eloHomeScore = ((homeRating.homeAvgScored || homeRating.avgScored10 || 100) + (awayRating.awayAvgAllowed || awayRating.avgAllowed10 || 100)) / 2;
  const eloAwayScore = ((awayRating.awayAvgScored || awayRating.avgScored10 || 100) + (homeRating.homeAvgAllowed || homeRating.avgAllowed10 || 100)) / 2;
  if (eloHomeScore > 0 && eloAwayScore > 0) {
    projections.push({ home: eloHomeScore, away: eloAwayScore, weight: 1.0, method: "elo-historical" });
  }

  // ── METHOD 2: Sport-specific efficiency model (when ESPN stats available) ──
  if (sportType === 'hockey' && homeStats?.sport === 'hockey' && awayStats?.sport === 'hockey'
      && homeStats.shotsFor && awayStats.shotsFor && homeStats.savePct && awayStats.savePct) {
    const homeExpShots = (homeStats.shotsFor + (awayStats.shotsAgainst || homeStats.shotsFor)) / 2;
    const awayExpShots = (awayStats.shotsFor + (homeStats.shotsAgainst || awayStats.shotsFor)) / 2;
    const lgAvgSavePct = 0.905;
    const homeSaveFactor = awayStats.savePct ? (1 - awayStats.savePct) / (1 - lgAvgSavePct) : 1.0;
    const awaySaveFactor = homeStats.savePct ? (1 - homeStats.savePct) / (1 - lgAvgSavePct) : 1.0;
    const effHome = Math.max(homeExpShots * (homeStats.shootingPct || 0.10) * homeSaveFactor, 1.0);
    const effAway = Math.max(awayExpShots * (awayStats.shootingPct || 0.10) * awaySaveFactor, 1.0);
    projections.push({ home: effHome, away: effAway, weight: 1.5, method: "nhl-shot-efficiency" });

  } else if (sportType === 'baseball' && homeStats?.sport === 'baseball' && awayStats?.sport === 'baseball'
             && homeStats.pointsPerGame && awayStats.pointsPerGame) {
    let effHome, effAway, method;
    if (homeStats.era && awayStats.era) {
      effHome = homeStats.pointsPerGame * (awayStats.era / 4.00);
      effAway = awayStats.pointsPerGame * (homeStats.era / 4.00);
      method = "mlb-pitching-adjusted";
    } else {
      effHome = (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2;
      effAway = (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2;
      method = "mlb-runs-average";
    }
    projections.push({ home: Math.max(effHome, 1.5), away: Math.max(effAway, 1.5), weight: 1.5, method });

  } else if (sportType === 'soccer' && homeStats?.sport === 'soccer' && awayStats?.sport === 'soccer'
             && homeStats.pointsPerGame && awayStats.pointsPerGame) {
    let effHome, effAway, method;
    if (homeStats.shotsOnGoal && awayStats.shotsOnGoal && homeStats.conversionRate && awayStats.conversionRate) {
      const homeExpSOT = (homeStats.shotsOnGoal + awayStats.shotsOnGoal) / 2;
      effHome = homeExpSOT * homeStats.conversionRate;
      effAway = homeExpSOT * awayStats.conversionRate;
      method = "soccer-shot-efficiency";
    } else {
      effHome = (homeStats.pointsPerGame + (awayStats.pointsAllowed || homeStats.pointsPerGame)) / 2;
      effAway = (awayStats.pointsPerGame + (homeStats.pointsAllowed || awayStats.pointsPerGame)) / 2;
      method = "soccer-goal-average";
    }
    projections.push({ home: Math.max(effHome, 0.3), away: Math.max(effAway, 0.3), weight: 1.5, method });

  } else if (homeStats?.offensiveRating && homeStats?.defensiveRating && homeStats?.pace &&
      awayStats?.offensiveRating && awayStats?.defensiveRating && awayStats?.pace) {
    // Basketball: pace-adjusted efficiency
    const avgPace = (homeStats.pace + awayStats.pace) / 2;
    const lgAvgDRtg = LEAGUE_AVG_DRTG[leagueName] || 110;
    const effHome = avgPace * (homeStats.offensiveRating / 100) * (awayStats.defensiveRating / lgAvgDRtg);
    const effAway = avgPace * (awayStats.offensiveRating / 100) * (homeStats.defensiveRating / lgAvgDRtg);
    projections.push({ home: effHome, away: effAway, weight: 1.5, method: "pace-adjusted-efficiency" });
  }

  // ── METHOD 3: PPG/PPG-allowed average (when available but efficiency isn't) ──
  if (homeStats?.pointsPerGame && homeStats?.pointsAllowed &&
      awayStats?.pointsPerGame && awayStats?.pointsAllowed &&
      !projections.find(p => p.method.includes('efficiency') || p.method.includes('pitching') || p.method.includes('pace'))) {
    const ppgHome = (homeStats.pointsPerGame + awayStats.pointsAllowed) / 2;
    const ppgAway = (awayStats.pointsPerGame + homeStats.pointsAllowed) / 2;
    projections.push({ home: ppgHome, away: ppgAway, weight: 1.2, method: "ppg-average" });
  }

  // ── ENSEMBLE: weighted average of all available methods ──
  let projHomeScore, projAwayScore, projMethod;
  if (projections.length === 1) {
    projHomeScore = projections[0].home;
    projAwayScore = projections[0].away;
    projMethod = projections[0].method;
  } else if (projections.length >= 2) {
    const totalWeight = projections.reduce((s, p) => s + p.weight, 0);
    projHomeScore = projections.reduce((s, p) => s + p.home * p.weight, 0) / totalWeight;
    projAwayScore = projections.reduce((s, p) => s + p.away * p.weight, 0) / totalWeight;
    projMethod = "ensemble(" + projections.map(p => p.method).join("+") + ")";
  } else {
    projHomeScore = 100;
    projAwayScore = 100;
    projMethod = "fallback";
  }

  // ── INJURY ADJUSTMENT: shift projections based on star player absence ──
  const homeInjImpact = computeInjuryAdjustment(game.homeInjuries, sportType);
  const awayInjImpact = computeInjuryAdjustment(game.awayInjuries, sportType);
  if (homeInjImpact > 0 || awayInjImpact > 0) {
    projHomeScore -= homeInjImpact;
    projAwayScore -= awayInjImpact;
    if (homeInjImpact > 0 || awayInjImpact > 0) {
      projMethod += ` [inj: home-${homeInjImpact.toFixed(1)}, away-${awayInjImpact.toFixed(1)}]`;
    }
  }

  // NCAAB neutral site detection
  let effectiveHomeAdv = leagueConfig?.homeAdv || 80;
  if (leagueName === 'NCAAB' && game.venue) {
    const now = new Date();
    const month = now.getMonth() + 1;
    if ((month === 3 && now.getDate() >= 15) || month === 4) effectiveHomeAdv = 0;
  }

  const homeEloAdj = homeRating.elo + effectiveHomeAdv;
  const homeWinProb = eloExpected(homeEloAdj, awayRating.elo);
  const projSpread = -(projHomeScore - projAwayScore);
  const projTotal = projHomeScore + projAwayScore;

  return { projHomeScore, projAwayScore, projSpread, projTotal, projMethod, homeWinProb, homeEloAdj, effectiveHomeAdv };
}

function computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, drawdownActive, calibrationData) {
  const candidates = [];
  if (!espnData || !ratingsData) return candidates;

  for (const league of espnData) {
    const leagueConfig = ESPN_LEAGUES.find(l => l.label === league.league);
    if (!leagueConfig) continue;
    const leagueRatings = ratingsData?.leagues?.[league.league];
    if (!leagueRatings?.teams) continue;

    for (const game of league.games) {
      const homeRating = findTeam(leagueRatings.teams, game.home);
      const awayRating = findTeam(leagueRatings.teams, game.away);
      if (!homeRating || !awayRating) continue;

      const proj = computeProjection(game, league.league, leagueConfig, homeRating, awayRating, teamStats);
      const gameData = findConsensusLine(consensusLookup, game.home);
      if (!gameData || gameData.homeSpread === undefined) {
        console.log(`[v10-edge] SKIP ${game.away} @ ${game.home} (${league.league}) — no consensus line found for "${game.home}"`);
        continue;
      }
      const spreadEdgeDbg = Math.abs(proj.projSpread - gameData.homeSpread);
      const totalEdgeDbg = gameData.total ? Math.abs(proj.projTotal - gameData.total) : 0;
      console.log(`[v10-edge] ${game.away} @ ${game.home} (${league.league}) — projSpread=${proj.projSpread.toFixed(1)}, consSpread=${gameData.homeSpread}, spreadEdge=${spreadEdgeDbg.toFixed(1)}, projTotal=${proj.projTotal.toFixed(1)}, consTotal=${gameData.total || '?'}, totalEdge=${totalEdgeDbg.toFixed(1)}, method=${proj.projMethod}`);

      const std = SPORT_STD_DEVS[league.league] || 12;
      const minEdge = SPORT_MIN_EDGE[league.league] || 2.0;
      const homeStats = teamStats?.[game.home];
      const awayStats = teamStats?.[game.away];

      const baseCandidate = {
        matchup: `${game.away} @ ${game.home}`,
        sport: league.league,
        homeTeam: game.home,
        awayTeam: game.away,
        venue: game.venue || "",
        homeElo: homeRating.elo,
        awayElo: awayRating.elo,
        homeWinProb: +(proj.homeWinProb * 100).toFixed(1),
        projHomeScore: +proj.projHomeScore.toFixed(1),
        projAwayScore: +proj.projAwayScore.toFixed(1),
        projMethod: proj.projMethod,
        homeStreak: homeRating.streak || 0,
        awayStreak: awayRating.streak || 0,
        homeRest: homeRating.daysSinceLastGame,
        awayRest: awayRating.daysSinceLastGame,
        homeCoverRate: homeRating.coverRate,
        awayCoverRate: awayRating.coverRate,
        homeRecord: game.homeRecord,
        awayRecord: game.awayRecord,
        homeLast5: homeRating.last5 ? homeRating.last5.map(g => g.result).join("") : "",
        awayLast5: awayRating.last5 ? awayRating.last5.map(g => g.result).join("") : "",
        homeAvgScored5: homeRating.avgScored5,
        homeAvgAllowed5: homeRating.avgAllowed5,
        awayAvgScored5: awayRating.avgScored5,
        awayAvgAllowed5: awayRating.avgAllowed5,
        homeInjuries: game.homeInjuries || [],
        awayInjuries: game.awayInjuries || [],
        homeStats: homeStats || null,
        awayStats: awayStats || null,
      };

      // ── SPREAD CANDIDATE ──
      const actualSpread = gameData.homeSpread;
      const spreadEdge = Math.abs(proj.projSpread - actualSpread);
      if (spreadEdge >= minEdge) {
        const spreadZ = spreadEdge / std;
        // Determine bet type for calibration cap lookup
        let betType = "Spread";
        if (league.league === "NHL") betType = "Puck Line";
        else if (league.league === "MLB") betType = "Run Line";
        const rawCoverProb = normalCDF(spreadZ);
        const coverProb = getCalibratedCoverProb(rawCoverProb, league.league, betType);
        // Determine pick side
        const isHomeCover = proj.projSpread < actualSpread; // model says home does better than line
        const side = isHomeCover
          ? `${game.home} ${actualSpread > 0 ? '+' : ''}${actualSpread}`
          : `${game.away} ${gameData.awaySpread > 0 ? '+' : ''}${gameData.awaySpread}`;
        const odds = isHomeCover ? (gameData.homeSpreadOdds || -110) : (gameData.awaySpreadOdds || -110);

        // Skip if odds worse than -250
        if (odds >= -250) {
          const kelly = computeKelly(coverProb, odds, drawdownActive);
          if (kelly.ev > 0.03) {
            candidates.push({
              ...baseCandidate,
              market: betType,
              side,
              odds,
              modelProjection: +proj.projSpread.toFixed(1),
              consensusLine: actualSpread,
              edge: +spreadEdge.toFixed(1),
              zScore: +spreadZ.toFixed(3),
              coverProb: +coverProb.toFixed(4),
              impliedProb: +impliedProb(odds).toFixed(4),
              ev: +kelly.ev.toFixed(4),
              kellyFraction: +kelly.kellyFraction.toFixed(4),
              kellyUnits: kelly.units,
              decimalPayout: +kelly.decPayout.toFixed(3),
              kellyCalcStr: `coverProb=${coverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_quarter=${kelly.kellyFraction.toFixed(4)}, units=${kelly.units}u`,
            });
          }
        }
      }

      // ── TOTAL CANDIDATE ──
      const actualTotal = gameData.total;
      if (actualTotal) {
        const totalEdge = Math.abs(proj.projTotal - actualTotal);
        const totalMinEdge = league.league === "NHL" ? 0.5 : league.league === "MLB" ? 0.8 : 3.0;
        if (totalEdge >= totalMinEdge) {
          const totalZ = totalEdge / std;
          const rawTotalCoverProb = normalCDF(totalZ);
          const totalCoverProb = getCalibratedCoverProb(rawTotalCoverProb, league.league, "Total");
          const isOver = proj.projTotal > actualTotal;
          const totalSide = `${isOver ? "Over" : "Under"} ${actualTotal}`;
          const totalOdds = isOver ? (gameData.overOdds || -110) : (gameData.underOdds || -110);

          if (totalOdds >= -250) {
            const kelly = computeKelly(totalCoverProb, totalOdds, drawdownActive);
            if (kelly.ev > 0.03) {
              candidates.push({
                ...baseCandidate,
                market: "Total",
                side: totalSide,
                odds: totalOdds,
                modelProjection: +proj.projTotal.toFixed(1),
                consensusLine: actualTotal,
                edge: +totalEdge.toFixed(1),
                zScore: +totalZ.toFixed(3),
                coverProb: +totalCoverProb.toFixed(4),
                impliedProb: +impliedProb(totalOdds).toFixed(4),
                ev: +kelly.ev.toFixed(4),
                kellyFraction: +kelly.kellyFraction.toFixed(4),
                kellyUnits: kelly.units,
                decimalPayout: +kelly.decPayout.toFixed(3),
                kellyCalcStr: `coverProb=${totalCoverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_quarter=${kelly.kellyFraction.toFixed(4)}, units=${kelly.units}u`,
              });
            }
          }
        }
      }
    }
  }

  // Sort by z-score descending (normalized edge across all sports)
  candidates.sort((a, b) => b.zScore - a.zScore);

  // Assign ranks
  candidates.forEach((c, i) => { c.rank = i + 1; });

  return candidates;
}

// ── Format candidate table for Claude prompt ──
function formatCandidateTable(candidates, dateISO, dateFormatted) {
  const top = candidates.slice(0, 15);
  let prompt = `TODAY: ${dateFormatted} (${dateISO})\n\n`;
  prompt += `${candidates.length} total edge candidates found across all sports. Here are the top ${top.length} ranked by normalized edge (z-score).\n`;
  prompt += `Your job: web search to verify injuries/news for top candidates, then SELECT up to 3.\n\n`;

  for (const c of top) {
    prompt += `━━━ #${c.rank} | ${c.sport} ${c.market} | z=${c.zScore.toFixed(2)} ━━━\n`;
    prompt += `  ${c.matchup}\n`;
    prompt += `  PICK: ${c.side} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds} | Edge: ${c.edge}${c.market === 'Total' ? 'pts' : c.sport === 'NHL' ? ' goals' : 'pts'}\n`;
    prompt += `  Cover%: ${(c.coverProb * 100).toFixed(1)}% | Kelly: ${c.kellyUnits}u | EV: ${(c.ev * 100).toFixed(1)}%\n`;
    prompt += `  Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge}\n`;
    prompt += `  Elo: ${c.homeTeam} ${c.homeElo} / ${c.awayTeam} ${c.awayElo} | WinProb: ${c.homeTeam} ${c.homeWinProb}%\n`;
    prompt += `  Score Proj: ${c.homeTeam} ${c.projHomeScore} - ${c.awayTeam} ${c.projAwayScore} [${c.projMethod}]\n`;
    prompt += `  Rest: ${c.homeTeam} ${c.homeRest !== undefined ? c.homeRest + 'd' : '?'} / ${c.awayTeam} ${c.awayRest !== undefined ? c.awayRest + 'd' : '?'}`;
    if (c.homeRest !== undefined && c.homeRest <= 1) prompt += ` (${c.homeTeam} B2B)`;
    if (c.awayRest !== undefined && c.awayRest <= 1) prompt += ` (${c.awayTeam} B2B)`;
    prompt += `\n`;
    prompt += `  Streaks: ${c.homeTeam} ${formatStreak(c.homeStreak)} / ${c.awayTeam} ${formatStreak(c.awayStreak)}\n`;
    if (c.homeLast5) prompt += `  Last 5: ${c.homeTeam} ${c.homeLast5} (${c.homeAvgScored5 || '?'}/${c.homeAvgAllowed5 || '?'}) | ${c.awayTeam} ${c.awayLast5} (${c.awayAvgScored5 || '?'}/${c.awayAvgAllowed5 || '?'})\n`;
    if (c.homeCoverRate !== undefined) prompt += `  Cover Rate: ${c.homeTeam} ${c.homeCoverRate}% / ${c.awayTeam} ${c.awayCoverRate || '?'}%\n`;
    if (c.homeRecord) prompt += `  Records: ${c.homeTeam} ${c.homeRecord} / ${c.awayTeam} ${c.awayRecord}\n`;

    // Key injuries
    const homeInj = (c.homeInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    const awayInj = (c.awayInjuries || []).filter(i => i.status !== 'Active').slice(0, 3);
    if (homeInj.length > 0) prompt += `  ${c.homeTeam} injuries: ${homeInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;
    if (awayInj.length > 0) prompt += `  ${c.awayTeam} injuries: ${awayInj.map(i => `${i.name} (${i.status})`).join(', ')}\n`;

    // Sport-specific stats
    if (c.homeStats?.sport === 'hockey') {
      if (c.homeStats.savePct) prompt += `  Save%: ${c.homeTeam} ${(c.homeStats.savePct * 100).toFixed(1)}% / ${c.awayTeam} ${c.awayStats?.savePct ? (c.awayStats.savePct * 100).toFixed(1) + '%' : '?'}\n`;
      if (c.homeStats.shootingPct) prompt += `  Shooting%: ${c.homeTeam} ${(c.homeStats.shootingPct * 100).toFixed(1)}% / ${c.awayTeam} ${c.awayStats?.shootingPct ? (c.awayStats.shootingPct * 100).toFixed(1) + '%' : '?'}\n`;
    } else if (c.homeStats?.sport === 'basketball') {
      if (c.homeStats.offensiveRating) prompt += `  ORtg: ${c.homeTeam} ${c.homeStats.offensiveRating} / ${c.awayTeam} ${c.awayStats?.offensiveRating || '?'} | DRtg: ${c.homeTeam} ${c.homeStats.defensiveRating} / ${c.awayTeam} ${c.awayStats?.defensiveRating || '?'}\n`;
      if (c.homeStats.pace) prompt += `  Pace: ${c.homeTeam} ${c.homeStats.pace} / ${c.awayTeam} ${c.awayStats?.pace || '?'}\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}

// ── Build final picks from JS candidates + Claude selections ──
function buildFinalPicks(candidateTable, claudeSelections, allCandidates) {
  const picks = [];
  for (const sel of claudeSelections) {
    const c = candidateTable.find(x => x.rank === sel.candidateRank);
    if (!c) {
      console.log(`[v10] WARNING: Claude selected rank ${sel.candidateRank} which is not in candidate table — skipping`);
      continue;
    }

    // Enforce: Claude can reduce units but never increase
    let finalUnits = c.kellyUnits;
    if (sel.adjustedUnits) {
      const claudeUnits = parseFloat(String(sel.adjustedUnits).replace(/[^0-9.]/g, ''));
      if (!isNaN(claudeUnits) && claudeUnits < c.kellyUnits) {
        finalUnits = Math.max(0.5, Math.round(claudeUnits * 2) / 2); // round to 0.5
      }
    }

    picks.push({
      sport: c.sport,
      matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
      pick: c.side,
      betType: c.market,
      odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
      rating: unitsToRating(finalUnits),
      confidence: unitsToConfidence(finalUnits),
      units: `${finalUnits}u`,
      kellyCalc: c.kellyCalcStr,
      winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
      coreReasoning: sel.coreReasoning || "",
      whatLoses: sel.whatLoses || "",
      dataVerified: sel.dataVerified || "",
      clvExpectation: sel.clvExpectation || "",
      modelEdge: `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${c.sport === 'NHL' ? 'goals' : 'pts'}`,
    });
  }

  // Enforce 4.0u daily cap
  let totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  if (totalUnits > 4.0) {
    console.log(`[v10] Daily cap: ${totalUnits}u > 4.0u, reducing smallest-edge picks`);
    const indices = picks.map((_, i) => i);
    indices.sort((a, b) => parseFloat(picks[a].units) - parseFloat(picks[b].units));
    while (totalUnits > 4.0) {
      let reduced = false;
      for (const idx of indices) {
        const u = parseFloat(picks[idx].units);
        if (u > 0.5) {
          picks[idx].units = `${u - 0.5}u`;
          totalUnits -= 0.5;
          reduced = true;
          break;
        }
      }
      if (!reduced) break;
    }
    // Re-assign ratings after cap adjustment
    for (const p of picks) {
      const u = parseFloat(p.units);
      p.rating = unitsToRating(u);
      p.confidence = unitsToConfidence(u);
    }
  }

  // Sort by units descending (highest confidence first)
  picks.sort((a, b) => parseFloat(b.units) - parseFloat(a.units));

  return picks;
}

// ── Compute bankroll context + drawdown detection ──
async function computeBankrollContext() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return { drawdownActive: false, context: "BANKROLL: $15,000 starting, unit value $150." };

  const startingBankroll = 15000;
  let totalProfit = 0;
  let recentResults = [];

  try {
    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks`;
    const authHeaders = { Authorization: `Bearer ${token}` };
    const datesResp = await fetch(`${storeUrl}/picks-dates`, { headers: authHeaders });
    if (datesResp.ok) {
      const datesArr = await datesResp.json();
      for (const d of datesArr.slice(-10)) {
        try {
          const pResp = await fetch(`${storeUrl}/picks-${d}`, { headers: authHeaders });
          if (pResp.ok) {
            const pData = await pResp.json();
            for (const p of (pData.picks || [])) {
              if (p.result === 'win' || p.result === 'loss') {
                recentResults.push(p.result);
                totalProfit += (p.profit || 0);
              }
            }
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error(`[v10] Bankroll calc error: ${e.message}`);
  }

  const last5 = recentResults.slice(-5);
  let consecutiveLosses = 0;
  for (let i = last5.length - 1; i >= 0; i--) {
    if (last5[i] === 'loss') consecutiveLosses++;
    else break;
  }
  const drawdownActive = consecutiveLosses >= 3;

  const currentBankroll = startingBankroll + totalProfit;
  console.log(`[v10] Bankroll: $${currentBankroll}, Drawdown: ${drawdownActive}, Losses: ${consecutiveLosses}`);

  return { drawdownActive, currentBankroll, totalProfit, consecutiveLosses };
}

// ══════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  console.log("[v10] Background function started — Deterministic Edge Architecture");

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.error("[v10] ANTHROPIC_API_KEY not set");
    return { statusCode: 500, body: "Missing API key" };
  }

  const now = new Date();
  let dateISO, dateFormatted;

  try {
    const body = JSON.parse(event.body || '{}');
    if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      dateISO = body.date;
      const d = new Date(body.date + 'T12:00:00-05:00');
      dateFormatted = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
      }).format(d);
    }
    // Refresh ratings if requested or stale
    if (body.refreshRatings || body.scheduled) {
      await refreshRatingsIfNeeded();
    }
  } catch (e) { /* ignore */ }

  if (!dateISO) {
    const estFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const estParts = estFormatter.formatToParts(now);
    dateISO = `${estParts.find(p => p.type === "year").value}-${estParts.find(p => p.type === "month").value}-${estParts.find(p => p.type === "day").value}`;
    dateFormatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(now);
  }

  console.log(`[v10] Generating picks for ${dateISO}`);

  // ── PHASE 1: DETERMINISTIC DATA ASSEMBLY ──
  const [oddsData, espnData, ratingsData, calibrationData, bankrollCtx, predictionMarkets] = await Promise.all([
    fetchOdds(dateISO),
    fetchESPNData(dateISO),
    fetchRatings(),
    fetchCalibrationData(),
    computeBankrollContext(),
    fetchPredictionMarkets(),
  ]);

  const teamStats = await fetchTeamStats(espnData);
  const consensusLookup = buildConsensusLookup(oddsData);

  // Debug: log data availability
  console.log(`[v10] ESPN leagues: ${(espnData||[]).map(l => l.league + '(' + l.games.length + ')').join(', ')}`);
  console.log(`[v10] Odds sports: ${(oddsData||[]).map(s => s.sport + '(' + s.games.length + ')').join(', ')}`);
  console.log(`[v10] Ratings leagues: ${ratingsData ? Object.keys(ratingsData.leagues || {}).join(', ') : 'NONE'}`);
  console.log(`[v10] Team stats: ${Object.keys(teamStats).length} teams`);
  console.log(`[v10] Consensus lookup keys (sample): ${Object.keys(consensusLookup).slice(0, 8).join(', ')}`);

  // ── PHASE 1B: COMPUTE ALL EDGES DETERMINISTICALLY ──
  let allCandidates;
  try {
    allCandidates = computeEdgeTable(espnData, ratingsData, teamStats, consensusLookup, bankrollCtx.drawdownActive, calibrationData);
    console.log(`[v10] Computed ${allCandidates.length} edge candidates across all sports`);

    // ── PHASE 1C: PREDICTION MARKET CROSS-REFERENCE ──
    if (predictionMarkets.length > 0) {
      let confirms = 0, cautions = 0;
      for (const c of allCandidates) {
        const signal = getPredictionMarketSignal(c, predictionMarkets);
        if (signal) {
          c.predictionMarket = signal;
          const adjusted = applyPredictionMarketAdjustment(c, signal);
          if (adjusted !== c.kellyUnits) {
            c.kellyUnits = adjusted;
            c.kellyCalcStr += ` [PM ${signal.agrees ? 'CONFIRM' : 'CAUTION'}: ${signal.source} ${signal.marketProb}]`;
            if (signal.agrees) confirms++;
            else cautions++;
          }
        }
      }
      // Re-sort after adjustments (units changed → re-rank by EV)
      allCandidates.sort((a, b) => b.ev - a.ev);
      allCandidates.forEach((c, i) => { c.rank = i + 1; });
      console.log(`[v10] Prediction market adjustments: ${confirms} confirmed, ${cautions} cautioned`);
    }
  } catch (edgeErr) {
    console.error(`[v10] EDGE TABLE COMPUTATION FAILED: ${edgeErr.message}`);
    console.error(edgeErr.stack);
    allCandidates = [];
  }

  if (allCandidates.length === 0) {
    console.log("[v10] No edge candidates found — storing no-plays result");
    await storePicks(dateISO, {
      date: dateISO, dateFormatted, model: "v10.0-deterministic-edge",
      picks: [], rejections: [{ matchup: "All games", side: "All markets", reason: `No statistical edges exceeded minimum thresholds. ESPN: ${(espnData||[]).reduce((s,l)=>s+l.games.length,0)} games/${(espnData||[]).length} leagues. Odds: ${(oddsData||[]).reduce((s,l)=>s+l.games.length,0)} games. Ratings: ${ratingsData ? Object.keys(ratingsData.leagues||{}).length : 0} leagues. TeamStats: ${Object.keys(teamStats).length}. Consensus: ${Object.keys(consensusLookup).length} keys.` }],
      summary: { totalPicks: 0, totalStraightBets: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [], modelVersion: "v10.0-deterministic-edge" },
      edgeSummary: "No plays today — WeBetAI found no edges exceeding minimum thresholds across all sports.",
      generatedAt: now.toISOString(),
    });
    return { statusCode: 200, body: "No edge candidates" };
  }

  // ── PHASE 2: CLAUDE AS VALIDATOR + NARRATOR ──
  const candidateTable = allCandidates.slice(0, 15);
  const userMessage = formatCandidateTable(candidateTable, dateISO, dateFormatted);

  console.log(`[v10] Sending ${candidateTable.length} candidates to Claude (${userMessage.length} chars)`);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        temperature: 0.2,
        system: THE_LOCK_V10_SYSTEM,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20 }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[v10] Claude API error ${response.status}: ${errText}`);
      // Fallback: use top 3 candidates without narratives
      return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
    }

    const result = await response.json();
    console.log("[v10] Claude API response received, stop_reason:", result.stop_reason);

    let rawText = "";
    for (const block of result.content) {
      if (block.type === "text") rawText += block.text;
    }

    // Parse Claude's selection JSON
    let claudeOutput;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        try { claudeOutput = JSON.parse(jsonStr); }
        catch (e) {
          let fixed = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').replace(/[\x00-\x1F\x7F]/g, ' ');
          claudeOutput = JSON.parse(fixed);
        }
      } else {
        throw new Error("No JSON in Claude response");
      }
    } catch (parseErr) {
      console.error(`[v10] JSON parse failed: ${parseErr.message}`);
      return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
    }

    // ── PHASE 3: MERGE JS NUMBERS + CLAUDE NARRATIVES ──
    const selections = claudeOutput.selections || [];
    const picks = buildFinalPicks(candidateTable, selections, allCandidates);

    // Build rejections from Claude + all non-selected candidates
    const selectedRanks = new Set(picks.map(p => {
      const sel = selections.find(s => candidateTable.find(c => c.rank === s.candidateRank)?.side === p.pick);
      return sel?.candidateRank;
    }).filter(Boolean));

    const rejections = [];
    // Add Claude's explicit rejections
    for (const r of (claudeOutput.rejections || [])) {
      const c = candidateTable.find(x => x.rank === r.candidateRank);
      rejections.push({
        matchup: c ? c.matchup : `Candidate #${r.candidateRank}`,
        side: c ? c.side : "N/A",
        reason: r.reason || "No reason given",
      });
    }
    // Add remaining non-selected candidates as rejections
    for (const c of allCandidates.slice(0, 15)) {
      if (!selections.find(s => s.candidateRank === c.rank) && !rejections.find(r => r.matchup === c.matchup && r.side === c.side)) {
        rejections.push({ matchup: c.matchup, side: c.side, reason: "Not selected — lower edge priority." });
      }
    }

    // Build model projections snapshot
    const modelProjections = {};
    for (const c of allCandidates) {
      const key = c.matchup;
      if (!modelProjections[key]) {
        modelProjections[key] = {
          homeWinProb: c.homeWinProb,
          projSpread: c.market === "Total" ? undefined : c.modelProjection,
          projTotal: c.market === "Total" ? c.modelProjection : undefined,
          projMethod: c.projMethod,
          homeElo: c.homeElo, awayElo: c.awayElo,
          homeRest: c.homeRest, awayRest: c.awayRest,
        };
      }
      if (c.market === "Total") modelProjections[key].projTotal = c.modelProjection;
      else modelProjections[key].projSpread = c.modelProjection;
    }

    const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
    const sportsCovered = [...new Set(picks.map(p => p.sport))];

    const picksData = {
      date: dateISO,
      dateFormatted,
      model: "v10.0-deterministic-edge",
      picks,
      rejections,
      edgeSummary: claudeOutput.edgeSummary || "",
      summary: {
        totalPicks: picks.length,
        totalStraightBets: picks.length,
        totalUnits: `${totalUnits.toFixed(1)}u`,
        aplusLocks: picks.filter(p => p.rating === "A+").length,
        sportsCovered,
        modelVersion: "v10.0-deterministic-edge",
      },
      generatedAt: now.toISOString(),
      parlayLegs: [],
      sgps: [],
      modelProjections,
      edgeCandidatesCount: allCandidates.length,
    };

    // Store thinking text if present
    const jsonStart = rawText.indexOf('{');
    if (jsonStart > 50) {
      picksData.thinkingText = rawText.substring(0, jsonStart).trim();
    }

    await storePicks(dateISO, picksData);
    console.log(`[v10] SUCCESS: ${picks.length} picks for ${dateISO}`);
    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("[v10] Fatal error:", err.message);
    return await fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now);
  }
};

// ── Fallback: if Claude fails, use top 3 candidates with auto-generated narrative ──
async function fallbackToTopCandidates(dateISO, dateFormatted, candidateTable, allCandidates, now) {
  console.log("[v10] Using fallback: top 3 candidates without Claude narratives");
  const top3 = candidateTable.slice(0, 3);
  const picks = top3.map(c => ({
    sport: c.sport,
    matchup: `${c.awayTeam} vs. ${c.homeTeam}`,
    pick: c.side,
    betType: c.market,
    odds: `${c.odds > 0 ? '+' : ''}${c.odds}`,
    rating: unitsToRating(c.kellyUnits),
    confidence: unitsToConfidence(c.kellyUnits),
    units: `${c.kellyUnits}u`,
    kellyCalc: c.kellyCalcStr,
    winProbability: `${(c.coverProb * 100).toFixed(0)}%`,
    coreReasoning: `WeBetAI projects ${c.modelProjection} vs the line at ${c.consensusLine}, creating a ${c.edge}-${c.sport === 'NHL' ? 'goal' : 'point'} edge. The ${c.projMethod} model gives this a ${(c.coverProb * 100).toFixed(0)}% cover probability with ${(c.ev * 100).toFixed(1)}% expected value.`,
    whatLoses: "Opponent outperforms projections and covers the line.",
    dataVerified: "Auto-generated from deterministic model — Claude narrative unavailable.",
    clvExpectation: "Line may move toward pick as sharp money arrives.",
    modelEdge: `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge}`,
  }));

  const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const picksData = {
    date: dateISO, dateFormatted, model: "v10.0-deterministic-edge",
    picks,
    rejections: allCandidates.slice(3, 10).map(c => ({ matchup: c.matchup, side: c.side, reason: "Lower edge priority." })),
    edgeSummary: "WeBetAI's deterministic model found today's top edges across all sports. Picks ranked by normalized z-score.",
    summary: { totalPicks: picks.length, totalStraightBets: picks.length, totalUnits: `${totalUnits.toFixed(1)}u`, aplusLocks: 0, sportsCovered: [...new Set(picks.map(p => p.sport))], modelVersion: "v10.0-deterministic-edge" },
    generatedAt: now.toISOString(), parlayLegs: [], sgps: [],
    fallback: true,
  };

  await storePicks(dateISO, picksData);
  return { statusCode: 200, body: "Fallback OK" };
}

// ── Store picks to "edge-picks" blob store ──
async function storePicks(dateISO, picksData) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error("[v10] NETLIFY_AUTH_TOKEN not set, cannot store picks");
    return;
  }

  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks`;

  try {
    const putPicks = await fetch(`${storeUrl}/picks-${dateISO}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(picksData),
    });
    if (!putPicks.ok) {
      const errBody = await putPicks.text();
      console.error(`[v10] Blob PUT failed ${putPicks.status}: ${errBody.substring(0, 200)}`);
    } else {
      console.log("[v10] Picks stored via blob API");
    }

    await fetch(`${storeUrl}/latest-date`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "text/plain" },
      body: dateISO,
    });

    try {
      let datesArr = [];
      const getDates = await fetch(`${storeUrl}/picks-dates`, { headers: { "Authorization": `Bearer ${token}` } });
      if (getDates.ok) datesArr = await getDates.json();
      if (!Array.isArray(datesArr)) datesArr = [];
      if (!datesArr.includes(dateISO)) {
        datesArr.push(dateISO);
        datesArr.sort();
        await fetch(`${storeUrl}/picks-dates`, {
          method: "PUT",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(datesArr),
        });
        console.log(`[v10] Added ${dateISO} to picks-dates index (${datesArr.length} total)`);
      }
    } catch (e) {
      console.error(`[v10] picks-dates index update error: ${e.message}`);
    }
  } catch (err) {
    console.error(`[v10] Blob store error: ${err.message}`);
  }
}
