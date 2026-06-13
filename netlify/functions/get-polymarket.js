/**
 * get-polymarket.js — Daily Prediction Market Picks
 *
 * Pulls from BOTH Polymarket and Kalshi APIs.
 * Focuses on markets CLOSING TODAY for maximum time-value opportunity.
 * Falls back to closing this week if not enough today-only markets qualify.
 *
 * Profitability-first: ranked by Expected Value, filtered 15-85¢.
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ═══════════════════════════════════════════════
// TIMESTAMPS
// ═══════════════════════════════════════════════

function getTodayRange() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
  // Also get end-of-week for fallback
  const endOfWeek = new Date(startOfDay.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    startTs: Math.floor(startOfDay.getTime() / 1000),
    endTs: Math.floor(endOfDay.getTime() / 1000),
    endWeekTs: Math.floor(endOfWeek.getTime() / 1000),
    now,
  };
}

// ═══════════════════════════════════════════════
// CATEGORY DETECTION
// ═══════════════════════════════════════════════

function classifyCategory(text) {
  const q = (text || '').toLowerCase();
  if (/trump|biden|election|president|congress|senate|governor|vote|democrat|republican|gop|legislation|immigration|tariff|executive order|cabinet|scotus|political|primary|impeach/.test(q)) return 'Politics';
  if (/bitcoin|btc|ethereum|eth\b|crypto|token|defi|blockchain|solana|sol\b|dogecoin|xrp|binance|coinbase/.test(q)) return 'Crypto';
  if (/nba|nfl|mlb|nhl|soccer|football|basketball|tennis|ufc|fight|championship|super bowl|world cup|olympics|f1\b|grand prix|mvp|playoff|lakers|celtics|warriors|yankees|spread:|o\/u\s|over\/under|moneyline|puck line|raptors|rockets|bulls|jazz|heat|spurs|nuggets|pistons|hawks|cavaliers|pacers|knicks|nets|magic|sixers|bucks|hornets|wizards|pelicans|grizzlies|timberwolves|thunder|blazers|kings|suns|clippers|mavericks|astros|dodgers|padres|braves|cubs|cardinals|phillies|mets|red sox|patriots|chiefs|eagles|cowboys|49ers|ravens|bills|lions|bears|packers|steelers|bengals|dolphins|saints|falcons|titans|colts|jaguars|texans|broncos|raiders|chargers|seahawks|rams|commanders|panthers|vikings|giants|jets|browns/.test(q)) return 'Sports';
  if (/ai\b|climate|space|nasa|pandemic|virus|vaccine|science|research|fda|disease|openai|gpt|llm|anthropic|weather|temperature|hurricane/.test(q)) return 'Tech/Science';
  if (/stock|fed\b|interest rate|gdp|recession|ceo|ipo|earnings|revenue|acquisition|merger|tesla|apple|google|meta\b|amazon|inflation|oil|crude|gold|s&p|nasdaq|dow/.test(q)) return 'Markets';
  if (/oscars|grammy|emmy|movie|film|music|celebrity|youtube|netflix|award|tiktok/.test(q)) return 'Culture';
  return 'Other';
}

// ═══════════════════════════════════════════════
// POLYMARKET FETCH
// ═══════════════════════════════════════════════

async function fetchPolymarkets(endDateMin, endDateMax) {
  try {
    // Fetch markets closing within our window
    const minDate = new Date(endDateMin * 1000).toISOString();
    const maxDate = new Date(endDateMax * 1000).toISOString();

    const [byVolume, byCompetitive] = await Promise.all([
      fetch(`${GAMMA_API}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false&end_date_min=${minDate}&end_date_max=${maxDate}`).then(r => r.ok ? r.json() : []),
      fetch(`${GAMMA_API}/markets?closed=false&active=true&limit=100&order=competitive&ascending=false&end_date_min=${minDate}&end_date_max=${maxDate}`).then(r => r.ok ? r.json() : []),
    ]);

    // Deduplicate
    const seen = new Set();
    const markets = [];
    for (const m of [...byVolume, ...byCompetitive]) {
      if (!seen.has(m.id)) { seen.add(m.id); markets.push(m); }
    }

    // Enrich with spread data
    await Promise.all(markets.slice(0, 30).map(async (m) => {
      try {
        if (!m.clobTokenIds) return;
        const ids = JSON.parse(m.clobTokenIds);
        if (ids?.[0]) {
          const r = await fetch(`${CLOB_API}/spread?token_id=${ids[0]}`);
          if (r.ok) { const d = await r.json(); if (d.spread) m.spread = d.spread; }
        }
      } catch {}
    }));

    // Normalize to common format
    return markets.map(m => {
      const outcomePrices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      const outcomes = m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'];
      return {
        source: 'Polymarket',
        id: 'poly-' + m.id,
        question: m.question || m.groupItemTitle || '',
        slug: m.slug,
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
        yesPrice: parseFloat(outcomePrices[0]) || 0.5,
        noPrice: parseFloat(outcomePrices[1]) || 0.5,
        outcomes,
        volume24h: parseFloat(m.volume24hr) || 0,
        totalVolume: parseFloat(m.volumeNum) || 0,
        liquidity: parseFloat(m.liquidityNum) || 0,
        spread: parseFloat(m.spread) || 0,
        change1d: parseFloat(m.oneDayPriceChange) || 0,
        change1w: parseFloat(m.oneWeekPriceChange) || 0,
        endDate: m.endDate || m.endDateIso,
        category: classifyCategory(m.question || m.groupItemTitle || ''),
      };
    });
  } catch (err) {
    console.warn('Polymarket fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// KALSHI FETCH
// ═══════════════════════════════════════════════

async function fetchKalshiMarkets(minCloseTs, maxCloseTs) {
  try {
    const url = `${KALSHI_API}/markets?status=open&min_close_ts=${minCloseTs}&max_close_ts=${maxCloseTs}&limit=200`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('Kalshi API returned', resp.status);
      return [];
    }
    const data = await resp.json();
    const markets = data.markets || [];

    return markets.map(m => {
      const yesBid = m.yes_bid_dollars || m.yes_bid || 0;
      const yesAsk = m.yes_ask_dollars || m.yes_ask || 0;
      const noBid = m.no_bid_dollars || m.no_bid || 0;
      const noAsk = m.no_ask_dollars || m.no_ask || 0;
      const lastPrice = m.last_price_dollars || m.last_price || 0;
      const prevPrice = m.previous_price_dollars || m.previous_price || 0;

      // Use midpoint for pricing, or last trade
      const yesPrice = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : lastPrice || 0.5;
      const noPrice = 1 - yesPrice;
      const spread = yesAsk > 0 && yesBid > 0 ? yesAsk - yesBid : 0;
      const change1d = prevPrice > 0 ? (lastPrice - prevPrice) : 0;

      return {
        source: 'Kalshi',
        id: 'kalshi-' + (m.ticker || m.id),
        question: m.title || m.subtitle || '',
        slug: m.ticker,
        url: m.ticker ? `https://kalshi.com/markets/${m.event_ticker}/${m.ticker}` : null,
        yesPrice,
        noPrice,
        outcomes: ['Yes', 'No'],
        volume24h: parseFloat(m.volume_24h_fp || m.volume_24h) || 0,
        totalVolume: parseFloat(m.volume_fp || m.volume) || 0,
        liquidity: parseFloat(m.liquidity_dollars || m.liquidity) || 0,
        spread,
        change1d,
        change1w: 0,
        endDate: m.close_time || m.expiration_time,
        category: classifyCategory(m.title || m.subtitle || ''),
      };
    });
  } catch (err) {
    console.warn('Kalshi fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════
// EV SCORING (same profitability formula)
// ═══════════════════════════════════════════════

function scoreMarket(m) {
  const { yesPrice, noPrice, volume24h, liquidity, change1d, change1w, spread, category } = m;

  // Hard filters — profitable range only
  if (category === 'Sports') return null;  // Sports excluded — use /edge for sports
  const minPrice = Math.min(yesPrice, noPrice);
  if (minPrice < 0.15 || minPrice > 0.85) return null;
  if (volume24h < 5000) return null;
  if (liquidity < 2000 && m.source === 'Polymarket') return null;

  const endDate = m.endDate;
  const daysOut = endDate ? Math.max((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24), 0) : 999;
  if (daysOut > 8) return null; // Only this week max

  // ── Pick side ──
  let side, cost, marketProb;
  if (Math.abs(change1d) > 0.01) {
    if (change1d > 0) { side = 'YES'; cost = yesPrice; marketProb = yesPrice; }
    else { side = 'NO'; cost = noPrice; marketProb = noPrice; }
  } else {
    // No momentum — pick the underdog (better payout)
    if (yesPrice <= 0.5) { side = 'YES'; cost = yesPrice; marketProb = yesPrice; }
    else { side = 'NO'; cost = noPrice; marketProb = noPrice; }
  }

  // ── Edge adjustment ──
  let edgeAdj = 0;
  const reasons = [];

  // Momentum
  const momentumAligned = (side === 'YES' && change1d > 0) || (side === 'NO' && change1d < 0);
  if (momentumAligned && Math.abs(change1d) > 0.05) {
    edgeAdj += 0.04; reasons.push(`Strong momentum (${(change1d * 100).toFixed(1)}% 1d)`);
  } else if (momentumAligned && Math.abs(change1d) > 0.02) {
    edgeAdj += 0.02; reasons.push(`Momentum building (${(change1d * 100).toFixed(1)}% 1d)`);
  }
  if (change1d !== 0 && change1w !== 0 && Math.sign(change1d) === Math.sign(change1w)) {
    edgeAdj += 0.01; reasons.push('Daily + weekly trends aligned');
  }

  // Volume conviction
  const volLiqRatio = volume24h / Math.max(liquidity, 1);
  if (volLiqRatio > 5) { edgeAdj += 0.03; reasons.push(`Volume spike (${volLiqRatio.toFixed(1)}x liquidity)`); }
  else if (volLiqRatio > 2) { edgeAdj += 0.02; reasons.push(`Active trading (${volLiqRatio.toFixed(1)}x liquidity)`); }
  else if (volLiqRatio > 1) { edgeAdj += 0.01; }

  // Calibration bias
  if (category === 'Politics' && (marketProb > 0.60 || marketProb < 0.40)) {
    edgeAdj += 0.02; reasons.push('Political markets historically underconfident');
  }
  if (category === 'Sports' && marketProb > 0.55) {
    edgeAdj += 0.01; reasons.push('Sports favorites slightly underpriced');
  }

  // Spread inefficiency
  if (spread > 0.04) { edgeAdj += 0.02; reasons.push(`Wide spread (${(spread * 100).toFixed(1)}%)`); }
  else if (spread > 0.02) { edgeAdj += 0.01; }

  // Closing today bonus
  if (daysOut < 1) {
    edgeAdj += 0.03; reasons.push('Closes today — maximum time value');
  } else if (daysOut <= 2) {
    edgeAdj += 0.02; reasons.push(`Closes in ${Math.round(daysOut)} day${daysOut > 1 ? 's' : ''}`);
  } else {
    reasons.push(`${Math.round(daysOut)} days to close`);
  }

  // ── EV ──
  const trueProb = Math.min(marketProb + edgeAdj, 0.95);
  const ev = trueProb - cost;
  if (ev <= 0) return null;

  const roi = ev / cost;
  const payout = 1 - cost;

  // Rank: EV × volume confidence × closing urgency
  const volumeConf = Math.min(Math.sqrt(volume24h) / 80, 3);
  const urgency = daysOut < 1 ? 2.0 : daysOut <= 2 ? 1.5 : daysOut <= 4 ? 1.2 : 1.0;
  const rankScore = ev * volumeConf * urgency * 1000;

  // Confidence + unit sizing (mirrors edge: A+=2u, A=1.5u, B+=1u, B=0.5u)
  let confidence, confidenceLabel, units;
  if (ev >= 0.08 && roi >= 0.15) { confidence = 'aplus'; confidenceLabel = 'A+'; units = 2.0; }
  else if (ev >= 0.05 && roi >= 0.10) { confidence = 'a'; confidenceLabel = 'A'; units = 1.5; }
  else if (ev >= 0.03 && roi >= 0.06) { confidence = 'bplus'; confidenceLabel = 'B+'; units = 1.0; }
  else { confidence = 'b'; confidenceLabel = 'B'; units = 0.5; }

  // Dollar amounts ($150/unit, same as edge picks)
  const dollarPerUnit = 150;
  const risk = units * dollarPerUnit;
  const shares = Math.floor(risk / cost);  // how many shares at this price
  const toWin = shares * payout;           // profit if correct

  const analysis = reasons.slice(0, 3).join('. ') + (reasons.length > 0 ? '.' : '');

  return {
    source: m.source,
    id: m.id,
    question: m.question,
    url: m.url,
    category: m.category,
    side,
    cost: Math.round(cost * 100),
    payout: Math.round(payout * 100),
    marketProb: Math.round(marketProb * 100),
    trueProb: Math.round(trueProb * 100),
    edge: Math.round(edgeAdj * 100),
    ev: Math.round(ev * 10000) / 100,
    roi: Math.round(roi * 1000) / 10,
    impliedOdds: '+' + (cost > 0 ? Math.round((1 / cost - 1) * 100) : 0),
    volume24h,
    liquidity,
    daysOut: Math.round(daysOut * 10) / 10,
    closesToday: daysOut < 1,
    confidence,
    confidenceLabel,
    units,
    risk,
    shares,
    toWin: Math.round(toWin),
    rankScore,
    analysis,
    outcomes: m.outcomes,
  };
}

// ═══════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    const { startTs, endTs, endWeekTs } = getTodayRange();

    // Fetch from both platforms in parallel
    // First try: markets closing today
    // Fallback: markets closing this week
    const [polyToday, kalshiToday, polyWeek, kalshiWeek] = await Promise.all([
      fetchPolymarkets(startTs, endTs),
      fetchKalshiMarkets(startTs, endTs),
      fetchPolymarkets(endTs, endWeekTs),
      fetchKalshiMarkets(endTs, endWeekTs),
    ]);

    const todayMarkets = [...polyToday, ...kalshiToday];
    const weekMarkets = [...polyWeek, ...kalshiWeek];

    // Score today's markets
    const todayScored = todayMarkets.map(scoreMarket).filter(Boolean);
    todayScored.sort((a, b) => b.rankScore - a.rankScore);

    // Score week markets as fallback
    const weekScored = weekMarkets.map(scoreMarket).filter(Boolean);
    weekScored.sort((a, b) => b.rankScore - a.rankScore);

    // Build picks: prefer today, fill with week if needed
    let picks = todayScored.slice(0, 5);
    if (picks.length < 5) {
      const weekFill = weekScored.filter(w => !picks.some(p => p.id === w.id));
      picks = [...picks, ...weekFill].slice(0, 5);
    }

    const polyCount = polyToday.length + polyWeek.length;
    const kalshiCount = kalshiToday.length + kalshiWeek.length;
    const totalScanned = polyCount + kalshiCount;
    const totalQualified = todayScored.length + weekScored.length;
    const closingToday = todayScored.length;
    const totalVol = [...todayScored, ...weekScored].reduce((s, m) => s + (parseFloat(m.volume24h) || 0), 0);

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        generated: new Date().toISOString(),
        dateFormatted: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
        summary: {
          marketsScanned: totalScanned,
          polymarketCount: polyCount,
          kalshiCount,
          marketsQualified: totalQualified,
          closingToday,
          totalVolume24h: totalVol,
        },
        picks,
      }),
    };
  } catch (err) {
    console.error('Predictions API error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Failed to fetch prediction data', detail: err.message }),
    };
  }
};
