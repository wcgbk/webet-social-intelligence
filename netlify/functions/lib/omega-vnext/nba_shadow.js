'use strict';
/**
 * NBA shadow runner. Not the daily card.
 *
 * SPORTS_ENABLED.NBA stays false. projectAll never calls this module.
 * Preseason games are projected here and tagged preseason / shadowOnly.
 * Gate floors are the shared GATES (no new floor, no lower floor).
 * selectStraights is not called. Nothing is written to picks-{date},
 * latest-date, or omega-shadow/picks-{date}.
 *
 * Blob keys (private, edge-picks-omega via storeJson):
 *   omega-nba-shadow-{YYYY-MM-DD}
 *   omega-nba-shadow-results-{YYYY-MM-DD}
 * dryRun does not call the store. The results blob carries a same-day
 * summary and a cumulative W-L / units / by-market chain from the prior
 * ET date's results blob.
 *
 * Schedule (netlify.toml, separate wrappers because a cron cannot pass a body):
 *   trigger-omega-nba-shadow       21:30 UTC  project + log today's ET slate
 *   trigger-omega-nba-shadow-grade 12:00 UTC  grade the previous ET date
 * trigger-omega-shadow (13:05 UTC daily-pipeline dry-run) is not wired here.
 * This board must not join that selection. SPORTS_ENABLED.NBA stays false.
 *
 * On switch: NBA_SHADOW.enabled in config.js. Server env OMEGA_NBA_SHADOW=0
 * is the kill-switch (no odds fetch, no blob write). A client body cannot
 * turn the job on.
 *
 * Odds API: at most one HTTP GET /v4/sports/basketball_nba/odds per ET date
 * (regions us,us2,eu × markets h2h,spreads,totals = 9 credits). The free
 * /events preflight (slateOddsGate) skips that call when no game commences
 * on the ET date. A second invoke the same date sees the logged blob and
 * does not call odds again. The grader uses ESPN only (0 odds credits).
 * Tests pass a fixture board and make 0 calls.
 */
const { ODDS_SPORT_KEYS, MODEL_VERSION, SPORTS_ENABLED, NBA_SHADOW, GATES } = require('./config');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { slateOddsGate } = require('./fetch_memo');
const { fetchEspnScoreboard, fetchEspnStandings, filterEventsSameEtDay } = require('./ingest');
const { americanToDecimal } = require('./odds_math');
const { prevEtDate, restMapFromScoreboard } = require('./sports/game_day');
const nba = require('./sports/nba');

const ODDS_REGIONS = 'us,us2,eu';
const ODDS_MARKETS = 'h2h,spreads,totals';
const ODDS_REGION_COUNT = 3;
const ODDS_MARKET_COUNT = 3;
/** Credits for one live shadow odds request under the markets × regions rule. */
const ODDS_CREDITS_PER_RUN = ODDS_REGION_COUNT * ODDS_MARKET_COUNT;
/** Flat stake for the shadow log. The daily card's Kelly units are not used. */
const SHADOW_UNIT = 1;

function shadowKillReason() {
  if (!NBA_SHADOW || NBA_SHADOW.enabled !== true) return 'NBA_SHADOW.enabled is false';
  if (process.env.OMEGA_NBA_SHADOW === '0') return 'OMEGA_NBA_SHADOW=0';
  return null;
}

function shadowLiveEnabled() {
  return shadowKillReason() == null;
}

function previousShadowDate(dateISO) {
  return prevEtDate(dateISO || todayET());
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

function slim(c) {
  return {
    sport: c.sport,
    matchup: c.matchup,
    market: c.market,
    side: c.side,
    line: c.line != null ? c.line : null,
    pickSide: c.pickSide || null,
    odds: c.odds != null ? c.odds : null,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    commenceTime: c.commenceTime || null,
    coverProb: c.coverProb != null ? c.coverProb : null,
    ev: c.ev != null ? c.ev : null,
    edgePct: c.edgePct != null ? c.edgePct : null,
    projMethod: c.projMethod || null,
    modelProjection: c.modelProjection != null ? c.modelProjection : null,
    preseason: !!c.preseason,
    shadowOnly: true,
    unknownTeam: !!c.unknownTeam,
    rejectReason: c.rejectReason || null,
  };
}

/**
 * Free /events preflight, then at most one basketball_nba odds request,
 * plus ESPN scoreboard, standings, and yesterday's scoreboard for
 * back-to-backs. ESPN failures soft-fail. A billed odds failure sets error
 * and still counts the call. An empty ET slate returns before the odds call.
 */
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
  const gate = await slateOddsGate({
    sportKey, apiKey, dateISO, fetchImpl, timeoutMs: 12000,
  });
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
  try {
    out.standings = await fetchEspnStandings('NBA');
  } catch (e) {
    console.error(`[omega-nba-shadow] standings soft-fail: ${e.message}`);
  }
  try {
    const prev = prevEtDate(dateISO);
    if (prev) {
      const yday = await fetchEspnScoreboard('NBA', prev);
      out.gameDay.restByTeam.NBA = restMapFromScoreboard((yday && yday.games) || [], prev);
    }
  } catch (e) {
    console.error(`[omega-nba-shadow] rest soft-fail: ${e.message}`);
  }
  return out;
}

