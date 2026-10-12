'use strict';

/**
 * Closing-line ledger for the public CLV page.
 * Display only. No prices, no selection, no writes.
 *
 * One row per graded bet. clvPp is no-vig close minus no-vig entry,
 * in percentage points (track-clv clvCents). Positive beat the close.
 * entryPrice is American odds when the source stored them.
 * closeNoVigP is the closing no-vig probability of the side.
 *
 * Day files that only store a family average become one aggregate row
 * per graded bet at that average, with beat flags that match the stored
 * beat rate. A later ticket for the same source and date replaces those
 * aggregate rows so a backfill does not double-count.
 */

const ALPHA_FROM = '2026-06-20';
const ALPHA_TO = '2026-10-07';
const OMEGA_FROM = '2026-09-05';
const SMALL_N = 50;
const LIVE_LOOKBACK_DAYS = 45;
const CANDIDATE_AVG_TARGET_PP = 0;
const PICK_AVG_TARGET_PP = 1;
const PICK_BEAT_TARGET_PCT = 55;
const LATEST_KEY = 'omega-clv-report/latest';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function round1(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function americanOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^even$/i.test(text)) return 100;
  const n = Number(text.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function probOrNull(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  return round4(n);
}

function marketFamily(market, side) {
  const m = String(market || '').toLowerCase();
  const s = String(side || '').toLowerCase();
  if (m.includes('f5') || /\bf5\b/.test(s)) return 'F5';
  if (m.includes('total') || /^(over|under)\b/.test(s)) return 'Total';
  if (m.includes('moneyline') || m === 'h2h' || m === 'ml' || /\bml\b/.test(s)) return 'ML';
  if (m.includes('run line') || m.includes('spread') || m.includes('puck')) return 'Spread';
  if (market) return String(market);
  return 'Other';
}

function normSport(sport) {
  if (sport == null || String(sport).trim() === '') return null;
  const s = String(sport).trim().toUpperCase();
  if (s === 'CFB' || s === 'NCAAF' || s === 'COLLEGE FOOTBALL') return 'NCAAF';
  if (s === 'MLB' || s === 'NFL' || s === 'NHL' || s === 'NBA') return s;
  return s;
}

function normMatchup(matchup) {
  return String(matchup || '')
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalSide(market, side) {
  const family = marketFamily(market, side);
  const s = String(side || '').trim();
  if (family === 'Total' || family === 'F5') {
    if (/^under\b/i.test(s)) return 'under';
    if (/^over\b/i.test(s)) return 'over';
  }
  return s
    .replace(/\s+[+-]?\d+(?:\.\d+)?$/, '')
    .replace(/\s+ml$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function lineToken(line) {
  if (line == null || line === '') return '';
  const n = Number(line);
  if (!Number.isFinite(n)) return String(line).trim().toLowerCase();
  return String(Object.is(n, -0) ? 0 : n);
}

function dedupeKey(row) {
  if (!row) return '';
  if (row.aggregate) {
    return [
      'agg',
      row.source || '',
      row.date || '',
      row.market || '',
      String(row.aggregateIndex == null ? '' : row.aggregateIndex),
    ].join('|');
  }
  return [
    row.source || '',
    row.date || '',
    normSport(row.sport) || '',
    marketFamily(row.market, row.side),
    canonicalSide(row.market, row.side),
    normMatchup(row.matchup),
    lineToken(row.line),
  ].join('|');
}

function clvPpOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.clvCents != null && Number.isFinite(Number(row.clvCents))) return round2(row.clvCents);
  if (row.clvProbCents != null && Number.isFinite(Number(row.clvProbCents))) return round2(row.clvProbCents);
  if (row.clvPp != null && Number.isFinite(Number(row.clvPp))) return round2(row.clvPp);
  if (row.clv != null && Number.isFinite(Number(row.clv))) return round2(Number(row.clv) * 100);
  if (row.clvProb != null && Number.isFinite(Number(row.clvProb))) return round2(Number(row.clvProb) * 100);
  return null;
}

function beatOf(row, clvPp) {
  if (row && (row.beatClosing === true || row.beatClose === true)) return true;
  if (row && (row.beatClosing === false || row.beatClose === false)) return false;
  return clvPp > 0;
}

function modelOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function finishRow(draft) {
  const market = marketFamily(draft.market, draft.side);
  const row = {
    source: draft.source,
    kind: draft.kind === 'candidate' ? 'candidate' : 'pick',
    date: draft.date || null,
    sport: normSport(draft.sport),
    market: market === 'Other' && !draft.market ? null : market,
    side: draft.side == null || draft.side === '' ? null : String(draft.side),
    matchup: draft.matchup == null || draft.matchup === '' ? null : String(draft.matchup),
    line: finiteOrNull(draft.line),
    entryPrice: americanOrNull(draft.entryPrice),
    closeNoVigP: probOrNull(draft.closeNoVigP),
    clvPp: round2(draft.clvPp),
    beatClose: !!draft.beatClose,
    modelVersion: modelOrNull(draft.modelVersion),
  };
  if (draft.aggregate) {
    row.aggregate = true;
    row.aggregateIndex = draft.aggregateIndex;
  }
  row.key = dedupeKey(row);
  return row;
}

function rowsFromClvBlob(blob, opts) {
  if (!blob || typeof blob !== 'object') return [];
  const src = opts || {};
  const date = src.date || blob.date || null;
  const source = src.source || 'omega';
  const modelVersion = modelOrNull(src.modelVersion || blob.model || blob.modelVersion);
  const picks = Array.isArray(blob.picks) ? blob.picks : [];
  const rows = [];
  for (const pick of picks) {
    const clvPp = clvPpOf(pick);
    if (clvPp == null) continue;
    rows.push(finishRow({
      source,
      kind: 'pick',
      date: pick.date || date,
      sport: pick.sport,
      market: pick.market || pick.betType,
      side: pick.pick || pick.side,
      matchup: pick.matchup,
      line: pick.betLine != null ? pick.betLine : pick.line,
      entryPrice: pick.pickTimeOdds != null ? pick.pickTimeOdds : pick.odds,
      closeNoVigP: pick.closingNoVig != null ? pick.closingNoVig : pick.closeNoVig,
      clvPp,
      beatClose: beatOf(pick, clvPp),
      modelVersion: pick.modelVersion || pick.model || modelVersion,
    }));
  }
  return rows;
}

function rowsFromCandidateBlob(blob, opts) {
  if (!blob || typeof blob !== 'object') return [];
  const src = opts || {};
  const date = src.date || blob.date || null;
  const modelVersion = modelOrNull(src.modelVersion || blob.model || blob.modelVersion);
  const list = Array.isArray(blob.candidates) ? blob.candidates
    : Array.isArray(blob.sides) ? blob.sides
      : Array.isArray(blob.rows) ? blob.rows
        : [];
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const clvPp = clvPpOf(item);
    if (clvPp == null) continue;
    const published = item.published === true || item.kind === 'pick';
    rows.push(finishRow({
      source: 'omega',
      kind: published ? 'pick' : 'candidate',
      date: item.date || date,
      sport: item.sport,
      market: item.market || item.betType,
      side: item.side || item.pick,
      matchup: item.matchup,
      line: item.line != null ? item.line : item.betLine,
      entryPrice: item.odds != null ? item.odds : item.pickTimeOdds,
      closeNoVigP: item.closeNoVig != null ? item.closeNoVig : item.closingNoVig,
      clvPp,
      beatClose: beatOf(item, clvPp),
      modelVersion: item.modelVersion || item.model || modelVersion,
    }));
  }
  return rows;
}

function beatCount(pct, n) {
  const p = Number(pct);
  const count = Number(n);
  if (!Number.isFinite(p) || !Number.isFinite(count) || count <= 0) return 0;
  const beats = Math.round((p / 100) * count);
  if (beats < 0) return 0;
  if (beats > count) return count;
  return beats;
}

function aggregateRow(src) {
  return finishRow({
    source: src.source,
    kind: 'pick',
    date: src.date,
    sport: null,
    market: src.market,
    side: null,
    matchup: null,
    line: null,
    entryPrice: null,
    closeNoVigP: null,
    clvPp: src.clvPp,
    beatClose: src.beatClose,
    modelVersion: src.modelVersion || null,
    aggregate: true,
    aggregateIndex: src.index,
  });
}

/**
 * Family-average day file (the clv-inv shape) or a day file that already
 * carries a picks array. Empty and unavailable days return [].
 */
function rowsFromDaySummary(doc, opts) {
  const src = opts || {};
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc.picks) && doc.picks.some((p) => clvPpOf(p) != null)) {
    return rowsFromClvBlob(doc, src);
  }
  if (doc.available === false) return [];
  const date = src.date || doc.from || doc.date || null;
  const source = src.source || doc.book || null;
  if (!source || !date) return [];
  const families = doc.byFamily && typeof doc.byFamily === 'object' ? doc.byFamily : null;
  const names = families ? Object.keys(families).sort() : [];
  if (names.length) {
    const rows = [];
    for (const market of names) {
      const fam = families[market] || {};
      const n = Number(fam.n) || 0;
      const mean = finiteOrNull(fam.meanCents);
      if (!n || mean == null) continue;
      const beats = beatCount(fam.beatClosePct, n);
      for (let i = 0; i < n; i += 1) {
        rows.push(aggregateRow({
          source,
          date,
          market,
          clvPp: mean,
          beatClose: i < beats,
          index: i,
          modelVersion: src.modelVersion,
        }));
      }
    }
    return rows;
  }
  const n = Number(doc.n) || 0;
  const mean = finiteOrNull(doc.meanCents);
  if (!n || mean == null) return [];
  const beats = beatCount(doc.beatClosePct, n);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(aggregateRow({
      source,
      date,
      market: null,
      clvPp: mean,
      beatClose: i < beats,
      index: i,
      modelVersion: src.modelVersion,
    }));
  }
  return rows;
}

