'use strict';

/**
 * Per-sport recalibration report. Observe only.
 *
 * CLV grades the model against the no-vig close. It does not select picks,
 * set stakes, or change a live price, probability, floor, or shrink.
 * Nothing in this module reads or writes config, the card, or a blob.
 *
 * CLV probability = close no-vig of our side − vigged implied probability
 * of the entry price. Positive means the close moved toward our side.
 * Shrink K is fit and reported. It is not applied.
 *   p = (1 − K) * p_model + K * p_close_or_sharp, K in [0, 1].
 */

const SPORTS = Object.freeze(['NFL', 'NCAAF', 'NHL', 'MLB']);
const MARKETS = Object.freeze(['Spread', 'Total', 'Moneyline']);
const WINDOWS = Object.freeze([7, 14, 28]);
const CAL_BINS = 10;
const K_STEP = 0.01;
const K_MIN = 0;
const K_MAX = 1;
/** 14-day mean CLV flag. Matches the sample where CLV can show an edge. */
const MIN_CLV_N = 50;
/** 14-day mean KL must exceed the 28-day mean by more than this fraction. */
const KL_RISE = 0.25;
/** One recommended K change needs this many graded rows on the 28-day cell. */
const MIN_RECOMMEND_N = 50;
const MIN_GAIN = 1e-6;

const SCHEMA = 'omega-recal-report-v1';
const LATEST_KEY = 'omega-recal-report/latest';
const NOTE = 'Observe-only recalibration report. CLV grades the model. It does not select picks or set stakes, and it does not change a live price, probability, floor, or selection. The fitted shrink K is reported and not applied.';

const MODEL_LOCK_FIELDS = new Set([
  'p_model', 'modelRawP', 'coverProb', 'calibratedProb', 'fair_sharp_p', 'odds', 'entryOdds',
]);

function reportKey(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`omega-recal-report refused bad date: ${dateISO}`);
  }
  return `omega-recal-report/${d}`;
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function prob(value) {
  const n = finite(value);
  if (n == null || n <= 0 || n >= 1) return null;
  return n;
}

/** Vigged implied probability of an American price. Not de-vigged. */
function americanToImplied(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
}

function clipProb(p) {
  if (!Number.isFinite(p)) return null;
  if (p <= 0) return 1e-15;
  if (p >= 1) return 1 - 1e-15;
  return p;
}

function logLoss(p, y) {
  const pc = clipProb(p);
  if (pc == null || (y !== 0 && y !== 1)) return null;
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}

function brier(p, y) {
  if (!Number.isFinite(p) || (y !== 0 && y !== 1)) return null;
  return (p - y) * (p - y);
}

/** KL(model || close) for two Bernoulli forecasts. Natural log, same as log-loss. */
function klBernoulli(modelP, closeP) {
  const p = clipProb(modelP);
  const q = clipProb(closeP);
  if (p == null || q == null) return null;
  return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q));
}

