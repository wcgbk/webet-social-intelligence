// generate-picks-v2-background.js
// OPTIMIZED VERSION — THE LOCK v4
// Changes from v3:
//   - Model: Sonnet (cost-efficient, strong calibration)
//   - Temperature: 0.2 (analytical, not creative)
//   - Max tokens: 32K (room for chain-of-thought)
//   - Web search: 40 uses (more grounded data)
//   - Prompt: removed forced-pick language, added calibration, totals math requirement
//   - Stores to "edge-picks-v2" blob store (separate from production)

// ── THE LOCK v4 — Optimized System Prompt ──
const THE_LOCK_SYSTEM = `You are THE LOCK — WeBet's elite sports betting AI. You are data-driven, disciplined, and selective. You say "The edge is" and "The data shows." You only bet when the data supports it.

CORE PRINCIPLE: Quality over quantity. You are selective. If fewer than 3 genuine edges exist today, output only those you have real conviction on. A 1-pick day with a winner beats a 3-pick day with 2 losers. An empty slate is better than a losing slate.

YOUR DAILY OUTPUT:
1. Between 1 and 5 TOP PICKS ranked by confidence (highest first) with full analysis
2. A "Safe 3-Leg Parlay" — your 3 highest-confidence legs (A/A+ only). OMIT entirely if you don't have 3 genuinely high-confidence legs.
3. A "5-Leg Power Parlay" — your 5 best legs (B+ or higher). OMIT entirely if you don't have 5 qualifying legs.
4. A "Long-Shot Super Parlay" — 8-16 legs at B or higher. OMIT entirely if you cannot find 8+ qualifying legs.
IMPORTANT: Only recommend parlays you have genuine confidence in. It is better to show fewer parlays than to pad with weak legs.

SPORTS TO ANALYZE (all that have games today):
NBA, NHL, NCAAB (March Madness, NIT, conference tourneys, regular season), EPL, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League, MLS

MARKET TYPES — consider ALL of these:
• Moneyline (ML) — standard win
• Spread — team covers the number
• Puck Line (-1.5 / +1.5) — NHL; prefer -1.5 for strong home favorites (better parlay value than ML)
• Total (Over/Under) — game total points/goals
• Same Game Parlay (SGP) — 2-3 correlated legs from one game (e.g. spread + total)
• Draw — soccer only; use for defensive matchups
• Asian Handicap — soccer; better value than ML on heavy favorites

MARKET SELECTION PRIORITIES:
• NHL: Puck Line -1.5 for home favorites with strong recent form > ML
• NHL: Under when both teams are defensive or on back-to-backs
• NCAAB: Totals can be valuable when pace mismatch exists — but ONLY with verified scoring data (see TOTALS PROTOCOL below)
• Soccer: ML for dominant home teams. Draw for defensive away teams. Under for congested fixtures.
• NBA: Spreads viable at 65%+ true win prob. Totals for pace mismatches. Never lay more than -14.
• SGPs: Combine spread + total when they align directionally in the same game.

EVIDENCE TIERS (in order of weight):
1. STATISTICAL MODEL — Elo ratings, projected scores, and computed edges from 60 days of results. This is your PRIMARY source for win probability. Your stated win% should be WITHIN 5% of the model's Elo-based probability unless you have strong evidence to deviate.
2. LAST 5 GAMES — Recent form data from the model and web search. Verify if the model's last-5 data matches current reality.
3. EDGE vs LINE — Compare the model's projected spread/total to the posted consensus line. A 3+ point spread difference or 4+ point total difference = potential edge. If model and line agree, there is NO edge — move on.
4. HEAD-TO-HEAD — Style matchups, patterns from last 2 seasons (use web search)
5. SITUATIONAL — Motivation, rest, revenge, travel, fixture congestion

INJURY PROTOCOL: Evaluate actual impact. A role player out doesn't change a pick. Star player out with quality backup = minor downgrade. Don't auto-reject — think critically.

5-FILTER FRAMEWORK (ALL 5 must pass for a pick to qualify):
1. Statistical Edge — The model's projected line differs from the posted line by 3+ pts (spread) or 4+ pts (total). If the model agrees with the line, there is NO edge.
2. Recent Form — Last 5 games must support the pick direction (from model data + web search verification)
3. Injury Impact — Nuanced, not automatic rejection. Check if injuries shift the model's projection.
4. Situational Edge — Rest, motivation, travel, revenge
5. Line Value — Model win probability vs implied odds probability. Only bet when model probability exceeds implied probability by 5%+.

TOTALS PROTOCOL (MANDATORY for any Over/Under pick):
Before recommending ANY totals pick, you MUST calculate and state:
(a) Team A avg points scored last 5 games
(b) Team B avg points scored last 5 games
(c) Team A avg points allowed last 5 games
(d) Team B avg points allowed last 5 games
(e) Your projected game total based on these numbers
(f) The posted O/U line
(g) The gap between your projection and the line
If the gap is less than 4 points, DO NOT take the totals pick — the edge is insufficient. Include this math in the coreReasoning field.

CALIBRATION — READ THIS CAREFULLY:
Your stated win probability must reflect ACTUAL expected hit rates, not optimistic estimates.
• NBA/NCAAB spreads: True probability rarely exceeds 65%. A -3 spread is roughly 52-58% depending on the matchup.
• NHL puck lines: -1.5 favorites genuinely hit ~45-55% of the time. Only rate A+ if truly dominant matchup.
• Totals: Over/Under is approximately 50-50 by design. An edge of 55-60% is genuinely strong.
• An A+ rating (80%+ stated probability) should be RARE — maybe 1-2 per WEEK across all sports, not daily.
• If your average stated probability across all picks exceeds 72%, you are overconfident — recalibrate downward.
• When in doubt, rate a pick one tier lower than your instinct suggests.

RATING SYSTEM:
A+ = Highest confidence (2.0u straight bet) — TRUE 75%+ win probability (extremely rare)
A  = High confidence (1.5u straight bet) — TRUE 68-74% win probability
A- = Strong (1.0u straight bet) — TRUE 63-67% win probability
B+ = Good (1.0u parlay leg) — TRUE 60-62% win probability
B  = Solid (0.5u parlay leg) — TRUE 57-59% win probability`;

