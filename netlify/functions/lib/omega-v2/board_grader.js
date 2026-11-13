'use strict';

/**
 * Daily graded-board cache fill.
 *
 * The 10:15 card grades prior morning boards only when
 * OMEGA_V2_MARKET_SKILL is on, and it races that work at 18s. This job
 * calls the same loader with a multi-minute budget so the cache keeps
 * growing while the skill flag is off. It does not build a card, size a
 * stake, or call The Odds API.
 *
 * Dates are the same window loadMarketSkillRows uses: the last 20 saved
 * dates strictly before today ET. A complete cache is not graded again.
 * A date that is not final is not written (gradeBoardDate / cacheIsComplete).
 * Production leaves readCache and writeCache unset so pairFixEnabled()
 * selects omega-v2/board-graded or omega-v2/board-graded-v2, the keys the
 * card reads.
 */

const { pairFixEnabled } = require('./constants');
const {
  loadMarketSkillRows,
  gradedBoardKey,
  gradedBoardKeyV2,
  cacheIsComplete,
} = require('./market_skill');
const { etParts } = require('../et-schedule');

const ENV = 'OMEGA_V2_BOARD_GRADER';
/** Same window as loadMarketSkillRows. */
const GRADED_LIMIT = 20;
/** NCAAM scoreboards have taken ~50s. Several minutes, inside the 15 min worker. */
const GRADER_BUDGET_MS = 8 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function boardGraderEnabled(env) {
  const source = env == null ? process.env : env;
  const flag = source ? source[ENV] : null;
  if (flag == null || String(flag).trim() === '') return true;
  const text = String(flag).trim().toLowerCase();
  return text !== 'off' && text !== '0' && text !== 'false';
}

function cardDay(value) {
  const d = String(value || '').slice(0, 10);
  return DATE_RE.test(d) ? d : '';
}

