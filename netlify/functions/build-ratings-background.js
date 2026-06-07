// build-ratings-background.js
// Background function: fetches 60 days of ESPN results, computes Elo ratings,
// offensive/defensive efficiency, pace, and projected lines per team.
// Stores to "edge-ratings" Netlify Blob store.
// Trigger via: POST /api/build-ratings?key=SECRET
// Auto-triggered by generate-picks-v2-background before picks generation.

// K-factors and home advantage calibrated to FiveThirtyEight / published sports Elo research:
// NBA: k=20, homeAdv=100 — standard, well-validated
// NHL: k=6 (high luck, low-count discrete events), homeAdv=50 (Neil Paine / FiveThirtyEight)
// MLB: k=4 (highest luck component in major US sports), homeAdv=24 (FiveThirtyEight MLB Elo)
// Must match ESPN_LEAGUES in generate-picks-alpha-background.js exactly.
const ESPN_LEAGUES = [
  { sport: "basketball", league: "nba", label: "NBA", homeAdv: 100, kFactor: 20, baseElo: 1500 },
  { sport: "hockey", league: "nhl", label: "NHL", homeAdv: 50, kFactor: 6, baseElo: 1500 },
  { sport: "baseball", league: "mlb", label: "MLB", homeAdv: 24, kFactor: 4, baseElo: 1500 },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAAB", homeAdv: 120, kFactor: 32, baseElo: 1500 },
  { sport: "soccer", league: "eng.1", label: "EPL", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "esp.1", label: "La Liga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ita.1", label: "Serie A", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "ger.1", label: "Bundesliga", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "fra.1", label: "Ligue 1", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "usa.1", label: "MLS", homeAdv: 80, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.champions", label: "UCL", homeAdv: 60, kFactor: 24, baseElo: 1500 },
  { sport: "soccer", league: "uefa.europa", label: "Europa", homeAdv: 60, kFactor: 24, baseElo: 1500 },
];

// ── Elo math ──
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function marginMultiplier(marginOfVictory, eloDiff) {
  // Multiplier that rewards blowouts but with diminishing returns (FiveThirtyEight-style)
  const abs = Math.abs(marginOfVictory);
  return Math.log(abs + 1) * (2.2 / ((eloDiff * 0.001) + 2.2));
}

// ── Fetch one day of results from ESPN scoreboard ──
async function fetchDayResults(sport, league, dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateStr}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const events = data.events || [];
    const games = [];

    for (const event of events) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const status = event.status?.type?.state;
      if (status !== "post") continue; // Only completed games

      const home = comp.competitors?.find(c => c.homeAway === "home");
      const away = comp.competitors?.find(c => c.homeAway === "away");
      if (!home || !away) continue;

      const homeScore = parseFloat(home.score);
      const awayScore = parseFloat(away.score);
      if (isNaN(homeScore) || isNaN(awayScore)) continue;

      games.push({
        date: dateStr,
        homeTeam: home.team?.displayName || "Unknown",
        homeId: home.team?.id || "",
        homeAbbr: home.team?.abbreviation || "",
        awayTeam: away.team?.displayName || "Unknown",
        awayId: away.team?.id || "",
        awayAbbr: away.team?.abbreviation || "",
        homeScore,
        awayScore,
        totalScore: homeScore + awayScore,
        margin: homeScore - awayScore,
      });
    }
    return games;
  } catch (e) {
    return [];
  }
}

