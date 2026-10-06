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
 * dryRun does not call the store.
 *
 * Schedule: unscheduled. trigger-omega-shadow is the 9:05 ET daily-pipeline
 * dry-run and is not wired here (that clock is outside the before-9am /
 * after-6pm window, and this board must not join that selection).
 *
 * Odds API: one HTTP GET /v4/sports/basketball_nba/odds per live run
 * (regions us,us2,eu × markets h2h,spreads,totals). The Odds API bills
 * that request as markets × regions = 9 credits when that rule applies.
 * A live run happens only when the function is invoked with
 * OMEGA_NBA_SHADOW=1. The grader uses ESPN only (0 odds credits).
 * Tests pass a fixture board and make 0 calls.
 */
const { ODDS_SPORT_KEYS, MODEL_VERSION, SPORTS_ENABLED, GATES } = require('./config');
const { calibrateAll } = require('./calibrate');
const { attachEv } = require('./edge');
const { applyGates } = require('./gates');
const { fetchEspnScoreboard, fetchEspnStandings, filterEventsSameEtDay } = require('./ingest');
const { prevEtDate, restMapFromScoreboard } = require('./sports/game_day');
const nba = require('./sports/nba');

const ODDS_REGIONS = 'us,us2,eu';
const ODDS_MARKETS = 'h2h,spreads,totals';
const ODDS_REGION_COUNT = 3;
const ODDS_MARKET_COUNT = 3;
/** Credits for one live shadow odds request under the markets × regions rule. */
const ODDS_CREDITS_PER_RUN = ODDS_REGION_COUNT * ODDS_MARKET_COUNT;

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
 * One basketball_nba odds request plus ESPN scoreboard, standings, and
 * yesterday's scoreboard for back-to-backs. ESPN failures soft-fail.
 * Odds failure sets error and still counts the call.
 */
async function fetchNbaBoard(dateISO) {
  const out = {
    oddsEvents: [],
    standings: {},
    espnGames: { games: [] },
    gameDay: { restByTeam: { NBA: {} } },
    preseason: false,
    oddsCalls: 0,
    error: null,
  };
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    out.error = 'ODDS_API_KEY missing';
    return out;
  }
  const sportKey = ODDS_SPORT_KEYS.NBA;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?regions=${ODDS_REGIONS}&markets=${ODDS_MARKETS}&oddsFormat=american&apiKey=${apiKey}`;
  out.oddsCalls = 1;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
    const fetchBoard = opts.fetchBoard || fetchNbaBoard;
    board = await fetchBoard(dateISO);
    oddsCalls = board.oddsCalls || 0;
    if (board.error) {
      return {
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

function gradeOne(pick, final) {
  const base = {
    matchup: pick.matchup,
    market: pick.market,
    side: pick.side,
    line: pick.line != null ? pick.line : null,
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
  const rows = picks.map((p) => gradeOne(p, matchFinal(p, finals)));
  const record = { win: 0, loss: 0, push: 0, pending: 0, unmatched: 0 };
  for (const row of rows) {
    if (record[row.result] != null) record[row.result] += 1;
  }
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
  ODDS_CREDITS_PER_RUN,
  ODDS_REGIONS,
  ODDS_MARKETS,
};