function buildUserPrompt(dateFormatted, dateISO) {
  return `TODAY: ${dateFormatted} (${dateISO})

INSTRUCTIONS:
1. Review the STATISTICAL EDGE MODEL projections below — these are your primary source for win probability and score predictions
2. Compare model projected spreads/totals to the CONSENSUS LINES — flag games where the gap is 3+ pts (spread) or 4+ pts (total)
3. Use web search to verify: injury updates, goaltender confirmations, breaking news that might shift the model's projection
4. For EVERY game you're considering, check ALL market types — not just moneyline
5. Apply the 5-filter framework strictly. Only include picks where ALL 5 filters pass.
6. For totals picks: follow the TOTALS PROTOCOL — use the model's projected total vs the posted line
7. Select your TOP picks (1-5) ranked by edge size (model vs line gap), with full analysis
8. Build parlays ONLY from legs you have high confidence in

THINKING PROCESS: Before outputting JSON, compare the statistical model's projections to the posted lines for EVERY game. Identify the 3-5 largest discrepancies. For each, verify with web search whether the model might be missing something (injuries, rest, motivation). Then select only the picks where the edge survives scrutiny.

OUTPUT FORMAT — Return valid JSON (may include thinking text before the JSON block):

{
  "date": "${dateISO}",
  "dateFormatted": "${dateFormatted}",
  "picks": [
    {
      "sport": "NCAAB",
      "matchup": "Away Team vs. Home Team",
      "pick": "Home Team -5.5",
      "betType": "Spread",
      "odds": "-110",
      "rating": "A",
      "confidence": "a",
      "units": "1.5u",
      "winProbability": "68%",
      "coreReasoning": "2-4 sentences explaining the edge using VERIFIED data points. For totals: include the math from Totals Protocol. Reference specific recent game scores, pace stats, defensive metrics, rest advantage, or line value.",
      "whatLoses": "One sentence — the specific scenario that beats this pick.",
      "dataVerified": "Brief note on what data you verified via web search vs pre-fetched data",
      "modelEdge": "Model projected spread/total vs posted line. E.g., 'Model: Home -7.2, Line: Home -3.5, Edge: 3.7 pts'"
    }
  ],
  "safe3Parlay": {
    "name": "Safe 3-Leg Parlay",
    "legs": [
      { "sport": "NBA", "matchup": "Away @ Home", "pick": "Home ML", "odds": "-150", "rating": "A+", "confidence": "aplus", "coreReasoning": "One sentence." }
    ],
    "totalOdds": "+320",
    "projectedPayout": "$42 on $10 bet"
  },
  "power5Parlay": {
    "name": "5-Leg Power Parlay",
    "legs": [
      { "sport": "NHL", "matchup": "Away @ Home", "pick": "Home -1.5", "odds": "+152", "rating": "B+", "confidence": "bplus", "coreReasoning": "One sentence." }
    ],
    "totalOdds": "+2500",
    "projectedPayout": "$260 on $10 bet"
  },
  "longShotParlay": {
    "name": "Long-Shot Super Parlay",
    "legs": [
      { "sport": "NCAAB", "matchup": "Away @ Home", "pick": "Over 145", "odds": "-110", "rating": "B", "confidence": "b", "coreReasoning": "One sentence." }
    ],
    "totalOdds": "+89420",
    "projectedPayout": "$8,952 on $10 bet"
  },
  "rejections": [
    { "matchup": "Team C vs Team D", "side": "All markets", "reason": "Why no edge." }
  ],
  "summary": {
    "totalPicks": 3,
    "totalStraightBets": 3,
    "totalUnits": "5.0u",
    "aplusLocks": 0,
    "sportsCovered": ["NBA", "NHL", "NCAAB"]
  }
}

FIELD RULES:
• "confidence": one of "aplus", "a", "aminus", "bplus", "b"
• "sport": one of "NBA", "NHL", "NCAAB", "EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "MLS", "UCL", "UEL"
• "betType": one of "ML", "Spread", "Puck Line", "Total", "Draw", "Asian Handicap", "BTTS", "SGP"
• "picks" = 1-5 top picks ranked by confidence (highest first) with full analysis. Quality over quantity.
• "safe3Parlay" = OMIT entirely if you don't have 3 high-confidence legs
• "power5Parlay" = OMIT entirely if you don't have 5 qualifying legs
• "longShotParlay" = OMIT entirely if you cannot find 8+ qualifying legs
• DO NOT include sportsbook names — just the line and odds
• DO NOT include parlays you aren't confident in

REMEMBER: You are THE LOCK. You find edges WHEN THEY EXIST. Be honest when the slate is thin. The data below has confirmed lines from real sportsbooks. Use web search to verify recent form before making picks.`;
}

