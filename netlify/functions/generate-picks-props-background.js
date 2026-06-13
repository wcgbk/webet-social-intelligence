// generate-picks-props-background.js
// All-Sport Player Props Engine v2.0 — TJ Bombard 10-Step Checklist
// Fetches player prop lines from The Odds API across NBA, MLB, NHL.
// Claude analyzes every prop with the full sharp money system prompt + web search.
// Background function (15min timeout). Stores to "edge-picks-props" Netlify Blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";

// ── Sports with player prop markets ──
const PROP_SPORTS = [
  { key: "basketball_nba", label: "NBA", espn: "basketball/nba" },
  { key: "baseball_mlb", label: "MLB", espn: "baseball/mlb" },
  { key: "icehockey_nhl", label: "NHL", espn: "hockey/nhl" },
];

// ── Player prop markets by sport ──
const PROP_MARKETS = {
  basketball_nba: [
    "player_points", "player_rebounds", "player_assists",
    "player_threes", "player_points_rebounds_assists",
  ],
  baseball_mlb: [
    "pitcher_strikeouts", "batter_hits", "batter_total_bases",
    "batter_rbis", "batter_home_runs",
  ],
  icehockey_nhl: [
    "player_points", "player_goals", "player_assists",
    "player_shots_on_goal",
  ],
};

// ── Readable market names ──
const MARKET_NAMES = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "3-Pointers",
  player_points_rebounds_assists: "PRA",
  player_blocks: "Blocks",
  player_steals: "Steals",
  pitcher_strikeouts: "Strikeouts",
  batter_hits: "Hits",
  batter_total_bases: "Total Bases",
  batter_rbis: "RBIs",
  batter_runs: "Runs",
  batter_home_runs: "Home Runs",
  player_goals: "Goals",
  player_shots_on_goal: "Shots on Goal",
};

