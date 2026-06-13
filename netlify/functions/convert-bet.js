// convert-bet.js — Netlify Function (v3 — two-pass scoring + claim-aware matching)
// Pipeline:
//   1. Extract tweet content (fxtwitter fallback if needed)
//   2. Use pre-extracted topic/claim/entities from search-x when available
//   3. Detect category + extract entities (fallback if search-x didn't provide them)
//   4. Fetch markets: targeted Polymarket search + broad pool + sportsbook for sports
//   5. PASS 1: Grok relevance-only scoring (no odds/volume influence)
//   6. Quality gate — reject matches below 0.5 relevance
//   7. PASS 2: Bettability scoring on relevance-passed markets only
//   8. Diversity enforcement — no duplicate events across cards
//   9. Validation — confirm topic alignment
//  10. Return top 3 markets + AI bet

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const url = body.url || '';
    const passedText = body.text || '';
    const passedAuthor = body.author || '';
    const passedHandle = body.handle || '';
    // Pre-extracted context from search-x trending-first approach
    const passedTopic = body.topic || '';
    const passedClaim = body.claim || '';
    const passedSentiment = body.sentiment || '';
    const passedEntities = body.entities || [];
    // Diversity tracking
    const usedMarketIds = new Set(body.usedMarketIds || []);
    const usedEventIds = new Set(body.usedEventIds || []);

    if (!url && !passedText) throw new Error('No URL or text provided');

    // ── Step 1: Extract tweet content ─────────────────────────────────────
    let tweetText = passedText;
    let tweetAuthor = passedAuthor;
    let tweetHandle = passedHandle;

    if (!tweetText && url) {
      const tweetIdMatch = url.match(/\/status\/(\d+)/);
      if (!tweetIdMatch) throw new Error('Could not find tweet ID in URL');
      const tweetId = tweetIdMatch[1];

      try {
        const res = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {
          headers: { 'User-Agent': 'WeBetAI/1.0' },
        });
        const data = await res.json();
        tweetText = data?.tweet?.text || '';
        tweetAuthor = tweetAuthor || data?.tweet?.author?.name || '';
        tweetHandle = tweetHandle || data?.tweet?.author?.screen_name || '';
      } catch (_) {
        try {
          const res2 = await fetch(`https://api.vxtwitter.com/i/status/${tweetId}`);
          const data2 = await res2.json();
          tweetText = data2?.text || '';
          tweetAuthor = tweetAuthor || data2?.user_name || '';
          tweetHandle = tweetHandle || data2?.user_screen_name || '';
        } catch (_) {}
      }
    }

    if (!tweetText) tweetText = url || 'trending topic';

    // ── Step 2: Build context (use search-x data when available) ─────────
    const topic = passedTopic || '';
    const claim = passedClaim || '';
    const sentiment = passedSentiment || 'neutral';
    const category = detectCategory(topic || tweetText);
    const isSports = ['NBA', 'NFL', 'NHL', 'MLB', 'Soccer', 'Tennis', 'Golf', 'MMA', 'Boxing', 'NCAA', 'F1'].includes(category);

    // Merge pre-extracted entities with local extraction
    const localEntities = extractEntities(tweetText);
    const mergedEntities = mergeEntities(passedEntities, localEntities);

    // Build search keywords from topic + entities for targeted Polymarket query
    const searchKeywords = buildSearchKeywords(topic, claim, mergedEntities);

    // ── Step 3: Fetch markets (targeted + broad + sportsbook) ────────────
    const [targetedMarkets, broadMarkets, sportsOdds] = await Promise.all([
      searchKeywords.length > 0 ? fetchTargetedPolymarkets(searchKeywords, usedMarketIds) : Promise.resolve([]),
      fetchBroadPolymarkets(usedMarketIds, usedEventIds),
      isSports ? fetchSportsOdds(category, mergedEntities) : Promise.resolve([]),
    ]);

    // Combine: targeted first (higher chance of relevance), then broad, then sports
    const seenIds = new Set();
    const allMarkets = [];
    for (const pool of [sportsOdds, targetedMarkets, broadMarkets]) {
      for (const m of pool) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          allMarkets.push(m);
        }
      }
    }

    // ── Step 4: PASS 1 — Grok relevance-only scoring ────────────────────
    const xaiKey = process.env.XAI_API_KEY;
    let candidates = [];
    let aiBet = null;

    if (xaiKey && allMarkets.length > 0) {
      const grokResult = await grokRelevancePass(tweetText, tweetHandle, topic, claim, sentiment, mergedEntities, allMarkets, xaiKey, category);
      candidates = grokResult.matches;
      aiBet = grokResult.aiBet;
    }

    // Fallback: entity-weighted keyword scoring if Grok fails
    if (candidates.length === 0 && allMarkets.length > 0) {
      candidates = keywordFallback(tweetText, allMarkets, mergedEntities, topic);
    }

    // ── Step 5: Quality gate — PASS 1 filter ────────────────────────────
    const RELEVANCE_FLOOR = 0.4; // higher threshold now that we have better data
    const relevant = candidates.filter(m => (m._relevance || 0) >= RELEVANCE_FLOOR);

    // If nothing passes, take best available but flag
    const gated = relevant.length >= 1
      ? relevant
      : candidates.slice(0, 3).map(m => ({ ...m, _lowConfidence: true }));

    // ── Step 6: PASS 2 — Bettability scoring (only on relevant markets) ─
    const scored = gated.map(m => {
      m._bettability = computeBettability(m);
      return m;
    });
    scored.sort((a, b) => b._bettability - a._bettability);

    // ── Step 7: Diversity enforcement ────────────────────────────────────
    const diverse = [];
    const seenEvents = new Set(usedEventIds);
    const seenQuestions = new Set();
    for (const m of scored) {
      const eventKey = m._eventId || m._sportsKey || m.id;
      const questionNorm = (m.question || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (seenEvents.has(eventKey) || seenQuestions.has(questionNorm)) continue;
      seenEvents.add(eventKey);
      seenQuestions.add(questionNorm);
      diverse.push(m);
      if (diverse.length >= 3) break;
    }

    // ── Step 8: Validation — confirm topic alignment ─────────────────────
    const validated = diverse.map(m => {
      const valid = validateMatch(tweetText, m, mergedEntities, category, topic);
      m._validated = valid;
      if (!valid) {
        m._relevance = Math.min(m._relevance || 0, 0.15);
        m._bettability = computeBettability(m); // recalc with penalized relevance
      }
      return m;
    });
    validated.sort((a, b) => b._bettability - a._bettability);

    // ── Step 9: Format response ──────────────────────────────────────────
    const topMarkets = validated.slice(0, 3).map((m) => {
      let outcomes = [];
      let prices = [];
      try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
      try { prices = JSON.parse(m.outcomePrices || '[]'); } catch (_) {}

      const yesPrice = prices[0] ? Math.round(parseFloat(prices[0]) * 100) : (m._yesPrice || null);
      const noPrice = prices[1] ? Math.round(parseFloat(prices[1]) * 100) : (m._noPrice || null);

      const betClaim = toBetClaim(m.question);
      const side = m._side || 'YES';
      const sideOdds = side === 'YES' ? yesPrice : noPrice;
      const specificOutcome = m._specificOutcome || `${side} — ${betClaim}`;

      const settleDateShort = m.endDate
        ? new Date(m.endDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
        : null;
      const settleDate = m.endDate
        ? new Date(m.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Market resolution';

      return {
        id: m.id,
        question: m.question,
        betClaim,
        specificOutcome,
        description: (m.description || '').slice(0, 200),
        volume: m.volume,
        numTrades: m.numTrades,
        liquidity: m.liquidity,
        endDate: m.endDate,
        settleDate,
        settleDateShort,
        polyUrl: m._source === 'sportsbook'
          ? null
          : `https://polymarket.com/event/${m.slug || m.conditionId || m.id}`,
        outcomes,
        prices,
        yesPrice,
        noPrice,
        side,
        sideOdds,
        sideReason: m._sideReason || null,
        sport: m._detectedCategory || detectCategory(m.question + ' ' + (m.description || '')),
        grokReason: m._grokReason || null,
        relevanceScore: Math.round((m._relevance || 0) * 100),
        bettabilityScore: Math.round(m._bettability * 100),
        source: m._source || 'polymarket',
        validated: m._validated !== false,
        lowConfidence: m._lowConfidence || false,
        eventId: m._eventId || null,
      };
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        tweetText,
        tweetAuthor,
        tweetHandle,
        topic,
        claim,
        category,
        entities: mergedEntities.slice(0, 10).map(e => e.text || e),
        markets: topMarkets,
        aiBet: aiBet || null,
        usedMarketIds: topMarkets.map(m => m.id),
        usedEventIds: topMarkets.map(m => m.eventId).filter(Boolean),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Category Detection ────────────────────────────────────────────────────────
function detectCategory(text) {
  const t = text.toLowerCase();
  if (/\b(ufc|mma|bellator|fight night|octagon|dana white)\b/.test(t)) return 'MMA';
  if (/\b(boxing|heavyweight|undercard|knockout|canelo|tyson|fury)\b/.test(t)) return 'Boxing';
  if (/\b(march madness|ncaa|college (basketball|football)|final four|cfp)\b/.test(t)) return 'NCAA';
  if (/\b(nba|basketball|laker|celtic|warrior|knick|bull|heat|buck|nugget|jokic|lebron|curry|doncic|tatum|embiid|giannis|sga|playoff)\b/.test(t)) return 'NBA';
  if (/\b(nfl|super bowl|quarterback|touchdown|mahomes|burrow|allen|lamar|eagle|cowboy|chief|49er|raven|bill|jet|draft)\b/.test(t)) return 'NFL';
  if (/\b(nhl|hockey|stanley cup|oiler|ranger|bruin|maple leaf|mcdavid)\b/.test(t)) return 'NHL';
  if (/\b(mlb|baseball|world series|yankee|dodger|home run|ohtani)\b/.test(t)) return 'MLB';
  if (/\b(soccer|premier league|la liga|champions league|world cup|mls|messi|ronaldo|mbappe|haaland|arsenal|liverpool)\b/.test(t)) return 'Soccer';
  if (/\b(tennis|wimbledon|us open|french open|australian open|djokovic|alcaraz|sinner)\b/.test(t)) return 'Tennis';
  if (/\b(golf|masters|pga|ryder cup|scheffler|mcilroy)\b/.test(t)) return 'Golf';
  if (/\b(f1|formula 1|grand prix|verstappen|hamilton|leclerc|norris)\b/.test(t)) return 'F1';
  if (/\b(election|president|trump|biden|congress|senate|vote|tariff|border|immigration|supreme court|republican|democrat|executive order|governor)\b/.test(t)) return 'Politics';
  if (/\b(nato|ukraine|russia|china|iran|gaza|ceasefire|sanction|greenland|venezuela|putin|zelensky)\b/.test(t)) return 'World';
  if (/\b(bitcoin|btc|crypto|ethereum|eth|solana|defi|token|altcoin|web3)\b/.test(t)) return 'Crypto';
  if (/\b(fed|interest rate|inflation|recession|gdp|cpi|fomc|treasury)\b/.test(t)) return 'Macro';
  if (/\b(stock|s&p|nasdaq|dow|ipo|earnings|wall street)\b/.test(t)) return 'Markets';
  if (/\b(ai|artificial intelligence|openai|chatgpt|claude|gemini|apple|google|microsoft|meta|startup|tech)\b/.test(t)) return 'Tech';
  if (/\b(oscar|grammy|emmy|box office|netflix|movie|album|celebrity|taylor swift|drake|beyonce|kanye)\b/.test(t)) return 'Entertainment';
  return 'General';
}

// ── Entity Extraction ─────────────────────────────────────────────────────────
function extractEntities(text) {
  const cleanText = text.replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').trim();
  const entities = [];

  const ENTITY_DB = {
    teams: { weight: 1.0, items: ['Lakers','Celtics','Warriors','Bulls','Heat','Knicks','Nets','Bucks','Nuggets','Suns','Mavericks','Clippers','Thunder','Cavaliers','76ers','Pacers','Hawks','Chiefs','Eagles','Cowboys','Patriots','Bills','Bengals','Ravens','49ers','Rams','Seahawks','Saints','Packers','Lions','Vikings','Steelers','Jets','Dolphins','Chargers','Broncos','Yankees','Dodgers','Red Sox','Cubs','Mets','Braves','Astros','Avalanche','Rangers','Bruins','Oilers','Maple Leafs','Barcelona','Real Madrid','Manchester City','Liverpool','Arsenal','Chelsea','Bayern','PSG','Manchester United','Tottenham','Juventus'] },
    athletes: { weight: 0.95, items: ['LeBron','Curry','Durant','Jokic','Giannis','Embiid','Luka','Tatum','SGA','Mahomes','Burrow','Allen','Lamar','Hurts','Ohtani','Judge','Soto','Messi','Ronaldo','Mbappe','Haaland','Salah','Djokovic','Alcaraz','Sinner','Verstappen','Hamilton','Scheffler','McIlroy'] },
    events: { weight: 0.9, items: ['Super Bowl','NBA Finals','NBA playoff','World Series','Stanley Cup','Champions League','Premier League','World Cup','March Madness','Wimbledon','US Open','French Open','Australian Open','Masters','UFC','NFL Draft','NBA Draft'] },
    political: { weight: 0.85, items: ['Trump','Biden','Congress','Senate','Supreme Court','Fed','Federal Reserve','DeSantis','RFK','Haley','Vance','Kamala','Harris','NATO','Ukraine','Russia','China','Iran','Gaza','Greenland','Venezuela','Putin','Zelensky','Xi Jinping'] },
    financial: { weight: 0.8, items: ['Bitcoin','BTC','Ethereum','ETH','Solana','SOL','XRP','Dogecoin','S&P 500','Nasdaq','Dow Jones','interest rate','inflation','recession','tariff','tariffs','trade war'] },
    tech: { weight: 0.75, items: ['OpenAI','ChatGPT','Claude','Gemini','Apple','Google','Microsoft','Meta','Tesla','Nvidia','Amazon','Netflix','SpaceX','Elon Musk'] },
    entertainment: { weight: 0.7, items: ['Oscars','Grammy','Emmy','Golden Globe','Taylor Swift','Drake','Beyonce','Kanye','Kendrick'] },
  };

  for (const [type, { weight, items }] of Object.entries(ENTITY_DB)) {
    for (const entity of items) {
      const regex = new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(cleanText)) {
        entities.push({ text: entity, type, weight });
      }
    }
  }

  // Capitalized phrases not in DB
  const caps = cleanText.match(/(?:[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})+)/g) || [];
  for (const phrase of caps) {
    if (!entities.find(e => e.text.toLowerCase() === phrase.toLowerCase())) {
      entities.push({ text: phrase, type: 'unknown', weight: 0.5 });
    }
  }

  entities.sort((a, b) => b.weight - a.weight);
  return entities;
}

// ── Merge pre-extracted entities with local extraction ─────────────────────────
function mergeEntities(passedEntities, localEntities) {
  const merged = [...localEntities];
  const existing = new Set(merged.map(e => (e.text || '').toLowerCase()));

  for (const pe of passedEntities) {
    const text = typeof pe === 'string' ? pe : pe.text;
    if (text && !existing.has(text.toLowerCase())) {
      existing.add(text.toLowerCase());
      merged.push({ text, type: 'extracted', weight: 0.85 });
    }
  }

  merged.sort((a, b) => b.weight - a.weight);
  return merged;
}

// ── Build search keywords for targeted Polymarket query ───────────────────────
function buildSearchKeywords(topic, claim, entities) {
  const keywords = [];

  // Topic words (highest priority)
  if (topic) {
    const topicWords = topic.split(/\s+/).filter(w => w.length > 2);
    keywords.push(...topicWords);
  }

  // High-weight entity names
  for (const e of entities.slice(0, 5)) {
    const text = e.text || e;
    if (text && !keywords.find(k => k.toLowerCase() === text.toLowerCase())) {
      keywords.push(text);
    }
  }

  // Claim keywords
  if (claim) {
    const claimWords = claim.split(/\s+/).filter(w => w.length > 3 && /^[A-Z]/.test(w));
    for (const w of claimWords) {
      if (!keywords.find(k => k.toLowerCase() === w.toLowerCase())) {
        keywords.push(w);
      }
    }
  }

  return keywords.slice(0, 8);
}

// ── Fetch TARGETED Polymarket events (keyword-filtered) ───────────────────────
async function fetchTargetedPolymarkets(keywords, usedMarketIds) {
  const markets = [];
  const seen = new Set(usedMarketIds);
  const now = new Date().toISOString();

  // Search Polymarket with the top 3 keywords individually
  const searchTerms = keywords.slice(0, 3);

  try {
    const searches = searchTerms.map(async (keyword) => {
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/events?limit=15&closed=false&order=volume&ascending=false&tag=${encodeURIComponent(keyword.toLowerCase())}`,
          { signal: AbortSignal.timeout(4000) }
        ).then(r => r.json());

        if (!Array.isArray(res)) return [];
        return res;
      } catch (_) {
        // Tag search failed, try title search
        try {
          const res = await fetch(
            `https://gamma-api.polymarket.com/events?limit=15&closed=false&title=${encodeURIComponent(keyword)}`,
            { signal: AbortSignal.timeout(4000) }
          ).then(r => r.json());
          return Array.isArray(res) ? res : [];
        } catch (_) {
          return [];
        }
      }
    });

    const results = await Promise.all(searches);

    for (const events of results) {
      for (const ev of events) {
        const eventMarkets = (ev.markets || []).filter(m => {
          if (m.closed) return false;
          if (m.endDate && m.endDate < now) return false;
          if (seen.has(m.id)) return false;
          return true;
        });

        eventMarkets.sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));

        for (const m of eventMarkets.slice(0, 2)) {
          seen.add(m.id);
          m._eventTitle = ev.title || '';
          m._eventId = ev.id || '';
          m._source = 'polymarket';
          m._targeted = true;
          markets.push(m);
        }
      }
    }
  } catch (err) {
    console.error('Targeted Polymarket error:', err.message);
  }

  return markets;
}

