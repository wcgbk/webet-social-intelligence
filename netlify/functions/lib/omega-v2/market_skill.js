'use strict';

/**
 * Walk-forward market-skill weight.
 *
 * The shrink and the cell shift are fit on published picks or on the
 * model's distance from the price. Neither asks whether pCal beat the
 * no-vig price on the unselected morning board. This weight does.
 *
 *   p = sigmoid(logit(pMkt) + w * (logit(pCal) - logit(pMkt)))
 *   w = (n * wHat + N0 * 1) / (n + N0)
 *
 * wHat minimizes log loss on graded board rows dated strictly before the
 * card. The prior is 1 (use the calibrated probability, which is today's
 * behaviour). N0 = 150 rows, about one week of one sport's board, both
 * sides. No graded rows means w = 1.
 *
 * The fit reads pCalRaw when the row has one, otherwise coverProb, otherwise
 * pCal. The board written for the day stores the weighted probability in
 * coverProb and the pre-weight probability in pCalRaw, so the next fit does
 * not compound the weight.
 */

const { MARKET_SKILL_N0, MARKET_SKILL_ENV, MODEL_SPORTS, pairFixEnabled } = require('./constants');
const { boardKey, mispairedOwnOdds } = require('./board');

const GRADED_LIMIT = 20;
const LOAD_BUDGET_MS = 18000;
// One legacy date per card. A cold regrade of every date before 2026-11-11
// took 49.8s (NCAAM scoreboards), past this budget, so the old graded key
// still feeds the fit until that date is rewritten under the v2 key.
const MIGRATE_BUDGET_MS = 12000;
const STALE_PENDING_MS = 36 * 60 * 60 * 1000;
const NEWEST_SETTLED_FLOOR = 0.9;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function openProb(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n >= 1) return null;
  return n;
}

function logit(p) {
  const x = openProb(p);
  if (x == null) return null;
  const c = Math.min(1 - 1e-6, Math.max(1e-6, x));
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  if (z > 30) return 1 - 1e-12;
  if (z < -30) return 1e-12;
  return 1 / (1 + Math.exp(-z));
}

/**
 * p = sigmoid(logit(pMkt) + w * (logit(pCal) - logit(pMkt))).
 * w = 0 returns pMkt. w = 1 returns pCal unchanged, so a full-trust
 * sport matches the probability the card used before this weight.
 */
function blendMarketSkill(pMkt, pCal, w) {
  const market = openProb(pMkt);
  const model = openProb(pCal);
  const weight = clamp01(w);
  if (market == null || model == null) return null;
  if (weight >= 1 - 1e-12) return model;
  if (weight <= 1e-12) return market;
  const lm = logit(market);
  const lc = logit(model);
  if (lm == null || lc == null) return null;
  const p = sigmoid(lm + weight * (lc - lm));
  return openProb(p) == null ? null : p;
}

function oneLogLoss(p, y) {
  const x = openProb(p);
  if (x == null) return 1e6;
  const c = Math.min(1 - 1e-12, Math.max(1e-12, x));
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
}

/**
 * Grid search on [0, 1] by 0.01. The lowest w wins a tie, matching a scan
 * that starts at the market and only moves when log loss strictly falls.
 */
function fitMarketSkillWeight(rows) {
  const usable = [];
  for (const row of rows || []) {
    const pMkt = openProb(row && row.pMkt);
    const pCal = openProb(row && row.pCal);
    const y = row && (row.y === 0 || row.y === 1) ? row.y : null;
    if (pMkt == null || pCal == null || y == null) continue;
    usable.push({ pMkt, pCal, y });
  }
  const n = usable.length;
  if (!n) return { w: 1, wHat: null, n: 0, N0: MARKET_SKILL_N0 };
  let bestW = 0;
  let best = Infinity;
  for (let i = 0; i <= 100; i += 1) {
    const w = i / 100;
    let loss = 0;
    for (const row of usable) {
      const p = blendMarketSkill(row.pMkt, row.pCal, w);
      loss += oneLogLoss(p, row.y);
    }
    if (loss < best - 1e-12) {
      best = loss;
      bestW = w;
    }
  }
  const w = (n * bestW + MARKET_SKILL_N0 * 1) / (n + MARKET_SKILL_N0);
  return { w, wHat: bestW, n, N0: MARKET_SKILL_N0 };
}