// ── Sport keys for The Odds API ──
const ODDS_SPORTS = [
  "basketball_nba",
  "icehockey_nhl",
  "basketball_ncaab",
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
  { sport: "basketball", league: "nba", label: "NBA" },
  { sport: "hockey", league: "nhl", label: "NHL" },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAAB" },
  { sport: "soccer", league: "eng.1", label: "EPL" },
  { sport: "soccer", league: "esp.1", label: "La Liga" },
  { sport: "soccer", league: "ita.1", label: "Serie A" },
  { sport: "soccer", league: "ger.1", label: "Bundesliga" },
  { sport: "soccer", league: "fra.1", label: "Ligue 1" },
  { sport: "soccer", league: "usa.1", label: "MLS" },
  { sport: "soccer", league: "uefa.champions", label: "UCL" },
  { sport: "soccer", league: "uefa.europa", label: "Europa" },
];

// ── Fetch today's odds from The Odds API ──
async function fetchOdds(dateISO) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log("[v2-picks] No ODDS_API_KEY, skipping odds fetch");
    return null;
  }

  const allOdds = [];
  for (const sport of ODDS_SPORTS) {
    try {
      const markets = sport.includes("icehockey")
        ? "h2h,spreads,totals,alternate_spreads,alternate_totals"
        : "h2h,spreads,totals";

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,eu&markets=${markets}&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const todayGames = data.filter(g => {
          const gameDate = new Date(g.commence_time).toISOString().split('T')[0];
          return gameDate === dateISO;
        });
        if (todayGames.length > 0) {
          allOdds.push({ sport, games: todayGames });
        }
      }
    } catch (e) {
      console.log(`[v2-picks] Odds fetch error for ${sport}: ${e.message}`);
    }
  }
  console.log(`[v2-picks] Fetched odds for ${allOdds.length} sports`);
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
      console.log(`[v2-picks] ESPN fetch error for ${label}: ${e.message}`);
    }
  }

  console.log(`[v2-picks] ESPN: ${results.length} leagues with games today`);
  return results;
}

