'use strict';
/**
 * Omega prediction-market OBSERVER sidecar (Kalshi + Polymarket).
 *
 * Read-only. Logs implied probs / money movement when a PM market maps
 * cleanly 1:1 to a game moneyline. NEVER mutates pick rating, units, edge,
 * EV, gates, or selection. Free public APIs only — no order placement.
 *
 * Blob keys (edge-picks-omega): omega-pm-observer/{date}  (+ alias pm-sidecar-{date})
 */

const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

/** Moneyline series only — observer maps game ML, not spreads/totals. */
const KALSHI_ML_SERIES = [
  { series: 'KXMLBGAME', sport: 'MLB' },
  { series: 'KXNFLGAME', sport: 'NFL' },
  { series: 'KXNCAAFGAME', sport: 'NCAAF' },
  { series: 'KXNBAGAME', sport: 'NBA' },
  { series: 'KXNHLGAME', sport: 'NHL' },
];

const TEAM_ALIASES = {
  'ny yankees': 'new york yankees',
  'nyy': 'new york yankees',
  'ny mets': 'new york mets',
  'sf giants': 'san francisco giants',
  'la dodgers': 'los angeles dodgers',
  'la angels': 'los angeles angels',
  'tb rays': 'tampa bay rays',
  'chi cubs': 'chicago cubs',
  'chi white sox': 'chicago white sox',
  'bos red sox': 'boston red sox',
  'kc royals': 'kansas city royals',
  'sd padres': 'san diego padres',
  'stl': 'st louis cardinals',
  'st louis': 'st louis cardinals',
  'az diamondbacks': 'arizona diamondbacks',
  'wsh': 'washington nationals',
  'oakland': 'athletics',
};

function normTeam(name) {
  let s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (TEAM_ALIASES[s]) s = TEAM_ALIASES[s];
  return s;
}

function tokens(name) {
  return normTeam(name).split(' ').filter((t) => t.length >= 2);
}

function teamsMatch(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (!ta.length) return false;
  const hit = ta.filter((t) => tb.has(t) || [...tb].some((x) => x.includes(t) || t.includes(x)));
  return hit.length >= Math.min(2, ta.length) || (ta.length === 1 && hit.length === 1);
}

function isMoneylineCandidate(c) {
  const m = String(c.market || c.marketType || '').toLowerCase();
  if (/total|spread|run.?line|puck.?line|\bou\b|over|under/.test(m)) return false;
  if (/moneyline|\bml\b|h2h|money line/.test(m)) return true;
  const side = String(c.side || c.pick || '');
  if (side && !/[+\-]?\d/.test(side) && !/^(over|under)\b/i.test(side)) return true;
  return false;
}

function pickTeamFromCandidate(c) {
  const side = String(c.side || c.pick || '').replace(/\s+ML$/i, '').trim();
  if (side && c.homeTeam && teamsMatch(side, c.homeTeam)) return { team: c.homeTeam, role: 'home' };
  if (side && c.awayTeam && teamsMatch(side, c.awayTeam)) return { team: c.awayTeam, role: 'away' };
  return { team: side || null, role: null };
}

function parseJsonField(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (_) { return null; }
  }
  return null;
}

function centsToProb(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return null;
  const n = Number(cents);
  return n > 1.5 ? n / 100 : n;
}

function polyImpliedForTeam(market, teamName) {
  const outcomes = parseJsonField(market.outcomes) || [];
  const prices = parseJsonField(market.outcomePrices)
    || parseJsonField(market.outcome_prices)
    || [];
  if (!outcomes.length || outcomes.length !== prices.length) return null;
  for (let i = 0; i < outcomes.length; i++) {
    if (teamsMatch(outcomes[i], teamName)) {
      const p = parseFloat(prices[i]);
      if (Number.isFinite(p)) return p;
    }
  }
  return null;
}

/**
 * Strict 1:1 Polymarket moneyline map: exactly one market whose two outcomes
 * are home + away.
 */
