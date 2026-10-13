'use strict';

/**
 * Display-only results views. Computed from fields the payloads already
 * carry (graded days, stored CLV rows, scored probabilities). Nothing here
 * prices a pick, sets a stake, or writes a blob.
 *
 * Win rate is wins / (wins + losses). Pushes are out. Break-even is the
 * average vigged implied probability of the prices paid on those decided
 * straights (52.4% at -110).
 * Parlay implied probability is the product of the straight prices on that
 * day (at most three). The ticket juice on top of that product is not stored.
 * Log-loss and Brier use a model probability when the row has one, and the
 * closing no-vig probability when the row has one. A recal report's 28-day
 * cells are copied when no scored rows were passed.
 */

const { clvPpOf, marketFamily } = require('../clv-ledger');

const BANDS = Object.freeze([
  '-300 to -151',
  '-150 to +150',
  '+151 to +200',
  '+201 to +300',
  'outside',
]);

function finite(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const t = value.trim().replace(/[−–]/g, '-').replace(/%/g, '').replace(/^\+/, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function mean(list) {
  const nums = (list || []).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** Vigged implied probability of an American price. The break-even rate. */
function americanImplied(odds) {
  const a = finite(odds);
  if (a == null || a === 0) return null;
  if (a > -100 && a < 100) return null;
  const p = a > 0 ? 100 / (a + 100) : Math.abs(a) / (Math.abs(a) + 100);
  if (!(p > 0 && p < 1)) return null;
  return p;
}

function priceBand(odds) {
  const a = finite(odds);
  if (a == null) return null;
  if (a < -300 || a > 300) return 'outside';
  if (a >= 201) return '+201 to +300';
  if (a >= 151) return '+151 to +200';
  if (a >= -150) return '-150 to +150';
  return '-300 to -151';
}

function outcomeBit(result) {
  if (result === 1 || result === 0) return result;
  const s = String(result || '').toLowerCase();
  if (s === 'win' || s === 'won' || s === 'w') return 1;
  if (s === 'loss' || s === 'lost' || s === 'l') return 0;
  return null;
}

function isParlayPick(pick) {
  if (!pick) return false;
  if (String(pick.sport || '').toUpperCase() === 'PARLAY') return true;
  return /parlay/i.test(String(pick.pick || ''));
}

function dayList(days) {
  return Array.isArray(days) ? days.filter((day) => day && typeof day === 'object') : [];
}

function straightPicks(days) {
  const out = [];
  for (const day of dayList(days)) {
    for (const pick of day.picks || []) {
      if (!pick || isParlayPick(pick)) continue;
      out.push(pick);
    }
  }
  return out;
}

function winRateVsBreakEven(days) {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  const implied = [];
  for (const pick of straightPicks(days)) {
    const y = outcomeBit(pick.result);
    if (y == null) {
      if (String(pick.result || '').toLowerCase() === 'push') pushes += 1;
      continue;
    }
    if (y === 1) wins += 1;
    else losses += 1;
    const be = americanImplied(pick.odds);
    if (be != null) implied.push(be);
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;
  const breakEven = mean(implied);
  return {
    n: decided,
    wins,
    losses,
    pushes,
    winRate: round4(winRate),
    breakEven: round4(breakEven),
    gap: winRate == null || breakEven == null ? null : round4(winRate - breakEven),
  };
}

function parlayHitVsImplied(days) {
  let wins = 0;
  let losses = 0;
  const implieds = [];
  for (const day of dayList(days)) {
    const y = outcomeBit(day.parlayResult);
    if (y == null) continue;
    const legs = [];
    for (const pick of day.picks || []) {
      if (!pick || isParlayPick(pick)) continue;
      if (americanImplied(pick.odds) == null) continue;
      legs.push(pick);
      if (legs.length === 3) break;
    }
    if (legs.length < 2) continue;
    if (y === 1) wins += 1;
    else losses += 1;
    let prod = 1;
    for (const leg of legs) prod *= americanImplied(leg.odds);
    implieds.push(prod);
  }
  const n = wins + losses;
  const hitRate = n > 0 ? wins / n : null;
  const implied = mean(implieds);
  return {
    n,
    wins,
    losses,
    hitRate: round4(hitRate),
    implied: round4(implied),
    gap: hitRate == null || implied == null ? null : round4(hitRate - implied),
    impliedFrom: 'product of straight prices',
  };
}

function clvSlices(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byBand = {};
  const byMarket = {};
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const pp = clvPpOf(row);
    if (pp == null) continue;
    const band = priceBand(row.entryPrice != null ? row.entryPrice : row.odds);
    const market = marketFamily(row.market || row.betType, row.side);
    if (band) {
      if (!byBand[band]) byBand[band] = [];
      byBand[band].push(pp);
    }
    const key = market || 'Other';
    if (!byMarket[key]) byMarket[key] = [];
    byMarket[key].push(pp);
  }
  function pack(values) {
    const beats = values.filter((n) => n > 0).length;
    return {
      n: values.length,
      avgClvPp: round4(mean(values)),
      beatClosePct: values.length ? round4((100 * beats) / values.length) : null,
    };
  }
  return {
    byPriceBand: BANDS.filter((band) => byBand[band]).map((band) => ({ band, ...pack(byBand[band]) })),
    byMarket: Object.keys(byMarket).sort().map((market) => ({ market, ...pack(byMarket[market]) })),
  };
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

function probOf(row, keys) {
  for (const key of keys) {
    const n = finite(row && row[key]);
    if (n != null && n > 0 && n < 1) return n;
  }
  return null;
}

function scoringFromRows(rows) {
  const groups = {};
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const sport = String(row.sport || '').trim().toUpperCase();
    if (!sport || sport === 'PARLAY') continue;
    const y = row.y === 0 || row.y === 1 ? row.y : outcomeBit(row.result != null ? row.result : row.outcome);
    if (y == null) continue;
    const pModel = probOf(row, ['pScore', 'coverProb', 'calibratedProb', 'p_model', 'modelRawP']);
    const pClose = probOf(row, ['pClose', 'closeNoVigP', 'closeNoVig', 'closeProb']);
    if (pModel == null && pClose == null) continue;
    if (!groups[sport]) groups[sport] = [];
    groups[sport].push({ y, pModel, pClose });
  }
  return Object.keys(groups).sort().map((sport) => {
    const group = groups[sport];
    return {
      sport,
      n: group.length,
      logLossModel: round4(mean(group.map((row) => logLoss(row.pModel, row.y)))),
      brierModel: round4(mean(group.map((row) => brier(row.pModel, row.y)))),
      logLossClose: round4(mean(group.map((row) => logLoss(row.pClose, row.y)))),
      brierClose: round4(mean(group.map((row) => brier(row.pClose, row.y)))),
    };
  });
}

function scoringFromRecal(recal) {
  if (!recal || !recal.sports) return [];
  const out = [];
  for (const sport of Object.keys(recal.sports).sort()) {
    const windows = recal.sports[sport] && recal.sports[sport].windows;
    const cell = windows && (windows[28] || windows['28']);
    if (!cell) continue;
    out.push({
      sport,
      n: Number(cell.n) || 0,
      logLossModel: round4(cell.logLossModel),
      brierModel: round4(cell.brierModel),
      logLossClose: round4(cell.logLossClose),
      brierClose: round4(cell.brierClose),
    });
  }
  return out;
}

function buildResultKpis(input) {
  const src = input || {};
  const clv = clvSlices(src.clvRows);
  const fromRows = scoringFromRows(src.scoredRows);
  return {
    displayOnly: true,
    applied: false,
    winRateVsBreakEven: winRateVsBreakEven(src.days),
    parlayHitVsImplied: parlayHitVsImplied(src.days),
    clvByPriceBand: clv.byPriceBand,
    clvByMarket: clv.byMarket,
    scoringBySport: fromRows.length ? fromRows : scoringFromRecal(src.recal),
  };
}

module.exports = {
  buildResultKpis,
  americanImplied,
  priceBand,
  winRateVsBreakEven,
  parlayHitVsImplied,
};
