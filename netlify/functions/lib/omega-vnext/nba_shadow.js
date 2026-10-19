'use strict';
/**
 * NBA shadow observer. Not the daily card.
 *
 * SPORTS_ENABLED.NBA stays false. projectAll never calls this module.
 * selectStraights is not called. Nothing is written to picks-{date},
 * latest-date, or omega-shadow/picks-{date}.
 *
 * Fair probability is de-vigged Pinnacle on the same line combined with
 * the model (sports/nba.js BLEND, locked at 0). EV is at the best
 * DraftKings or Hard Rock price. One EV floor, one EV cap, American
 * odds from -250 to +250. Markets: moneyline, spread, total. One side
 * per market per game, ranked by EV.
 *
 * Every candidate is logged with p_model, p_fair, price, and book.
 * Grade later compares the logged side to the result and, when the
 * Pinnacle close is the same number, to that close (CLV). A moved
 * number is a null CLV.
 *
 * The shared calibrate band and the shared GATES are not the observer
 * decision. Current main shrinks toward a 0.42–0.58 band and gates NBA
 * at 3% with a -300..+300 band. Using those would move a sharp price
 * and would not be the single 2% floor. The observer prices p_fair
 * directly. At blend 0 that price is already the Pinnacle no-vig, so
 * the hand-set shrink would not have moved it either.
 *
 * Blob keys (private, edge-picks-omega via storeJson):
 *   omega-nba-shadow-{YYYY-MM-DD}
 *   omega-nba-shadow-results-{YYYY-MM-DD}
 * dryRun does not call the store.
 *
 * Odds API: at most one GET /v4/sports/basketball_nba/odds per ET date
 * (regions us,us2,eu × markets h2h,spreads,totals = 9 credits), and only
 * when this module is asked to fetch. The free /events preflight skips
 * that call when no game commences on the ET date. Tests pass a fixture
 * board and make 0 calls. The production project wrapper does not fetch.
 *
 * OMEGA_NBA_SHADOW=0 is the kill switch. NBA_SHADOW.enabled is the
 * config switch. A client body cannot turn the job on.
 */
const { ODDS_SPORT_KEYS, MODEL_VERSION, SPORTS_ENABLED, NBA_SHADOW } = require('./config');
const { isSameEtDay, americanToDecimal, americanToImplied } = require('./odds_math');
const { filterEventsSameEtDay, fetchEspnScoreboard } = require('./ingest');
const { prevEtDate } = require('./sports/game_day');
const { gradeNoVigClv } = require('./clv_grade');
const nba = require('./sports/nba');

const ODDS_REGIONS = 'us,us2,eu';
const ODDS_MARKETS = 'h2h,spreads,totals';
const ODDS_REGION_COUNT = 3;
const ODDS_MARKET_COUNT = 3;
const ODDS_CREDITS_PER_RUN = ODDS_REGION_COUNT * ODDS_MARKET_COUNT;
const SHADOW_UNIT = 1;
const PREGAME_GRACE_MS = 5 * 60 * 1000;

/** Single floor, single cap, one odds band. Not the shared GATES table. */
const OBSERVER = Object.freeze({
  minEV: 0.02,
  maxEV: 0.12,
  minAmericanOdds: -250,
  maxAmericanOdds: 250,
});

function shadowKillReason() {
  if (!NBA_SHADOW || NBA_SHADOW.enabled !== true) return 'NBA_SHADOW.enabled is false';
  if (process.env.OMEGA_NBA_SHADOW === '0') return 'OMEGA_NBA_SHADOW=0';
  return null;
}

function shadowLiveEnabled() {
  return shadowKillReason() == null;
}

/**
 * Side log from a board the caller already has. Default off.
 * Does not call the Odds API and does not attach anything to a card.
 */
function generateShadowRequested(opts) {
  if (opts && opts.nbaGenerateShadow === false) return false;
  if (opts && opts.nbaGenerateShadow === true) return true;
  return process.env.OMEGA_NBA_GENERATE_SHADOW === '1';
}

