// get-bettoredge.js
// API endpoint: GET /.netlify/functions/get-bettoredge
// Returns BettorEdge exchange data: active events, external sportsbook prices,
// exchange trades, and available orders. Caches in Netlify Blobs (5min TTL).

const { bettoredgeFetch } = require("./bettoredge-auth");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const EVENTS_BASE = "https://api.events.bettoredge.com/v1";
const MARKETS_BASE = "https://api.markets.bettoredge.com/v1";

// Sports we care about — map BettorEdge league names to our sport keys
const LEAGUE_FILTER = [
  "nba", "nhl", "mlb", "nfl",
  "epl", "la liga", "serie a", "bundesliga", "ligue 1", "mls",
  "ucl", "europa", "ncaab", "ncaaf", "ncaam", "pga", "ufc", "atp",
];

function leagueMatches(leagueName) {
  const lower = (leagueName || "").toLowerCase();
  return LEAGUE_FILTER.some((f) => lower.includes(f));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    // Check blob cache first (5min TTL)
    const now = new Date();
    const dateKey = now.toISOString().split("T")[0];
    const cacheKey = `bettoredge-${dateKey}-${Math.floor(now.getTime() / (5 * 60 * 1000))}`;

    let cached = null;
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("bettoredge-data");
      cached = await store.get(cacheKey, { type: "json" });
      if (cached) {
        console.log("[get-bettoredge] Serving from cache:", cacheKey);
        return {
          statusCode: 200,
          headers: { ...CORS, "Cache-Control": "public, max-age=300, s-maxage=300" },
          body: JSON.stringify(cached),
        };
      }
    } catch (e) {
      console.log("[get-bettoredge] Blob cache miss or unavailable:", e.message);
    }

    // 1. Fetch active leagues
    console.log("[get-bettoredge] Fetching active leagues...");
    const leaguesResp = await bettoredgeFetch(`${EVENTS_BASE}/leagues?status=active`);
    if (!leaguesResp.ok) throw new Error(`Leagues fetch failed: ${leaguesResp.status}`);
    const leaguesData = await leaguesResp.json();

    const leagues = (leaguesData.leagues || leaguesData.teams || []).filter((l) => leagueMatches(l.league_name));
    console.log(`[get-bettoredge] ${leagues.length} matching leagues found`);

    // 2. Fetch active events (expanded) for each league
    console.log("[get-bettoredge] Fetching active events...");
    const eventsResp = await bettoredgeFetch(`${EVENTS_BASE}/events/active?expanded=true`);
    if (!eventsResp.ok) throw new Error(`Events fetch failed: ${eventsResp.status}`);
    const eventsData = await eventsResp.json();

    const leagueIds = new Set(leagues.map((l) => l.league_id));
    const allEvents = (eventsData.events || []).filter((e) => leagueIds.has(e.league_id));
    console.log(`[get-bettoredge] ${allEvents.length} active events in target leagues`);

    // 3. Fetch external prices + exchange trades for each event (batch, max 20 concurrent)
    const enrichedEvents = [];
    const batchSize = 10;

    for (let i = 0; i < allEvents.length; i += batchSize) {
      const batch = allEvents.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (evt) => {
          const eventId = evt.event_id;
          const [pricesResp, tradesResp] = await Promise.all([
            bettoredgeFetch(`${EVENTS_BASE}/prices/latest/${eventId}/team`).catch(() => null),
            bettoredgeFetch(`${MARKETS_BASE}/trades/event/latest/${eventId}/team`).catch(() => null),
          ]);

          let prices = [];
          let trades = [];

          if (pricesResp && pricesResp.ok) {
            const pd = await pricesResp.json();
            prices = pd.prices || [];
          }
          if (tradesResp && tradesResp.ok) {
            const td = await tradesResp.json();
            trades = td.trades || [];
          }

          // Find the league name for this event
          const league = leagues.find((l) => l.league_id === evt.league_id);

          return {
            eventId,
            eventTitle: evt.event_title || `${evt.away?.name || "Away"} vs ${evt.home?.name || "Home"}`,
            scheduledDatetime: evt.scheduled_datetime,
            leagueId: evt.league_id,
            leagueName: league?.league_name || evt.league_name || "Unknown",
            sport: league?.sport || "unknown",
            status: evt.status,
            home: {
              teamId: evt.home?.team_id,
              name: evt.home?.name,
              abbr: evt.home?.abbr,
              score: evt.home_team_score,
            },
            away: {
              teamId: evt.away?.team_id,
              name: evt.away?.name,
              abbr: evt.away?.abbr,
              score: evt.away_team_score,
            },
            // Supported markets on BettorEdge
            supportedMarkets: (evt.supported_markets || []).map((m) => ({
              marketId: m.market_id,
              availableOrders: (m.available_orders || []).map((o) => ({
                title: o.title,
                side: o.side,
                odds: o.odds,
                probability: o.probability,
                openAmt: o.open_amt,
                var1: o.var_1,
              })),
              latestTrades: (m.latest_trades || []).map((t) => ({
                marketId: t.market_id,
                side: t.side,
                odds: t.odds,
                probability: t.probability,
                tradeAmt: t.trade_amt,
                var1: t.var_1,
                marketType: t.market_type,
              })),
            })),
            // External sportsbook prices (DraftKings, FanDuel, etc.)
            externalPrices: prices.map((p) => ({
              source: p.external_name,
              market: p.market,
              marketId: p.market_id,
              side: p.side,
              odds: p.odds,
              var1: p.var_1,
              vigPct: p.vig_pct,
              probability: p.probability,
              participantId: p.participant_id,
              participantType: p.participant_type,
              trend: p.trend_direction,
              status: p.status,
            })),
            // BettorEdge exchange trades
            exchangeTrades: trades.map((t) => ({
              marketId: t.market_id,
              side: t.side,
              odds: typeof t.odds === "string" ? parseFloat(t.odds) : t.odds,
              probability: t.probability,
              tradeAmt: t.trade_amt,
              cumulativeAmt: t.cumulative_amt,
              var1: t.var_1,
              marketType: t.market_type,
            })),
          };
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") enrichedEvents.push(r.value);
      }
    }

    // 4. Fetch all available orders (best unfilled P2P exchange orders)
    console.log("[get-bettoredge] Fetching available orders...");
    let availableOrders = { events: [], tournaments: [], matches: [] };
    try {
      const ordersResp = await bettoredgeFetch(`${MARKETS_BASE}/orders/available`);
      if (ordersResp.ok) {
        availableOrders = await ordersResp.json();
      }
    } catch (e) {
      console.error("[get-bettoredge] Available orders fetch error:", e.message);
    }

    // 5. Fetch all markets for reference
    let allMarkets = [];
    try {
      const marketsResp = await bettoredgeFetch(`${MARKETS_BASE}/markets/all`);
      if (marketsResp.ok) {
        const md = await marketsResp.json();
        allMarkets = (md.markets || []).map((m) => ({
          marketId: m.market_id,
          description: m.description,
          type: m.type,
          stat: m.stat,
          level: m.level,
          statLabel: m.stat_label,
        }));
      }
    } catch (e) {
      console.error("[get-bettoredge] Markets fetch error:", e.message);
    }

    // Build response
    const response = {
      date: dateKey,
      generatedAt: now.toISOString(),
      leagues: leagues.map((l) => ({
        leagueId: l.league_id,
        leagueName: l.league_name,
        sport: l.sport,
        externalOddsId: l.external_odds_id,
      })),
      events: enrichedEvents,
      markets: allMarkets,
      availableOrdersSummary: {
        totalEvents: (availableOrders.events || []).length,
        totalTournaments: (availableOrders.tournaments || []).length,
        totalMatches: (availableOrders.matches || []).length,
      },
      summary: {
        totalLeagues: leagues.length,
        totalEvents: enrichedEvents.length,
        eventsWithPrices: enrichedEvents.filter((e) => e.externalPrices.length > 0).length,
        eventsWithTrades: enrichedEvents.filter((e) => e.exchangeTrades.length > 0).length,
      },
    };

    // Cache to blobs
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("bettoredge-data");
      await store.setJSON(cacheKey, response);
      console.log("[get-bettoredge] Cached to blob:", cacheKey);
    } catch (e) {
      console.log("[get-bettoredge] Cache write skipped:", e.message);
    }

    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=300, s-maxage=300" },
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error("[get-bettoredge] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: err.message }),
    };
  }
};
