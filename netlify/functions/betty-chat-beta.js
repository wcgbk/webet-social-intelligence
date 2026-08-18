// betty-chat-beta.js — Betty Beta: Full-context AI with all WeBetAI data sources
// Same brain as SMS Betty, but with web chat interface + configurable data sources

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Betty's core personality ──
const BETTY_CORE = `You are Betty, WeBetAI's AI. You're a knowledgeable, friendly assistant people text like a real person.

VOICE & TONE:
- Warm, sharp, confident, and fun — like the person at the bar who knows more about sports than everyone there.
- You're someone people look forward to talking to. Engaging, direct, and genuinely interested in what they're asking.
- Confident and knowledgeable but never cold. You compliment good questions, you keep things fun and energetic.
- Do NOT flirt, use pet names ("handsome", "babe", etc.), or be romantically suggestive. Stay professional and cool.
- EXCEPTION: If a user clearly flirts with you first, you can lightly and humorously play along once — then steer back to the topic.
- NEVER say "haha", "lol", "lmao", or any form of laughing. Hard rule. No laughing emojis either.
- You can talk about anything — sports, news, markets, pop culture, life advice, whatever. You're a full AI with real-time data, not just a picks bot.

FORMAT RULES:
- Keep it concise but don't be robotic. Sound like a person, not a terminal.
- Default: 1-3 sentences. Under 400 characters.
- If someone asks for detail or a breakdown, go up to 800 chars.
- No markdown (no ** or # or bullets). Plain text only. Line breaks to separate info.
- Minimal emojis. One max per message, only if it fits naturally.

PICKS INTEGRITY:
- The ONLY betting picks you endorse are from [EDGE PICKS] data. These come from /alpha on webetsocial.com.
- NEVER generate your own picks. You're the interface for WeBetAI's model, not a sportsbook.
- If a game isn't in today's picks: "That one didn't make the cut today — model only takes high-edge plays."
- No picks loaded = "Picks drop at 10am EST."
- You CAN discuss any game, matchup, player, score, or storyline freely. Just don't frame it as a WeBetAI pick unless it's in the data.

GENERAL KNOWLEDGE:
- You are a full-featured AI. Answer questions about anything — not just sports.
- You have access to live ESPN scores, Polymarket, Kalshi, BettorEdge, team ratings, Guardian fact-checks, and the WeBetAI data ecosystem.
- For topics outside your live data, use your general knowledge. Be helpful, be accurate.
- If you don't know something, say so honestly.

RESPONSE RULES (CRITICAL):
- NEVER direct people to URLs, pages, dashboards, or sections. Just give them the answer.
- You have ALL the data. Use it. If they ask about a specific pick, talk about THAT pick — matchup, number, why it made the card, what loses — like a sharp friend. Do not dump the whole card as a list (the chat already showed cards).
- NEVER say "check the dashboard", "head to the edge picks", "hop on the site", or "go to [URL]". You ARE the interface. The conversation IS the product.
- Only provide a URL if someone explicitly says "send me the link" or "what's the URL."
- Keep talking. After you answer, one short question to stay in the conversation.`;

// ── Timed fetch helper (3s max per data source) ──
const SITE = () => process.env.URL || 'https://webetsocial.com';

function timedFetch(url, ms = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .then(res => { clearTimeout(timer); return res.ok ? res.json() : null; })
    .catch(() => { clearTimeout(timer); return null; });
}

// ── Data source fetchers ──

async function fetchEdgePicks() {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-alpha');
    const latestDate = await store.get('latest-date');
    if (!latestDate) return null;
    return await store.get(`picks-${latestDate.trim()}`, { type: 'json' });
  } catch (_) {
    return timedFetch(`${SITE()}/.netlify/functions/get-picks-alpha`);
  }
}

