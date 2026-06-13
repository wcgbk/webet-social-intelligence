// kalshi-execute-background.js
// Background function (15min timeout). Reads beta picks, matches to Kalshi markets, places orders.
// Stores execution log to "kalshi-executions" Netlify Blob store.

const crypto = require('crypto');
const { getKalshiPrivateKey } = require('./kalshi-key');

// Module-level key cache — loaded once per cold start, reused on warm invocations
let _kalshiPrivateKey = null;
async function initKalshiKey() {
  if (!_kalshiPrivateKey) {
    _kalshiPrivateKey = await getKalshiPrivateKey();
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const DOLLAR_PER_UNIT = 150; // $150 per unit
const MAX_DAILY_UNITS = 3; // 3u × $150 = $450 max daily risk
const MAX_DAILY_RISK = MAX_DAILY_UNITS * DOLLAR_PER_UNIT;

// ── Statistical helpers for Kalshi-specific edge calculation ──

// Standard normal CDF (Abramowitz & Stegun approximation, accurate to ~1e-7)
function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1 + sign * y);
}

// Standard deviation of outcomes by sport/market
// Derived from historical closing line margins
const OUTCOME_STDEV = {
  NBA_Spread: 11,    // NBA ATS outcomes cluster around ±11 pts
  NBA_Total: 11,     // NBA total scoring variance ~11 pts
  NHL_Spread: 1.7,   // NHL puck line variance ~1.7 goals
  NHL_Total: 1.7,    // NHL total goals variance ~1.7 goals
  MLB_Spread: 2.2,   // MLB run line variance ~2.2 runs
  MLB_Total: 2.2,    // MLB total runs variance ~2.2 runs
};

// Parse model projection from the modelEdge string
// Formats: "Model: -9.1, Line: -2.5, Edge: 6.6 pts"
//          "Model: 226.2, Line: 219.5, Edge: 6.7 pts"
//          "Model: 6.8, Line: 6, Edge: 0.8 goals"
function parseModelEdge(modelEdgeStr) {
  if (!modelEdgeStr) return null;
  const modelMatch = modelEdgeStr.match(/Model:\s*([-\d.]+)/);
  const lineMatch = modelEdgeStr.match(/Line:\s*([-\d.]+)/);
  if (!modelMatch || !lineMatch) return null;
  return {
    modelProjection: parseFloat(modelMatch[1]),
    originalLine: parseFloat(lineMatch[1]),
  };
}

// Calculate cover probability for a specific line given model projection
// For spreads: P(team margin > kalshiLine) given model projects "modelProjection"
// For totals over: P(total > kalshiLine) given model projects "modelProjection"
// For totals under: P(total < kalshiLine) given model projects "modelProjection"
function calcCoverProb(modelProjection, kalshiLine, stdev, direction) {
  // edge = how far the model projection is from the Kalshi line
  // For spreads (favorite -X): model = -9.1, kalshiLine = 3.5 → edge = 9.1 - 3.5 = 5.6
  // For over: model = 226.2, kalshiLine = 220.5 → edge = 226.2 - 220.5 = 5.7
  let edge;
  if (direction === 'over') {
    edge = modelProjection - kalshiLine;
  } else if (direction === 'under') {
    edge = kalshiLine - modelProjection;
  } else {
    // Spread: model is negative for favorite (e.g., -9.1 means fav by 9.1)
    // Kalshi line is positive (e.g., 3.5 means "win by more than 3.5")
    edge = Math.abs(modelProjection) - kalshiLine;
  }
  const z = edge / stdev;
  return normalCDF(z);
}

// ── Kalshi API helpers ──

function getBaseUrl() {
  return (process.env.KALSHI_ENV === 'production')
    ? 'https://api.elections.kalshi.com/trade-api/v2'
    : 'https://demo-api.kalshi.co/trade-api/v2';
}

function signRequest(timestamp, method, path) {
  const privateKeyPem = _kalshiPrivateKey;
  if (!privateKeyPem) throw new Error('Kalshi private key not loaded — initKalshiKey() must be awaited first');
  const message = `${timestamp}${method}${path}`;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return signature.toString('base64');
}