function slateLooksPreseason(espnGames) {
  const games = (espnGames && espnGames.games) || [];
  return games.length > 0 && games.every((g) => g.preseason || Number(g.seasonType) === 1);
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function assertDate(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`omega-nba-shadow refused bad date: ${dateISO}`);
  }
  return d;
}

function previousShadowDate(dateISO) {
  return prevEtDate(dateISO || todayET());
}

function shadowKey(dateISO) {
  return `omega-nba-shadow-${assertDate(dateISO)}`;
}

function shadowResultsKey(dateISO) {
  return `omega-nba-shadow-results-${assertDate(dateISO)}`;
}

async function defaultStore(key, data) {
  const { storeJson } = require('./store');
  return storeJson(key, data);
}

async function defaultRead(key) {
  const { readJson } = require('./store');
  return readJson(key);
}

function countSameEtDay(events, dateISO) {
  let n = 0;
  for (const ev of events || []) {
    const t = ev && (ev.commence_time || ev.commenceTime || ev.date);
    if (t && isSameEtDay(t, dateISO)) n += 1;
  }
  return n;
}

/**
 * Free /events preflight. skip is true only when the call succeeds and
 * zero events commence on dateISO. Errors do not skip: the caller then
 * pulls odds, and a failed odds call is the day's billed attempt.
 */
async function slateOddsGate({ sportKey, apiKey, dateISO, fetchImpl, timeoutMs = 12000 } = {}) {
  if (!apiKey || !sportKey || !dateISO) {
    return { skip: false, reason: 'missing-args', sameDay: null, events: null };
  }
  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/events`
    + `?dateFormat=iso&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error(`events HTTP ${resp.status}`);
    const body = await resp.json();
    const list = Array.isArray(body) ? body : [];
    const sameDay = countSameEtDay(list, dateISO);
    if (sameDay === 0) return { skip: true, reason: 'no-same-et-day', sameDay: 0, events: list.length };
    return { skip: false, reason: 'has-same-et-day', sameDay, events: list.length };
  } catch (e) {
    return { skip: false, reason: 'events-unavailable', error: e.message, sameDay: null, events: null };
  }
}

function observerReason(c, opts) {
  if (c && c.unknownTeam) return 'unknown-team';
  if (c.p_pinnacle == null || !Number.isFinite(Number(c.p_fair))) return 'no-pinnacle-same-line';
  const price = Number.isFinite(Number(c.price)) ? Number(c.price) : Number(c.odds);
  if (!Number.isFinite(price)) return 'no-dk-hr-price';
  if (price < OBSERVER.minAmericanOdds || price > OBSERVER.maxAmericanOdds) return 'odds-out-of-band';
  const ev = Number(c.ev);
  if (!Number.isFinite(ev) || ev < OBSERVER.minEV) return 'ev-floor';
  if (ev > OBSERVER.maxEV) return 'ev-cap';
  const cardDate = opts && opts.dateISO;
  if (cardDate) {
    if (!c.commenceTime) return 'missing-commenceTime';
    if (!isSameEtDay(c.commenceTime, cardDate)) return 'not-same-et-day';
  }
  if (c.commenceTime && opts && Number.isFinite(opts.asOfMs)) {
    const t = Date.parse(c.commenceTime);
    if (Number.isFinite(t) && t < opts.asOfMs - PREGAME_GRACE_MS) return 'in-progress-or-started';
  }
  return null;
}

function betterPasser(next, prev) {
  if (!prev) return true;
  if (next.ev > prev.ev + 1e-12) return true;
  if (prev.ev > next.ev + 1e-12) return false;
  return Number(next.price) > Number(prev.price);
}

/**
 * Individual gates, then one side per market per game. Rank the yes
 * pool by EV. Every input row is returned in `all` with its reason.
 */
