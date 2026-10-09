'use strict';

/**
 * Sharp closing prices for every gate-evaluated Omega candidate.
 *
 * Reads omega-candidates/{date} (today ET and yesterday ET). Writes only
 * clv-candidates-v2/{date}. Never picks-{date}, clv-{date}, or a KPI blob.
 *
 * One live GET /sports/{sport}/odds per sport per run, bookmakers limited to
 * the sharp set below (5 ≤ 10, so The Odds API bills it as one region).
 * markets=h2h,spreads,totals → 3 credits. GET /events is free and can skip
 * a sport whose future games are already off the board. No historical
 * endpoint (10×). Daily cap OMEGA_CANDIDATE_CLOSE_CREDIT_CAP, default 90,
 * tracked per ET day inside the blob.
 *
 * De-vig matches fair_sharp_p: sharpFairForSide order (Pinnacle, then Circa,
 * then the other sharp books), same-book pair only. A spread or total whose
 * sharp close is a different number stores that number's no-vig and
 * pointAdjusted. It does not shift the probability onto the candidate line.
 *
 * getStore() in the v1 lambda-compat runtime throws on setJSON/get when the
 * blobs context is missing. Writes and reads fall back to the Netlify REST
 * API, same as storeJson.
 */

const { SHARP_BOOKS, SITE_ID, BLOB_STORE } = require('./config');
const { collectMarketOutcomes, oppositeBundle } = require('./edge');
const { americanToImplied, noVigTwoWay, americanCentsDiff } = require('./odds_math');
const { etParts } = require('../et-schedule');
const { rowKey, sportKeyFor, candidateLedgerKey } = require('./candidate_ledger');

/** Odds API bookmaker keys. circasports is Circa's key. ≤10 → 1 region. */
const SHARP_CLOSE_BOOKS = ['pinnacle', 'circasports', 'lowvig', 'betonlineag', 'bookmaker'];
const MARKETS = 'h2h,spreads,totals';
/** 3 markets × 1 region. */
const CREDITS_PER_CALL = 3;
const DUE_BEFORE_MS = 20 * 60 * 1000;
const DUE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_CREDIT_CAP = 90;
const CLOSE_SCHEMA = 'clv-candidates-v2';

function candidateCloseKey(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`clv-candidates-v2 refused bad date: ${dateISO}`);
  }
  return `clv-candidates-v2/${d}`;
}