function cardDay(value) {
  const d = String(value || '').slice(0, 10);
  return DATE_RE.test(d) ? d : '';
}

/**
 * Probability the fit is allowed to see. pCalRaw is the pre-weight value.
 * coverProb on a new board is already weighted, so it loses to pCalRaw.
 * Older boards have only coverProb. A graded file may carry pCal.
 */
function skillProbability(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.pCalRaw != null && row.pCalRaw !== '') {
    const raw = openProb(row.pCalRaw);
    if (raw != null) return raw;
  }
  if (row.coverProb != null && row.coverProb !== '') {
    const cover = openProb(row.coverProb);
    if (cover != null) return cover;
  }
  return openProb(row.pCal);
}

function skillMarket(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = openProb(row.pMkt);
  if (direct != null) return direct;
  const fair = openProb(row.fair_sharp_p != null ? row.fair_sharp_p : row.sharpFairP);
  return fair;
}

function skillLabel(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.y === 0 || row.y === 1) return row.y;
  if (row.result === 'win') return 1;
  if (row.result === 'loss') return 0;
  return null;
}

/**
 * Rows the weight may see. A missing date, the card date, and anything
 * later are dropped. They are not an error: one bad row must not stop
 * the card.
 */
function normalizeSkillRows(rows, cardDate) {
  const card = cardDay(cardDate);
  if (!card) return [];
  const out = [];
  for (const row of rows || []) {
    const date = cardDay(row && (row.date || row.d));
    if (!date || date >= card) continue;
    const sport = String((row && row.sport) || '').toUpperCase();
    if (!sport) continue;
    const y = skillLabel(row);
    const pCal = skillProbability(row);
    const pMkt = skillMarket(row);
    if (y == null || pCal == null || pMkt == null) continue;
    out.push({
      date,
      sport,
      market: row.market || row.betType || null,
      y,
      pMkt,
      pCal,
    });
  }
  return out;
}

function emptySportRecord() {
  return { w: 1, wHat: null, n: 0, N0: MARKET_SKILL_N0, dates: [] };
}

function disabledMarketSkill() {
  const bySport = {};
  for (const sport of MODEL_SPORTS) bySport[sport] = emptySportRecord();
  return { enabled: false, N0: MARKET_SKILL_N0, bySport };
}

function fitMarketSkill(rows, cardDate) {
  const usable = normalizeSkillRows(rows, cardDate);
  const groups = new Map();
  for (const row of usable) {
    if (!groups.has(row.sport)) groups.set(row.sport, []);
    groups.get(row.sport).push(row);
  }
  const bySport = {};
  for (const sport of MODEL_SPORTS) bySport[sport] = emptySportRecord();
  for (const [sport, list] of groups) {
    const fit = fitMarketSkillWeight(list);
    const dates = [...new Set(list.map((row) => row.date))].sort();
    bySport[sport] = {
      w: fit.w,
      wHat: fit.wHat,
      n: fit.n,
      N0: MARKET_SKILL_N0,
      dates,
    };
  }
  return { enabled: true, N0: MARKET_SKILL_N0, bySport };
}

