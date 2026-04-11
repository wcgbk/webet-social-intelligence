// generate-picks-mlb-props-background.js
// MLB Strikeout Props Engine — TJ Bombard 10-Step Checklist
// Fetches pitcher K prop lines from The Odds API, ESPN pitcher data,
// runs Claude analysis with the full TJ Bombard system prompt.
// Background function (15min timeout). Stores to "edge-picks-mlb-props" blob store.

const SITE_ID = process.env.SITE_ID || "87d7bcd9-e95a-479c-bc44-6432a2ffc606";
const MLB_SPORT = "baseball_mlb";

// ── Hard Rock Bet only (same as MLB F5 pipeline) ──
const HARD_ROCK_KEYS = new Set(['hardrockbet', 'hardrockbet_oh']);

// ── Strikeout-specific park factors (higher = more Ks) ──
const K_PARK_FACTORS = {
  "Coors Field": { kf: 90, notes: "Altitude suppresses K rate — hitters see ball better at elevation" },
  "Chase Field": { kf: 98, notes: "Dome — neutral for Ks" },
  "Globe Life Field": { kf: 99, notes: "Retractable roof, neutral" },
  "Minute Maid Park": { kf: 100, notes: "Neutral" },
  "loanDepot park": { kf: 103, notes: "Pitcher-friendly, slightly elevated K rate" },
  "Tropicana Field": { kf: 102, notes: "Dome, slightly K-friendly" },
  "Oracle Park": { kf: 104, notes: "Pitcher-friendly, spacious — elevated Ks" },
  "Petco Park": { kf: 105, notes: "Pitcher-friendly, marine layer suppresses contact" },
  "T-Mobile Park": { kf: 103, notes: "Pitcher-friendly" },
  "Comerica Park": { kf: 102, notes: "Deep center, pitcher-friendly" },
  "PNC Park": { kf: 101, notes: "Pitcher-friendly" },
  "Citi Field": { kf: 103, notes: "Pitcher-friendly" },
  "Dodger Stadium": { kf: 101, notes: "Slight K-lean at night" },
  "Yankee Stadium": { kf: 98, notes: "Hitter-friendly, slightly suppresses K rate" },
  "Fenway Park": { kf: 97, notes: "Contact-friendly, lower K rate" },
  "Wrigley Field": { kf: 99, notes: "Wind-dependent" },
  "Kauffman Stadium": { kf: 100, notes: "Neutral" },
  "Target Field": { kf: 100, notes: "Neutral" },
};