function blobKind(key) {
  const text = String(key || '');
  if (/^clv-\d{4}-\d{2}-\d{2}$/.test(text)) return 'picks';
  if (text.startsWith('clv-candidates-v2/') || text.startsWith('clv-candidates-') || text.startsWith('omega-candidates/')) {
    return 'candidates';
  }
  return null;
}

function rowsFromBlob(key, blob, opts) {
  const kind = blobKind(key);
  if (kind === 'picks') return rowsFromClvBlob(blob, opts);
  if (kind === 'candidates') return rowsFromCandidateBlob(blob, opts);
  return [];
}

function filled(prev, next) {
  const out = { ...prev };
  const fields = ['clvPp', 'beatClose', 'closeNoVigP', 'entryPrice', 'sport', 'market', 'side', 'matchup', 'line', 'modelVersion', 'date'];
  for (const field of fields) {
    if (next[field] != null && next[field] !== '') out[field] = next[field];
  }
  if (prev.kind === 'pick' || next.kind === 'pick') out.kind = 'pick';
  else out.kind = next.kind || prev.kind;
  if (prev.aggregate && next.aggregate) {
    out.aggregate = true;
    out.aggregateIndex = prev.aggregateIndex;
  } else {
    delete out.aggregate;
    delete out.aggregateIndex;
  }
  out.key = dedupeKey(out);
  return out;
}