function marketSkillEnabled(opts, env) {
  const options = opts || {};
  if (Object.prototype.hasOwnProperty.call(options, 'marketSkill') && options.marketSkill != null) {
    const value = options.marketSkill;
    if (value === false || value === 0) return false;
    const text = String(value).trim().toLowerCase();
    if (text === 'off' || text === '0' || text === 'false') return false;
    return true;
  }
  const source = env == null ? process.env : env;
  const flag = source ? source[MARKET_SKILL_ENV] : null;
  if (flag == null || String(flag).trim() === '') return true;
  const text = String(flag).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

/**
 * True when the card run should grade prior boards. An injected row list
 * is already graded. The flag off does not call the grader. A fixture
 * card has no morning board to grade.
 */
function shouldLoadMarketSkill(opts) {
  if (!marketSkillEnabled(opts)) return false;
  if (Array.isArray(opts && opts.gradedBoardRows)) return false;
  if (Array.isArray(opts && opts.fixtureCandidates)) return false;
  return true;
}

function weightFor(skill, sport) {
  if (!skill || skill.enabled === false) return 1;
  const key = String(sport || '').toUpperCase();
  const row = skill.bySport && skill.bySport[key];
  if (!row || !Number.isFinite(Number(row.w))) return 1;
  return clamp01(row.w);
}

/**
 * Replace pCal with the market-skill blend of the probability already on
 * the calibration (after the shrink, the map, and a coverage anchor).
 * pCalRaw stays the pre-weight model probability from applyCalibration.
 * Flag off and w = 1 leave pCal as it was.
 */
function applyMarketSkill(calibration, skill, sport) {
  if (!calibration) return calibration;
  if (!skill || skill.enabled === false) return calibration;
  const w = weightFor(skill, sport);
  const pCalRaw = openProb(calibration.pCalRaw) != null
    ? Number(calibration.pCalRaw)
    : Number(calibration.pCal);
  const base = Number(calibration.pCal);
  const pMkt = Number(calibration.pMkt);
  let pCal = base;
  if (Number.isFinite(base) && Number.isFinite(pMkt) && w < 1 - 1e-12) {
    const blended = blendMarketSkill(pMkt, base, w);
    if (blended != null) pCal = blended;
  }
  return {
    ...calibration,
    pCal,
    pCalRaw: Number.isFinite(pCalRaw) ? pCalRaw : calibration.pCalRaw,
    marketSkillW: w,
  };
}

function sportSkillRecord(skill, sport) {
  const key = String(sport || '').toUpperCase();
  const row = skill && skill.bySport && skill.bySport[key];
  if (row) return row;
  return emptySportRecord();
}

function attachMarketSkillReport(report, skill) {
  if (!report || !Array.isArray(report.rows)) return report;
  for (const row of report.rows) {
    row.marketSkill = sportSkillRecord(skill, row.sport);
  }
  return report;
}

function publicMarketSkill(skill) {
  const bySport = (skill && skill.bySport) || {};
  const out = {
    enabled: !!(skill && skill.enabled),
    N0: MARKET_SKILL_N0,
  };
  for (const sport of Object.keys(bySport)) out[sport] = bySport[sport];
  return out;
}

function boardProbKey(c) {
  const sport = String((c && c.sport) || '').toUpperCase();
  const matchup = String((c && c.matchup) || '').trim().toLowerCase();
  const pick = String((c && (c.pick || c.side)) || '').trim().toLowerCase();
  const market = String((c && (c.marketFamily || c.market || c.betType)) || '').trim().toLowerCase();
  const line = c && c.line != null && c.line !== '' ? String(c.line) : '';
  return `${sport}|${matchup}|${pick}|${market}|${line}`;
}

function gradedBoardKey(dateISO) {
  return `omega-v2/board-graded/${cardDay(dateISO)}`;
}

function gradedBoardKeyV2(dateISO) {
  return `omega-v2/board-graded-v2/${cardDay(dateISO)}`;
}

function writesDisabled(opts) {
  if (opts && (opts.noWrite || opts.dryRun || opts.shadow)) return true;
  if (process.env.OMEGA_REPLAY_NO_WRITE === '1') return true;
  return false;
}

function marketOf(row) {
  const token = String((row && (row.market || row.betType)) || '').toLowerCase();
  if (!token) return null;
  if (token === 'total' || token === 'totals' || token.includes('total')) return 'Total';
  if (token === 'spread' || token === 'spreads' || /spread|puck|run line/.test(token)) return 'Spread';
  if (token === 'moneyline' || token === 'h2h' || token === 'ml') return 'Moneyline';
  return null;
}

function graderFns() {
  const grader = require('../../get-results-omega');
  return {
    gradePick: grader._test.gradePick,
    findGame: grader._test.findGame,
  };
}

function scoreMerge(lists) {
  const map = new Map();
  const rank = (g) => (g && g.state === 'in' ? 3 : g && g.state === 'post' ? 2 : 1);
  for (const list of lists) {
    for (const game of list || []) {
      if (!game) continue;
      const key = [
        String(game.awayTeam || '').toLowerCase(),
        String(game.homeTeam || '').toLowerCase(),
        String(game.startISO || ''),
      ].join('|');
      const prev = map.get(key);
      if (!prev || rank(game) > rank(prev)) map.set(key, game);
    }
  }
  return [...map.values()];
}

async function fetchNcaamScores(dateISO) {
  const { scoreboardDates, gamesFromScoreboard } = require('../espn-scoreboard');
  const { fetchScoreboardJson, ESPN_WEB_HOST } = require('../../../../js/live-score');
  const lists = [];
  for (const day of scoreboardDates(dateISO)) {
    const ymd = String(day).replace(/-/g, '');
    const url = `${ESPN_WEB_HOST}/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${ymd}&groups=50&limit=300`;
    try {
      const data = await fetchScoreboardJson(url);
      const games = gamesFromScoreboard(data);
      for (const game of games) game._sport = 'NCAAM';
      lists.push(games);
    } catch (_) {
      // One ESPN day failing leaves the others. An empty merge is a miss.
    }
  }
  return scoreMerge(lists);
}

async function defaultFetchScores(dateISO, sport) {
  const key = String(sport || '').toUpperCase();
  if (key === 'NCAAM') return fetchNcaamScores(dateISO);
  const { fetchESPNScores } = require('../espn-scoreboard');
  const games = await fetchESPNScores(dateISO, key);
  for (const game of games || []) game._sport = key;
  return games || [];
}

async function readStoredKey(key, options) {
  if (options && typeof options.readStored === 'function') return options.readStored(key);
  try {
    const { readJson } = require('../omega-vnext/store');
    return await readJson(key);
  } catch (_) {
    return null;
  }
}

async function writeStoredKey(key, body, options) {
  if (options && typeof options.writeStored === 'function') {
    await options.writeStored(key, body);
    return;
  }
  const { storeJson } = require('../omega-vnext/store');
  await storeJson(key, body);
}

async function defaultReadCache(dateISO) {
  try {
    const { readJson } = require('../omega-vnext/store');
    return await readJson(gradedBoardKey(dateISO));
  } catch (_) {
    return null;
  }
}

async function defaultWriteCache(dateISO, body) {
  const { storeJson } = require('../omega-vnext/store');
  await storeJson(gradedBoardKey(dateISO), body);
}

async function defaultReadBoard(dateISO) {
  try {
    const { readJson } = require('../omega-vnext/store');
    return await readJson(boardKey(dateISO));
  } catch (_) {
    return null;
  }
}

async function defaultReadDates() {
  try {
    const { readJson } = require('../omega-vnext/store');
    const stored = await readJson('picks-dates');
    return Array.isArray(stored) ? stored : [];
  } catch (_) {
    return [];
  }
}

function cacheIsComplete(body) {
  return !!(body && body.complete === true && Array.isArray(body.rows));
}

function rowsFromGradedBody(date, body) {
  if (!cacheIsComplete(body)) return null;
  return body.rows.map((row) => ({
    sport: String(row.sport || '').toUpperCase(),
    market: row.market || null,
    y: row.y === 1 ? 1 : 0,
    pMkt: openProb(row.pMkt),
    pCal: openProb(row.pCal),
    date,
  })).filter((row) => row.pMkt != null && row.pCal != null && (row.y === 0 || row.y === 1));
}

function withTimeout(promise, ms, label) {
  let timer;
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) {
    return Promise.reject(new Error(label || 'timeout'));
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || 'timeout')), budget);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Grade one morning board against finals. Pushes and ties are settled and
 * dropped. Pending rows keep a commence time so the settle window can drop
 * a postponed game without freezing a live slate. An unmatched row on a
 * fetched board does not block once every matched game is final: a name
 * miss would otherwise re-pull the same finals forever. A sport whose
 * scoreboard came back empty is a miss, not a final, and counts as pending.
 */
