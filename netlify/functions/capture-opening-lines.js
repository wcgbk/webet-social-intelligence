// capture-opening-lines.js
// Runs at 9am ET daily via trigger. Captures opening lines for all sports
// and stores them in Netlify Blobs for the picks pipeline to compare against.
// This enables stale-line detection: if the line has already moved toward
// our model's price by pick time, the edge is "captured" and less valuable.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

const ODDS_SPORTS = [
  "basketball_nba", "icehockey_nhl", "basketball_ncaab", "baseball_mlb",
  "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a",
  "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_usa_mls",
  "soccer_uefa_champs_league", "soccer_uefa_europa_league",
];

exports.handler = async (event) => {
  const apiKey = process.env.ODDS_API_KEY;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!apiKey || !token) {
    return { statusCode: 500, body: "Missing API keys" };
  }

  // Get today's date in EST
  const now = new Date();
  const estFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const estParts = estFormatter.formatToParts(now);
  const dateISO = `${estParts.find(p => p.type === "year").value}-${estParts.find(p => p.type === "month").value}-${estParts.find(p => p.type === "day").value}`;

  console.log(`[opening-lines] Capturing opening lines for ${dateISO}`);

  const lines = {};

  for (const sport of ODDS_SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();

      const todayGames = data.filter(g => {
        const gameTime = new Date(g.commence_time);
        const estDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(gameTime);
        const [m, d, y] = estDate.split('/');
        return `${y}-${m}-${d}` === dateISO;
      });

      for (const game of todayGames) {
        const key = `${game.away_team} @ ${game.home_team}`.toLowerCase();
        const spreads = [], totals = [], h2h = {};

        for (const book of (game.bookmakers || [])) {
          for (const mkt of (book.markets || [])) {
            if (mkt.key === 'spreads') {
              for (const o of mkt.outcomes) {
                if (o.name === game.home_team && o.point !== undefined) spreads.push(o.point);
              }
            }
            if (mkt.key === 'totals') {
              for (const o of mkt.outcomes) {
                if (o.name === 'Over' && o.point !== undefined) totals.push(o.point);
              }
            }
            if (mkt.key === 'h2h') {
              for (const o of mkt.outcomes) {
                if (!h2h[o.name]) h2h[o.name] = [];
                h2h[o.name].push(o.price);
              }
            }
          }
        }

        const medianSpread = spreads.length > 0 ? spreads.sort((a, b) => a - b)[Math.floor(spreads.length / 2)] : null;
        const medianTotal = totals.length > 0 ? totals.sort((a, b) => a - b)[Math.floor(totals.length / 2)] : null;
        const mlHome = h2h[game.home_team]?.sort((a, b) => a - b)?.[Math.floor((h2h[game.home_team]?.length || 1) / 2)] || null;
        const mlAway = h2h[game.away_team]?.sort((a, b) => a - b)?.[Math.floor((h2h[game.away_team]?.length || 1) / 2)] || null;

        lines[key] = {
          sport, homeTeam: game.home_team, awayTeam: game.away_team,
          openSpread: medianSpread, openTotal: medianTotal,
          openMLHome: mlHome, openMLAway: mlAway,
          capturedAt: now.toISOString(),
          bookCount: game.bookmakers?.length || 0,
        };
      }
    } catch (e) {
      console.log(`[opening-lines] Error for ${sport}: ${e.message}`);
    }
  }

  // Store to Netlify Blobs
  const blobKey = `opening-lines-${dateISO}`;
  const payload = { date: dateISO, capturedAt: now.toISOString(), games: lines, gameCount: Object.keys(lines).length };

  try {
    await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks/${blobKey}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    console.log(`[opening-lines] Stored ${Object.keys(lines).length} opening lines for ${dateISO}`);
  } catch (e) {
    console.log(`[opening-lines] Blob store failed: ${e.message}`);
  }

  return { statusCode: 200, body: JSON.stringify({ date: dateISO, games: Object.keys(lines).length }) };
};
