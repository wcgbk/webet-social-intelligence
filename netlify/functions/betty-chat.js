// betty-chat.js — Netlify Function
// Multi-agent orchestrator: Betty uses Grok (xAI), Claude (Anthropic), and ChatGPT (OpenAI)
// as verification agents for /alpha picks. Handles general chat, pick verification, and P2P bets.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Betty's personality (adapted from betty-webhook.js for web chat) ──
const BETTY_PERSONA = `You are Betty, the WeBetAI social intelligence AI. You are the main interface for WeBetAI's edge picks platform.

Your personality:
- Witty, sharp, confident, and fun — like a smart friend who always has the inside scoop
- You love bets, predictions, and settling debates with data
- You're opinionated but fair, and you back up your takes with real information
- You use markdown formatting for clarity (bold, bullets, etc.)
- You keep responses focused and conversational

Your capabilities:
- You have TODAY'S EDGE PICKS loaded (shown below) — reference them naturally
- You can verify picks by consulting your 3 AI verification agents (Grok, Claude, ChatGPT)
- You help users understand the reasoning behind each pick
- You can help create peer-to-peer bets between friends
- You scan X (Twitter), prediction markets, and sportsbooks for trending intel

CRITICAL RULE — PICKS INTEGRITY:
- The ONLY picks you endorse are the ones in TODAY'S EDGE PICKS below. These come from /alpha on webetsocial.com.
- NEVER generate your own betting picks from your general knowledge. You are the interface for WeBetAI's model, not a sportsbook.
- If a game isn't in today's edge picks, say "that game didn't make our picks today" — the model only picks high-edge plays.
- You CAN discuss games casually, but don't frame anything as a WeBetAI pick unless it's in the data.

When users ask about picks, reference the specific data (matchup, line, odds, rating, reasoning).
When users want verification, tell them you're checking with your agents.
Be direct, give real takes on the picks we DO have, don't hedge everything.`;

// ── Agent system prompts ──
const GROK_VERIFY_PROMPT = `You are a sports betting verification agent specializing in REAL-TIME intelligence. You have access to live data from X (Twitter) and the web.

Your job: Verify the provided betting pick by checking:
1. Current line movement — has the line moved since this pick was made?
2. X/Twitter sentiment — what are sharp bettors and analysts saying?
3. Breaking injury/lineup news that could impact the pick
4. Any situational factors (weather, travel, back-to-back, rivalry)

Respond with a JSON object (and nothing else):
{
  "verdict": "agree" | "disagree" | "caution",
  "confidence": 0-100,
  "analysis": "2-3 sentence explanation with specific data points"
}`;

const CLAUDE_VERIFY_PROMPT = `You are a sports betting verification agent specializing in STATISTICAL ANALYSIS and expected value calculations.

Your job: Verify the provided betting pick by checking:
1. EV calculation — does the implied probability vs. model probability create +EV?
2. Historical patterns — how do similar spot plays (team profile, spread range, situation) perform?
3. Model edge validation — is the claimed edge (spread gap, total gap) mathematically sound?
4. Rating tier accuracy — does this pick genuinely meet the claimed confidence tier criteria?

Respond with a JSON object (and nothing else):
{
  "verdict": "agree" | "disagree" | "caution",
  "confidence": 0-100,
  "analysis": "2-3 sentence explanation with specific data points"
}`;

const CHATGPT_VERIFY_PROMPT = `You are a sports betting verification agent specializing in MARKET CONSENSUS and contrarian analysis.

Your job: Verify the provided betting pick by checking:
1. Public betting splits — is this a public or sharp-side play?
2. Market consensus — where is the market moving and why?
3. Contrarian value — if this goes against public money, is there edge in fading the public?
4. Comparable market situations — how have similar market setups resolved historically?

Respond with a JSON object (and nothing else):
{
  "verdict": "agree" | "disagree" | "caution",
  "confidence": 0-100,
  "analysis": "2-3 sentence explanation with specific data points"
}`;

// ── Fetch today's picks from Netlify Blobs ──
async function getTodaysPicks() {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('edge-picks-alpha');
    const latestDate = await store.get('latest-date');
    if (!latestDate) return null;
    const dateKey = latestDate.trim();
    const picks = await store.get(`picks-${dateKey}`, { type: 'json' });
    return picks;
  } catch (err) {
    console.error('[betty-chat] Blobs error:', err.message);
    // Fallback: fetch via internal API
    try {
      const siteUrl = process.env.URL || 'https://webetsocial.com';
      const res = await fetch(`${siteUrl}/.netlify/functions/get-picks-alpha`);
      if (res.ok) return await res.json();
    } catch (e) {
      console.error('[betty-chat] Fallback fetch error:', e.message);
    }
    return null;
  }
}