function clvProb(closeNoVig, entryImplied) {
  if (!Number.isFinite(closeNoVig) || !Number.isFinite(entryImplied)) return null;
  return closeNoVig - entryImplied;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function datesEnding(asOf, n) {
  const out = [];
  const count = Number(n) || 0;
  for (let back = count - 1; back >= 0; back -= 1) out.push(shiftYmd(asOf, -back));
  return out;
}

function canonicalDate(value) {
  const s = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function canonicalSport(value) {
  const s = String(value || '').trim().toUpperCase();
  if (s === 'NFL') return 'NFL';
  if (s === 'NHL') return 'NHL';
  if (s === 'MLB') return 'MLB';
  if (s === 'NCAAF' || s === 'CFB' || s === 'COLLEGE FOOTBALL' || s === 'COLLEGE') return 'NCAAF';
  return null;
}

function canonicalMarket(value) {
  const m = String(value || '');
  if (/total/i.test(m)) return 'Total';
  if (/spread|run\s*line|puck/i.test(m)) return 'Spread';
  if (/money\s*line|^ml$|\bh2h\b/i.test(m)) return 'Moneyline';
  return null;
}

function lineToken(line) {
  if (line == null || line === '') return '';
  const n = Number(line);
  return Number.isFinite(n) ? String(n) : String(line);
}

function sideToken(side) {
  return String(side || '')
    .trim()
    .toLowerCase()
    .replace(/\s+ml$/i, '')
    .replace(/\s+/g, ' ');
}

function joinKey(row) {
  const sport = canonicalSport(row && row.sport) || String((row && row.sport) || '').trim().toLowerCase();
  const market = canonicalMarket(row && (row.market || row.betType))
    || String((row && (row.market || row.betType)) || '').trim().toLowerCase();
  return [
    sport,
    String((row && row.matchup) || '').trim().toLowerCase(),
    market,
    sideToken(row && (row.side || row.pick)),
    lineToken(row && row.line),
  ].join('|');
}

function softKey(row) {
  const sport = canonicalSport(row && row.sport) || String((row && row.sport) || '').trim().toLowerCase();
  return [
    sport,
    String((row && row.matchup) || '').trim().toLowerCase(),
    sideToken(row && (row.side || row.pick)),
  ].join('|');
}

function decisiveResult(value) {
  if (value == null || value === '') return null;
  if (value === 1 || value === '1') return 'win';
  if (value === 0 || value === '0') return 'loss';
  const s = String(value).trim().toLowerCase();
  if (s === 'win' || s === 'w') return 'win';
  if (s === 'loss' || s === 'l') return 'loss';
  return null;
}

function outcomeBit(value) {
  const d = decisiveResult(value);
  if (d === 'win') return 1;
  if (d === 'loss') return 0;
  return null;
}

function inRollingWindow(date, asOf, days) {
  const d = canonicalDate(date);
  const end = canonicalDate(asOf);
  if (!d || !end) return false;
  const start = shiftYmd(end, -(Number(days) - 1));
  return d >= start && d <= end;
}

function mean(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n ? sum / n : null;
}

function emptyCalibration() {
  const bins = [];
  for (let i = 0; i < CAL_BINS; i += 1) {
    bins.push({
      bin: i,
      lo: i / CAL_BINS,
      hi: (i + 1) / CAL_BINS,
      n: 0,
      meanModel: null,
      outcomeRate: null,
      meanClose: null,
    });
  }
  return bins;
}

function calibrationCurve(rows) {
  const acc = [];
  for (let i = 0; i < CAL_BINS; i += 1) {
    acc.push({ n: 0, sumModel: 0, sumY: 0, sumClose: 0 });
  }
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.pScore)) continue;
    let idx = Math.floor(row.pScore * CAL_BINS);
    if (idx < 0) idx = 0;
    if (idx > CAL_BINS - 1) idx = CAL_BINS - 1;
    const bin = acc[idx];
    bin.n += 1;
    bin.sumModel += row.pScore;
    bin.sumY += row.y;
    bin.sumClose += row.pClose;
  }
  return acc.map((bin, i) => ({
    bin: i,
    lo: i / CAL_BINS,
    hi: (i + 1) / CAL_BINS,
    n: bin.n,
    meanModel: bin.n ? bin.sumModel / bin.n : null,
    outcomeRate: bin.n ? bin.sumY / bin.n : null,
    meanClose: bin.n ? bin.sumClose / bin.n : null,
  }));
}

/**
 * Grid search on K in [0, 1], step 0.01.
 * Ties keep the smaller K. The returned K is not applied anywhere.
 */
function fitShrinkK(rows) {
  const usable = [];
  for (const row of rows || []) {
    const pRaw = prob(row && (row.pRaw != null ? row.pRaw : row.p_model));
    const pAnchor = prob(row && (row.pAnchor != null ? row.pAnchor : (row.pClose != null ? row.pClose : row.pSharp)));
    const y = row && (row.y === 0 || row.y === 1) ? row.y : outcomeBit(row && row.result);
    if (pRaw == null || pAnchor == null || (y !== 0 && y !== 1)) continue;
    usable.push({ pRaw, pAnchor, y });
  }
  if (!usable.length) {
    return { k: null, n: 0, logLoss: null, applied: false, bounded: [K_MIN, K_MAX] };
  }
  let bestK = 0;
  let bestLoss = Infinity;
  const steps = Math.round((K_MAX - K_MIN) / K_STEP);
  for (let i = 0; i <= steps; i += 1) {
    const k = Math.round((K_MIN + i * K_STEP) * 100) / 100;
    let sum = 0;
    for (const row of usable) {
      const p = (1 - k) * row.pRaw + k * row.pAnchor;
      sum += logLoss(p, row.y);
    }
    const avg = sum / usable.length;
    if (avg < bestLoss - 1e-12) {
      bestLoss = avg;
      bestK = k;
    }
  }
  return {
    k: bestK,
    n: usable.length,
    logLoss: bestLoss,
    applied: false,
    bounded: [K_MIN, K_MAX],
    step: K_STEP,
    formula: 'p=(1-K)*p_model+K*p_close_or_sharp',
  };
}

