'use strict';

/**
 * Fits for OMEGA_CAL_MODE B and C.
 * B: one K per (sport, market) on p = (1-K)*p_model + K*p_sharp, K in [0.3, 1].
 * C: Platt, or isotonic regression when the train fold is large enough,
 *    on the hand-set shrunk probability. No unfitted band.
 * The eval date is not an input. Callers pass only rows dated before it.
 */

const {
  K_POLICY, CAL_POOL, shrinkKForMarket, linearShrink, applyProbabilityMap, logit, sigmoid,
} = require('../../netlify/functions/lib/omega-vnext/calibrate');

const SPORTS = Object.freeze(['MLB', 'NFL', 'NCAAF', 'NHL', 'NBA']);
const FAMILIES = Object.freeze(['Spread', 'Total', 'Moneyline']);

function lossAt(p, y) {
  const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}

function brierAt(p, y) {
  const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return (pc - y) * (pc - y);
}

function round6(x) {
  if (x == null || !Number.isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}

function round2(x) {
  if (x == null || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

function gameIdOf(row) {
  return row.gameId || `${row.date}|${row.sport}|${row.matchup}`;
}

function gameCount(rows) {
  const s = new Set();
  for (const r of rows) s.add(gameIdOf(r));
  return s.size;
}

function familyOf(row) {
  return row.marketFamily || row.market;
}

function shrunkOf(row) {
  if (Number.isFinite(row._shrunk)) return row._shrunk;
  return linearShrink(row.p_model, row.fair_sharp_p, shrinkKForMarket(row.market, row.sport));
}

function meets(n, nGames, minRows, minGames) {
  return n >= minRows && nGames >= minGames;
}

function emptyAcc() {
  return { sum: new Float64Array(101), n: 0, games: new Set() };
}

function addRow(acc, row, grid) {
  acc.n += 1;
  acc.games.add(gameIdOf(row));
  for (let i = 0; i < 101; i++) acc.sum[i] += grid[i];
}

/**
 * Loss at K = i/100 for i = 0..100. Built once per row.
 */
function lossGridFor(row) {
  const g = new Float64Array(101);
  for (let i = 0; i <= 100; i++) {
    g[i] = lossAt(linearShrink(row.p_model, row.fair_sharp_p, i / 100), row.y);
  }
  return g;
}

function bestIndex(sum, n, lo, hi) {
  let bestI = lo;
  let best = Infinity;
  for (let i = lo; i <= hi; i++) {
    const loss = sum[i] / n;
    const k = i / 100;
    if (loss < best - 1e-12 || (Math.abs(loss - best) <= 1e-12 && k > bestI / 100)) {
      best = loss;
      bestI = i;
    }
  }
  return { k: bestI / 100, loss: best };
}

function fitFromAcc(acc) {
  if (!acc || !acc.n) {
    return { k: null, kMle: null, n: 0, nGames: 0, loss: null, bound: null };
  }
  const mle = bestIndex(acc.sum, acc.n, 0, 100);
  const boxed = bestIndex(acc.sum, acc.n, Math.round(K_POLICY.min * 100), Math.round(K_POLICY.max * 100));
  let bound = null;
  if (mle.k < K_POLICY.min - 1e-12) bound = 'policy-floor';
  else if (mle.k > K_POLICY.max + 1e-12) bound = 'market-cap';
  return {
    k: round2(boxed.k),
    kMle: round2(mle.k),
    n: acc.n,
    nGames: acc.games.size,
    loss: round6(boxed.loss),
    bound,
  };
}

function handCell(sport, family, n, nGames) {
  return {
    k: shrinkKForMarket(family, sport),
    kMle: null,
    n: n || 0,
    nGames: nGames || 0,
    loss: null,
    bound: null,
    level: 'handset',
    poolN: 0,
    poolGames: 0,
    note: 'No train pool cleared the sample floor. Applied K is the hand-set table, not a fit.',
  };
}

function fittedCell(fit, level, poolN, poolGames) {
  return {
    k: fit.k,
    kMle: fit.kMle,
    n: fit.n,
    nGames: fit.nGames,
    loss: fit.loss,
    bound: fit.bound,
    level,
    poolN: poolN == null ? fit.n : poolN,
    poolGames: poolGames == null ? fit.nGames : poolGames,
    note: fit.bound === 'policy-floor'
      ? 'Applied K is the product floor 0.3. kMle is the unconstrained grid minimizer and is not used.'
      : null,
  };
}

/**
 * @param {Array} rows train rows only
 * @param {Map|null} grids optional loss grids keyed by row object
 */
function fitShrinkTable(rows, grids) {
  const buckets = new Map();
  const ensure = (key) => {
    let acc = buckets.get(key);
    if (!acc) {
      acc = emptyAcc();
      buckets.set(key, acc);
    }
    return acc;
  };
  for (const row of rows) {
    const grid = grids ? grids.get(row) : lossGridFor(row);
    const sport = row.sport || 'default';
    const fam = familyOf(row);
    addRow(ensure('ALL'), row, grid);
    addRow(ensure(`S|${sport}`), row, grid);
    addRow(ensure(`C|${sport}|${fam}`), row, grid);
  }
  const globalFit = fitFromAcc(buckets.get('ALL'));
  const globalOk = meets(globalFit.n, globalFit.nGames, CAL_POOL.minRows, CAL_POOL.minGames);
  const cells = {};
  for (const sport of SPORTS) {
    const sportFit = fitFromAcc(buckets.get(`S|${sport}`));
    const sportOk = meets(sportFit.n, sportFit.nGames, CAL_POOL.minRows, CAL_POOL.minGames);
    for (const fam of FAMILIES) {
      const key = `${sport}|${fam}`;
      const cellFit = fitFromAcc(buckets.get(`C|${key}`));
      if (meets(cellFit.n, cellFit.nGames, CAL_POOL.minRows, CAL_POOL.minGames)) {
        cells[key] = fittedCell(cellFit, 'cell');
      } else if (sportOk) {
        cells[key] = fittedCell(sportFit, 'sport', sportFit.n, sportFit.nGames);
        cells[key].n = cellFit.n;
        cells[key].nGames = cellFit.nGames;
        cells[key].kMleCell = cellFit.kMle;
      } else if (globalOk) {
        cells[key] = fittedCell(globalFit, 'global', globalFit.n, globalFit.nGames);
        cells[key].n = cellFit.n;
        cells[key].nGames = cellFit.nGames;
        cells[key].kMleCell = cellFit.kMle;
      } else {
        cells[key] = handCell(sport, fam, cellFit.n, cellFit.nGames);
      }
    }
  }
  return {
    minRows: CAL_POOL.minRows,
    minGames: CAL_POOL.minGames,
    kMin: K_POLICY.min,
    kMax: K_POLICY.max,
    kMinIsProductConstraint: true,
    cells,
  };
}

function projectStep(a, b, da, db, loA, hiA, loB, hiB) {
  let na = a - da;
  let nb = b - db;
  na = Math.min(hiA, Math.max(loA, na));
  nb = Math.min(hiB, Math.max(loB, nb));
  return [na, nb];
}

/**
 * Platt on the shrunk probability. Logistic regression of y on logit(p_shrunk).
 * Starts at identity and two other slopes. Keeps the best train log-loss inside
 * a in [-2, 2], b in [0, 2]. b >= 0 keeps the map nondecreasing.
 */
function fitPlatt(rows) {
  const ps = [];
  const ys = [];
  for (const row of rows) {
    const p = shrunkOf(row);
    if (!Number.isFinite(p)) continue;
    ps.push(p);
    ys.push(row.y);
  }
  const n = ps.length;
  if (!n) return { a: 0, b: 1, loss: null, n: 0, bound: null };
  const zs = ps.map((p) => logit(p));
  const [loA, hiA] = CAL_POOL.plattA;
  const [loB, hiB] = CAL_POOL.plattB;

  function lossOf(a, b) {
    let s = 0;
    for (let i = 0; i < n; i++) s += lossAt(sigmoid(a + b * zs[i]), ys[i]);
    return s / n;
  }

  function newton(a0, b0) {
    let a = a0;
    let b = b0;
    for (let iter = 0; iter < 30; iter++) {
      let g0 = 0;
      let g1 = 0;
      let h00 = 0;
      let h01 = 0;
      let h11 = 0;
      for (let i = 0; i < n; i++) {
        const p = sigmoid(a + b * zs[i]);
        const r = p - ys[i];
        const w = Math.max(p * (1 - p), 1e-6);
        g0 += r;
        g1 += r * zs[i];
        h00 += w;
        h01 += w * zs[i];
        h11 += w * zs[i] * zs[i];
      }
      h00 += 1e-8;
      h11 += 1e-8;
      const det = h00 * h11 - h01 * h01;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
      const da = (h11 * g0 - h01 * g1) / det;
      const db = (h00 * g1 - h01 * g0) / det;
      const [na, nb] = projectStep(a, b, da, db, loA, hiA, loB, hiB);
      if (Math.abs(na - a) < 1e-9 && Math.abs(nb - b) < 1e-9) {
        a = na;
        b = nb;
        break;
      }
      a = na;
      b = nb;
    }
    return { a, b, loss: lossOf(a, b) };
  }

  let best = { a: 0, b: 1, loss: lossOf(0, 1) };
  for (const start of [[0, 1], [0, 0.5], [0, 1.5], [0, 0], [0.5, 1], [-0.5, 1]]) {
    const fit = newton(start[0], start[1]);
    if (fit.loss < best.loss - 1e-12) best = fit;
  }
  const boundA = best.a <= loA + 1e-6 || best.a >= hiA - 1e-6;
  const boundB = best.b <= loB + 1e-6 || best.b >= hiB - 1e-6;
  let bound = null;
  if (boundA && boundB) bound = 'a+b';
  else if (boundA) bound = 'a';
  else if (boundB) bound = 'b';
  return {
    a: round6(best.a),
    b: round6(best.b),
    loss: round6(best.loss),
    n,
    bound,
  };
}

/** Pool adjacent violators. Blocks are nondecreasing in the mean of y. */
function fitIsotonic(rows) {
  const pts = [];
  for (const row of rows) {
    const p = shrunkOf(row);
    if (!Number.isFinite(p)) continue;
    pts.push({ p, y: row.y });
  }
  pts.sort((a, b) => a.p - b.p);
  const blocks = [];
  for (const pt of pts) {
    blocks.push({ sum: pt.y, n: 1, x0: pt.p, x1: pt.p });
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.sum / left.n <= right.sum / right.n + 1e-12) break;
      blocks.pop();
      blocks.pop();
      blocks.push({
        sum: left.sum + right.sum,
        n: left.n + right.n,
        x0: left.x0,
        x1: right.x1,
      });
    }
  }
  return blocks.map((b) => ({
    x0: round6(b.x0),
    x1: round6(b.x1),
    v: round6(b.sum / b.n),
  }));
}

function meanMapLoss(rows, map) {
  if (!rows.length) return null;
  let s = 0;
  let n = 0;
  for (const row of rows) {
    const p0 = shrunkOf(row);
    if (!Number.isFinite(p0)) continue;
    s += lossAt(applyProbabilityMap(p0, map), row.y);
    n += 1;
  }
  return n ? s / n : null;
}

function plattCell(fit, level, n, nGames, poolN, poolGames) {
  return {
    type: 'platt',
    a: fit.a,
    b: fit.b,
    bound: fit.bound,
    trainLogLoss: fit.loss,
    level,
    n,
    nGames,
    poolN,
    poolGames,
  };
}

function isoCell(knots, isoLoss, platt, level, n, nGames, poolN, poolGames) {
  return {
    type: 'isotonic',
    knots,
    trainLogLoss: round6(isoLoss),
    plattA: platt.a,
    plattB: platt.b,
    plattTrainLogLoss: platt.loss,
    level,
    n,
    nGames,
    poolN,
    poolGames,
    note: 'Isotonic regression (pool adjacent violators) on the hand-set shrunk probability. Chosen because train log-loss beat Platt by the pre-specified margin. Not the legacy 0.42–0.58 band.',
  };
}

function identityCell(n, nGames, reason) {
  return {
    type: 'identity',
    level: 'identity',
    n: n || 0,
    nGames: nGames || 0,
    poolN: 0,
    poolGames: 0,
    reason,
    note: 'Sample floor not met. The hand-set shrunk probability is published unchanged. The unfitted 0.42–0.58 band is not applied.',
  };
}

function chooseMap(rows) {
  const platt = fitPlatt(rows);
  const plattMap = { type: 'platt', a: platt.a, b: platt.b };
  const n = rows.length;
  const nGames = gameCount(rows);
  if (meets(n, nGames, CAL_POOL.isoMinRows, CAL_POOL.isoMinGames)) {
    const knots = fitIsotonic(rows);
    const isoLoss = meanMapLoss(rows, { type: 'isotonic', knots });
    if (isoLoss != null && platt.loss != null && isoLoss < platt.loss - CAL_POOL.isoTrainMargin) {
      return { kind: 'isotonic', knots, isoLoss, platt, n, nGames };
    }
  }
  return { kind: 'platt', platt, n, nGames };
}

function fitMapTable(rows) {
  const bySport = new Map();
  const byCell = new Map();
  for (const row of rows) {
    const sport = row.sport || 'default';
    const fam = familyOf(row);
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport).push(row);
    const key = `${sport}|${fam}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(row);
  }
  const globalOk = meets(rows.length, gameCount(rows), CAL_POOL.minRows, CAL_POOL.minGames);
  const globalChoice = globalOk ? chooseMap(rows) : null;
  const sportChoice = new Map();
  for (const sport of SPORTS) {
    const subset = bySport.get(sport) || [];
    if (meets(subset.length, gameCount(subset), CAL_POOL.minRows, CAL_POOL.minGames)) {
      sportChoice.set(sport, chooseMap(subset));
    }
  }
  const cells = {};
  for (const sport of SPORTS) {
    for (const fam of FAMILIES) {
      const key = `${sport}|${fam}`;
      const subset = byCell.get(key) || [];
      const n = subset.length;
      const nGames = gameCount(subset);
      let choice = null;
      let level = null;
      let poolRows = null;
      if (meets(n, nGames, CAL_POOL.minRows, CAL_POOL.minGames)) {
        choice = chooseMap(subset);
        level = 'cell';
        poolRows = subset;
      } else if (sportChoice.has(sport)) {
        choice = sportChoice.get(sport);
        level = 'sport';
        poolRows = bySport.get(sport) || [];
      } else if (globalChoice) {
        choice = globalChoice;
        level = 'global';
        poolRows = rows;
      }
      if (!choice) {
        cells[key] = identityCell(n, nGames, 'below min sample at cell, sport, and global');
        continue;
      }
      const poolN = poolRows.length;
      const poolGames = gameCount(poolRows);
      if (choice.kind === 'isotonic') {
        cells[key] = isoCell(choice.knots, choice.isoLoss, choice.platt, level, n, nGames, poolN, poolGames);
      } else {
        cells[key] = plattCell(choice.platt, level, n, nGames, poolN, poolGames);
      }
    }
  }
  return {
    minRows: CAL_POOL.minRows,
    minGames: CAL_POOL.minGames,
    isoMinRows: CAL_POOL.isoMinRows,
    isoMinGames: CAL_POOL.isoMinGames,
    isoTrainMargin: CAL_POOL.isoTrainMargin,
    plattA: CAL_POOL.plattA.slice(),
    plattB: CAL_POOL.plattB.slice(),
    on: 'hand-set shrunk probability, shrinkTowardSharp, no band',
    cells,
  };
}

module.exports = {
  SPORTS,
  FAMILIES,
  lossAt,
  brierAt,
  round6,
  gameIdOf,
  gameCount,
  shrunkOf,
  lossGridFor,
  fitShrinkTable,
  fitPlatt,
  fitIsotonic,
  fitMapTable,
  meanMapLoss,
};