function fetchResults() { return timedFetch(`${SITE()}/.netlify/functions/get-results-alpha`); }
function fetchRatings(league) { return timedFetch(`${SITE()}/.netlify/functions/get-ratings${league ? `?league=${league}` : ''}`); }
function fetchGuardian() { return timedFetch(`${SITE()}/.netlify/functions/get-guardian`); }
function fetchMarkets() { return timedFetch(`${SITE()}/.netlify/functions/get-bettoredge`); }
function fetchP2PLeaderboard() { return timedFetch(`${SITE()}/.netlify/functions/get-p2p-leaderboard`); }

// ── ESPN live scores (NBA, NHL, MLB, MLS) ──
async function fetchESPNScores() {
  const endpoints = [
    { league: 'NBA', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { league: 'NHL', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' },
    { league: 'MLB', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
    { league: 'MLS', url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
  ];
  const results = await Promise.allSettled(endpoints.map(e => timedFetch(e.url, 2500)));
  const games = [];
  endpoints.forEach((e, i) => {
    if (results[i].status !== 'fulfilled' || !results[i].value) return;
    const data = results[i].value;
    (data.events || []).forEach(ev => {
      const c = ev.competitions?.[0];
      if (!c) return;
      const away = c.competitors?.find(t => t.homeAway === 'away');
      const home = c.competitors?.find(t => t.homeAway === 'home');
      const status = c.status?.type?.shortDetail || '';
      games.push({
        league: e.league,
        away: away?.team?.abbreviation || '?',
        awayScore: away?.score || '0',
        home: home?.team?.abbreviation || '?',
        homeScore: home?.score || '0',
        status,
        state: c.status?.type?.state || 'pre', // pre, in, post
      });
    });
  });
  return games.length > 0 ? games : null;
}

// ── Polymarket trending markets ──
async function fetchPolymarket() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=8', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const markets = await res.json();
    return (markets || []).map(m => ({
      question: m.question || m.title || '',
      price: m.outcomePrices ? JSON.parse(m.outcomePrices)?.[0] : null,
      volume24h: m.volume24hr || 0,
      category: m.category || '',
    })).filter(m => m.question);
  } catch (_) { return null; }
}

// ── Kalshi trending markets ──
async function fetchKalshi() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?limit=8&status=open', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.markets || []).map(m => ({
      title: m.title || m.ticker || '',
      yesPrice: m.yes_ask || m.last_price || 0,
      volume: m.volume || 0,
    })).filter(m => m.title);
  } catch (_) { return null; }
}

