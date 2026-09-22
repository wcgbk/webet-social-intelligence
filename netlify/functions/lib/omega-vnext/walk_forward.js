'use strict';

/**
 * Omega walk-forward SCAFFOLD. Observer only.
 *
 * Records lock→close samples under omega-walkforward/* after CLV_KPI_FLOOR.
 * Does not fit shrink, isotonic bands, or gates. Does not steer generate.
 * Actual coefficient fit is Monday 11:00 America/New_York on or after
 * 2026-09-29, and not from sparse day-1 closes.
 *
 * Alpha public blobs and public TSP records are offline priors only.
 * They are not an Omega empirical CLV percentile.
 */

const fs = require('fs');
const path = require('path');
const { CLV_KPI_FLOOR } = require('./config');
const { makePickId } = require('./clv_log');

const OBSERVER_ONLY = true;
const FIT_ENABLED = false;
const FIT_EARLIEST = '2026-09-29';
const KPI_FLOOR = CLV_KPI_FLOOR;

/** Strings that must not appear in calibrate.js or index.js. */
const FIT_PARAM_KEYS = [
  'omega-walkforward/fit',
  'self-optimize-params',
  'shrinkFit',
  'isotonicFit',
  'fittedShrinkK',
  'fittedIsotonic',
];

const WALKFORWARD_KEY_RE = /^omega-walkforward\/(?:samples\/\d{4}-\d{2}-\d{2}|reports\/(?:\d{4}-\d{2}-\d{2}|latest)|priors-offline)$/;

const LIVE_KEY_RE = /^(?:picks-\d{4}-\d{2}-\d{2}|picks-sim-|latest-date|picks-dates|self-optimize-params)/;

const PRIORS_FILE = path.join(__dirname, 'data', 'walkforward-offline-priors.json');

function assertWalkforwardKey(key) {
  const k = String(key || '');
  if (LIVE_KEY_RE.test(k) || k.includes('self-optimize-params') || k.startsWith('omega-walkforward/fit')) {
    throw new Error(`omega-walkforward refused live key: ${k}`);
  }
  if (!WALKFORWARD_KEY_RE.test(k)) {
    throw new Error(`omega-walkforward refused key: ${k}`);
  }
  return k;
}

function isOnOrAfterFloor(dateISO) {
  return typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) && dateISO >= KPI_FLOOR;
}

function etYmd(d = new Date()) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function addDaysYmd(ymd, delta) {
  const [y, m, day] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Explicit ?date= or [yesterday ET, today ET]. Does not write anything. */
function datesForRun(explicitDate, now = new Date()) {
  if (explicitDate) return [String(explicitDate)];
  const today = etYmd(now);
  return [addDaysYmd(today, -1), today];
}

function finiteNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseAmerican(v) {
  if (v == null || v === '' || v === 'N/A') return null;
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return Math.trunc(v);
  const s = String(v).trim().replace(/[−–]/g, '-').replace(/[^\d.+-]/g, '');
  if (!s || s === '+' || s === '-') return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/** Probability in [0, 1]. Percent strings and bare >1 numbers are scaled. */
function parseProb(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const pct = v.includes('%');
    const n = parseFloat(v.replace('%', ''));
    if (!Number.isFinite(n)) return null;
    if (pct || Math.abs(n) > 1) return n / 100;
    return n;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Math.abs(v) > 1) return v / 100;
    return v;
  }
  return null;
}

/** Percent points (3.2 means 3.2%). Fractions with abs <= 1 are scaled. */
function parseEdgePct(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const pct = v.includes('%');
    const n = parseFloat(v.replace('%', ''));
    if (!Number.isFinite(n)) return null;
    if (pct) return n;
    if (Math.abs(n) <= 1) return +(n * 100).toFixed(4);
    return n;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Math.abs(v) <= 1) return +(v * 100).toFixed(4);
    return v;
  }
  return null;
}

function parseUnits(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(String(v).replace(/u/ig, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeResult(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'win' || s === 'loss' || s === 'push' || s === 'void') return s;
  return null;
}

function clvKey(row) {
  const pick = (row && (row.pick || row.side)) || '';
  const matchup = (row && row.matchup) || '';
  return `${pick}||${matchup}`;
}

function indexClv(rows) {
  const byId = new Map();
  const byKey = new Map();
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.pickId) byId.set(r.pickId, r);
    const key = clvKey(r);
    if (key !== '||') byKey.set(key, r);
  }
  return { byId, byKey };
}

function lookupClv(pick, idx) {
  if (!pick || !idx) return null;
  if (pick.pickId && idx.byId.has(pick.pickId)) return idx.byId.get(pick.pickId);
  const key = clvKey(pick);
  if (key !== '||' && idx.byKey.has(key)) return idx.byKey.get(key);
  if (pick.closingOdds != null || pick.clvCents != null || pick.clv != null) return pick;
  return null;
}

/**
 * One graded sample. Close fields stay null until a CLV row exists.
 * `result` is omitted unless the row is win/loss/push/void (pending is dropped).
 */