function classify(raw, opts) {
  const tagged = (raw || []).map((c) => ({ ...c, rejectReason: observerReason(c, opts) }));
  const best = new Map();
  for (const c of tagged) {
    if (c.rejectReason) continue;
    const key = `${c.matchup}|${c.market}`;
    if (betterPasser(c, best.get(key))) best.set(key, c);
  }
  const yes = [];
  const rejected = [];
  const all = [];
  for (const c of tagged) {
    if (c.rejectReason) {
      rejected.push(c);
      all.push(c);
      continue;
    }
    const key = `${c.matchup}|${c.market}`;
    if (best.get(key) !== c) {
      const row = { ...c, rejectReason: 'one-side-per-market' };
      rejected.push(row);
      all.push(row);
    } else {
      const row = { ...c, rejectReason: null };
      yes.push(row);
      all.push(row);
    }
  }
  yes.sort((a, b) => Number(b.ev) - Number(a.ev) || Number(b.price) - Number(a.price));
  return { yes, rejected, all };
}

function slim(c) {
  return {
    sport: c.sport,
    matchup: c.matchup,
    market: c.market,
    side: c.side,
    line: c.line != null ? c.line : null,
    pickSide: c.pickSide || null,
    odds: c.odds != null ? c.odds : null,
    price: c.price != null ? c.price : (c.odds != null ? c.odds : null),
    book: c.book || null,
    p_model: c.p_model != null ? c.p_model : null,
    p_fair: c.p_fair != null ? c.p_fair : null,
    p_pinnacle: c.p_pinnacle != null ? c.p_pinnacle : null,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    commenceTime: c.commenceTime || null,
    ev: c.ev != null ? c.ev : null,
    blendWeight: c.blendWeight != null ? c.blendWeight : null,
    projMethod: c.projMethod || null,
    modelProjection: c.modelProjection != null ? c.modelProjection : null,
    preseason: !!c.preseason,
    shadowOnly: true,
    unknownTeam: !!c.unknownTeam,
    rejectReason: c.rejectReason || null,
  };
}

async function fetchNbaBoard(dateISO, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const out = {
    oddsEvents: [],
    standings: {},
    espnGames: { games: [] },
    gameDay: { restByTeam: { NBA: {} } },
    preseason: false,
    oddsCalls: 0,
    error: null,
    skipped: false,
    skipReason: null,
  };
  const killed = shadowKillReason();
  if (killed) {
    out.skipped = true;
    out.skipReason = killed;
    return out;
  }
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    out.error = 'ODDS_API_KEY missing';
    return out;
  }
  const sportKey = ODDS_SPORT_KEYS.NBA;
  const gate = await slateOddsGate({ sportKey, apiKey, dateISO, fetchImpl, timeoutMs: 12000 });
  if (gate.skip) {
    out.skipped = true;
    out.skipReason = gate.reason || 'no-same-et-day';
    out.preflight = { sameDay: gate.sameDay, events: gate.events, reason: gate.reason };
    return out;
  }
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
  out.oddsCalls = 1;
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`odds HTTP ${resp.status}`);
    const data = await resp.json();
    const raw = Array.isArray(data) ? data : ((data && data.data) || []);
    out.oddsEvents = filterEventsSameEtDay(raw, dateISO);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  try {
    const board = await fetchEspnScoreboard('NBA', dateISO);
    out.espnGames = board || { games: [] };
    const games = out.espnGames.games || [];
    out.preseason = games.length > 0 && games.every((g) => g.preseason || Number(g.seasonType) === 1);
  } catch (e) {
    console.error(`[omega-nba-shadow] scoreboard soft-fail: ${e.message}`);
  }
  return out;
}

async function logNbaFromGenerate(opts = {}) {
  if (!generateShadowRequested(opts)) {
    return { ran: false, reason: 'flag-off', oddsCalls: 0, wrote: false, attachedToCard: false };
  }
  const killed = shadowKillReason();
  if (killed) {
    return { ran: false, reason: killed, oddsCalls: 0, wrote: false, attachedToCard: false };
  }
  const dateISO = assertDate(opts.dateISO || todayET());
  const snap = opts.snap || {};
  const espnGames = (snap.espnBySport && snap.espnBySport.NBA) || opts.espnGames || { games: [] };
  const dryRun = opts.dryRun !== false;
  const summary = await runNbaShadow({
    dateISO,
    dryRun: true,
    oddsEvents: (snap.oddsBySport && snap.oddsBySport.NBA) || opts.oddsEvents || [],
    standings: (snap.standingsBySport && snap.standingsBySport.NBA) || opts.standings || {},
    espnGames,
    gameDay: snap.gameDay || opts.gameDay || { restByTeam: { NBA: {} } },
    preseason: slateLooksPreseason(espnGames),
    asOf: opts.asOf,
    asOfMs: opts.asOfMs,
    prior: opts.prior,
  });
  summary.ran = true;
  summary.oddsCalls = 0;
  summary.creditsEstimate = 0;
  summary.attachedToCard = false;
  summary.wrote = false;
  if (dryRun || !summary.payload) return summary;
  const write = opts.store || defaultStore;
  await write(summary.key, summary.payload);
  summary.wrote = true;
  return summary;
}