function gradeBoardCandidates(candidates, gamesBySport, gradePick, findGame) {
  const rows = [];
  const pendingRows = [];
  let settled = 0;
  let droppedMispaired = 0;
  const list = Array.isArray(candidates) ? candidates : [];
  const unmatched = new Set();
  const gradeable = [];
  // NCAAF school matching walks every scoreboard game. A morning board
  // repeats that walk once per market (ML, spread, total) of the same
  // game. findGame resolves the game from the matchup and start, then
  // gradePick applies the side. One lookup per game keeps a Saturday
  // board inside the card budget. A miss is not cached: a total has no
  // team name, and caching that miss would hide a later side that matches.
  const gameCache = new Map();
  const locateGame = (pick, games) => {
    const key = [
      pick.sport,
      pick.matchup,
      pick.commenceTime || '',
      pick.homeTeam || '',
      pick.awayTeam || '',
    ].join('\n');
    if (gameCache.has(key)) return gameCache.get(key);
    const game = findGame(pick, games);
    if (game) gameCache.set(key, game);
    return game;
  };
  const markPending = (cand) => {
    pendingRows.push({ commenceTime: cand && cand.commenceTime });
  };
  for (const cand of list) {
    const market = marketOf(cand);
    if (!market) continue;
    const sport = String(cand.sport || '').toUpperCase();
    if (!sport) continue;
    gradeable.push({ cand, market, sport });
    const games = gamesBySport && Array.isArray(gamesBySport[sport]) ? gamesBySport[sport] : null;
    if (!games || !games.length) {
      markPending(cand);
      continue;
    }
    const pick = {
      pick: cand.side || cand.pick,
      betType: market,
      sport,
      matchup: cand.matchup,
      commenceTime: cand.commenceTime,
      homeTeam: cand.homeTeam,
      awayTeam: cand.awayTeam,
    };
    const game = locateGame(pick, games);
    if (!game) {
      unmatched.add(cand);
      continue;
    }
    const result = gradePick(pick, game);
    if (result === 'pending') {
      markPending(cand);
      continue;
    }
    settled += 1;
    if (result !== 'win' && result !== 'loss') continue;
    const pCal = skillProbability(cand);
    const pMkt = skillMarket(cand);
    if (pCal == null || pMkt == null) continue;
    if (mispairedOwnOdds(cand)) {
      droppedMispaired += 1;
      continue;
    }
    rows.push({ sport, market, y: result === 'win' ? 1 : 0, pMkt, pCal });
  }
  const sports = [...new Set(gradeable.map((row) => row.sport))];
  for (const sport of sports) {
    const sportRows = gradeable.filter((row) => row.sport === sport);
    const missed = sportRows.filter((row) => unmatched.has(row.cand));
    if (!missed.length) continue;
    // A sport that matched nothing is a missed scoreboard, not a final.
    // A sport that matched some games keeps the name misses out of the fit
    // and still caches, so a single alias does not re-pull every card.
    if (missed.length === sportRows.length) {
      for (const row of missed) markPending(row.cand);
    }
  }
  const pending = pendingRows.length;
  return {
    rows,
    pending,
    pendingRows,
    settled,
    droppedMispaired,
    complete: pending === 0 && gradeable.length > 0,
  };
}

