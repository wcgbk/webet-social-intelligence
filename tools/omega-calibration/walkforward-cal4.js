'use strict';

/**
 * Expanding-window scores for OMEGA_CAL_MODE A, B, and C.
 *
 * Window 2026-09-22..2026-10-08. For each card date D, B and C are fit on
 * graded rows dated before D and scored on D. A has no fit. Production is
 * the hand-set shrink plus the unfitted 0.42–0.58 band. Cluster bootstrap
 * is by game, B = 1000, seed 6167.
 *
 *   node tools/omega-calibration/walkforward-cal4.js
 *   node tools/omega-calibration/walkforward-cal4.js --data /path/dataset.jsonl
 *
 * Writes:
 *   netlify/functions/lib/omega-vnext/data/omega-cal-mode.json
 *   tools/omega-calibration/out/walkforward-cal4.json
 *   tools/omega-calibration/out/walkforward-cal4.md
 *
 * byDate[D] is the record replay must use for D. `ship` is fit on the whole
 * window, including the last day, and is only for a card after that window.
 */

const fs = require('fs');
const path = require('path');
const {
  probabilityForMode, shrinkTowardSharp, bandRetainClip, K_POLICY, CAL_POOL, BAND_CLIP,
} = require('../../netlify/functions/lib/omega-vnext/calibrate');
const {
  SPORTS, FAMILIES, lossAt, brierAt, round6, gameIdOf, lossGridFor, fitShrinkTable, fitMapTable,
} = require('./cal4-fit');

const DATA = arg('--data') || '/workspace/omega-autopilot/wt-calib/tools/omega-calibration/out/dataset.jsonl';
const ROOT = path.join(__dirname, '../..');
const OUT_DIR = path.join(__dirname, 'out');
const REPORT_JSON = path.join(OUT_DIR, 'walkforward-cal4.json');
const REPORT_MD = path.join(OUT_DIR, 'walkforward-cal4.md');
const PARAMS_FILE = path.join(ROOT, 'netlify/functions/lib/omega-vnext/data/omega-cal-mode.json');

const WINDOW_START = '2026-09-22';
const WINDOW_END = '2026-10-08';
const BOOT = 1000;
const SEED = 6167;
const METHODS = ['market', 'production', 'A', 'B', 'C', 'raw'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - i) + s[hi] * (i - lo);
}