/**
 * Project today's NBA board, run the shared calibrate + gates, and
 * (unless dryRun) write the private shadow blob. Does not select a card.
 */
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
      // A billed attempt is the day's call. Persist it so a retry does not
      // spend a second 9 credits. A missing key (0 calls) stays retryable.
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
          picks: [],
          rejected: [],
        });
        fail.wrote = true;
      }
      return fail;
    }
  }

  const raw = nba.project({
    oddsEvents: board.oddsEvents,
    standings: board.standings,
    espnGames: board.espnGames,
    gameDay: board.gameDay,
    prior: opts.prior,
    allowPreseason: true,
    preseason: !!board.preseason,
  });
  const calibrated = calibrateAll(raw).map(attachEv);
  const { yesPool, rejected } = applyGates(calibrated, {
    cardDate: dateISO,
    asOf: opts.asOf,
    asOfMs: opts.asOfMs,
  });
  const payload = {
    date: dateISO,
    shadow: true,
    shadowOnly: true,
    sport: 'NBA',
    preseason: !!board.preseason,
    model: MODEL_VERSION,
    sportsEnabledNba: SPORTS_ENABLED.NBA === true,
    selection: 'gates-only; not daily selectStraights',
    gates: {
      minEV: GATES.minEV.NBA != null ? GATES.minEV.NBA : GATES.minEV.default,
      minCoverProb: GATES.minCoverProb.NBA != null ? GATES.minCoverProb.NBA : GATES.minCoverProb.default,
    },
    generatedAt: new Date().toISOString(),
    candidateCount: raw.length,
    yesCount: yesPool.length,
    rejectedCount: rejected.length,
    picks: yesPool.map(slim),
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
    candidateCount: raw.length,
    yesCount: yesPool.length,
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

/** Flat 1u shadow profit. A win needs an American price. Pending stays null. */
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
  for (const row of rows || []) {
    const result = record[row.result] != null ? row.result : 'unmatched';
    record[result] += 1;
    const market = row.market || 'Other';
    if (!byMarket[market]) byMarket[market] = emptyMarketBucket();
    if (byMarket[market][result] != null) byMarket[market][result] += 1;
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
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
  };
  if (!final) return { ...base, result: 'unmatched' };
  const hs = Number(final.homeScore);
  const as = Number(final.awayScore);
  const done = isFinalStatus(final.status) && Number.isFinite(hs) && Number.isFinite(as);
  if (!done) {
    return { ...base, result: 'pending', homeScore: final.homeScore, awayScore: final.awayScore, status: final.status || null };
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

function matchFinal(pick, finals) {
  const { resolveTeamId } = require('./sports/team_identity');
  const hid = resolveTeamId('NBA', pick.homeTeam);
  const aid = resolveTeamId('NBA', pick.awayTeam);
  if (!hid || !aid) return null;
  return (finals || []).find((g) => {
    return resolveTeamId('NBA', g.homeTeam) === hid && resolveTeamId('NBA', g.awayTeam) === aid;
  }) || null;
}

/**
 * Grade a prior shadow slate from ESPN finals (or a fixture).
 * Grades the gated shadow picks. dryRun does not write.
 */
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
  const rows = picks.map((p) => {
    const row = gradeOne(p, matchFinal(p, finals));
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
  gradeNbaShadow,
  fetchNbaBoard,
  gradeOne,
  shadowKey,
  shadowResultsKey,
  todayET,
  previousShadowDate,
  shadowLiveEnabled,
  shadowKillReason,
  summarizeRows,
  ODDS_CREDITS_PER_RUN,
  ODDS_REGIONS,
  ODDS_MARKETS,
};