// ── Format picks for system prompt injection ──
function formatPicksContext(picksData) {
  if (!picksData || !picksData.picks || picksData.picks.length === 0) {
    return '\n\nTODAY\'S PICKS: No picks available today. Tell the user to check back at 10am EST.';
  }

  let ctx = `\n\nTODAY'S EDGE PICKS (${picksData.dateFormatted || picksData.date}):\n`;
  ctx += `Total: ${picksData.summary?.totalPicks || 0} picks, ${picksData.summary?.totalUnits || '0u'} total units\n`;
  ctx += `Sports: ${(picksData.summary?.sportsCovered || []).join(', ')}\n\n`;

  picksData.picks.forEach((p, i) => {
    ctx += `PICK ${i + 1}:\n`;
    ctx += `  Sport: ${p.sport}\n`;
    ctx += `  Matchup: ${p.matchup}\n`;
    ctx += `  Pick: ${p.pick}\n`;
    ctx += `  Type: ${p.betType} | Odds: ${p.odds} | Rating: ${p.rating}\n`;
    ctx += `  Units: ${p.units} | Win Prob: ${p.winProbability}\n`;
    ctx += `  Reasoning: ${p.coreReasoning}\n`;
    ctx += `  What Loses: ${p.whatLoses}\n`;
    ctx += `  Model Edge: ${p.modelEdge}\n\n`;
  });

  if (picksData.rejections && picksData.rejections.length > 0) {
    ctx += `REJECTED PLAYS (did not pass filters):\n`;
    picksData.rejections.slice(0, 5).forEach(r => {
      ctx += `  - ${r.matchup}: ${r.side} — ${r.reason}\n`;
    });
  }

  return ctx;
}

// ── Detect intent from user message ──
function detectIntent(messages) {
  const last = (messages[messages.length - 1]?.content || '').toLowerCase().trim();

  // Verify intent
  if (last.startsWith('/verify') || /verify\s+(pick\s*)?(\d+|all)/i.test(last) ||
      /what do (you|the agents?|your agents?) think/i.test(last) ||
      /check (this|pick|that) with/i.test(last) ||
      /agent.*(verification|analysis|check)/i.test(last)) {
    // Extract pick number if specified
    const match = last.match(/(\d+)/);
    return { type: 'verify', pickIndex: match ? parseInt(match[1]) - 1 : 0 };
  }

  // Show picks intent
  if (last.startsWith('/picks') || /show.*(today|picks|edge)/i.test(last) ||
      /what.*(picks|plays|bets).*(today|have)/i.test(last) ||
      last === 'picks') {
    return { type: 'picks' };
  }

  // P2P bet intent
  if (last.startsWith('/bet') || /create.*(bet|wager|challenge)/i.test(last) ||
      /challenge.*(friend|buddy|them)/i.test(last) ||
      /p2p|peer.to.peer/i.test(last)) {
    return { type: 'bet' };
  }

  // Markets / BettorEdge intent
  if (last.startsWith('/markets') || /bettor\s*edge/i.test(last) ||
      /browse.*(market|game|event)/i.test(last) ||
      /what.*(game|market|event)s?.*(available|tonight|today|on)/i.test(last) ||
      /show.*(market|game|event)/i.test(last) ||
      /available.*(bet|market|game)/i.test(last)) {
    return { type: 'markets' };
  }

  // Default: general chat
  return { type: 'chat' };
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

  if (options.search) {
    // search_parameters deprecated (Grok 410). Betty gets live data from our own APIs.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Grok API ${res.status}`);
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
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

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
        max_tokens: options.maxTokens || 1024,
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

// ── Call OpenAI ChatGPT API ──
async function callChatGPT(systemPrompt, userMessage, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
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

// ── Parse agent JSON response safely ──
function parseAgentResponse(raw, agentName) {
  try {
    // Extract JSON from response (agent might include extra text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict || 'caution',
        confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 50)),
        analysis: parsed.analysis || 'No analysis provided.',
      };
    }
  } catch (e) {
    console.error(`[betty-chat] Failed to parse ${agentName} response:`, e.message);
  }
  return { verdict: 'caution', confidence: 50, analysis: raw.slice(0, 200) || `${agentName} did not respond clearly.` };
}