function preferRow(prev, next) {
  if (prev.aggregate && !next.aggregate) {
    const out = { ...next, kind: prev.kind === 'pick' || next.kind === 'pick' ? 'pick' : next.kind };
    out.key = dedupeKey(out);
    return out;
  }
  if (next.aggregate && !prev.aggregate) return prev;
  return filled(prev, next);
}

function compareRows(a, b) {
  const date = String(a.date || '').localeCompare(String(b.date || ''));
  if (date) return date;
  const source = String(a.source || '').localeCompare(String(b.source || ''));
  if (source) return source;
  return String(a.key || '').localeCompare(String(b.key || ''));
}

/**
 * Append-only merge. Same dedupe key keeps one row (later close wins).
 * A real ticket for a source+date drops that date's family-average rows.
 */
function mergeRows(rows) {
  const map = new Map();
  const order = [];
  for (const raw of rows || []) {
    if (!raw || raw.clvPp == null || !Number.isFinite(Number(raw.clvPp))) continue;
    const row = raw.key && raw.source && raw.date ? { ...raw } : finishRow(raw);
    if (!row.key) row.key = dedupeKey(row);
    const key = dedupeKey(row);
    row.key = key;
    const prev = map.get(key);
    if (!prev) {
      order.push(key);
      map.set(key, row);
      continue;
    }
    map.set(key, preferRow(prev, row));
  }
  let merged = order.map((key) => map.get(key));
  const realDates = new Set();
  for (const row of merged) {
    if (!row.aggregate) realDates.add(`${row.source}|${row.date}`);
  }
  if (realDates.size) {
    merged = merged.filter((row) => !(row.aggregate && realDates.has(`${row.source}|${row.date}`)));
  }
  merged.sort(compareRows);
  return merged;
}