function blendAt(row, k) {
  return (1 - k) * row.pRaw + k * row.pAnchor;
}

function emptyMetrics() {
  return {
    n: 0,
    meanClv: null,
    pctBeatingClose: null,
    meanEdge: null,
    meanRealizedClv: null,
    drift: null,
    logLossModel: null,
    brierModel: null,
    logLossClose: null,
    brierClose: null,
    meanKl: null,
    calibration: emptyCalibration(),
  };
}

function summarize(rows) {
  const list = rows || [];
  if (!list.length) return emptyMetrics();
  const meanClv = mean(list.map((r) => r.clv));
  const meanEdge = mean(list.map((r) => r.edge));
  const beats = list.filter((r) => r.clv > 0).length;
  return {
    n: list.length,
    meanClv,
    pctBeatingClose: (100 * beats) / list.length,
    meanEdge,
    meanRealizedClv: meanClv,
    drift: meanEdge == null || meanClv == null ? null : meanEdge - meanClv,
    logLossModel: mean(list.map((r) => logLoss(r.pScore, r.y))),
    brierModel: mean(list.map((r) => brier(r.pScore, r.y))),
    logLossClose: mean(list.map((r) => logLoss(r.pClose, r.y))),
    brierClose: mean(list.map((r) => brier(r.pClose, r.y))),
    meanKl: mean(list.map((r) => klBernoulli(r.pScore, r.pClose))),
    calibration: calibrationCurve(list),
  };
}

function summarizeMarket(rows) {
  const metrics = summarize(rows);
  metrics.shrinkK = fitShrinkK(rows);
  return metrics;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const sport = canonicalSport(row.sport);
  const market = canonicalMarket(row.market || row.betType);
  const date = canonicalDate(row.date || row.cardDate);
  if (!sport || !market || !date) return null;

  const pRawIn = prob(row.pRaw != null ? row.pRaw : (row.p_model != null ? row.p_model : row.modelRawP));
  const pCal = prob(row.pCalibrated != null ? row.pCalibrated : (row.coverProb != null ? row.coverProb : row.calibratedProb));
  const pScore = prob(row.pScore != null ? row.pScore : (pCal != null ? pCal : pRawIn));
  const pRaw = pRawIn != null ? pRawIn : pScore;
  const pSharp = prob(row.pSharp != null
    ? row.pSharp
    : (row.fair_sharp_p_at_generate != null ? row.fair_sharp_p_at_generate : (row.fair_sharp_p != null ? row.fair_sharp_p : row.sharpFairP)));
  const pClose = prob(row.pClose != null ? row.pClose : (row.closeNoVig != null ? row.closeNoVig : row.closeProb));
  const entry = prob(row.entryImplied != null ? row.entryImplied : americanToImplied(row.odds != null ? row.odds : row.entryOdds));
  const y = row.y === 0 || row.y === 1 ? row.y : outcomeBit(row.result != null ? row.result : row.outcome);
  if (pScore == null || pRaw == null || pClose == null || pSharp == null || entry == null) return null;
  if (y !== 0 && y !== 1) return null;
  return {
    date,
    sport,
    market,
    pRaw,
    pScore,
    pSharp,
    pClose,
    pAnchor: pClose,
    entryImplied: entry,
    clv: pClose - entry,
    edge: pScore - pSharp,
    y,
  };
}

function asBlobs(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function rowsOf(blob, dateFallback) {
  if (!blob) return [];
  if (Array.isArray(blob)) {
    return blob.map((row) => ({ ...row, date: canonicalDate(row && row.date) || dateFallback || null }));
  }
  const date = canonicalDate(blob.date) || dateFallback || null;
  const rows = [];
  const lists = [blob.candidates, blob.rows];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row) continue;
      rows.push({ ...row, date: canonicalDate(row.date) || date });
    }
  }
  return rows;
}

