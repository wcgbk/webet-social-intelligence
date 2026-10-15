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

/**
 * Whole-number display rule: positives round up, negatives round away
 * from zero, zero stays zero. Null stays null.
 */
function wholeAway(n) {
  if (n == null || n === '') return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (Math.abs(x) < 1e-9) return 0;
  return x > 0 ? Math.ceil(x - 1e-9) : Math.floor(x + 1e-9);
}

/** Edge = Alpha through 9/21 plus Omega from 9/22. Omega = Omega from 9/22. */
const ALPHA_EDGE_TO = '2026-09-21';
const OMEGA_LIVE_FROM = '2026-09-22';

/**
 * First live card per code version, when it is known and the stored rows
 * cannot show it (the first row with a version field). Display only.
 */
const VERSION_FIRST_CARD = Object.freeze({
  'v12.4.0-webetai-pure': '2026-10-14',
});

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

function carryEngineering(entries, asOf, side, versionSince) {
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
      stale: true,
    };
  }
  return {
    processes: current.processes,
    architecture: current.architecture,
    math: current.math,
    overall: current.overall,
    scoredOn,
    carriedForward: scoredOn !== asOf,
    // Stale: last scored before the live code version's first card.
    stale: versionSince ? String(scoredOn) < String(versionSince) : false,
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
  // Whole dollars, rounded up (tracking rule; matches stakeDollars ceil).
  const profitDollars = Math.ceil((Number(cum.totalProfit) || 0) - 1e-9);
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

function bucketRows(rows) {
  const list = rows || [];
  const n = list.length;
  if (!n) return { n: 0, avgClvPp: null, beatClosePct: null, percentile: null, smallSample: true };
  let sum = 0;
  let beats = 0;
  for (const row of list) {
    sum += Number(row.clvPp);
    if (row.beatClose === true || (row.beatClose == null && Number(row.clvPp) > 0)) beats += 1;
  }
  const avg = round2(sum / n);
  return {
    n,
    avgClvPp: avg,
    beatClosePct: round1((beats / n) * 100),
    percentile: clvPercentile(avg),
    smallSample: n < 50,
  };
}

function isParlayRow(row) {
  const m = String((row && (row.market || row.sport)) || '').toLowerCase();
  if (m === 'parlay') return true;
  const { isParlayGradeName } = require('./omega-vnext/result_kpis');
  return isParlayGradeName(row && (row.pick || row.selection));
}

/**
 * Closing-line totals on PUBLISHED picks only (ledger kind 'pick'), the
 * same no-vig Pinnacle close the ledger grades (clvPp, percentage points).
 * Straights are the headline. Parlay rows are kept apart; the ledger has
 * none today, so parlay is { available: false }.
 *   edge     Alpha picks through 9/21 + Omega picks from 9/22
 *   omega    Omega picks from 9/22
 *   current  Omega picks on or after the live version's first card
 */
function clvPublishedFromRows(rows, opts) {
  const src = opts || {};
  const asOf = src.asOf || '9999-12-31';
  const since = src.versionSince || null;
  const picks = (rows || []).filter((row) => row && row.kind === 'pick'
    && Number.isFinite(Number(row.clvPp)) && row.date && String(row.date) <= asOf);
  const straights = picks.filter((row) => !isParlayRow(row));
  const parlays = picks.filter(isParlayRow);
  const isEdge = (row) => (row.source === 'alpha' && row.date <= ALPHA_EDGE_TO)
    || (row.source === 'omega' && row.date >= OMEGA_LIVE_FROM);
  const isOmega = (row) => row.source === 'omega' && row.date >= OMEGA_LIVE_FROM;
  const isCurrent = (row) => isOmega(row) && since && row.date >= since;
  const parlayBlock = (list) => (list.length ? { available: true, ...bucketRows(list) } : { available: false, n: 0 });
  return {
    edge: { basis: 'published-straights', ...bucketRows(straights.filter(isEdge)), parlay: parlayBlock(parlays.filter(isEdge)) },
    omega: { basis: 'published-straights', ...bucketRows(straights.filter(isOmega)), parlay: parlayBlock(parlays.filter(isOmega)) },
    current: { basis: 'published-straights', ...bucketRows(straights.filter(isCurrent)), parlay: parlayBlock(parlays.filter(isCurrent)) },
  };
}

/**
 * Live version and the first card date for it. A row whose previous row
 * carried the same version keeps that row's since date. Otherwise the
 * known first-card table, then the row date.
 */
function resolveVersion(previousRows, date, live) {
  const name = live ? String(live) : null;
  const prior = (previousRows || [])
    .filter((row) => row && row.date && row.date < date)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;
  const prevName = prior && prior.version ? prior.version.live : null;
  let since = null;
  if (name && prevName === name && prior.version.since) since = prior.version.since;
  if (!since && name && VERSION_FIRST_CARD[name]) since = VERSION_FIRST_CARD[name];
  if (!since && name) since = date;
  return {
    live: name,
    since,
    previous: prevName,
    changed: !!(name && prevName && prevName !== name),
  };
}

/**
 * Running KPIs since the version's first card, from results day rows.
 * Cards dated before the report date only: the 9:15 ET run sees the day's
 * own card unsettled, so it is never counted early or late.
 */
function currentKpi(days, since, asOf, aggregateDays) {
  if (!since || typeof aggregateDays !== 'function' || !Array.isArray(days)) return null;
  const list = days.filter((day) => day && day.date >= since && day.date < asOf
    && (day.source == null || day.source === 'omega'));
  return kpiFromAggregate(aggregateDays(list));
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
  const version = src.version && src.version.since !== undefined
    ? src.version
    : resolveVersion(src.previousRows || [], date, src.liveVersion || (src.version && src.version.live));
  const edgeEng = carryEngineering(entries, date, 'edge', version.since);
  const omegaEng = carryEngineering(entries, date, 'omega', version.since);
  if (edgeEng.processes == null || omegaEng.processes == null) {
    throw new Error(`no engineering score on or before ${date}`);
  }
  const kpi = src.kpi || kpiSidesFromResults(src.results);
  // Secondary: every evaluated bet (ledger totals). Headline: published picks.
  const clvAll = src.clvAll || (src.clvReport ? clvSidesFromReport(src.clvReport) : (src.clv || null));
  const published = src.clvPublished
    || (Array.isArray(src.clvRows)
      ? clvPublishedFromRows(src.clvRows, { asOf: date, versionSince: version.since })
      : null);
  const clv = published || src.clv || clvAll;
  const curKpi = src.currentKpi
    || currentKpi(src.days || (src.results && src.results.days), version.since, date, src.aggregateDays);
  return {
    date,
    version,
    edge: { engineering: edgeEng, kpi: kpi.edge, clv: clv.edge, clvAll: clvAll ? clvAll.edge : null },
    omega: { engineering: omegaEng, kpi: kpi.omega, clv: clv.omega, clvAll: clvAll ? clvAll.omega : null },
    current: {
      version: version.live,
      since: version.since,
      kpi: curKpi,
      clv: published ? published.current : null,
    },
  };
}

function applyDeltas(rows) {
  const sorted = (rows || [])
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.map((row, index) => {
    const prev = index > 0 ? sorted[index - 1] : null;
    const sameVersion = !!(prev && prev.version && row.version
      && prev.version.live && prev.version.live === row.version.live);
    const out = {
      date: row.date,
      edge: row.edge,
      omega: row.omega,
      delta: {
        from: prev ? prev.date : null,
        edge: prev ? sideDelta(prev.edge, row.edge) : nullSideDelta(),
        omega: prev ? sideDelta(prev.omega, row.omega) : nullSideDelta(),
        current: sameVersion && prev.current && row.current
          ? sideDelta(prev.current, row.current)
          : nullSideDelta(),
      },
    };
    if (row.version) out.version = row.version;
    if (row.current) out.current = row.current;
    return out;
  });
}

function bareRow(row) {
  const out = { date: row.date, edge: row.edge, omega: row.omega };
  if (row.version) out.version = row.version;
  if (row.current) out.current = row.current;
  return out;
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
  const row = src.row || buildDayRow({ ...src, previousRows: src.previousRows || [] });
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
    version: saved.version || null,
    current: saved.current || null,
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
  wholeAway,
  clvPublishedFromRows,
  resolveVersion,
  currentKpi,
  VERSION_FIRST_CARD,
  ALPHA_EDGE_TO,
  OMEGA_LIVE_FROM,
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