function bucket(rows) {
  const list = rows || [];
  const n = list.length;
  if (!n) {
    return {
      n: 0,
      avgClvPp: null,
      beatClosePct: null,
      smallSample: true,
      sampleLabel: 'n<50',
    };
  }
  let sum = 0;
  let beats = 0;
  for (const row of list) {
    sum += Number(row.clvPp);
    if (row.beatClose === true) beats += 1;
  }
  const smallSample = n < SMALL_N;
  return {
    n,
    avgClvPp: round2(sum / n),
    beatClosePct: round1((beats / n) * 100),
    smallSample,
    sampleLabel: smallSample ? 'n<50' : null,
  };
}

function sportLabel(row) {
  if (row.sport) return row.sport;
  if (row.source === 'alpha') return 'Alpha (sport not on file)';
  if (row.source === 'omega') return 'Omega (sport not on file)';
  return 'Sport not on file';
}

function targetBlock(rows, extra) {
  const base = bucket(rows);
  const avgGapPp = base.avgClvPp == null ? null : round2(base.avgClvPp - extra.targetAvgClvPp);
  const meetsAvg = base.avgClvPp == null ? null : base.avgClvPp >= extra.targetAvgClvPp;
  const meetsBeat = extra.targetBeatClosePct == null || base.beatClosePct == null
    ? null
    : base.beatClosePct >= extra.targetBeatClosePct;
  return {
    ...base,
    targetAvgClvPp: extra.targetAvgClvPp,
    targetBeatClosePct: extra.targetBeatClosePct == null ? null : extra.targetBeatClosePct,
    avgGapPp,
    meetsAvg,
    meetsBeat,
  };
}

function etParts(now) {
  const when = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const piece of fmt.formatToParts(when)) {
    if (piece.type !== 'literal') parts[piece.type] = piece.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
  };
}

function etYmd(now) {
  return etParts(now).ymd;
}