function resultRowsOf(blob, dateFallback) {
  const rows = rowsOf(blob, dateFallback);
  if (blob && !Array.isArray(blob)) {
    const date = canonicalDate(blob.date) || dateFallback || null;
    for (const pick of blob.picks || []) {
      if (!pick) continue;
      rows.push({ ...pick, date: canonicalDate(pick.date) || date });
    }
    for (const ticket of blob.parlayLegs || []) {
      const legs = ticket && Array.isArray(ticket.legs) ? ticket.legs : [];
      for (const leg of legs) {
        if (!leg) continue;
        rows.push({ ...leg, date: canonicalDate(leg.date) || date });
      }
    }
  }
  return rows;
}

function mergeRow(prev, next) {
  const out = { ...prev };
  for (const [key, value] of Object.entries(next || {})) {
    if (value == null || value === '') continue;
    if (MODEL_LOCK_FIELDS.has(key) && prev[key] != null) continue;
    out[key] = value;
  }
  if (next && next.closeNoVig != null) out.closeNoVig = next.closeNoVig;
  if (next && next.closeProb != null) out.closeProb = next.closeProb;
  if (next && next.fair_sharp_p_at_generate != null) out.fair_sharp_p_at_generate = next.fair_sharp_p_at_generate;
  return out;
}

function findUniqueSoft(map, date, row) {
  const want = softKey(row);
  let hit = null;
  for (const [key, value] of map) {
    if (!key.startsWith(`${date}|`)) continue;
    if (softKey(value) !== want) continue;
    if (hit) return null;
    hit = value;
  }
  return hit;
}

/**
 * Ledger rows left-joined to closes and graded outcomes.
 * A close-only row is kept: the close blob is the ledger plus the close.
 * Does not mutate the inputs.
 */
function joinCandidates(input) {
  const src = input || {};
  const map = new Map();
  const order = [];
  const put = (row) => {
    if (!row) return;
    const date = canonicalDate(row.date);
    if (!date) return;
    const key = `${date}|${joinKey(row)}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, { ...row, date });
      return;
    }
    map.set(key, mergeRow(map.get(key), row));
  };
  for (const blob of asBlobs(src.ledgers)) {
    const fallback = canonicalDate(blob && blob.date);
    for (const row of rowsOf(blob, fallback)) put(row);
  }
  for (const blob of asBlobs(src.closes)) {
    const fallback = canonicalDate(blob && blob.date);
    for (const row of rowsOf(blob, fallback)) put(row);
  }
  for (const blob of asBlobs(src.results)) {
    const fallback = canonicalDate(blob && blob.date);
    for (const row of resultRowsOf(blob, fallback)) {
      const date = canonicalDate(row.date) || fallback;
      const result = decisiveResult(row.result != null ? row.result : row.outcome);
      if (!date || !result) continue;
      const exact = map.get(`${date}|${joinKey(row)}`);
      const prev = exact || findUniqueSoft(map, date, row);
      if (!prev) continue;
      prev.result = result;
    }
  }
  return order.map((key) => map.get(key));
}

function round6(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1e6) / 1e6;
}

function fmt(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return round6(value).toFixed(6);
}

function collectDriftFlags(sports) {
  const flags = [];
  for (const sport of SPORTS) {
    const w14 = sports[sport] && sports[sport].windows[14];
    const w28 = sports[sport] && sports[sport].windows[28];
    if (w14 && w14.n >= MIN_CLV_N && Number.isFinite(w14.meanClv) && w14.meanClv < 0) {
      flags.push({
        sport,
        code: 'negative-clv',
        windowDays: 14,
        n: w14.n,
        meanClv: w14.meanClv,
        text: `${sport} 14-day mean CLV is ${fmt(w14.meanClv)} with n=${w14.n}. Revisit that sport's parameters one at a time. Do not veto individual picks.`,
      });
    }
    const kl14 = w14 && w14.meanKl;
    const kl28 = w28 && w28.meanKl;
    if (Number.isFinite(kl14) && Number.isFinite(kl28) && kl28 > 0 && kl14 > kl28 * (1 + KL_RISE)) {
      const rise = kl14 / kl28 - 1;
      flags.push({
        sport,
        code: 'kl-rise',
        windowDays: 14,
        vsWindowDays: 28,
        n14: w14.n,
        n28: w28.n,
        meanKl14: kl14,
        meanKl28: kl28,
        rise,
        text: `${sport} 14-day mean KL ${fmt(kl14)} is ${(rise * 100).toFixed(1)}% above the 28-day mean KL ${fmt(kl28)}. One parameter at a time. Do not veto individual picks.`,
      });
    }
  }
  return flags;
}