function kalshiHeaders(method, path) {
  const ts = Date.now().toString();
  // Signature must use full URL path including /trade-api/v2 prefix
  const signPath = `/trade-api/v2${path}`;
  return {
    'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signRequest(ts, method, signPath),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function kalshiFetch(method, path, body) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const opts = { method, headers: kalshiHeaders(method, path) };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// ── Sport/BetType → Kalshi series mapping ──

const SERIES_MAP = {
  'NBA_Spread': 'KXNBASPREAD',
  'NBA_Total': 'KXNBATOTAL',
  'NBA_Moneyline': 'KXNBAGAME',
  'NHL_Spread': 'KXNHLSPREAD',
  'NHL_Puck Line': 'KXNHLSPREAD',
  'NHL_Total': 'KXNHLTOTAL',
  'NHL_Moneyline': 'KXNHLGAME',
  'MLB_Spread': 'KXMLBSPREAD',
  'MLB_Run Line': 'KXMLBSPREAD',
  'MLB_Total': 'KXMLBTOTAL',
  'MLB_Moneyline': 'KXMLBGAME',
};

// ── Team name normalization ──

function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function getTeamWords(name) {
  const words = normalizeTeam(name).split(' ');
  // Return all words (city + team name) for broader matching
  // e.g. "Toronto Raptors" → ["toronto", "raptors"]
  // Filter short words that cause false positives (e.g. "red" in "scored")
  return words.filter(w => w.length >= 4);
}

function wordInText(word, text) {
  // Word boundary match to avoid "red" matching inside "scored"
  const re = new RegExp(`\\b${word}\\b`, 'i');
  return re.test(text);
}

function extractTeamsFromMatchup(matchup) {
  const parts = (matchup || '').split(/\s+(?:vs\.?|@|at|v)\s+/i).map(s => s.trim()).filter(Boolean);
  return parts;
}

// Kalshi uses non-standard abbreviations for some cities
// Map full city/team name → Kalshi ticker abbreviation
const KALSHI_ABBREV_MAP = {
  'brooklyn': 'bkn',
  'golden state': 'gs',
  'oklahoma city': 'okc',
  'new york': 'nyk',
  'new orleans': 'no',
  'san antonio': 'sa',
  'los angeles lakers': 'lal',
  'los angeles clippers': 'lac',
  'la lakers': 'lal',
  'la clippers': 'lac',
  'portland': 'por',
  'minnesota': 'min',
  'philadelphia': 'phi',
  'washington': 'wsh',
  'sacramento': 'sac',
  'indiana': 'ind',
  'tampa bay': 'tb',
  'st louis': 'stl',
  'st. louis': 'stl',
  'columbus': 'cbj',
  'new jersey': 'nj',
  'new york islanders': 'nyi',
  'new york rangers': 'nyr',
  'san jose': 'sj',
  'vegas': 'vgk',
  'las vegas': 'vgk',
  'utah': 'uta',
  'anaheim': 'ana',
  'arizona': 'ari',
  'colorado': 'col',
  'nashville': 'nsh',
  'winnipeg': 'wpg',
  'vancouver': 'van',
  'calgary': 'cgy',
  'edmonton': 'edm',
  'seattle': 'sea',
};

function getCityAbbrev(teamName) {
  const normalized = normalizeTeam(teamName);
  // Check multi-word city matches first (longest match wins)
  for (const [key, abbr] of Object.entries(KALSHI_ABBREV_MAP)) {
    if (normalized.startsWith(key) || normalized.includes(key)) return abbr;
  }
  // Fallback: first 3 letters of first word
  const firstWord = getTeamWords(teamName)[0] || '';
  return firstWord.substring(0, 3);
}

// ── Scanner: all Kalshi sports series ──

const ALL_SERIES = [
  { series: 'KXNBASPREAD', sport: 'NBA', type: 'Spread', stdevKey: 'NBA_Spread' },
  { series: 'KXNBATOTAL',  sport: 'NBA', type: 'Total',  stdevKey: 'NBA_Total' },
  { series: 'KXNBAGAME',   sport: 'NBA', type: 'Moneyline', stdevKey: 'NBA_Spread' },
  { series: 'KXNHLSPREAD', sport: 'NHL', type: 'Spread', stdevKey: 'NHL_Spread' },
  { series: 'KXNHLTOTAL',  sport: 'NHL', type: 'Total',  stdevKey: 'NHL_Total' },
  { series: 'KXNHLGAME',   sport: 'NHL', type: 'Moneyline', stdevKey: 'NHL_Spread' },
  { series: 'KXMLBSPREAD', sport: 'MLB', type: 'Spread', stdevKey: 'MLB_Spread' },
  { series: 'KXMLBTOTAL',  sport: 'MLB', type: 'Total',  stdevKey: 'MLB_Total' },
  { series: 'KXMLBGAME',   sport: 'MLB', type: 'Moneyline', stdevKey: 'MLB_Spread' },
];

function normalizeForTicker(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
}

function extractGameFromEvent(eventTicker) {
  const match = eventTicker.match(/\d{2}[A-Z]{3}\d{2}([A-Z]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function extractLineFromMarket(market) {
  const yesSubTitle = (market.yes_sub_title || '').toLowerCase();
  const title = (market.title || '').toLowerCase();
  const ticker = (market.ticker || '').toUpperCase();
  const totalSub = yesSubTitle.match(/([\d.]+)\s*(?:points|goals|runs)/i);
  if (totalSub) return parseFloat(totalSub[1]);
  const spreadSub = yesSubTitle.match(/over\s+([\d.]+)\s*(?:points|goals|runs)/i);
  if (spreadSub) return parseFloat(spreadSub[1]);
  const titleLine = title.match(/([\d.]+)\s*(?:or more|points|goals|runs)/i);
  if (titleLine) return parseFloat(titleLine[1]);
  const tickerLine = ticker.match(/-(\d+)$/);
  if (tickerLine) return parseFloat(tickerLine[1]) + 0.5;
  return null;
}

function extractSpreadTeam(market) {
  const title = (market.title || '').toLowerCase();
  const m = title.match(/^(\w[\w\s]*?)\s+wins\s+by/i);
  return m ? m[1].trim() : null;
}

// ── Tiered pricing: determine fill price based on edge at different price levels ──
// kalshiCoverProb = probability our bet wins (always from our side's perspective)
// rawAskPrice = the price we'd pay for our side's contract
//   YES side: yesAsk   (e.g., 0.49)
//   NO side:  1 - yesBid (e.g., 0.52 when yesBid=0.48)
// fairPrice = kalshiCoverProb (the model's fair value for our side)

function computeTieredPrice(kalshiCoverProb, rawAskPrice) {
  const fairPrice = kalshiCoverProb; // model says this is what the contract is worth
  const midpoint = Math.round(((fairPrice + rawAskPrice) / 2) * 100) / 100;

  // Edge = fair value - price we pay
  const edgeAsk = fairPrice - rawAskPrice;
  const edgeMid = fairPrice - midpoint;

  if (edgeAsk >= 0.05) {
    return { price: rawAskPrice, tier: 'ask', edge: edgeAsk, fairPrice, midpoint };
  } else if (edgeMid >= 0.05) {
    return { price: midpoint, tier: 'midpoint', edge: edgeMid, fairPrice, midpoint };
  } else {
    return { price: null, tier: 'skip', edge: Math.max(edgeAsk, edgeMid), fairPrice, midpoint };
  }
}

// ── Parse pick details ──

function parsePick(pick) {
  const pickStr = pick.pick || '';
  const betType = (pick.betType || '').trim();
  const sport = (pick.sport || '').trim();

  let direction = null; // 'over', 'under', or team side
  let targetLine = null;
  let pickTeam = null;

  if (betType === 'Total' || /over|under/i.test(pickStr)) {
    const m = pickStr.match(/(over|under)\s*([\d.]+)/i);
    if (m) {
      direction = m[1].toLowerCase();
      targetLine = parseFloat(m[2]);
    }
  } else if (betType === 'Spread' || betType === 'Puck Line' || betType === 'Run Line') {
    const lineMatch = pickStr.match(/([+-][\d.]+)/);
    if (lineMatch) targetLine = parseFloat(lineMatch[1]);
    pickTeam = pickStr.replace(/[+-][\d.]+.*$/, '').trim();
    direction = 'spread';
  } else {
    // Moneyline
    pickTeam = pickStr.replace(/\s*ML$/i, '').trim();
    direction = 'moneyline';
  }

  return { sport, betType, direction, targetLine, pickTeam, pickStr };
}

// ── Find matching Kalshi market ──

async function findKalshiMarket(pick) {
  const parsed = parsePick(pick);
  const seriesKey = `${parsed.sport}_${parsed.betType.replace(/\s+/g, '')}`;
  const series = SERIES_MAP[seriesKey] || SERIES_MAP[`${parsed.sport}_${parsed.betType}`];
  if (!series) {
    return { match: null, reason: `No Kalshi series for ${seriesKey}` };
  }

  // Fetch open markets in this series
  const path = '/markets';
  const { ok, data } = await kalshiFetch('GET', `/markets?series_ticker=${series}&status=open&limit=500`);
  if (!ok || !data.markets) {
    return { match: null, reason: `Failed to fetch ${series} markets` };
  }

  const markets = data.markets;
  const teams = extractTeamsFromMatchup(pick.matchup);

  // Build city abbreviation map for event_ticker matching
  // Kalshi event_tickers use 3-letter city codes: TORDET, DETPIT, etc.
  const cityAbbrevs = teams.map(t => getCityAbbrev(t));

  // Filter to markets that match our teams
  // Strategy 1: Both team city/name words appear in title+subtitle+ticker
  // Strategy 2: Both city abbreviations appear in event_ticker (for spread markets where title has only 1 team)
  const teamMatches = markets.filter(m => {
    const title = (m.title || '').toLowerCase();
    const subtitle = (m.yes_sub_title || '').toLowerCase();
    const ticker = (m.ticker || '').toLowerCase();
    const eventTicker = (m.event_ticker || '').toLowerCase();
    const combined = `${title} ${subtitle} ${ticker}`;

    // Strategy 1: full word match in combined text
    let teamsMatched = 0;
    for (const team of teams) {
      const words = getTeamWords(team);
      if (words.some(w => wordInText(w, combined))) teamsMatched++;
    }
    if (teamsMatched >= Math.min(2, teams.length)) return true;

    // Strategy 2: city abbreviation match in event_ticker
    // e.g. event_ticker "kxnbaspread-26mar31tordet-det3" contains "tor" and "det"
    if (cityAbbrevs.length >= 2 && cityAbbrevs.every(abbr => abbr.length >= 3 && eventTicker.includes(abbr))) {
      return true;
    }

    return false;
  });

  if (teamMatches.length === 0) {
    return { match: null, reason: `No Kalshi market found for ${pick.matchup} in ${series} (${markets.length} markets searched)` };
  }

  // For totals: find the closest line to our target
  if (parsed.direction === 'over' || parsed.direction === 'under') {
    let bestMatch = null;
    let bestDiff = Infinity;
    let bestLine = null;

    for (const m of teamMatches) {
      const title = (m.title || '').toLowerCase();
      const yesSubTitle = (m.yes_sub_title || '').toLowerCase();
      // Extract line from yes_sub_title ("Over 220.5 points scored") or title or ticker
      const subMatch = yesSubTitle.match(/([\d.]+)\s*(?:points|goals)/i);
      const titleMatch = title.match(/([\d.]+)\s*(?:or more|or fewer|\+|total|points|goals)/i);
      // Also try extracting from ticker: KXNBATOTAL-26MAR31TORDET-220 → 220
      const tickerMatch = (m.ticker || '').match(/-(\d+)$/);
      const capStrike = m.cap_strike || null;
      const floorStrike = m.floor_strike || null;
      const line = subMatch ? parseFloat(subMatch[1])
        : titleMatch ? parseFloat(titleMatch[1])
        : tickerMatch ? parseFloat(tickerMatch[1]) + 0.5 // ticker has whole number, actual line is +0.5
        : (capStrike || floorStrike || null);

      if (line !== null && parsed.targetLine !== null) {
        const diff = Math.abs(line - parsed.targetLine);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestMatch = m;
          bestLine = line;
        }
      }
    }

    if (bestMatch && bestDiff <= 5) {
      // Kalshi yes_sub_title is "Over X.X points scored" — YES = over, NO = under
      const bestYesSub = (bestMatch.yes_sub_title || '').toLowerCase();
      let side;
      if (bestYesSub.includes('over')) {
        side = parsed.direction === 'over' ? 'yes' : 'no';
      } else if (bestYesSub.includes('under') || bestYesSub.includes('fewer')) {
        side = parsed.direction === 'under' ? 'yes' : 'no';
      } else {
        side = parsed.direction === 'over' ? 'yes' : 'no'; // default: assume YES = over
      }

      return { match: bestMatch, side, lineDiff: bestDiff, kalshiLine: bestLine, direction: parsed.direction, reason: 'matched' };
    }

    return { match: teamMatches[0], side: parsed.direction === 'over' ? 'yes' : 'no', lineDiff: bestDiff, kalshiLine: bestLine, direction: parsed.direction, reason: 'closest_line' };
  }

  // For spreads: find the closest spread line
  if (parsed.direction === 'spread') {
    const pickTeamWords = getTeamWords(parsed.pickTeam);
    let bestMatch = null;
    let bestDiff = Infinity;
    let bestLine = null;

    for (const m of teamMatches) {
      const title = (m.title || '').toLowerCase();
      const yesSubTitle = (m.yes_sub_title || '').toLowerCase();
      const ticker = (m.ticker || '').toUpperCase();

      // Kalshi spread format: "Detroit wins by over 3.5 Points?"
      const subMatch = yesSubTitle.match(/over\s+([\d.]+)\s*points/i);
      const titleMatch = title.match(/over\s+([\d.]+)\s*points/i) || title.match(/by\s+(?:over\s+)?([\d.]+)/i);
      const tickerMatch = ticker.match(/[A-Z]+(\d+)$/);
      const line = subMatch ? parseFloat(subMatch[1])
        : titleMatch ? parseFloat(titleMatch[1])
        : tickerMatch ? parseFloat(tickerMatch[1]) + 0.5
        : null;

      if (line !== null && parsed.targetLine !== null) {
        const diff = Math.abs(line - Math.abs(parsed.targetLine));
        if (diff < bestDiff) {
          bestDiff = diff;
          bestMatch = m;
          bestLine = line;
        }
      }
    }

    if (bestMatch) {
      // Kalshi spread: "Detroit wins by over 3.5 Points?" — YES = Detroit covers, NO = doesn't
      // First, filter to markets for our picked team
      const teamFilteredMatches = teamMatches.filter(m => {
        const t = (m.title || '').toLowerCase();
        return pickTeamWords.some(w => t.includes(w + ' wins'));
      });

      if (teamFilteredMatches.length > 0) {
        // Re-find best match within our team's markets
        bestMatch = null;
        bestDiff = Infinity;
        bestLine = null;
        for (const m of teamFilteredMatches) {
          const yesSubTitle = (m.yes_sub_title || '').toLowerCase();
          const subMatch = yesSubTitle.match(/over\s+([\d.]+)/i);
          const mLine = subMatch ? parseFloat(subMatch[1]) : null;
          if (mLine !== null) {
            const diff = Math.abs(mLine - Math.abs(parsed.targetLine));
            if (diff < bestDiff) { bestDiff = diff; bestMatch = m; bestLine = mLine; }
          }
        }
      }

      if (!bestMatch) bestMatch = teamMatches[0];

      // If we picked the favorite (negative line), YES on "team wins by over X"
      // If we picked underdog (positive line), NO on "opponent wins by over X"
      const side = parsed.targetLine < 0 ? 'yes' : 'no';

      return { match: bestMatch, side, lineDiff: bestDiff, kalshiLine: bestLine, direction: 'spread', reason: 'matched' };
    }

    return { match: null, reason: `No matching spread line in ${teamMatches.length} team-matched markets` };
  }

  // Moneyline: simplest case
  if (parsed.direction === 'moneyline') {
    const pickTeamWords = getTeamWords(parsed.pickTeam);
    for (const m of teamMatches) {
      const title = (m.title || '').toLowerCase();
      if (pickTeamWords.some(w => title.includes(w))) {
        return { match: m, side: 'yes', lineDiff: 0, kalshiLine: null, direction: 'moneyline', reason: 'matched' };
      }
    }
    return { match: teamMatches[0], side: 'yes', lineDiff: 0, kalshiLine: null, direction: 'moneyline', reason: 'best_guess' };
  }

  return { match: null, reason: 'Unknown bet type' };
}

// ── Check orderbook depth ──

async function checkOrderbook(ticker) {
  const { ok, data } = await kalshiFetch('GET', `/markets/${ticker}/orderbook?depth=10`);
  if (!ok) return { depth: 0, bestAsk: null, bestBid: null };

  const book = data.orderbook_fp || data.orderbook || {};
  const yesLevels = book.yes_dollars || book.yes || [];
  const noLevels = book.no_dollars || book.no || [];

  // Best yes ask = lowest no bid complement, or from yes levels
  let bestYesBid = 0, bestYesAsk = 1, yesDepth = 0, noDepth = 0;

  for (const [price, qty] of yesLevels) {
    const p = parseFloat(price);
    const q = parseFloat(qty);
    if (p > bestYesBid) bestYesBid = p;
    yesDepth += p * q; // dollar depth
  }

  for (const [price, qty] of noLevels) {
    const p = parseFloat(price);
    const q = parseFloat(qty);
    const impliedYesAsk = 1 - p;
    if (impliedYesAsk < bestYesAsk) bestYesAsk = impliedYesAsk;
    noDepth += p * q;
  }

  return {
    yesBid: bestYesBid,
    yesAsk: bestYesAsk,
    yesDepthDollars: Math.round(yesDepth * 100) / 100,
    noDepthDollars: Math.round(noDepth * 100) / 100,
    totalDepth: Math.round((yesDepth + noDepth) * 100) / 100,
    levels: { yes: yesLevels.length, no: noLevels.length },
  };
}

// ── Place order ──

async function placeOrder(ticker, side, contracts, priceDollars, pickLabel) {
  const clientOrderId = `webetai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const order = {
    ticker,
    side, // 'yes' or 'no'
    action: 'buy',
    count: contracts,
    type: 'limit',
    time_in_force: 'good_till_canceled',
    client_order_id: clientOrderId,
  };

  if (side === 'yes') {
    order.yes_price = Math.round(priceDollars * 100); // cents
  } else {
    order.no_price = Math.round(priceDollars * 100);
  }

  console.log(`[kalshi] Placing order: ${contracts} contracts ${side} @ $${priceDollars} on ${ticker} (${pickLabel})`);
  const { ok, status, data } = await kalshiFetch('POST', '/portfolio/orders', order);

  if (ok) {
    console.log(`[kalshi] Order placed: ${data.order?.order_id || 'OK'}`);
    return { success: true, orderId: data.order?.order_id, clientOrderId, data: data.order };
  } else {
    console.error(`[kalshi] Order FAILED (${status}):`, JSON.stringify(data));
    return { success: false, error: data, status };
  }
}

// ── Get portfolio balance ──

async function getBalance() {
  const { ok, data } = await kalshiFetch('GET', '/portfolio/balance');
  if (!ok) return { balance: 0, portfolioValue: 0 };
  return {
    balance: (data.balance || 0) / 100, // convert cents to dollars
    portfolioValue: (data.portfolio_value || 0) / 100,
  };
}

// ── Get positions ──

async function getPositions() {
  const { ok, data } = await kalshiFetch('GET', '/portfolio/positions?limit=100&count_filter=position');
  if (!ok) return [];
  return data.market_positions || [];
}

// ── Store execution log to blob ──

async function storeLog(dateISO, log) {
  const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;

  const storeUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-executions`;
  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Store today's execution
  await fetch(`${storeUrl}/exec-${dateISO}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify(log),
  });

  // Update dates index
  let dates = [];
  try {
    const dResp = await fetch(`${storeUrl}/exec-dates`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (dResp.ok) dates = await dResp.json();
  } catch (e) { /* empty */ }
  if (!dates.includes(dateISO)) {
    dates.push(dateISO);
    dates.sort();
    await fetch(`${storeUrl}/exec-dates`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(dates) });
  }

  // Store latest for quick dashboard access
  await fetch(`${storeUrl}/latest`, { method: 'PUT', headers: authHeaders, body: JSON.stringify(log) });
}

// ── Main execution ──

exports.handler = async (event) => {
  console.log('[kalshi] Execution started');
  await initKalshiKey(); // load from Blob if not in env var

  // Parse body for liveOverride flag (from Purchase Live button)
  let bodyData = {};
  try { bodyData = JSON.parse(event.body || '{}'); } catch (e) { /* ok */ }
  const liveOverride = bodyData.liveOverride === true;

  const env = process.env.KALSHI_ENV || 'demo';
  const enabled = process.env.KALSHI_ENABLED === 'true' || liveOverride;
  const apiKey = process.env.KALSHI_API_KEY;
  const privateKey = _kalshiPrivateKey;

  if (liveOverride) console.log('[kalshi] LIVE OVERRIDE — placing real orders via Purchase button');

  const dateISO = new Date().toISOString().split('T')[0];
  const log = {
    date: dateISO,
    timestamp: new Date().toISOString(),
    environment: env,
    enabled,
    dollarPerUnit: DOLLAR_PER_UNIT,
    picks: [],
    executions: [],
    balance: null,
    positions: [],
    errors: [],
  };

  try {
    // Check config
    if (!apiKey || !privateKey) {
      log.errors.push('KALSHI_API_KEY or KALSHI_PRIVATE_KEY not configured');
      console.log('[kalshi] API keys not configured — logging picks without execution');
    }

    // 1. Fetch beta picks
    const siteURL = process.env.URL || 'https://webetsocial.com';
    const picksResp = await fetch(`${siteURL}/.netlify/functions/get-picks-beta`);
    if (!picksResp.ok) {
      log.errors.push(`Failed to fetch beta picks: ${picksResp.status}`);
      await storeLog(dateISO, log);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(log) };
    }

    const picksData = await picksResp.json();
    const picks = (picksData.picks || []).slice(0, 3);
    log.picks = picks.map(p => ({
      sport: p.sport,
      matchup: p.matchup,
      pick: p.pick,
      betType: p.betType,
      odds: p.odds,
      units: p.units,
      rating: p.rating,
      winProbability: p.winProbability,
      modelEdge: p.modelEdge,
    }));

    console.log(`[kalshi] Found ${picks.length} beta picks for ${dateISO}`);

    if (!apiKey || !privateKey) {
      log.executions = picks.map(p => ({
        pick: p.pick,
        status: 'skipped',
        reason: 'API keys not configured',
      }));
      await storeLog(dateISO, log);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(log) };
    }

    // 2. Check balance
    try {
      log.balance = await getBalance();
      console.log(`[kalshi] Balance: $${log.balance.balance}, Portfolio: $${log.balance.portfolioValue}`);
    } catch (e) {
      log.errors.push(`Balance check failed: ${e.message}`);
    }

    // Save model projections for scanner phase
    const modelProjections = picksData.modelProjections || {};

    // Track cumulative risk across edge picks + scanner
    let cumulativeRisk = 0;

    // 3. Execute each pick
    for (const pick of picks) {
      const exec = {
        pick: pick.pick,
        matchup: pick.matchup,
        sport: pick.sport,
        betType: pick.betType,
        units: pick.units,
        status: 'pending',
        kalshiTicker: null,
        kalshiTitle: null,
        side: null,
        contracts: 0,
        price: null,
        orderId: null,
        orderbook: null,
        reason: null,
        error: null,
      };

      try {
        // Find matching market
        console.log(`[kalshi] Matching: ${pick.pick} (${pick.matchup})`);
        const { match, side, lineDiff, kalshiLine, direction, reason } = await findKalshiMarket(pick);

        if (!match) {
          exec.status = 'no_market';
          exec.reason = reason;
          console.log(`[kalshi] No market: ${reason}`);
          log.executions.push(exec);
          continue;
        }

        exec.kalshiTicker = match.ticker;
        exec.kalshiTitle = match.title;
        exec.side = side;
        exec.lineDiff = lineDiff;
        exec.kalshiLine = kalshiLine;

        // ── Gate 1: Line drift — skip if Kalshi line is too far from our pick ──
        const MAX_LINE_DRIFT = 2; // max points/goals off from our line
        if (typeof lineDiff === 'number' && lineDiff > MAX_LINE_DRIFT) {
          exec.status = 'line_drift';
          exec.reason = `Kalshi line ${lineDiff.toFixed(1)} pts off from pick (max ${MAX_LINE_DRIFT})`;
          log.executions.push(exec);
          continue;
        }

        // ── Recalculate cover probability for the ACTUAL Kalshi line ──
        const modelEdgeParsed = parseModelEdge(pick.modelEdge);
        const sportBetKey = `${pick.sport}_${(pick.betType || '').replace(/\s+/g, '')}`;
        // Map bet types to stdev categories
        const stdevKey = sportBetKey.replace(/PuckLine|RunLine/, 'Spread');
        const stdev = OUTCOME_STDEV[stdevKey] || OUTCOME_STDEV[`${pick.sport}_Spread`] || 11;

        let kalshiCoverProb = null;
        let kalshiEdgeStr = '';

        if (modelEdgeParsed && kalshiLine !== null) {
          kalshiCoverProb = calcCoverProb(
            modelEdgeParsed.modelProjection,
            kalshiLine,
            stdev,
            direction // 'over', 'under', or 'spread'
          );

          const origCoverProb = parseFloat(pick.winProbability) / 100;
          kalshiEdgeStr = `Model proj: ${modelEdgeParsed.modelProjection}, ` +
            `Pick line: ${modelEdgeParsed.originalLine} (${(origCoverProb * 100).toFixed(0)}% cover), ` +
            `Kalshi line: ${kalshiLine} (${(kalshiCoverProb * 100).toFixed(1)}% cover), ` +
            `σ=${stdev}`;

          console.log(`[kalshi] Recalc: ${kalshiEdgeStr}`);
        } else {
          // Fallback: use the original win probability (sportsbook-based)
          kalshiCoverProb = parseFloat(pick.winProbability) / 100;
          kalshiEdgeStr = `Using original sportsbook cover prob: ${(kalshiCoverProb * 100).toFixed(0)}% (no recalc — model projection or Kalshi line unavailable)`;
          console.log(`[kalshi] ${kalshiEdgeStr}`);
        }

        exec.kalshiCoverProb = Math.round(kalshiCoverProb * 1000) / 10;
        exec.kalshiEdgeCalc = kalshiEdgeStr;

        // Check orderbook
        const book = await checkOrderbook(match.ticker);
        exec.orderbook = book;
        console.log(`[kalshi] Orderbook ${match.ticker}: bid=$${book.yesBid} ask=$${book.yesAsk} depth=$${book.totalDepth}`);

        // Determine price based on side
        const rawPrice = side === 'yes' ? book.yesAsk : (1 - book.yesBid);
        if (!rawPrice || rawPrice <= 0 || rawPrice >= 1) {
          exec.status = 'no_price';
          exec.reason = `No valid price: ${side} price=${rawPrice}`;
          log.executions.push(exec);
          continue;
        }

        // ── Gate 2: Odds alignment — compare pick odds to Kalshi price ──
        const pickOdds = parseInt(pick.odds);
        let pickImplied = 0.5;
        if (!isNaN(pickOdds)) {
          pickImplied = pickOdds < 0
            ? Math.abs(pickOdds) / (Math.abs(pickOdds) + 100)
            : 100 / (pickOdds + 100);
        }
        const kalshiImplied = side === 'yes' ? rawPrice : (1 - rawPrice);
        const oddsGap = kalshiImplied - pickImplied;
        exec.pickImplied = Math.round(pickImplied * 1000) / 10;
        exec.kalshiImplied = Math.round(kalshiImplied * 1000) / 10;

        const MAX_ODDS_DRIFT = 0.10;
        if (oddsGap > MAX_ODDS_DRIFT) {
          exec.status = 'odds_drift';
          exec.reason = `Kalshi implied ${(kalshiImplied * 100).toFixed(1)}% vs pick ${(pickImplied * 100).toFixed(1)}% = ${(oddsGap * 100).toFixed(1)}pp worse (max ${MAX_ODDS_DRIFT * 100}pp)`;
          log.executions.push(exec);
          continue;
        }

        // ── Gate 3: Tiered pricing — edge must be ≥5% at a fillable price ──
        const edgeVsKalshi = kalshiCoverProb - kalshiImplied;
        exec.kalshiEdge = Math.round(edgeVsKalshi * 1000) / 10;

        const tiered = computeTieredPrice(kalshiCoverProb, rawPrice);
        exec.rawAskPrice = rawPrice;
        exec.fairPrice = Math.round(tiered.fairPrice * 100) / 100;
        exec.pricingTier = tiered.tier;

        if (tiered.tier === 'skip') {
          exec.status = 'insufficient_edge';
          exec.reason = `No fillable price with ≥5% edge. Ask=${(rawPrice*100).toFixed(0)}¢ (edge ${(tiered.edge*100).toFixed(1)}%), Fair=${(fairPrice*100).toFixed(0)}¢`;
          log.executions.push(exec);
          continue;
        }

        const price = tiered.price;
        exec.price = price;

        // ── Kalshi-specific EV calculation at the FILL price ──
        const evPerContract = (kalshiCoverProb * (1 - price)) - ((1 - kalshiCoverProb) * price);
        const evPercent = evPerContract / price;
        exec.kalshiEV = Math.round(evPercent * 1000) / 10;
        exec.evPerContract = Math.round(evPerContract * 100) / 100;

        // Calculate contracts and payout
        const units = parseFloat(pick.units) || 1;
        const riskDollars = units * DOLLAR_PER_UNIT;
        const contracts = Math.max(1, Math.floor(riskDollars / price));
        exec.contracts = contracts;
        exec.totalRisk = Math.round(contracts * price * 100) / 100;
        exec.totalPayout = Math.round(contracts * 1 * 100) / 100;
        exec.totalProfit = Math.round((exec.totalPayout - exec.totalRisk) * 100) / 100;

        // ── Gate 4: Liquidity — need at least 2x our order in book depth ──
        if (book.totalDepth < riskDollars * 2) {
          exec.status = 'thin_liquidity';
          exec.reason = `Book depth $${book.totalDepth} < 2x risk $${riskDollars * 2}`;
          log.executions.push(exec);
          continue;
        }

        // ── Gate 5: Daily risk cap ──
        if (cumulativeRisk + exec.totalRisk > MAX_DAILY_RISK) {
          exec.status = 'risk_cap';
          exec.reason = `Would exceed daily cap: $${cumulativeRisk.toFixed(2)} + $${exec.totalRisk} > $${MAX_DAILY_RISK}`;
          log.executions.push(exec);
          continue;
        }

        // Place the order (only if enabled)
        if (!enabled) {
          exec.status = 'dry_run';
          exec.reason = 'KALSHI_ENABLED != true — would place order';
          cumulativeRisk += exec.totalRisk;
          log.executions.push(exec);
          continue;
        }

        const result = await placeOrder(match.ticker, side, contracts, price, pick.pick);

        if (result.success) {
          exec.status = 'placed';
          exec.orderId = result.orderId;
          exec.orderData = result.data;
          cumulativeRisk += exec.totalRisk;
        } else {
          exec.status = 'order_failed';
          exec.error = result.error;
        }
      } catch (e) {
        exec.status = 'error';
        exec.error = e.message;
        console.error(`[kalshi] Error executing ${pick.pick}:`, e.message);
      }

      log.executions.push(exec);
    }

    // Track risk cap usage
    log.riskCap = { maxUnits: MAX_DAILY_UNITS, maxDollars: MAX_DAILY_RISK, used: Math.round(cumulativeRisk * 100) / 100 };

    // 5. Get current positions
    try {
      log.positions = await getPositions();
    } catch (e) {
      log.errors.push(`Positions fetch failed: ${e.message}`);
    }

    // Store log
    await storeLog(dateISO, log);

    console.log(`[kalshi] Execution complete: ${log.executions.filter(e => e.status === 'placed').length} placed, ${log.executions.filter(e => e.status === 'dry_run').length} dry run, ${log.executions.filter(e => e.status === 'no_market').length} no market`);

    return { statusCode: 200, headers: CORS, body: JSON.stringify(log) };

  } catch (err) {
    console.error('[kalshi] Fatal error:', err.message);
    log.errors.push(err.message);
    await storeLog(dateISO, log).catch(() => {});
    return { statusCode: 500, headers: CORS, body: JSON.stringify(log) };
  }
};
