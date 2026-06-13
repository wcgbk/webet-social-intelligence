// kalshi-scan.js
// Research-only: Scans ALL open Kalshi sports markets independently,
// applies WeBetAI model projections + normal CDF math to find +EV contracts.
// GET /api/kalshi-scan?key=SECRET
// Does NOT place any orders — pure research output.

const crypto = require('crypto');
const { getKalshiPrivateKey } = require('./kalshi-key');
let _kalshiPrivateKey = null;
async function initKalshiKey() { if (!_kalshiPrivateKey) _kalshiPrivateKey = await getKalshiPrivateKey(); }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Statistical helpers ──

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

const OUTCOME_STDEV = {
  NBA_Spread: 11, NBA_Total: 11,
  NHL_Spread: 1.7, NHL_Total: 1.7,
  MLB_Spread: 2.2, MLB_Total: 2.2,
};

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

async function kalshiFetch(method, path) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const opts = { method, headers: kalshiHeaders(method, path) };
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function checkOrderbook(ticker) {
  const { ok, data } = await kalshiFetch('GET', `/markets/${ticker}/orderbook?depth=10`);
  if (!ok) return { yesBid: 0, yesAsk: 1, totalDepth: 0, hasLiquidity: false };
  const book = data.orderbook_fp || data.orderbook || {};
  const yesLevels = book.yes_dollars || book.yes || [];
  const noLevels = book.no_dollars || book.no || [];
  let bestYesBid = 0, bestYesAsk = 1, yesDepth = 0, noDepth = 0;
  for (const [price, qty] of yesLevels) {
    const p = parseFloat(price); const q = parseFloat(qty);
    if (p > bestYesBid) bestYesBid = p;
    yesDepth += p * q;
  }
  for (const [price, qty] of noLevels) {
    const p = parseFloat(price); const q = parseFloat(qty);
    const impliedYesAsk = 1 - p;
    if (impliedYesAsk < bestYesAsk) bestYesAsk = impliedYesAsk;
    noDepth += p * q;
  }
  const totalDepth = Math.round((yesDepth + noDepth) * 100) / 100;
  return {
    yesBid: bestYesBid,
    yesAsk: bestYesAsk,
    yesDepthDollars: Math.round(yesDepth * 100) / 100,
    noDepthDollars: Math.round(noDepth * 100) / 100,
    totalDepth,
    hasLiquidity: yesLevels.length > 0 || noLevels.length > 0,
  };
}

// ── All Kalshi sports series to scan ──

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

// ── Projection parsing ──

function parseTeamsFromKey(matchupKey) {
  const parts = matchupKey.split(/\s+@\s+/).map(s => s.trim());
  if (parts.length === 2) return { away: parts[0], home: parts[1] };
  return null;
}

function normalizeForTicker(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
}

const KALSHI_ABBREV_MAP = {
  'brooklyn': 'bkn', 'golden state': 'gs', 'oklahoma city': 'okc',
  'new york knicks': 'nyk', 'new york rangers': 'nyr', 'new york islanders': 'nyi',
  'new york': 'nyk', 'new orleans': 'no', 'san antonio': 'sa',
  'los angeles lakers': 'lal', 'los angeles clippers': 'lac', 'la lakers': 'lal', 'la clippers': 'lac',
  'portland': 'por', 'minnesota': 'min', 'philadelphia': 'phi', 'washington': 'wsh',
  'sacramento': 'sac', 'indiana': 'ind', 'tampa bay': 'tb', 'st louis': 'stl',
  'columbus': 'cbj', 'new jersey': 'nj', 'san jose': 'sj',
  'vegas': 'vgk', 'las vegas': 'vgk', 'utah': 'uta', 'anaheim': 'ana',
  'arizona': 'ari', 'colorado': 'col', 'nashville': 'nsh', 'winnipeg': 'wpg',
  'vancouver': 'van', 'calgary': 'cgy', 'edmonton': 'edm', 'seattle': 'sea',
};

