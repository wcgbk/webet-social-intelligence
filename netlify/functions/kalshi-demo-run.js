// kalshi-demo-run.js
// INTERNAL Kalshi auto-bet DEMO simulator (paper trading only — NO real money, NO live orders).
// GET /.netlify/functions/kalshi-demo-run?key=<KALSHI_DEMO_KEY>[&date=YYYY-MM-DD]
//
// Purpose: internal live-betting testing. Reads the Grok bot's live sportsbook picks
// (the `live-picks` blob store) READ-ONLY, and simulates what a Kalshi auto-bet model WOULD do
// with each pick as it arrives:
//   1. Try to map the pick to a real Kalshi market and record a DRY-RUN entry at the public ask.
//   2. If no Kalshi market exists (integer totals, unsupported sport, thin/absent book), fall back
//      to a book-odds paper bet at the pick's own stated odds so every pick is always simulated.
// Picks are graded from `finalWL`/`result` as the bot re-POSTs settlements, and a running paper
// P/L is tracked. Once a pick has an entry it is LOCKED (entry price/contracts frozen) so re-runs
// are idempotent and prices don't drift between polls.
//
// ISOLATION (by design — see the two hard constraints for this feature):
//   * This is 100% SEPARATE from the live-picks feature, the public site, and the user dashboard.
//   * It NEVER writes to / mutates / triggers the `live-picks` store or the Grok bot. It only READS.
//   * It has its OWN blob store `kalshi-demo` and its OWN internal page (/kalshi-demo).
//   * It contains NO order-placement code and never calls any authenticated Kalshi endpoint.
//     Kalshi market data is read from the PUBLIC (unsigned) API; if that fails, it falls back to book.
//
// Auth: `?key=` must equal env KALSHI_DEMO_KEY, else LIVE_PICKS_KEY (so the same key that unlocks
// /live-picks also unlocks this demo — Ben's choice), else PICKS_SECRET_KEY. The picks it surfaces
// are premium, so the endpoint fails closed if none of those is set.
// Storage: Netlify Blobs REST API (the SDK is unavailable on git-based deploys of this site).

const SITE_ID = process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const LIVE_STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/live-picks`;   // READ ONLY
const DEMO_STORE_URL = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/kalshi-demo`;  // our own store

const KALSHI_PUBLIC_BASE = 'https://api.elections.kalshi.com/trade-api/v2'; // public market data, no auth
const DOLLAR_PER_UNIT = 150;   // matches the live feed's "1 unit = $150"
const MAX_NEW_KALSHI_TRIES = 15; // cap live Kalshi lookups per run (rest fall back to book)
const KALSHI_TIMEOUT_MS = 3500;  // per public-API call

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Kalshi game/total/spread series by "<SPORT>_<betType>".
const SERIES_MAP = {
  NBA_Moneyline: 'KXNBAGAME', NBA_Total: 'KXNBATOTAL', NBA_Spread: 'KXNBASPREAD',
  NHL_Moneyline: 'KXNHLGAME', NHL_Total: 'KXNHLTOTAL', NHL_Spread: 'KXNHLSPREAD',
  MLB_Moneyline: 'KXMLBGAME', MLB_Total: 'KXMLBTOTAL', MLB_Spread: 'KXMLBSPREAD',
};

const KALSHI_ABBREV_MAP = {
  'brooklyn': 'bkn', 'golden state': 'gs', 'oklahoma city': 'okc', 'new york': 'nyk',
  'new orleans': 'no', 'san antonio': 'sa', 'los angeles lakers': 'lal', 'los angeles clippers': 'lac',
  'la lakers': 'lal', 'la clippers': 'lac', 'portland': 'por', 'minnesota': 'min', 'philadelphia': 'phi',
  'washington': 'wsh', 'sacramento': 'sac', 'indiana': 'ind', 'tampa bay': 'tb', 'st louis': 'stl',
  'st. louis': 'stl', 'columbus': 'cbj', 'new jersey': 'nj', 'new york islanders': 'nyi',
  'new york rangers': 'nyr', 'san jose': 'sj', 'vegas': 'vgk', 'las vegas': 'vgk', 'utah': 'uta',
  'anaheim': 'ana', 'arizona': 'ari', 'colorado': 'col', 'nashville': 'nsh', 'winnipeg': 'wpg',
  'vancouver': 'van', 'calgary': 'cgy', 'edmonton': 'edm', 'seattle': 'sea',
};

