// get-ratings.js
// API endpoint: GET /api/get-ratings
// Returns team Elo ratings, efficiency metrics, and optionally predictions for today's games.
// Query params:
//   ?league=NBA — filter to one league
//   ?team=Boston Celtics — get one team's profile
//   ?predict=true — include projections for today's matchups

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
    const token = process.env.NETLIFY_AUTH_TOKEN;

    if (!token) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: false, message: "Ratings not configured yet." }),
      };
    }

    const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-ratings`;

    // Fetch ratings
    const resp = await fetch(`${storeUrl}/latest`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: false, message: "No ratings built yet. Trigger build-ratings first." }),
      };
    }

    const ratings = await resp.json();
    const params = event.queryStringParameters || {};

    // Filter by league
    if (params.league) {
      const league = ratings.leagues[params.league.toUpperCase()];
      if (!league) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ error: false, message: `No ratings for league: ${params.league}` }),
        };
      }

      // Filter by team
      if (params.team) {
        const team = league.teams[params.team];
        if (!team) {
          // Try fuzzy match
          const key = Object.keys(league.teams).find(k =>
            k.toLowerCase().includes(params.team.toLowerCase())
          );
          if (key) {
            return {
              statusCode: 200,
              headers: { ...CORS, "Cache-Control": "public, max-age=600" },
              body: JSON.stringify({ league: params.league, team: league.teams[key] }),
            };
          }
          return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({ error: false, message: `Team not found: ${params.team}` }),
          };
        }
        return {
          statusCode: 200,
          headers: { ...CORS, "Cache-Control": "public, max-age=600" },
          body: JSON.stringify({ league: params.league, team }),
        };
      }

      // Return full league sorted by Elo
      const sorted = Object.values(league.teams).sort((a, b) => b.elo - a.elo);
      return {
        statusCode: 200,
        headers: { ...CORS, "Cache-Control": "public, max-age=600" },
        body: JSON.stringify({
          league: params.league,
          gameCount: league.gameCount,
          leagueAvgScore: league.leagueAvgScore,
          teams: sorted,
          generatedAt: ratings.generatedAt,
        }),
      };
    }

    // Return summary (all leagues, top 5 per league by Elo)
    const summary = {};
    for (const [leagueName, league] of Object.entries(ratings.leagues)) {
      const sorted = Object.values(league.teams).sort((a, b) => b.elo - a.elo);
      summary[leagueName] = {
        teamCount: sorted.length,
        gameCount: league.gameCount,
        top5: sorted.slice(0, 5).map(t => ({
          name: t.name,
          elo: t.elo,
          record: `${t.wins}-${t.losses}${t.draws ? `-${t.draws}` : ""}`,
          netRating: t.netRating,
        })),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=600" },
      body: JSON.stringify({
        generatedAt: ratings.generatedAt,
        buildTimeMs: ratings.buildTimeMs,
        daysBack: ratings.daysBack,
        leagues: summary,
      }),
    };
  } catch (err) {
    console.error("[get-ratings] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: "Failed to fetch ratings" }),
    };
  }
};