// ── Format pre-fetched data with consensus lines ──
function formatDataForPrompt(oddsData, espnData) {
  let context = "";
  let totalGames = 0;

  if (espnData && espnData.length > 0) {
    context += "\n\n=== TODAY'S GAMES & INJURIES (ESPN) ===\n";
    for (const league of espnData) {
      context += `\n--- ${league.league} (${league.games.length} games) ---\n`;
      for (const game of league.games) {
        totalGames++;
        const time = new Date(game.date).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
        context += `${game.away} (${game.awayRecord}) @ ${game.home} (${game.homeRecord}) — ${time} ET`;
        if (game.venue) context += ` — ${game.venue}`;
        context += "\n";
        if (game.homeInjuries?.length) {
          context += `  ${game.home} injuries: ${game.homeInjuries.map(i => `${i.name} (${i.status}${i.detail ? ': ' + i.detail : ''})`).join(', ')}\n`;
        }
        if (game.awayInjuries?.length) {
          context += `  ${game.away} injuries: ${game.awayInjuries.map(i => `${i.name} (${i.status}${i.detail ? ': ' + i.detail : ''})`).join(', ')}\n`;
        }
      }
    }
  }

  if (oddsData && oddsData.length > 0) {
    context += "\n\n=== CONFIRMED BETTING LINES (The Odds API — multiple books) ===\n";
    for (const sportOdds of oddsData) {
      const sportLabel = sportOdds.sport.replace("basketball_", "").replace("icehockey_", "").replace("soccer_", "").toUpperCase();
      context += `\n--- ${sportLabel} ---\n`;
      for (const game of sportOdds.games) {
        const time = new Date(game.commence_time).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
        context += `${game.away_team} @ ${game.home_team} (${time} ET)\n`;

        // Compute consensus lines across all books
        const allSpreads = [], allTotals = [], allH2H = {};
        for (const book of (game.bookmakers || [])) {
          for (const mkt of (book.markets || [])) {
            if (mkt.key === 'spreads') {
              for (const o of mkt.outcomes) {
                if (o.point !== undefined) allSpreads.push({ team: o.name, spread: o.point, price: o.price });
              }
            }
            if (mkt.key === 'totals') {
              for (const o of mkt.outcomes) {
                if (o.point !== undefined) allTotals.push({ side: o.name, line: o.point, price: o.price });
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

        // Consensus spread
        if (allSpreads.length > 0) {
          const homeTeam = game.home_team;
          const homeSpreads = allSpreads.filter(s => s.team === homeTeam).map(s => s.spread);
          if (homeSpreads.length > 0) {
            homeSpreads.sort((a, b) => a - b);
            const median = homeSpreads[Math.floor(homeSpreads.length / 2)];
            context += `  Consensus Spread: ${homeTeam} ${median > 0 ? '+' : ''}${median}\n`;
          }
        }

        // Consensus total
        if (allTotals.length > 0) {
          const overLines = allTotals.filter(t => t.side === 'Over').map(t => t.line);
          if (overLines.length > 0) {
            overLines.sort((a, b) => a - b);
            const median = overLines[Math.floor(overLines.length / 2)];
            context += `  Consensus Total: O/U ${median}\n`;
          }
        }

        // Consensus ML
        const mlParts = [];
        for (const [team, prices] of Object.entries(allH2H)) {
          prices.sort((a, b) => a - b);
          const median = prices[Math.floor(prices.length / 2)];
          mlParts.push(`${team} ${median > 0 ? '+' : ''}${median}`);
        }
        if (mlParts.length > 0) {
          context += `  Consensus ML: ${mlParts.join(' / ')}\n`;
        }

        // Show 2 books for line shopping detail
        const books = (game.bookmakers || []).slice(0, 2);
        for (const book of books) {
          const markets = {};
          for (const mkt of book.markets || []) {
            const outcomes = mkt.outcomes.map(o => {
              let s = `${o.name} ${o.price > 0 ? '+' : ''}${o.price}`;
              if (o.point !== undefined) s += ` (${o.point > 0 ? '+' : ''}${o.point})`;
              return s;
            }).join(' / ');
            markets[mkt.key] = outcomes;
          }
          let line = `  [${book.title}]`;
          if (markets.h2h) line += ` ML: ${markets.h2h}`;
          if (markets.spreads) line += ` | Spread: ${markets.spreads}`;
          if (markets.totals) line += ` | Total: ${markets.totals}`;
          context += line + "\n";
        }
      }
    }
  }

  if (!context || totalGames === 0) {
    context = "\n\nNOTE: Limited pre-fetched data. Use web search extensively to find today's full game schedule, odds, injuries, and recent results.\n";
  }

  context += `\n\n=== TOTAL GAMES FOUND: ${totalGames} across ${(espnData||[]).length} leagues ===\n`;
  context += "Use web search to verify last 5 game results, goaltender confirmations, and any late-breaking injury news BEFORE making picks.\n";

  return context;
}

// ── Fetch pre-built team ratings from Blobs ──
async function fetchRatings() {
  const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;

  try {
    const resp = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings/latest`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) {
      const data = await resp.json();
      console.log(`[v2-picks] Loaded ratings from ${data.generatedAt}`);
      return data;
    }
  } catch (e) {
    console.log(`[v2-picks] Ratings fetch failed: ${e.message}`);
  }
  return null;
}

// ── Elo expected score (for win probability) ──
function eloExpected(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// ── Format statistical model output for the prompt ──
function formatRatingsForPrompt(ratingsData, espnData, oddsData) {
  if (!ratingsData || !ratingsData.leagues) return "";

  let ctx = "\n\n=== STATISTICAL EDGE MODEL (Elo + Efficiency Projections) ===\n";
  ctx += "These projections are computed from 60 days of historical game results.\n";
  ctx += "Use these as your PRIMARY source for win probability and score projections.\n";
  ctx += "Your stated win probability should be CLOSE to the model's Elo-based probability.\n\n";

  // Map ESPN league labels to ratings league keys
  const leagueMap = {};
  for (const l of (espnData || [])) {
    leagueMap[l.league] = l;
  }

  // Also build a team name lookup from odds data for matching
  const oddsTeams = new Set();
  for (const s of (oddsData || [])) {
    for (const g of s.games) {
      oddsTeams.add(g.home_team);
      oddsTeams.add(g.away_team);
    }
  }

  let matchupCount = 0;

  for (const [leagueName, leagueData] of Object.entries(ratingsData.leagues)) {
    const teams = leagueData.teams;
    if (!teams || Object.keys(teams).length === 0) continue;

    // Get today's games from ESPN data
    const espnLeague = leagueMap[leagueName];
    if (!espnLeague || !espnLeague.games || espnLeague.games.length === 0) continue;

    ctx += `--- ${leagueName} Statistical Projections ---\n`;

    // Find home advantage for this league
    const leagueConfig = ESPN_LEAGUES.find(l => l.label === leagueName);
    const homeAdv = leagueConfig ? leagueConfig.homeAdv : 80;

    for (const game of espnLeague.games) {
      // Find teams in ratings
      const homeRating = findTeam(teams, game.home);
      const awayRating = findTeam(teams, game.away);

      if (!homeRating || !awayRating) continue;
      matchupCount++;

      // Compute projections
      const homeEloAdj = homeRating.elo + homeAdv;
      const homeWinProb = eloExpected(homeEloAdj, awayRating.elo);
      const projHomeScore = (homeRating.homeAvgScored + awayRating.awayAvgAllowed) / 2;
      const projAwayScore = (awayRating.awayAvgScored + homeRating.homeAvgAllowed) / 2;
      const projSpread = -(projHomeScore - projAwayScore);
      const projTotal = projHomeScore + projAwayScore;

      ctx += `\n${game.away} @ ${game.home}\n`;
      ctx += `  Elo: ${game.home} ${homeRating.elo} | ${game.away} ${awayRating.elo}\n`;
      ctx += `  Model Win%: ${game.home} ${(homeWinProb * 100).toFixed(1)}% | ${game.away} ${((1 - homeWinProb) * 100).toFixed(1)}%\n`;
      ctx += `  Projected Score: ${game.home} ${projHomeScore.toFixed(1)} - ${game.away} ${projAwayScore.toFixed(1)}\n`;
      ctx += `  Projected Spread: ${game.home} ${projSpread > 0 ? '+' : ''}${projSpread.toFixed(1)}\n`;
      ctx += `  Projected Total: ${projTotal.toFixed(1)}\n`;
      ctx += `  Net Ratings: ${game.home} ${homeRating.netRating > 0 ? '+' : ''}${homeRating.netRating} | ${game.away} ${awayRating.netRating > 0 ? '+' : ''}${awayRating.netRating}\n`;
      ctx += `  Streaks: ${game.home} ${formatStreak(homeRating.streak)} | ${game.away} ${formatStreak(awayRating.streak)}\n`;

      // Last 5 games summary
      if (homeRating.last5 && homeRating.last5.length > 0) {
        const record = homeRating.last5.map(g => g.result).join("");
        ctx += `  ${game.home} Last 5: ${record} (avg ${homeRating.avgScored5} scored, ${homeRating.avgAllowed5} allowed)\n`;
      }
      if (awayRating.last5 && awayRating.last5.length > 0) {
        const record = awayRating.last5.map(g => g.result).join("");
        ctx += `  ${game.away} Last 5: ${record} (avg ${awayRating.avgScored5} scored, ${awayRating.avgAllowed5} allowed)\n`;
      }

      // Flag edge vs consensus
      // (will be compared to odds data by Claude)
    }
  }

  if (matchupCount === 0) {
    return "\n\n=== STATISTICAL MODEL: No pre-built ratings available. Use web search for team stats. ===\n";
  }

  ctx += `\n=== ${matchupCount} matchups projected. Compare Model Spread/Total to Consensus Lines above to find edges. ===\n`;
  ctx += "EDGE DETECTION: When the model's projected spread differs from the consensus line by 3+ points, that's a potential edge.\n";
  ctx += "When the model's projected total differs from the posted O/U by 4+ points, that's a totals edge.\n";

  return ctx;
}

// ── Fuzzy team name matching for ratings ──
function findTeam(teams, name) {
  if (!name || !teams) return null;
  // Direct match
  if (teams[name]) return teams[name];
  // Case-insensitive partial match
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(teams)) {
    if (key.toLowerCase() === lower) return val;
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
    // Match last word (e.g., "Celtics" matches "Boston Celtics")
    const lastWord = lower.split(/\s+/).pop();
    const keyLast = key.toLowerCase().split(/\s+/).pop();
    if (lastWord === keyLast && lastWord.length > 3) return val;
    // Match abbreviation
    if (val.abbr && val.abbr.toLowerCase() === lower) return val;
  }
  return null;
}

function formatStreak(streak) {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return "—";
}

exports.handler = async (event) => {
  console.log("[v2-picks] Optimized background function started");

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.error("[v2-picks] ANTHROPIC_API_KEY not set");
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
        timeZone: "America/New_York",
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      }).format(d);
    }
  } catch (e) { /* ignore */ }

  if (!dateISO) {
    const estFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const estParts = estFormatter.formatToParts(now);
    const year = estParts.find(p => p.type === "year").value;
    const month = estParts.find(p => p.type === "month").value;
    const day = estParts.find(p => p.type === "day").value;
    dateISO = `${year}-${month}-${day}`;
    dateFormatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(now);
  }

  console.log(`[v2-picks] Generating optimized picks for ${dateISO}`);

  // ── Step 1: Pre-fetch live sports data + statistical ratings ──
  const [oddsData, espnData, ratingsData] = await Promise.all([
    fetchOdds(dateISO),
    fetchESPNData(dateISO),
    fetchRatings(),
  ]);

  const liveDataContext = formatDataForPrompt(oddsData, espnData);
  const ratingsContext = formatRatingsForPrompt(ratingsData, espnData, oddsData);
  console.log(`[v2-picks] Live data context: ${liveDataContext.length} chars`);
  console.log(`[v2-picks] Ratings context: ${ratingsContext.length} chars`);

  const userMessage = buildUserPrompt(dateFormatted, dateISO) + liveDataContext + ratingsContext;

  // ── Step 2: Call Claude Sonnet with optimized settings ──
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
        max_tokens: 32000,
        temperature: 0.2,
        system: THE_LOCK_SYSTEM,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 40,
          }
        ],
        messages: [
          { role: "user", content: userMessage }
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[v2-picks] Claude API error ${response.status}: ${errText}`);
      return { statusCode: 500, body: "Claude API error" };
    }

    const result = await response.json();
    console.log("[v2-picks] Claude API response received, stop_reason:", result.stop_reason);

    // Extract text (skip web search result blocks)
    let rawText = "";
    for (const block of result.content) {
      if (block.type === "text") {
        rawText += block.text;
      }
    }

    console.log(`[v2-picks] Raw text length: ${rawText.length}`);
    console.log(`[v2-picks] Raw text preview: ${rawText.substring(0, 500)}`);

    // Parse JSON
    let picksData;
    try {
      // Try to find JSON in the response (may have thinking text before it)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];
        try {
          picksData = JSON.parse(jsonStr);
        } catch (e) {
          // Fix common issues
          let fixed = jsonStr
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']')
            .replace(/[\x00-\x1F\x7F]/g, ' ');
          picksData = JSON.parse(fixed);
        }
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseErr) {
      console.error("[v2-picks] JSON parse failed:", parseErr.message);
      console.error("[v2-picks] Raw response:", rawText.substring(0, 1000));
      await storePicks(dateISO, {
        date: dateISO,
        dateFormatted,
        picks: [],
        rejections: [{ matchup: "System", side: "N/A", reason: "AI response did not contain valid JSON. Will retry." }],
        summary: { totalPicks: 0, totalUnits: "0u", aplusLocks: 0, sportsCovered: [] },
        error: true,
        version: "v2",
        generatedAt: now.toISOString(),
      });
      return { statusCode: 200, body: "Stored error state" };
    }

    // Validate and enrich
    picksData.generatedAt = now.toISOString();
    picksData.version = "v2";
    picksData.date = picksData.date || dateISO;
    picksData.dateFormatted = picksData.dateFormatted || dateFormatted;
    picksData.picks = picksData.picks || [];
    picksData.parlayLegs = picksData.parlayLegs || [];
    picksData.sgps = picksData.sgps || [];
    picksData.rejections = picksData.rejections || [];
    picksData.summary = picksData.summary || {};

    // Store chain-of-thought / thinking text if present
    const jsonStart = rawText.indexOf('{');
    if (jsonStart > 50) {
      picksData.thinkingText = rawText.substring(0, jsonStart).trim();
    }

    // Normalize confidence field
    const ratingMap = { "A+": "aplus", "A": "a", "A-": "aminus", "B+": "bplus", "B": "b" };
    for (const pick of [...picksData.picks, ...picksData.parlayLegs]) {
      if (!pick.confidence && pick.rating) {
        pick.confidence = ratingMap[pick.rating] || "b";
      }
    }

    // Store to separate v2 blob store
    await storePicks(dateISO, picksData);

    const pickCount = picksData.picks?.length || 0;
    console.log(`[v2-picks] SUCCESS: ${pickCount} picks for ${dateISO} (v2 optimized)`);
    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("[v2-picks] Fatal error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};

// Store to SEPARATE v2 blob store
async function storePicks(dateISO, picksData) {
  const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  const token = process.env.NETLIFY_AUTH_TOKEN;

  if (!token) {
    console.error("[v2-picks] NETLIFY_AUTH_TOKEN not set");
    return;
  }

  // Use "edge-picks-v2" store — separate from production "edge-picks"
  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-v2`;

  try {
    const putPicks = await fetch(`${storeUrl}/picks-${dateISO}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(picksData),
    });

    if (!putPicks.ok) {
      const errBody = await putPicks.text();
      console.error(`[v2-picks] Blob PUT failed ${putPicks.status}: ${errBody.substring(0, 200)}`);
    } else {
      console.log("[v2-picks] V2 picks stored");
    }

    await fetch(`${storeUrl}/latest-date`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: dateISO,
    });
  } catch (err) {
    console.error(`[v2-picks] Blob store error: ${err.message}`);
  }
}
