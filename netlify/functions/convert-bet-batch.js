// convert-bet-batch.js — Batch market matching for multiple posts in ONE Grok call
// Instead of 5 separate convert-bet calls (5 Grok API calls, ~30s total),
// this sends all posts to Grok at once (1 API call, ~5-8s total).
// Then applies the same pipeline: bettability, quality gate, diversity, validation.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// COST PAUSE 2026-07-10 — paused alongside convert-bet.js to stop the X-post →
// market matching Grok spend. Flip to false to re-enable.
const CONVERT_BET_PAUSED = true;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (CONVERT_BET_PAUSED) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ paused: true, cards: [], results: [] }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const posts = body.posts || [];

    if (!posts.length) throw new Error('No posts provided');

    // ── Step 1: Detect categories + extract entities for all posts ────────
    const enrichedPosts = posts.map((p, i) => {
      const topic = p.topic || '';
      const claim = p.claim || '';
      const sentiment = p.sentiment || 'neutral';
      const text = p.text || '';
      const category = detectCategory(topic || text);
      const isSports = ['NBA','NFL','NHL','MLB','Soccer','Tennis','Golf','MMA','Boxing','NCAA','F1'].includes(category);
      const localEntities = extractEntities(text);
      const merged = mergeEntities(p.entities || [], localEntities);
      return { ...p, idx: i, topic, claim, sentiment, category, isSports, entities: merged };
    });

    // ── Step 2: Determine which sport APIs to call ───────────────────────
    const sportCategories = [...new Set(enrichedPosts.filter(p => p.isSports).map(p => p.category))];
    const allEntities = enrichedPosts.flatMap(p => p.entities);

    // Build search keywords from all posts for targeted Polymarket
    const allKeywords = [];
    for (const p of enrichedPosts) {
      if (p.topic) allKeywords.push(...p.topic.split(/\s+/).filter(w => w.length > 2));
      for (const e of (p.entities || []).slice(0, 3)) {
        const t = e.text || e;
        if (t && !allKeywords.includes(t)) allKeywords.push(t);
      }
    }

    // ── Step 3: Fetch all market data in parallel ────────────────────────
    const marketFetches = [
      fetchBroadPolymarkets(),
      allKeywords.length > 0 ? fetchTargetedPolymarkets(allKeywords.slice(0, 6)) : Promise.resolve([]),
      ...sportCategories.map(cat => fetchSportsOdds(cat, allEntities)),
    ];

    const results = await Promise.all(marketFetches);
    const broadMarkets = results[0];
    const targetedMarkets = results[1];
    const sportsMarkets = results.slice(2).flat();

    // Combine and dedupe
    const seenIds = new Set();
    const allMarkets = [];
    for (const pool of [sportsMarkets, targetedMarkets, broadMarkets]) {
      for (const m of pool) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          allMarkets.push(m);
        }
      }
    }

    // ── Step 4: Single Grok call to match ALL posts at once ──────────────
    const xaiKey = process.env.XAI_API_KEY;
    let batchMatches = {};
    let batchAiBets = {};

    if (xaiKey && allMarkets.length > 0 && enrichedPosts.length > 0) {
      const grokResult = await grokBatchMatch(enrichedPosts, allMarkets, xaiKey);
      batchMatches = grokResult.matches || {};
      batchAiBets = grokResult.aiBets || {};
    }

    // ── Step 5: Process each post through quality gate + bettability ─────
    const usedEventIds = new Set();
    const usedQuestions = new Set();
    const output = [];

    for (const post of enrichedPosts) {
      const idx = post.idx;
      let candidates = batchMatches[idx] || [];

      // Fallback: keyword matching if Grok returned nothing for this post
      if (candidates.length === 0) {
        candidates = keywordFallback(post.text, allMarkets, post.entities, post.topic);
      }

      // Quality gate: relevance >= 0.4
      const relevant = candidates.filter(m => (m._relevance || 0) >= 0.4);
      const gated = relevant.length >= 1
        ? relevant
        : candidates.slice(0, 3).map(m => ({ ...m, _lowConfidence: true }));

      // Bettability scoring
      const scored = gated.map(m => { m._bettability = computeBettability(m); return m; });
      scored.sort((a, b) => b._bettability - a._bettability);

      // Diversity enforcement (across ALL posts in the batch)
      const diverse = [];
      for (const m of scored) {
        const eventKey = m._eventId || m._sportsKey || m.id;
        const qNorm = (m.question || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
        if (usedEventIds.has(eventKey) || usedQuestions.has(qNorm)) continue;
        usedEventIds.add(eventKey);
        usedQuestions.add(qNorm);
        diverse.push(m);
        if (diverse.length >= 3) break;
      }

      // Validation
      const validated = diverse.map(m => {
        const valid = validateMatch(post.text, m, post.entities, post.category, post.topic);
        m._validated = valid;
        if (!valid) {
          m._relevance = Math.min(m._relevance || 0, 0.15);
          m._bettability = computeBettability(m);
        }
        return m;
      });
      validated.sort((a, b) => b._bettability - a._bettability);

      // Format top market
      const topMarkets = validated.slice(0, 3).map(formatMarket);

      output.push({
        idx,
        tweetText: post.text,
        tweetAuthor: post.author,
        tweetHandle: post.handle,
        topic: post.topic,
        claim: post.claim,
        category: post.category,
        markets: topMarkets,
        aiBet: batchAiBets[idx] || null,
      });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ results: output }),
    };
  } catch (err) {
    console.error('convert-bet-batch error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Grok Batch Matching (ONE call for ALL posts) ──────────────────────────────
async function grokBatchMatch(posts, allMarkets, apiKey) {
  try {
    const pool = allMarkets.slice(0, 150);

    const marketList = pool.map((m, i) => {
      let yp = '?';
      try { yp = Math.round(parseFloat(JSON.parse(m.outcomePrices || '[]')[0]) * 100) + '%'; } catch (_) {}
      const src = m._source === 'sportsbook' ? '[SPORTS]' : (m._targeted ? '[TARGETED]' : '[PM]');
      return `[${i}] ${src} ${m.question} | YES: ${yp}`;
    });

    const postDescriptions = posts.map((p, i) => {
      const parts = [`POST ${i}: @${(p.handle || '').replace(/^@/, '')} — "${(p.text || '').slice(0, 300)}"`];
      if (p.topic) parts.push(`  Topic: ${p.topic}`);
      if (p.claim) parts.push(`  Claim: ${p.claim}`);
      if (p.sentiment && p.sentiment !== 'neutral') parts.push(`  Sentiment: ${p.sentiment}`);
      if (p.entities && p.entities.length > 0) {
        const ents = p.entities.slice(0, 5).map(e => e.text || e).join(', ');
        parts.push(`  Entities: ${ents}`);
      }
      parts.push(`  Category: ${p.category}`);
      return parts.join('\n');
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // slightly more time for batch

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning',
        messages: [
          {
            role: 'user',
            content: `You are a relevance-matching engine for WeBet. Match EACH post below to the most topically relevant markets.

POSTS:
${postDescriptions.join('\n\n')}

MATCHING RULES:
1. Each post must match DIFFERENT markets (no duplicates across posts)
2. The market topic must match the post's SPECIFIC subject, not just share a name
3. For sports: match specific teams/players mentioned, prefer [SPORTS] markets
4. Be HONEST with relevance: 0.9+ = exact topic, 0.7+ = closely related, 0.5+ = same area, <0.5 = weak
5. Return 1-3 matches per post. It's OK to return just 1 if only 1 market is truly relevant.

For each match provide: idx (market index), relevance (float 0-1), side (YES/NO), outcome (the specific bet claim), reason (under 15 words)

Also create ONE unique peer-to-peer AI bet per post — specific, timely, debatable.

MARKETS:
${marketList.join('\n')}

Return ONLY valid JSON:
{
  "matches": {
    "0": [{"idx":5,"relevance":0.9,"side":"YES","outcome":"specific claim","reason":"why this matches"}],
    "1": [{"idx":12,"relevance":0.85,"side":"NO","outcome":"specific claim","reason":"why this matches"}]
  },
  "aiBets": {
    "0": {"claim":"...","side":"YES","confidence":7,"reasoning":"...","category":"Politics"},
    "1": {"claim":"...","side":"NO","confidence":6,"reasoning":"...","category":"Sports"}
  }
}`
          }
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.error('Grok batch API error:', res.status);
      return { matches: {}, aiBets: {} };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(cleaned);

    // Process matches
    const processedMatches = {};
    for (const [postIdx, matchList] of Object.entries(result.matches || {})) {
      processedMatches[postIdx] = (matchList || [])
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
          };
        });
    }

    // Process AI bets
    const processedAiBets = {};
    for (const [postIdx, bet] of Object.entries(result.aiBets || {})) {
      if (bet) {
        processedAiBets[postIdx] = {
          claim: bet.claim || '',
          side: bet.side || 'YES',
          confidence: Math.min(Math.max(parseInt(bet.confidence) || 5, 1), 10),
          reasoning: bet.reasoning || '',
          category: bet.category || 'Markets',
        };
      }
    }

    return { matches: processedMatches, aiBets: processedAiBets };
  } catch (err) {
    console.error('Grok batch error:', err);
    return { matches: {}, aiBets: {} };
  }
}

// ── Market Fetching ───────────────────────────────────────────────────────────
async function fetchBroadPolymarkets() {
  try {
    const now = new Date().toISOString();
    const eventsRes = await fetch(
      'https://gamma-api.polymarket.com/events?limit=60&closed=false&order=volume&ascending=false',
      { signal: AbortSignal.timeout(5000) }
    ).then(r => r.json());

    if (!Array.isArray(eventsRes)) return [];

    const markets = [];
    const seen = new Set();
    for (const ev of eventsRes) {
      const eventMarkets = (ev.markets || []).filter(m => !m.closed && !(m.endDate && m.endDate < now) && !seen.has(m.id));
      eventMarkets.sort((a, b) => (parseFloat(b.volume) || 0) - (parseFloat(a.volume) || 0));
      for (const m of eventMarkets.slice(0, 3)) {
        seen.add(m.id);
        m._eventTitle = ev.title || '';
        m._eventId = ev.id || '';
        m._source = 'polymarket';
        markets.push(m);
      }
    }
    return markets;
  } catch (err) {
    console.error('Broad Polymarket error:', err.message);
    return [];
  }
}

async function fetchTargetedPolymarkets(keywords) {
  const markets = [];
  const seen = new Set();
  const now = new Date().toISOString();

  try {
    const searches = keywords.slice(0, 4).map(async (kw) => {
      try {
        const res = await fetch(
          `https://gamma-api.polymarket.com/events?limit=10&closed=false&order=volume&ascending=false&tag=${encodeURIComponent(kw.toLowerCase())}`,
          { signal: AbortSignal.timeout(3000) }
        ).then(r => r.json());
        return Array.isArray(res) ? res : [];
      } catch (_) {
        try {
          const res = await fetch(
            `https://gamma-api.polymarket.com/events?limit=10&closed=false&title=${encodeURIComponent(kw)}`,
            { signal: AbortSignal.timeout(3000) }
          ).then(r => r.json());
          return Array.isArray(res) ? res : [];
        } catch (_) { return []; }
      }
    });

    const results = await Promise.all(searches);
    for (const events of results) {
      for (const ev of events) {
        for (const m of (ev.markets || []).filter(m => !m.closed && !(m.endDate && m.endDate < now) && !seen.has(m.id)).slice(0, 2)) {
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

async function fetchSportsOdds(category, entities) {
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) return [];

  const sportMap = {
    NBA: 'basketball_nba', NFL: 'americanfootball_nfl', NHL: 'icehockey_nhl',
    MLB: 'baseball_mlb', Soccer: 'soccer_epl', MMA: 'mma_mixed_martial_arts', NCAA: 'basketball_ncaab',
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

    const teamEntities = entities.filter(e => (e.type || '') === 'teams').map(e => (e.text || e).toLowerCase());

    return games.slice(0, 20).map(game => {
      const bk = game.bookmakers?.[0];
      const h2h = bk?.markets?.find(m => m.key === 'h2h');
      if (!h2h) return null;
      const ho = h2h.outcomes?.find(o => o.name === game.home_team);
      const ao = h2h.outcomes?.find(o => o.name === game.away_team);
      if (!ho || !ao) return null;

      const hp = americanToProb(ho.price);
      const ap = americanToProb(ao.price);
      const gameLower = `${game.home_team} ${game.away_team}`.toLowerCase();
      const teamMatch = teamEntities.some(t => gameLower.includes(t));

      return {
        id: game.id,
        question: `${game.away_team} @ ${game.home_team}`,
        description: `${game.sport_title} — ${new Date(game.commence_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        outcomes: JSON.stringify([game.home_team, game.away_team]),
        outcomePrices: JSON.stringify([hp.toFixed(4), ap.toFixed(4)]),
        volume: '0', numTrades: '0', liquidity: '0',
        endDate: game.commence_time,
        _eventTitle: `${game.away_team} vs ${game.home_team}`,
        _eventId: `sports_${game.id}`,
        _source: 'sportsbook',
        _sportsKey: `${game.sport_key}_${game.id}`,
        _detectedCategory: category,
        _yesPrice: Math.round(hp * 100),
        _noPrice: Math.round(ap * 100),
        _homeTeam: game.home_team,
        _awayTeam: game.away_team,
        _relevanceBoost: teamMatch ? 0.4 : 0,
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

// ── Keyword Fallback ──────────────────────────────────────────────────────────
function keywordFallback(tweetText, allMarkets, entities, topic) {
  const entityTerms = (entities || []).map(e => ({ term: (e.text || e).toLowerCase(), weight: e.weight || 0.7 }));
  if (topic) {
    for (const w of topic.toLowerCase().split(/\s+/).filter(w => w.length > 2)) {
      if (!entityTerms.find(e => e.term === w)) entityTerms.push({ term: w, weight: 0.9 });
    }
  }
  const plainWords = (tweetText || '').replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').toLowerCase()
    .split(/\s+/).filter(w => w.length > 4).map(w => ({ term: w, weight: 0.3 }));
  const allTerms = [...entityTerms, ...plainWords];
  if (!allTerms.length) return [];

  return allMarkets.map(m => {
    const text = ((m.question || '') + ' ' + (m.description || '') + ' ' + (m._eventTitle || '')).toLowerCase();
    let total = 0, matched = 0;
    for (const { term, weight } of allTerms) { total += weight; if (text.includes(term)) matched += weight; }
    const rel = total > 0 ? matched / total : 0;
    if (rel <= 0.05) return null;
    return { ...m, _relevance: Math.min(rel * 1.5, 1), _side: 'YES', _specificOutcome: `YES — ${toBetClaim(m.question)}`, _sideReason: 'keyword match', _grokReason: null };
  }).filter(Boolean).sort((a, b) => b._relevance - a._relevance).slice(0, 10);
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateMatch(tweetText, market, entities, category, topic) {
  const postLower = ((tweetText || '') + ' ' + (topic || '')).toLowerCase();
  const marketText = ((market.question || '') + ' ' + (market.description || '') + ' ' + (market._eventTitle || '')).toLowerCase();

  if (market._source === 'sportsbook') {
    const ht = (market._homeTeam || '').toLowerCase();
    const at = (market._awayTeam || '').toLowerCase();
    return postLower.includes(ht.split(' ').pop()) || postLower.includes(at.split(' ').pop()) ||
      (entities || []).some(e => marketText.includes((e.text || e).toLowerCase()));
  }

  const pe = (entities || []).filter(e => (e.weight || 0) >= 0.5).map(e => (e.text || e).toLowerCase());
  if (!pe.length) return true;
  return pe.some(e => marketText.includes(e)) || detectCategory(marketText) === category;
}

// ── Bettability Scoring ───────────────────────────────────────────────────────
function computeBettability(m) {
  const relevance = m._relevance || 0.3;
  let yesRaw = 0.5;
  try { const p = JSON.parse(m.outcomePrices || '[]'); yesRaw = parseFloat(p[0]) || 0.5; } catch (_) {}
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
    else timeScore = 0.3;
  }
  const trades = parseInt(m.numTrades) || 0;
  const tradeScore = m._source === 'sportsbook' ? 0.6 : Math.min(Math.log10(Math.max(trades, 1)) / 5, 1);

  return 0.45 * relevance + 0.18 * oddsScore + 0.12 * volScore + 0.08 * liqScore + 0.10 * timeScore + 0.07 * tradeScore;
}

// ── Format market for response ────────────────────────────────────────────────
function formatMarket(m) {
  let outcomes = [], prices = [];
  try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
  try { prices = JSON.parse(m.outcomePrices || '[]'); } catch (_) {}

  const yesPrice = prices[0] ? Math.round(parseFloat(prices[0]) * 100) : (m._yesPrice || null);
  const noPrice = prices[1] ? Math.round(parseFloat(prices[1]) * 100) : (m._noPrice || null);
  const betClaim = toBetClaim(m.question);
  const side = m._side || 'YES';

  return {
    id: m.id,
    question: m.question,
    betClaim,
    specificOutcome: m._specificOutcome || `${side} — ${betClaim}`,
    description: (m.description || '').slice(0, 200),
    volume: m.volume, numTrades: m.numTrades, liquidity: m.liquidity,
    endDate: m.endDate,
    settleDate: m.endDate ? new Date(m.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Market resolution',
    settleDateShort: m.endDate ? new Date(m.endDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : null,
    polyUrl: m._source === 'sportsbook' ? null : `https://polymarket.com/event/${m.slug || m.conditionId || m.id}`,
    outcomes, prices, yesPrice, noPrice, side,
    sideOdds: side === 'YES' ? yesPrice : noPrice,
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function detectCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\b(ufc|mma|bellator)\b/.test(t)) return 'MMA';
  if (/\b(nba|basketball|laker|celtic|warrior|knick|bull|heat|buck|nugget|jokic|lebron|curry|doncic|tatum|embiid|giannis)\b/.test(t)) return 'NBA';
  if (/\b(nfl|super bowl|mahomes|burrow|allen|lamar|eagle|cowboy|chief)\b/.test(t)) return 'NFL';
  if (/\b(nhl|hockey|stanley cup|oiler|ranger|bruin)\b/.test(t)) return 'NHL';
  if (/\b(mlb|baseball|world series|yankee|dodger|ohtani)\b/.test(t)) return 'MLB';
  if (/\b(soccer|premier league|champions league|world cup|messi|ronaldo|mbappe|haaland|arsenal|liverpool)\b/.test(t)) return 'Soccer';
  if (/\b(tennis|wimbledon|djokovic|alcaraz|sinner)\b/.test(t)) return 'Tennis';
  if (/\b(golf|masters|pga|scheffler)\b/.test(t)) return 'Golf';
  if (/\b(f1|formula 1|verstappen|hamilton)\b/.test(t)) return 'F1';
  if (/\b(election|president|trump|biden|congress|senate|tariff|republican|democrat)\b/.test(t)) return 'Politics';
  if (/\b(nato|ukraine|russia|china|iran|gaza|putin|zelensky)\b/.test(t)) return 'World';
  if (/\b(bitcoin|btc|crypto|ethereum|eth|solana|defi)\b/.test(t)) return 'Crypto';
  if (/\b(fed|interest rate|inflation|recession|gdp|cpi|fomc)\b/.test(t)) return 'Macro';
  if (/\b(stock|s&p|nasdaq|dow|ipo|earnings)\b/.test(t)) return 'Markets';
  if (/\b(ai|openai|chatgpt|apple|google|microsoft|meta|tech)\b/.test(t)) return 'Tech';
  if (/\b(oscar|grammy|emmy|netflix|movie|taylor swift|beyonce)\b/.test(t)) return 'Entertainment';
  return 'General';
}

function extractEntities(text) {
  const clean = (text || '').replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').trim();
  const entities = [];
  const DB = {
    teams: { w: 1.0, items: ['Lakers','Celtics','Warriors','Bulls','Heat','Knicks','Bucks','Nuggets','Suns','Mavericks','Thunder','Cavaliers','76ers','Chiefs','Eagles','Cowboys','Bills','Bengals','Ravens','49ers','Packers','Lions','Steelers','Yankees','Dodgers','Mets','Braves','Astros','Arsenal','Liverpool','Barcelona','Real Madrid','Manchester City','Chelsea','Bayern','PSG'] },
    athletes: { w: 0.95, items: ['LeBron','Curry','Durant','Jokic','Giannis','Embiid','Luka','Tatum','SGA','Mahomes','Burrow','Allen','Lamar','Ohtani','Messi','Ronaldo','Mbappe','Haaland','Djokovic','Alcaraz','Verstappen','Hamilton'] },
    political: { w: 0.85, items: ['Trump','Biden','Congress','Senate','Supreme Court','Fed','NATO','Ukraine','Russia','China','Iran','Gaza','Putin','Zelensky'] },
    financial: { w: 0.8, items: ['Bitcoin','BTC','Ethereum','ETH','Solana','S&P 500','Nasdaq','inflation','tariff','tariffs'] },
    tech: { w: 0.75, items: ['OpenAI','ChatGPT','Apple','Google','Microsoft','Meta','Tesla','Nvidia','Elon Musk'] },
  };
  for (const [type, { w, items }] of Object.entries(DB)) {
    for (const entity of items) {
      if (new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clean)) {
        entities.push({ text: entity, type, weight: w });
      }
    }
  }
  entities.sort((a, b) => b.weight - a.weight);
  return entities;
}

function mergeEntities(passed, local) {
  const merged = [...local];
  const existing = new Set(merged.map(e => (e.text || '').toLowerCase()));
  for (const pe of (passed || [])) {
    const text = typeof pe === 'string' ? pe : pe.text;
    if (text && !existing.has(text.toLowerCase())) {
      existing.add(text.toLowerCase());
      merged.push({ text, type: 'extracted', weight: 0.85 });
    }
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

function toBetClaim(question) {
  let c = (question || '').replace(/^Will\s+/i, '').replace(/^Does\s+/i, '').replace(/^Is\s+/i, '')
    .replace(/^Are\s+/i, '').replace(/^Can\s+/i, '').replace(/\?+$/, '').trim();
  return c.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    if (['the','a','an','of','in','on','to','by','or','and','for','at','vs'].includes(l) && i > 0) return l;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}