// ── TJ Bombard System Prompt — All-Sport Player Props ──
const SYSTEM_PROMPT = `You are the world's most elite player props analyst — a fusion of Tokyo Brandon (WagerTalk's #1 profit capper), Action Network's Sharp Money Desk, RotoGrinders/Notorious, BettingPros Model, and Dimers Signal Engine.

You analyze player props across NBA, MLB, and NHL using the same sharp principles.

CORE PHILOSOPHY:
1. Beat the number, not the game. Win probability is irrelevant — attack the specific prop line.
2. Process over outcome. A bad beat on a +EV pick is still a win.
3. Line is everything. No line = no pick.
4. Closing Line Value (CLV) is the scorecard.
5. Sharp money reveals truth. Follow sharp action, not the crowd.

TIER SYSTEM:
- TIER A (2-3 units): Recent performance strongly supports direction (4-5 of last 5 games hit) + opponent vulnerability in this stat category + 2+ sharp signals + 5%+ projection edge
- TIER B (1-2 units): Recent trend supports direction (3 of last 5 hit) + favorable matchup + 1+ sharp signal + 3%+ projection edge
- TIER C (0.5-1 unit): Matchup angle only, marginal 2-3% projection edge, fewer confirming signals
- PASS: Recent performance contradicts direction (2 or fewer of last 5 hit), unfavorable matchup, no sharp signals, or line already moved significantly

10-STEP CHECKLIST (run for every prop):
1. Player availability & health check — injuries, rest days, minutes restrictions, lineup status
2. Recent form (last 5 games in this stat) — this is the HEAVIEST weight factor
3. Season averages vs the prop line — is the line above or below their average?
4. Opponent vulnerability in this stat category:
   - NBA: Opponent defensive rating, pace, points allowed to position, rebounds allowed, assists allowed
   - MLB: Opponent K rate vs handedness (for pitcher Ks), pitcher ERA/WHIP (for batter props)
   - NHL: Opponent goals against, shots allowed, PK/PP rates
5. Home/away splits and venue factors
6. Game script probability — total line, spread, blowout risk (affects minutes/playing time)
7. Line movement analysis — has the line moved? Which direction? Sharp or public action?
8. Cross-sport context — back-to-back games, travel, rest days, motivation (playoff race, contract year)
9. Sharp signal confirmation (need 2+ for Tier A/B): recent form ATS, opponent vulnerability ranking, projection edge 3%+, line movement favoring our side, situational edge
10. Commit or Pass — assign tier and units

SPORT-SPECIFIC GUIDANCE:

NBA PROPS:
- Points: Check usage rate, minutes projection, pace of game. High-total games = more possessions = more opportunities.
- Rebounds: Check opponent rebound rate, player's minutes, whether opponent plays small. Centers vs small-ball = value.
- Assists: Check pace, teammate health (more playmaking if star is out), opponent turnover rate.
- 3-Pointers: Check recent shooting %, volume of attempts, opponent 3PT defense. Volatile — only take with strong recent form.
- PRA (Points+Rebounds+Assists): Combo prop — look for correlated upside. High-usage stars in high-total games.

MLB PROPS:
- Pitcher Strikeouts: K/9 rate, opponent team K%, pitch count expectations, park K-factor, game total (low totals = fewer innings).
- Batter Hits: Batting average, matchup vs pitcher handedness, park factor, recent hot/cold streaks.
- Total Bases: Slugging %, power numbers, park factor, pitcher quality.
- RBIs: Batting order position (3-5 hitters get more RBI chances), runners on base opportunity.
- Home Runs: ISO power, park factor, pitcher HR/FB rate.

NHL PROPS:
- Goals: Shooting %, shots per game, PP time, opponent GA/game. Goals are volatile — weight recent form heavily.
- Shots on Goal: More stable than goals. Check SOG average, ice time, PP opportunities, opponent shot suppression.
- Points (G+A): Check overall production rate, line combinations, PP unit deployment.
- Assists: Check linemates' shooting, PP quarterback role, opponent PK weakness.

OUTPUT FORMAT — You MUST respond with valid JSON only, no other text:
{
  "analysis_date": "YYYY-MM-DD",
  "picks": [
    {
      "playerName": "Full Name",
      "sport": "basketball_nba" or "baseball_mlb" or "icehockey_nhl",
      "sportLabel": "NBA" or "MLB" or "NHL",
      "matchup": "Away Team @ Home Team",
      "statType": "Points" or "Rebounds" etc,
      "marketKey": "player_points" etc,
      "line": 24.5,
      "direction": "Over" or "Under",
      "pick": "Over 24.5 Points",
      "odds": "-110",
      "book": "Best book name",
      "tier": "A" or "B" or "C",
      "units": "2.0u",
      "confidence": "aplus" or "a" or "aminus",
      "rating": "A+" or "A" or "A-",
      "last5": "4/5 Over (28, 31, 22, 26, 30)",
      "seasonAvg": "25.3",
      "opponentRank": "Top 5 in points allowed to SGs",
      "projectionEdge": "+5.2%",
      "sharpSignals": 3,
      "edgePct": "5.2%",
      "ev": "+10%",
      "modelProb": "58%",
      "marketProb": "52%",
      "coreReasoning": "2-3 sentence analysis covering the top reasons this prop hits",
      "riskFactor": "1 sentence on the main risk",
      "commenceTime": "ISO timestamp from the data"
    }
  ],
  "rejections": [
    {
      "playerName": "Full Name",
      "sportLabel": "NBA" or "MLB" or "NHL",
      "matchup": "Away @ Home",
      "statType": "Points",
      "pick": "Over 24.5 Points",
      "reason": "1-2 sentence reason for pass"
    }
  ],
  "edgeSummary": "1-2 sentence overall slate summary across all sports"
}

CONFIDENCE MAPPING:
- Tier A = confidence "aplus", rating "A+", units 2.0-3.0u
- Tier B = confidence "a", rating "A", units 1.0-1.5u
- Tier C = confidence "aminus", rating "A-", units 0.5u

RULES:
- Maximum 5 picks per day across all sports. Quality over quantity.
- Never force a pick. PASS is valid and expected.
- Only output props that have lines in the data provided.
- Sort picks by tier (A first, then B, then C).
- Always say "WeBetAI" instead of "the model" in narratives.
- Use web search to verify: injury reports, recent game logs, matchup stats, lineup confirmations.
- For early season / insufficient data: use career stats, last season stats, and spring training / preseason data as proxies. Do NOT skip a player due to lack of current season data.`;

