'use strict';

/**
 * Omega historical REPLAY harness.
 * Runs omega-vnext against Odds API historical snapshots into an isolated
 * eval store (omega-replay/{runId}/*). NEVER overwrites live picks-{date}.
 *
 * Scoring (v12.3.5+): joins best-available closes/settles already in the stack
 * (clv-{date}, live picks-{date} settle fields). Soft-fails with null + reason
 * when closes/settles are absent. Does not invent books or write live keys.
 *
 * Quota caution: ~1 historical odds request × enabled sports × days.
 * Default dryRun=true. Hard cap MAX_DAYS=14.
 */

const { SPORTS_ENABLED, MODEL_VERSION } = require('./config');
const { storeReplayCard, storeReplaySummary, assertReplayKey, readJson, readPicks } = require('./store');
const { gradeNoVigClv, attachRealizedAliases, summarizeBySportMarket } = require('./clv_grade');
const { americanToDecimal } = require('./odds_math');

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

function normMatchKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickMatchKey(p) {
  if (!p) return '';
  if (p.pickId) return `id:${p.pickId}`;
  const matchup = p.matchup || [p.awayTeam, p.homeTeam].filter(Boolean).join(' @ ');
  const side = p.pick || p.side || '';
  const market = p.market || p.betType || '';
  return normMatchKey(`${matchup}|${market}|${side}`);
}

function parseUnits(u) {
  if (u == null) return null;
  if (typeof u === 'number' && Number.isFinite(u)) return u;
  const m = String(u).replace(/u$/i, '').trim();
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
}