function creditCap(override, env) {
  if (Number.isFinite(override) && override >= 0) return override;
  const source = env || process.env;
  const raw = source.OMEGA_CANDIDATE_CLOSE_CREDIT_CAP;
  if (raw == null || String(raw).trim() === '') return DEFAULT_CREDIT_CAP;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return DEFAULT_CREDIT_CAP;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function etDayAndYesterday(now) {
  const etDay = etParts(now).ymd;
  return { etDay, dates: [etDay, shiftYmd(etDay, -1)] };
}

/**
 * Commence is due when it is within the next 20 minutes, or it started
 * less than 5 minutes ago. Exactly 5 minutes ago is already past the window.
 */
function isDue(commenceISO, nowMs) {
  const t = Date.parse(commenceISO);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return false;
  const delta = t - nowMs;
  return delta <= DUE_BEFORE_MS && delta > -DUE_AFTER_MS;
}

function hasClose(row) {
  return !!(row && row.closeNoVig != null && Number.isFinite(Number(row.closeNoVig)));
}

function samePoint(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= 1e-6;
}

function marketKeyOf(market, side) {
  const m = String(market || '');
  const s = String(side || '');
  if (/total/i.test(m) || /^\s*(over|under)\b/i.test(s)) return 'totals';
  if (/spread|run line|puck/i.test(m)) return 'spreads';
  return 'h2h';
}

function outcomeName(row) {
  const marketKey = marketKeyOf(row && row.market, row && row.side);
  const side = String((row && row.side) || '').trim();
  if (marketKey === 'totals') return /^under/i.test(side) ? 'Under' : 'Over';
  let name = side.replace(/\s+ML$/i, '').trim();
  if (marketKey === 'spreads') name = name.replace(/\s+[+-]\d+(\.\d+)?$/, '').trim();
  return name;
}

function finiteLine(line) {
  if (line == null || line === '') return null;
  const n = Number(line);
  return Number.isFinite(n) ? n : null;
}

function priceAt(bundle, book) {
  const want = String(book || '').toLowerCase();
  const row = (bundle && bundle.prices || []).find((p) => String(p.book || '').toLowerCase() === want && Number.isFinite(Number(p.american)));
  return row ? Number(row.american) : null;
}

function pairedAtBook(bundles, target, book) {
  if (!target) return null;
  const opp = oppositeBundle(bundles, target);
  if (!opp) return null;
  const sideOdds = priceAt(target, book);
  const oppOdds = priceAt(opp, book);
  if (sideOdds == null || oppOdds == null) return null;
  const nv = noVigTwoWay(sideOdds, oppOdds);
  if (!nv) return null;
  return {
    book: String(book).toLowerCase(),
    sideOdds,
    oppOdds,
    closeNoVig: nv.p1,
    line: target.point == null ? null : target.point,
  };
}

function closestPaired(bundles, name, line, book) {
  const want = String(name || '').toLowerCase();
  let best = null;
  let bestDist = Infinity;
  for (const bundle of bundles || []) {
    if (String(bundle.side || '').toLowerCase() !== want) continue;
    const paired = pairedAtBook(bundles, bundle, book);
    if (!paired) continue;
    const dist = line == null || bundle.point == null ? 0 : Math.abs(Number(bundle.point) - Number(line));
    if (dist < bestDist - 1e-9) {
      best = paired;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Same-book sharp no-vig for one candidate. Exact line wins across the sharp
 * order before any different line is considered. No mixed-book consensus and
 * no point-shift model.
 */
function devigCandidate(event, row) {
  if (!event || !row) return null;
  const marketKey = marketKeyOf(row.market, row.side);
  const name = outcomeName(row);
  if (!name) return null;
  const line = marketKey === 'h2h' ? null : finiteLine(row.line);
  const bundles = collectMarketOutcomes(event, marketKey);
  if (!bundles.length) return null;
  const exact = bundles.find((b) => String(b.side || '').toLowerCase() === name.toLowerCase() && samePoint(b.point, line));
  if (exact) {
    for (const book of SHARP_BOOKS) {
      const paired = pairedAtBook(bundles, exact, book);
      if (paired) return { ...paired, pointAdjusted: false };
    }
  }
  if (marketKey === 'h2h') return null;
  for (const book of SHARP_BOOKS) {
    const paired = closestPaired(bundles, name, line, book);
    if (!paired) continue;
    return { ...paired, pointAdjusted: !samePoint(paired.line, line) };
  }
  return null;
}

function cents(prob) {
  if (prob == null || !Number.isFinite(prob)) return null;
  return +(prob * 100).toFixed(2);
}

function stampClose(row, close, nowIso) {
  const frozen = row && row.fair_sharp_p_at_generate != null ? Number(row.fair_sharp_p_at_generate) : null;
  const fair = Number.isFinite(frozen) ? frozen : (row && row.fair_sharp_p != null ? Number(row.fair_sharp_p) : null);
  const fairOk = Number.isFinite(fair) ? fair : null;
  const clvProb = fairOk == null ? null : close.closeNoVig - fairOk;
  const offered = americanToImplied(row && row.odds);
  const clvVsOffered = offered == null ? null : close.closeNoVig - offered;
  return {
    closeAt: nowIso,
    closeBook: close.book,
    closeLine: close.line == null ? null : close.line,
    closeOddsPair: { side: close.sideOdds, opp: close.oppOdds },
    closeNoVig: close.closeNoVig,
    pointAdjusted: !!close.pointAdjusted,
    clvProb,
    clvProbCents: cents(clvProb),
    clvVsOffered,
    clvVsOfferedCents: cents(clvVsOffered),
    clvAmericanCents: close.pointAdjusted ? null : americanCentsDiff(row && row.odds, close.sideOdds),
    fair_sharp_p_at_generate: fairOk,
  };
}

const CLOSE_FIELDS = [
  'closeAt', 'closeBook', 'closeLine', 'closeOddsPair', 'closeNoVig', 'pointAdjusted',
  'clvProb', 'clvProbCents', 'clvVsOffered', 'clvVsOfferedCents', 'clvAmericanCents',
  'fair_sharp_p_at_generate', 'result', 'gradedAt',
];

function copyClose(row) {
  const out = {};
  if (!row) return out;
  for (const k of CLOSE_FIELDS) {
    if (row[k] != null) out[k] = row[k];
  }
  return out;
}

/**
 * Existing rows stay, including ones the new ledger dropped. Ledger fields
 * refresh under a prior close. A prior close is copied back on top so a
 * ledger row cannot blank it.
 */
function mergeCandidates(existingRows, ledgerRows) {
  const map = new Map();
  const order = [];
  const put = (key, row) => {
    if (!map.has(key)) order.push(key);
    map.set(key, row);
  };
  for (const row of existingRows || []) {
    if (!row) continue;
    put(rowKey(row), { ...row });
  }
  for (const row of ledgerRows || []) {
    if (!row) continue;
    const key = rowKey(row);
    const prev = map.get(key);
    if (!prev) put(key, { ...row });
    else put(key, { ...prev, ...row, ...copyClose(prev) });
  }
  return order.map((key) => map.get(key));
}

function overlayClose(prev, stamped) {
  const base = { ...(prev || {}) };
  const fairFrozen = base.fair_sharp_p_at_generate != null && Number.isFinite(Number(base.fair_sharp_p_at_generate));
  const fair = fairFrozen ? Number(base.fair_sharp_p_at_generate) : stamped.fair_sharp_p_at_generate;
  let clvProb = stamped.clvProb;
  let clvVsOffered = stamped.clvVsOffered;
  if (fairFrozen && stamped.closeNoVig != null) {
    clvProb = stamped.closeNoVig - fair;
    const offered = americanToImplied(base.odds);
    clvVsOffered = offered == null ? stamped.clvVsOffered : stamped.closeNoVig - offered;
  }
  return {
    ...base,
    closeAt: stamped.closeAt,
    closeBook: stamped.closeBook,
    closeLine: stamped.closeLine,
    closeOddsPair: stamped.closeOddsPair,
    closeNoVig: stamped.closeNoVig,
    pointAdjusted: stamped.pointAdjusted,
    clvProb,
    clvProbCents: cents(clvProb),
    clvVsOffered,
    clvVsOfferedCents: cents(clvVsOffered),
    clvAmericanCents: stamped.pointAdjusted ? null : stamped.clvAmericanCents,
    fair_sharp_p_at_generate: fair,
    result: base.result || null,
    gradedAt: base.gradedAt || null,
  };
}

function coverageBySportMarket(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const sport = (row && row.sport) || 'unknown';
    const market = (row && row.market) || 'unknown';
    const key = `${sport}|${market}`;
    if (!map.has(key)) map.set(key, { sport, market, candidates: 0, withClose: 0 });
    const g = map.get(key);
    g.candidates += 1;
    if (hasClose(row)) g.withClose += 1;
  }
  return [...map.values()].map((g) => ({
    ...g,
    pct: g.candidates ? Math.round((1000 * g.withClose) / g.candidates) / 10 : 0,
  }));
}

function creditsUsedOn(blobs, etDay) {
  let n = 0;
  for (const blob of blobs || []) {
    const day = blob && blob.credits && blob.credits.byEtDay && blob.credits.byEtDay[etDay];
    if (day) n += Number(day.used) || 0;
  }
  return n;
}

function withCredits(existing, etDay, add, cap, runMeta) {
  const prevMap = (existing && existing.byEtDay) || {};
  const byEtDay = {};
  for (const key of Object.keys(prevMap)) {
    const day = prevMap[key] || {};
    byEtDay[key] = {
      used: Number(day.used) || 0,
      runs: Array.isArray(day.runs) ? day.runs.slice() : [],
    };
  }
  if (!byEtDay[etDay]) byEtDay[etDay] = { used: 0, runs: [] };
  if (add > 0) {
    byEtDay[etDay].used += add;
    byEtDay[etDay].runs.push(runMeta);
  }
  return { cap, byEtDay };
}

function sharpOddsUrl(sportKey, apiKey) {
  const qs = new URLSearchParams({
    bookmakers: SHARP_CLOSE_BOOKS.join(','),
    markets: MARKETS,
    oddsFormat: 'american',
    apiKey: apiKey || '',
  });
  return `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds?${qs}`;
}

function eventsUrl(sportKey, apiKey) {
  const qs = new URLSearchParams({
    dateFormat: 'iso',
    apiKey: apiKey || '',
  });
  return `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/events?${qs}`;
}

function teamsMatchEvent(event, row) {
  if (!event || !row) return false;
  const home = String(event.home_team || event.homeTeam || '').toLowerCase();
  const away = String(event.away_team || event.awayTeam || '').toLowerCase();
  if (!home || !away) return false;
  const rowHome = String(row.homeTeam || '').toLowerCase();
  const rowAway = String(row.awayTeam || '').toLowerCase();
  if (rowHome && rowAway) {
    return (home === rowHome && away === rowAway) || (home === rowAway && away === rowHome);
  }
  const matchup = String(row.matchup || '').toLowerCase();
  return matchup.includes(home) && matchup.includes(away);
}

function findEvent(events, row) {
  if (!Array.isArray(events) || !row) return null;
  if (row.eventId) {
    const byId = events.find((e) => String((e && (e.id || e.eventId)) || '') === String(row.eventId));
    if (byId) return byId;
  }
  return events.find((e) => teamsMatchEvent(e, row)) || null;
}

/**
 * Skip the paid call only when /events succeeded, every due game is still in
 * the future, and none of them are listed. A game that already started may
 * have left /events; that is not a skip.
 */
function eventsAllowSkip(events, dueRows, nowMs) {
  if (!Array.isArray(events)) return false;
  const rows = dueRows || [];
  if (!rows.length) return true;
  const started = rows.some((row) => {
    const t = Date.parse(row.commenceTime);
    return Number.isFinite(t) && t <= nowMs;
  });
  if (started) return false;
  return !rows.some((row) => events.some((ev) => teamsMatchEvent(ev, row) || (row.eventId && ev && String(ev.id) === String(row.eventId))));
}

function blobRestUrl(key, siteId) {
  const site = siteId || process.env.SITE_ID || SITE_ID;
  return `https://api.netlify.com/api/v1/blobs/${site}/${BLOB_STORE}/${key}`;
}

async function restCall(key, { method, body, fetchImpl, token, siteId } = {}) {
  const auth = token != null ? token : process.env.NETLIFY_AUTH_TOKEN;
  if (!auth) throw new Error('NETLIFY_AUTH_TOKEN missing');
  const doFetch = fetchImpl || fetch;
  return doFetch(blobRestUrl(key, siteId), {
    method: method || 'GET',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function defaultGetStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore(BLOB_STORE);
}

async function readWithFallback(key, deps) {
  const getter = deps.getStore || defaultGetStore;
  try {
    const store = await getter();
    if (!store || typeof store.get !== 'function') throw new Error('getStore returned no get');
    return await store.get(key, { type: 'json' });
  } catch (e) {
    console.error(`[candidate-closes] get ${key} failed: ${e.message} — REST fallback`);
    try {
      const resp = await restCall(key, { method: 'GET', fetchImpl: deps.blobFetch, token: deps.token, siteId: deps.siteId });
      if (!resp || !resp.ok) return null;
      return await resp.json();
    } catch (err) {
      console.error(`[candidate-closes] REST get ${key} failed: ${err.message}`);
      return null;
    }
  }
}

async function writeWithFallback(key, data, deps) {
  const getter = deps.getStore || defaultGetStore;
  try {
    const store = await getter();
    if (!store || typeof store.setJSON !== 'function') throw new Error('getStore returned no setJSON');
    await store.setJSON(key, data);
    return { via: 'sdk' };
  } catch (e) {
    console.error(`[candidate-closes] SDK setJSON ${key}: ${e.message} — REST fallback`);
    const resp = await restCall(key, {
      method: 'PUT',
      body: data,
      fetchImpl: deps.blobFetch,
      token: deps.token,
      siteId: deps.siteId,
    });
    if (!resp || !resp.ok) {
      const status = resp ? resp.status : 'no-response';
      throw new Error(`blob PUT ${key} → ${status}`);
    }
    console.log(`[candidate-closes] REST wrote ${key}`);
    return { via: 'rest' };
  }
}

async function readBlob(key, deps) {
  if (deps && typeof deps.readJson === 'function') return deps.readJson(key);
  return readWithFallback(key, deps || {});
}

async function writeBlob(key, data, deps) {
  if (deps && typeof deps.writeJson === 'function') return deps.writeJson(key, data);
  return writeWithFallback(key, data, deps || {});
}

async function fetchJson(fetchImpl, url) {
  const resp = await fetchImpl(url, { signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
  if (!resp || !resp.ok) {
    const status = resp ? resp.status : 'no-response';
    throw new Error(`HTTP ${status}`);
  }
  const body = await resp.json();
  if (body && Array.isArray(body.data) && !Array.isArray(body)) return body.data;
  return body;
}

function ledgerCandidates(blob) {
  if (!blob) return [];
  if (Array.isArray(blob.candidates)) return blob.candidates;
  if (Array.isArray(blob.sides)) return blob.sides;
  return [];
}

/**
 * Capture sharp closes for due candidates. `readJson` / `writeJson` /
 * `getStore` / `fetchImpl` are injectable. Network is limited to the Odds
 * API helpers above plus the blob REST fallback.
 */
async function captureCandidateClosesV2(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.nowMs || Date.now());
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const clock = opts.etDay ? { etDay: opts.etDay, dates: opts.dates || [opts.etDay, shiftYmd(opts.etDay, -1)] } : etDayAndYesterday(now);
  const etDay = clock.etDay;
  const dates = clock.dates;
  const cap = creditCap(opts.creditCap, opts.env);
  const deps = opts;

  const ledgers = {};
  const blobs = {};
  for (const dateISO of dates) {
    try {
      ledgers[dateISO] = await readBlob(candidateLedgerKey(dateISO), deps);
    } catch (e) {
      console.error(`[candidate-closes] ledger ${dateISO} failed: ${e.message}`);
      ledgers[dateISO] = null;
    }
    try {
      blobs[dateISO] = await readBlob(candidateCloseKey(dateISO), deps);
    } catch (e) {
      console.error(`[candidate-closes] close blob ${dateISO} failed: ${e.message}`);
      blobs[dateISO] = null;
    }
  }

  const usedBefore = creditsUsedOn(dates.map((d) => blobs[d]), etDay);
  const dueBySport = new Map();
  for (const dateISO of dates) {
    const existing = new Map();
    for (const row of ledgerCandidates(blobs[dateISO])) existing.set(rowKey(row), row);
    for (const row of ledgerCandidates(ledgers[dateISO])) {
      if (!row || !isDue(row.commenceTime, nowMs)) continue;
      const prev = existing.get(rowKey(row));
      if (hasClose(prev) || hasClose(row)) continue;
      const sportKey = row.sportKey || sportKeyFor(row.sport);
      if (!sportKey) continue;
      if (!dueBySport.has(sportKey)) dueBySport.set(sportKey, []);
      dueBySport.get(sportKey).push({ ...row, _date: dateISO });
    }
  }

  const fetchImpl = opts.fetchImpl || fetch;
  const apiKey = opts.apiKey != null ? opts.apiKey : process.env.ODDS_API_KEY;
  const oddsCache = opts.oddsCache instanceof Map ? opts.oddsCache : new Map();
  const calls = [];
  let runCredits = 0;
  let usedNow = usedBefore;
  const sports = [...dueBySport.keys()].sort();

  for (const sportKey of sports) {
    const dueRows = dueBySport.get(sportKey);
    let events;
    if (opts.eventsBySportKey && Object.prototype.hasOwnProperty.call(opts.eventsBySportKey, sportKey)) {
      events = opts.eventsBySportKey[sportKey];
    } else if (apiKey) {
      try {
        events = await fetchJson(fetchImpl, eventsUrl(sportKey, apiKey));
        calls.push({ sportKey, action: 'events', credits: 0 });
      } catch (e) {
        events = null;
        calls.push({ sportKey, action: 'events-error', credits: 0, error: e.message });
      }
    } else {
      events = null;
    }
    if (eventsAllowSkip(events, dueRows, nowMs)) {
      calls.push({ sportKey, action: 'skip-events', credits: 0 });
      continue;
    }
    if (oddsCache.has(sportKey)) {
      calls.push({ sportKey, action: 'reuse', credits: 0 });
      continue;
    }
    if (usedNow + CREDITS_PER_CALL > cap) {
      calls.push({ sportKey, action: 'skip-cap', credits: 0, wouldCost: CREDITS_PER_CALL });
      continue;
    }
    if (!apiKey) {
      calls.push({ sportKey, action: 'skip-no-key', credits: 0 });
      continue;
    }
    if (opts.oddsBySportKey && Object.prototype.hasOwnProperty.call(opts.oddsBySportKey, sportKey)) {
      oddsCache.set(sportKey, opts.oddsBySportKey[sportKey] || []);
      usedNow += CREDITS_PER_CALL;
      runCredits += CREDITS_PER_CALL;
      calls.push({ sportKey, action: 'odds', credits: CREDITS_PER_CALL });
      continue;
    }
    try {
      const games = await fetchJson(fetchImpl, sharpOddsUrl(sportKey, apiKey));
      oddsCache.set(sportKey, Array.isArray(games) ? games : []);
      usedNow += CREDITS_PER_CALL;
      runCredits += CREDITS_PER_CALL;
      calls.push({ sportKey, action: 'odds', credits: CREDITS_PER_CALL });
    } catch (e) {
      oddsCache.set(sportKey, null);
      calls.push({ sportKey, action: 'odds-error', credits: 0, error: e.message });
      console.error(`[candidate-closes] odds ${sportKey} failed: ${e.message}`);
    }
  }

  const updatesByDate = {};
  for (const [sportKey, dueRows] of dueBySport) {
    const games = oddsCache.get(sportKey);
    if (!Array.isArray(games)) continue;
    for (const row of dueRows) {
      try {
        const event = findEvent(games, row);
        const close = event ? devigCandidate(event, row) : null;
        if (!close) continue;
        const stamped = stampClose(row, close, nowIso);
        if (!updatesByDate[row._date]) updatesByDate[row._date] = [];
        updatesByDate[row._date].push({ key: rowKey(row), stamped });
      } catch (e) {
        console.error(`[candidate-closes] de-vig ${sportKey} ${row.matchup || ''} failed: ${e.message}`);
      }
    }
  }

  let creditDate = null;
  if (runCredits > 0) {
    creditDate = (ledgers[etDay] || blobs[etDay]) ? etDay : (Object.keys(updatesByDate)[0] || etDay);
  }
  const runMeta = {
    at: nowIso,
    credits: runCredits,
    calls: calls.filter((c) => c.action === 'odds').map((c) => c.sportKey),
  };
  const written = [];
  const coverage = {};
  for (const dateISO of dates) {
    const existing = blobs[dateISO];
    const ledger = ledgers[dateISO];
    const updates = updatesByDate[dateISO] || [];
    const charge = creditDate === dateISO ? runCredits : 0;
    if (!existing && !ledger && !updates.length && !charge) continue;
    const mergedRows = mergeCandidates(ledgerCandidates(existing), ledgerCandidates(ledger));
    const byKey = new Map(mergedRows.map((row) => [rowKey(row), row]));
    for (const update of updates) {
      const prev = byKey.get(update.key);
      if (!prev) continue;
      if (hasClose(prev) && update.stamped.closeNoVig == null) continue;
      byKey.set(update.key, overlayClose(prev, update.stamped));
    }
    const candidates = mergedRows.map((row) => byKey.get(rowKey(row)) || row);
    const cov = coverageBySportMarket(candidates);
    const payload = {
      date: dateISO,
      schema: CLOSE_SCHEMA,
      private: true,
      updatedAt: nowIso,
      note: 'Sharp closes for every gate-evaluated candidate. Not a KPI. Not joined into clv-{date}.',
      credits: withCredits(existing && existing.credits, etDay, charge, cap, charge ? runMeta : null),
      coverage: cov,
      candidates,
    };
    try {
      await writeBlob(candidateCloseKey(dateISO), payload, deps);
      written.push(dateISO);
      coverage[dateISO] = cov;
    } catch (e) {
      console.error(`[candidate-closes] write ${dateISO} failed: ${e.message}`);
      coverage[dateISO] = { error: e.message, coverage: cov };
    }
  }

  console.log(`[capture-candidate-closes] et=${etDay} creditsThisRun=${runCredits} used=${usedNow} cap=${cap} calls=${calls.map((c) => `${c.sportKey}:${c.action}:${c.credits}`).join(',') || 'none'}`);
  return {
    ok: true,
    etDay,
    dates,
    creditsThisRun: runCredits,
    creditsUsed: usedNow,
    cap,
    calls,
    written,
    coverage,
    dueSports: sports,
  };
}

function asGradePick(row, dateISO) {
  return {
    pick: row.side,
    side: row.side,
    betType: row.market,
    market: row.market,
    matchup: row.matchup,
    sport: row.sport,
    odds: row.odds,
    commenceTime: row.commenceTime,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    date: dateISO,
    units: 1,
  };
}

/**
 * Fill final results from ESPN onto a private close blob. No Odds API.
 * Rows that already have a non-pending result are left alone. A missing
 * blob writes nothing.
 */
async function gradeCandidateResults(opts = {}) {
  const dateISO = opts.dateISO;
  const key = candidateCloseKey(dateISO);
  const blob = await readBlob(key, opts);
  const rows = ledgerCandidates(blob);
  if (!blob || !rows.length) return { graded: 0, key, wrote: false };
  const pending = rows.filter((row) => !row.result || row.result === 'pending');
  if (!pending.length) return { graded: 0, key, wrote: false };
  const sports = [...new Set(pending.map((row) => row.sport).filter(Boolean))];
  const gamesBySport = {};
  for (const sport of sports) {
    try {
      gamesBySport[sport] = typeof opts.fetchESPNScores === 'function'
        ? await opts.fetchESPNScores(dateISO, sport)
        : [];
    } catch (e) {
      gamesBySport[sport] = [];
      console.error(`[candidate-closes] ESPN ${sport} ${dateISO}: ${e.message}`);
    }
  }
  let graded = 0;
  const candidates = rows.map((row) => {
    if (row.result && row.result !== 'pending') return row;
    try {
      const pick = asGradePick(row, dateISO);
      const games = gamesBySport[row.sport] || [];
      const game = typeof opts.findGameForGrading === 'function' ? opts.findGameForGrading(pick, games) : null;
      const result = typeof opts.gradePick === 'function' ? opts.gradePick(pick, game) : null;
      if (!result || result === 'pending') return row.result ? row : { ...row, result: result || null };
      graded += 1;
      return { ...row, result, gradedAt: new Date().toISOString() };
    } catch (e) {
      console.error(`[candidate-closes] grade ${row.matchup || ''} failed: ${e.message}`);
      return row;
    }
  });
  if (!graded) return { graded: 0, key, wrote: false };
  const next = { ...blob, candidates, updatedAt: new Date().toISOString() };
  await writeBlob(key, next, opts);
  return { graded, key, wrote: true };
}

module.exports = {
  SHARP_CLOSE_BOOKS,
  SHARP_BOOKS,
  CREDITS_PER_CALL,
  DUE_BEFORE_MS,
  DUE_AFTER_MS,
  DEFAULT_CREDIT_CAP,
  CLOSE_SCHEMA,
  candidateCloseKey,
  creditCap,
  shiftYmd,
  etDayAndYesterday,
  isDue,
  hasClose,
  devigCandidate,
  stampClose,
  mergeCandidates,
  overlayClose,
  coverageBySportMarket,
  creditsUsedOn,
  sharpOddsUrl,
  eventsUrl,
  eventsAllowSkip,
  findEvent,
  captureCandidateClosesV2,
  gradeCandidateResults,
  readWithFallback,
  writeWithFallback,
  marketKeyOf,
  outcomeName,
};
