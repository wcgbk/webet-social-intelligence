'use strict';

/**
 * Omega historical REPLAY harness.
 * Runs omega-vnext against Odds API historical snapshots into an isolated
 * eval store (omega-replay/{runId}/*). NEVER overwrites live picks-{date}.
 *
 * Quota caution: ~1 historical odds request × enabled sports × days.
 * Default dryRun=true. Hard cap MAX_DAYS=14.
 */

const { SPORTS_ENABLED, MODEL_VERSION } = require('./config');
const { storeReplayCard, storeReplaySummary, assertReplayKey } = require('./store');

const DEFAULT_MAX_DAYS = 7;
const HARD_MAX_DAYS = 14;

function enabledSports() {
  return Object.keys(SPORTS_ENABLED).filter(s => SPORTS_ENABLED[s]);
}

function parseDateRange(from, to, { maxDays = DEFAULT_MAX_DAYS } = {}) {
  const start = String(from || '');
  const end = String(to || from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(`bad date range: ${from}..${to}`);
  }
  if (end < start) throw new Error(`to < from: ${from}..${to}`);
  const cap = Math.min(Math.max(1, Number(maxDays) || DEFAULT_MAX_DAYS), HARD_MAX_DAYS);
  const dates = [];
  let [y, m, d] = start.split('-').map(Number);
  const endT = Date.UTC(...end.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  for (;;) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dates.push(iso);
    if (iso === end || dates.length >= cap) break;
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    const cur = Date.UTC(y, m - 1, d);
    if (cur > endT) break;
  }
  return { dates, maxDays: cap, truncated: dates[dates.length - 1] < end };
}

/**
 * Mid-morning ET snapshot timestamp for Odds API historical `date=` param.
 * 13:00Z ≈ 9:00am EDT; 14:00Z ≈ 9:00am EST — we use 13:00Z year-round as a
 * documented approximation (EDT season dominates NFL/MLB windows).
 */
function historicalTimestampForDate(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${dateISO}`);
  return `${d}T13:00:00Z`;
}

function estimateQuotaCalls(nDays, sports) {
  const nSports = (sports && sports.length) || enabledSports().length;
  return nDays * nSports;
}

function summarizeReplay(run) {
  const days = (run && run.days) || [];
  let nPicks = 0;
  let nEmpty = 0;
  for (const d of days) {
    const n = d && d.nPicks != null ? d.nPicks : 0;
    nPicks += n;
    if (!n) nEmpty += 1;
  }
  return {
    runId: run && run.runId,
    modelVersion: (run && run.modelVersion) || MODEL_VERSION,
    nDays: days.length,
    nPicks,
    nEmptyDays: nEmpty,
    clvPlaceholder: null,
    roiPlaceholder: null,
    notes: [
      'CLV/ROI placeholders until closes are joined in a later pass',
      'Eval store only — never wrote live picks-{date}',
      `Estimated Odds API historical calls ≈ ${run && run.estimatedOddsCalls != null ? run.estimatedOddsCalls : '?'}`,
    ],
    dryRun: !!(run && run.dryRun),
    from: run && run.from,
    to: run && run.to,
  };
}

/**
 * Replay one ET date. Always uses generate dryRun (no live storePicks).
 * When dryRun=false, writes omega-replay/{runId}/picks-{date} only.
 */
async function runReplayDay(opts = {}) {
  const {
    dateISO,
    dryRun = true,
    runId = 'adhoc',
    skipNarrate = true,
    sports = null,
    generateFn = null,
  } = opts;
  const historicalSnapshot = historicalTimestampForDate(dateISO);
  const generate = generateFn || (await loadGenerate());
  const card = await generate({
    date: dateISO,
    historicalSnapshot,
    dryRun: true, // ALWAYS dry for live store
    simMode: false,
    force: false,
    skipNarrate: !!skipNarrate,
    sportsFilter: sports,
  });
  const nPicks = Array.isArray(card && card.picks) ? card.picks.length : 0;
  let key = null;
  if (!dryRun) {
    key = await storeReplayCard(runId, dateISO, {
      ...card,
      historicalSnapshot,
      replayMeta: { runId, dryRun: false, historicalSnapshot },
    });
  }
  return {
    date: dateISO,
    historicalSnapshot,
    nPicks,
    empty: nPicks === 0,
    key,
    dryRun: !!dryRun,
    model: card && card.model,
  };
}

async function loadGenerate() {
  // Lazy require so unit tests can inject generateFn without loading narrate.
  const { generateOmegaVnext } = require('./index');
  return generateOmegaVnext;
}

async function runReplayRange(opts = {}) {
  const from = opts.from;
  const to = opts.to || opts.from;
  const dryRun = opts.dryRun !== false; // default true
  const maxDays = opts.maxDays != null ? opts.maxDays : DEFAULT_MAX_DAYS;
  const runId = opts.runId || `replay-${from}-to-${to || from}`;
  const skipNarrate = opts.skipNarrate !== false;
  const sports = opts.sports || null;
  const { dates, truncated, maxDays: cap } = parseDateRange(from, to, { maxDays });
  const estimatedOddsCalls = estimateQuotaCalls(dates.length, sports);
  console.log(`[omega-replay] runId=${runId} days=${dates.length} dryRun=${dryRun} estOddsCalls≈${estimatedOddsCalls} cap=${cap}`);
  if (estimatedOddsCalls > 40) {
    console.warn(`[omega-replay] QUOTA CAUTION: ~${estimatedOddsCalls} Odds API historical calls — shrink window if needed`);
  }
  const days = [];
  for (const dateISO of dates) {
    try {
      const row = await runReplayDay({
        dateISO, dryRun, runId, skipNarrate, sports, generateFn: opts.generateFn,
      });
      days.push(row);
      console.log(`[omega-replay] ${dateISO} picks=${row.nPicks} key=${row.key || '(dry)'}`);
    } catch (e) {
      console.error(`[omega-replay] ${dateISO} soft-fail: ${e.message}`);
      days.push({ date: dateISO, error: e.message, nPicks: 0, dryRun: !!dryRun });
    }
  }
  const run = {
    runId,
    from,
    to,
    dryRun: !!dryRun,
    modelVersion: MODEL_VERSION,
    estimatedOddsCalls,
    truncated,
    maxDays: cap,
    days,
  };
  const summary = summarizeReplay(run);
  let summaryKey = null;
  if (!dryRun) {
    try {
      summaryKey = await storeReplaySummary(runId, { ...summary, days });
    } catch (e) {
      console.error(`[omega-replay] summary soft-fail: ${e.message}`);
    }
  }
  return { ...run, summary, summaryKey };
}

module.exports = {
  DEFAULT_MAX_DAYS,
  HARD_MAX_DAYS,
  parseDateRange,
  historicalTimestampForDate,
  estimateQuotaCalls,
  summarizeReplay,
  runReplayDay,
  runReplayRange,
  assertReplayKey,
  enabledSports,
};