// ── TJ Bombard System Prompt ──
const SYSTEM_PROMPT = `You are the world's most elite MLB strikeout prop analyst — a fusion of Tokyo Brandon (WagerTalk's #1 profit capper), Action Network's Sharp Money Desk, RotoGrinders/Notorious, BettingPros Model, and Dimers Signal Engine.

CORE PHILOSOPHY:
1. Beat the number, not the game. Win probability is irrelevant — attack the specific K line.
2. Process over outcome. A bad beat on a +EV pick is still a win.
3. Line is everything. No line = no pick.
4. Closing Line Value (CLV) is the scorecard.
5. Sharp money reveals truth. Follow sharp action, not the crowd.

TIER SYSTEM:
- TIER A (2-3 units): Last 5 starts 4-5 Over, opponent K% top-10 vs handedness, RLM or 5%+ projection edge, line NOT moved 2+ from open
- TIER B (1-2 units): Last 5 starts 3-5 Over, opponent K% above average, 1+ sharp signal, line within 1K of open
- TIER C (0.5-1 unit): Matchup angle only, marginal 2-3% projection edge
- PASS: Last 5 shows 2 or fewer Over, opponent is top-10 contact team, no signals, or line already moved 2+

You must run the 10-STEP CHECKLIST for every pitcher:
1. Injury & availability check
2. Opening line vs current line
3. Reverse Line Movement (RLM) check
4. Last 5 starts ATS (HEAVIEST weighting)
5. Opponent strikeout vulnerability (K% vs LHP/RHP)
6. Pitch mix & arsenal analysis
7. Park & environmental factors
8. Game script probability (blowout risk, total line)
9. Sharp signal confirmation (need 2+ of: RLM, last 5 ATS, opponent K% top-10, projection 3%+ edge, situational edge, pitch mix trending up)
10. Commit or Pass

OUTPUT FORMAT — You MUST respond with valid JSON only, no other text:
{
  "analysis_date": "YYYY-MM-DD",
  "picks": [
    {
      "pitcher": "Full Name",
      "team": "TEAM_ABBR",
      "opponent": "OPP_ABBR",
      "matchup": "Team A @ Team B",
      "line": "O 6.5" or "U 5.5",
      "odds": "-120",
      "book": "Best book name",
      "tier": "A" or "B" or "C",
      "units": "2.0u",
      "confidence": "a" or "b" or "c",
      "rating": "A" or "B" or "C",
      "last5ATS": "4-1 Over",
      "opponentKPct": "25.3% (rank #X vs RHP/LHP)",
      "rlm": "Yes — detail" or "No",
      "projectionEdge": "+5.2%",
      "sharpSignals": 3,
      "coreReasoning": "2-3 sentence analysis covering the top reasons",
      "riskFactor": "1 sentence on the main risk",
      "pitcherERA": 3.45,
      "pitcherK9": 10.2,
      "venue": "Stadium Name",
      "parkKFactor": 103,
      "gameTotal": 8.5,
      "commenceTime": "ISO timestamp"
    }
  ],
  "passes": [
    {
      "pitcher": "Full Name",
      "team": "TEAM_ABBR",
      "opponent": "OPP_ABBR",
      "reason": "1-2 sentence reason for pass"
    }
  ],
  "summary": "1-2 sentence overall slate summary"
}

EARLY SEASON / INSUFFICIENT DATA RULE:
- When current 2026 season data is insufficient (fewer than 5 starts, recent callups, early April), use career stats, 2025 season stats, spring training data, and minor league K rates as proxies.
- Weight career data heavily for pitchers with fewer than 5 starts this season.
- Do NOT skip a pitcher just because they lack 2026 data — use the best available historical sample.

RULES:
- Maximum 5 picks per day. Quality over quantity.
- Never force a pick. PASS is a valid and expected outcome.
- Only output pitchers who have strikeout prop lines in the data provided.
- Sort picks by tier (A first, then B, then C).
- Unit sizing: A = 2.0u, B = 1.0u, C = 0.5u (adjust within tier range based on conviction).`;

// ── Fetch MLB events for today ──
async function fetchMLBEvents(apiKey, dateISO) {
  try {
    const startDate = `${dateISO}T00:00:00Z`;
    const endDate = `${dateISO}T23:59:59Z`;
    const url = `https://api.the-odds-api.com/v4/sports/${MLB_SPORT}/events?apiKey=${apiKey}&dateFormat=iso&commencesFrom=${startDate}&commencesTo=${endDate}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[mlb-props] Events API ${resp.status}`);
      return [];
    }
    return await resp.json();
  } catch (e) {
    console.error(`[mlb-props] Events fetch failed: ${e.message}`);
    return [];
  }
}

// ── Fetch strikeout props for a single event ──
async function fetchStrikeoutProps(eventId, apiKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${MLB_SPORT}/events/${eventId}/odds?apiKey=${apiKey}&regions=us,us2&markets=pitcher_strikeouts&oddsFormat=american`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[mlb-props] Props API ${resp.status} for event ${eventId}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`[mlb-props] Props fetch failed for ${eventId}: ${e.message}`);
    return null;
  }
}

// ── Fetch game-level odds (ML + totals) for game script context ──
async function fetchGameOdds(apiKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${MLB_SPORT}/odds?apiKey=${apiKey}&regions=us,us2&markets=h2h,totals&oddsFormat=american`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    return await resp.json();
  } catch (e) { return []; }
}

// ── Fetch ESPN scoreboard for starters ──
async function fetchESPNData(dateISO) {
  try {
    const dateParam = dateISO.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateParam}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return null;
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      if (!away || !home) return null;

      // Extract probable pitchers
      let awaySP = null, homeSP = null;
      for (const p of (comp.probables || [])) {
        const abbr = p.team?.abbreviation;
        if (abbr === away.team?.abbreviation) awaySP = p.athlete;
        if (abbr === home.team?.abbreviation) homeSP = p.athlete;
      }

      return {
        awayTeam: away.team?.displayName || '',
        awayAbbr: away.team?.abbreviation || '',
        homeTeam: home.team?.displayName || '',
        homeAbbr: home.team?.abbreviation || '',
        venue: comp.venue?.fullName || '',
        awaySP: awaySP ? { name: awaySP.displayName, id: awaySP.id } : null,
        homeSP: homeSP ? { name: homeSP.displayName, id: homeSP.id } : null,
        state: comp.status?.type?.state || 'pre',
      };
    }).filter(Boolean);
  } catch (e) {
    console.error(`[mlb-props] ESPN fetch failed: ${e.message}`);
    return [];
  }
}

