// generate-picks-be-background.js
// v10.0 — BettorEdge Enhanced Edge Architecture
// Isolated pipeline: same core math as v10, PLUS BettorEdge exchange data.
// Adds: vig-free exchange probabilities, per-book vig%, sharpest-line Kelly.
// Background function (15min timeout). Stores to "edge-picks-be" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const { bettoredgeFetch } = require("./bettoredge-auth");

// ── BETA system prompt: Claude as VERIFIER only — does NOT select picks ──
const THE_LOCK_V10_SYSTEM = `You are THE LOCK — WeBetAI's sports betting verification engine. You VERIFY pre-computed statistical edges using web search. You do NOT select picks, compute projections, or adjust unit sizing — the statistical model handles all of that.

YOUR INPUTS:
A ranked table of the top candidate picks with pre-computed edges, cover probabilities, Kelly units, and supporting team context. Candidates are ranked by expected value (EV). The system will automatically select the top 3 candidates that pass your verification.

YOUR JOB:
1. Use web search to verify injury status, recent news, goaltender confirmations (NHL), starting pitchers (MLB), and recent form for the top 8 candidates.
2. For EACH candidate, return a PASS or FAIL verdict. You must verify all 8.
3. You may only FAIL a candidate if web search reveals a MATERIAL change after the data cutoff:
   - Star player ruled out / downgraded AFTER the data was pulled (not already reflected in the injury list)
   - Goaltender change (NHL) not reflected in pre-computed data
   - Starting pitcher change (MLB)
   - Severe weather for outdoor sports
   - Material lineup or coaching change announced AFTER data cutoff
4. Write a 3-4 sentence coreReasoning narrative for each PASS candidate.
5. You MUST NOT override model direction, rankings, or recompute edges.
6. You MUST NOT adjust units. Unit sizing is final from the Kelly model.
7. You MUST NOT fail a candidate based on narrative preference, gut feeling, recent team record, vibes, or because you prefer a different pick. ONLY fail on material post-cutoff information discovered via web search.
8. Always say "WeBetAI" instead of "the model" or "our model" in narratives.

NARRATIVE RULES (for coreReasoning field):
- DO NOT write a projection/line/edge sentence. The system will prepend the correct math automatically.
- Your narrative must argue IN FAVOR of the pick side. If the pick is "Team X +17.5", explain why Team X covers that spread — NOT why the opponent wins. Frame the edge as the spread being too wide, the picked team being undervalued, or situational factors favoring a cover.
- "The team you're picking" = the team or direction named in the PICK field. For spreads, that's the team getting or giving points. For totals, that's the Over or Under direction.
- Start your coreReasoning with your first supporting fact — a verified insight from web search.
- Support with 2-3 distinct verified facts (form, injuries, rest, matchup factor).
- End with value statement explaining why the odds offer value.
- Max 4 sentences. No padding. No duplicate stats. Every sentence must add new information.
- DO NOT restate projections, lines, edges, cover probabilities, or any numbers from the candidate table.
- NEVER lead with negative data about the team you're picking. Do NOT build a case for the opponent — build the case for the PICK SIDE covering.
- NEVER use technical jargon like ORtg, DRtg, pace numbers, DVOA, ATS, or advanced stat abbreviations.

OUTPUT FORMAT — Return ONLY valid JSON (no text before or after the JSON):
{
  "verifications": [
    {
      "candidateRank": 1,
      "verdict": "PASS",
      "coreReasoning": "Start with a supporting fact, not projections...",
      "whatLoses": "One sentence — the specific scenario that beats this pick.",
      "dataVerified": "Brief note on what data you verified via web search.",
      "clvExpectation": "Your expectation for closing line movement."
    },
    {
      "candidateRank": 4,
      "verdict": "FAIL",
      "failReason": "Specific post-cutoff material change discovered via web search.",
      "dataVerified": "What you found in web search that triggered the fail."
    }
  ],
  "edgeSummary": "1-2 sentence editorial-style Daily Edge Summary. Write it like a sharp sports analyst for a general audience — confident, specific, compelling. Reference actual matchups and WHY the edge exists. Use 'WeBetAI' not 'the model'. No advanced stat abbreviations (ORtg, DRtg, DVOA, ATS) — plain English only."
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

// Sport-specific Kelly multipliers — all equal until CLV feedback loop provides data-driven weighting
const SPORT_KELLY_MULT = {};
const LEAGUE_AVG_DRTG = { NBA: 112.0, NCAAB: 100.0, NHL: 100.0 };

// ── Edge discount curve: diminishing returns on large edges ──
// Edges above 10pts (or sport-equivalent) get log-compressed before Kelly sizing.
// Prevents oversizing on inflated projections that don't improve accuracy.
function applyEdgeDiscount(rawEdge, std) {
  const edgeInStdDevs = rawEdge / std;
  if (edgeInStdDevs <= 1.0) return rawEdge; // normal range, no discount
  // Log compression above 1 std dev: edge grows as log(1 + excess)
  const excess = edgeInStdDevs - 1.0;
  const discounted = 1.0 + Math.log(1 + excess);
  return discounted * std;
}

// ── B2B rest adjustment constants ──
// Teams on back-to-back score ~2-3% less (NBA/NHL empirical)
const B2B_SCORING_PENALTY = { NBA: 0.97, NHL: 0.97, NCAAB: 1.0, MLB: 1.0 };

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

// ── Parse prediction market title to extract bet type, handicap, direction, sport ─���
function parseMarketTitle(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase();
  let type = 'unknown', handicap = null, team = null, direction = null, sport = null;

  // Sport detection
  if (/\bnba\b|basketball/.test(text) && !/ncaa|college/.test(text)) sport = 'NBA';
  else if (/\bnhl\b|hockey/.test(text)) sport = 'NHL';
  else if (/\bmlb\b|baseball/.test(text)) sport = 'MLB';
  else if (/\bncaa\b|college basketball|march madness/.test(text)) sport = 'NCAAB';
  else if (/\bepl\b|premier league/.test(text)) sport = 'EPL';
  else if (/\bla liga\b/.test(text)) sport = 'La Liga';
  else if (/\bserie a\b/.test(text)) sport = 'Serie A';
  else if (/\bbundesliga\b/.test(text)) sport = 'Bundesliga';
  else if (/\bligue 1\b/.test(text)) sport = 'Ligue 1';
  else if (/\bmls\b/.test(text)) sport = 'MLS';
  else if (/\bucl\b|champions league/.test(text)) sport = 'UCL';
  else if (/\beuropa league\b/.test(text)) sport = 'Europa';

  // Total detection (check first — "over 225.5" is unambiguous)
  let m;
  if ((m = text.match(/over\s+([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'over';
  } else if ((m = text.match(/under\s+([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'under';
  } else if ((m = text.match(/total[s]?\s*(?:points?|goals?)?\s*(?:over|o\/u)?\s*([\d.]+)/))) {
    type = 'total'; handicap = parseFloat(m[1]); direction = 'over';
  }

  // Spread detection (team followed by +/- number)
  if (type === 'unknown') {
    if ((m = text.match(/(.+?)\s+([+-]\d+\.?\d*)\s*(?:spread|pts|points)?/))) {
      type = 'spread'; team = m[1].trim(); handicap = parseFloat(m[2]);
    } else if ((m = text.match(/spread\s*[:\-]?\s*(.+?)\s+([+-]?\d+\.?\d*)/))) {
      type = 'spread'; team = m[1].trim(); handicap = parseFloat(m[2]);
    } else if ((m = text.match(/cover\s+([+-]?\d+\.?\d*)/))) {
      type = 'spread'; handicap = parseFloat(m[1]);
    }
  }

  // Moneyline detection
  if (type === 'unknown') {
    if ((m = text.match(/will\s+(?:the\s+)?(.+?)\s+(?:win|beat|defeat)/))) {
      type = 'moneyline'; team = m[1].trim();
    } else if ((m = text.match(/(.+?)\s+to\s+win/))) {
      type = 'moneyline'; team = m[1].trim();
    } else if (/\bmoneyline\b|\bml\b|\bwin\b/.test(text)) {
      type = 'moneyline';
    }
  }

  return { type, handicap, team, direction, sport };
}

// ── Classify candidate bet type to canonical form ──
function classifyCandidateBetType(candidate) {
  const mkt = (candidate.market || '').toLowerCase();
  let type = 'unknown', handicap = null, direction = null;

  if (mkt === 'total') {
    type = 'total';
    const m = (candidate.side || '').match(/(over|under)\s+([\d.]+)/i);
    if (m) { direction = m[1].toLowerCase(); handicap = parseFloat(m[2]); }
  } else if (/spread|puck line|run line/.test(mkt)) {
    type = 'spread';
    const m = (candidate.side || '').match(/([+-]?\d+\.?\d*)/);
    if (m) handicap = parseFloat(m[1]);
  }

  return { type, handicap, direction };
}

// ── Compute quality weight for a prediction market signal (0.0-1.0) ──
function computeMarketQuality(market, alignmentType) {
  // Volume: continuous log scale
  const vol = Math.max(market.volume || 1, 1);
  const volumeWeight = Math.min(1.0, Math.log10(vol) / 5); // 100→0.4, 1K→0.6, 10K→0.8, 100K→1.0

  // Bid-ask spread (Kalshi only)
  let bidAskWeight = 1.0;
  if (market.bidAskSpread !== null && market.bidAskSpread !== undefined) {
    if (market.bidAskSpread < 0.03) bidAskWeight = 1.0;
    else if (market.bidAskSpread < 0.08) bidAskWeight = 0.8;
    else if (market.bidAskSpread < 0.15) bidAskWeight = 0.5;
    else bidAskWeight = 0.2;
  }

  // Alignment: exact match = 1.0, partial (ML→spread) = 0.5, none = 0.0
  let alignWeight = 0.0;
  if (alignmentType === 'exact') alignWeight = 1.0;
  else if (alignmentType === 'partial') alignWeight = 0.5;

  return volumeWeight * bidAskWeight * alignWeight;
}

// ── Convert moneyline win prob to approximate spread cover prob ──
function moneylineToSpreadCoverApprox(mlProb) {
  return 0.5 + (mlProb - 0.5) * 0.6;
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
          const parsed = parseMarketTitle(m.title || m.subtitle || '', m.category || m.subtitle || '');
          const bidAskSpread = (yesBid > 0 && yesAsk > 0) ? (yesAsk - yesBid) : null;
          markets.push({
            source: 'Kalshi',
            title: m.title || m.subtitle || '',
            yesPrice,
            noPrice: 1 - yesPrice,
            volume: parseFloat(m.volume_24h_fp || m.volume_24h) || 0,
            ticker: m.ticker || '',
            parsedType: parsed.type,
            parsedHandicap: parsed.handicap,
            parsedTeam: parsed.team,
            parsedDirection: parsed.direction,
            parsedSport: parsed.sport,
            bidAskSpread,
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
          const parsed = parseMarketTitle(m.question || m.groupItemTitle || '', m.description || '');
          markets.push({
            source: 'Polymarket',
            title: m.question || m.groupItemTitle || '',
            yesPrice: parseFloat(prices[0]) || 0.5,
            noPrice: parseFloat(prices[1]) || 0.5,
            volume: parseFloat(m.volume24hr) || 0,
            ticker: m.slug || '',
            parsedType: parsed.type,
            parsedHandicap: parsed.handicap,
            parsedTeam: parsed.team,
            parsedDirection: parsed.direction,
            parsedSport: parsed.sport,
            bidAskSpread: null,
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

// ── Match prediction market to a candidate — multi-match, type-aligned aggregation ──
function getPredictionMarketSignal(candidate, predictionMarkets) {
  if (!predictionMarkets || predictionMarkets.length === 0) return null;

  const homeLast = candidate.homeTeam.toLowerCase().split(' ').pop();
  const awayLast = candidate.awayTeam.toLowerCase().split(' ').pop();
  const candidateBet = classifyCandidateBetType(candidate);

  // Phase A: Collect all team-matched markets
  const matched = [];
  for (const pm of predictionMarkets) {
    const title = pm.title.toLowerCase();
    const matchesHome = homeLast.length > 3 && title.includes(homeLast);
    const matchesAway = awayLast.length > 3 && title.includes(awayLast);
    if (!matchesHome && !matchesAway) continue;

    // Sport validation — skip if market sport doesn't match candidate
    if (pm.parsedSport && pm.parsedSport !== candidate.sport) continue;

    matched.push(pm);
  }

  if (matched.length === 0) return null;

  // Phase B: Type-align and compute comparable probabilities
  let weightedGapSum = 0, totalWeight = 0, totalVolume = 0, marketCount = 0;
  let weightedMarketProbSum = 0;
  let bestSource = matched[0].source, bestTitle = matched[0].title;
  let hasExact = false;

  for (const pm of matched) {
    let comparableProb = null;
    let alignmentType = 'none';

    if (candidateBet.type === pm.parsedType) {
      // Exact match: total→total, spread→spread
      alignmentType = 'exact';
      hasExact = true;
      if (candidateBet.type === 'total') {
        // If candidate is "Over" and market is "over", use yesPrice
        // If candidate is "Under" and market is "over", use noPrice
        if (candidateBet.direction === pm.parsedDirection || !pm.parsedDirection) {
          comparableProb = pm.yesPrice;
        } else {
          comparableProb = pm.noPrice;
        }
      } else {
        comparableProb = pm.yesPrice;
      }
    } else if (candidateBet.type === 'spread' && pm.parsedType === 'moneyline') {
      // Partial: convert ML win prob to approximate spread cover prob
      alignmentType = 'partial';
      comparableProb = moneylineToSpreadCoverApprox(pm.yesPrice);
    } else if (candidateBet.type === 'total' && pm.parsedType === 'moneyline') {
      // No alignment: ML tells us nothing about totals — skip
      continue;
    } else {
      continue;
    }

    if (comparableProb === null || comparableProb <= 0 || comparableProb >= 1) continue;

    const quality = computeMarketQuality(pm, alignmentType);
    if (quality < 0.05) continue; // skip negligible signals

    const gap = candidate.coverProb - comparableProb; // signed: positive = model more confident
    weightedGapSum += gap * quality;
    weightedMarketProbSum += comparableProb * quality;
    totalWeight += quality;
    totalVolume += pm.volume || 0;
    marketCount++;

    // Track highest-quality source for display
    if (quality > 0.5) { bestSource = pm.source; bestTitle = pm.title; }
  }

  if (totalWeight < 0.1 || marketCount === 0) return null;

  const aggregateGap = weightedGapSum / totalWeight;
  const avgMarketProb = weightedMarketProbSum / totalWeight;
  const avgQuality = totalWeight / marketCount;

  return {
    source: bestSource,
    title: bestTitle,
    marketProb: +avgMarketProb.toFixed(3),
    modelProb: +candidate.coverProb.toFixed(3),
    gap: +Math.abs(aggregateGap).toFixed(3),
    gapSigned: +aggregateGap.toFixed(3),
    agrees: Math.abs(aggregateGap) <= 0.08,
    disagrees: Math.abs(aggregateGap) > 0.12,
    volume: totalVolume,
    marketCount,
    avgQuality: +avgQuality.toFixed(3),
    alignmentType: hasExact ? 'exact' : 'partial',
    confidence: +totalWeight.toFixed(3),
  };
}

// ── Prediction market adjustment DISABLED (beta) — units come from Kelly only ──
function applyPredictionMarketAdjustment(candidate, signal) {
  if (signal) {
    console.log(`[v10-beta-pm] SKIPPED adjustment for ${candidate.side} — prediction markets do not modify units in beta`);
  }
  return candidate.kellyUnits;
}

// ── Fetch real-time X intelligence via Grok for top candidates ──
async function fetchXIntelligence(candidates) {
  const xaiKey = process.env.XAI_API_KEY;
  if (!xaiKey || candidates.length === 0) return {};

  // Build a single Grok call for all top candidates (efficient — one API call)
  const teamPairs = candidates.slice(0, 8).map(c => `${c.awayTeam} vs ${c.homeTeam} (${c.sport})`);

  try {
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 1500,
        temperature: 0.1,
        messages: [{
          role: 'system',
          content: 'You are a sports intelligence analyst. Return ONLY valid JSON. No markdown, no explanation.'
        }, {
          role: 'user',
          content: `Check X/Twitter for the latest breaking news on these games happening today. Focus ONLY on: injury updates, lineup changes, goaltender confirmations (NHL), starting pitcher changes (MLB), weather issues, or any material news that would shift the betting line.