// ── Fetch BROAD Polymarket events (top by volume, like before) ────────────────
async function fetchBroadPolymarkets(usedMarketIds, usedEventIds) {
  const allMarkets = [];
  const seen = new Set(usedMarketIds);
  const now = new Date().toISOString();

  try {
    const eventsRes = await fetch(
      'https://gamma-api.polymarket.com/events?limit=60&closed=false&order=volume&ascending=false',
      { signal: AbortSignal.timeout(5000) }
    ).then(r => r.json());

    if (!Array.isArray(eventsRes)) return [];

    for (const ev of eventsRes) {
      if (usedEventIds.has(ev.id)) continue;

      const eventMarkets = (ev.markets || []).filter(m => {
        if (m.closed) return false;
        if (m.endDate && m.endDate < now) return false;
        if (seen.has(m.id)) return false;
        return true;
      });

      eventMarkets.sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));

      for (const m of eventMarkets.slice(0, 3)) {
        seen.add(m.id);
        m._eventTitle = ev.title || '';
        m._eventId = ev.id || '';
        m._source = 'polymarket';
        m._targeted = false;
        allMarkets.push(m);
      }
    }
  } catch (err) {
    console.error('Broad Polymarket error:', err.message);
  }

  return allMarkets;
}

// ── Fetch sportsbook odds ─────────────────────────────────────────────────────
async function fetchSportsOdds(category, entities) {
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) return [];

  const sportMap = {
    NBA: 'basketball_nba', NFL: 'americanfootball_nfl', NHL: 'icehockey_nhl',
    MLB: 'baseball_mlb', Soccer: 'soccer_epl', MMA: 'mma_mixed_martial_arts',
    NCAA: 'basketball_ncaab',
  };

  const sportKey = sportMap[category];
  if (!sportKey) return [];

  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings,fanduel`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return [];
    const games = await res.json();

    const teamEntities = entities.filter(e => e.type === 'teams').map(e => e.text.toLowerCase());
    const athleteEntities = entities.filter(e => e.type === 'athletes').map(e => e.text.toLowerCase());

    return games.slice(0, 20).map(game => {
      const bookmaker = game.bookmakers?.[0];
      const h2h = bookmaker?.markets?.find(m => m.key === 'h2h');
      if (!h2h) return null;

      const homeOutcome = h2h.outcomes?.find(o => o.name === game.home_team);
      const awayOutcome = h2h.outcomes?.find(o => o.name === game.away_team);
      if (!homeOutcome || !awayOutcome) return null;

      const homeProb = americanToProb(homeOutcome.price);
      const awayProb = americanToProb(awayOutcome.price);

      const gameLower = `${game.home_team} ${game.away_team}`.toLowerCase();
      const teamMatch = teamEntities.some(t => gameLower.includes(t));
      const relevanceBoost = teamMatch ? 0.4 : (athleteEntities.length > 0 ? 0.2 : 0);

      return {
        id: game.id,
        question: `${game.away_team} @ ${game.home_team}`,
        description: `${game.sport_title} — ${new Date(game.commence_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        outcomes: JSON.stringify([game.home_team, game.away_team]),
        outcomePrices: JSON.stringify([homeProb.toFixed(4), awayProb.toFixed(4)]),
        volume: '0', numTrades: '0', liquidity: '0',
        endDate: game.commence_time,
        _eventTitle: `${game.away_team} vs ${game.home_team}`,
        _eventId: `sports_${game.id}`,
        _source: 'sportsbook',
        _sportsKey: `${game.sport_key}_${game.id}`,
        _detectedCategory: category,
        _yesPrice: Math.round(homeProb * 100),
        _noPrice: Math.round(awayProb * 100),
        _homeTeam: game.home_team,
        _awayTeam: game.away_team,
        _homeOdds: homeOutcome.price,
        _awayOdds: awayOutcome.price,
        _bookmaker: bookmaker.title,
        _relevanceBoost: relevanceBoost,
      };
    }).filter(Boolean);
  } catch (err) {
    console.error('Odds API error:', err.message);
    return [];
  }
}

function americanToProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ── PASS 1: Grok Relevance-Only Scoring ───────────────────────────────────────
async function grokRelevancePass(tweetText, tweetHandle, topic, claim, sentiment, entities, allMarkets, apiKey, category) {
  try {
    const pool = allMarkets.slice(0, 150);
    const entityStr = entities.slice(0, 8).map(e => e.text || e).join(', ');

    const marketList = pool.map((m, i) => {
      let yp = '?';
      try { yp = Math.round(parseFloat(JSON.parse(m.outcomePrices || '[]')[0]) * 100) + '%'; } catch (_) {}
      const src = m._source === 'sportsbook' ? '[SPORTS]' : (m._targeted ? '[TARGETED]' : '[PM]');
      return `[${i}] ${src} ${m.question} | YES: ${yp}`;
    });

    // Build context block from search-x extracted data
    const contextBlock = [
      topic ? `TRENDING TOPIC: ${topic}` : '',
      claim ? `POST CLAIM: ${claim}` : '',
      sentiment !== 'neutral' ? `AUTHOR SENTIMENT: ${sentiment}` : '',
      entityStr ? `KEY ENTITIES: ${entityStr}` : '',
      `DETECTED CATEGORY: ${category}`,
    ].filter(Boolean).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          {
            role: 'user',
            content: `You are a relevance-matching engine for WeBet, a social betting app. Your ONLY job is to find markets that match the TOPIC of this X post.

POST by @${tweetHandle}:
"${tweetText.slice(0, 500)}"

${contextBlock}

TASK 1 — RELEVANCE MATCHING (this is the critical task):
Score each market PURELY on TOPICAL RELEVANCE to this post. Ignore odds, volume, and popularity.

STRICT MATCHING RULES:
1. The market must be about the SAME SPECIFIC SUBJECT as the post.
   ✅ Post about "Lakers vs Celtics tonight" → market "Lakers @ Celtics game odds" (same game)
   ❌ Post about "Lakers vs Celtics tonight" → market "NBA MVP 2026" (same sport, different topic)
2. Sharing a famous name is NOT enough. The ISSUE must match.
   ✅ Post about "Trump tariffs on China" → market "US tariff rate exceeds 25%" (same issue)
   ❌ Post about "Trump tariffs on China" → market "Trump wins 2028 election" (same person, different topic)
3. For sports: match the SPECIFIC teams/players/games mentioned, not just the sport.
4. Relevance scoring must be HONEST:
   - 0.9-1.0: Exact same specific topic/event
   - 0.7-0.89: Closely related to the same topic
   - 0.5-0.69: Same general area but different specific topic
   - 0.3-0.49: Loosely related
   - 0.0-0.29: Different topic entirely

Return 3-5 matches. It's OK to return fewer if only 1-2 markets are truly relevant.

For each match:
- idx: market index
- relevance: honest float 0.0-1.0
- side: "YES" or "NO" based on the post author's likely stance${sentiment !== 'neutral' ? ` (author seems ${sentiment})` : ''}
- outcome: plain-English bet claim (the actual prediction, not just YES/NO)
- reason: why this matches the post's specific topic (under 15 words)

TASK 2 — WEBET AI BET:
Create ONE peer-to-peer bet inspired by this post's EXACT topic${claim ? ` ("${claim}")` : ''}. Make it:
- Specific and verifiable (not vague)
- Timely (resolves within weeks/months)
- Debatable (friends would disagree)

Markets:
${marketList.join('\n')}

Return ONLY valid JSON:
{
  "matches": [{"idx":0,"relevance":0.85,"side":"YES","outcome":"specific claim","reason":"brief reason"}],
  "aiBet": {"claim":"...","side":"YES","confidence":7,"reasoning":"...","category":"Politics"}
}`
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error('Grok API error:', res.status);
      return { matches: [], aiBet: null };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(cleaned);

    const matches = (result.matches || [])
      .filter(p => typeof p.idx === 'number' && p.idx >= 0 && p.idx < pool.length)
      .map(p => {
        const market = pool[p.idx];
        const boost = market._relevanceBoost || 0;
        return {
          ...market,
          _relevance: Math.min(Math.max((typeof p.relevance === 'number' ? p.relevance : 0.5) + boost, 0), 1),
          _side: (p.side === 'NO') ? 'NO' : 'YES',
          _specificOutcome: p.outcome || '',
          _sideReason: p.reason || '',
          _grokReason: p.reason || '',
          _detectedCategory: category,
        };
      });

    const aiBet = result.aiBet ? {
      claim: result.aiBet.claim || '',
      side: result.aiBet.side || 'YES',
      confidence: Math.min(Math.max(parseInt(result.aiBet.confidence) || 5, 1), 10),
      reasoning: result.aiBet.reasoning || '',
      category: result.aiBet.category || 'Markets',
    } : null;

    return { matches, aiBet };
  } catch (err) {
    console.error('Grok relevance pass error:', err);
    return { matches: [], aiBet: null };
  }
}

// ── Keyword Fallback (entity-weighted) ────────────────────────────────────────
function keywordFallback(tweetText, allMarkets, entities, topic) {
  const entityTerms = entities.map(e => ({ term: (e.text || e).toLowerCase(), weight: e.weight || 0.7 }));

  // Add topic words as high-weight terms
  if (topic) {
    const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const w of topicWords) {
      if (!entityTerms.find(e => e.term === w)) {
        entityTerms.push({ term: w, weight: 0.9 });
      }
    }
  }

  const plainWords = tweetText
    .replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').toLowerCase()
    .split(/\s+/).filter(w => w.length > 4 && /^[a-z]/i.test(w))
    .map(w => ({ term: w, weight: 0.3 }));

  const allTerms = [...entityTerms, ...plainWords];
  if (allTerms.length === 0) return [];

  return allMarkets
    .map(m => {
      const text = ((m.question || '') + ' ' + (m.description || '') + ' ' + (m._eventTitle || '')).toLowerCase();
      let totalWeight = 0;
      let matchedWeight = 0;

      for (const { term, weight } of allTerms) {
        totalWeight += weight;
        if (text.includes(term)) matchedWeight += weight;
      }

      const relevance = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      if (relevance <= 0.05) return null;

      return {
        ...m,
        _relevance: Math.min(relevance * 1.5, 1),
        _side: 'YES',
        _specificOutcome: `YES — ${toBetClaim(m.question)}`,
        _sideReason: 'keyword match',
        _grokReason: null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b._relevance - a._relevance)
    .slice(0, 10);
}

// ── Validation: confirm topic alignment ───────────────────────────────────────
function validateMatch(tweetText, market, entities, category, topic) {
  const postLower = (tweetText + ' ' + topic).toLowerCase();
  const marketText = ((market.question || '') + ' ' + (market.description || '') + ' ' + (market._eventTitle || '')).toLowerCase();

  if (market._source === 'sportsbook') {
    const homeTeam = (market._homeTeam || '').toLowerCase();
    const awayTeam = (market._awayTeam || '').toLowerCase();
    const teamInPost = postLower.includes(homeTeam.split(' ').pop()) || postLower.includes(awayTeam.split(' ').pop());
    const entityInMarket = entities.some(e =>
      marketText.includes((e.text || e).toLowerCase())
    );
    return teamInPost || entityInMarket;
  }

  const postEntities = entities.filter(e => (e.weight || 0) >= 0.5).map(e => (e.text || e).toLowerCase());
  if (postEntities.length === 0) return true;

  const entityOverlap = postEntities.some(e => marketText.includes(e));
  const marketCategory = detectCategory(marketText);
  const categoryMatch = marketCategory === category || category === 'General';

  return entityOverlap || categoryMatch;
}

// ── PASS 2: Bettability Scoring (only applied to relevance-passed markets) ────
function computeBettability(m) {
  const relevance = m._relevance || 0.3;

  let yesRaw = 0.5;
  try {
    const p = JSON.parse(m.outcomePrices || '[]');
    yesRaw = parseFloat(p[0]) || 0.5;
  } catch (_) {}
  const oddsScore = 1 - Math.abs(yesRaw - 0.5) * 2;

  const vol = parseFloat(m.volume) || 0;
  const volScore = m._source === 'sportsbook' ? 0.7 : Math.min(Math.log10(Math.max(vol, 1)) / 8, 1);

  const liq = parseFloat(m.liquidity) || 0;
  const liqScore = m._source === 'sportsbook' ? 0.7 : Math.min(Math.log10(Math.max(liq, 1)) / 7, 1);

  let timeScore = 0.2;
  if (m.endDate) {
    const days = (new Date(m.endDate) - new Date()) / 86400000;
    if (days < 0) timeScore = 0.0;
    else if (days < 1) timeScore = 0.8;
    else if (days <= 7) timeScore = 0.9;
    else if (days <= 30) timeScore = 1.0;
    else if (days <= 90) timeScore = 0.7;
    else if (days <= 365) timeScore = 0.4;
    else timeScore = 0.2;
  }

  const trades = parseInt(m.numTrades) || 0;
  const tradeScore = m._source === 'sportsbook' ? 0.6 : Math.min(Math.log10(Math.max(trades, 1)) / 5, 1);

  // Relevance is king — it already passed the quality gate, so weight it highest
  return (
    0.45 * relevance +
    0.18 * oddsScore +
    0.12 * volScore +
    0.08 * liqScore +
    0.10 * timeScore +
    0.07 * tradeScore
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function toBetClaim(question) {
  let claim = question
    .replace(/^Will\s+/i, '').replace(/^Does\s+/i, '').replace(/^Is\s+/i, '')
    .replace(/^Are\s+/i, '').replace(/^Can\s+/i, '').replace(/\?+$/, '').trim();

  claim = claim.split(' ').map((w, i) => {
    const lower = w.toLowerCase();
    if (['the', 'a', 'an', 'of', 'in', 'on', 'to', 'by', 'or', 'and', 'for', 'at', 'vs'].includes(lower) && i > 0) return lower;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');

  return claim;
}