// ── Build context from enabled data sources (each fetch has 3s timeout) ──
async function buildContext(enabledSources) {
  const ctx = [];
  const map = {
    picks: fetchEdgePicks, results: fetchResults, ratings: fetchRatings,
    guardian: fetchGuardian, markets: fetchMarkets, p2p: fetchP2PLeaderboard,
    espn: fetchESPNScores, polymarket: fetchPolymarket, kalshi: fetchKalshi,
  };

  const keys = enabledSources.filter(k => map[k]);
  const results = await Promise.allSettled(keys.map(k => map[k]()));

  keys.forEach((key, i) => {
    if (results[i].status !== 'fulfilled' || !results[i].value) return;
    const data = results[i].value;

    if (key === 'picks') {
      if (!data.picks?.length) { ctx.push('[EDGE PICKS] No picks today. Drops at 10am EST.'); return; }
      let s = `[EDGE PICKS — ${data.dateFormatted || data.date}]\n`;
      s += `${data.summary?.totalPicks || 0} picks, ${data.summary?.totalUnits || '0u'} units | ${(data.summary?.sportsCovered || []).join(', ')}\n`;
      data.picks.forEach((p, idx) => {
        s += `#${idx + 1} [${p.rating}] ${p.sport}: ${p.matchup} — ${p.pick} | ${p.odds} | ${p.units}u\n`;
        s += `  Why: ${p.coreReasoning} | Risk: ${p.whatLoses}\n`;
      });
      ctx.push(s);
    }
    else if (key === 'results') {
      const c = data.cumulative; if (!c) return;
      let s = `[TRACK RECORD] ${c.wins}W-${c.losses}L | ${c.accuracy} | ${c.roi} ROI | ${c.totalProfit > 0 ? '+' : ''}${c.totalProfit}u profit`;
      if (data.days?.length) s += `\nRecent: ${data.days.slice(0, 3).map(d => `${d.dateFormatted}: ${d.wins}W-${d.losses}L`).join(' | ')}`;
      ctx.push(s);
    }
    else if (key === 'ratings') {
      if (!data.leagues) return;
      let s = '[TEAM RATINGS]\n';
      Object.entries(data.leagues).forEach(([lg, info]) => {
        s += `${lg}: ${(info.top5 || []).slice(0, 3).map(t => `${t.name} (${t.elo})`).join(', ')}\n`;
      });
      ctx.push(s);
    }
    else if (key === 'guardian') {
      if (!data.digest) return;
      let s = `[GUARDIAN — ${data.date}]`;
      if (data.stats) s += ` Verified: ${data.stats.verified} | Avg Score: ${data.stats.avgAuthenticityScore}`;
      const items = Array.isArray(data.digest) ? data.digest.slice(0, 5) : [];
      items.forEach(item => { s += `\n- ${item.title || item.claim || JSON.stringify(item).slice(0, 80)}`; });
      ctx.push(s);
    }
    else if (key === 'markets') {
      const events = (data.events || []).filter(e => new Date(e.scheduledDatetime) > new Date()).slice(0, 8);
      if (!events.length) return;
      let s = `[LIVE MARKETS — ${events.length} upcoming]\n`;
      events.forEach(e => {
        const t = new Date(e.scheduledDatetime).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
        s += `${(e.leagueName || '').toUpperCase()}: ${e.away?.name || '?'} @ ${e.home?.name || '?'} ${t} ET\n`;
      });
      ctx.push(s);
    }
    else if (key === 'p2p') {
      if (!data.leaderboard?.length) return;
      ctx.push('[P2P LEADERBOARD]\n' + data.leaderboard.slice(0, 5).map((u, i) =>
        `#${i + 1} ${u.handle || u.name}: ${u.wins}W-${u.losses}L | ${u.profit > 0 ? '+' : ''}$${u.profit}`
      ).join('\n'));
    }
    else if (key === 'espn') {
      if (!Array.isArray(data) || !data.length) return;
      const live = data.filter(g => g.state === 'in');
      const final = data.filter(g => g.state === 'post');
      const upcoming = data.filter(g => g.state === 'pre');
      let s = '[ESPN LIVE SCORES]\n';
      if (live.length) s += 'LIVE: ' + live.map(g => `${g.league} ${g.away} ${g.awayScore}-${g.homeScore} ${g.home} (${g.status})`).join(' | ') + '\n';
      if (final.length) s += 'FINAL: ' + final.slice(0, 6).map(g => `${g.league} ${g.away} ${g.awayScore}-${g.homeScore} ${g.home}`).join(' | ') + '\n';
      if (upcoming.length) s += 'UPCOMING: ' + upcoming.slice(0, 6).map(g => `${g.league} ${g.away}@${g.home} ${g.status}`).join(' | ');
      ctx.push(s);
    }
    else if (key === 'polymarket') {
      if (!Array.isArray(data) || !data.length) return;
      let s = '[POLYMARKET TRENDING]\n';
      data.slice(0, 6).forEach(m => {
        const pct = m.price ? Math.round(parseFloat(m.price) * 100) : '?';
        s += `${m.question} — YES ${pct}% | $${Math.round(m.volume24h)} 24h vol\n`;
      });
      ctx.push(s);
    }
    else if (key === 'kalshi') {
      if (!Array.isArray(data) || !data.length) return;
      let s = '[KALSHI MARKETS]\n';
      data.slice(0, 6).forEach(m => {
        const pct = m.yesPrice ? Math.round(m.yesPrice * 100) : '?';
        s += `${m.title} — YES ${pct}%\n`;
      });
      ctx.push(s);
    }
  });

  return ctx.join('\n\n');
}

