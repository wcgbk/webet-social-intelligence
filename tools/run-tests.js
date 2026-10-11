'use strict';

/**
 * Root test harness. Discovers test-*.js next to package.json and runs each
 * file in its own child process.
 *
 *   concurrency  max(2, floor(cpus / 2)), override with OMEGA_TEST_CONCURRENCY
 *   timeout      180s, override with OMEGA_TEST_TIMEOUT_MS
 *                or OMEGA_TEST_TIMEOUT (seconds, or milliseconds if it ends in ms)
 *
 * A TIMEOUT is retried once, after the parallel batch, with the same limit.
 * A passing retry is a pass. A second timeout or a non-zero exit is a failure.
 * The process exits non-zero when any test fails.
 *
 * Child environment:
 *   OMEGA_REPLAY_NO_WRITE=1
 *   ODDS_API_KEY, XAI_API_KEY, X_BEARER_TOKEN, TWITTER_BEARER_TOKEN, and
 *   Netlify token variables are removed so a test cannot call a paid API
 *   or write a blob with ambient credentials.
 *   tools/block-real-network.js is preloaded. It rejects real fetch unless
 *   the test sets OMEGA_TEST_ALLOW_NET=1. A test that replaces global.fetch
 *   keeps its mock. Remote attempts are reported below the summary.
 *
 * Optional args limit the run to those files:
 *   node tools/run-tests.js test-omega-golden-card.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(__dirname, 'block-real-network.js');

const STRIP_EXACT = [
  'ODDS_API_KEY',
  'XAI_API_KEY',
  'X_BEARER_TOKEN',
  'TWITTER_BEARER_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_TOKEN',
  'NETLIFY_API_TOKEN',
  'NETLIFY_ACCESS_TOKEN',
  'NETLIFY_PERSONAL_ACCESS_TOKEN',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_BLOBS_API_TOKEN',
  'NETLIFY_SITE_AUTH_TOKEN',
];

function positiveInt(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function concurrency() {
  const cpus = Math.max(1, (os.cpus() || []).length || 1);
  const fallback = Math.max(2, Math.floor(cpus / 2));
  return positiveInt(process.env.OMEGA_TEST_CONCURRENCY) || fallback;
}

function timeoutMs() {
  const fromMs = positiveInt(process.env.OMEGA_TEST_TIMEOUT_MS);
  if (fromMs) return fromMs;
  const raw = process.env.OMEGA_TEST_TIMEOUT;
  if (raw == null || String(raw).trim() === '') return 180000;
  const text = String(raw).trim();
  if (/ms$/i.test(text)) return positiveInt(text.replace(/ms$/i, '')) || 180000;
  const seconds = Number(text.replace(/s$/i, ''));
  if (!Number.isFinite(seconds) || seconds <= 0) return 180000;
  return Math.floor(seconds * 1000);
}

function childEnv() {
  const env = { ...process.env, OMEGA_REPLAY_NO_WRITE: '1' };
  for (const key of STRIP_EXACT) delete env[key];
  for (const key of Object.keys(env)) {
    if (/NETLIFY/i.test(key) && /TOKEN|SECRET|KEY/i.test(key)) delete env[key];
    if (/BLOBS/i.test(key) && /TOKEN|SECRET|KEY/i.test(key)) delete env[key];
  }
  const flag = `--require ${GUARD}`;
  const prev = env.NODE_OPTIONS || '';
  if (!prev.includes(GUARD)) env.NODE_OPTIONS = `${prev} ${flag}`.trim();
  return env;
}

function discover(only) {
  const all = fs.readdirSync(ROOT)
    .filter((name) => /^test-.*\.js$/.test(name))
    .sort();
  if (!only.length) return all;
  const want = new Set(only.map((name) => path.basename(name)));
  const found = all.filter((name) => want.has(name));
  const missing = [...want].filter((name) => !found.includes(name));
  if (missing.length) {
    console.error(`unknown test file: ${missing.join(', ')}`);
    process.exit(1);
  }
  return found;
}

function killTree(child) {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {
    try { child.kill('SIGTERM'); } catch (_2) { /* already gone */ }
  }
  const hard = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
  }, 1500);
  if (typeof hard.unref === 'function') hard.unref();
  child.once('close', () => clearTimeout(hard));
}

function cap(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

function netAttempts(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('OMEGA_NET_ATTEMPT ')) continue;
    rows.push(line.slice('OMEGA_NET_ATTEMPT '.length).trim());
  }
  return rows;
}