function priorBoardDates(dates, cardDate) {
  const card = cardDay(cardDate);
  return (Array.isArray(dates) ? dates : [])
    .map((d) => cardDay(d))
    .filter((d) => d && card && d < card)
    .sort()
    .slice(-GRADED_LIMIT);
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

async function readStoredKey(key, opts) {
  if (opts && typeof opts.readStored === 'function') return opts.readStored(key);
  try {
    const { readJson } = require('../omega-vnext/store');
    return await readJson(key);
  } catch (_) {
    return null;
  }
}

/**
 * Match the loader's skip rules. Injected readCache is the unit-test store.
 * Otherwise a v2 complete body wins when the pair fix is on, then the legacy
 * key. The oldest legacy date is the one loadGuardedRows regrades.
 */
async function classifyPrior(prior, opts) {
  const kinds = new Map();
  if (typeof opts.readCache === 'function') {
    for (const date of prior) {
      let body = null;
      try { body = await opts.readCache(date); } catch (_) { body = null; }
      kinds.set(date, cacheIsComplete(body) ? 'complete' : 'miss');
    }
    return { kinds, migrateDate: null };
  }
  const guarded = pairFixEnabled(opts.env);
  for (const date of prior) {
    if (!guarded) {
      const body = await readStoredKey(gradedBoardKey(date), opts);
      kinds.set(date, cacheIsComplete(body) ? 'complete' : 'miss');
      continue;
    }
    const fresh = await readStoredKey(gradedBoardKeyV2(date), opts);
    if (cacheIsComplete(fresh)) {
      kinds.set(date, 'v2');
      continue;
    }
    const old = await readStoredKey(gradedBoardKey(date), opts);
    kinds.set(date, cacheIsComplete(old) ? 'legacy' : 'miss');
  }
  const migrateDate = guarded
    ? (prior.find((date) => kinds.get(date) === 'legacy') || null)
    : null;
  return { kinds, migrateDate };
}

function willFetch(date, kinds, migrateDate) {
  const kind = kinds.get(date);
  if (kind === 'miss') return true;
  if (kind === 'legacy' && date === migrateDate) return true;
  return false;
}

function summaryLine(summary) {
  const base = `[grade-boards-omega] datesGraded=${summary.datesGraded} rows=${summary.rows} skipped=${summary.skipped}`;
  if (summary.killSwitch) return `${base} kill-switch=off`;
  return base;
}

function loadOptions(opts, prior, now, budgetMs) {
  const noWrite = !!(opts.noWrite || opts.dryRun || opts.shadow);
  const loadOpts = {
    now,
    budgetMs,
    noWrite,
    dryRun: !!opts.dryRun,
    shadow: !!opts.shadow,
    readDates: async () => prior,
  };
  if (typeof opts.readBoard === 'function') loadOpts.readBoard = opts.readBoard;
  if (typeof opts.fetchScores === 'function') loadOpts.fetchScores = opts.fetchScores;
  if (typeof opts.readCache === 'function') loadOpts.readCache = opts.readCache;
  if (typeof opts.writeCache === 'function') loadOpts.writeCache = opts.writeCache;
  if (typeof opts.gradePick === 'function') loadOpts.gradePick = opts.gradePick;
  if (typeof opts.findGame === 'function') loadOpts.findGame = opts.findGame;
  return loadOpts;
}

async function runBoardGrader(opts = {}) {
  const env = opts.env || process.env;
  if (!boardGraderEnabled(env)) {
    const summary = {
      ok: true,
      killSwitch: true,
      skippedReason: 'kill-switch',
      cardDate: null,
      datesGraded: 0,
      rows: 0,
      skipped: 0,
      byDate: {},
      gradedDates: [],
      skippedDates: [],
      noWrite: true,
    };
    console.log(summaryLine(summary));
    return summary;
  }
  const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
  const cardDate = cardDay(opts.cardDate) || etParts(now).ymd;
  const readDates = opts.readDates || defaultReadDates;
  let rawDates = [];
  try { rawDates = await readDates(); } catch (_) { rawDates = []; }
  const prior = priorBoardDates(rawDates, cardDate);
  const { kinds, migrateDate } = await classifyPrior(prior, { ...opts, env });
  const fetchDates = prior.filter((date) => willFetch(date, kinds, migrateDate));
  const skippedDates = prior.filter((date) => !willFetch(date, kinds, migrateDate));
  const budgetMs = Number.isFinite(Number(opts.budgetMs)) ? Number(opts.budgetMs) : GRADER_BUDGET_MS;
  const loadOpts = loadOptions(opts, prior, now, budgetMs);
  const loadRows = opts.loadRows || loadMarketSkillRows;
  let rows = [];
  try {
    const loaded = await loadRows(cardDate, loadOpts);
    rows = Array.isArray(loaded) ? loaded : [];
  } catch (err) {
    console.warn(`[grade-boards-omega] load failed: ${err && err.message ? err.message : err}`);
    rows = [];
  }
  const fetchSet = new Set(fetchDates);
  const fresh = rows.filter((row) => row && fetchSet.has(row.date));
  const gradedDates = [...new Set(fresh.map((row) => row.date))];
  const byDate = {};
  for (const date of fetchDates) {
    byDate[date] = fresh.filter((row) => row.date === date).length;
  }
  const summary = {
    ok: true,
    killSwitch: false,
    cardDate,
    datesGraded: gradedDates.length,
    rows: fresh.length,
    skipped: skippedDates.length,
    byDate,
    gradedDates,
    skippedDates,
    noWrite: !!loadOpts.noWrite,
    budgetMs,
  };
  console.log(summaryLine(summary));
  return summary;
}

module.exports = {
  ENV,
  GRADED_LIMIT,
  GRADER_BUDGET_MS,
  boardGraderEnabled,
  priorBoardDates,
  runBoardGrader,
  summaryLine,
  cacheIsComplete,
};