// ── Fetch events for a sport ──
async function fetchEvents(sportKey, apiKey, dateISO) {
  try {
    const startDate = `${dateISO}T00:00:00Z`;
    const endDate = `${dateISO}T23:59:59Z`;
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}&dateFormat=iso&commencesFrom=${startDate}&commencesTo=${endDate}`;
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[props] Events ${sportKey}: ${resp.status}`); return []; }
    return await resp.json();
  } catch (e) {
    console.log(`[props] Events fetch error ${sportKey}: ${e.message}`);
    return [];
  }
}

// ── Fetch player props for a single event ──
async function fetchEventProps(eventId, sportKey, markets, apiKey) {
  try {
    const marketsParam = markets.join(",");
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${apiKey}&regions=us,us2&markets=${marketsParam}&oddsFormat=american`;
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`[props] Props ${sportKey}/${eventId}: ${resp.status}`); return null; }
    return await resp.json();
  } catch (e) {
    console.log(`[props] Props fetch error ${sportKey}/${eventId}: ${e.message}`);
    return null;
  }
}

// ── Fetch game-level odds (ML + totals) for game script context ──
async function fetchGameOdds(sportKey, apiKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,us2&markets=h2h,totals&oddsFormat=american`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    return await resp.json();
  } catch (e) { return []; }
}

// ── Extract and organize prop lines per player ──
function extractProps(propsData) {
  if (!propsData || !propsData.bookmakers) return [];
  const playerProps = {};

  for (const bk of propsData.bookmakers) {
    for (const mkt of (bk.markets || [])) {
      for (const outcome of (mkt.outcomes || [])) {
        const player = outcome.description || '';
        const direction = outcome.name; // Over or Under
        const line = outcome.point;
        const odds = outcome.price;
        if (!player || line == null) continue;

        const key = `${player}|${mkt.key}|${line}`;
        if (!playerProps[key]) {
          playerProps[key] = {
            player,
            marketKey: mkt.key,
            statType: MARKET_NAMES[mkt.key] || mkt.key,
            line,
            over: [],
            under: [],
          };
        }
        const entry = { odds, book: bk.title || bk.key };
        if (direction === 'Over') playerProps[key].over.push(entry);
        else playerProps[key].under.push(entry);
      }
    }
  }

  // Find best odds for each prop
  const result = [];
  for (const [, data] of Object.entries(playerProps)) {
    if (data.over.length === 0 && data.under.length === 0) continue;
    const bestOver = data.over.sort((a, b) => b.odds - a.odds)[0] || null;
    const bestUnder = data.under.sort((a, b) => b.odds - a.odds)[0] || null;
    result.push({
      player: data.player,
      marketKey: data.marketKey,
      statType: data.statType,
      line: data.line,
      bestOver,
      bestUnder,
      totalBooks: data.over.length + data.under.length,
    });
  }
  return result;
}