function buildSampleFromPickClv(pick, clvRec) {
  const p = pick && typeof pick === 'object' ? pick : {};
  const c = clvRec && typeof clvRec === 'object' ? clvRec : {};
  const market = p.market || p.betType || c.market || c.betType || null;
  const side = p.side || p.pick || c.side || c.pick || null;
  const matchup = p.matchup || c.matchup || null;
  const sport = p.sport || c.sport || null;
  const date = p.date || c.date || null;

  const lockRaw = (p.lockSnapshot && p.lockSnapshot.odds != null)
    ? p.lockSnapshot.odds
    : (p.odds != null ? p.odds : c.pickTimeOdds);
  const lockOdds = parseAmerican(lockRaw);
  const closeOdds = parseAmerican(c.closingOdds != null ? c.closingOdds : c.closeOdds);

  let clvCents = null;
  if (typeof c.clvCents === 'number' && Number.isFinite(c.clvCents)) clvCents = c.clvCents;
  else if (typeof c.realizedClvCents === 'number' && Number.isFinite(c.realizedClvCents)) clvCents = c.realizedClvCents;
  else if (typeof c.clv === 'number' && Number.isFinite(c.clv)) clvCents = +(c.clv * 100).toFixed(2);

  let beatClosing = null;
  if (c.beatClosing === true || c.beatClose === true) beatClosing = true;
  else if (c.beatClosing === false || c.beatClose === false) beatClosing = false;
  else if (clvCents != null) beatClosing = clvCents > 0;

  const pickId = p.pickId || c.pickId || makePickId({
    date: date || '',
    sport: sport || '',
    matchup: matchup || '',
    side: side || '',
    market: market || '',
  });

  const sample = {
    date,
    pickId,
    sport,
    market,
    side,
    matchup,
    lockOdds,
    closeOdds,
    clvCents,
    beatClosing,
    coverProb: parseProb(p.coverProb != null ? p.coverProb : c.coverProb),
    p_model: finiteNum(p.p_model != null ? p.p_model : c.p_model),
    fair_sharp_p: finiteNum(p.fair_sharp_p != null ? p.fair_sharp_p : c.fair_sharp_p),
    edgePct: parseEdgePct(p.edgePct != null ? p.edgePct : c.edgePct),
    units: parseUnits(p.units != null ? p.units : c.units),
    modelVersion: p.modelVersion || c.modelVersion || null,
  };
  const result = normalizeResult(c.result != null ? c.result : p.result);
  if (result) sample.result = result;
  return sample;
}

function pushUnique(locks, seen, row) {
  if (!row || typeof row !== 'object') return;
  const id = row.pickId || null;
  const key = clvKey(row);
  if (id && seen.ids.has(id)) return;
  if (key !== '||' && seen.keys.has(key)) return;
  locks.push(row);
  if (id) seen.ids.add(id);
  if (key !== '||') seen.keys.add(key);
}

/**
 * Pair a card with its clv-{date} rows. Dates before KPI_FLOOR are skipped
 * and produce no samples (caller must not write them).
 */
function collectSamples(dateISO, picksBlob, clvBlob) {
  if (!isOnOrAfterFloor(dateISO)) {
    return { date: dateISO || null, skipped: true, reason: 'before-kpi-floor', samples: [] };
  }
  const cardPicks = picksBlob && Array.isArray(picksBlob.picks) ? picksBlob.picks : [];
  const cardParlays = picksBlob && Array.isArray(picksBlob.parlayLegs) ? picksBlob.parlayLegs : [];
  const clvRows = clvBlob && Array.isArray(clvBlob.picks) ? clvBlob.picks : [];
  const clvParlays = clvBlob && Array.isArray(clvBlob.parlayLegs) ? clvBlob.parlayLegs : [];
  const idx = indexClv(clvRows.concat(clvParlays));

  const locks = [];
  const seen = { ids: new Set(), keys: new Set() };
  for (const p of cardPicks) pushUnique(locks, seen, p);
  for (const pl of cardParlays) {
    for (const leg of (pl && pl.legs) || []) pushUnique(locks, seen, leg);
  }
  if (!locks.length) {
    for (const row of clvRows) pushUnique(locks, seen, row);
    for (const leg of clvParlays) pushUnique(locks, seen, leg);
  } else {
    for (const leg of clvParlays) pushUnique(locks, seen, leg);
  }

  const samples = locks.map((lock) => {
    const clv = lookupClv(lock, idx) || {};
    return buildSampleFromPickClv({ ...lock, date: lock.date || dateISO }, clv);
  });
  return { date: dateISO, skipped: false, reason: null, samples };
}

