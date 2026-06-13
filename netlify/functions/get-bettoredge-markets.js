// get-bettoredge-markets.js
// API endpoint: GET /.netlify/functions/get-bettoredge-markets
// Returns top available markets on BettorEdge ranked by open volume.

const { bettoredgeFetch } = require("./bettoredge-auth");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const EVENTS_BASE = "https://api.events.bettoredge.com/v1";
const MARKETS_BASE = "https://api.markets.bettoredge.com/v1";
const LEAGUE_MAP = { "6": "NHL", "7": "NBA", "3": "MLB", "8": "NCAAM", "4": "MLS", "9": "PGA", "10": "UFC", "12": "EPL", "55": "NCAAWBB", "62": "ATP" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  try {
    const resp = await bettoredgeFetch(`${MARKETS_BASE}/orders/available`);
    if (!resp.ok) throw new Error(`BettorEdge API error: ${resp.status}`);
    const data = await resp.json();

    const orders = [];

    // Process events
    for (const container of data.events || []) {
      const lid = container.league_id || "?";
      const league = LEAGUE_MAP[lid] || lid;
      for (const mkt of container.supported_markets || []) {
        for (const order of mkt.available_orders || []) {
          orders.push({
            event: container.event_title || "?",
            league,
            leagueId: lid,
            scheduled: container.scheduled_datetime || null,
            title: order.title || "?",
            side: order.side || "?",
            odds: order.odds || 0,
            openAmt: order.open_amt || 0,
            potentialWinnings: order.potential_winnings || 0,
            probability: order.probability || 0,
            grade: order.grade || 0,
            var1: order.var_1 || 0,
            type: "game",
            url: order.url || "",
            playerId: order.player_id || "",
          });
        }
      }
    }

    // Process tournaments (futures)
    for (const container of data.tournaments || []) {
      const lid = container.league_id || "?";
      const league = (LEAGUE_MAP[lid] || lid) + " Futures";
      for (const mkt of container.supported_markets || []) {
        for (const order of mkt.available_orders || []) {
          orders.push({
            event: container.tournament_name || "?",
            league,
            leagueId: lid,
            scheduled: container.scheduled_datetime || null,
            title: order.title || "?",
            side: order.side || "?",
            odds: order.odds || 0,
            openAmt: order.open_amt || 0,
            potentialWinnings: order.potential_winnings || 0,
            probability: order.probability || 0,
            grade: order.grade || 0,
            var1: order.var_1 || 0,
            type: "futures",
            url: order.url || "",
            playerId: order.player_id || "",
          });
        }
      }
    }

    // Process matches
    for (const container of data.matches || []) {
      for (const mkt of container.supported_markets || []) {
        for (const order of mkt.available_orders || []) {
          orders.push({
            event: container.match_title || "?",
            league: "Match",
            leagueId: "?",
            scheduled: null,
            title: order.title || "?",
            side: order.side || "?",
            odds: order.odds || 0,
            openAmt: order.open_amt || 0,
            potentialWinnings: order.potential_winnings || 0,
            probability: order.probability || 0,
            grade: order.grade || 0,
            var1: order.var_1 || 0,
            type: "match",
            url: order.url || "",
            playerId: order.player_id || "",
          });
        }
      }
    }

    // Sort by volume
    orders.sort((a, b) => b.openAmt - a.openAmt);

    const totalVolume = orders.reduce((s, o) => s + o.openAmt, 0);
    const uniquePlayers = new Set(orders.map((o) => o.playerId)).size;
    const uniqueLeagues = [...new Set(orders.map((o) => o.league))];

    // ── Fetch executed trades (latest per market line) for volume context ──
    let executedVolume = { totalTrades: 0, cumulativeVolume: 0, earliestTrade: null, latestTrade: null, byLeague: {} };
    try {
      const eventsResp = await bettoredgeFetch(`${EVENTS_BASE}/events/active?expanded=true`);
      if (eventsResp.ok) {
        const eventsData = await eventsResp.json();
        const events = eventsData.events || [];

        // Fetch latest trades for each event (batch of 10)
        for (let i = 0; i < events.length; i += 10) {
          const batch = events.slice(i, i + 10);
          const results = await Promise.allSettled(batch.map(async (evt) => {
            const tResp = await bettoredgeFetch(`${MARKETS_BASE}/trades/event/latest/${evt.event_id}/team`).catch(() => null);
            if (!tResp || !tResp.ok) return [];
            const td = await tResp.json();
            return (td.trades || []).map((t) => ({ ...t, league_id: evt.league_id }));
          }));

          for (const r of results) {
            if (r.status === "fulfilled") {
              for (const t of r.value) {
                executedVolume.totalTrades++;
                executedVolume.cumulativeVolume += (t.cumulative_amt || 0);
                const lid = t.league_id || "?";
                const league = LEAGUE_MAP[lid] || lid;
                executedVolume.byLeague[league] = (executedVolume.byLeague[league] || 0) + (t.cumulative_amt || 0);

                // Track time window
                const tradeTime = t.create_datetime || t.last_update_datetime;
                if (tradeTime) {
                  if (!executedVolume.earliestTrade || tradeTime < executedVolume.earliestTrade) executedVolume.earliestTrade = tradeTime;
                  if (!executedVolume.latestTrade || tradeTime > executedVolume.latestTrade) executedVolume.latestTrade = tradeTime;
                }
              }
            }
          }
        }
      }
      executedVolume.cumulativeVolume = Math.round(executedVolume.cumulativeVolume * 100) / 100;
    } catch (e) {
      console.error("[get-bettoredge-markets] Executed trades fetch error:", e.message);
    }

    // ── FULL SLATE: every game from ESPN regardless of exchange liquidity ──
    // Free WeBit P2P bets don't need exchange liquidity — players bet each other.
    // Pull the full ESPN schedule and overlay BettorEdge orders where they exist.
    const ESPN_SB = {
      MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
      NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
      NHL: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard",
    };
    const abbrKey = (a, b) => [a, b].map(x => (x || "").toUpperCase()).sort().join("|");
    // Index orders by the abbreviations in their event title (e.g. "TEX - 0 vs BOS - 0")
    const ordersByGame = {};
    for (const o of orders) {
      const m = String(o.event || "").toUpperCase().match(/([A-Z]{2,4})\s*-?\s*\d*\s*(?:VS|@|AT)\s*([A-Z]{2,4})/);
      if (!m) continue;
      const k = abbrKey(m[1], m[2]);
      (ordersByGame[k] = ordersByGame[k] || []).push(o);
    }
    const games = [];
    await Promise.all(Object.entries(ESPN_SB).map(async ([sport, url]) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        const j = await r.json();
        for (const ev of (j.events || [])) {
          const c = (ev.competitions || [])[0]; if (!c) continue;
          const away = (c.competitors || []).find(x => x.homeAway === "away");
          const home = (c.competitors || []).find(x => x.homeAway === "home");
          if (!away || !home) continue;
          const aAbbr = (away.team || {}).abbreviation || "", hAbbr = (home.team || {}).abbreviation || "";
          const st = c.status && c.status.type ? c.status.type.state : "pre";
          games.push({
            sport, league: sport,
            event: `${(away.team || {}).displayName} vs ${(home.team || {}).displayName}`,
            awayTeam: (away.team || {}).displayName || "", homeTeam: (home.team || {}).displayName || "",
            awayAbbr: aAbbr, homeAbbr: hAbbr,
            scheduled: ev.date || null, state: st,
            orders: ordersByGame[abbrKey(aAbbr, hAbbr)] || [],
          });
        }
      } catch (e) { /* skip a league on error */ }
    }));
    // Upcoming first, then by scheduled time
    games.sort((a, b) => {
      const ap = a.state === "pre" ? 0 : 1, bp = b.state === "pre" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return new Date(a.scheduled || 0) - new Date(b.scheduled || 0);
    });

    return {
      statusCode: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=120, s-maxage=120" },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalOrders: orders.length,
        totalVolume: Math.round(totalVolume * 100) / 100,
        uniqueBettors: uniquePlayers,
        leagues: uniqueLeagues,
        orders,
        games,
        executedVolume,
      }),
    };
  } catch (err) {
    console.error("[get-bettoredge-markets] Error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: true, message: err.message }),
    };
  }
};