function getCityAbbrev(teamName) {
  const normalized = normalizeForTicker(teamName);
  for (const [key, abbr] of Object.entries(KALSHI_ABBREV_MAP)) {
    if (normalized.startsWith(key) || normalized.includes(key)) return abbr;
  }
  const words = normalized.split(' ').filter(w => w.length >= 3);
  return (words[0] || '').substring(0, 3);
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

// ── Main handler ──

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  await initKalshiKey();

  const key = event.queryStringParameters?.key || '';
  const SECRET = process.env.PICKS_SECRET_KEY || 'webet95picks2026';
  if (key !== SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const apiKey = process.env.KALSHI_API_KEY;
  const privateKey = _kalshiPrivateKey;
  if (!apiKey || !privateKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Kalshi API keys not configured' }) };
  }

  // 1. Fetch model projections from beta picks
  const siteURL = process.env.URL || 'https://webetsocial.com';
  let modelProjections = {};
  try {
    const picksResp = await fetch(`${siteURL}/.netlify/functions/get-picks-beta`);
    if (picksResp.ok) {
      const picksData = await picksResp.json();
      modelProjections = picksData.modelProjections || {};
    }
  } catch (e) {
    console.error('[kalshi-scan] Failed to fetch model projections:', e.message);
  }

  // Build abbreviation pair lookup
  const projectionsByAbbrevPair = {};
  for (const [matchupKey, proj] of Object.entries(modelProjections)) {
    const teams = parseTeamsFromKey(matchupKey);
    if (!teams) continue;
    const awayAbbr = getCityAbbrev(teams.away);
    const homeAbbr = getCityAbbrev(teams.home);
    const pairKey = `${awayAbbr}${homeAbbr}`;
    projectionsByAbbrevPair[pairKey] = { ...proj, away: teams.away, home: teams.home, matchupKey };
  }

  console.log(`[kalshi-scan] Model projections for ${Object.keys(modelProjections).length} games`);

  // 2. First pass: scan all markets, compute model edges, collect candidates
  const candidates = [];
  const scanSummary = {};

  for (const seriesCfg of ALL_SERIES) {
    const { series, sport, type, stdevKey } = seriesCfg;
    const stdev = OUTCOME_STDEV[stdevKey] || 11;

    let markets = [];
    try {
      const { ok, data } = await kalshiFetch('GET', `/markets?series_ticker=${series}&status=open&limit=500`);
      if (ok && data.markets) markets = data.markets;
    } catch (e) {
      scanSummary[series] = { error: e.message };
      continue;
    }

    scanSummary[series] = { marketsFound: markets.length, matched: 0, candidates: 0 };

    // Group by event
    const byEvent = {};
    for (const m of markets) {
      const et = m.event_ticker || 'unknown';
      if (!byEvent[et]) byEvent[et] = [];
      byEvent[et].push(m);
    }

    for (const [eventTicker, eventMarkets] of Object.entries(byEvent)) {
      const gameCode = extractGameFromEvent(eventTicker);
      let matchedProj = null;

      for (const [pairKey, proj] of Object.entries(projectionsByAbbrevPair)) {
        if (gameCode.includes(pairKey) || gameCode === pairKey) {
          matchedProj = proj; break;
        }
        // Reverse check
        const mid = Math.ceil(pairKey.length / 2);
        const reversed = pairKey.substring(mid) + pairKey.substring(0, mid);
        if (gameCode.includes(reversed) || gameCode === reversed) {
          matchedProj = proj; break;
        }
      }

      if (!matchedProj) continue;
      scanSummary[series].matched++;

      for (const market of eventMarkets) {
        const line = extractLineFromMarket(market);
        if (line === null && type !== 'Moneyline') continue;

        const yesSubTitle = (market.yes_sub_title || '').toLowerCase();
        const title = (market.title || '').toLowerCase();
        const lastPrice = (market.last_price || 0) / 100;
        const volume = market.volume || 0;
        const openInterest = market.open_interest || 0;

        if (type === 'Total') {
          const projTotal = matchedProj.projTotal;
          if (!projTotal) continue;

          for (const dir of ['over', 'under']) {
            const coverProb = dir === 'over'
              ? normalCDF((projTotal - line) / stdev)
              : normalCDF((line - projTotal) / stdev);

            const isYesOver = yesSubTitle.includes('over') || (!yesSubTitle.includes('under') && !yesSubTitle.includes('fewer'));
            const kalshiSide = (dir === 'over') === isYesOver ? 'yes' : 'no';

            // Only keep candidates where model sees meaningful edge (>5% vs 50% baseline)
            if (coverProb > 0.55) {
              candidates.push({
                sport, type, matchup: `${matchedProj.away} @ ${matchedProj.home}`,
                eventTicker, ticker: market.ticker, title: market.title,
                side: `${dir} ${line}`, kalshiSide, line,
                modelProjection: projTotal, coverProb, stdev,
                volume, openInterest, lastPrice,
                commenceTime: matchedProj.commenceTime || '',
                distFromModel: Math.abs(projTotal - line),
              });
              scanSummary[series].candidates++;
            }
          }
        } else if (type === 'Spread') {
          const projSpread = matchedProj.projSpread;
          if (projSpread === undefined || projSpread === null) continue;

          const spreadTeam = extractSpreadTeam(market);
          if (!spreadTeam) continue;

          const homeNorm = normalizeForTicker(matchedProj.home);
          const isHomeTeam = homeNorm.includes(spreadTeam) || spreadTeam.includes(homeNorm.split(' ')[0]);
          const effectiveProj = isHomeTeam ? projSpread : -projSpread;
          const yesCoverProb = normalCDF((effectiveProj - line) / stdev);

          // YES side = team covers
          if (yesCoverProb > 0.55) {
            candidates.push({
              sport, type, matchup: `${matchedProj.away} @ ${matchedProj.home}`,
              eventTicker, ticker: market.ticker, title: market.title,
              side: `YES: ${spreadTeam} wins by > ${line}`, kalshiSide: 'yes', line,
              modelProjection: effectiveProj, coverProb: yesCoverProb, stdev,
              volume, openInterest, lastPrice,
              commenceTime: matchedProj.commenceTime || '',
              distFromModel: Math.abs(effectiveProj - line),
            });
            scanSummary[series].candidates++;
          }

          // NO side = team doesn't cover
          const noCoverProb = 1 - yesCoverProb;
          if (noCoverProb > 0.55) {
            candidates.push({
              sport, type, matchup: `${matchedProj.away} @ ${matchedProj.home}`,
              eventTicker, ticker: market.ticker, title: market.title,
              side: `NO: ${spreadTeam} does NOT win by > ${line}`, kalshiSide: 'no', line,
              modelProjection: effectiveProj, coverProb: noCoverProb, stdev,
              volume, openInterest, lastPrice,
              commenceTime: matchedProj.commenceTime || '',
              distFromModel: Math.abs(effectiveProj - line),
            });
            scanSummary[series].candidates++;
          }
        } else if (type === 'Moneyline') {
          // Kalshi moneyline: each market.ticker is one team's contract (e.g. ...-BKN)
          // YES on that contract = that specific team wins
          // Determine which team this contract represents from ticker suffix
          const homeWinProb = (matchedProj.homeWinProb || 50) / 100;
          const awayWinProb = 1 - homeWinProb;

          const tickerSuffix = (market.ticker || '').split('-').pop().toLowerCase();
          const homeAbbr = getCityAbbrev(matchedProj.home).toLowerCase();
          const awayAbbr = getCityAbbrev(matchedProj.away).toLowerCase();

          let contractTeam, contractWinProb;
          if (tickerSuffix === homeAbbr || tickerSuffix.includes(homeAbbr) || homeAbbr.includes(tickerSuffix)) {
            contractTeam = matchedProj.home;
            contractWinProb = homeWinProb;
          } else if (tickerSuffix === awayAbbr || tickerSuffix.includes(awayAbbr) || awayAbbr.includes(tickerSuffix)) {
            contractTeam = matchedProj.away;
            contractWinProb = awayWinProb;
          } else {
            // Can't determine — skip
            continue;
          }

          // YES on this contract = contractTeam wins
          // Buy YES if model thinks contractTeam wins with edge
          if (contractWinProb > 0.55) {
            candidates.push({
              sport, type, matchup: `${matchedProj.away} @ ${matchedProj.home}`,
              eventTicker, ticker: market.ticker, title: market.title,
              side: `YES: ${contractTeam} wins`, kalshiSide: 'yes', line: null,
              modelProjection: `${(contractWinProb * 100).toFixed(1)}%`, coverProb: contractWinProb, stdev: 'N/A',
              volume, openInterest, lastPrice,
              commenceTime: matchedProj.commenceTime || '',
              distFromModel: 0,
            });
            scanSummary[series].candidates++;
          }
          // Buy NO if model thinks contractTeam LOSES with edge
          const oppProb = 1 - contractWinProb;
          if (oppProb > 0.55) {
            const oppTeam = contractTeam === matchedProj.home ? matchedProj.away : matchedProj.home;
            candidates.push({
              sport, type, matchup: `${matchedProj.away} @ ${matchedProj.home}`,
              eventTicker, ticker: market.ticker, title: market.title,
              side: `NO: ${oppTeam} wins`, kalshiSide: 'no', line: null,
              modelProjection: `${(oppProb * 100).toFixed(1)}%`, coverProb: oppProb, stdev: 'N/A',
              volume, openInterest, lastPrice,
              commenceTime: matchedProj.commenceTime || '',
              distFromModel: 0,
            });
            scanSummary[series].candidates++;
          }
        }
      }
    }
  }

  // 3. Sort candidates: prioritize closest to model projection (most reliable edge)
  candidates.sort((a, b) => a.distFromModel - b.distFromModel);

  // 4. Deep scan: fetch real orderbooks for top 25 candidates
  const MAX_ORDERBOOK_CHECKS = 25;
  const topCandidates = candidates.slice(0, MAX_ORDERBOOK_CHECKS);
  const opportunities = [];

  console.log(`[kalshi-scan] ${candidates.length} total candidates, checking orderbooks for top ${topCandidates.length}`);

  for (const c of topCandidates) {
    const book = await checkOrderbook(c.ticker);

    // Determine the real market price from orderbook
    let realPrice = null;
    let priceSource = 'none';

    if (c.kalshiSide === 'yes') {
      if (book.yesAsk < 1) { realPrice = book.yesAsk; priceSource = 'ask'; }
      else if (c.lastPrice > 0) { realPrice = c.lastPrice; priceSource = 'last_trade'; }
    } else {
      // NO side: price = 1 - yesBid
      if (book.yesBid > 0) { realPrice = 1 - book.yesBid; priceSource = 'bid_complement'; }
      else if (c.lastPrice > 0) { realPrice = 1 - c.lastPrice; priceSource = 'last_trade_complement'; }
    }

    const hasRealPrice = realPrice !== null && realPrice > 0 && realPrice < 1;

    // Calculate edge vs real price or vs 50% if no price
    const marketPrice = hasRealPrice ? realPrice : 0.5;
    const edge = c.coverProb - marketPrice;
    const ev = edge / marketPrice;

    // Compute Kelly sizing (quarter Kelly)
    const kellyFull = edge > 0 ? edge / (1 - marketPrice) : 0;
    const kellyQuarter = kellyFull / 4;

    // ── SANITY CHECKS ──
    // Rule 1: Edge must be positive and above noise floor
    if (edge <= 0.02) continue;

    // Rule 2: Phantom edge detection — if edge > 25%, the market price is
    // probably stale/thin, not a real opportunity. Flag as suspicious.
    const edgePct = edge * 100;
    const isSuspicious = edgePct > 25;

    // Rule 3: Minimum liquidity — contracts with < $500 book depth are
    // untradeable at any real size. Don't show them as actionable.
    const minDepth = 500;
    const hasMeaningfulDepth = book.totalDepth >= minDepth;

    // Rule 4: Price floor — contracts priced below 10¢ are extreme longshots
    // where the model-vs-market gap is unreliable.
    const abovePriceFloor = marketPrice >= 0.10;

    // Rule 5: Market price must come from a real orderbook, not a stale last trade
    const hasReliablePrice = priceSource === 'ask' || priceSource === 'bid_complement';

    // Determine tier with all sanity checks applied
    let tier = 'no_market';
    if (isSuspicious) {
      tier = 'suspicious';
    } else if (hasMeaningfulDepth && hasRealPrice && hasReliablePrice && abovePriceFloor && edge > 0.08) {
      tier = 'actionable';
    } else if (book.hasLiquidity && hasRealPrice && abovePriceFloor) {
      tier = 'marginal';
    } else if (hasRealPrice) {
      tier = 'thin';
    }

    opportunities.push({
      sport: c.sport,
      type: c.type,
      matchup: c.matchup,
      eventTicker: c.eventTicker,
      ticker: c.ticker,
      title: c.title,
      side: c.side,
      kalshiSide: c.kalshiSide,
      line: c.line,
      modelProjection: c.modelProjection,
      coverProb: Math.round(c.coverProb * 1000) / 10,
      marketPrice: Math.round(marketPrice * 1000) / 10,
      priceSource,
      edge: Math.round(edge * 1000) / 10,
      ev: Math.round(ev * 1000) / 10,
      kellyQuarter: Math.round(kellyQuarter * 1000) / 10,
      stdev: c.stdev,
      commenceTime: c.commenceTime || '',
      volume: c.volume,
      openInterest: c.openInterest,
      orderbook: {
        yesBid: book.yesBid,
        yesAsk: book.yesAsk,
        totalDepth: book.totalDepth,
        hasLiquidity: book.hasLiquidity,
      },
      tier,
    });
  }

  // Also include remaining candidates WITHOUT orderbook data as "unpriced"
  const remainingCandidates = candidates.slice(MAX_ORDERBOOK_CHECKS).map(c => ({
    sport: c.sport,
    type: c.type,
    matchup: c.matchup,
    ticker: c.ticker,
    title: c.title,
    side: c.side,
    line: c.line,
    modelProjection: c.modelProjection,
    coverProb: Math.round(c.coverProb * 1000) / 10,
    marketPrice: 'unpriced',
    edge: 'needs_orderbook',
    volume: c.volume,
    openInterest: c.openInterest,
    tier: 'unpriced',
  }));

  // ── Percentile grading for profitability ──
  // Score each opportunity on 4 dimensions, compute composite percentile
  if (opportunities.length > 0) {
    // Collect raw values for percentile ranking
    const edges = opportunities.map(o => o.edge);
    const coverProbs = opportunities.map(o => o.coverProb);
    const evs = opportunities.map(o => o.ev);
    const depths = opportunities.map(o => o.orderbook?.totalDepth || 0);

    function percentileRank(arr, val) {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = sorted.findIndex(v => v >= val);
      return idx < 0 ? 100 : Math.round((idx / sorted.length) * 100);
    }

    for (const o of opportunities) {
      const depth = o.orderbook?.totalDepth || 0;

      // Individual percentile scores (0-100, higher is better)
      const edgePct = percentileRank(edges, o.edge);
      const coverPct = percentileRank(coverProbs, o.coverProb);
      const evPct = percentileRank(evs, o.ev);
      const depthPct = percentileRank(depths, depth);

      // Weighted composite: edge 30%, cover probability 25%, EV 25%, liquidity 20%
      const composite = Math.round(
        edgePct * 0.30 +
        coverPct * 0.25 +
        evPct * 0.25 +
        depthPct * 0.20
      );

      // Letter grade from composite percentile
      let grade, gradeColor;
      if (composite >= 90) { grade = 'A+'; gradeColor = '#c0392b'; }
      else if (composite >= 80) { grade = 'A'; gradeColor = '#004C54'; }
      else if (composite >= 70) { grade = 'A-'; gradeColor = '#1abc9c'; }
      else if (composite >= 55) { grade = 'B+'; gradeColor = '#2196f3'; }
      else if (composite >= 40) { grade = 'B'; gradeColor = '#e67e22'; }
      else { grade = 'C'; gradeColor = '#8b95a3'; }

      // Profitability estimate: expected profit per $100 risked
      // E[profit] = (coverProb/100 * payout) - risk, where payout = $1/contract, risk = marketPrice/100
      const probWin = o.coverProb / 100;
      const mktPrice = o.marketPrice / 100;
      const expectedProfitPer100 = mktPrice > 0
        ? Math.round(((probWin * (1 / mktPrice)) - 1) * 100 * 10) / 10
        : 0;

      o.percentile = {
        composite,
        grade,
        gradeColor,
        edge: edgePct,
        cover: coverPct,
        ev: evPct,
        liquidity: depthPct,
        expectedProfitPer100,
      };
    }
  }

  // Sort final opportunities by composite percentile (best first), then edge
  opportunities.sort((a, b) => {
    const aP = a.percentile?.composite || 0;
    const bP = b.percentile?.composite || 0;
    if (bP !== aP) return bP - aP;
    return b.edge - a.edge;
  });

  const actionable = opportunities.filter(o => o.tier === 'actionable');
  const marginal = opportunities.filter(o => o.tier === 'marginal');

  const result = {
    timestamp: new Date().toISOString(),
    environment: process.env.KALSHI_ENV || 'demo',
    gamesWithProjections: Object.keys(modelProjections).length,
    seriesScanned: ALL_SERIES.length,
    totalMarketsScanned: Object.values(scanSummary).reduce((s, v) => s + (v.marketsFound || 0), 0),
    totalCandidates: candidates.length,
    orderbookChecked: topCandidates.length,
    summary: {
      actionable: actionable.length,
      marginal: marginal.length,
      thin: opportunities.filter(o => o.tier === 'thin').length,
      noMarket: opportunities.filter(o => o.tier === 'no_market').length,
      unpriced: remainingCandidates.length,
    },
    scanSummary,
    // Tiered results
    actionableOpportunities: actionable,
    marginalOpportunities: marginal,
    allCheckedOpportunities: opportunities,
    unpricedCandidates: remainingCandidates,
    disclaimer: 'RESEARCH ONLY — no orders placed. Edge calculations use WeBetAI projections + normal CDF. Markets with no orderbook liquidity use 50% default price.',
  };

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(result, null, 2),
  };
};