function logLossOfBlend(rows, k) {
  if (!rows.length || !Number.isFinite(k)) return null;
  let sum = 0;
  for (const row of rows) sum += logLoss(blendAt(row, k), row.y);
  return sum / rows.length;
}

/**
 * One change: the sport/market cell on the 28-day window whose fitted K
 * cuts log-loss the most versus the model probability already on the row.
 * Sample under MIN_RECOMMEND_N does not qualify. Nothing is applied.
 */
function recommendOne(prepared, asOf) {
  let best = null;
  for (const sport of SPORTS) {
    for (const market of MARKETS) {
      const rows = prepared.filter((row) => row.sport === sport && row.market === market && inRollingWindow(row.date, asOf, 28));
      if (rows.length < MIN_RECOMMEND_N) continue;
      const fit = fitShrinkK(rows);
      if (!Number.isFinite(fit.k)) continue;
      const logLossModel = mean(rows.map((row) => logLoss(row.pScore, row.y)));
      const logLossFit = logLossOfBlend(rows, fit.k);
      if (!Number.isFinite(logLossModel) || !Number.isFinite(logLossFit)) continue;
      const gain = logLossModel - logLossFit;
      if (!(gain > MIN_GAIN)) continue;
      const candidate = {
        sport,
        market,
        windowDays: 28,
        k: fit.k,
        n: rows.length,
        gain,
        logLossModel,
        logLossFit,
      };
      if (!best || candidate.gain > best.gain + 1e-12
        || (Math.abs(candidate.gain - best.gain) <= 1e-12 && candidate.n > best.n)) {
        best = candidate;
      }
    }
  }
  if (!best) {
    return {
      change: false,
      parameter: null,
      text: `No parameter change. No sport/market cell on the 28-day window has n>=${MIN_RECOMMEND_N} and a positive log-loss gain from the fitted shrink. Hold the current hand-set shrink. Not applied.`,
      sport: null,
      market: null,
      windowDays: 28,
      k: null,
      n: 0,
      gain: null,
      applied: false,
    };
  }
  const text = `Recommend one change: ${best.sport} ${best.market} shrink K to ${best.k.toFixed(2)} on the 28-day window (n=${best.n}). Expected log-loss ${fmt(best.logLossModel)} to ${fmt(best.logLossFit)} (gain ${fmt(best.gain)}). Not applied. Does not change a live price, probability, floor, stake, or selection.`;
  return {
    change: true,
    parameter: 'shrinkK',
    text,
    sport: best.sport,
    market: best.market,
    windowDays: 28,
    k: best.k,
    n: best.n,
    gain: best.gain,
    logLossModel: best.logLossModel,
    logLossFit: best.logLossFit,
    applied: false,
  };
}

function rowWindMph(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.windMph != null && row.windMph !== '') return finite(row.windMph);
  const weather = row.weather && typeof row.weather === 'object' ? row.weather : null;
  if (weather && weather.windMph != null && weather.windMph !== '') return finite(weather.windMph);
  const fb = row.fbWeather && typeof row.fbWeather === 'object' ? row.fbWeather : null;
  if (fb && fb.windMph != null && fb.windMph !== '') return finite(fb.windMph);
  return null;
}

function windBandName(mph) {
  if (mph == null) return null;
  if (mph < 15) return 'under-15';
  if (mph < 25) return '15-to-25';
  return '25-plus';
}

function rowIsPush(row) {
  if (!row) return false;
  if (row.push === true) return true;
  const text = String(row.result != null ? row.result : row.outcome || '').toLowerCase();
  return text === 'push';
}