function mapPolymarketMoneyline(candidate, markets) {
  const home = candidate.homeTeam;
  const away = candidate.awayTeam;
  if (!home || !away) return null;

  const scored = [];
  for (const m of markets || []) {
    const smt = String(m.sportsMarketType || m.sports_market_type || m.sportsMarketType || '').toLowerCase();
    const q = String(m.question || m.title || m.question || '');
    const isMl = smt === 'moneyline' || smt === 'ml' || /moneyline|\bml\b/i.test(q);
    if (!isMl && smt && smt !== 'moneyline') continue;
    const outcomes = parseJsonField(m.outcomes) || [];
    if (outcomes.length !== 2) continue;
    const o0h = teamsMatch(outcomes[0], home);
    const o0a = teamsMatch(outcomes[0], away);
    const o1h = teamsMatch(outcomes[1], home);
    const o1a = teamsMatch(outcomes[1], away);
    if (!((o0h && o1a) || (o0a && o1h))) continue;
    scored.push(m);
  }
  if (scored.length !== 1) return null;

  const m = scored[0];
  const { team } = pickTeamFromCandidate(candidate);
  const implied = team ? polyImpliedForTeam(m, team) : null;
  const prices = (parseJsonField(m.outcomePrices) || []).map((p) => parseFloat(p));
  return {
    venue: 'polymarket',
    marketId: m.id || m.conditionId || null,
    slug: m.slug || null,
    question: m.question || null,
    sportsMarketType: m.sportsMarketType || 'moneyline',
    outcomes: parseJsonField(m.outcomes),
    outcomePrices: prices,
    impliedPick: implied,
    volume24hr: m.volume24hr != null ? Number(m.volume24hr)
      : (m.volume_24hr != null ? Number(m.volume_24hr) : null),
    liquidity: m.liquidity != null ? Number(m.liquidity) : null,
    endDate: m.endDate || m.end_date_iso || null,
  };
}

/**
 * Strict 1:1 Kalshi moneyline: exactly one event with home+away YES contracts.
 */
function mapKalshiMoneyline(candidate, kalshiMarkets) {
  const home = candidate.homeTeam;
  const away = candidate.awayTeam;
  if (!home || !away) return null;
  const sport = candidate.sport;

  const byEvent = new Map();
  for (const m of kalshiMarkets || []) {
    if (m._sport && sport && m._sport !== sport) continue;
    const key = m.event_ticker || m.eventTicker
      || String(m.ticker || '').replace(/-[A-Z0-9]{2,5}$/i, '');
    if (!key) continue;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(m);
  }

  const matches = [];
  for (const [eventKey, mkts] of byEvent) {
    const labeled = mkts.map((m) => ({
      m,
      label: m.yes_sub_title || m.yes_subtitle || m.title || m.ticker || '',
    }));
    const homeM = labeled.filter((x) => teamsMatch(x.label, home));
    const awayM = labeled.filter((x) => teamsMatch(x.label, away));
    if (homeM.length === 1 && awayM.length === 1 && homeM[0].m !== awayM[0].m) {
      matches.push({ eventKey, home: homeM[0].m, away: awayM[0].m });
    }
  }
  if (matches.length !== 1) return null;

  const g = matches[0];
  const { role } = pickTeamFromCandidate(candidate);
  const pickM = role === 'home' ? g.home : role === 'away' ? g.away : null;
  const yesBid = pickM && (pickM.yes_bid != null ? pickM.yes_bid : pickM.yesBid);
  const yesAsk = pickM && (pickM.yes_ask != null ? pickM.yes_ask : pickM.yesAsk);
  const last = pickM && (pickM.last_price != null ? pickM.last_price : pickM.lastPrice);
  const implied = centsToProb(last != null ? last : yesBid);
  return {
    venue: 'kalshi',
    eventTicker: g.eventKey,
    homeTicker: g.home.ticker,
    awayTicker: g.away.ticker,
    pickTicker: pickM ? pickM.ticker : null,
    impliedPick: implied,
    yesBid: centsToProb(yesBid),
    yesAsk: centsToProb(yesAsk),
    lastPrice: centsToProb(last),
    volume: pickM && pickM.volume != null ? Number(pickM.volume) : null,
    openInterest: pickM && pickM.open_interest != null ? Number(pickM.open_interest) : null,
  };
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'WeBetOmegaPmObserver/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function fetchPolymarketSportsMl({ limit = 200 } = {}) {
  const url = `${POLY_GAMMA}/markets?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`;
  const data = await fetchJson(url);
  const arr = Array.isArray(data) ? data : (data.markets || []);
  return arr.filter((m) => {
    const smt = String(m.sportsMarketType || '').toLowerCase();
    if (smt === 'moneyline' || smt === 'ml') return true;
    return /^(mlb|nfl|nba|nhl|ncaaf|cfb)-/i.test(String(m.slug || ''));
  });
}

async function fetchKalshiSportsMl({ sports = ['MLB', 'NFL', 'NCAAF'] } = {}) {
  const want = new Set(sports);
  const series = KALSHI_ML_SERIES.filter((s) => want.has(s.sport));
  const out = [];
  const errors = [];
  for (const s of series) {
    try {
      const url = `${KALSHI_API}/markets?series_ticker=${encodeURIComponent(s.series)}&status=open&limit=200`;
      const data = await fetchJson(url);
      const mkts = data.markets || [];
      for (const m of mkts) out.push({ ...m, _sport: s.sport, _series: s.series });
    } catch (e) {
      errors.push({ series: s.series, sport: s.sport, error: e.message, status: e.status || null });
    }
  }
  return { markets: out, errors };
}