function calendarDaysBefore(boardDate, cardDate) {
  const board = Date.parse(`${boardDate}T00:00:00Z`);
  const card = Date.parse(`${cardDate}T00:00:00Z`);
  if (!Number.isFinite(board) || !Number.isFinite(card)) return 0;
  return Math.round((card - board) / 86400000);
}

function resolveNow(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  if (typeof now === 'string' && now) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

function commenceMs(value) {
  if (value == null || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * A board two or more calendar days before the card is settled. Pending
 * rows are postponed or unmatched finals: drop them, keep the graded rows,
 * and cache the date. The day before the card still skips while a game is
 * live. A pending commence more than 36h before now is dropped, and the
 * date is kept when at least 90% of the rows that are not stale have settled.
 */
function settleDecision(graded, boardDate, cardDate, now) {
  const pendingRows = graded && Array.isArray(graded.pendingRows) ? graded.pendingRows : [];
  const settled = graded && Number.isFinite(graded.settled) ? graded.settled : 0;
  const gradedRows = graded && Array.isArray(graded.rows) ? graded.rows : [];
  if (calendarDaysBefore(boardDate, cardDate) >= 2) {
    if (!(graded && graded.complete) && !gradedRows.length && !pendingRows.length) {
      return { accept: false, droppedPending: 0 };
    }
    return { accept: true, droppedPending: pendingRows.length };
  }
  const nowMs = resolveNow(now).getTime();
  let stale = 0;
  let recent = 0;
  for (const row of pendingRows) {
    const started = commenceMs(row && row.commenceTime);
    if (started != null && nowMs - started > STALE_PENDING_MS) stale += 1;
    else recent += 1;
  }
  if (!pendingRows.length) {
    return { accept: !!(graded && graded.complete), droppedPending: 0 };
  }
  // Stale commences are already out of `kept`. Compare settled/kept to the
  // floor in integers so 9/10 passes and 8/9 does not.
  const kept = settled + recent;
  const floor = Math.round(NEWEST_SETTLED_FLOOR * 1000);
  const floorMet = kept > 0 && settled * 1000 >= kept * floor;
  if (recent === 0 || floorMet) {
    return { accept: true, droppedPending: stale + recent };
  }
  return { accept: false, droppedPending: 0 };
}

async function gradeBoardDate(dateISO, opts) {
  const date = cardDay(dateISO);
  const readCache = opts.readCache;
  const writeCache = opts.writeCache;
  const readBoard = opts.readBoard;
  const fetchScores = opts.fetchScores;
  const gradePick = opts.gradePick;
  const findGame = opts.findGame;
  let cached = null;
  try {
    cached = await readCache(date);
  } catch (_) {
    cached = null;
  }
  const cachedRows = rowsFromGradedBody(date, cached);
  if (cachedRows) {
    return { date, rows: cachedRows, fromCache: true, complete: true };
  }
  let body = null;
  try {
    body = await readBoard(date);
  } catch (_) {
    return { date, rows: [], skipped: 'board-missing' };
  }
  if (!body || typeof body !== 'object') return { date, rows: [], skipped: 'board-missing' };
  const stamped = cardDay(body.date) || date;
  if (!stamped || (opts.cardDate && stamped >= opts.cardDate)) {
    return { date, rows: [], skipped: 'leak' };
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!candidates.length) return { date, rows: [], skipped: 'empty-board' };
  const sports = [...new Set(candidates.map((c) => String((c && c.sport) || '').toUpperCase()).filter(Boolean))];
  const gamesBySport = {};
  try {
    await Promise.all(sports.map(async (sport) => {
      const games = await fetchScores(date, sport);
      if (!Array.isArray(games)) throw new Error('scores missing');
      gamesBySport[sport] = games;
    }));
  } catch (err) {
    return { date, rows: [], skipped: 'scores-missing' };
  }
  const graded = gradeBoardCandidates(candidates, gamesBySport, gradePick, findGame);
  const decision = settleDecision(graded, date, opts.cardDate, opts.now);
  if (!decision.accept) return { date, rows: [], skipped: 'not-final', complete: false };
  const rows = graded.rows.map((row) => ({ ...row, date }));
  if (!writesDisabled(opts)) {
    try {
      await writeCache(date, {
        date,
        complete: true,
        droppedPending: decision.droppedPending,
        droppedMispaired: graded.droppedMispaired || 0,
        gradedAt: new Date().toISOString(),
        rows: graded.rows.map((row) => ({
          sport: row.sport,
          market: row.market,
          y: row.y,
          pMkt: row.pMkt,
          pCal: row.pCal,
        })),
      });
    } catch (err) {
      console.warn(`[omega-v2] board-graded write skipped ${date}: ${err && err.message ? err.message : err}`);
    }
  }
  return { date, rows, complete: true, fromCache: false, droppedPending: decision.droppedPending };
}

/**
 * Flag on, production caches. A v2 body is the guarded grade. A date that
 * only has the old key keeps those rows (they have no odds, so nothing is
 * removed) and the oldest such date is regraded once. A miss of both keys
 * is graded the same way as before. A regrade that does not finish leaves
 * the old rows in place.
 */
async function loadGuardedRows(ctx) {
  const { card, prior, options, readBoard, fetchScores, gradePick, findGame, budget } = ctx;
  const started = Date.now();
  const states = await Promise.all(prior.map(async (date) => {
    const freshRows = rowsFromGradedBody(date, await readStoredKey(gradedBoardKeyV2(date), options));
    if (freshRows) return { date, kind: 'v2', rows: freshRows };
    const oldRows = rowsFromGradedBody(date, await readStoredKey(gradedBoardKey(date), options));
    if (oldRows) return { date, kind: 'legacy', rows: oldRows };
    return { date, kind: 'miss', rows: [] };
  }));
  const migrate = states.find((state) => state.kind === 'legacy');
  const left = budget - (Date.now() - started);
  const gradeOne = async (date, cap) => {
    if (!(cap > 0)) return null;
    try {
      return await withTimeout(gradeBoardDate(date, {
        cardDate: card,
        now: options.now,
        readCache: async () => null,
        writeCache: async (day, body) => writeStoredKey(gradedBoardKeyV2(day), body, options),
        readBoard,
        fetchScores,
        gradePick,
        findGame,
        noWrite: options.noWrite,
        dryRun: options.dryRun,
        shadow: options.shadow,
      }), cap, 'grade timeout');
    } catch (err) {
      console.warn(`[omega-v2] board grade skipped ${date}: ${err && err.message ? err.message : err}`);
      return null;
    }
  };
  const gradedByDate = new Map();
  await Promise.all(states.map(async (state) => {
    if (state.kind === 'miss') {
      const part = await gradeOne(state.date, left);
      if (part && Array.isArray(part.rows) && part.rows.length) gradedByDate.set(state.date, part.rows);
      return;
    }
    if (!migrate || state.date !== migrate.date) return;
    const cap = Math.min(Math.max(left, 0), MIGRATE_BUDGET_MS);
    const part = await gradeOne(state.date, cap);
    if (part && part.complete && Array.isArray(part.rows)) gradedByDate.set(state.date, part.rows);
  }));
  const rows = [];
  for (const state of states) {
    if (gradedByDate.has(state.date)) rows.push(...gradedByDate.get(state.date));
    else if (state.kind !== 'miss') rows.push(...state.rows);
  }
  return rows;
}

/**
 * Graded morning-board rows for dates strictly before cardDate.
 * Same date list as loadBoardHistory: the last 20 card dates before this
 * one. A cached complete date returns immediately and is not graded again.
 * A missing board or a score timeout is skipped. Dates are graded together,
 * and each one is raced against the budget still left, so one slow
 * scoreboard does not spend the budget a date at a time. The caller also
 * races this function at 20s.
 */
async function loadMarketSkillRows(cardDate, opts = {}) {
  const card = cardDay(cardDate);
  if (!card) return [];
  const options = opts || {};
  const readDates = options.readDates || defaultReadDates;
  const readBoard = options.readBoard || defaultReadBoard;
  const readCache = options.readCache || defaultReadCache;
  const writeCache = options.writeCache || defaultWriteCache;
  const fetchScores = options.fetchScores || defaultFetchScores;
  let gradePick = options.gradePick;
  let findGame = options.findGame;
  if (typeof gradePick !== 'function' || typeof findGame !== 'function') {
    const grader = graderFns();
    gradePick = gradePick || grader.gradePick;
    findGame = findGame || grader.findGame;
  }
  let dates = [];
  try {
    dates = await readDates();
  } catch (_) {
    return [];
  }
  const prior = (Array.isArray(dates) ? dates : [])
    .map((d) => cardDay(d))
    .filter((d) => d && d < card)
    .sort()
    .slice(-GRADED_LIMIT);
  const budget = Number.isFinite(Number(options.budgetMs)) ? Number(options.budgetMs) : LOAD_BUDGET_MS;
  if (pairFixEnabled() && !options.readCache && !options.writeCache) {
    return loadGuardedRows({
      card,
      prior,
      options,
      readBoard,
      fetchScores,
      gradePick,
      findGame,
      budget,
    });
  }
  const started = Date.now();
  const left = budget - (Date.now() - started);
  if (left <= 0) return [];
  const parts = await Promise.all(prior.map(async (date) => {
    try {
      return await withTimeout(gradeBoardDate(date, {
        cardDate: card,
        now: options.now,
        readCache,
        writeCache,
        readBoard,
        fetchScores,
        gradePick,
        findGame,
        noWrite: options.noWrite,
        dryRun: options.dryRun,
        shadow: options.shadow,
      }), left, 'grade timeout');
    } catch (err) {
      console.warn(`[omega-v2] board grade skipped ${date}: ${err && err.message ? err.message : err}`);
      return null;
    }
  }));
  const rows = [];
  for (const part of parts) {
    if (part && Array.isArray(part.rows)) rows.push(...part.rows);
  }
  return rows;
}

/**
 * Offline graded file. Tools pass this in. Production does not read it.
 * A missing file is an empty history (w = 1), not an error.
 */
function readGradedFile(file) {
  try {
    const fs = require('fs');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  MARKET_SKILL_N0,
  blendMarketSkill,
  fitMarketSkillWeight,
  fitMarketSkill,
  normalizeSkillRows,
  skillProbability,
  marketSkillEnabled,
  shouldLoadMarketSkill,
  disabledMarketSkill,
  applyMarketSkill,
  weightFor,
  attachMarketSkillReport,
  publicMarketSkill,
  boardProbKey,
  gradedBoardKey,
  gradedBoardKeyV2,
  gradeBoardCandidates,
  gradeBoardDate,
  loadMarketSkillRows,
  readGradedFile,
  writesDisabled,
};