Games to check:
${teamPairs.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return JSON: { "alerts": [ { "game": "Team A vs Team B", "alert": "brief news", "impact": "positive|negative|neutral", "affectedTeam": "team name" } ] }
If no breaking news for a game, omit it. Only include confirmed news, not rumors.`
        }],
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const alerts = {};
        for (const a of (parsed.alerts || [])) {
          const key = (a.game || '').toLowerCase();
          alerts[key] = a;
        }
        console.log(`[v10] X Intelligence: ${Object.keys(alerts).length} alerts from Grok`);
        return alerts;
      }
    }
  } catch (e) {
    console.log(`[v10] X Intelligence fetch failed: ${e.message}`);
  }
  return {};
}

// ── Apply X intelligence alerts to candidate context ──
function applyXIntelligence(candidates, xAlerts) {
  if (!xAlerts || Object.keys(xAlerts).length === 0) return;

  for (const c of candidates) {
    // Try to match alert to candidate
    const matchKeys = [
      `${c.awayTeam} vs ${c.homeTeam}`.toLowerCase(),
      `${c.homeTeam} vs ${c.awayTeam}`.toLowerCase(),
      c.awayTeam.toLowerCase().split(' ').pop(),
      c.homeTeam.toLowerCase().split(' ').pop(),
    ];

    for (const [key, alert] of Object.entries(xAlerts)) {
      const keyLower = key.toLowerCase();
      if (matchKeys.some(mk => keyLower.includes(mk) || mk.includes(keyLower.split(' ').pop()))) {
        c.xAlert = alert;
        // If negative impact on the team we're betting ON, flag it
        if (alert.impact === 'negative') {
          const affectedNorm = (alert.affectedTeam || '').toLowerCase();
          const pickSide = c.side.toLowerCase();
          // Check if the affected team is the one in our pick
          if (pickSide.includes(affectedNorm.split(' ').pop())) {
            c.xAlertWarning = true;
            console.log(`[v10-x] WARNING: ${c.side} — negative alert: ${alert.alert}`);
          }
        }
        break;
      }
    }
  }
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
      const entry = { homeTeam, awayTeam, sport: sportOdds.sport, commenceTime: game.commence_time || '' };

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

  // ── B2B REST ADJUSTMENT: teams on back-to-back score ~3% less ──
  const sportKey = sportType === 'hockey' ? 'NHL' : sportType === 'basketball' ? (leagueName === 'NCAAB' ? 'NCAAB' : 'NBA') : 'MLB';
  const b2bPenalty = B2B_SCORING_PENALTY[sportKey] || 1.0;
  const homeB2B = homeRating.daysSinceLastGame !== undefined && homeRating.daysSinceLastGame <= 1;
  const awayB2B = awayRating.daysSinceLastGame !== undefined && awayRating.daysSinceLastGame <= 1;
  if (homeB2B) {
    projHomeScore *= b2bPenalty;
    projMethod += ` [B2B: home]`;
  }
  if (awayB2B) {
    projAwayScore *= b2bPenalty;
    projMethod += ` [B2B: away]`;
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
        commenceTime: gameData.commenceTime || "",
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
      const rawSpreadEdge = Math.abs(proj.projSpread - actualSpread);
      const spreadEdge = applyEdgeDiscount(rawSpreadEdge, std);
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
            // Apply sport-specific Kelly multiplier
            const sportMult = SPORT_KELLY_MULT[league.league] || 1.0;
            let adjUnits = Math.round(kelly.units * sportMult * 2) / 2; // round to 0.5u
            adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
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
              kellyUnits: adjUnits,
              decimalPayout: +kelly.decPayout.toFixed(3),
              kellyCalcStr: `coverProb=${coverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_quarter=${kelly.kellyFraction.toFixed(4)}, units=${adjUnits}u${sportMult !== 1.0 ? ` [${league.league} ${sportMult}x]` : ''}`,
            });
          }
        }
      }

      // ── TOTAL CANDIDATE ──
      const actualTotal = gameData.total;
      if (actualTotal) {
        const rawTotalEdge = Math.abs(proj.projTotal - actualTotal);
        const totalEdge = applyEdgeDiscount(rawTotalEdge, std);
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
              const sportMult = SPORT_KELLY_MULT[league.league] || 1.0;
              let adjUnits = Math.round(kelly.units * sportMult * 2) / 2;
              adjUnits = Math.max(0.5, Math.min(3.0, adjUnits));
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
                kellyUnits: adjUnits,
                decimalPayout: +kelly.decPayout.toFixed(3),
                kellyCalcStr: `coverProb=${totalCoverProb.toFixed(3)}, decPayout=${kelly.decPayout.toFixed(3)}, edge=${kelly.ev.toFixed(3)}, kelly_quarter=${kelly.kellyFraction.toFixed(4)}, units=${adjUnits}u${sportMult !== 1.0 ? ` [${league.league} ${sportMult}x]` : ''}`,
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
    // Explicit narrative direction so Claude knows which side to argue for
    const isTotal = (c.market || '').toLowerCase() === 'total';
    if (isTotal) {
      const overUnder = (c.side || '').match(/(over|under)/i);
      prompt += `  👉 NARRATIVE DIRECTION: Write narrative supporting ${overUnder ? overUnder[1] : c.side} hitting\n`;
    } else {
      const pickedTeam = (c.side || '').replace(/[+-][\d.]+/g, '').trim();
      const handicap = (c.side || '').match(/([+-][\d.]+)/);
      prompt += `  👉 NARRATIVE DIRECTION: Write narrative supporting ${pickedTeam} covering ${handicap ? handicap[1] : 'the spread'}\n`;
    }
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
    // X/Grok intelligence alert
    if (c.xAlert) {
      prompt += `  ⚡ X ALERT: ${c.xAlert.alert} (impact: ${c.xAlert.impact}, team: ${c.xAlert.affectedTeam || '?'})\n`;
      if (c.xAlertWarning) prompt += `  ⚠️ WARNING: This alert affects the team in our pick — verify before selecting.\n`;
    }

    // Prediction market signal
    if (c.predictionMarket) {
      const pm = c.predictionMarket;
      const status = pm.agrees ? 'CONFIRMS' : pm.disagrees ? 'DISAGREES' : 'NEUTRAL';
      prompt += `  PM: ${pm.marketCount}x ${pm.alignmentType} markets ${status} (market=${(pm.marketProb*100).toFixed(0)}% vs model=${(pm.modelProb*100).toFixed(0)}%, quality=${pm.avgQuality})\n`;
    }

    // BettorEdge exchange data
    if (c.bettorEdge?.matched) {
      const be = c.bettorEdge;
      prompt += `  🔄 BETTOREDGE: `;
      if (be.exchangeProb) {
        prompt += `Exchange prob=${(be.exchangeProb*100).toFixed(0)}% vs model=${(be.modelCoverProb*100).toFixed(0)}% (${be.signal})`;
      }
      if (be.sharpestBook) {
        prompt += ` | Sharpest: ${be.sharpestBook} @ ${be.sharpestOdds > 0 ? '+' : ''}${be.sharpestOdds} (vig ${be.sharpestVig}%)`;
      }
      prompt += ` | ${be.exchangeTradeCount} trades, ${be.externalPriceCount} prices\n`;
    }

    prompt += `\n`;
  }

  return prompt;
}

// ── Enforce JS-computed math in narrative: prepend projection sentence, strip any Claude math ──
function fixNarrativeEdge(narrative, candidate) {
  if (!narrative || !candidate) return narrative;
  const c = candidate;
  const edgeVal = Math.abs(c.edge);
  const unit = c.sport === 'NHL' ? 'goal' : 'point';
  const isTotal = (c.market || '').toLowerCase() === 'total';

  // Build the JS-computed opening sentence
  let jsSentence;
  if (isTotal) {
    jsSentence = `WeBetAI projects ${c.modelProjection} total ${c.sport === 'NHL' ? 'goals' : 'points'}, line is ${c.consensusLine}, creating a ${edgeVal}-${unit} edge.`;
  } else {
    // Spread: modelProjection is projected margin (negative = away team favored)
    const projMargin = Math.abs(c.modelProjection);
    const side = c.side || '';
    // Determine if the pick is on the underdog or favorite
    const spreadLine = Math.abs(c.consensusLine);
    jsSentence = `WeBetAI projects a ${projMargin}-point margin, line is ${c.consensusLine}, creating a ${edgeVal}-${unit} edge.`;
  }

  // Strip any Claude sentence that restates projections/edges (starts with "WeBetAI projects" or mentions "[X]-point/goal edge")
  let cleaned = narrative
    .replace(/WeBetAI projects[^.]*\./i, '')
    .replace(/[^.]*\d+\.?\d*-(point|goal) edge[^.]*\./g, '')
    .trim();

  // Pick-direction sanity check: for spreads, warn if narrative mentions opponent more than picked team
  if (!isTotal && c.homeTeam && c.awayTeam) {
    const pickedTeam = (c.side || '').replace(/[+-][\d.]+/g, '').trim().toLowerCase();
    const opponent = (c.homeTeam.toLowerCase() === pickedTeam || c.homeTeam.toLowerCase().includes(pickedTeam.split(' ').pop()))
      ? c.awayTeam : c.homeTeam;
    const lowerNarrative = cleaned.toLowerCase();
    const pickedMentions = (lowerNarrative.match(new RegExp(pickedTeam.split(' ').pop(), 'g')) || []).length;
    const opponentMentions = (lowerNarrative.match(new RegExp(opponent.split(' ').pop().toLowerCase(), 'g')) || []).length;
    if (opponentMentions > pickedMentions + 1) {
      console.log(`[v10-beta] ⚠️ NARRATIVE DIRECTION WARNING: "${c.side}" narrative mentions opponent "${opponent}" ${opponentMentions}x vs picked team ${pickedMentions}x — may be arguing against the pick`);
    }
  }

  return jsSentence + ' ' + cleaned;
}

// ── Build final picks: top 3 by EV that passed Claude verification ──
function buildFinalPicks(candidateTable, claudeVerifications, allCandidates) {
  // Build a set of failed candidate ranks
  const failedRanks = new Set();
  const verificationMap = {};
  for (const v of claudeVerifications) {
    verificationMap[v.candidateRank] = v;
    if (v.verdict === 'FAIL') {
      failedRanks.add(v.candidateRank);
      console.log(`[v10-beta] FAILED rank ${v.candidateRank}: ${v.failReason || 'no reason'}`);
    }
  }

  // Take top 3 candidates by EV rank that passed verification (candidateTable is already sorted by EV)
  const picks = [];
  for (const c of candidateTable) {
    if (picks.length >= 3) break;
    if (failedRanks.has(c.rank)) continue;

    const v = verificationMap[c.rank];
    const finalUnits = c.kellyUnits; // Units come from Kelly only — Claude cannot adjust

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
      coreReasoning: fixNarrativeEdge(v?.coreReasoning || "", c),
      whatLoses: v?.whatLoses || "",
      dataVerified: v?.dataVerified || "",
      clvExpectation: v?.clvExpectation || "",
      modelEdge: `Model: ${c.modelProjection}, Line: ${c.consensusLine}, Edge: ${c.edge} ${c.sport === 'NHL' ? 'goals' : 'pts'}`,
      commenceTime: c.commenceTime || "",
    });
    console.log(`[v10-beta] SELECTED rank ${c.rank}: ${c.side} (EV: ${(c.ev * 100).toFixed(1)}%, units: ${finalUnits}u)`);
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
            c.kellyCalcStr += ` [PM ${signal.agrees ? 'CONFIRM' : 'CAUTION'}: ${signal.marketCount}x ${signal.alignmentType} ${signal.source} q=${signal.avgQuality}]`;
            if (signal.agrees) confirms++;
            else cautions++;
          }
        }
      }
      // Re-sort after adjustments (units changed → re-rank by EV)
      allCandidates.sort((a, b) => b.ev - a.ev);
      allCandidates.forEach((c, i) => { c.rank = i + 1; });
      const pmSignals = allCandidates.filter(c => c.predictionMarket).length;
      console.log(`[v10] Prediction market: ${pmSignals} candidates matched, ${confirms} confirmed, ${cautions} cautioned (type-aligned)`);
    }

    // ── PHASE 1D: X/GROK REAL-TIME INTELLIGENCE ──
    const xAlerts = await fetchXIntelligence(allCandidates);
    applyXIntelligence(allCandidates, xAlerts);

    // ── PHASE 1E: BETTOREDGE EXCHANGE INTEGRATION ──
    try {
      console.log("[v10-BE] Fetching BettorEdge exchange data...");
      const EVENTS_BASE = "https://api.events.bettoredge.com/v1";
      const MARKETS_BASE = "https://api.markets.bettoredge.com/v1";

      // Fetch leagues + active events + exchange trades in parallel
      const [beLeaguesResp, beEventsResp] = await Promise.all([
        bettoredgeFetch(`${EVENTS_BASE}/leagues?status=active`),
        bettoredgeFetch(`${EVENTS_BASE}/events/active?expanded=true`),
      ]);

      const beLeagues = beLeaguesResp.ok ? (await beLeaguesResp.json()).leagues || [] : [];
      const beEventsRaw = beEventsResp.ok ? (await beEventsResp.json()).events || [] : [];
      console.log(`[v10-BE] BettorEdge: ${beLeagues.length} leagues, ${beEventsRaw.length} active events`);

      // Fetch external prices + exchange trades for each event (batch of 10)
      const beEventData = {};
      for (let i = 0; i < beEventsRaw.length; i += 10) {
        const batch = beEventsRaw.slice(i, i + 10);
        const results = await Promise.allSettled(batch.map(async (evt) => {
          const [pricesResp, tradesResp] = await Promise.all([
            bettoredgeFetch(`${EVENTS_BASE}/prices/latest/${evt.event_id}/team`).catch(() => null),
            bettoredgeFetch(`${MARKETS_BASE}/trades/event/latest/${evt.event_id}/team`).catch(() => null),
          ]);
          const prices = pricesResp?.ok ? (await pricesResp.json()).prices || [] : [];
          const trades = tradesResp?.ok ? (await tradesResp.json()).trades || [] : [];
          return { evt, prices, trades };
        }));
        for (const r of results) {
          if (r.status === "fulfilled") {
            const { evt, prices, trades } = r.value;
            const homeKey = (evt.home?.name || "").toLowerCase().replace(/[^a-z]/g, "");
            const awayKey = (evt.away?.name || "").toLowerCase().replace(/[^a-z]/g, "");
            const key = `${awayKey}_${homeKey}`;
            beEventData[key] = { prices, trades, home: evt.home?.name, away: evt.away?.name, eventId: evt.event_id };
          }
        }
      }
      console.log(`[v10-BE] BettorEdge event data built for ${Object.keys(beEventData).length} matchups`);

      // Helper: normalize team name for matching
      function beNormalize(name) {
        return (name || "").toLowerCase().replace(/[^a-z]/g, "");
      }

      // Apply BettorEdge data to each candidate
      let beMatches = 0, beBoosts = 0, beCautions = 0;
      for (const c of allCandidates) {
        // Try to match candidate to BettorEdge event
        const matchupParts = (c.matchup || "").split(/\s+(?:vs\.?|@|at)\s+/i);
        if (matchupParts.length < 2) continue;
        const team1 = beNormalize(matchupParts[0]);
        const team2 = beNormalize(matchupParts[1]);

        let beMatch = null;
        for (const [key, data] of Object.entries(beEventData)) {
          const h = beNormalize(data.home);
          const a = beNormalize(data.away);
          if ((team1.includes(h) || h.includes(team1) || team2.includes(h) || h.includes(team2)) &&
              (team1.includes(a) || a.includes(team1) || team2.includes(a) || a.includes(team2))) {
            beMatch = data;
            break;
          }
        }

        if (!beMatch) continue;
        beMatches++;

        // Extract exchange probability (vig-free signal)
        const exchangeTrades = beMatch.trades.filter(t => {
          const matchesBetType = (c.betType === "Spread" || c.betType === "Puck Line" || c.betType === "Run Line")
            ? t.var_1 != null && t.var_1 !== 0
            : c.betType === "Total"
              ? (t.side === "over" || t.side === "under")
              : (t.side === "home" || t.side === "away") && (!t.var_1 || t.var_1 === 0);
          return matchesBetType;
        });

        // Find consensus and lowest-vig external price
        const relevantPrices = beMatch.prices.filter(p => {
          if (c.betType === "Spread" || c.betType === "Puck Line" || c.betType === "Run Line") return p.market === "Spread" && p.var_1 != null;
          if (c.betType === "Total") return p.market === "Total";
          return p.market === "Winner";
        });

        // Get BettorEdge consensus
        const consensusPrices = relevantPrices.filter(p => p.external_name === "Consensus");
        // Get lowest vig price (sharpest book)
        const vigPrices = relevantPrices.filter(p => p.vig_pct > 0 && p.vig_pct < 20).sort((a, b) => a.vig_pct - b.vig_pct);
        const sharpestLine = vigPrices[0] || null;

        // Exchange probability (vig-free)
        let exchangeProb = null;
        if (exchangeTrades.length > 0) {
          const probs = exchangeTrades.map(t => t.probability).filter(p => p > 0 && p < 1);
          if (probs.length > 0) exchangeProb = probs.reduce((a, b) => a + b, 0) / probs.length;
        }

        // Store BettorEdge data on candidate
        c.bettorEdge = {
          matched: true,
          exchangeProb: exchangeProb ? Math.round(exchangeProb * 1000) / 1000 : null,
          modelCoverProb: c.coverProb,
          probDelta: exchangeProb ? Math.round((c.coverProb - exchangeProb) * 1000) / 1000 : null,
          sharpestBook: sharpestLine ? sharpestLine.external_name : null,
          sharpestOdds: sharpestLine ? sharpestLine.odds : null,
          sharpestVig: sharpestLine ? Math.round(sharpestLine.vig_pct * 100) / 100 : null,
          consensusOdds: consensusPrices[0]?.odds || null,
          exchangeTradeCount: exchangeTrades.length,
          externalPriceCount: relevantPrices.length,
        };

        // Confidence adjustment based on exchange agreement
        if (exchangeProb) {
          const gap = Math.abs(c.coverProb - exchangeProb);
          if (gap <= 0.05) {
            // Model and exchange agree — boost confidence
            const prevUnits = c.kellyUnits;
            c.kellyUnits = Math.min(3.0, Math.round((c.kellyUnits + 0.5) * 2) / 2);
            c.bettorEdge.signal = "AGREE";
            c.kellyCalcStr += ` [BE AGREE: exchange=${(exchangeProb*100).toFixed(0)}% vs model=${(c.coverProb*100).toFixed(0)}%, +0.5u boost]`;
            beBoosts++;
          } else if (gap > 0.10) {
            // Model and exchange disagree — reduce confidence
            const prevUnits = c.kellyUnits;
            c.kellyUnits = Math.max(0.5, Math.round((c.kellyUnits - 0.5) * 2) / 2);
            c.bettorEdge.signal = "DISAGREE";
            c.kellyCalcStr += ` [BE DISAGREE: exchange=${(exchangeProb*100).toFixed(0)}% vs model=${(c.coverProb*100).toFixed(0)}%, -0.5u caution]`;
            beCautions++;
          } else {
            c.bettorEdge.signal = "NEUTRAL";
            c.kellyCalcStr += ` [BE NEUTRAL: exchange=${(exchangeProb*100).toFixed(0)}% vs model=${(c.coverProb*100).toFixed(0)}%]`;
          }
        }

        // Update rating after unit adjustment
        c.rating = unitsToRating(c.kellyUnits);
        c.confidence = unitsToConfidence(c.kellyUnits);
      }

      // Re-sort after BettorEdge adjustments
      allCandidates.sort((a, b) => b.ev - a.ev);
      allCandidates.forEach((c, i) => { c.rank = i + 1; });
      console.log(`[v10-BE] BettorEdge: ${beMatches} candidates matched, ${beBoosts} boosted, ${beCautions} cautioned`);
    } catch (beErr) {
      console.error(`[v10-BE] BettorEdge integration failed (non-fatal): ${beErr.message}`);
      // Continue without BettorEdge data — pipeline still works with Odds API alone
    }

  } catch (edgeErr) {
    console.error(`[v10] EDGE TABLE COMPUTATION FAILED: ${edgeErr.message}`);
    console.error(edgeErr.stack);
    allCandidates = [];
  }

  if (allCandidates.length === 0) {
    console.log("[v10] No edge candidates found — storing no-plays result");
    await storePicks(dateISO, {
      date: dateISO, dateFormatted, model: "v10.0-bettoredge-edge",
      picks: [], rejections: [{ matchup: "All games", side: "All markets", reason: `No statistical edges exceeded minimum thresholds. ESPN: ${(espnData||[]).reduce((s,l)=>s+l.games.length,0)} games/${(espnData||[]).length} leagues. Odds: ${(oddsData||[]).reduce((s,l)=>s+l.games.length,0)} games. Ratings: ${ratingsData ? Object.keys(ratingsData.leagues||{}).length : 0} leagues. TeamStats: ${Object.keys(teamStats).length}. Consensus: ${Object.keys(consensusLookup).length} keys.` }],
      summary: { totalPicks: 0, totalStraightBets: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [], modelVersion: "v10.0-bettoredge-edge" },
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

    // ── PHASE 3: MERGE JS NUMBERS + CLAUDE VERIFICATIONS ──
    const verifications = claudeOutput.verifications || [];
    const picks = buildFinalPicks(candidateTable, verifications, allCandidates);

    // Build rejections: failed verifications + non-selected candidates
    const selectedSides = new Set(picks.map(p => p.pick));

    const rejections = [];
    // Add Claude's failed verifications
    for (const v of verifications) {
      if (v.verdict === 'FAIL') {
        const c = candidateTable.find(x => x.rank === v.candidateRank);
        rejections.push({
          matchup: c ? c.matchup : `Candidate #${v.candidateRank}`,
          side: c ? c.side : "N/A",
          reason: v.failReason || "Failed verification",
        });
      }
    }
    // Add remaining non-selected candidates as rejections
    for (const c of allCandidates.slice(0, 15)) {
      if (!selectedSides.has(c.side) && !rejections.find(r => r.side === c.side)) {
        rejections.push({ matchup: c.matchup, side: c.side, reason: "Not selected — lower EV priority." });
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
      model: "v10.0-bettoredge-edge",
      picks,
      rejections,
      edgeSummary: claudeOutput.edgeSummary || "",
      summary: {
        totalPicks: picks.length,
        totalStraightBets: picks.length,
        totalUnits: `${totalUnits.toFixed(1)}u`,
        aplusLocks: picks.filter(p => p.rating === "A+").length,
        sportsCovered,
        modelVersion: "v10.0-bettoredge-edge",
      },
      generatedAt: now.toISOString(),
      parlayLegs: [],
      sgps: [],
      modelProjections,
      edgeCandidatesCount: allCandidates.length,
      candidateTable: candidateTable.map(c => ({
        rank: c.rank,
        sport: c.sport,
        side: c.side,
        market: c.market,
        odds: c.odds,
        modelProjection: c.modelProjection,
        consensusLine: c.consensusLine,
        edge: c.edge,
        coverProb: c.coverProb,
        ev: c.ev,
        kellyUnits: c.kellyUnits,
        matchup: c.matchup,
        verification: verifications.find(v => v.candidateRank === c.rank)?.verdict || 'NOT_VERIFIED',
      })),
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
    commenceTime: c.commenceTime || "",
  }));

  const totalUnits = picks.reduce((s, p) => s + parseFloat(p.units), 0);
  const picksData = {
    date: dateISO, dateFormatted, model: "v10.0-bettoredge-edge",
    picks,
    rejections: allCandidates.slice(3, 10).map(c => ({ matchup: c.matchup, side: c.side, reason: "Lower edge priority." })),
    edgeSummary: "WeBetAI's deterministic model found today's top edges across all sports. Picks ranked by normalized z-score.",
    summary: { totalPicks: picks.length, totalStraightBets: picks.length, totalUnits: `${totalUnits.toFixed(1)}u`, aplusLocks: 0, sportsCovered: [...new Set(picks.map(p => p.sport))], modelVersion: "v10.0-bettoredge-edge" },
    generatedAt: now.toISOString(), parlayLegs: [], sgps: [],
    fallback: true,
  };

  await storePicks(dateISO, picksData);
  return { statusCode: 200, body: "Fallback OK" };
}

// ── Store picks to "edge-picks-be" blob store ──
async function storePicks(dateISO, picksData) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error("[v10-beta] NETLIFY_AUTH_TOKEN not set, cannot store picks");
    return;
  }

  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-be`;

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

  // No Kalshi auto-execution for BettorEdge test pipeline
  console.log("[v10-BE] BettorEdge picks stored — no Kalshi trigger (test pipeline)");
}
