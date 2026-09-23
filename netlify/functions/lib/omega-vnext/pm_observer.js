'use strict';
/**
 * Omega prediction markets (Kalshi + Polymarket).
 *
 * Two uses, both read-only (public GETs, no orders):
 * 1. Soft score features at generate, before selectStraights. Moneyline
 *    1:1 maps become pmVsBookGap / pmMove and a HARD-CAPPED _pmScoreAdj
 *    (PM_SOFT.maxAbsScoreAdj). Missing map or API failure → adjustment 0.
 *    This path does not write coverProb, edgePct, EV, gates, Kelly, or units.
 * 2. Observer audit. runPmObserver logs implieds to omega-pm-observer/{date}.
 *    The morning open snap is omega-pm-observer/{date}-open. The audit write
 *    still never mutates locked pick rating, units, edge, EV, or coverProb.
 *
 * Blob keys (edge-picks-omega):
 *   omega-pm-observer/{date}        post-card audit (+ alias pm-sidecar-{date})
 *   omega-pm-observer/{date}-open   morning snap for pmMove (+ alias -open)
 */

const { PM_SOFT } = require('./config');
const { americanToImplied } = require('./odds_math');

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
 * Audit copy. Soft score may already have been applied upstream at generate.
 * This logging path does not change locked picks.
 */
const OBSERVER_DISCLAIMER =
  'Prediction-market implied probs are an audit log. The observer write path does not mutate locked pick rating, units, edge, EV, or coverProb. '
  + 'At generate, moneyline soft features may adjust selection score only via hard-capped _pmScoreAdj (PM_SOFT.maxAbsScoreAdj). '
  + 'Gates, Kelly, grades, unit caps, and shrink are unchanged. No orders placed.';

function finiteProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