// ── Blob storage (dual-write: SDK + REST API) ──
async function storeBlob(key, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("edge-picks-props");
    await store.set(key, body);
    console.log(`[props] Stored ${key} via SDK`);
  } catch (e) {
    console.log(`[props] SDK write failed for ${key}: ${e.message}`);
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || SITE_ID;
  if (!token) return;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-props/${key}`, {
      method: "PUT", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
    console.log(`[props] Stored ${key} via API: ${resp.status}`);
  } catch (e) { console.error(`[props] API write failed: ${e.message}`); }
}

async function appendPicksDate(dateISO) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || SITE_ID;
  if (!token) return;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-props/picks-dates`;
  const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    let dates = [];
    const resp = await fetch(url, { headers });
    if (resp.ok) { try { dates = await resp.json(); } catch (e) {} }
    if (!Array.isArray(dates)) dates = [];
    if (!dates.includes(dateISO)) {
      dates.push(dateISO);
      dates.sort();
      await fetch(url, { method: "PUT", headers, body: JSON.stringify(dates) });
      console.log(`[props] Updated picks-dates: ${dates.join(', ')}`);
    }
  } catch (e) { console.error(`[props] picks-dates update failed: ${e.message}`); }
}

// ── Main handler ──
exports.handler = async (event) => {
  console.log("[props] v2.0 — TJ Bombard All-Sport Props Engine started");

  try {
    const body = JSON.parse(event.body || "{}");
    const now = new Date();
    const estFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const [m, d, y] = estFormatter.format(now).split('/');
    const dateISO = body.date || `${y}-${m}-${d}`;
    const dateFormatted = new Date(dateISO + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const apiKey = process.env.ODDS_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.error("[props] No ODDS_API_KEY");
      return { statusCode: 500, body: JSON.stringify({ error: true, message: "No ODDS_API_KEY" }) };
    }

    console.log(`[props] Generating for ${dateISO}`);

    // ── Step 1: Fetch events + game odds for all sports in parallel ──
    const eventFetches = PROP_SPORTS.map(s => fetchEvents(s.key, apiKey, dateISO));
    const oddsFetches = PROP_SPORTS.map(s => fetchGameOdds(s.key, apiKey));
    const [eventResults, oddsResults] = await Promise.all([
      Promise.all(eventFetches),
      Promise.all(oddsFetches),
    ]);

    const sportData = {};
    for (let i = 0; i < PROP_SPORTS.length; i++) {
      const sport = PROP_SPORTS[i];
      sportData[sport.key] = {
        label: sport.label,
        events: eventResults[i] || [],
        gameOdds: oddsResults[i] || [],
      };
      console.log(`[props] ${sport.label}: ${sportData[sport.key].events.length} events`);
    }

    const totalEvents = Object.values(sportData).reduce((s, d) => s + d.events.length, 0);
    if (totalEvents === 0) {
      const noPlay = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], rejections: [], edgeSummary: "No games scheduled today across NBA, MLB, NHL.", summary: { totalPicks: 0, totalUnits: "0u", sportsCovered: [] } };
      await storeBlob(`picks-${dateISO}`, noPlay);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0 }) };
    }

    // ── Step 2: Fetch player props for each event (batched, max 8 events per sport) ──
    let dataContext = `TODAY'S DATE: ${dateISO} (${dateFormatted})\n\n`;
    const sportCounts = {};

    for (const sport of PROP_SPORTS) {
      const sd = sportData[sport.key];
      if (sd.events.length === 0) continue;

      const eventsToFetch = sd.events.slice(0, 6);
      const allEventProps = [];

      // Batch fetch props in groups of 4
      for (let i = 0; i < eventsToFetch.length; i += 4) {
        const batch = eventsToFetch.slice(i, i + 4);
        const results = await Promise.all(
          batch.map(ev => fetchEventProps(ev.id, sport.key, PROP_MARKETS[sport.key] || [], apiKey))
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j]) {
            const props = extractProps(results[j]);
            if (props.length > 0) {
              allEventProps.push({
                eventId: batch[j].id,
                homeTeam: batch[j].home_team,
                awayTeam: batch[j].away_team,
                commenceTime: batch[j].commence_time,
                props,
              });
            }
          }
        }
      }

      const totalProps = allEventProps.reduce((s, e) => s + e.props.length, 0);
      sportCounts[sport.label] = { events: sd.events.length, propsFound: totalProps };
      console.log(`[props] ${sport.label}: ${allEventProps.length} events with props, ${totalProps} total prop lines`);

      if (allEventProps.length === 0) continue;

      // ── Build context for this sport ──
      dataContext += `=== ${sport.label} PLAYER PROPS ===\n`;

      for (const ev of allEventProps) {
        dataContext += `\n--- ${ev.awayTeam} @ ${ev.homeTeam} (${ev.commenceTime}) ---\n`;

        // Game-level context (totals, moneylines)
        const gameMatch = sd.gameOdds.find(g =>
          g.home_team === ev.homeTeam && g.away_team === ev.awayTeam
        );
        if (gameMatch) {
          for (const bk of (gameMatch.bookmakers || []).slice(0, 2)) {
            for (const mkt of (bk.markets || [])) {
              if (mkt.key === 'totals') {
                const over = mkt.outcomes?.find(o => o.name === 'Over');
                if (over) dataContext += `  Game Total: ${over.point} (${bk.title})\n`;
              }
              if (mkt.key === 'h2h') {
                const home = mkt.outcomes?.find(o => o.name === ev.homeTeam);
                const away = mkt.outcomes?.find(o => o.name === ev.awayTeam);
                if (home && away) {
                  dataContext += `  Moneyline: ${ev.awayTeam} ${away.price > 0 ? '+' : ''}${away.price} / ${ev.homeTeam} ${home.price > 0 ? '+' : ''}${home.price}\n`;
                }
              }
            }
          }
        }

        // Player prop lines — send top 8 per game (prioritize props with most book coverage)
        const sortedProps = ev.props
          .sort((a, b) => b.totalBooks - a.totalBooks)
          .slice(0, 8);
        for (const prop of sortedProps) {
          dataContext += `\n  PLAYER: ${prop.player} | ${prop.statType} | Line: ${prop.line}\n`;
          if (prop.bestOver) dataContext += `    Best Over: ${prop.bestOver.odds > 0 ? '+' : ''}${prop.bestOver.odds} (${prop.bestOver.book})\n`;
          if (prop.bestUnder) dataContext += `    Best Under: ${prop.bestUnder.odds > 0 ? '+' : ''}${prop.bestUnder.odds} (${prop.bestUnder.book})\n`;
          dataContext += `    Books: ${prop.totalBooks}\n`;
        }
        if (ev.props.length > 8) {
          dataContext += `  ... and ${ev.props.length - 8} more props for this game (lower book coverage)\n`;
        }
      }

      dataContext += `\n`;
    }

    dataContext += `=== END OF DATA ===\n\nAnalyze ALL player props above across all sports. Run the 10-step checklist for the most promising candidates. Return your picks (max 5 total across all sports) and notable passes as JSON. Use web search to verify recent form, injury status, and matchup data.`;

    // ── Step 3: Call Claude ──
    if (!anthropicKey) {
      console.error("[props] No ANTHROPIC_API_KEY");
      const fallback = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], rejections: [], edgeSummary: "Claude API unavailable.", _debug: { sportCounts } };
      await storeBlob(`picks-${dateISO}`, fallback);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0, reason: "No API key" }) };
    }

    console.log(`[props] Sending data to Claude for analysis (${dataContext.length} chars)`);
    let claudeResult = null;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          temperature: 0.3,
          system: SYSTEM_PROMPT,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 15 }],
          messages: [{ role: "user", content: dataContext }],
        }),
      });

      if (resp.ok) {
        const claudeData = await resp.json();
        const textBlocks = (claudeData.content || []).filter(b => b.type === 'text');
        const fullText = textBlocks.map(b => b.text).join('\n');
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          claudeResult = JSON.parse(jsonMatch[0]);
          console.log(`[props] Claude returned ${claudeResult.picks?.length || 0} picks`);
        } else {
          console.error("[props] No JSON in Claude response");
        }
      } else {
        const errBody = await resp.text();
        console.error(`[props] Claude error: ${resp.status} — ${errBody.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[props] Claude call failed: ${e.message}`);
    }

    // ── Step 4: Build final result ──
    const picks = (claudeResult?.picks || []).map(p => {
      // Find commenceTime from event data if not provided
      let commenceTime = p.commenceTime || null;
      if (!commenceTime) {
        for (const sport of PROP_SPORTS) {
          const sd = sportData[sport.key];
          for (const ev of (sd?.events || [])) {
            const matchup = (p.matchup || '').toLowerCase();
            const home = (ev.home_team || '').toLowerCase();
            const away = (ev.away_team || '').toLowerCase();
            if (matchup.includes(home.split(' ').pop()) && matchup.includes(away.split(' ').pop())) {
              commenceTime = ev.commence_time;
              break;
            }
          }
          if (commenceTime) break;
        }
      }

      return {
        sport: p.sport || '',
        sportLabel: p.sportLabel || '',
        matchup: p.matchup || '',
        playerName: p.playerName || '',
        statType: p.statType || '',
        marketKey: p.marketKey || '',
        pick: p.pick || `${p.direction} ${p.line} ${p.statType}`,
        line: p.line,
        direction: p.direction || 'Over',
        odds: p.odds || '-110',
        book: p.book || '',
        tier: p.tier || 'C',
        confidence: p.confidence || 'aminus',
        rating: p.rating || 'A-',
        units: p.units || '0.5u',
        last5: p.last5 || '',
        seasonAvg: p.seasonAvg || '',
        opponentRank: p.opponentRank || '',
        projectionEdge: p.projectionEdge || '',
        sharpSignals: p.sharpSignals || 0,
        edgePct: p.edgePct || p.projectionEdge || '',
        ev: p.ev || '',
        modelProb: p.modelProb || '',
        marketProb: p.marketProb || '',
        coreReasoning: p.coreReasoning || '',
        riskFactor: p.riskFactor || '',
        commenceTime,
      };
    });

    const rejections = (claudeResult?.rejections || []).map(r => ({
      sportLabel: r.sportLabel || '',
      matchup: r.matchup || '',
      playerName: r.playerName || '',
      statType: r.statType || '',
      pick: r.pick || '',
      reason: r.reason || '',
    }));

    const edgeSummary = claudeResult?.edgeSummary || (picks.length > 0
      ? `WeBetAI found ${picks.length} player prop edge${picks.length > 1 ? 's' : ''} across ${[...new Set(picks.map(p => p.sportLabel))].join(', ')}.`
      : `WeBetAI analyzed props across all sports but no edges met the threshold today.`);

    const finalResult = {
      date: dateISO,
      dateFormatted,
      generatedAt: now.toISOString(),
      picks,
      rejections,
      edgeSummary,
      _debug: { sportCounts, totalEvents },
      summary: {
        totalPicks: picks.length,
        totalUnits: picks.reduce((s, p) => s + (parseFloat(p.units) || 0), 0).toFixed(1) + 'u',
        sportsCovered: [...new Set(picks.map(p => p.sportLabel))],
      },
    };

    console.log(`[props] Final: ${picks.length} picks, ${rejections.length} rejections`);

    // ── Overwrite guard ──
    if (picks.length === 0) {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (token) {
        try {
          const existingResp = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-props/picks-${dateISO}`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (existingResp.ok) {
            const existing = await existingResp.json();
            if (existing.picks && existing.picks.length > 0) {
              console.log(`[props] Preserving existing ${existing.picks.length} picks`);
              return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true, reason: 'Existing picks preserved' }) };
            }
          }
        } catch (e) { /* proceed */ }
      }
    }

    await storeBlob(`picks-${dateISO}`, finalResult);
    await storeBlob("latest-date", dateISO);
    await appendPicksDate(dateISO);

    return { statusCode: 200, body: JSON.stringify({ success: true, picks: picks.length, rejections: rejections.length, date: dateISO }) };

  } catch (outerErr) {
    console.error("[props] FATAL:", outerErr.message, outerErr.stack);
    return { statusCode: 500, body: JSON.stringify({ error: true, message: outerErr.message }) };
  }
};