function keyMargin(value) {
  const n = finite(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  if (Math.abs(abs - 3) < 1e-9) return 3;
  if (Math.abs(abs - 7) < 1e-9) return 7;
  return null;
}

function clvOfRaw(row) {
  const direct = finite(row && row.clv);
  if (direct != null) return Math.abs(direct) <= 1.5 ? direct : direct / 100;
  const pp = finite(row && row.clvPp);
  if (pp != null) return pp / 100;
  const close = finite(row && (row.pClose != null ? row.pClose : row.closeNoVig));
  const entry = finite(row && row.entryImplied);
  const implied = entry != null ? entry : americanToImplied(row && (row.odds != null ? row.odds : row.entryOdds));
  if (close == null || implied == null) return null;
  return close - implied;
}

/**
 * NFL report splits. Totals with a stored wind are grouped into bands.
 * Spread pushes on a 3 or a 7 are counted separately. This does not
 * change a price, a probability, or a stake.
 */
function nflCalibrationSplits(rows) {
  const bands = { 'under-15': [], '15-to-25': [], '25-plus': [] };
  let spreadPushes = 0;
  let margin3 = 0;
  let margin7 = 0;
  for (const row of rows || []) {
    if (!row || canonicalSport(row.sport) !== 'NFL') continue;
    const market = canonicalMarket(row.market || row.betType);
    if (market === 'Total') {
      const band = windBandName(rowWindMph(row));
      if (band) bands[band].push(row);
    }
    if (market === 'Spread' && rowIsPush(row)) {
      spreadPushes += 1;
      const line = finite(row.line != null ? row.line : (row.marketLine != null ? row.marketLine : row.point));
      const margin = finite(row.margin != null ? row.margin : row.finalMargin);
      const key = keyMargin(line) || keyMargin(margin);
      if (key === 3) margin3 += 1;
      else if (key === 7) margin7 += 1;
    }
  }
  function pack(group) {
    const vals = [];
    for (const row of group) {
      const clv = clvOfRaw(row);
      if (clv != null) vals.push(clv);
    }
    const beats = vals.filter((n) => n > 0).length;
    return {
      n: group.length,
      nClv: vals.length,
      meanClv: mean(vals),
      pctBeatingClose: vals.length ? (100 * beats) / vals.length : null,
    };
  }
  return {
    displayOnly: true,
    applied: false,
    totalsByWind: {
      'under-15': pack(bands['under-15']),
      '15-to-25': pack(bands['15-to-25']),
      '25-plus': pack(bands['25-plus']),
    },
    keyNumberPushes: { spreadPushes, margin3, margin7 },
  };
}

function buildRecalReport(input) {
  const src = input || {};
  const asOf = canonicalDate(src.asOf);
  if (!asOf) throw new Error('recal report needs an asOf date YYYY-MM-DD');
  const generatedAt = src.generatedAt || new Date().toISOString();
  const joined = Array.isArray(src.rows) ? src.rows : joinCandidates(src);
  const prepared = [];
  for (const row of joined) {
    const norm = normalizeRow(row);
    if (norm) prepared.push(norm);
  }
  const sports = {};
  for (const sport of SPORTS) {
    const sportRows = prepared.filter((row) => row.sport === sport);
    const windows = {};
    for (const days of WINDOWS) {
      const inWindow = sportRows.filter((row) => inRollingWindow(row.date, asOf, days));
      const metrics = summarize(inWindow);
      const markets = {};
      for (const market of MARKETS) {
        markets[market] = summarizeMarket(inWindow.filter((row) => row.market === market));
      }
      windows[days] = {
        from: shiftYmd(asOf, -(days - 1)),
        through: asOf,
        ...metrics,
        markets,
      };
    }
    sports[sport] = { windows };
  }
  const driftFlags = collectDriftFlags(sports);
  const recommendation = recommendOne(prepared, asOf);
  const nflSplits = nflCalibrationSplits(joined);
  return {
    schema: SCHEMA,
    observerOnly: true,
    applied: false,
    asOf,
    generatedAt,
    windows: WINDOWS.slice(),
    cohort: prepared.length,
    sports,
    driftFlags,
    recommendation,
    nflSplits,
    sources: {
      ledger: 'omega-candidates/{date}',
      closes: 'clv-candidates-v2/{date}',
      results: 'graded result on the close row, else picks-{date}',
      days: 28,
    },
    note: NOTE,
  };
}

module.exports = {
  SPORTS,
  MARKETS,
  WINDOWS,
  CAL_BINS,
  K_STEP,
  K_MIN,
  K_MAX,
  MIN_CLV_N,
  KL_RISE,
  MIN_RECOMMEND_N,
  SCHEMA,
  LATEST_KEY,
  NOTE,
  reportKey,
  americanToImplied,
  logLoss,
  brier,
  klBernoulli,
  clvProb,
  shiftYmd,
  datesEnding,
  canonicalSport,
  canonicalMarket,
  inRollingWindow,
  calibrationCurve,
  fitShrinkK,
  summarize,
  normalizeRow,
  joinCandidates,
  buildRecalReport,
  collectDriftFlags,
  recommendOne,
  nflCalibrationSplits,
};