// ── Build ratings for one league ──
async function buildLeagueRatings(leagueConfig, daysBack = 60) {
  const { sport, league, label, homeAdv, kFactor, baseElo } = leagueConfig;
  console.log(`[ratings] Building ${label} ratings (${daysBack} days)...`);

  // Generate date range
  const dates = [];
  const now = new Date();
  for (let i = daysBack; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0].replace(/-/g, ""));
  }

  // Fetch all results (batch 5 days at a time to avoid rate limits)
  const allGames = [];
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(d => fetchDayResults(sport, league, d))
    );
    for (const games of results) {
      allGames.push(...games);
    }
    // Small delay between batches
    if (i + 5 < dates.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[ratings] ${label}: ${allGames.length} completed games found`);

  if (allGames.length === 0) {
    return { label, teams: {}, gameCount: 0 };
  }

  // Initialize team ratings
  const teams = {};
  function getTeam(name, id, abbr) {
    if (!teams[name]) {
      teams[name] = {
        name,
        id,
        abbr,
        elo: baseElo,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        homeWins: 0,
        homeLosses: 0,
        awayWins: 0,
        awayLosses: 0,
        pointsScored: [],     // last N games
        pointsAllowed: [],
        homeScored: [],
        homeAllowed: [],
        awayScored: [],
        awayAllowed: [],
        last5: [],             // last 5 game results: {date, opponent, score, opponentScore, result, home}
        streak: 0,             // positive = win streak, negative = loss streak
        lastGameDate: null,    // date string of most recent game (YYYYMMDD)
        opponentElos: [],      // Elo of opponents at time of game (for SOS)
        eloProjections: [],    // {projected, actual, covered} for cover rate tracking
      };
    }
    return teams[name];
  }

  // Process games chronologically
  allGames.sort((a, b) => a.date.localeCompare(b.date));

  for (const game of allGames) {
    const homeTeam = getTeam(game.homeTeam, game.homeId, game.homeAbbr);
    const awayTeam = getTeam(game.awayTeam, game.awayId, game.awayAbbr);

    // Elo update with home advantage
    const homeEloAdj = homeTeam.elo + homeAdv;
    const awayEloAdj = awayTeam.elo;

    const homeExpected = expectedScore(homeEloAdj, awayEloAdj);
    const awayExpected = 1 - homeExpected;

    let homeActual, awayActual;
    if (game.homeScore > game.awayScore) {
      homeActual = 1;
      awayActual = 0;
      homeTeam.wins++;
      awayTeam.losses++;
      homeTeam.streak = homeTeam.streak > 0 ? homeTeam.streak + 1 : 1;
      awayTeam.streak = awayTeam.streak < 0 ? awayTeam.streak - 1 : -1;
    } else if (game.awayScore > game.homeScore) {
      homeActual = 0;
      awayActual = 1;
      homeTeam.losses++;
      awayTeam.wins++;
      homeTeam.streak = homeTeam.streak < 0 ? homeTeam.streak - 1 : -1;
      awayTeam.streak = awayTeam.streak > 0 ? awayTeam.streak + 1 : 1;
    } else {
      // Draw (soccer)
      homeActual = 0.5;
      awayActual = 0.5;
      homeTeam.draws++;
      awayTeam.draws++;
      homeTeam.streak = 0;
      awayTeam.streak = 0;
    }

    // Margin-adjusted K factor
    const movMult = marginMultiplier(game.margin, homeEloAdj - awayEloAdj);
    const adjK = kFactor * movMult;

    // Track Elo projection vs actual margin for cover rate (before Elo update)
    const eloSpreadProjection = (homeEloAdj - awayEloAdj) / 25; // rough Elo-to-spread conversion
    const actualMargin = game.homeScore - game.awayScore;
    homeTeam.eloProjections.push({
      projected: eloSpreadProjection,
      actual: actualMargin,
      covered: actualMargin > eloSpreadProjection,
    });
    awayTeam.eloProjections.push({
      projected: -eloSpreadProjection,
      actual: -actualMargin,
      covered: -actualMargin > -eloSpreadProjection,
    });
    if (homeTeam.eloProjections.length > 10) homeTeam.eloProjections.shift();
    if (awayTeam.eloProjections.length > 10) awayTeam.eloProjections.shift();

    // Track opponent Elo at time of game (for SOS)
    homeTeam.opponentElos.push(awayTeam.elo);
    awayTeam.opponentElos.push(homeTeam.elo);
    if (homeTeam.opponentElos.length > 10) homeTeam.opponentElos.shift();
    if (awayTeam.opponentElos.length > 10) awayTeam.opponentElos.shift();

    homeTeam.elo += adjK * (homeActual - homeExpected);
    awayTeam.elo += adjK * (awayActual - awayExpected);
    homeTeam.gamesPlayed++;
    awayTeam.gamesPlayed++;

    // Track last game date
    homeTeam.lastGameDate = game.date;
    awayTeam.lastGameDate = game.date;

    // Track home/away W-L
    if (game.homeScore > game.awayScore) {
      homeTeam.homeWins++;
      awayTeam.awayLosses++;
    } else if (game.awayScore > game.homeScore) {
      homeTeam.homeLosses++;
      awayTeam.awayWins++;
    }

    // Track scoring (keep last 15 games for rolling averages)
    const maxHistory = 15;
    homeTeam.pointsScored.push(game.homeScore);
    homeTeam.pointsAllowed.push(game.awayScore);
    homeTeam.homeScored.push(game.homeScore);
    homeTeam.homeAllowed.push(game.awayScore);
    awayTeam.pointsScored.push(game.awayScore);
    awayTeam.pointsAllowed.push(game.homeScore);
    awayTeam.awayScored.push(game.awayScore);
    awayTeam.awayAllowed.push(game.homeScore);

    if (homeTeam.pointsScored.length > maxHistory) {
      homeTeam.pointsScored.shift();
      homeTeam.pointsAllowed.shift();
    }
    if (homeTeam.homeScored.length > maxHistory) {
      homeTeam.homeScored.shift();
      homeTeam.homeAllowed.shift();
    }
    if (awayTeam.pointsScored.length > maxHistory) {
      awayTeam.pointsScored.shift();
      awayTeam.pointsAllowed.shift();
    }
    if (awayTeam.awayScored.length > maxHistory) {
      awayTeam.awayScored.shift();
      awayTeam.awayAllowed.shift();
    }

    // Track last 5 games
    const homeResult = game.homeScore > game.awayScore ? "W" : game.homeScore < game.awayScore ? "L" : "D";
    const awayResult = game.awayScore > game.homeScore ? "W" : game.awayScore < game.homeScore ? "L" : "D";
    homeTeam.last5.push({
      date: game.date,
      opponent: game.awayTeam,
      scored: game.homeScore,
      allowed: game.awayScore,
      result: homeResult,
      home: true,
    });
    awayTeam.last5.push({
      date: game.date,
      opponent: game.homeTeam,
      scored: game.awayScore,
      allowed: game.homeScore,
      result: awayResult,
      home: false,
    });
    if (homeTeam.last5.length > 5) homeTeam.last5.shift();
    if (awayTeam.last5.length > 5) awayTeam.last5.shift();
  }

  // Compute derived metrics for each team
  const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const leagueAvgScored = avg(allGames.map(g => g.homeScore + g.awayScore)) / 2;

  for (const team of Object.values(teams)) {
    const last10Scored = team.pointsScored.slice(-10);
    const last10Allowed = team.pointsAllowed.slice(-10);
    const last5Scored = team.pointsScored.slice(-5);
    const last5Allowed = team.pointsAllowed.slice(-5);

    team.avgScored10 = +avg(last10Scored).toFixed(1);
    team.avgAllowed10 = +avg(last10Allowed).toFixed(1);
    team.avgScored5 = +avg(last5Scored).toFixed(1);
    team.avgAllowed5 = +avg(last5Allowed).toFixed(1);

    // Offensive/Defensive ratings relative to league average
    // ORtg > 1.0 = better offense than average, DRtg < 1.0 = better defense than average
    if (leagueAvgScored > 0) {
      team.offRating = +(avg(last10Scored) / leagueAvgScored).toFixed(3);
      team.defRating = +(avg(last10Allowed) / leagueAvgScored).toFixed(3);
      team.netRating = +(team.offRating - team.defRating).toFixed(3);
    }

    // Home/away splits
    team.homeAvgScored = +avg(team.homeScored.slice(-5)).toFixed(1);
    team.homeAvgAllowed = +avg(team.homeAllowed.slice(-5)).toFixed(1);
    team.awayAvgScored = +avg(team.awayScored.slice(-5)).toFixed(1);
    team.awayAvgAllowed = +avg(team.awayAllowed.slice(-5)).toFixed(1);

    team.elo = +team.elo.toFixed(0);

    // ── Rest days detection ──
    if (team.lastGameDate) {
      const lastDateStr = team.lastGameDate;
      const lastDate = new Date(
        parseInt(lastDateStr.substring(0, 4)),
        parseInt(lastDateStr.substring(4, 6)) - 1,
        parseInt(lastDateStr.substring(6, 8))
      );
      const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      team.daysSinceLastGame = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));
    } else {
      team.daysSinceLastGame = null;
    }

    // ── Strength of Schedule (SOS) ──
    // Average Elo of last 10 opponents
    team.sosRating = team.opponentElos.length > 0
      ? +avg(team.opponentElos).toFixed(0)
      : baseElo;

    // ── Pace factor ──
    // Approximation: average (scored + allowed) / 2 over last 5 games
    const paceScoredLast5 = team.pointsScored.slice(-5);
    const paceAllowedLast5 = team.pointsAllowed.slice(-5);
    if (paceScoredLast5.length > 0) {
      const paceValues = paceScoredLast5.map((s, i) => (s + (paceAllowedLast5[i] || 0)) / 2);
      team.pace = +avg(paceValues).toFixed(1);
    } else {
      team.pace = 0;
    }

    // ── Cover rate ──
    // Percentage of last 10 games where team covered Elo-projected spread
    if (team.eloProjections.length > 0) {
      const covered = team.eloProjections.filter(p => p.covered).length;
      team.coverRate = +((covered / team.eloProjections.length) * 100).toFixed(1);
    } else {
      team.coverRate = 50.0;
    }

    // ── Home/Away record ──
    team.homeRecord = `${team.homeWins}-${team.homeLosses}`;
    team.awayRecord = `${team.awayWins}-${team.awayLosses}`;

    // Clean up raw arrays (don't store in blob — too large)
    delete team.pointsScored;
    delete team.pointsAllowed;
    delete team.homeScored;
    delete team.homeAllowed;
    delete team.awayScored;
    delete team.awayAllowed;
    delete team.opponentElos;
    delete team.eloProjections;
    delete team.lastGameDate;
    delete team.homeWins;
    delete team.homeLosses;
    delete team.awayWins;
    delete team.awayLosses;
  }

  return { label, teams, gameCount: allGames.length, leagueAvgScore: +leagueAvgScored.toFixed(1) };
}

// ── Predict matchup ──
function predictMatchup(homeTeam, awayTeam, leagueConfig, leagueAvgScore) {
  if (!homeTeam || !awayTeam) return null;

  const { homeAdv } = leagueConfig;

  // Elo-based win probability
  const homeEloAdj = homeTeam.elo + homeAdv;
  const homeWinProb = expectedScore(homeEloAdj, awayTeam.elo);

  // Score prediction using team efficiency + home/away splits
  // Home team: (their home avg scored + opponent away avg allowed) / 2
  // Away team: (their away avg scored + opponent home avg allowed) / 2
  const projectedHomeScore = (homeTeam.homeAvgScored + awayTeam.awayAvgAllowed) / 2;
  const projectedAwayScore = (awayTeam.awayAvgScored + homeTeam.homeAvgAllowed) / 2;
  const projectedTotal = projectedHomeScore + projectedAwayScore;
  const projectedSpread = -(projectedHomeScore - projectedAwayScore); // negative = home favored

  return {
    homeTeam: homeTeam.name,
    awayTeam: awayTeam.name,
    homeElo: homeTeam.elo,
    awayElo: awayTeam.elo,
    homeWinProb: +(homeWinProb * 100).toFixed(1),
    awayWinProb: +((1 - homeWinProb) * 100).toFixed(1),
    projectedHomeScore: +projectedHomeScore.toFixed(1),
    projectedAwayScore: +projectedAwayScore.toFixed(1),
    projectedSpread: +projectedSpread.toFixed(1),
    projectedTotal: +projectedTotal.toFixed(1),
    homeNetRating: homeTeam.netRating,
    awayNetRating: awayTeam.netRating,
    homeStreak: homeTeam.streak,
    awayStreak: awayTeam.streak,
    homeLast5: homeTeam.last5,
    awayLast5: awayTeam.last5,
  };
}

// ── Store ratings to Netlify Blobs ──
async function storeRatings(ratingsData) {
  const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error("[ratings] NETLIFY_AUTH_TOKEN not set");
    return;
  }

  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings`;

  try {
    // Store full ratings
    const putResp = await fetch(`${storeUrl}/latest`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ratingsData),
    });

    if (!putResp.ok) {
      const err = await putResp.text();
      console.error(`[ratings] Blob PUT failed ${putResp.status}: ${err.substring(0, 200)}`);
    } else {
      console.log("[ratings] Ratings stored to Blobs");
    }

    // Store historical copy at ratings-{dateISO} for backtesting
    const dateISO = new Date().toISOString().split("T")[0]; // e.g. "2026-03-21"
    const histResp = await fetch(`${storeUrl}/ratings-${dateISO}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ratingsData),
    });

    if (!histResp.ok) {
      const err = await histResp.text();
      console.error(`[ratings] Historical blob PUT failed ${histResp.status}: ${err.substring(0, 200)}`);
    } else {
      console.log(`[ratings] Historical ratings stored at ratings-${dateISO}`);
    }

    // Store timestamp
    await fetch(`${storeUrl}/last-updated`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[ratings] Store error: ${err.message}`);
  }
}