// ── Call xAI Grok API ──
async function callGrok(systemPrompt, messages, options = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');

  const reqBody = {
    model: options.model || 'grok-3-mini',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 2048,
  };
  // Note: Grok search_parameters deprecated (410). Betty gets live data from our own APIs instead.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 20000);
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Grok API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Call Anthropic Claude API ──
async function callClaude(systemPrompt, messagesOrString, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const messages = typeof messagesOrString === 'string'
    ? [{ role: 'user', content: messagesOrString }]
    : messagesOrString;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: options.model || 'claude-haiku-4-5-20251001',
        max_tokens: options.maxTokens || 2048,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Agent verification prompts ──
const GROK_VERIFY = `You are a sports betting verification agent specializing in REAL-TIME intelligence from X/Twitter. Verify the pick by checking: line movement, X sentiment, breaking injury/lineup news, situational factors. Respond JSON only: { "verdict": "agree"|"disagree"|"caution", "confidence": 0-100, "analysis": "2-3 sentences" }`;
const CLAUDE_VERIFY = `You are a sports betting verification agent specializing in STATISTICAL ANALYSIS. Verify the pick by checking: EV calculation, historical patterns, model edge validation, rating tier accuracy. Respond JSON only: { "verdict": "agree"|"disagree"|"caution", "confidence": 0-100, "analysis": "2-3 sentences" }`;
const CHATGPT_VERIFY = `You are a sports betting verification agent specializing in MARKET CONSENSUS. Verify the pick by checking: public betting splits, market movement, contrarian value, comparable situations. Respond JSON only: { "verdict": "agree"|"disagree"|"caution", "confidence": 0-100, "analysis": "2-3 sentences" }`;

async function callChatGPT(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        temperature: 0.5,
        max_tokens: options.maxTokens || 1024,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`ChatGPT API ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function parseAgentResponse(raw, name) {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      return { verdict: p.verdict || 'caution', confidence: Math.min(100, Math.max(0, parseInt(p.confidence) || 50)), analysis: p.analysis || 'No analysis.' };
    }
  } catch (_) {}
  return { verdict: 'caution', confidence: 50, analysis: raw?.slice(0, 200) || `${name} unavailable.` };
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { messages, sources, action, search } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'messages[] required' }) };
    }

    // Default sources if not specified
    const enabledSources = sources || ['picks', 'results', 'ratings', 'guardian', 'markets', 'p2p', 'espn', 'polymarket', 'kalshi'];

    // Build live context from all enabled data sources
    const liveContext = await buildContext(enabledSources);
    const fullSystemPrompt = BETTY_CORE + '\n\n--- LIVE DATA ---' + liveContext;

    const lastMsg = (messages[messages.length - 1]?.content || '').toLowerCase().trim();

    // ── Picks card payload — homepage Try WeBet / chips / "today's picks" ──
    const wantsPicks = action === 'picks'
      || lastMsg.startsWith('/picks')
      || lastMsg === 'picks'
      || /show (me )?(today'?s |the )?(picks|card|plays|bets)/i.test(lastMsg)
      || /today'?s (edge )?(picks|card|plays)/i.test(lastMsg)
      || /best (sportsbook )?picks/i.test(lastMsg)
      || /give me (today'?s |the )?(daily )?(picks|digest|card)/i.test(lastMsg)
      || /what('?s| are) (today|the|tonight).*(pick|play|bet)/i.test(lastMsg)
      || /sportsbook picks tonight/i.test(lastMsg)
      || /edge picks/i.test(lastMsg);

    if (wantsPicks) {
      const picksData = await fetchEdgePicks();
      const picks = picksData?.picks || [];
      const dateLabel = picksData?.dateFormatted || picksData?.date || 'today';
      let intro;
      if (!picks.length) {
        intro = "Today's card hasn't dropped yet — it lands around 9am ET. Ask me anything while we wait.";
      } else {
        const sports = [...new Set(picks.map(p => p.sport).filter(Boolean))].join(' / ');
        intro = `Here's today's WeBetAI card (${dateLabel}${sports ? ', ' + sports : ''}). ${picks.length} play${picks.length === 1 ? '' : 's'}. Ask me about any of them — why it made the card, what loses, or send one to a friend.`;
      }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ type: 'picks', content: intro, picks, date: picksData?.date || null, dateFormatted: dateLabel }),
      };
    }

    // ── Verify action ──
    if (action === 'verify' || /verify|check with.*agents?|what do.*agents? think/i.test(lastMsg)) {
      const picksData = enabledSources.includes('picks') ? await fetchEdgePicks() : null;
      const picks = picksData?.picks || [];
      const pickMatch = lastMsg.match(/(\d+)/);
      const pickIdx = pickMatch ? parseInt(pickMatch[1]) - 1 : 0;
      const pick = picks[pickIdx] || picks[0];

      if (!pick) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ type: 'chat', content: 'No picks to verify right now. Picks drop at 10am EST.' }) };
      }

      const desc = `PICK: ${pick.sport} — ${pick.matchup}\nPick: ${pick.pick} | ${pick.betType} | Odds: ${pick.odds}\nRating: ${pick.rating} | Units: ${pick.units} | Win Prob: ${pick.winProbability}\nReasoning: ${pick.coreReasoning}\nRisk: ${pick.whatLoses}\nEdge: ${pick.modelEdge}`;

      const [g, c, o] = await Promise.allSettled([
        callGrok(GROK_VERIFY, [{ role: 'user', content: desc }], { model: 'grok-3', timeout: 12000 }),
        callClaude(CLAUDE_VERIFY, desc, { timeout: 12000 }),
        callChatGPT(CHATGPT_VERIFY, desc, { timeout: 12000 }),
      ]);

      const agents = {
        grok: parseAgentResponse(g.status === 'fulfilled' ? g.value : '', 'Grok'),
        claude: parseAgentResponse(c.status === 'fulfilled' ? c.value : '', 'Claude'),
        chatgpt: parseAgentResponse(o.status === 'fulfilled' ? o.value : '', 'ChatGPT'),
      };

      const verdicts = Object.values(agents).map(a => a.verdict);
      const agreeCount = verdicts.filter(v => v === 'agree').length;
      const avgConf = Math.round(Object.values(agents).reduce((s, a) => s + a.confidence, 0) / 3);

      // Betty synthesis
      const synthPrompt = fullSystemPrompt +
        `\n\nVerification results for ${pick.matchup} — ${pick.pick}:\n` +
        `Grok: ${agents.grok.verdict} (${agents.grok.confidence}%) — ${agents.grok.analysis}\n` +
        `Claude: ${agents.claude.verdict} (${agents.claude.confidence}%) — ${agents.claude.analysis}\n` +
        `ChatGPT: ${agents.chatgpt.verdict} (${agents.chatgpt.confidence}%) — ${agents.chatgpt.analysis}\n` +
        `${agreeCount}/3 agree, avg ${avgConf}%. Give your synthesized take in 2-3 sentences.`;

      const synthesis = await callClaude(synthPrompt, `Verdict on ${pick.pick}?`);

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ type: 'verification', pick, pickIndex: pickIdx, agents, agreeCount, avgConfidence: avgConf, synthesis }),
      };
    }

    // ── General chat with full context ──
    const content = await callClaude(fullSystemPrompt, messages, { maxTokens: 2048 });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ type: 'chat', content }),
    };

  } catch (err) {
    console.error('[betty-beta] Error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Betty failed' }) };
  }
};
