'use strict';

/**
 * Offline 30-day card replay.
 * Odds come from Supabase morning snapshots (3:00 / 10:00 ET) and are injected
 * as a stored line-move board. Days with neither snapshot are skipped.
 * Any request to the Odds API host fails the run.
 *
 *   node scripts/replay-predeploy-30d.js
 *   node scripts/replay-predeploy-30d.js --child <root> <board.json> <out.json>
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const START = '2026-09-15';
const END = '2026-10-14';
const SCHEMA = 'omega-pinnacle-line-moves-v1';

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

function redact(text) {
  return String(text || '')
    .replace(/apiKey=[^&\s'"]+/gi, 'apiKey=REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer REDACTED')
    .replace(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, 'REDACTED_JWT');
}

function dayList() {
  const out = [];
  let cursor = new Date(`${START}T00:00:00Z`);
  const end = new Date(`${END}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function bookKey(book) {
  const b = String(book || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (b === 'pinnacle') return 'pinnacle';
  if (b === 'draftkings') return 'draftkings';
  if (b.includes('hardrock')) return 'hardrockbet';
  return null;
}

function marketName(market) {
  const m = String(market || '').toLowerCase();
  if (m === 'h2h' || m === 'ml' || m.includes('moneyline')) return 'moneyline';
  if (m.includes('spread')) return 'spread';
  if (m.includes('total')) return 'total';
  return null;
}

function quoteFor(row, home, away) {
  const market = marketName(row.market);
  if (!market || row.price == null || !Number.isFinite(Number(row.price))) return null;
  const raw = String(row.side || '');
  const sl = raw.toLowerCase();
  let side;
  let team;
  if (market === 'total') {
    if (sl.startsWith('over')) { side = 'over'; team = 'Over'; }
    else if (sl.startsWith('under')) { side = 'under'; team = 'Under'; }
    else return null;
  } else if (sl === 'home' || norm(raw) === norm(home)) {
    side = 'home';
    team = home;
  } else if (sl === 'away' || norm(raw) === norm(away)) {
    side = 'away';
    team = away;
  } else if (raw) {
    side = sl;
    team = raw;
  } else return null;
  const quote = { market, price: Math.round(Number(row.price)), side, team };
  if (market !== 'moneyline' && row.point != null && row.point !== '') quote.line = Number(row.point);
  return quote;
}

function installOddsGuard() {
  const https = require('https');
  const http = require('http');
  const blocked = [];
  function hostOf(input) {
    try {
      if (typeof input === 'string') return new URL(input).hostname;
      if (input instanceof URL) return input.hostname;
      if (input && typeof input.href === 'string') return new URL(input.href).hostname;
      const host = input && (input.hostname || input.host);
      if (host) return String(host).split(':')[0];
    } catch (_) {}
    return '';
  }
  function hrefOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.href === 'string') return input.href;
    return '';
  }
  function check(input) {
    const host = hostOf(input).toLowerCase();
    const href = hrefOf(input).toLowerCase();
    const configured = process.env.ODDS_API_URL || process.env.ODDS_API_BASE || process.env.ODDS_API_HOST || '';
    let configuredHost = '';
    try { if (configured) configuredHost = new URL(configured).hostname.toLowerCase(); } catch (_) {}
    const hit = host === 'api.the-odds-api.com'
      || host.endsWith('.the-odds-api.com')
      || href.includes('the-odds-api.com')
      || (configuredHost && host === configuredHost);
    if (!hit) return;
    blocked.push(host || href);
    const err = new Error(`ODDS_API_BLOCKED ${host || href}`);
    err.code = 'ODDS_API_BLOCKED';
    throw err;
  }
  const origFetch = global.fetch;
  if (typeof origFetch === 'function') {
    global.fetch = function guardedFetch(url, opts) {
      check(url);
      return origFetch.apply(this, arguments);
    };
  }
  function wrap(mod, name) {
    const orig = mod[name];
    if (typeof orig !== 'function') return;
    mod[name] = function guarded(input) {
      check(input);
      if (input && typeof input === 'object') check(input.host || input.hostname || input.path || '');
      return orig.apply(this, arguments);
    };
  }
  wrap(https, 'request');
  wrap(https, 'get');
  wrap(http, 'request');
  wrap(http, 'get');
  return blocked;
}

function cardSig(data) {
  const picks = (data && data.picks) || [];
  const tickets = (data && data.parlayLegs) || [];
  let legs = tickets;
  let units = null;
  if (tickets.length === 1 && tickets[0] && Array.isArray(tickets[0].legs)) {
    legs = tickets[0].legs;
    units = tickets[0].units != null ? tickets[0].units : null;
  }
  const pickSig = picks.map((p) => ({
    sport: p.sport || null,
    matchup: p.matchup || null,
    pick: p.pick || p.side || null,
    market: p.betType || p.market || null,
    odds: p.odds != null ? p.odds : (p.price != null ? p.price : null),
    line: p.line != null ? p.line : (p.betLine != null ? p.betLine : null),
    units: p.units != null ? p.units : null,
    rating: p.rating || null,
    result: p.result != null ? p.result : null,
    profit: p.profit != null ? p.profit : null,
    grade: p.grade != null ? p.grade : null,
  }));
  const legSig = (legs || []).map((leg) => ({
    matchup: leg.matchup || null,
    pick: leg.pick || leg.side || null,
    odds: leg.odds != null ? leg.odds : null,
    line: leg.line != null ? leg.line : null,
    units: leg.units != null ? leg.units : null,
    result: leg.result != null ? leg.result : null,
  }));
  return {
    picks: pickSig.length,
    parlayLegs: legSig.length,
    parlayUnits: units,
    picksDetail: pickSig,
    parlayDetail: legSig,
  };
}

async function runChild(root, boardFile) {
  const outFile = `${boardFile}.out.json`;
  const childEnv = { ...process.env, OMEGA_REPLAY_NO_WRITE: '1', NODE_PATH: path.join(ROOT, 'node_modules') };
  delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
  delete childEnv.SUPABASE_SECRET_KEY;
  delete childEnv.SUPABASE_DB_PASSWORD;
  const child = spawn(process.execPath, [__filename, '--child', root, boardFile, outFile], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += buf.toString(); });
  child.stderr.on('data', (buf) => { stderr += buf.toString(); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 240000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timeout);
  let parsed = null;
  if (fs.existsSync(outFile)) {
    try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { parsed = null; }
  }
  return {
    code,
    stdout: redact(stdout).slice(-4000),
    stderr: redact(stderr).slice(-8000),
    parsed,
  };
}

async function childMain(root, boardFile, outFile) {
  const blocked = installOddsGuard();
  const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const { generateOmegaVnext, MODEL_VERSION } = require(path.join(root, 'netlify/functions/lib/omega-vnext/index.js'));
  const asOf = Date.parse(`${board.date}T14:00:00Z`);
  let data = null;
  let error = null;
  try {
    data = await generateOmegaVnext({
      date: board.date,
      dryRun: true,
      skipNarrate: true,
      replay: true,
      allowPaidOdds: false,
      force: true,
      pregameAsOfMs: asOf,
      lineMoveDoc: board.doc,
      readPinnacleLineMoves: async () => board.doc,
    });
  } catch (err) {
    error = redact(err && err.stack ? err.stack : err && err.message);
  }
  const sig = data ? cardSig(data) : null;
  const payload = {
    model: MODEL_VERSION,
    error,
    oddsBlocked: blocked.slice(),
    sig,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload));
  if (error || blocked.length) process.exit(2);
}

function schedulesOf(toml) {
  const map = {};
  let name = null;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\[functions\."([^"]+)"\]/);
    if (header) {
      name = header[1];
      continue;
    }
    if (!name || /^\s*#/.test(line)) continue;
    const sched = line.match(/^\s*schedule\s*=\s*"([^"]+)"/);
    if (sched) map[name] = sched[1];
  }
  return map;
}

function scheduleDiff(baseToml, headToml) {
  const base = schedulesOf(baseToml);
  const head = schedulesOf(headToml);
  const changed = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of keys) {
    if (base[key] !== head[key]) changed.push({ functionName: key, base: base[key] || null, head: head[key] || null });
  }
  changed.sort((a, b) => a.functionName.localeCompare(b.functionName));
  return changed;
}

async function main() {
  const pg = require('/tmp/pgmod/node_modules/pg');
  const fileEnv = loadEnv('/workspace/supabase/webet-db.env');
  const pw = fileEnv.SUPABASE_DB_PASSWORD;
  if (!pw) throw new Error('missing db password key');
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'postgres.' + (fileEnv.SUPABASE_REF || 'qvfgebrkolfyggfizgkx'),
    password: pw,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
    application_name: 'eng-audit-1014-replay',
  });
  await client.connect();
  const counts = await client.query(`
    SELECT (snapshot_ts AT TIME ZONE 'UTC')::date::text AS day,
      count(*) FILTER (
        WHERE line_type IN ('snapshot', 'opening')
          AND extract(hour FROM snapshot_ts AT TIME ZONE 'UTC') = 7
      )::int AS snap3,
      count(*) FILTER (
        WHERE lower(book) = 'pinnacle'
          AND line_type IN ('snapshot', 'opening')
          AND extract(hour FROM snapshot_ts AT TIME ZONE 'UTC') = 7
      )::int AS pin3,
      count(*) FILTER (
        WHERE line_type = 'snapshot'
          AND extract(hour FROM snapshot_ts AT TIME ZONE 'UTC') = 14
      )::int AS snap10,
      count(*) FILTER (
        WHERE lower(book) = 'pinnacle'
          AND line_type = 'snapshot'
          AND extract(hour FROM snapshot_ts AT TIME ZONE 'UTC') = 14
      )::int AS pin10
    FROM clv.odds_snapshots
    WHERE snapshot_ts >= '2026-09-15T00:00:00Z'
      AND snapshot_ts < '2026-10-15T00:00:00Z'
      AND lower(book) IN ('pinnacle', 'draftkings', 'hardrockbet')
    GROUP BY 1
    ORDER BY 1
  `);
  const byDay = new Map(counts.rows.map((row) => [row.day, row]));
  const days = dayList();
  const skipped = [];
  const replayDays = [];
  for (const day of days) {
    const row = byDay.get(day) || { snap3: 0, pin3: 0, snap10: 0, pin10: 0 };
    const has3 = Number(row.snap3) > 0;
    const has10 = Number(row.snap10) > 0;
    if (!has3 && !has10) skipped.push(day);
    else replayDays.push({ day, snap3: Number(row.snap3), pin3: Number(row.pin3), snap10: Number(row.snap10), pin10: Number(row.pin10) });
  }
  console.log(`days=${days.length} replay=${replayDays.map((d) => d.day).join(',') || 'none'} skipped=${skipped.length}`);

  const baseRoot = process.env.REPLAY_BASE_ROOT || '/tmp/webet-e84d5aa';
  const results = [];
  for (const item of replayDays) {
    const start = `${item.day}T07:00:00Z`;
    const ten = `${item.day}T14:00:00Z`;
    const rows = (await client.query(`
      SELECT s.id, s.game_id, s.sport, s.book, s.market, s.side, s.point, s.price, s.line_type, s.snapshot_ts,
             g.home_team, g.away_team, g.commence_time
      FROM clv.odds_snapshots s
      JOIN clv.games g ON g.game_id = s.game_id
      WHERE lower(s.book) IN ('pinnacle', 'draftkings', 'hardrockbet')
        AND (
          (s.snapshot_ts >= $1::timestamptz AND s.snapshot_ts < $1::timestamptz + interval '1 hour'
            AND s.line_type IN ('snapshot', 'opening'))
          OR
          (s.snapshot_ts >= $2::timestamptz AND s.snapshot_ts < $2::timestamptz + interval '1 hour'
            AND s.line_type = 'snapshot')
        )
    `, [start, ten])).rows;
    const events = new Map();
    const conflicts = [];
    for (const row of rows) {
      const book = bookKey(row.book);
      if (!book || !row.home_team || !row.away_team) continue;
      const slot = new Date(row.snapshot_ts).getTime() >= Date.parse(ten) ? '1000' : '0300';
      const quote = quoteFor(row, row.home_team, row.away_team);
      if (!quote) continue;
      if (!events.has(row.game_id)) {
        events.set(row.game_id, {
          schema: SCHEMA,
          sport: row.sport,
          eventId: row.game_id,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          commenceTime: row.commence_time ? new Date(row.commence_time).toISOString() : null,
          date: item.day,
          checks: [],
          _slots: {},
        });
      }
      const event = events.get(row.game_id);
      if (!event._slots[slot]) {
        event._slots[slot] = { slot, at: new Date(row.snapshot_ts).toISOString(), books: {} };
      }
      const check = event._slots[slot];
      if (!check.books[book]) check.books[book] = {};
      const qkey = `${quote.market}|${quote.side}|${quote.line == null ? '' : quote.line}`;
      const prev = check.books[book][qkey];
      if (prev && prev.price !== quote.price) conflicts.push(row.game_id);
      if (!prev || new Date(row.snapshot_ts) >= new Date(check.at)) {
        check.books[book][qkey] = quote;
        check.at = new Date(row.snapshot_ts).toISOString();
      }
    }
    const eventDocs = [...events.values()].map((event) => {
      const checks = ['0300', '1000'].filter((slot) => event._slots[slot]).map((slot) => event._slots[slot]);
      return {
        schema: event.schema,
        sport: event.sport,
        eventId: event.eventId,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        commenceTime: event.commenceTime,
        date: event.date,
        checks,
      };
    }).filter((event) => event.checks.some((check) => check.slot === '1000'));
    const doc = { schema: SCHEMA, date: item.day, events: eventDocs };
    const boardFile = `/tmp/replay-board-${item.day}.json`;
    fs.writeFileSync(boardFile, JSON.stringify({ date: item.day, doc }));
    console.log(`board ${item.day} events=${eventDocs.length} rows=${rows.length} conflicts=${conflicts.length}`);
    const head = await runChild(ROOT, boardFile);
    console.log(`head ${item.day} code=${head.code} picks=${head.parsed && head.parsed.sig && head.parsed.sig.picks}`);
    const base = await runChild(baseRoot, boardFile);
    console.log(`base ${item.day} code=${base.code} picks=${base.parsed && base.parsed.sig && base.parsed.sig.picks}`);
    results.push({
      day: item.day,
      windows: item,
      events: eventDocs.length,
      rows: rows.length,
      priceConflicts: conflicts.length,
      head: { code: head.code, parsed: head.parsed, stderrTail: head.stderr },
      base: { code: base.code, parsed: base.parsed, stderrTail: base.stderr },
    });
  }
  await client.end();

  const baseToml = fs.readFileSync(path.join(baseRoot, 'netlify.toml'), 'utf8');
  const headToml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const schedDiff = scheduleDiff(baseToml, headToml);
  const scheduleOk = schedDiff.length === 1
    && schedDiff[0].functionName === 'monitor-omega-snapshot-coverage'
    && schedDiff[0].base == null
    && schedDiff[0].head === '20 14,15 * * *';

  const dayReports = results.map((row) => {
    const headSig = row.head.parsed && row.head.parsed.sig;
    const baseSig = row.base.parsed && row.base.parsed.sig;
    const identical = JSON.stringify(headSig) === JSON.stringify(baseSig);
    const oddsBlocked = ((row.head.parsed && row.head.parsed.oddsBlocked) || []).concat((row.base.parsed && row.base.parsed.oddsBlocked) || []);
    const headErr = (row.head.parsed && row.head.parsed.error) || (row.head.code !== 0 ? `exit ${row.head.code}` : null);
    const baseErr = (row.base.parsed && row.base.parsed.error) || (row.base.code !== 0 ? `exit ${row.base.code}` : null);
    const shapeOk = !!(headSig && headSig.picks === 3 && headSig.parlayLegs === 3);
    return {
      day: row.day,
      events: row.events,
      shapeOk,
      identical,
      oddsBlocked,
      headErr,
      baseErr,
      head: headSig,
      base: baseSig,
      pass: shapeOk && identical && oddsBlocked.length === 0 && !headErr && !baseErr,
    };
  });
  const pass = skipped.length + replayDays.length === days.length
    && skipped.includes('2026-10-10')
    && dayReports.length > 0
    && dayReports.every((row) => row.pass)
    && scheduleOk;
  const proof = {
    window: { start: START, end: END, days: days.length },
    replayed: dayReports.map((row) => row.day),
    skipped,
    scheduleDiff: schedDiff,
    scheduleOk,
    days: dayReports,
    pass,
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/replay-30d-20261014.json'), JSON.stringify(proof, null, 2));
  const lines = [
    '# 30-day pre-deploy replay',
    '',
    `Window ${START} through ${END} (${days.length} days). Odds source is Supabase snapshots in the 3:00 ET (07:00Z) and 10:00 ET (14:00Z, line_type snapshot) windows. No Odds API request is allowed.`,
    '',
    `Replayed: ${proof.replayed.join(', ') || '(none)'}.`,
    '',
    `Skipped (${skipped.length}): ${skipped.join(', ')}.`,
    '',
    `Schedule diff: ${scheduleOk ? 'only monitor-omega-snapshot-coverage 20 14,15 * * *' : JSON.stringify(schedDiff)}.`,
    '',
    `Pass: ${pass}.`,
    '',
  ];
  for (const row of dayReports) {
    lines.push(`## ${row.day}`);
    lines.push('');
    lines.push(`Events on the 10:00 board: ${row.events}. Shape ok: ${row.shapeOk}. Identical refs: ${row.identical}. Odds blocked: ${row.oddsBlocked.length}. Pass: ${row.pass}.`);
    if (row.headErr) lines.push(`Head error: ${row.headErr.split('\n')[0]}`);
    if (row.baseErr) lines.push(`Base error: ${row.baseErr.split('\n')[0]}`);
    if (row.head) lines.push(`Head picks ${row.head.picks}, parlay legs ${row.head.parlayLegs}, parlay units ${row.head.parlayUnits}.`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({ head: row.head, base: row.base }, null, 2));
    lines.push('```');
    lines.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'docs/REPLAY-30D-20261014.md'), lines.join('\n'));
  console.log(`REPLAY ${pass ? 'PASS' : 'FAIL'} replayed=${proof.replayed.length} skipped=${skipped.length}`);
  if (!pass) process.exit(1);
}

if (process.argv[2] === '--child') {
  childMain(process.argv[3], process.argv[4], process.argv[5]).catch((err) => {
    const outFile = process.argv[5];
    const payload = { error: redact(err && err.stack ? err.stack : err.message), oddsBlocked: [], sig: null };
    try { fs.writeFileSync(outFile, JSON.stringify(payload)); } catch (_) {}
    console.error(payload.error);
    process.exit(2);
  });
} else {
  main().catch((err) => {
    console.error(redact(err && err.stack ? err.stack : err.message));
    process.exit(1);
  });
}
