'use strict';

/**
 * Daily progress row for /tracking. Display only.
 * Does not price, select, grade, or stake a bet.
 *
 * Three tracks, each for Edge (all model versions) and Omega:
 *
 * engineering
 *   Stored elite-desk percentiles, the same four lenses as /percentile:
 *   Processes, Architecture, Math, Overall. Not computed from ROI.
 *   The daily job copies the latest manual entry on or before the report
 *   date, separately for Edge and for Omega.
 *
 * kpi
 *   The track-record fields get-results-omega already publishes
 *   (aggregateDays, then the percentile page):
 *     record    straight wins-losses-pushes
 *     accuracy  straight accuracy (pushes excluded)
 *     roi       all bets, straights plus the parlay
 *     profit    that same all-bet profit, in units and in dollars at $150
 *
 * clv
 *   Ledger totals: average CLV in percentage points, percent of closes that
 *   beat the close, and an elite percentile of that average.
 *   Edge uses totals.overall. Omega uses totals.byModel.Omega.
 *
 * Elite CLV percentile, piecewise linear on average pick CLV (pp).
 * The ends clamp. Knots are exact. Between knots the line is linear.
 * The result is rounded to one decimal.
 *
 *     avg CLV      percentile
 *     <= -2 pp     20th
 *     -1 pp        35th
 *      0           50th
 *     +1 pp        75th
 *     +2 pp        85th
 *     >= +3 pp     95th
 */

const DOLLAR_PER_UNIT = 150;
const RESULTS_CACHE_KEY = 'results-omega-cache-v9-ncaaf-state';
const INDEX_KEY = 'omega-tracking/index';
const LENSES = ['processes', 'architecture', 'math', 'overall'];

const CLV_PERCENTILE_ANCHORS = Object.freeze([
  Object.freeze({ avgClvPp: -2, percentile: 20 }),
  Object.freeze({ avgClvPp: -1, percentile: 35 }),
  Object.freeze({ avgClvPp: 0, percentile: 50 }),
  Object.freeze({ avgClvPp: 1, percentile: 75 }),
  Object.freeze({ avgClvPp: 2, percentile: 85 }),
  Object.freeze({ avgClvPp: 3, percentile: 95 }),
]);

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function clvPercentile(avgClvPp) {
  if (avgClvPp == null || !Number.isFinite(Number(avgClvPp))) return null;
  const x = Number(avgClvPp);
  const anchors = CLV_PERCENTILE_ANCHORS;
  if (x <= anchors[0].avgClvPp) return anchors[0].percentile;
  const last = anchors[anchors.length - 1];
  if (x >= last.avgClvPp) return last.percentile;
  for (let i = 1; i < anchors.length; i += 1) {
    const left = anchors[i - 1];
    const right = anchors[i];
    if (x <= right.avgClvPp) {
      const span = right.avgClvPp - left.avgClvPp;
      const t = (x - left.avgClvPp) / span;
      return round1(left.percentile + t * (right.percentile - left.percentile));
    }
  }
  return null;
}

function dayKey(dateISO) {
  return `omega-tracking/${dateISO}`;
}

function lensValue(block, key) {
  if (!block || typeof block !== 'object') return null;
  if (block[key] != null && block[key] !== '') return block[key];
  const titled = key.charAt(0).toUpperCase() + key.slice(1);
  if (block[titled] != null && block[titled] !== '') return block[titled];
  return null;
}

function scoreBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const out = {};
  for (const key of LENSES) {
    const n = Number(lensValue(block, key));
    if (!Number.isFinite(n)) return null;
    out[key] = n;
  }
  return out;
}

function carryEngineering(entries, asOf, side) {
  const list = (entries || [])
    .filter((entry) => entry && entry.date && String(entry.date) <= String(asOf))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let current = null;
  let scoredOn = null;
  for (const entry of list) {
    const block = scoreBlock(entry[side]);
    if (!block) continue;
    current = block;
    scoredOn = entry.date;
  }
  if (!current) {
    return {
      processes: null,
      architecture: null,
      math: null,
      overall: null,
      scoredOn: null,
      carriedForward: false,
    };
  }
  return {
    processes: current.processes,
    architecture: current.architecture,
    math: current.math,
    overall: current.overall,
    scoredOn,
    carriedForward: scoredOn !== asOf,
  };
}