function formatUpdatedAtEt(now) {
  const when = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${fmt.format(when)} ET`;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function eachDate(from, to) {
  const out = [];
  if (!from || !to || to < from) return out;
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    cursor = shiftYmd(cursor, 1);
  }
  return out;
}

function liveDates(asOf, lookbackDays) {
  const days = lookbackDays == null ? LIVE_LOOKBACK_DAYS : lookbackDays;
  const start = shiftYmd(asOf, -(days - 1));
  const from = start > OMEGA_FROM ? start : OMEGA_FROM;
  return eachDate(from, asOf);
}

function buildReport(opts) {
  const src = opts || {};
  const rows = mergeRows(src.rows || []);
  const generatedAt = src.generatedAt || new Date().toISOString();
  const asOf = src.asOf || etYmd(generatedAt);
  const byModel = {
    Alpha: bucket(rows.filter((row) => row.source === 'alpha')),
    Omega: bucket(rows.filter((row) => row.source === 'omega')),
  };
  const sportMap = new Map();
  for (const row of rows) {
    const sport = sportLabel(row);
    if (!sportMap.has(sport)) sportMap.set(sport, []);
    sportMap.get(sport).push(row);
  }
  const bySport = [...sportMap.entries()]
    .map(([sport, list]) => ({ sport, ...bucket(list) }))
    .sort((a, b) => (b.n - a.n) || a.sport.localeCompare(b.sport));
  const omega = rows.filter((row) => row.source === 'omega');
  const published = omega.filter((row) => row.kind === 'pick');
  return {
    schema: 'omega-clv-report-v1',
    observerOnly: true,
    applied: false,
    displayOnly: true,
    asOf,
    generatedAt,
    updatedAtEt: formatUpdatedAtEt(generatedAt),
    window: {
      alphaFrom: ALPHA_FROM,
      alphaTo: ALPHA_TO,
      omegaFrom: OMEGA_FROM,
    },
    totals: {
      overall: bucket(rows),
      byModel,
      bySport,
    },
    omegaTargets: {
      allCandidates: targetBlock(omega, {
        targetAvgClvPp: CANDIDATE_AVG_TARGET_PP,
        targetBeatClosePct: null,
      }),
      publishedPicks: targetBlock(published, {
        targetAvgClvPp: PICK_AVG_TARGET_PP,
        targetBeatClosePct: PICK_BEAT_TARGET_PCT,
      }),
    },
    n: rows.length,
    source: src.source || null,
  };
}

function signedPp(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = round2(value);
  const text = Math.abs(n).toFixed(2);
  if (n > 0) return `+${text}`;
  if (n < 0) return `-${text}`;
  return '0.00';
}

function pctText(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${round1(value).toFixed(1)}%`;
}

function formatTotalsTable(report) {
  const lines = [
    '| Slice | n | Avg CLV (pp) | Beat close | Sample |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  const add = (name, block) => {
    lines.push(`| ${name} | ${block.n} | ${signedPp(block.avgClvPp)} | ${pctText(block.beatClosePct)} | ${block.sampleLabel || ''} |`);
  };
  add('Overall', report.totals.overall);
  add('Alpha', report.totals.byModel.Alpha);
  add('Omega', report.totals.byModel.Omega);
  for (const sport of report.totals.bySport) add(sport.sport, sport);
  add('Omega all closes (target avg ≥ 0 pp)', report.omegaTargets.allCandidates);
  add('Omega published picks (target avg ≥ +1.0 pp, beat ≥ 55%)', report.omegaTargets.publishedPicks);
  return lines.join('\n');
}

function reportKey(dateISO) {
  return `omega-clv-report/${dateISO}`;
}

module.exports = {
  ALPHA_FROM,
  ALPHA_TO,
  OMEGA_FROM,
  SMALL_N,
  LIVE_LOOKBACK_DAYS,
  CANDIDATE_AVG_TARGET_PP,
  PICK_AVG_TARGET_PP,
  PICK_BEAT_TARGET_PCT,
  LATEST_KEY,
  marketFamily,
  normSport,
  canonicalSide,
  dedupeKey,
  clvPpOf,
  rowsFromClvBlob,
  rowsFromCandidateBlob,
  rowsFromDaySummary,
  rowsFromBlob,
  blobKind,
  mergeRows,
  bucket,
  buildReport,
  formatTotalsTable,
  signedPp,
  etYmd,
  formatUpdatedAtEt,
  shiftYmd,
  eachDate,
  liveDates,
  reportKey,
};