function round6(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function average(vals) {
  if (!vals || !vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** fair_sharp_p (or sharpFairP alias) first, else vigged American implied. */
function bookImpliedForCandidate(c) {
  const fair = finiteProb(c && c.fair_sharp_p);
  if (fair != null) return { bookImplied: fair, bookImpliedSource: 'fair_sharp_p' };
  const alias = finiteProb(c && c.sharpFairP);
  if (alias != null) return { bookImplied: alias, bookImpliedSource: 'fair_sharp_p' };
  const odds = c && (c.odds != null && c.odds !== '' ? c.odds : c.oddsStr);
  const implied = finiteProb(americanToImplied(odds));
  if (implied != null) return { bookImplied: implied, bookImpliedSource: 'american' };
  return { bookImplied: null, bookImpliedSource: null };
}

function venueImpliedMap(polyMap, kalshiMap) {
  const out = {};
  const poly = finiteProb(polyMap && polyMap.impliedPick);
  const kalshi = finiteProb(kalshiMap && kalshiMap.impliedPick);
  if (poly != null) out.polymarket = poly;
  if (kalshi != null) out.kalshi = kalshi;
  return out;
}

function mappedVenueImplieds(candidate, polyMarkets, kalshiMarkets) {
  let poly = null;
  let kalshi = null;
  try { poly = mapPolymarketMoneyline(candidate, polyMarkets); } catch (_) { poly = null; }
  try { kalshi = mapKalshiMoneyline(candidate, kalshiMarkets); } catch (_) { kalshi = null; }
  return venueImpliedMap(poly, kalshi);
}

function noteMatchesCandidate(candidate, note) {
  if (!candidate || !note) return false;
  if (candidate.sport && note.sport && candidate.sport !== note.sport) return false;
  if (candidate.homeTeam && note.homeTeam && !teamsMatch(candidate.homeTeam, note.homeTeam)) return false;
  if (candidate.awayTeam && note.awayTeam && !teamsMatch(candidate.awayTeam, note.awayTeam)) return false;
  const side = candidate.side || candidate.pick || '';
  const nSide = note.side || '';
  if (side && nSide && !teamsMatch(side, nSide)) return false;
  return !!(candidate.homeTeam || candidate.awayTeam || side);
}

/**
 * Prior venue implieds from an open snap (raw markets) or, if the snap has
 * no raw arrays, from observer notes. Null when there is no snap.
 */
function priorVenueImplieds(candidate, priorArtifact) {
  if (!priorArtifact || typeof priorArtifact !== 'object') return null;
  const hasRaw = Array.isArray(priorArtifact.polyMarkets) || Array.isArray(priorArtifact.kalshiMarkets);
  if (hasRaw) {
    return mappedVenueImplieds(
      candidate,
      priorArtifact.polyMarkets || [],
      priorArtifact.kalshiMarkets || [],
    );
  }
  if (!Array.isArray(priorArtifact.notes)) return null;
  const note = priorArtifact.notes.find((n) => noteMatchesCandidate(candidate, n));
  if (!note) return null;
  return venueImpliedMap(note.polymarket, note.kalshi);
}

function emptyPmFeatures(reason) {
  return {
    pmVsBookGap: null,
    pmMove: null,
    pmImplied: null,
    bookImplied: null,
    bookImpliedSource: null,
    venues: [],
    _pmScoreAdj: 0,
    capped: false,
    reason: reason || 'unmapped',
  };
}

/**
 * Score-only PM features for one candidate. Never writes coverProb / edge / EV.
 * _pmScoreAdj is 0 when the candidate is not a clean moneyline map.
 */
function computePmFeatures(candidate, {
  polyMarkets = [],
  kalshiMarkets = [],
  priorArtifact = null,
  pmSoft = null,
} = {}) {
  const cfg = pmSoft || PM_SOFT;
  if (!candidate || !isMoneylineCandidate(candidate)) {
    return { pmFeatures: emptyPmFeatures('not-moneyline'), _pmScoreAdj: 0 };
  }

  const now = mappedVenueImplieds(candidate, polyMarkets, kalshiMarkets);
  const venues = Object.keys(now);
  const pmImplied = average(venues.map((v) => now[v]));
  const book = bookImpliedForCandidate(candidate);

  if (pmImplied == null || book.bookImplied == null) {
    const reason = pmImplied == null ? 'no-map' : 'no-book-implied';
    return {
      _pmScoreAdj: 0,
      pmFeatures: {
        ...emptyPmFeatures(reason),
        pmImplied: pmImplied == null ? null : round6(pmImplied),
        bookImplied: book.bookImplied == null ? null : round6(book.bookImplied),
        bookImpliedSource: book.bookImpliedSource,
        venues,
      },
    };
  }

  const pmVsBookGap = pmImplied - book.bookImplied;
  const prior = priorVenueImplieds(candidate, priorArtifact);
  const paired = prior ? venues.filter((v) => prior[v] != null) : [];
  const pmMove = paired.length
    ? average(paired.map((v) => now[v] - prior[v]))
    : null;

  const wGap = Number(cfg.scoreWeightVsBook) || 0;
  const wMove = Number(cfg.scoreWeightMove) || 0;
  const raw = (wGap * pmVsBookGap) + (pmMove == null ? 0 : wMove * pmMove);
  const cap = Math.abs(Number(cfg.maxAbsScoreAdj));
  let adj = raw;
  let capped = false;
  if (!Number.isFinite(cap)) {
    adj = 0;
  } else if (raw > cap) {
    adj = cap;
    capped = true;
  } else if (raw < -cap) {
    adj = -cap;
    capped = true;
  } else {
    adj = round6(raw);
  }

  return {
    _pmScoreAdj: adj,
    pmFeatures: {
      pmVsBookGap: round6(pmVsBookGap),
      pmMove: pmMove == null ? null : round6(pmMove),
      pmImplied: round6(pmImplied),
      bookImplied: round6(book.bookImplied),
      bookImpliedSource: book.bookImpliedSource,
      venues,
      _pmScoreAdj: adj,
      capped,
      reason: null,
    },
  };
}

function priorSnapUsable(priorArtifact) {
  if (!priorArtifact || typeof priorArtifact !== 'object') return false;
  if (Array.isArray(priorArtifact.polyMarkets) && priorArtifact.polyMarkets.length) return true;
  if (Array.isArray(priorArtifact.kalshiMarkets) && priorArtifact.kalshiMarkets.length) return true;
  if (Array.isArray(priorArtifact.notes) && priorArtifact.notes.length) return true;
  return false;
}

async function loadSoftMarkets(candidates, opts = {}) {
  let polyMarkets = opts.polyMarkets;
  let kalshiMarkets = opts.kalshiMarkets;
  const sources = {
    polymarket: { ok: false, count: 0, error: null },
    kalshi: { ok: false, count: 0, error: null, seriesErrors: [] },
  };
  const fetchPoly = opts.fetchPolymarketSportsMl || fetchPolymarketSportsMl;
  const fetchKalshi = opts.fetchKalshiSportsMl || fetchKalshiSportsMl;

  if (polyMarkets == null) {
    try {
      const fetched = await fetchPoly();
      polyMarkets = Array.isArray(fetched) ? fetched : [];
      sources.polymarket = { ok: true, count: polyMarkets.length, error: null };
    } catch (e) {
      polyMarkets = [];
      sources.polymarket = { ok: false, count: 0, error: e.message };
    }
  } else {
    if (!Array.isArray(polyMarkets)) polyMarkets = [];
    sources.polymarket = { ok: true, count: polyMarkets.length, error: null, injected: true };
  }

  if (kalshiMarkets == null) {
    try {
      const fromOpts = Array.isArray(opts.sports) ? opts.sports.filter(Boolean) : [];
      const fromCands = [...new Set((candidates || []).map((c) => c.sport).filter(Boolean))];
      const sports = fromOpts.length ? fromOpts : fromCands;
      const k = await fetchKalshi({ sports: sports.length ? sports : ['MLB', 'NFL', 'NCAAF'] });
      kalshiMarkets = (k && k.markets) || [];
      const errors = (k && k.errors) || [];
      sources.kalshi = {
        ok: errors.length === 0 || kalshiMarkets.length > 0,
        count: kalshiMarkets.length,
        error: errors.length ? errors.map((x) => x.error).join('; ') : null,
        seriesErrors: errors,
      };
    } catch (e) {
      kalshiMarkets = [];
      sources.kalshi = { ok: false, count: 0, error: e.message, seriesErrors: [] };
    }
  } else {
    if (!Array.isArray(kalshiMarkets)) kalshiMarkets = [];
    sources.kalshi = { ok: true, count: kalshiMarkets.length, error: null, injected: true };
  }

  return { polyMarkets, kalshiMarkets, sources };
}

/**
 * Annotate candidates with pmFeatures + _pmScoreAdj. Never throws.
 * Pass polyMarkets/kalshiMarkets to skip the network (tests, or a snap already in hand).
 */
async function annotatePmSoftFeatures(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  try {
    const loaded = await loadSoftMarkets(list, opts);
    const priorArtifact = opts.priorArtifact || null;
    const next = list.map((c) => {
      try {
        const feat = computePmFeatures(c, {
          polyMarkets: loaded.polyMarkets,
          kalshiMarkets: loaded.kalshiMarkets,
          priorArtifact,
          pmSoft: opts.pmSoft,
        });
        return { ...c, pmFeatures: feat.pmFeatures, _pmScoreAdj: feat._pmScoreAdj };
      } catch (_) {
        return { ...c, pmFeatures: emptyPmFeatures('error'), _pmScoreAdj: 0 };
      }
    });
    return {
      candidates: next,
      sources: loaded.sources,
      priorOpen: priorSnapUsable(priorArtifact),
      polyMarkets: loaded.polyMarkets,
      kalshiMarkets: loaded.kalshiMarkets,
    };
  } catch (e) {
    return {
      candidates: list.map((c) => ({ ...c, pmFeatures: emptyPmFeatures('soft-fail'), _pmScoreAdj: 0 })),
      sources: {
        polymarket: { ok: false, count: 0, error: e.message },
        kalshi: { ok: false, count: 0, error: e.message, seriesErrors: [] },
      },
      priorOpen: false,
      error: e.message,
      polyMarkets: [],
      kalshiMarkets: [],
    };
  }
}

function compactPolyMarket(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    id: m.id || m.conditionId || null,
    slug: m.slug || null,
    question: m.question || m.title || null,
    sportsMarketType: m.sportsMarketType || m.sports_market_type || null,
    outcomes: m.outcomes,
    outcomePrices: m.outcomePrices != null ? m.outcomePrices : (m.outcome_prices || null),
    volume24hr: m.volume24hr != null ? m.volume24hr : (m.volume_24hr != null ? m.volume_24hr : null),
    liquidity: m.liquidity != null ? m.liquidity : null,
    endDate: m.endDate || m.end_date_iso || null,
  };
}

function compactKalshiMarket(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    ticker: m.ticker || null,
    event_ticker: m.event_ticker || m.eventTicker || null,
    yes_sub_title: m.yes_sub_title || m.yes_subtitle || m.title || null,
    title: m.title || null,
    last_price: m.last_price != null ? m.last_price : (m.lastPrice != null ? m.lastPrice : null),
    yes_bid: m.yes_bid != null ? m.yes_bid : (m.yesBid != null ? m.yesBid : null),
    yes_ask: m.yes_ask != null ? m.yes_ask : (m.yesAsk != null ? m.yesAsk : null),
    volume: m.volume != null ? m.volume : null,
    open_interest: m.open_interest != null ? m.open_interest : (m.openInterest != null ? m.openInterest : null),
    _sport: m._sport || null,
  };
}

/**
 * Morning open snap. Stores compact raw ML markets so 9:30 can compute pmMove
 * for whatever side is ranked — picks often do not exist yet at 8:30 ET.
 * Never throws. Does not require a published card.
 */
async function buildPmOpenArtifact({
  dateISO = null,
  candidates = [],
  picks = [],
  modelVersion = null,
  fetchPolymarketSportsMl: fetchPoly = null,
  fetchKalshiSportsMl: fetchKalshi = null,
  sports = null,
} = {}) {
  const started = new Date().toISOString();
  const before = (picks || []).map((p) => ({ ...p }));
  const loaded = await loadSoftMarkets(candidates, {
    fetchPolymarketSportsMl: fetchPoly || fetchPolymarketSportsMl,
    fetchKalshiSportsMl: fetchKalshi || fetchKalshiSportsMl,
    sports,
  });
  let notes = [];
  try {
    notes = buildObserverNotes(candidates || [], {
      polyMarkets: loaded.polyMarkets,
      kalshiMarkets: loaded.kalshiMarkets,
    });
  } catch (_) {
    notes = [];
  }
  try { assertNeverMutatesPicks(before, picks || []); } catch (e) {
    console.error(`[pm-observer] open snap mutate check: ${e.message}`);
  }
  return {
    observer: 'omega-pm-observer',
    slot: 'open',
    version: 'v1',
    date: dateISO || null,
    modelVersion: modelVersion || null,
    fetchedAt: started,
    completedAt: new Date().toISOString(),
    sources: loaded.sources,
    polyMarkets: (loaded.polyMarkets || []).map(compactPolyMarket).filter(Boolean),
    kalshiMarkets: (loaded.kalshiMarkets || []).map(compactKalshiMarket).filter(Boolean),
    mappedCount: notes.length,
    notes,
    disclaimer: OBSERVER_DISCLAIMER,
  };
}

/**
 * Soft-fail observer run. API outages yield empty notes + source errors — never throw.
 * Optional polyMarkets/kalshiMarkets skip a second fetch when the caller already has them.
 */
async function runPmObserver({
  dateISO,
  candidates = [],
  picks = [],
  modelVersion = null,
  polyMarkets = null,
  kalshiMarkets = null,
  fetchPolymarketSportsMl: fetchPoly = null,
  fetchKalshiSportsMl: fetchKalshi = null,
} = {}) {
  const started = new Date().toISOString();

  const pool = [];
  const seen = new Set();
  for (const c of [...(picks || []), ...(candidates || [])]) {
    const key = `${c.sport}|${c.homeTeam}|${c.awayTeam}|${c.side || c.pick}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(c);
  }

  const loaded = await loadSoftMarkets(pool, {
    polyMarkets,
    kalshiMarkets,
    fetchPolymarketSportsMl: fetchPoly || undefined,
    fetchKalshiSportsMl: fetchKalshi || undefined,
  });

  const before = (picks || []).map((p) => ({ ...p }));
  let notes = [];
  try {
    notes = buildObserverNotes(pool, {
      polyMarkets: loaded.polyMarkets,
      kalshiMarkets: loaded.kalshiMarkets,
    });
  } catch (_) {
    notes = [];
  }
  assertNeverMutatesPicks(before, picks);

  return {
    observer: 'omega-pm-observer',
    slot: 'post',
    version: 'v1',
    date: dateISO || null,
    modelVersion: modelVersion || null,
    fetchedAt: started,
    completedAt: new Date().toISOString(),
    sources: loaded.sources,
    mappedCount: notes.length,
    notes,
    disclaimer: OBSERVER_DISCLAIMER,
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
  computePmFeatures,
  annotatePmSoftFeatures,
  buildPmOpenArtifact,
  bookImpliedForCandidate,
  OBSERVER_DISCLAIMER,
  KALSHI_ML_SERIES,
  POLY_GAMMA,
  KALSHI_API,
};