function buildDailyReport(dateISO, samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const bySportMarket = {};
  let graded = 0;
  for (const s of rows) {
    const sport = (s && s.sport) || 'unknown';
    const market = (s && s.market) || 'unknown';
    if (!bySportMarket[sport]) bySportMarket[sport] = {};
    if (!bySportMarket[sport][market]) {
      bySportMarket[sport][market] = { n: 0, graded: 0, clvSum: 0, beats: 0, meanClvCents: null, beatClosePct: null };
    }
    const b = bySportMarket[sport][market];
    b.n++;
    if (s && typeof s.clvCents === 'number' && Number.isFinite(s.clvCents)) {
      b.graded++;
      graded++;
      b.clvSum += s.clvCents;
      if (s.beatClosing === true) b.beats++;
    }
  }
  for (const markets of Object.values(bySportMarket)) {
    for (const b of Object.values(markets)) {
      b.meanClvCents = b.graded ? +((b.clvSum / b.graded).toFixed(2)) : null;
      b.beatClosePct = b.graded ? +((b.beats / b.graded) * 100).toFixed(1) : null;
      delete b.clvSum;
      delete b.beats;
    }
  }
  return {
    observerOnly: true,
    fitEnabled: false,
    fitApplied: false,
    date: dateISO,
    n: rows.length,
    graded,
    bySportMarket,
    notes: [
      'scaffold only — no coefficient fit',
      'Alpha and public TSP blobs are offline priors only — not an Omega empirical CLV percentile.',
      `Coefficient fit is Monday 11:00 ET on or after ${FIT_EARLIEST}. Not from day-1 closes.`,
    ],
    kpiFloor: KPI_FLOOR,
    fitEarliest: FIT_EARLIEST,
  };
}

function buildSamplesBlob(dateISO, samples, opts = {}) {
  const rows = Array.isArray(samples) ? samples : [];
  return {
    observerOnly: true,
    fitEnabled: false,
    fitApplied: false,
    scaffold: 'omega-walkforward-observer',
    date: dateISO,
    kpiFloor: KPI_FLOOR,
    fitEarliest: FIT_EARLIEST,
    sourceModel: opts.sourceModel || null,
    n: rows.length,
    samples: rows,
    notes: ['scaffold only — no coefficient fit'],
  };
}

function planCapture(dateISO, picksBlob, clvBlob) {
  const collected = collectSamples(dateISO, picksBlob, clvBlob);
  if (collected.skipped) {
    return {
      date: dateISO || null,
      write: false,
      skipped: true,
      reason: collected.reason,
      samples: [],
      report: null,
      samplesBlob: null,
    };
  }
  const sourceModel = picksBlob && (picksBlob.model || null);
  return {
    date: dateISO,
    write: true,
    skipped: false,
    reason: null,
    samples: collected.samples,
    report: buildDailyReport(dateISO, collected.samples),
    samplesBlob: buildSamplesBlob(dateISO, collected.samples, { sourceModel }),
  };
}

/**
 * Static documentation of Alpha / public TSP blobs.
 * Coefficients are always stripped. Never feed this into calibrate.
 */
function sanitizePriors(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  return {
    role: 'OFFLINE PRIORS ONLY',
    appliedToCalibrate: false,
    coefficients: null,
    fitEnabled: false,
    doNotApply: true,
    sources: Array.isArray(src.sources) ? src.sources : [],
    honesty: Array.isArray(src.honesty) ? src.honesty : [],
    loadError: src.loadError || null,
  };
}

function loadOfflinePriors() {
  try {
    const raw = JSON.parse(fs.readFileSync(PRIORS_FILE, 'utf8'));
    return sanitizePriors(raw);
  } catch (e) {
    return sanitizePriors({ loadError: e.message, sources: [], honesty: [] });
  }
}

/**
 * Fail if generator sources load this module or read fit / self-opt params.
 * Pass the file text of calibrate.js and index.js (tests do).
 */
function assertGeneratorDoesNotReadFit(calibrateSrc, indexSrc) {
  const checks = [
    ['calibrate.js', calibrateSrc],
    ['index.js', indexSrc],
  ];
  const problems = [];
  for (const [name, src] of checks) {
    const text = String(src == null ? '' : src);
    if (/walk_forward/.test(text)) problems.push(`${name} references walk_forward`);
    if (/\bgetFitParams\s*\(/.test(text)) problems.push(`${name} calls getFitParams`);
    for (const key of FIT_PARAM_KEYS) {
      if (text.includes(key)) problems.push(`${name} contains fit param key ${key}`);
    }
  }
  if (problems.length) {
    throw new Error(`generator must not read walk-forward fit: ${problems.join('; ')}`);
  }
  return true;
}

/**
 * Live steer params. Always null while this scaffold is observer-only.
 * No branch returns a shrink map, isotonic table, or gate override.
 */
function getFitParams() {
  if (FIT_ENABLED !== true || OBSERVER_ONLY === true) return null;
  const today = etYmd();
  if (!today || today < FIT_EARLIEST) return null;
  return null;
}

module.exports = {
  OBSERVER_ONLY,
  FIT_ENABLED,
  FIT_EARLIEST,
  KPI_FLOOR,
  FIT_PARAM_KEYS,
  WALKFORWARD_KEY_RE,
  LIVE_KEY_RE,
  assertWalkforwardKey,
  isOnOrAfterFloor,
  etYmd,
  addDaysYmd,
  datesForRun,
  buildSampleFromPickClv,
  collectSamples,
  buildDailyReport,
  buildSamplesBlob,
  planCapture,
  sanitizePriors,
  loadOfflinePriors,
  assertGeneratorDoesNotReadFit,
  getFitParams,
};