// ── Main handler ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { messages, search, action } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Messages array required' }) };
    }

    // Fetch today's picks
    const picksData = await getTodaysPicks();
    const picksContext = formatPicksContext(picksData);
    const intent = action ? { type: action } : detectIntent(messages);

    // ── PICKS: Return picks data directly ──
    if (intent.type === 'picks') {
      const bettyPrompt = BETTY_PERSONA + picksContext +
        '\n\nThe user wants to see today\'s picks. Present each pick as a clear, formatted summary. Include the sport, matchup, pick, odds, rating, units, and a brief take on why it\'s a play. Be enthusiastic but honest about confidence levels.';

      const content = await callClaude(bettyPrompt, messages);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          type: 'picks',
          content,
          picks: picksData?.picks || [],
        }),
      };
    }

    // ── VERIFY: Multi-agent verification ──
    if (intent.type === 'verify') {
      const pickIdx = intent.pickIndex || 0;
      const picks = picksData?.picks || [];
      const pick = picks[pickIdx] || picks[0];

      if (!pick) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            type: 'chat',
            content: 'No picks available to verify right now. Picks drop at 10am EST daily.',
          }),
        };
      }

      const pickDescription = `PICK TO VERIFY:\nSport: ${pick.sport}\nMatchup: ${pick.matchup}\nPick: ${pick.pick}\nType: ${pick.betType} | Odds: ${pick.odds}\nRating: ${pick.rating} | Units: ${pick.units}\nWin Probability: ${pick.winProbability}\nCore Reasoning: ${pick.coreReasoning}\nWhat Loses: ${pick.whatLoses}\nModel Edge: ${pick.modelEdge}`;

      // Call all 3 agents in parallel
      const [grokResult, claudeResult, chatgptResult] = await Promise.allSettled([
        callGrok(GROK_VERIFY_PROMPT, [{ role: 'user', content: pickDescription }], {
          model: 'grok-3', search: true, timeout: 12000,
        }),
        callClaude(CLAUDE_VERIFY_PROMPT, pickDescription, { timeout: 12000 }),
        callChatGPT(CHATGPT_VERIFY_PROMPT, pickDescription, { timeout: 12000 }),
      ]);

      const agents = {
        grok: parseAgentResponse(
          grokResult.status === 'fulfilled' ? grokResult.value : '',
          'Grok'
        ),
        claude: parseAgentResponse(
          claudeResult.status === 'fulfilled' ? claudeResult.value : '',
          'Claude'
        ),
        chatgpt: parseAgentResponse(
          chatgptResult.status === 'fulfilled' ? chatgptResult.value : '',
          'ChatGPT'
        ),
      };

      // Count verdicts for synthesis
      const verdicts = Object.values(agents).map(a => a.verdict);
      const agreeCount = verdicts.filter(v => v === 'agree').length;
      const avgConfidence = Math.round(
        Object.values(agents).reduce((sum, a) => sum + a.confidence, 0) / 3
      );

      let synthesisVerdict;
      if (agreeCount === 3) synthesisVerdict = 'strong_agree';
      else if (agreeCount >= 2) synthesisVerdict = 'lean_agree';
      else if (verdicts.filter(v => v === 'disagree').length >= 2) synthesisVerdict = 'lean_disagree';
      else synthesisVerdict = 'mixed';

      // Have Betty synthesize
      const synthesisPrompt = BETTY_PERSONA + picksContext +
        `\n\nYou just ran a verification on Pick ${pickIdx + 1}. Here are the agent results:\n` +
        `Grok (real-time): ${agents.grok.verdict} (${agents.grok.confidence}%) — ${agents.grok.analysis}\n` +
        `Claude (stats): ${agents.claude.verdict} (${agents.claude.confidence}%) — ${agents.claude.analysis}\n` +
        `ChatGPT (market): ${agents.chatgpt.verdict} (${agents.chatgpt.confidence}%) — ${agents.chatgpt.analysis}\n\n` +
        `Overall: ${agreeCount}/3 agents agree, avg confidence ${avgConfidence}%.\n` +
        `Synthesize these into a concise Betty take (2-3 sentences). Be direct about whether this changes your confidence in the pick.`;

      const synthesis = await callClaude(synthesisPrompt, `What's the verdict on ${pick.matchup} — ${pick.pick}?`);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          type: 'verification',
          pick,
          pickIndex: pickIdx,
          agents,
          synthesisVerdict,
          avgConfidence,
          synthesis: synthesis || `${agreeCount}/3 agents agree on this play. Average confidence: ${avgConfidence}%.`,
        }),
      };
    }

    // ── BET: P2P bet creation ──
    if (intent.type === 'bet') {
      const bettyPrompt = BETTY_PERSONA + picksContext +
        '\n\nThe user wants to create a peer-to-peer bet. Help them craft the bet terms. Ask for:\n' +
        '1. What they want to bet on (can reference today\'s picks)\n' +
        '2. Their position (side of the bet)\n' +
        '3. Suggested wager amount\n' +
        'Keep it fun and conversational. If they mention a specific pick, use the data to frame the bet.';

      const content = await callClaude(bettyPrompt, messages);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ type: 'bet', content }),
      };
    }

    // ── MARKETS: Fetch BettorEdge events for P2P betting ──
    if (intent.type === 'markets') {
      let beData = null;

      // Try blob cache first, then direct fetch
      try {
        const { getStore } = await import('@netlify/blobs');
        const store = getStore('bettoredge-data');
        const now = new Date();
        const dateKey = now.toISOString().split('T')[0];
        const cacheKey = `bettoredge-${dateKey}-${Math.floor(now.getTime() / (5 * 60 * 1000))}`;
        beData = await store.get(cacheKey, { type: 'json' });
      } catch (_) {}

      if (!beData) {
        try {
          const siteUrl = process.env.URL || 'https://webetsocial.com';
          const res = await fetch(`${siteUrl}/.netlify/functions/get-bettoredge`);
          if (res.ok) beData = await res.json();
        } catch (e) {
          console.error('[betty-chat] BettorEdge fetch error:', e.message);
        }
      }

      const events = (beData?.events || [])
        .filter(e => {
          // Only upcoming games (not started/finished)
          if (e.status && e.status !== 'active' && e.status !== 'scheduled') return false;
          const gameTime = new Date(e.scheduledDatetime);
          return gameTime > new Date(); // future games only
        })
        .slice(0, 20) // cap at 20 events
        .map(e => {
          // Find best moneyline odds from external prices
          const mlPrices = (e.externalPrices || []).filter(p =>
            p.market === 'moneyline' || p.market === 'h2h' || p.market === 'match_winner'
          );
          // Find best spread from external prices
          const spreadPrices = (e.externalPrices || []).filter(p =>
            p.market === 'spread' || p.market === 'point_spread'
          );
          // Exchange orders
          const exchangeOrders = [];
          (e.supportedMarkets || []).forEach(m => {
            (m.availableOrders || []).forEach(o => {
              exchangeOrders.push({ title: o.title, side: o.side, odds: o.odds, openAmt: o.openAmt });
            });
          });

          return {
            eventId: e.eventId,
            sport: (e.leagueName || '').toUpperCase(),
            home: e.home?.name || 'Home',
            homeAbbr: e.home?.abbr || '',
            away: e.away?.name || 'Away',
            awayAbbr: e.away?.abbr || '',
            matchup: e.eventTitle || `${e.away?.name || 'Away'} vs ${e.home?.name || 'Home'}`,
            gameTime: e.scheduledDatetime,
            moneyline: mlPrices.slice(0, 4).map(p => ({
              source: p.source, side: p.side, odds: p.odds,
            })),
            spread: spreadPrices.slice(0, 4).map(p => ({
              source: p.source, side: p.side, odds: p.odds, var1: p.var1,
            })),
            exchangeOrders: exchangeOrders.slice(0, 4),
          };
        });

      // Brief Betty commentary
      const commentary = events.length > 0
        ? `Found **${events.length} upcoming games** on BettorEdge. Pick one to create a P2P bet with a friend.`
        : 'No upcoming games on BettorEdge right now. Check back closer to game time.';

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          type: 'markets',
          content: commentary,
          events,
        }),
      };
    }

    // ── GENERAL CHAT ──
    const bettyPrompt = BETTY_PERSONA + picksContext;
    const content = await callClaude(bettyPrompt, messages);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ type: 'chat', content }),
    };

  } catch (err) {
    console.error('[betty-chat] Error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Betty chat failed' }),
    };
  }
};