exports.handler = async (event) => {
  console.log("[ratings] Build ratings background function started");

  const startTime = Date.now();

  // Build ratings for all leagues in parallel (grouped to avoid rate limits)
  const results = {};
  const totalGames = {};

  // Process leagues in batches of 3
  for (let i = 0; i < ESPN_LEAGUES.length; i += 3) {
    const batch = ESPN_LEAGUES.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(config => buildLeagueRatings(config, 60))
    );
    for (const result of batchResults) {
      results[result.label] = {
        teams: result.teams,
        gameCount: result.gameCount,
        leagueAvgScore: result.leagueAvgScore,
      };
      totalGames[result.label] = result.gameCount;
    }
  }

  const ratingsData = {
    generatedAt: new Date().toISOString(),
    daysBack: 60,
    leagues: results,
    gamesSummary: totalGames,
    buildTimeMs: Date.now() - startTime,
  };

  const totalTeams = Object.values(results).reduce((sum, l) => sum + Object.keys(l.teams).length, 0);
  const totalGamesCount = Object.values(totalGames).reduce((sum, c) => sum + c, 0);
  console.log(`[ratings] Built ratings for ${totalTeams} teams across ${totalGamesCount} games in ${ratingsData.buildTimeMs}ms`);

  await storeRatings(ratingsData);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      success: true,
      teams: totalTeams,
      games: totalGamesCount,
      leagues: Object.keys(results),
      buildTimeMs: ratingsData.buildTimeMs,
    }),
  };
};

// Export for use by generate-picks-v2-background
module.exports.predictMatchup = predictMatchup;
module.exports.ESPN_LEAGUES = ESPN_LEAGUES;