async function runNbaShadow(opts = {}) {
  const dryRun = !!opts.dryRun;
  const dateISO = assertDate(opts.dateISO || todayET());
  const key = shadowKey(dateISO);
  let oddsCalls = 0;
  let board;
  if (opts.oddsEvents) {
    board = {
      oddsEvents: opts.oddsEvents,
      standings: opts.standings || {},
      espnGames: opts.espnGames || { games: [] },
      gameDay: opts.gameDay || { restByTeam: { NBA: {} } },
      preseason: !!opts.preseason,
      oddsCalls: 0,
      error: null,
    };
  } else {
    const killed = shadowKillReason();
    if (killed) {
      return {
        wrote: false,
        key,
        date: dateISO,
        oddsCalls: 0,
        creditsEstimate: 0,
        skipped: true,
        reason: killed,
        candidateCount: 0,
        yesCount: 0,
        rejectedCount: 0,
      };
    }
    const read = opts.read || defaultRead;
    let existing = null;
    try { existing = await read(key); } catch (_) { existing = null; }
    if (existing && existing.shadowOnly && existing.generatedAt) {
      return {
        wrote: false,
        key,
        date: dateISO,
        oddsCalls: 0,
        creditsEstimate: 0,
        skipped: true,
        reason: 'already-logged',
        preseason: !!existing.preseason,
        candidateCount: existing.candidateCount || 0,
        yesCount: existing.yesCount || 0,
        rejectedCount: existing.rejectedCount || 0,
        sportsEnabledNba: existing.sportsEnabledNba === true,
        payload: existing,
      };
    }
    const fetchBoard = opts.fetchBoard || fetchNbaBoard;
    board = await fetchBoard(dateISO, { fetchImpl: opts.fetchImpl });
    oddsCalls = board.oddsCalls || 0;
    if (board.error) {
      const fail = {
        wrote: false,
        key,
        date: dateISO,
        oddsCalls,
        creditsEstimate: oddsCalls ? ODDS_CREDITS_PER_RUN : 0,
        error: board.error,
        candidateCount: 0,
        yesCount: 0,
        rejectedCount: 0,
      };
      if (!dryRun && oddsCalls > 0) {
        const write = opts.store || defaultStore;
        await write(key, {
          date: dateISO,
          shadow: true,
          shadowOnly: true,
          sport: 'NBA',
          model: MODEL_VERSION,
          sportsEnabledNba: SPORTS_ENABLED.NBA === true,
          generatedAt: new Date().toISOString(),
          error: board.error,
          oddsCalls,
          candidateCount: 0,
          yesCount: 0,
          rejectedCount: 0,
          candidates: [],
          picks: [],
          rejected: [],
        });
        fail.wrote = true;
      }
      return fail;
    }
  }

  const asOfMs = Number.isFinite(opts.asOfMs)
    ? opts.asOfMs
    : (opts.asOf != null && opts.asOf !== '' ? Date.parse(opts.asOf) : null);
  const raw = nba.project({
    oddsEvents: board.oddsEvents,
    standings: board.standings,
    gameDay: board.gameDay,
    prior: opts.prior,
    allowPreseason: true,
    preseason: !!board.preseason,
  });
  const { yes, rejected, all } = classify(raw, {
    dateISO,
    asOfMs: Number.isFinite(asOfMs) ? asOfMs : null,
  });
  const payload = {
    date: dateISO,
    shadow: true,
    shadowOnly: true,
    sport: 'NBA',
    observer: true,
    preseason: !!board.preseason,
    model: MODEL_VERSION,
    sportsEnabledNba: SPORTS_ENABLED.NBA === true,
    selection: 'observer gates; not daily selectStraights',
    gates: {
      minEV: OBSERVER.minEV,
      maxEV: OBSERVER.maxEV,
      minAmericanOdds: OBSERVER.minAmericanOdds,
      maxAmericanOdds: OBSERVER.maxAmericanOdds,
      blend: { ...nba.BLEND },
    },
    generatedAt: new Date().toISOString(),
    candidateCount: all.length,
    yesCount: yes.length,
    rejectedCount: rejected.length,
    candidates: all.map(slim),
    picks: yes.map(slim),
    rejected: rejected.map(slim),
    oddsCalls,
    oddsSkipped: board.skipReason || null,
  };
  const summary = {
    wrote: false,
    key,
    date: dateISO,
    oddsCalls,
    creditsEstimate: oddsCalls ? ODDS_CREDITS_PER_RUN : 0,
    preseason: !!board.preseason,
    candidateCount: all.length,
    yesCount: yes.length,
    rejectedCount: rejected.length,
    sportsEnabledNba: payload.sportsEnabledNba,
    skipped: !!board.skipped,
    reason: board.skipReason || null,
    payload,
  };
  if (dryRun) return summary;
  const write = opts.store || defaultStore;
  await write(key, payload);
  summary.wrote = true;
  return summary;
}

function isFinalStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'post' || s === 'final' || s.includes('final');
}

function parseAmerican(odds) {
  if (odds == null || odds === '') return null;
  const n = parseInt(String(odds).replace(/[^0-9+-]/g, ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function round4(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return +v.toFixed(4);
}

function shadowProfitUnits(row) {
  const result = row && row.result;
  if (result === 'push') return 0;
  if (result === 'loss') return -SHADOW_UNIT;
  if (result !== 'win') return null;
  const dec = americanToDecimal(parseAmerican(row.odds));
  if (dec == null) return null;
  return round4(SHADOW_UNIT * (dec - 1));
}

function emptyMarketBucket() {
  return { win: 0, loss: 0, push: 0, pending: 0, unmatched: 0, units: 0 };
}

function summarizeRows(rows) {
  const record = { win: 0, loss: 0, push: 0, pending: 0, unmatched: 0 };
  const byMarket = {};
  let units = 0;
  let priced = 0;
  let unpriced = 0;
  let clvN = 0;
  let clvSum = 0;
  let clvBeats = 0;
  for (const row of rows || []) {
    const result = record[row.result] != null ? row.result : 'unmatched';
    record[result] += 1;
    const market = row.market || 'Other';
    if (!byMarket[market]) byMarket[market] = emptyMarketBucket();
    if (byMarket[market][result] != null) byMarket[market][result] += 1;
    if (row.clv != null && Number.isFinite(Number(row.clv))) {
      clvN += 1;
      clvSum += Number(row.clv);
      if (row.beatClose === true) clvBeats += 1;
    }
    const profit = row.profitUnits != null ? Number(row.profitUnits) : shadowProfitUnits(row);
    if (profit == null || !Number.isFinite(profit)) {
      if (result === 'win' || result === 'loss') unpriced += 1;
      continue;
    }
    priced += 1;
    units = round4(units + profit);
    byMarket[market].units = round4(byMarket[market].units + profit);
  }
  return {
    wl: `${record.win}-${record.loss}`,
    units,
    byMarket,
    record,
    priced,
    unpriced,
    unitStake: SHADOW_UNIT,
    clv: {
      n: clvN,
      meanClv: clvN ? +((clvSum / clvN).toFixed(4)) : null,
      beats: clvBeats,
      beatRate: clvN ? +((clvBeats / clvN).toFixed(4)) : null,
    },
  };
}

function addSummaries(prior, today) {
  const record = { win: 0, loss: 0, push: 0, pending: 0, unmatched: 0 };
  const aRec = (prior && prior.record) || {};
  const bRec = (today && today.record) || {};
  for (const k of Object.keys(record)) {
    record[k] = (Number(aRec[k]) || 0) + (Number(bRec[k]) || 0);
  }
  const names = new Set([
    ...Object.keys((prior && prior.byMarket) || {}),
    ...Object.keys((today && today.byMarket) || {}),
  ]);
  const byMarket = {};
  for (const name of names) {
    const a = (prior.byMarket && prior.byMarket[name]) || emptyMarketBucket();
    const b = (today.byMarket && today.byMarket[name]) || emptyMarketBucket();
    byMarket[name] = {
      win: (a.win || 0) + (b.win || 0),
      loss: (a.loss || 0) + (b.loss || 0),
      push: (a.push || 0) + (b.push || 0),
      pending: (a.pending || 0) + (b.pending || 0),
      unmatched: (a.unmatched || 0) + (b.unmatched || 0),
      units: round4((a.units || 0) + (b.units || 0)),
    };
  }
  return {
    wl: `${record.win}-${record.loss}`,
    units: round4((prior.units || 0) + (today.units || 0)),
    byMarket,
    record,
    priced: (prior.priced || 0) + (today.priced || 0),
    unpriced: (prior.unpriced || 0) + (today.unpriced || 0),
    unitStake: SHADOW_UNIT,
  };
}

function chainCumulative(priorBlob, daySummary, dateISO) {
  const base = priorBlob && (priorBlob.cumulative || priorBlob.summary);
  if (!base || typeof base !== 'object') {
    return { ...daySummary, from: dateISO, through: dateISO };
  }
  const combined = addSummaries(base, daySummary);
  combined.from = base.from || priorBlob.date || null;
  combined.through = dateISO;
  return combined;
}

function gradeOne(pick, final) {
  const base = {
    matchup: pick.matchup,
    market: pick.market,
    side: pick.side,
    line: pick.line != null ? pick.line : null,
    odds: pick.odds != null ? pick.odds : null,
    price: pick.price != null ? pick.price : (pick.odds != null ? pick.odds : null),
    book: pick.book || null,
    p_model: pick.p_model != null ? pick.p_model : null,
    p_fair: pick.p_fair != null ? pick.p_fair : null,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    pickSide: pick.pickSide || null,
  };
  if (!final) return { ...base, result: 'unmatched' };
  const hs = Number(final.homeScore);
  const as = Number(final.awayScore);
  const done = isFinalStatus(final.status) && Number.isFinite(hs) && Number.isFinite(as);
  if (!done) {
    return {
      ...base,
      result: 'pending',
      homeScore: final.homeScore,
      awayScore: final.awayScore,
      status: final.status || null,
    };
  }
  if (pick.market === 'Total') {
    const line = Number(pick.line);
    const total = hs + as;
    const over = pick.pickSide === 'over' || /^over\b/i.test(String(pick.side || ''));
    const diff = over ? total - line : line - total;
    const result = diff > 0 ? 'win' : (diff < 0 ? 'loss' : 'push');
    return { ...base, result, homeScore: hs, awayScore: as, total };
  }
  if (pick.market === 'Moneyline') {
    if (hs === as) return { ...base, result: 'push', homeScore: hs, awayScore: as };
    const homePick = pick.pickSide === 'home';
    const homeWon = hs > as;
    const result = homePick === homeWon ? 'win' : 'loss';
    return { ...base, result, homeScore: hs, awayScore: as };
  }
  const line = Number(pick.line);
  const homePick = pick.pickSide !== 'away';
  const marginForSide = homePick ? (hs - as) : (as - hs);
  const cover = marginForSide + line;
  const result = cover > 0 ? 'win' : (cover < 0 ? 'loss' : 'push');
  return { ...base, result, homeScore: hs, awayScore: as, marginForSide };
}

function normMarket(market) {
  const s = String(market || '').toLowerCase();
  if (s === 'h2h' || s.startsWith('money')) return 'moneyline';
  if (s.startsWith('spread')) return 'spread';
  if (s.startsWith('total')) return 'total';
  return s;
}

function sameGame(pick, row) {
  return nba.resolveTeamId(pick.homeTeam) && nba.resolveTeamId(row.homeTeam)
    ? nba.resolveTeamId(pick.homeTeam) === nba.resolveTeamId(row.homeTeam)
      && nba.resolveTeamId(pick.awayTeam) === nba.resolveTeamId(row.awayTeam)
    : pick.homeTeam === row.homeTeam && pick.awayTeam === row.awayTeam;
}

function sameSide(pick, row) {
  const market = normMarket(pick.market);
  if (market === 'total') {
    const over = pick.pickSide === 'over' || /^over\b/i.test(String(pick.side || ''));
    const closeOver = row.pickSide === 'over' || /^over\b/i.test(String(row.side || ''));
    return over === closeOver;
  }
  if (pick.pickSide === 'home' || pick.pickSide === 'away') {
    const team = pick.pickSide === 'home' ? pick.homeTeam : pick.awayTeam;
    if (nba.resolveTeamId(row.side) && nba.resolveTeamId(team)) {
      return nba.resolveTeamId(row.side) === nba.resolveTeamId(team);
    }
  }
  return String(row.side || '') === String(pick.side || '')
    || (row.side && String(pick.side || '').startsWith(String(row.side)));
}

function sameLine(pick, row) {
  if (normMarket(pick.market) === 'moneyline') return row.line == null || pick.line == null;
  return Number(row.line) === Number(pick.line);
}

function flattenCloseEvents(events) {
  const rows = [];
  for (const ev of events || []) {
    if (!ev || !ev.bookmakers) continue;
    const home = ev.home_team || ev.homeTeam;
    const away = ev.away_team || ev.awayTeam;
    const pin = (ev.bookmakers || []).find((b) => String(b.key || '').toLowerCase() === 'pinnacle');
    if (!pin) continue;
    for (const mkt of pin.markets || []) {
      const market = normMarket(mkt.key);
      if (!market) continue;
      for (const o of mkt.outcomes || []) {
        rows.push({
          homeTeam: home,
          awayTeam: away,
          market,
          side: o.name,
          line: o.point != null ? Number(o.point) : null,
          american: Number(o.price),
        });
      }
    }
  }
  return rows;
}

function closeRows(closes) {
  if (!closes) return [];
  const list = Array.isArray(closes) ? closes : [];
  if (list.some((row) => row && row.bookmakers)) return flattenCloseEvents(list);
  return list.map((row) => ({
    homeTeam: row.homeTeam || row.home_team,
    awayTeam: row.awayTeam || row.away_team,
    market: normMarket(row.market),
    side: row.side,
    pickSide: row.pickSide || null,
    line: row.line != null ? Number(row.line) : (row.point != null ? Number(row.point) : null),
    american: row.american != null ? Number(row.american) : (row.price != null ? Number(row.price) : null),
    oppAmerican: row.oppAmerican != null ? Number(row.oppAmerican) : null,
  }));
}

function oppositeLine(row, other) {
  const market = normMarket(row.market);
  if (market === 'moneyline') return true;
  if (market === 'total') return Number(other.line) === Number(row.line);
  return Number(other.line) === -Number(row.line);
}

function oppAmericanFor(rows, row) {
  if (row.oppAmerican != null && Number.isFinite(row.oppAmerican)) return row.oppAmerican;
  const opp = rows.find((other) => other !== row
    && sameGame(row, other)
    && normMarket(other.market) === normMarket(row.market)
    && oppositeLine(row, other)
    && !sameSide(row, other)
    && Number.isFinite(Number(other.american)));
  return opp ? Number(opp.american) : null;
}

/**
 * CLV vs the Pinnacle close on the same line. A different point is null.
 * Positive CLV means the close no-vig is higher than the bet no-vig.
 */
function gradeClv(pick, closes) {
  const rows = closeRows(closes).filter((row) => sameGame(pick, row) && normMarket(row.market) === normMarket(pick.market) && sameSide(pick, row));
  if (!rows.length) return { clv: null, beatClose: null, clvReason: 'no-close' };
  const matched = rows.find((row) => sameLine(pick, row) && Number.isFinite(Number(row.american)));
  if (!matched) {
    return { clv: null, beatClose: null, clvReason: 'line-moved', closeLine: rows[0].line };
  }
  const opp = oppAmericanFor(closeRows(closes), matched);
  const closeImp = americanToImplied(matched.american);
  const oppImp = americanToImplied(opp);
  if (closeImp == null || oppImp == null) {
    return {
      clv: null,
      beatClose: null,
      clvReason: 'close-one-sided',
      closeAmerican: matched.american,
      closeLine: matched.line,
    };
  }
  const graded = gradeNoVigClv(pick.odds != null ? pick.odds : pick.price, matched.american, closeImp + oppImp);
  if (!graded) {
    return { clv: null, beatClose: null, clvReason: 'unpriced', closeAmerican: matched.american };
  }
  return {
    clv: graded.clv,
    clvCents: graded.clvCents,
    beatClose: graded.beatClose,
    closeAmerican: matched.american,
    closeLine: matched.line != null ? matched.line : null,
    clvReason: null,
  };
}

function matchFinal(pick, finals) {
  const games = Array.isArray(finals) ? finals : ((finals && finals.games) || []);
  for (const g of games) {
    if (!g) continue;
    const home = g.homeTeam || g.home_team;
    const away = g.awayTeam || g.away_team;
    if (nba.resolveTeamId(pick.homeTeam) && nba.resolveTeamId(home)
      && nba.resolveTeamId(pick.homeTeam) === nba.resolveTeamId(home)
      && nba.resolveTeamId(pick.awayTeam) === nba.resolveTeamId(away)) return g;
    if (home === pick.homeTeam && away === pick.awayTeam) return g;
  }
  return null;
}

async function gradeNbaShadow(opts = {}) {
  const dryRun = !!opts.dryRun;
  const dateISO = assertDate(opts.dateISO || todayET());
  const key = shadowResultsKey(dateISO);
  const read = opts.read || defaultRead;
  let slate = opts.slate;
  if (!slate) slate = await read(shadowKey(dateISO));
  let finals = opts.finals;
  if (!finals) {
    const board = await fetchEspnScoreboard('NBA', dateISO);
    finals = (board && board.games) || [];
  }
  const picks = (slate && (slate.picks || slate.yes)) || [];
  const closes = opts.closes != null ? opts.closes : (slate && slate.closes);
  const rows = picks.map((p) => {
    const row = gradeOne(p, matchFinal(p, finals));
    const clv = gradeClv(p, closes);
    Object.assign(row, clv);
    row.profitUnits = shadowProfitUnits(row);
    return row;
  });
  const daySummary = summarizeRows(rows);
  const record = daySummary.record;
  let priorBlob = null;
  if (opts.priorResults !== undefined) {
    priorBlob = opts.priorResults;
  } else if (!opts.slate) {
    const prev = previousShadowDate(dateISO);
    if (prev) {
      try { priorBlob = await read(shadowResultsKey(prev)); } catch (_) { priorBlob = null; }
    }
  }
  const cumulative = chainCumulative(priorBlob, daySummary, dateISO);
  const payload = {
    date: dateISO,
    shadow: true,
    shadowOnly: true,
    sport: 'NBA',
    model: MODEL_VERSION,
    sourceKey: shadowKey(dateISO),
    generatedAt: new Date().toISOString(),
    graded: rows.length,
    record,
    summary: daySummary,
    cumulative,
    rows,
    oddsCalls: 0,
  };
  const summary = {
    wrote: false,
    key,
    date: dateISO,
    oddsCalls: 0,
    creditsEstimate: 0,
    graded: rows.length,
    record,
    summary: daySummary,
    cumulative,
    payload,
  };
  if (dryRun) return summary;
  const write = opts.store || defaultStore;
  await write(key, payload);
  summary.wrote = true;
  return summary;
}

module.exports = {
  runNbaShadow,
  logNbaFromGenerate,
  generateShadowRequested,
  gradeNbaShadow,
  matchFinal,
  fetchNbaBoard,
  gradeOne,
  gradeClv,
  classify,
  observerReason,
  shadowKey,
  shadowResultsKey,
  todayET,
  previousShadowDate,
  shadowLiveEnabled,
  shadowKillReason,
  summarizeRows,
  slateOddsGate,
  OBSERVER,
  ODDS_CREDITS_PER_RUN,
  ODDS_REGIONS,
  ODDS_MARKETS,
};