function parseAmerican(odds) {
  if (odds == null || odds === 'N/A') return null;
  const n = parseInt(String(odds).replace(/[^0-9+-]/g, ''), 10);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Profit in units from settled result (track-clv-omega calcProfit shape). */
function profitUnits(result, units, american) {
  const r = String(result || '').toLowerCase();
  if (!r || r === 'pending' || r === 'push') return r === 'push' ? 0 : null;
  const u = parseUnits(units);
  if (u == null) return null;
  if (r === 'loss') return -u;
  if (r === 'win') {
    const a = parseAmerican(american);
    if (a == null) return null;
    const dec = americanToDecimal(a);
    if (dec == null) return null;
    return +(u * (dec - 1)).toFixed(4);
  }
  return null;
}

function findCloseRecord(pick, clvBlob) {
  const rows = (clvBlob && Array.isArray(clvBlob.picks)) ? clvBlob.picks : [];
  if (!rows.length) return null;
  const key = pickMatchKey(pick);
  let hit = rows.find(r => pickMatchKey(r) === key);
  if (hit) return hit;
  const mPick = normMatchKey(pick.pick || pick.side);
  const mMatch = normMatchKey(pick.matchup || `${pick.awayTeam || ''} @ ${pick.homeTeam || ''}`);
  hit = rows.find(r => {
    const rm = normMatchKey(r.matchup);
    const rp = normMatchKey(r.pick);
    return mMatch && rm && mMatch === rm && mPick && rp && (rp === mPick || rp.includes(mPick) || mPick.includes(rp));
  });
  return hit || null;
}

function findSettleRecord(pick, picksBlob) {
  const rows = (picksBlob && Array.isArray(picksBlob.picks)) ? picksBlob.picks : [];
  if (!rows.length) return null;
  const key = pickMatchKey(pick);
  let hit = rows.find(r => pickMatchKey(r) === key);
  if (hit) return hit;
  const mPick = normMatchKey(pick.pick || pick.side);
  const mMatch = normMatchKey(pick.matchup || `${pick.awayTeam || ''} @ ${pick.homeTeam || ''}`);
  hit = rows.find(r => {
    const rm = normMatchKey(r.matchup);
    const rp = normMatchKey(r.pick);
    return mMatch && rm && mMatch === rm && mPick && rp && (rp === mPick || rp.includes(mPick) || mPick.includes(rp));
  });
  return hit || null;
}

/**
 * Score one replay day against stored closes/settles.
 * Injectable readers for unit tests (no network).
 *
 * @returns {{
 *   date, nPicks, nScoredClv, nScoredSettle, meanClvCents, beatClosePct,
 *   roiUnits, roiPct, unitsRisked, scoreReason, picks: Array
 * }}
 */
function scoreReplayDay(card, dateISO, opts = {}) {
  const picks = (card && Array.isArray(card.picks)) ? card.picks : [];
  const clvBlob = opts.clvBlob !== undefined ? opts.clvBlob : null;
  const picksBlob = opts.picksBlob !== undefined ? opts.picksBlob : null;

  const scored = [];
  let clvSum = 0;
  let nClv = 0;
  let beats = 0;
  let profitSum = 0;
  let riskSum = 0;
  let nSettle = 0;

  for (const pick of picks) {
    const row = {
      pick: pick.pick || pick.side || null,
      matchup: pick.matchup || null,
      sport: pick.sport || null,
      market: pick.market || pick.betType || null,
      pickId: pick.pickId || null,
      clvCents: null,
      beatClose: null,
      result: null,
      profitUnits: null,
      units: parseUnits(pick.units),
      source: null,
    };

    // 1) Prefer existing track-clv-omega blob (realized no-vig CLV + optional settle).
    const clvRec = findCloseRecord(pick, clvBlob);
    if (clvRec) {
      attachRealizedAliases(clvRec);
      const cents = typeof clvRec.clvCents === 'number' ? clvRec.clvCents
        : (typeof clvRec.realizedClvCents === 'number' ? clvRec.realizedClvCents
          : (typeof clvRec.clv === 'number' ? +(clvRec.clv * 100).toFixed(2) : null));
      if (cents != null && Number.isFinite(cents)) {
        row.clvCents = cents;
        row.beatClose = clvRec.beatClose === true || clvRec.beatClosing === true || cents > 0;
        row.source = 'clv-blob';
        nClv += 1;
        clvSum += cents;
        if (row.beatClose) beats += 1;
      } else if (clvRec.closingOdds && (pick.odds || pick.pickTimeOdds || clvRec.pickTimeOdds)) {
        const betA = parseAmerican(pick.odds || pick.pickTimeOdds || clvRec.pickTimeOdds);
        const closeA = parseAmerican(clvRec.closingOdds);
        const ov = Number(clvRec.closingOverround) || 1.045;
        const g = gradeNoVigClv(betA, closeA, ov);
        if (g) {
          row.clvCents = g.clvCents;
          row.beatClose = g.beatClose;
          row.source = 'clv-blob-regrade';
          nClv += 1;
          clvSum += g.clvCents;
          if (g.beatClose) beats += 1;
        }
      }
      if (clvRec.result && clvRec.result !== 'pending') {
        row.result = clvRec.result;
        const pu = clvRec.profit != null && Number.isFinite(Number(clvRec.profit))
          ? Number(clvRec.profit)
          : profitUnits(clvRec.result, pick.units || clvRec.units, pick.odds || clvRec.pickTimeOdds);
        if (pu != null) {
          row.profitUnits = pu;
          const u = parseUnits(pick.units || clvRec.units) || 0;
          nSettle += 1;
          profitSum += pu;
          riskSum += Math.abs(u);
        }
      }
    }

    // 2) Live picks-{date} settle fields (read-only; never written by replay).
    if (row.result == null) {
      const live = findSettleRecord(pick, picksBlob);
      if (live && live.result && live.result !== 'pending') {
        row.result = live.result;
        const pu = live.profit != null && Number.isFinite(Number(live.profit))
          ? Number(live.profit)
          : profitUnits(live.result, pick.units || live.units, pick.odds || live.odds);
        if (pu != null) {
          row.profitUnits = pu;
          const u = parseUnits(pick.units || live.units) || 0;
          nSettle += 1;
          profitSum += pu;
          riskSum += Math.abs(u);
          if (!row.source) row.source = 'picks-blob-settle';
        }
      }
    }

    // 3) Card-carried close/settle (rare; e.g. injected fixtures).
    if (row.clvCents == null && pick.closingOdds && (pick.odds || pick.pickTimeOdds)) {
      const betA = parseAmerican(pick.odds || pick.pickTimeOdds);
      const closeA = parseAmerican(pick.closingOdds);
      const ov = Number(pick.closingOverround) || 1.045;
      const g = gradeNoVigClv(betA, closeA, ov);
      if (g) {
        row.clvCents = g.clvCents;
        row.beatClose = g.beatClose;
        row.source = row.source || 'card-close';
        nClv += 1;
        clvSum += g.clvCents;
        if (g.beatClose) beats += 1;
      }
    }
    if (row.result == null && pick.result && pick.result !== 'pending') {
      const pu = profitUnits(pick.result, pick.units, pick.odds);
      if (pu != null) {
        row.result = pick.result;
        row.profitUnits = pu;
        const u = parseUnits(pick.units) || 0;
        nSettle += 1;
        profitSum += pu;
        riskSum += Math.abs(u);
        if (!row.source) row.source = 'card-settle';
      }
    }

    scored.push(row);
  }

  let scoreReason = null;
  if (!picks.length) scoreReason = 'no_picks';
  else if (nClv === 0 && nSettle === 0) scoreReason = 'closes_missing';
  else if (nClv === 0) scoreReason = 'closes_missing_partial_settle';
  else if (nSettle === 0) scoreReason = 'settles_missing_partial_clv';
  else if (nClv < picks.length || nSettle < picks.length) scoreReason = 'partial';

  return {
    date: dateISO,
    nPicks: picks.length,
    nScoredClv: nClv,
    nScoredSettle: nSettle,
    meanClvCents: nClv ? +((clvSum / nClv).toFixed(2)) : null,
    beatClosePct: nClv ? +((beats / nClv) * 100).toFixed(1) : null,
    roiUnits: nSettle ? +profitSum.toFixed(4) : null,
    unitsRisked: nSettle ? +riskSum.toFixed(4) : null,
    roiPct: nSettle && riskSum > 0 ? +((profitSum / riskSum) * 100).toFixed(2) : null,
    scoreReason,
    picks: scored,
  };
}

async function loadScoreInputs(dateISO, opts = {}) {
  const readClv = opts.readClvFn || (async (d) => {
    try { return await readJson(`clv-${d}`); } catch (_) { return null; }
  });
  const readLive = opts.readPicksFn || (async (d) => {
    try { return await readPicks(d); } catch (_) { return null; }
  });
  let clvBlob = null;
  let picksBlob = null;
  try { clvBlob = await readClv(dateISO); } catch (e) {
    console.warn(`[omega-replay] clv-${dateISO} soft-fail: ${e.message}`);
  }
  try { picksBlob = await readLive(dateISO); } catch (e) {
    console.warn(`[omega-replay] picks-${dateISO} read soft-fail: ${e.message}`);
  }
  return { clvBlob, picksBlob };
}

function summarizeReplay(run) {
  const days = (run && run.days) || [];
  let nPicks = 0;
  let nEmpty = 0;
  let clvSum = 0;
  let nClv = 0;
  let beatsWeighted = 0;
  let profitSum = 0;
  let riskSum = 0;
  let nSettle = 0;
  let nDaysClv = 0;
  let nDaysSettle = 0;
  let nDaysMissingCloses = 0;

  for (const d of days) {
    const n = d && d.nPicks != null ? d.nPicks : 0;
    nPicks += n;
    if (!n) nEmpty += 1;
    const sc = d && d.score;
    if (!sc) continue;
    if (sc.nScoredClv > 0 && sc.meanClvCents != null) {
      clvSum += sc.meanClvCents * sc.nScoredClv;
      nClv += sc.nScoredClv;
      if (sc.beatClosePct != null) beatsWeighted += (sc.beatClosePct / 100) * sc.nScoredClv;
      nDaysClv += 1;
    }
    if (sc.nScoredSettle > 0 && sc.roiUnits != null) {
      profitSum += sc.roiUnits;
      riskSum += sc.unitsRisked || 0;
      nSettle += sc.nScoredSettle;
      nDaysSettle += 1;
    }
    if (sc.scoreReason === 'closes_missing' || sc.scoreReason === 'closes_missing_partial_settle') {
      nDaysMissingCloses += 1;
    }
  }

  const meanClvCents = nClv ? +((clvSum / nClv).toFixed(2)) : null;
  const beatClosePct = nClv ? +((beatsWeighted / nClv) * 100).toFixed(1) : null;
  const roiUnits = nSettle ? +profitSum.toFixed(4) : null;
  const roiPct = nSettle && riskSum > 0 ? +((profitSum / riskSum) * 100).toFixed(2) : null;

  const notes = [
    'Eval store only — never wrote live picks-{date}',
    `Estimated Odds API historical calls ≈ ${run && run.estimatedOddsCalls != null ? run.estimatedOddsCalls : '?'}`,
    'CLV/ROI joined from clv-{date} / picks-{date} settles when present; null + scoreReason when closes absent',
  ];
  if (nDaysMissingCloses) notes.push(`${nDaysMissingCloses} day(s) missing closes (soft-fail)`);

  return {
    runId: run && run.runId,
    modelVersion: (run && run.modelVersion) || MODEL_VERSION,
    nDays: days.length,
    nPicks,
    nEmptyDays: nEmpty,
    nScoredClv: nClv,
    nScoredSettle: nSettle,
    nDaysWithClv: nDaysClv,
    nDaysWithSettle: nDaysSettle,
    nDaysMissingCloses,
    meanClvCents,
    beatClosePct,
    roiUnits,
    roiPct,
    unitsRisked: nSettle ? +riskSum.toFixed(4) : null,
    // Deprecated aliases kept null so old callers do not misread zeros.
    clvPlaceholder: null,
    roiPlaceholder: null,
    notes,
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
    score = true,
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

  let dayScore = null;
  if (score !== false) {
    try {
      const inputs = await loadScoreInputs(dateISO, opts);
      dayScore = scoreReplayDay(card, dateISO, inputs);
    } catch (e) {
      console.warn(`[omega-replay] score soft-fail ${dateISO}: ${e.message}`);
      dayScore = {
        date: dateISO,
        nPicks,
        nScoredClv: 0,
        nScoredSettle: 0,
        meanClvCents: null,
        beatClosePct: null,
        roiUnits: null,
        roiPct: null,
        unitsRisked: null,
        scoreReason: `score_error:${e.message}`,
        picks: [],
      };
    }
  }

  let key = null;
  if (!dryRun) {
    key = await storeReplayCard(runId, dateISO, {
      ...card,
      historicalSnapshot,
      replayMeta: { runId, dryRun: false, historicalSnapshot },
      replayScore: dayScore,
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
    score: dayScore,
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
        dateISO, dryRun, runId, skipNarrate, sports,
        generateFn: opts.generateFn,
        readClvFn: opts.readClvFn,
        readPicksFn: opts.readPicksFn,
        score: opts.score,
      });
      days.push(row);
      const sc = row.score;
      console.log(`[omega-replay] ${dateISO} picks=${row.nPicks} clvN=${sc && sc.nScoredClv} roiN=${sc && sc.nScoredSettle} reason=${sc && sc.scoreReason} key=${row.key || '(dry)'}`);
    } catch (e) {
      console.error(`[omega-replay] ${dateISO} soft-fail: ${e.message}`);
      days.push({
        date: dateISO,
        error: e.message,
        nPicks: 0,
        dryRun: !!dryRun,
        score: {
          date: dateISO,
          nPicks: 0,
          nScoredClv: 0,
          nScoredSettle: 0,
          meanClvCents: null,
          beatClosePct: null,
          roiUnits: null,
          roiPct: null,
          scoreReason: `day_error:${e.message}`,
        },
      });
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
  scoreReplayDay,
  profitUnits,
  runReplayDay,
  runReplayRange,
  assertReplayKey,
  enabledSports,
};