// ── Extract best K props from bookmakers ──
function extractKProps(propsData) {
  if (!propsData || !propsData.bookmakers) return [];
  const pitcherLines = {};

  for (const bk of propsData.bookmakers) {
    // Hard Rock Bet only — ignore all other books
    if (!HARD_ROCK_KEYS.has(bk.key)) continue;
    for (const mkt of (bk.markets || [])) {
      if (mkt.key !== 'pitcher_strikeouts') continue;
      for (const outcome of (mkt.outcomes || [])) {
        const pitcher = outcome.description || outcome.name;
        const side = outcome.name; // "Over" or "Under"
        const line = outcome.point;
        const odds = outcome.price;
        if (!pitcher || line == null) continue;

        if (!pitcherLines[pitcher]) {
          pitcherLines[pitcher] = { pitcher, lines: {} };
        }
        const key = `${line}`;
        if (!pitcherLines[pitcher].lines[key]) {
          pitcherLines[pitcher].lines[key] = { point: line, books: [] };
        }
        pitcherLines[pitcher].lines[key].books.push({
          book: bk.title || bk.key,
          bookKey: bk.key,
          side,
          odds,
          point: line,
        });
      }
    }
  }

  // For each pitcher, find the consensus line and best odds
  const result = [];
  for (const [name, data] of Object.entries(pitcherLines)) {
    const lineKeys = Object.keys(data.lines).sort((a, b) => {
      // Pick the most common line
      return data.lines[b].books.length - data.lines[a].books.length;
    });
    if (lineKeys.length === 0) continue;

    const mainLine = data.lines[lineKeys[0]];
    const overBooks = mainLine.books.filter(b => b.side === 'Over');
    const underBooks = mainLine.books.filter(b => b.side === 'Under');

    // Best over odds (highest positive or least negative)
    const bestOver = overBooks.sort((a, b) => b.odds - a.odds)[0];
    const bestUnder = underBooks.sort((a, b) => b.odds - a.odds)[0];

    result.push({
      pitcher: name,
      line: mainLine.point,
      bestOver: bestOver ? { odds: bestOver.odds, book: bestOver.book } : null,
      bestUnder: bestUnder ? { odds: bestUnder.odds, book: bestUnder.book } : null,
      totalBooks: mainLine.books.length,
      allLines: Object.values(data.lines).map(l => ({
        point: l.point,
        bookCount: l.books.length,
      })),
    });
  }
  return result;
}

// ── Blob storage (dual-write: SDK + REST API) ──
async function storeBlob(key, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("edge-picks-mlb-props");
    await store.set(key, body);
    console.log(`[mlb-props] Stored ${key} via SDK`);
  } catch (e) {
    console.log(`[mlb-props] SDK write failed for ${key}: ${e.message}`);
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || SITE_ID;
  if (!token) return;
  try {
    const resp = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb-props/${key}`, {
      method: "PUT", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
    console.log(`[mlb-props] Stored ${key} via API: ${resp.status}`);
  } catch (e) { console.error(`[mlb-props] API write failed: ${e.message}`); }
}

async function appendPicksDate(dateISO) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || SITE_ID;
  if (!token) return;
  const url = `https://api.netlify.com/api/v1/blobs/${siteId}/edge-picks-mlb-props/picks-dates`;
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
      console.log(`[mlb-props] Updated picks-dates: ${dates.join(', ')}`);
    }
  } catch (e) { console.error(`[mlb-props] picks-dates update failed: ${e.message}`); }
}