// ── small helpers ──
function getEasternDateToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}
function normalizeTeam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function getTeamWords(name) {
  return normalizeTeam(name).split(' ').filter((w) => w.length >= 4);
}
function wordInText(word, text) {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}
function extractTeams(matchup) {
  return (matchup || '').split(/\s+(?:vs\.?|@|at|v)\s+/i).map((s) => s.trim()).filter(Boolean);
}
function getCityAbbrev(teamName) {
  const n = normalizeTeam(teamName);
  for (const [key, abbr] of Object.entries(KALSHI_ABBREV_MAP)) {
    if (n.startsWith(key) || n.includes(key)) return abbr;
  }
  return (getTeamWords(teamName)[0] || '').substring(0, 3);
}
// Stable identity of a pick across the day's re-POSTs (odds drift, so exclude them).
function seqKey(s) {
  return [s.sport, s.event, s.pick].map((x) => (x == null ? '' : String(x)).toLowerCase().trim()).join('|');
}
function normResult(s) {
  const r = String(s.finalWL || s.result || '').toUpperCase();
  if (r === 'W' || r === 'WIN') return 'W';
  if (r === 'L' || r === 'LOSS' || r === 'LOSE') return 'L';
  if (r === 'P' || r === 'PUSH') return 'P';
  return null; // open / ungraded
}
// American odds → { implied prob, profit per $1 staked }
function parseAmerican(odds) {
  const o = parseInt(String(odds).replace(/[^\d+-]/g, ''), 10);
  if (!isFinite(o) || o === 0) return { implied: 0.5, profit: 1 }; // even-ish default
  if (o < 0) return { implied: Math.abs(o) / (Math.abs(o) + 100), profit: 100 / Math.abs(o) };
  return { implied: 100 / (o + 100), profit: o / 100 };
}

// Classify the pick into a betType + direction + line + team from its text.
function classify(sel) {
  const pickStr = String(sel.pick || '');
  const sport = String(sel.sport || '').toUpperCase().trim();
  const lineNum = (sel.line != null && isFinite(Number(sel.line))) ? Number(sel.line) : null;

  const ou = pickStr.match(/(over|under|o|u)\s*([\d.]+)/i);
  if (ou && /over|under|\bo\b|\bu\b/i.test(pickStr)) {
    return { sport, betType: 'Total', direction: ou[1].toLowerCase().startsWith('o') ? 'over' : 'under',
             targetLine: parseFloat(ou[2]), team: null };
  }
  const spread = pickStr.match(/([+-]\d+(?:\.\d+)?)/);
  if (spread) {
    return { sport, betType: 'Spread', direction: 'spread', targetLine: parseFloat(spread[1]),
             team: pickStr.replace(/[+-]\d+(?:\.\d+)?.*$/, '').trim() };
  }
  return { sport, betType: 'Moneyline', direction: 'moneyline', targetLine: lineNum,
           team: pickStr.replace(/\s*(ML|moneyline)\s*$/i, '').trim() };
}