function dateRange(start, end) {
  const out = [];
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function usable(row) {
  return !!row
    && (row.y === 0 || row.y === 1)
    && Number.isFinite(row.p_model)
    && Number.isFinite(row.fair_sharp_p)
    && row.p_model > 0 && row.p_model < 1
    && row.fair_sharp_p > 0 && row.fair_sharp_p < 1;
}

function loadRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function scorePair(p, y) {
  return { ll: lossAt(p, y), br: brierAt(p, y) };
}

function ciOf(xs) {
  return [round6(percentile(xs, 0.025)), round6(percentile(xs, 0.975))];
}

function bootstrap(scored, rand) {
  const byGame = new Map();
  for (const row of scored) {
    if (!byGame.has(row.gameId)) byGame.set(row.gameId, []);
    byGame.get(row.gameId).push(row);
  }
  const games = [...byGame.values()];
  const n = games.length;
  const bags = {};
  for (const m of METHODS) bags[m] = { ll: [], br: [] };
  const contrasts = ['A', 'B', 'C'];
  const diffs = {};
  for (const m of contrasts) {
    diffs[`${m}MinusProductionLl`] = [];
    diffs[`${m}MinusMarketLl`] = [];
    diffs[`${m}MinusProductionBr`] = [];
    diffs[`${m}MinusMarketBr`] = [];
  }
  for (let b = 0; b < BOOT; b++) {
    const sums = {};
    for (const m of METHODS) sums[m] = { ll: 0, br: 0, n: 0 };
    for (let i = 0; i < n; i++) {
      const g = games[(rand() * n) | 0];
      for (const row of g) {
        for (const m of METHODS) {
          sums[m].ll += row[m].ll;
          sums[m].br += row[m].br;
          sums[m].n += 1;
        }
      }
    }
    for (const m of METHODS) {
      bags[m].ll.push(sums[m].ll / sums[m].n);
      bags[m].br.push(sums[m].br / sums[m].n);
    }
    for (const m of contrasts) {
      diffs[`${m}MinusProductionLl`].push(sums[m].ll / sums[m].n - sums.production.ll / sums.production.n);
      diffs[`${m}MinusMarketLl`].push(sums[m].ll / sums[m].n - sums.market.ll / sums.market.n);
      diffs[`${m}MinusProductionBr`].push(sums[m].br / sums[m].n - sums.production.br / sums.production.n);
      diffs[`${m}MinusMarketBr`].push(sums[m].br / sums[m].n - sums.market.br / sums.market.n);
    }
  }
  const ci = {};
  for (const m of METHODS) {
    ci[m] = { logLoss: ciOf(bags[m].ll), brier: ciOf(bags[m].br) };
  }
  const diffOut = {};
  for (const k of Object.keys(diffs)) {
    const meanDiff = mean(diffs[k]);
    const band = ciOf(diffs[k]);
    diffOut[k] = {
      mean: round6(meanDiff),
      ci95: band,
      excludesZero: band[0] > 0 || band[1] < 0,
      pointBetter: meanDiff < 0,
    };
  }
  return { ci, diffs: diffOut, nGames: n, B: BOOT, seed: SEED };
}

function point(scored, method) {
  return {
    logLoss: round6(mean(scored.map((r) => r[method].ll))),
    brier: round6(mean(scored.map((r) => r[method].br))),
    n: scored.length,
  };
}

function countLevels(block) {
  const counts = {};
  if (!block || !block.cells) return counts;
  for (const cell of Object.values(block.cells)) {
    const key = cell.level || cell.type || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function slimCells(block, mode) {
  const out = {};
  for (const [key, cell] of Object.entries(block.cells)) {
    if (mode === 'B') {
      out[key] = {
        k: cell.k,
        kMle: cell.kMle,
        bound: cell.bound,
        level: cell.level,
        n: cell.n,
        nGames: cell.nGames,
        poolN: cell.poolN,
        poolGames: cell.poolGames,
      };
    } else {
      out[key] = {
        type: cell.type,
        a: cell.a,
        b: cell.b,
        bound: cell.bound,
        level: cell.level,
        n: cell.n,
        nGames: cell.nGames,
        poolN: cell.poolN,
        knots: cell.type === 'isotonic' ? (cell.knots || []).length : undefined,
        trainLogLoss: cell.trainLogLoss,
      };
    }
  }
  return out;
}

function markdown(report) {
  const lines = [];
  lines.push('# Calibration modes A / B / C, expanding window');
  lines.push('');
  lines.push(`Dataset \`${report.data}\`. Graded rows ${report.n}. Games ${report.nGames}.`);
  lines.push(`Window ${report.window[0]}..${report.window[1]}. Cluster bootstrap by game, B=${report.bootstrap.B}, seed ${report.bootstrap.seed}.`);
  lines.push('');
  lines.push('Production is the hand-set shrink (`SHRINK_K`, MLB `shrinkK`) followed by `bandRetainClip`: a fixed 0.42–0.58 band that keeps 25% of the excess. That step was named `isotonicClip`. It is not a fitted isotonic regression.');
  lines.push('');
  lines.push('A drops that band and keeps the hand-set shrink. B fits K on the same linear form with no band. K is bounded to [0.3, 1.0]. The lower bound is a product constraint equal to the lowest hand-set K (MLB moneyline 0.30), not a log-loss estimate. `kMle` is the unconstrained minimizer on [0, 1] and is not applied when it sits below 0.3. C keeps the hand-set shrink and replaces the band with a Platt map on that shrunk probability. Isotonic regression is used only when the train pool has at least 400 rows and 50 games and its train log-loss beats Platt by 0.001. Pools under 80 rows or 20 games step up to sport, then global, then the hand-set K (B) or the identity map (C).');
  lines.push('');
  lines.push('Floors and gates are not part of this fit. `minCoverProb`, `minEV`, and the rest of `GATES` stay at the current values.');
  lines.push('');
  lines.push('## Out of sample');
  lines.push('');
  lines.push('| method | log-loss | 95% CI | Brier | 95% CI |');
  lines.push('| --- | ---: | --- | ---: | --- |');
  for (const m of METHODS) {
    const s = report.scores[m];
    const c = report.bootstrap.ci[m];
    lines.push(`| ${m} | ${s.logLoss.toFixed(6)} | ${c.logLoss[0].toFixed(6)} .. ${c.logLoss[1].toFixed(6)} | ${s.brier.toFixed(6)} | ${c.brier[0].toFixed(6)} .. ${c.brier[1].toFixed(6)} |`);
  }
  lines.push('');
  lines.push('| contrast | mean | 95% CI | CI excludes 0 | point estimate better |');
  lines.push('| --- | ---: | --- | --- | --- |');
  for (const [k, d] of Object.entries(report.bootstrap.diffs)) {
    lines.push(`| ${k} | ${d.mean.toFixed(6)} | ${d.ci95[0].toFixed(6)} .. ${d.ci95[1].toFixed(6)} | ${d.excludesZero} | ${d.pointBetter} |`);
  }
  lines.push('');
  lines.push('A negative contrast is a lower score than the baseline. Lower log-loss and lower Brier are better.');
  lines.push('');
  lines.push('## Log-loss ship check (volume is a separate replay)');
  lines.push('');
  lines.push('| mode | log-loss vs production | meets log-loss bar |');
  lines.push('| --- | --- | --- |');
  for (const m of ['A', 'B', 'C']) {
    const d = report.bootstrap.diffs[`${m}MinusProductionLl`];
    const meetsBar = d.pointBetter === true;
    const how = d.excludesZero ? 'CI excludes 0' : 'point estimate better, CI overlaps 0';
    lines.push(`| ${m} | ${d.mean.toFixed(6)} (${how}) | ${meetsBar} |`);
  }
  lines.push('');
  lines.push('## By date (log-loss)');
  lines.push('');
  lines.push('| date | n | market | production | A | B | C | raw |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const day of report.byDate) {
    const L = day.logLoss;
    lines.push(`| ${day.date} | ${day.n} | ${L.market.toFixed(6)} | ${L.production.toFixed(6)} | ${L.A.toFixed(6)} | ${L.B.toFixed(6)} | ${L.C.toFixed(6)} | ${L.raw.toFixed(6)} |`);
  }
  lines.push('');
  lines.push('## Ship table, mode B (fit on the whole window, not used for the rows above)');
  lines.push('');
  lines.push('| cell | K | kMle | bound | level | n | games | pool n |');
  lines.push('| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |');
  for (const sport of SPORTS) {
    for (const fam of FAMILIES) {
      const key = `${sport}|${fam}`;
      const c = report.ship.B.cells[key];
      lines.push(`| ${key} | ${c.k} | ${c.kMle == null ? '' : c.kMle} | ${c.bound || ''} | ${c.level} | ${c.n} | ${c.nGames} | ${c.poolN} |`);
    }
  }
  lines.push('');
  lines.push('## Ship table, mode C');
  lines.push('');
  lines.push('| cell | type | a | b | level | n | games | knots |');
  lines.push('| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |');
  for (const sport of SPORTS) {
    for (const fam of FAMILIES) {
      const key = `${sport}|${fam}`;
      const c = report.ship.C.cells[key];
      lines.push(`| ${key} | ${c.type} | ${c.a == null ? '' : c.a} | ${c.b == null ? '' : c.b} | ${c.level} | ${c.n} | ${c.nGames} | ${c.knots == null ? '' : c.knots} |`);
    }
  }
  lines.push('');
  lines.push(`Production vs stored coverProb max abs ${report.productionCheck.maxAbs} on ${report.productionCheck.n} rows.`);
  lines.push('');
  lines.push('Replay volume (picks per day, zero-pick days) is not in this file. It comes from the replay harness with `OMEGA_CAL_MODE` set. The ship decision uses both.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const all = loadRows(DATA).filter(usable).filter((r) => r.date >= WINDOW_START && r.date <= WINDOW_END);
  const grids = new Map();
  let prodMax = 0;
  let prodN = 0;
  for (const row of all) {
    grids.set(row, lossGridFor(row));
    if (Number.isFinite(row.coverProb_current)) {
      const p = bandRetainClip(shrinkTowardSharp(row.p_model, row.fair_sharp_p, row.market, row.sport));
      const d = Math.abs(p - row.coverProb_current);
      if (d > prodMax) prodMax = d;
      prodN += 1;
    }
  }
  const dates = dateRange(WINDOW_START, WINDOW_END);
  const byDate = {};
  const scored = [];
  const dayReport = [];
  for (const date of dates) {
    const train = all.filter((r) => r.date < date);
    const B = fitShrinkTable(train, grids);
    const C = fitMapTable(train);
    const record = {
      trainedOn: 'dates < card date',
      trainedThrough: train.length ? train.reduce((m, r) => (r.date > m ? r.date : m), '') : null,
      nTrain: train.length,
      nTrainGames: new Set(train.map(gameIdOf)).size,
      B,
      C,
    };
    byDate[date] = record;
    const dayRows = all.filter((r) => r.date === date);
    const dayScored = [];
    for (const row of dayRows) {
      const prod = probabilityForMode('legacy', row.p_model, row.fair_sharp_p, row.market, row.sport, null);
      const a = probabilityForMode('A', row.p_model, row.fair_sharp_p, row.market, row.sport, null);
      const b = probabilityForMode('B', row.p_model, row.fair_sharp_p, row.market, row.sport, record);
      const c = probabilityForMode('C', row.p_model, row.fair_sharp_p, row.market, row.sport, record);
      const rec = {
        date,
        gameId: gameIdOf(row),
        y: row.y,
        market: scorePair(row.fair_sharp_p, row.y),
        production: scorePair(prod.p, row.y),
        A: scorePair(a.p, row.y),
        B: scorePair(b.p, row.y),
        C: scorePair(c.p, row.y),
        raw: scorePair(row.p_model, row.y),
      };
      dayScored.push(rec);
      scored.push(rec);
    }
    const logLoss = {};
    for (const m of METHODS) logLoss[m] = round6(mean(dayScored.map((r) => r[m].ll)));
    dayReport.push({
      date,
      n: dayScored.length,
      nTrain: train.length,
      logLoss,
      BLevels: countLevels(B),
      CLevels: countLevels(C),
    });
    console.log(`wf ${date} train=${train.length} eval=${dayScored.length} A=${logLoss.A} B=${logLoss.B} C=${logLoss.C} prod=${logLoss.production} mkt=${logLoss.market}`);
  }

  const shipTrain = all.slice();
  const ship = {
    trainedOn: 'all graded rows in the window, including the last day',
    trainedThrough: WINDOW_END,
    nTrain: shipTrain.length,
    nTrainGames: new Set(shipTrain.map(gameIdOf)).size,
    note: 'Live cards after the window use this record. Replay of a window date must use byDate for that date. Using ship on a window date would include that date.',
    B: fitShrinkTable(shipTrain, grids),
    C: fitMapTable(shipTrain),
  };

  const boot = bootstrap(scored, mulberry32(SEED));
  const scores = {};
  for (const m of METHODS) scores[m] = point(scored, m);

  const paramsDoc = {
    description: 'Walk-forward calibration records for OMEGA_CAL_MODE B and C. A and legacy do not read this file.',
    window: [WINDOW_START, WINDOW_END],
    kPolicy: {
      min: K_POLICY.min,
      max: K_POLICY.max,
      minIsProductConstraint: true,
      note: K_POLICY.note,
    },
    pool: {
      minRows: CAL_POOL.minRows,
      minGames: CAL_POOL.minGames,
      isoMinRows: CAL_POOL.isoMinRows,
      isoMinGames: CAL_POOL.isoMinGames,
      isoTrainMargin: CAL_POOL.isoTrainMargin,
    },
    bandClip: {
      name: BAND_CLIP.name,
      historicalName: BAND_CLIP.historicalName,
      fitted: false,
      lo: BAND_CLIP.lo,
      hi: BAND_CLIP.hi,
      keep: BAND_CLIP.keep,
      note: BAND_CLIP.note,
    },
    byDate,
    ship,
  };

  const report = {
    data: DATA,
    window: [WINDOW_START, WINDOW_END],
    n: scored.length,
    nGames: boot.nGames,
    scores,
    bootstrap: boot,
    byDate: dayReport,
    ship: { B: { cells: slimCells(ship.B, 'B') }, C: { cells: slimCells(ship.C, 'C') } },
    productionCheck: { n: prodN, maxAbs: round6(prodMax) },
    kPolicy: paramsDoc.kPolicy,
    pool: paramsDoc.pool,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PARAMS_FILE), { recursive: true });
  fs.writeFileSync(PARAMS_FILE, JSON.stringify(paramsDoc));
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD, markdown(report));
  console.log(`wrote ${PARAMS_FILE}`);
  console.log(`wrote ${REPORT_JSON}`);
  console.log(`production check n=${prodN} maxAbs=${prodMax}`);
  for (const m of ['A', 'B', 'C']) {
    const d = boot.diffs[`${m}MinusProductionLl`];
    console.log(`${m} - production ll ${d.mean} ci ${d.ci95.join(' .. ')} excludes0=${d.excludesZero} better=${d.pointBetter}`);
  }
}

main();
