'use strict';
/**
 * Fit prior-decay speed. priorW(gp) = K/(K+gp).
 *
 * For each sport and each K, rerun the replay window with
 * OMEGA_<SPORT>_PRIOR_K set on the child. Other sports stay at the
 * config default. One prepared tree serves every K because the override
 * is read at call time.
 *
 *   node tools/fit-decay.js [--dates a,b] [--concurrency 3] [--force]
 *                           [--sports NFL,NCAAF,NHL] [--src dir]
 *
 * Records all-candidate model log-loss vs the Pinnacle close
 * (calib sets.all.bySport[SPORT].ALL.modelLogLoss). A K is eligible only
 * when 2026-10-04 and 2026-10-10 each have 3 straights and a 3-leg parlay
 * and no date in the run wrote an error. The lowest eligible log-loss
 * wins. A tie within 1e-6 keeps the smaller K.
 *
 * Writes /tmp/fit-decay-report.json. Does not edit config, deploy, or push.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WORKTREE = '/workspace/wt-decay';
const REPLAY = '/workspace/omega-replay-2w';
const GRID = [0.5, 1, 2, 3, 4, 6, 8, 12];
const SPORTS = ['NFL', 'NCAAF', 'NHL'];
const CARD_DATES = ['2026-10-04', '2026-10-10'];
const DEFAULT_DATES = [
  '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
];
const REPORT = '/tmp/fit-decay-report.json';
const LL_TIE = 1e-6;

function parseArgs(argv) {
  const out = {
    dates: DEFAULT_DATES.slice(),
    concurrency: 3,
    force: false,
    sports: SPORTS.slice(),
    src: path.join(REPLAY, 'src', 'decay-1011'),
    skipPrepare: false,
    noJoint: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dates') {
      out.dates = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--force') out.force = true;
    else if (a === '--sports') {
      out.sports = String(argv[++i] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a === '--src') out.src = argv[++i];
    else if (a === '--skip-prepare') out.skipPrepare = true;
    else if (a === '--no-joint') out.noJoint = true;
    else {
      console.error('unknown arg ' + a);
      process.exit(2);
    }
  }
  return out;
}

function labelFor(sport, k) {
  return `decay-${sport}-k${k}`;
}

function outDir(label) {
  return path.join(REPLAY, 'out', label);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function dateFilesReady(label, dates) {
  return dates.every((date) => fs.existsSync(path.join(outDir(label), `${date}.json`)));
}

function runProc(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, {
      env,
      cwd: REPLAY,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('exit', (code) => {
      log.end();
      resolve({ code: code == null ? 1 : code, sec: (Date.now() - started) / 1000 });
    });
  });
}

function baseEnv(extra) {
  const env = { ...process.env };
  for (const sport of SPORTS) delete env[`OMEGA_${sport}_PRIOR_K`];
  delete env.OMEGA_NHL_SHRINK_K;
  delete env.ODDS_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  env.OMEGA_REPLAY_REPO = WORKTREE;
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function prepareSrc(src) {
  if (fs.existsSync(src)) fs.rmSync(src, { recursive: true, force: true });
  const res = spawnSync('sh', ['prepare-src.sh', 'WORKTREE', src], {
    cwd: REPLAY,
    env: baseEnv(),
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error('PREPARE_FAIL');
    process.exit(1);
  }
}

async function runWindow(label, dates, envExtra, force) {
  const dir = outDir(label);
  const logFile = path.join(REPLAY, `out-${label}.log`);
  if (force && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  if (!force && dateFilesReady(label, dates)) {
    console.log(`RUN_SKIP ${label}`);
    return { code: 0, sec: 0, skipped: true };
  }
  fs.mkdirSync(REPLAY, { recursive: true });
  console.log(`RUN_START ${label}`);
  const result = await runProc(process.execPath, [
    path.join(REPLAY, 'run-window.js'),
    '--src', process.env.FIT_DECAY_SRC,
    '--label', label,
    '--dates', dates.join(','),
  ], baseEnv(envExtra), logFile);
  console.log(`RUN_DONE ${label} exit=${result.code} sec=${result.sec.toFixed(1)}`);
  return result;
}

async function runMetrics(label, dates) {
  const from = dates.slice().sort()[0];
  const to = dates.slice().sort().slice(-1)[0];
  const logFile = path.join(REPLAY, `out-${label}-metrics.log`);
  const result = await runProc(process.execPath, [
    path.join(REPLAY, 'calib', 'metrics.js'),
    label,
    '--from', from,
    '--to', to,
  ], baseEnv(), logFile);
  return result;
}

function cardStatus(label, dates) {
  const problems = [];
  for (const date of dates) {
    const file = path.join(outDir(label), `${date}.json`);
    if (!fs.existsSync(file)) {
      problems.push(`${date} missing`);
      continue;
    }
    let doc = null;
    try { doc = readJson(file); } catch (e) {
      problems.push(`${date} unreadable`);
      continue;
    }
    if (!doc || doc.error) problems.push(`${date} error`);
  }
  const cards = {};
  for (const date of CARD_DATES) {
    const file = path.join(outDir(label), `${date}.json`);
    if (!fs.existsSync(file)) {
      cards[date] = { ok: false, why: 'missing' };
      continue;
    }
    let doc = null;
    try { doc = readJson(file); } catch (_) { doc = null; }
    if (!doc || doc.error) {
      cards[date] = { ok: false, why: 'error' };
      continue;
    }
    const picks = Array.isArray(doc.picks) ? doc.picks.length : 0;
    const legs = doc.parlay && doc.parlay[0] && Array.isArray(doc.parlay[0].legs)
      ? doc.parlay[0].legs.length
      : 0;
    const ok = picks === 3 && legs === 3;
    cards[date] = {
      ok,
      picks,
      legs,
      why: ok ? '3+3' : `picks=${picks} legs=${legs}`,
    };
  }
  const cardsOk = CARD_DATES.every((date) => cards[date] && cards[date].ok);
  return {
    ok: cardsOk && problems.length === 0,
    cardsOk,
    problems,
    cards,
  };
}

function metricOf(label, sport) {
  const file = path.join(outDir(label), 'calib.json');
  if (!fs.existsSync(file)) return null;
  let report = null;
  try { report = readJson(file); } catch (_) { return null; }
  const cell = report
    && report.sets
    && report.sets.all
    && report.sets.all.bySport
    && report.sets.all.bySport[sport]
    && report.sets.all.bySport[sport].ALL;
  if (!cell || !Number.isFinite(Number(cell.modelLogLoss))) return { raw: cell || null };
  return {
    n: cell.n,
    nOutcome: cell.nOutcome,
    modelLogLoss: Number(cell.modelLogLoss),
    closeLogLoss: Number.isFinite(Number(cell.closeLogLoss)) ? Number(cell.closeLogLoss) : null,
    meanKl: Number.isFinite(Number(cell.meanKl)) ? Number(cell.meanKl) : null,
    meanCrossEntropy: Number.isFinite(Number(cell.meanCrossEntropy)) ? Number(cell.meanCrossEntropy) : null,
    badDays: report.badDays || 0,
  };
}

function choose(rows) {
  const eligible = rows.filter((row) => row.eligible && Number.isFinite(row.modelLogLoss));
  eligible.sort((a, b) => {
    const d = a.modelLogLoss - b.modelLogLoss;
    if (Math.abs(d) < LL_TIE) return a.k - b.k;
    return d;
  });
  return eligible;
}

async function pool(jobs, n, worker) {
  const ret = new Array(jobs.length);
  let cursor = 0;
  async function loop() {
    while (cursor < jobs.length) {
      const idx = cursor;
      cursor += 1;
      ret[idx] = await worker(jobs[idx]);
    }
  }
  const width = Math.min(n, jobs.length);
  await Promise.all(Array.from({ length: width }, () => loop()));
  return ret;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const date of CARD_DATES) {
    if (!args.dates.includes(date)) {
      console.error(`dates must include ${date}`);
      process.exit(2);
    }
  }
  if (!args.skipPrepare) prepareSrc(args.src);
  if (!fs.existsSync(path.join(args.src, 'netlify/functions/lib/omega-vnext/index.js'))) {
    console.error('prepared src missing ' + args.src);
    process.exit(1);
  }
  process.env.FIT_DECAY_SRC = args.src;

  const jobs = [];
  for (const sport of args.sports) {
    for (const k of GRID) {
      jobs.push({
        sport,
        k,
        label: labelFor(sport, k),
        env: { [`OMEGA_${sport}_PRIOR_K`]: k },
      });
    }
  }

  await pool(jobs, args.concurrency, async (job) => {
    await runWindow(job.label, args.dates, job.env, args.force);
    await runMetrics(job.label, args.dates);
    return job;
  });

  const rows = jobs.map((job) => {
    const gate = cardStatus(job.label, args.dates);
    const metric = metricOf(job.label, job.sport) || {};
    const ll = Number.isFinite(metric.modelLogLoss) ? metric.modelLogLoss : null;
    const eligible = gate.ok && ll != null && !(metric.badDays > 0);
    return {
      sport: job.sport,
      k: job.k,
      label: job.label,
      modelLogLoss: ll,
      closeLogLoss: metric.closeLogLoss == null ? null : metric.closeLogLoss,
      n: metric.n == null ? null : metric.n,
      nOutcome: metric.nOutcome == null ? null : metric.nOutcome,
      meanKl: metric.meanKl == null ? null : metric.meanKl,
      meanCrossEntropy: metric.meanCrossEntropy == null ? null : metric.meanCrossEntropy,
      badDays: metric.badDays || 0,
      cardsOk: gate.cardsOk,
      eligible,
      problems: gate.problems,
      cards: gate.cards,
    };
  });

  const choice = {};
  const ranked = {};
  for (const sport of args.sports) {
    const ordered = choose(rows.filter((row) => row.sport === sport));
    ranked[sport] = ordered.map((row) => ({ k: row.k, modelLogLoss: row.modelLogLoss }));
    choice[sport] = ordered[0]
      ? { k: ordered[0].k, modelLogLoss: ordered[0].modelLogLoss, label: ordered[0].label }
      : null;
  }

  let joint = null;
  if (!args.noJoint) {
    const env = {};
    for (const sport of args.sports) {
      if (choice[sport]) env[`OMEGA_${sport}_PRIOR_K`] = choice[sport].k;
    }
    const attempts = [{ name: 'decay-joint', env, note: 'best eligible' }];
    if (Object.keys(env).length) {
      const sportsByCost = args.sports.slice().sort((a, b) => {
        const ra = ranked[a] || [];
        const rb = ranked[b] || [];
        const costA = ra[1] && ra[0] ? ra[1].modelLogLoss - ra[0].modelLogLoss : 1;
        const costB = rb[1] && rb[0] ? rb[1].modelLogLoss - rb[0].modelLogLoss : 1;
        return costA - costB;
      });
      for (const sport of sportsByCost) {
        const next = (ranked[sport] || [])[1];
        if (!next || !choice[sport]) continue;
        attempts.push({
          name: `decay-joint-${sport}-k${next.k}`,
          env: { ...env, [`OMEGA_${sport}_PRIOR_K`]: next.k },
          note: `${sport} next ${next.k}`,
        });
      }
      for (const sport of args.sports) {
        if (!choice[sport]) continue;
        const dropped = { ...env };
        delete dropped[`OMEGA_${sport}_PRIOR_K`];
        attempts.push({
          name: `decay-joint-drop-${sport}`,
          env: dropped,
          note: `drop ${sport} to default`,
        });
      }
    }
    for (const attempt of attempts) {
      await runWindow(attempt.name, args.dates, attempt.env, args.force);
      const gate = cardStatus(attempt.name, args.dates);
      joint = { ...attempt, ...gate, env: attempt.env };
      console.log(`JOINT ${attempt.name} cards=${gate.cardsOk} runOk=${gate.ok} ${attempt.note}`);
      if (gate.ok) break;
    }
  }

  const report = {
    dates: args.dates,
    grid: GRID,
    sports: args.sports,
    src: args.src,
    worktree: WORKTREE,
    rows,
    ranked,
    choice,
    joint,
    mlb: 'unchanged: no Pinnacle closes in the replay window, and no games-played prior',
    mappedCurrent: {
      NFL: 'infinity (preseason deviation weight 1)',
      NCAAF: 'strength 2, pace variance about 14',
      NHL: 34,
    },
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('sport K eligible mLL n KL CE cards');
  for (const row of rows) {
    const ll = row.modelLogLoss == null ? '—' : row.modelLogLoss.toFixed(4);
    const kl = row.meanKl == null ? '—' : row.meanKl.toFixed(4);
    const ce = row.meanCrossEntropy == null ? '—' : row.meanCrossEntropy.toFixed(4);
    console.log(
      `${row.sport} ${String(row.k).padStart(4)} ${row.eligible ? 'yes' : 'no '} ${ll} n=${row.nOutcome == null ? '—' : row.nOutcome} KL=${kl} CE=${ce} cards=${row.cardsOk ? '3+3' : 'fail'}`,
    );
  }
  for (const sport of args.sports) {
    const picked = choice[sport];
    console.log(picked
      ? `CHOICE ${sport} K=${picked.k} mLL=${picked.modelLogLoss.toFixed(4)}`
      : `CHOICE ${sport} none (keep current)`);
  }
  if (joint) console.log(`JOINT_PICK ${joint.name} ok=${joint.ok} ${joint.note}`);
  console.log('WROTE ' + REPORT);
  console.log('SWEEP_DONE');
}

main().catch((e) => {
  console.error('SWEEP_FAIL ' + (e && e.stack || e));
  process.exit(1);
});