function runFile(file, limitMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    live.add(child);

    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(giveUp);
      live.delete(child);
      const ms = Date.now() - started;
      const output = `${stdout}\n${stderr}`;
      resolve({
        file,
        status,
        ms,
        code: extra && extra.code != null ? extra.code : null,
        signal: extra && extra.signal ? extra.signal : null,
        stdout,
        stderr,
        attempts: netAttempts(output),
        error: extra && extra.error ? extra.error : null,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limitMs);
    const giveUp = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish('timeout');
    }, limitMs + 8000);

    child.stdout.on('data', (buf) => { stdout = cap(stdout + buf, 400000); });
    child.stderr.on('data', (buf) => { stderr = cap(stderr + buf, 400000); });
    child.on('error', (err) => finish('fail', { error: err.message, code: 1 }));
    child.on('close', (code, signal) => {
      if (timedOut) finish('timeout', { code, signal });
      else if (code === 0) finish('pass', { code, signal });
      else finish('fail', { code, signal });
    });
  });
}

async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  const n = Math.max(1, Math.min(width, items.length || 1));
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function tail(text, lines) {
  const rows = String(text || '').trim().split(/\r?\n/);
  if (rows.length <= lines) return rows.join('\n');
  return rows.slice(rows.length - lines).join('\n');
}

const live = new Set();
function shutdown() {
  for (const child of live) killTree(child);
  process.exit(1);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  const only = process.argv.slice(2).filter((arg) => arg !== '--');
  const files = discover(only);
  const width = concurrency();
  const limit = timeoutMs();
  if (!files.length) {
    console.error('no test-*.js files in the repo root');
    process.exit(1);
  }

  console.log(`omega test harness: ${files.length} files, concurrency ${width}, timeout ${fmtMs(limit)}`);

  const results = await pool(files, width, async (file) => {
    const result = await runFile(file, limit);
    const tag = result.status === 'pass' ? 'PASS' : result.status === 'timeout' ? 'TIMEOUT' : 'FAIL';
    console.log(`${tag.padEnd(7)} ${fmtMs(result.ms).padStart(8)}  ${file}`);
    return result;
  });

  const timeouts = results.filter((row) => row.status === 'timeout');
  if (timeouts.length) {
    console.log(`\nretrying ${timeouts.length} timeout${timeouts.length === 1 ? '' : 's'} serially`);
    for (const row of timeouts) {
      const again = await runFile(row.file, limit);
      again.retried = true;
      again.firstTimeoutMs = row.ms;
      const tag = again.status === 'pass' ? 'PASS' : again.status === 'timeout' ? 'TIMEOUT' : 'FAIL';
      console.log(`${tag.padEnd(7)} ${fmtMs(again.ms).padStart(8)}  ${row.file}  (retry)`);
      const index = results.findIndex((item) => item.file === row.file);
      results[index] = again;
    }
  }

  const sorted = [...results].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  const passed = results.filter((row) => row.status === 'pass');
  const failed = results.filter((row) => row.status === 'fail');
  const stillTimeout = results.filter((row) => row.status === 'timeout');
  const retriedPass = passed.filter((row) => row.retried);

  console.log('\n── summary (duration descending) ──');
  for (const row of sorted) {
    const tag = row.status === 'pass' ? 'PASS' : row.status === 'timeout' ? 'TIMEOUT' : 'FAIL';
    const retry = row.retried ? '  retried' : '';
    console.log(`${tag.padEnd(7)} ${fmtMs(row.ms).padStart(8)}  ${row.file}${retry}`);
  }

  console.log(`\n${passed.length} passed, ${failed.length} failed, ${stillTimeout.length} timed out` +
    (retriedPass.length ? `, ${retriedPass.length} passed on timeout retry` : ''));

  const attempted = results.filter((row) => row.attempts && row.attempts.length);
  if (!attempted.length) {
    console.log('network attempts: none');
  } else {
    console.log('network attempts:');
    for (const row of attempted) {
      const counts = {};
      for (const attempt of row.attempts) {
        const kind = attempt.split(' ')[0] || 'unknown';
        counts[kind] = (counts[kind] || 0) + 1;
      }
      const bits = Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ');
      console.log(`  ${row.file}  ${bits}  (${row.status})`);
      const sample = [...new Set(row.attempts)].slice(0, 5);
      for (const line of sample) console.log(`    ${line}`);
    }
  }

  for (const row of sorted) {
    if (row.status === 'pass') continue;
    console.log(`\n── ${row.status.toUpperCase()} ${row.file}  exit=${row.code} signal=${row.signal || ''} ──`);
    if (row.error) console.log(row.error);
    const dumped = tail(`${row.stdout}\n${row.stderr}`, 120);
    if (dumped) console.log(dumped);
  }

  if (failed.length || stillTimeout.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