// ── public Kalshi fetch (unsigned) with timeout ──
async function kpublic(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), KALSHI_TIMEOUT_MS);
  try {
    const r = await fetch(`${KALSHI_PUBLIC_BASE}${path}`, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fetch + reduce an orderbook to best yes/no ask prices (dollars, 0..1) and total $ depth.
async function getBook(ticker) {
  const data = await kpublic(`/markets/${encodeURIComponent(ticker)}/orderbook?depth=10`);
  if (!data) return null;
  const book = data.orderbook_fp || data.orderbook || {};
  const yesLevels = book.yes_dollars || book.yes || [];
  const noLevels = book.no_dollars || book.no || [];
  let yesBid = 0, noBid = 0, depth = 0;
  for (const [p, q] of yesLevels) { const P = parseFloat(p), Q = parseFloat(q); if (P > yesBid) yesBid = P; depth += P * Q; }
  for (const [p, q] of noLevels) { const P = parseFloat(p), Q = parseFloat(q); if (P > noBid) noBid = P; depth += P * Q; }
  // Buying YES costs (1 - best no bid); buying NO costs (1 - best yes bid). Guard both.
  const yesAsk = noBid > 0 ? 1 - noBid : null;
  const noAsk = yesBid > 0 ? 1 - yesBid : null;
  return { yesAsk, noAsk, totalDepth: Math.round(depth * 100) / 100 };
}

// Best-effort match of a classified pick to a Kalshi market. Returns {ticker,title,side,line} or null.
// Uses a per-run market cache keyed by series to avoid refetching.
async function matchKalshi(cls, matchup, seriesCache) {
  const series = SERIES_MAP[`${cls.sport}_${cls.betType}`];
  if (!series) return null;

  if (!seriesCache[series]) {
    const data = await kpublic(`/markets?series_ticker=${series}&status=open&limit=500`);
    seriesCache[series] = (data && Array.isArray(data.markets)) ? data.markets : [];
  }
  const markets = seriesCache[series];
  if (!markets.length) return null;

  const teams = extractTeams(matchup);
  const abbrevs = teams.map((t) => getCityAbbrev(t));
  const candidates = markets.filter((m) => {
    const combined = `${m.title || ''} ${m.yes_sub_title || ''} ${m.ticker || ''}`.toLowerCase();
    const et = (m.event_ticker || '').toLowerCase();
    let hit = 0;
    for (const team of teams) if (getTeamWords(team).some((w) => wordInText(w, combined))) hit++;
    if (hit >= Math.min(2, teams.length) && teams.length) return true;
    if (abbrevs.length >= 2 && abbrevs.every((a) => a.length >= 3 && et.includes(a))) return true;
    return false;
  });
  if (!candidates.length) return null;

  if (cls.direction === 'over' || cls.direction === 'under') {
    let best = null, bestDiff = Infinity, bestLine = null;
    for (const m of candidates) {
      const sub = (m.yes_sub_title || '').toLowerCase();
      const tkr = (m.ticker || '').match(/-(\d+)$/);
      const line = (m.cap_strike ?? m.floor_strike ?? (sub.match(/([\d.]+)/) ? parseFloat(sub.match(/([\d.]+)/)[1]) : (tkr ? parseFloat(tkr[1]) + 0.5 : null)));
      if (line != null && cls.targetLine != null) {
        const d = Math.abs(line - cls.targetLine);
        if (d < bestDiff) { bestDiff = d; best = m; bestLine = line; }
      }
    }
    if (!best || bestDiff > 1.0) return null; // Kalshi totals are .5-only; refuse if >1 off (integer-line picks)
    const sub = (best.yes_sub_title || '').toLowerCase();
    const yesIsOver = sub.includes('over') || (!sub.includes('under') && !sub.includes('fewer'));
    const side = (cls.direction === 'over') === yesIsOver ? 'yes' : 'no';
    return { ticker: best.ticker, title: best.title || best.yes_sub_title || best.ticker, side, line: bestLine };
  }

  if (cls.direction === 'spread') {
    let best = null, bestDiff = Infinity, bestLine = null;
    const target = Math.abs(cls.targetLine ?? 0);
    for (const m of candidates) {
      const sub = (m.yes_sub_title || m.title || '').toLowerCase();
      const sm = sub.match(/(?:over|by)\s+([\d.]+)/i);
      const tkr = (m.ticker || '').match(/(\d+)$/);
      const line = sm ? parseFloat(sm[1]) : (tkr ? parseFloat(tkr[1]) + 0.5 : null);
      if (line != null) { const d = Math.abs(line - target); if (d < bestDiff) { bestDiff = d; best = m; bestLine = line; } }
    }
    if (!best || bestDiff > 1.0) return null;
    return { ticker: best.ticker, title: best.title || best.ticker, side: 'yes', line: bestLine };
  }

  // Moneyline: pick the per-team "will X win" market whose text contains the pick team.
  const teamWords = getTeamWords(cls.team);
  let ml = candidates.find((m) => {
    const t = `${m.title || ''} ${m.yes_sub_title || ''}`.toLowerCase();
    return teamWords.some((w) => wordInText(w, t));
  }) || candidates[0];
  return { ticker: ml.ticker, title: ml.title || ml.yes_sub_title || ml.ticker, side: 'yes', line: null };
}

// ── blob helpers (our store only for writes) ──
async function blobGetJSON(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return await r.json().catch(() => null);
  } catch (e) { /* ignore */ }
  return null;
}
async function blobGetText(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return (await r.text()).trim();
  } catch (e) { /* ignore */ }
  return null;
}
async function blobPut(url, token, body, contentType) {
  return fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Compute paper P/L for one simulated entry given its result.
function settle(entry, result) {
  if (!result) return { result: null, pnl: null };
  if (result === 'P') return { result: 'P', pnl: 0 };
  if (entry.mode === 'kalshi') {
    const c = entry.contracts || 0, p = entry.entryPrice || 0;
    return { result, pnl: Math.round((result === 'W' ? c * (1 - p) : -c * p) * 100) / 100 };
  }
  // book paper
  const stake = entry.stake || 0;
  return { result, pnl: Math.round((result === 'W' ? stake * (entry.bookProfit || 0) : -stake) * 100) / 100 };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const params = event.queryStringParameters || {};
  const gate = process.env.KALSHI_DEMO_KEY || process.env.LIVE_PICKS_KEY || process.env.PICKS_SECRET_KEY;
  if (!gate) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: true, status: 'NOT_CONFIGURED', message: 'No gate key set (KALSHI_DEMO_KEY / LIVE_PICKS_KEY / PICKS_SECRET_KEY).' }) };
  }
  if (params.key !== gate) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: true, message: 'Unauthorized' }) };
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Storage not configured' }) };
  }

  try {
    // 1. Resolve the date + read the Grok live-picks card READ-ONLY.
    const requested = (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) ? params.date : null;
    let dateKey = requested || getEasternDateToday();
    let card = await blobGetJSON(`${LIVE_STORE_URL}/picks-${dateKey}`, token);
    if (!card && !requested) {
      const latest = await blobGetText(`${LIVE_STORE_URL}/latest-date`, token);
      if (latest && /^\d{4}-\d{2}-\d{2}$/.test(latest) && latest !== dateKey) {
        const d2 = await blobGetJSON(`${LIVE_STORE_URL}/picks-${latest}`, token);
        if (d2) { card = d2; dateKey = latest; }
      }
    }
    const selections = (card && Array.isArray(card.selections)) ? card.selections : [];

    // 2. Load our prior demo log for this date so existing entries stay LOCKED (price/contracts frozen).
    const prior = await blobGetJSON(`${DEMO_STORE_URL}/exec-${dateKey}`, token);
    const priorByKey = {};
    if (prior && Array.isArray(prior.entries)) prior.entries.forEach((e) => { priorByKey[e.key] = e; });

    // 3. Simulate each selection.
    const seriesCache = {};
    let newKalshiTries = 0;
    let matchDeadlineHit = false;

    const entries = await Promise.all(selections.map(async (sel) => {
      const key = seqKey(sel);
      const cls = classify(sel);
      const units = (sel.units != null && isFinite(Number(sel.units))) ? Math.max(0, Number(sel.units)) : 1;
      const stake = Math.round(units * DOLLAR_PER_UNIT * 100) / 100;
      const american = parseAmerican(sel.odds);
      const result = normResult(sel);

      const base = {
        key,
        sport: sel.sport || '', event: sel.event || '', pick: sel.pick || '',
        odds: sel.odds || '', units, stake, betType: cls.betType, direction: cls.direction,
        firstSeq: Number(sel.firstSeq) || 0,
      };

      const existing = priorByKey[key];
      if (existing && existing.entry) {
        // LOCKED: keep the original entry, only re-settle from the latest result.
        const s = settle(existing.entry, result);
        return { ...base, entry: existing.entry, status: result ? (result === 'W' ? 'won' : result === 'L' ? 'lost' : 'push') : 'open', result: s.result, pnl: s.pnl };
      }

      // New pick → try Kalshi (best-effort, capped), else book fallback.
      let match = null;
      if (SERIES_MAP[`${cls.sport}_${cls.betType}`] && newKalshiTries < MAX_NEW_KALSHI_TRIES && !matchDeadlineHit) {
        newKalshiTries++;
        try {
          match = await matchKalshi(cls, sel.event, seriesCache);
        } catch (e) { match = null; }
      } else if (newKalshiTries >= MAX_NEW_KALSHI_TRIES) {
        matchDeadlineHit = true;
      }

      let entry;
      if (match) {
        const book = await getBook(match.ticker);
        const price = book ? (match.side === 'yes' ? book.yesAsk : book.noAsk) : null;
        if (price && price > 0.01 && price < 0.99) {
          const contracts = Math.max(1, Math.floor(stake / price));
          entry = {
            mode: 'kalshi', ticker: match.ticker, title: match.title, side: match.side,
            kalshiLine: match.line, entryPrice: Math.round(price * 100) / 100,
            contracts, cost: Math.round(contracts * price * 100) / 100,
            bookDepth: book.totalDepth, note: 'dry-run — would place order (KALSHI_ENABLED off; demo never places)',
          };
        }
      }
      if (!entry) {
        // Book-odds paper fallback — guaranteed coverage.
        entry = {
          mode: 'book', entryImplied: Math.round(american.implied * 1000) / 10,
          bookProfit: Math.round(american.profit * 1000) / 1000, stake,
          note: match ? 'no valid Kalshi price — book paper' : 'no Kalshi market — book paper',
        };
      }

      const s = settle(entry, result);
      return { ...base, entry, status: result ? (result === 'W' ? 'won' : result === 'L' ? 'lost' : 'push') : 'open', result: s.result, pnl: s.pnl };
    }));

    // 4. KPIs.
    let w = 0, l = 0, p = 0, open = 0, kalshiCount = 0, bookCount = 0, staked = 0, pnl = 0, units = 0;
    entries.forEach((e) => {
      if (e.entry.mode === 'kalshi') kalshiCount++; else bookCount++;
      staked += (e.entry.mode === 'kalshi' ? (e.entry.cost || 0) : (e.stake || 0));
      if (e.result === 'W') { w++; units += e.units; }
      else if (e.result === 'L') { l++; units -= e.units; }
      else if (e.result === 'P') { p++; }
      else open++;
      if (e.pnl != null) pnl += e.pnl;
    });
    const graded = w + l + p;
    const kpis = {
      total: entries.length, kalshiEntries: kalshiCount, bookEntries: bookCount,
      graded, wins: w, losses: l, pushes: p, open,
      winRate: (w + l) ? Math.round((w / (w + l)) * 1000) / 10 : null,
      staked: Math.round(staked * 100) / 100,
      paperPnl: Math.round(pnl * 100) / 100,
      roi: staked ? Math.round((pnl / staked) * 1000) / 10 : null,
      units: Math.round(units * 100) / 100,
    };

    // Newest-added first (mirror the live feed's ordering).
    entries.sort((a, b) => (b.firstSeq || 0) - (a.firstSeq || 0));

    const log = {
      mode: 'DEMO', realMoney: false, source: (card && card.source) || 'Live Sportsbook Picks (Grok feed)',
      date: dateKey, ranAt: new Date().toISOString(),
      feedFetchedAt: (card && card.fetchedAt) || null, feedReceivedAt: (card && card.receivedAt) || null,
      dollarPerUnit: DOLLAR_PER_UNIT, matchDeadlineHit, kpis, entries,
    };

    // 5. Persist to OUR store only.
    await blobPut(`${DEMO_STORE_URL}/exec-${dateKey}`, token, log);
    await blobPut(`${DEMO_STORE_URL}/latest`, token, log);
    const datesBlob = await blobGetJSON(`${DEMO_STORE_URL}/exec-dates`, token);
    const dates = Array.isArray(datesBlob) ? datesBlob : [];
    if (!dates.includes(dateKey)) { dates.push(dateKey); dates.sort(); await blobPut(`${DEMO_STORE_URL}/exec-dates`, token, dates); }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(log) };
  } catch (err) {
    console.error('[kalshi-demo-run]', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: true, message: 'Demo run failed', detail: err.message }) };
  }
};