function parsePct(value) {
  if (value == null || value === '--' || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Map one aggregateDays() result, or the matching slice of a
 * get-results-omega body, onto the track-record metrics.
 * Straight wins, losses, and accuracy. Pushes from cumulative.
 * ROI and profit from cumulative (straights + parlay) at $150.
 */
function kpiFromAggregate(block) {
  const cum = (block && block.cumulative) || {};
  const str = (block && block.straight) || {};
  const wins = Number(str.wins) || 0;
  const losses = Number(str.losses) || 0;
  const pushes = Number(cum.pushes) || 0;
  const profitDollars = Math.round(Number(cum.totalProfit) || 0);
  const accuracyPct = parsePct(str.accuracy);
  const roiPct = parsePct(cum.roi);
  return {
    wins,
    losses,
    pushes,
    record: `${wins}-${losses}-${pushes}`,
    accuracyPct,
    accuracy: str.accuracy == null ? null : String(str.accuracy),
    roiPct,
    roi: cum.roi == null ? null : String(cum.roi),
    profitDollars,
    profitUnits: round2(profitDollars / DOLLAR_PER_UNIT),
    pending: Number(cum.pending) || 0,
  };
}

function kpiSidesFromResults(results) {
  if (!results || !results.cumulative || !results.straight || !results.omegaOnly) {
    throw new Error('results document is missing cumulative, straight, or omegaOnly');
  }
  return {
    edge: kpiFromAggregate({ cumulative: results.cumulative, straight: results.straight }),
    omega: kpiFromAggregate(results.omegaOnly),
  };
}

/** Same mapping, starting from day rows and the shared aggregateDays. */
function kpiSidesFromDays(edgeDays, omegaDays, aggregateDays) {
  if (typeof aggregateDays !== 'function') throw new Error('aggregateDays is required');
  return {
    edge: kpiFromAggregate(aggregateDays(edgeDays || [])),
    omega: kpiFromAggregate(aggregateDays(omegaDays || [])),
  };
}

function clvBlock(bucket) {
  const src = bucket || {};
  const avg = src.avgClvPp == null || !Number.isFinite(Number(src.avgClvPp))
    ? null
    : Number(src.avgClvPp);
  const beat = src.beatClosePct == null || !Number.isFinite(Number(src.beatClosePct))
    ? null
    : Number(src.beatClosePct);
  return {
    n: Number(src.n) || 0,
    avgClvPp: avg,
    beatClosePct: beat,
    percentile: clvPercentile(avg),
    smallSample: !!src.smallSample,
  };
}

function clvSidesFromReport(report) {
  const totals = report && report.totals;
  if (!totals || !totals.overall || !totals.byModel || !totals.byModel.Omega) {
    throw new Error('clv report is missing totals');
  }
  return {
    edge: clvBlock(totals.overall),
    omega: clvBlock(totals.byModel.Omega),
  };
}

function nullEngineeringDelta() {
  return { processes: null, architecture: null, math: null, overall: null };
}

function nullKpiDelta() {
  return {
    wins: null,
    losses: null,
    pushes: null,
    accuracyPct: null,
    roiPct: null,
    profitDollars: null,
    profitUnits: null,
  };
}

function nullClvDelta() {
  return { avgClvPp: null, beatClosePct: null, percentile: null };
}

function nullSideDelta() {
  return {
    engineering: nullEngineeringDelta(),
    kpi: nullKpiDelta(),
    clv: nullClvDelta(),
  };
}

function deltaNum(prev, next, places) {
  if (prev == null || next == null) return null;
  const left = Number(prev);
  const right = Number(next);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const raw = right - left;
  if (places === 0) return Math.round(raw);
  if (places === 1) return round1(raw);
  return round2(raw);
}

function sideDelta(prev, next) {
  if (!prev || !next) return nullSideDelta();
  const pe = prev.engineering || {};
  const ne = next.engineering || {};
  const pk = prev.kpi || {};
  const nk = next.kpi || {};
  const pc = prev.clv || {};
  const nc = next.clv || {};
  return {
    engineering: {
      processes: deltaNum(pe.processes, ne.processes, 0),
      architecture: deltaNum(pe.architecture, ne.architecture, 0),
      math: deltaNum(pe.math, ne.math, 0),
      overall: deltaNum(pe.overall, ne.overall, 0),
    },
    kpi: {
      wins: deltaNum(pk.wins, nk.wins, 0),
      losses: deltaNum(pk.losses, nk.losses, 0),
      pushes: deltaNum(pk.pushes, nk.pushes, 0),
      accuracyPct: deltaNum(pk.accuracyPct, nk.accuracyPct, 1),
      roiPct: deltaNum(pk.roiPct, nk.roiPct, 1),
      profitDollars: deltaNum(pk.profitDollars, nk.profitDollars, 0),
      profitUnits: deltaNum(pk.profitUnits, nk.profitUnits, 2),
    },
    clv: {
      avgClvPp: deltaNum(pc.avgClvPp, nc.avgClvPp, 2),
      beatClosePct: deltaNum(pc.beatClosePct, nc.beatClosePct, 1),
      percentile: deltaNum(pc.percentile, nc.percentile, 1),
    },
  };
}

function buildDayRow(opts) {
  const src = opts || {};
  const date = src.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error(`tracking row refused bad date: ${date}`);
  }
  const entries = src.entries || (src.scores && src.scores.entries) || [];
  const edgeEng = carryEngineering(entries, date, 'edge');
  const omegaEng = carryEngineering(entries, date, 'omega');
  if (edgeEng.processes == null || omegaEng.processes == null) {
    throw new Error(`no engineering score on or before ${date}`);
  }
  const kpi = src.kpi || kpiSidesFromResults(src.results);
  const clv = src.clv || clvSidesFromReport(src.clvReport);
  return {
    date,
    edge: { engineering: edgeEng, kpi: kpi.edge, clv: clv.edge },
    omega: { engineering: omegaEng, kpi: kpi.omega, clv: clv.omega },
  };
}

function applyDeltas(rows) {
  const sorted = (rows || [])
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.map((row, index) => {
    const prev = index > 0 ? sorted[index - 1] : null;
    return {
      date: row.date,
      edge: row.edge,
      omega: row.omega,
      delta: {
        from: prev ? prev.date : null,
        edge: prev ? sideDelta(prev.edge, row.edge) : nullSideDelta(),
        omega: prev ? sideDelta(prev.omega, row.omega) : nullSideDelta(),
      },
    };
  });
}

function bareRow(row) {
  return { date: row.date, edge: row.edge, omega: row.omega };
}

function upsertRows(existing, row) {
  const prior = (existing || [])
    .filter((item) => item && item.date && item.date !== row.date)
    .map(bareRow);
  prior.push(bareRow(row));
  return applyDeltas(prior);
}

function scaleCopy() {
  return CLV_PERCENTILE_ANCHORS.map((item) => ({
    avgClvPp: item.avgClvPp,
    percentile: item.percentile,
  }));
}

function buildIndex(opts) {
  const src = opts || {};
  const row = src.row || buildDayRow(src);
  const rows = upsertRows(src.previousRows || [], row);
  return {
    schema: 'omega-tracking-v1',
    observerOnly: true,
    displayOnly: true,
    applied: false,
    asOf: row.date,
    generatedAt: src.generatedAt || null,
    updatedAtEt: src.updatedAtEt || null,
    dollarPerUnit: DOLLAR_PER_UNIT,
    clvPercentileScale: scaleCopy(),
    rows,
  };
}

function dayDocument(index, dateISO) {
  const saved = (index.rows || []).find((row) => row.date === dateISO);
  if (!saved) throw new Error(`tracking index missing ${dateISO}`);
  return {
    schema: 'omega-tracking-day-v1',
    observerOnly: true,
    displayOnly: true,
    applied: false,
    generatedAt: index.generatedAt,
    updatedAtEt: index.updatedAtEt,
    dollarPerUnit: index.dollarPerUnit,
    clvPercentileScale: index.clvPercentileScale,
    date: saved.date,
    edge: saved.edge,
    omega: saved.omega,
    delta: saved.delta,
  };
}

function isIndex(value) {
  return !!(value && value.schema === 'omega-tracking-v1' && Array.isArray(value.rows));
}

module.exports = {
  DOLLAR_PER_UNIT,
  RESULTS_CACHE_KEY,
  INDEX_KEY,
  LENSES,
  CLV_PERCENTILE_ANCHORS,
  dayKey,
  clvPercentile,
  carryEngineering,
  kpiFromAggregate,
  kpiSidesFromResults,
  kpiSidesFromDays,
  clvSidesFromReport,
  buildDayRow,
  applyDeltas,
  upsertRows,
  buildIndex,
  dayDocument,
  isIndex,
  sideDelta,
};