function buildObserverNotes(candidates, { polyMarkets = [], kalshiMarkets = [] } = {}) {
  const notes = [];
  for (const c of candidates || []) {
    if (!isMoneylineCandidate(c)) continue;
    if (!c.homeTeam || !c.awayTeam) continue;
    const base = {
      sport: c.sport,
      matchup: c.matchup || `${c.awayTeam} @ ${c.homeTeam}`,
      side: c.side || c.pick || null,
      market: c.market || 'Moneyline',
      homeTeam: c.homeTeam,
      awayTeam: c.awayTeam,
      snapshot: {
        rating: c.rating != null ? c.rating : null,
        units: c.units != null ? c.units : null,
        edgePct: c.edgePct != null ? c.edgePct : null,
        ev: c.ev != null ? c.ev : null,
        coverProb: c.coverProb != null ? c.coverProb : null,
      },
      polymarket: null,
      kalshi: null,
    };
    try { base.polymarket = mapPolymarketMoneyline(c, polyMarkets); } catch (_) { base.polymarket = null; }
    try { base.kalshi = mapKalshiMoneyline(c, kalshiMarkets); } catch (_) { base.kalshi = null; }
    if (base.polymarket || base.kalshi) notes.push(base);
  }
  return notes;
}

function assertNeverMutatesPicks(beforePicks, afterPicks) {
  const b = beforePicks || [];
  const a = afterPicks || [];
  if (b.length !== a.length) {
    throw new Error(`pm-observer mutated pick count ${b.length}→${a.length}`);
  }
  for (let i = 0; i < b.length; i++) {
    for (const k of ['rating', 'units', 'edgePct', 'ev', 'coverProb', 'pick', 'odds', 'confidence']) {
      if (JSON.stringify(b[i][k]) !== JSON.stringify(a[i][k])) {
        throw new Error(`pm-observer mutated picks[${i}].${k}`);
      }
    }
  }
  return true;
}

/**
 * Soft-fail observer run. API outages yield empty notes + source errors — never throw.
 */
async function runPmObserver({
  dateISO,
  candidates = [],
  picks = [],
  modelVersion = null,
} = {}) {
  const started = new Date().toISOString();
  const sources = {
    polymarket: { ok: false, count: 0, error: null },
    kalshi: { ok: false, count: 0, error: null, seriesErrors: [] },
  };

  const pool = [];
  const seen = new Set();
  for (const c of [...(picks || []), ...(candidates || [])]) {
    const key = `${c.sport}|${c.homeTeam}|${c.awayTeam}|${c.side || c.pick}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(c);
  }

  let polyMarkets = [];
  let kalshiMarkets = [];
  try {
    polyMarkets = await fetchPolymarketSportsMl();
    sources.polymarket = { ok: true, count: polyMarkets.length, error: null };
  } catch (e) {
    sources.polymarket = { ok: false, count: 0, error: e.message };
  }
  try {
    const sports = [...new Set(pool.map((c) => c.sport).filter(Boolean))];
    const k = await fetchKalshiSportsMl({ sports: sports.length ? sports : ['MLB', 'NFL', 'NCAAF'] });
    kalshiMarkets = k.markets;
    sources.kalshi = {
      ok: k.errors.length === 0 || k.markets.length > 0,
      count: k.markets.length,
      error: k.errors.length ? k.errors.map((x) => x.error).join('; ') : null,
      seriesErrors: k.errors,
    };
  } catch (e) {
    sources.kalshi = { ok: false, count: 0, error: e.message, seriesErrors: [] };
  }

  const before = (picks || []).map((p) => ({ ...p }));
  const notes = buildObserverNotes(pool, { polyMarkets, kalshiMarkets });
  assertNeverMutatesPicks(before, picks);

  return {
    observer: 'omega-pm-observer',
    version: 'v1',
    date: dateISO || null,
    modelVersion: modelVersion || null,
    fetchedAt: started,
    completedAt: new Date().toISOString(),
    sources,
    mappedCount: notes.length,
    notes,
    disclaimer:
      'OBSERVER ONLY — prediction-market implied probs are logged for research. '
      + 'They do not feed Omega selection, grades, unit caps, or gates. No orders placed.',
  };
}

module.exports = {
  normTeam,
  teamsMatch,
  isMoneylineCandidate,
  mapPolymarketMoneyline,
  mapKalshiMoneyline,
  buildObserverNotes,
  assertNeverMutatesPicks,
  fetchPolymarketSportsMl,
  fetchKalshiSportsMl,
  runPmObserver,
  KALSHI_ML_SERIES,
  POLY_GAMMA,
  KALSHI_API,
};