// ── Main handler ──
exports.handler = async (event) => {
  console.log("[mlb-props] Starting MLB Strikeout Props engine");

  try {
    const now = new Date();
    const estOffset = -4 * 60;
    const est = new Date(now.getTime() + (now.getTimezoneOffset() + estOffset) * 60000);
    const dateISO = est.toISOString().slice(0, 10);
    const dateFormatted = est.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const apiKey = process.env.ODDS_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.error("[mlb-props] No ODDS_API_KEY");
      return { statusCode: 500, body: JSON.stringify({ error: true, message: "No ODDS_API_KEY" }) };
    }

    // ── Step 1: Fetch events, ESPN data, and game odds in parallel ──
    console.log(`[mlb-props] Fetching data for ${dateISO}`);
    const [events, espnGames, gameOdds] = await Promise.all([
      fetchMLBEvents(apiKey, dateISO),
      fetchESPNData(dateISO),
      fetchGameOdds(apiKey),
    ]);

    console.log(`[mlb-props] Found ${events.length} events, ${espnGames.length} ESPN games`);

    if (events.length === 0) {
      const noPlay = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], passes: [], summary: "No MLB games scheduled today." };
      await storeBlob(`picks-${dateISO}`, noPlay);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0 }) };
    }

    // ── Step 2: Fetch strikeout props for each event ──
    console.log(`[mlb-props] Fetching K props for ${events.length} events`);
    const allKProps = [];
    // Batch in groups of 5 to avoid rate limits
    for (let i = 0; i < events.length; i += 5) {
      const batch = events.slice(i, i + 5);
      const results = await Promise.all(batch.map(ev => fetchStrikeoutProps(ev.id, apiKey)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) {
          const kProps = extractKProps(results[j]);
          if (kProps.length > 0) {
            allKProps.push({
              eventId: batch[j].id,
              homeTeam: batch[j].home_team,
              awayTeam: batch[j].away_team,
              commenceTime: batch[j].commence_time,
              kProps,
            });
          }
        }
      }
    }

    console.log(`[mlb-props] Found K props for ${allKProps.length} events`);

    if (allKProps.length === 0) {
      const noProps = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], passes: [], summary: "No pitcher strikeout props available today." };
      await storeBlob(`picks-${dateISO}`, noProps);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0, reason: "No K props" }) };
    }

    // ── Step 3: Build context for Claude ──
    let dataContext = `TODAY'S DATE: ${dateISO} (${dateFormatted})\n\n`;
    dataContext += `=== PITCHER STRIKEOUT PROP LINES ===\n`;

    for (const ev of allKProps) {
      dataContext += `\n--- ${ev.awayTeam} @ ${ev.homeTeam} (${ev.commenceTime}) ---\n`;

      // Add game-level context
      const gameMatch = gameOdds.find(g =>
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
                dataContext += `  Moneyline: ${ev.awayTeam} ${away.price > 0 ? '+' : ''}${away.price} / ${ev.homeTeam} ${home.price > 0 ? '+' : ''}${home.price} (${bk.title})\n`;
              }
            }
          }
        }
      }

      // ESPN context
      const espnMatch = espnGames.find(g => {
        const home = ev.homeTeam.toLowerCase();
        const away = ev.awayTeam.toLowerCase();
        return (g.homeTeam.toLowerCase().includes(home.split(' ').pop()) ||
                home.includes(g.homeTeam.toLowerCase().split(' ').pop())) &&
               (g.awayTeam.toLowerCase().includes(away.split(' ').pop()) ||
                away.includes(g.awayTeam.toLowerCase().split(' ').pop()));
      });
      if (espnMatch) {
        if (espnMatch.awaySP) dataContext += `  Away SP: ${espnMatch.awaySP.name}\n`;
        if (espnMatch.homeSP) dataContext += `  Home SP: ${espnMatch.homeSP.name}\n`;
        if (espnMatch.venue) {
          dataContext += `  Venue: ${espnMatch.venue}`;
          const kf = K_PARK_FACTORS[espnMatch.venue];
          if (kf) dataContext += ` (K-Factor: ${kf.kf}, ${kf.notes})`;
          dataContext += '\n';
        }
      }

      // K prop lines
      for (const kp of ev.kProps) {
        dataContext += `\n  PITCHER: ${kp.pitcher} | Line: ${kp.line} Ks\n`;
        if (kp.bestOver) dataContext += `    Best Over: ${kp.bestOver.odds > 0 ? '+' : ''}${kp.bestOver.odds} (${kp.bestOver.book})\n`;
        if (kp.bestUnder) dataContext += `    Best Under: ${kp.bestUnder.odds > 0 ? '+' : ''}${kp.bestUnder.odds} (${kp.bestUnder.book})\n`;
        if (kp.allLines.length > 1) {
          dataContext += `    Alt lines: ${kp.allLines.map(l => `${l.point} (${l.bookCount} books)`).join(', ')}\n`;
        }
        dataContext += `    Books offering: ${kp.totalBooks}\n`;
      }
    }

    dataContext += `\n=== END OF DATA ===\n\nAnalyze ALL pitchers above. Run the 10-step checklist for each. Return your picks (max 5) and passes as JSON.`;

    // ── Step 4: Call Claude ──
    if (!anthropicKey) {
      console.error("[mlb-props] No ANTHROPIC_API_KEY");
      // Store raw data as fallback
      const fallback = { date: dateISO, dateFormatted, generatedAt: now.toISOString(), picks: [], passes: [], summary: "Claude API unavailable — no analysis performed.", _rawData: allKProps.length };
      await storeBlob(`picks-${dateISO}`, fallback);
      await storeBlob("latest-date", dateISO);
      await appendPicksDate(dateISO);
      return { statusCode: 200, body: JSON.stringify({ success: true, picks: 0, reason: "No API key" }) };
    }

    console.log(`[mlb-props] Sending ${allKProps.length} events to Claude for analysis`);
    let claudePicks = null;

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
          claudePicks = JSON.parse(jsonMatch[0]);
          console.log(`[mlb-props] Claude returned ${claudePicks.picks?.length || 0} picks`);
        } else {
          console.error("[mlb-props] No JSON in Claude response");
        }
      } else {
        const errBody = await resp.text();
        console.error(`[mlb-props] Claude error: ${resp.status} — ${errBody.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[mlb-props] Claude call failed: ${e.message}`);
    }

    // ── Step 5: Build final result ──
    const picks = (claudePicks?.picks || []).map((p, i) => {
      // Map commence time from event data
      let commenceTime = p.commenceTime || null;
      if (!commenceTime) {
        for (const ev of allKProps) {
          const matchAway = ev.awayTeam.toLowerCase();
          const matchHome = ev.homeTeam.toLowerCase();
          const pMatchup = (p.matchup || '').toLowerCase();
          if (pMatchup.includes(matchAway.split(' ').pop()) && pMatchup.includes(matchHome.split(' ').pop())) {
            commenceTime = ev.commenceTime;
            break;
          }
        }
      }

      return {
        sport: "MLB",
        type: "Strikeout Prop",
        pitcher: p.pitcher,
        team: p.team,
        opponent: p.opponent,
        matchup: p.matchup,
        pick: `${p.pitcher} ${p.line}`,
        line: p.line,
        odds: p.odds,
        book: p.book,
        tier: p.tier,
        units: p.units,
        confidence: p.confidence || p.tier?.toLowerCase(),
        rating: p.rating || p.tier,
        last5ATS: p.last5ATS,
        opponentKPct: p.opponentKPct,
        rlm: p.rlm,
        projectionEdge: p.projectionEdge,
        sharpSignals: p.sharpSignals,
        coreReasoning: p.coreReasoning,
        riskFactor: p.riskFactor,
        pitcherERA: p.pitcherERA,
        pitcherK9: p.pitcherK9,
        venue: p.venue,
        parkKFactor: p.parkKFactor,
        gameTotal: p.gameTotal,
        commenceTime,
      };
    });

    const passes = claudePicks?.passes || [];

    const finalResult = {
      date: dateISO,
      dateFormatted,
      generatedAt: now.toISOString(),
      picks,
      passes,
      summary: claudePicks?.summary || `${picks.length} strikeout prop picks for ${dateFormatted}.`,
      _debug: {
        eventsFound: events.length,
        eventsWithKProps: allKProps.length,
        totalPitchersAnalyzed: allKProps.reduce((s, e) => s + e.kProps.length, 0),
      },
    };

    // ── Step 6: Overwrite guard ──
    if (picks.length === 0) {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (token) {
        try {
          const existingResp = await fetch(
            `https://api.netlify.com/api/v1/blobs/${SITE_ID}/edge-picks-mlb-props/picks-${dateISO}`,
            { headers: { "Authorization": `Bearer ${token}` } }
          );
          if (existingResp.ok) {
            const existing = await existingResp.json();
            if (existing.picks && existing.picks.length > 0) {
              console.log(`[mlb-props] Preserving existing ${existing.picks.length} picks`);
              return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true, reason: 'Existing picks preserved' }) };
            }
          }
        } catch (e) { /* proceed with save */ }
      }
    }

    await storeBlob(`picks-${dateISO}`, finalResult);
    await storeBlob("latest-date", dateISO);
    await appendPicksDate(dateISO);

    return { statusCode: 200, body: JSON.stringify({ success: true, picks: picks.length, passes: passes.length, date: dateISO }) };

  } catch (outerErr) {
    console.error("[mlb-props] FATAL:", outerErr.message, outerErr.stack);
    return { statusCode: 500, body: JSON.stringify({ error: true, message: outerErr.message }) };
  }
};
