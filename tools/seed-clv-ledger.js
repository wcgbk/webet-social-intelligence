'use strict';

/**
 * One-time seed for the CLV ledger. Local files only. No network.
 *
 * Alpha, 2026-06-20 through 2026-10-07: /workspace/clv-inv/day-alpha-*.json
 *   Those files are family averages (n, mean cents, beat %). One aggregate
 *   row per graded bet keeps that average and beat count.
 * Omega, 2026-09-05 onward: day-omega-*.json, replaced by an edge-picks-omega
 *   clv-* blob when a local copy has the same date. A day with no blob stays
 *   on the family average.
 *
 * Writes data/clv-ledger-seed.json and clv/report.json.
 *
 *   node tools/seed-clv-ledger.js
 *   CLV_INV_DIR=... CLV_BLOB_DIRS=/a:/b node tools/seed-clv-ledger.js
 */

const fs = require('fs');
const path = require('path');
const ledger = require('../netlify/functions/lib/clv-ledger');

const ROOT = path.join(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'data', 'clv-ledger-seed.json');
const REPORT_PATH = path.join(ROOT, 'clv', 'report.json');

const DEFAULT_INV = process.env.CLV_INV_DIR || '/workspace/clv-inv';
const DEFAULT_BLOB_DIRS = process.env.CLV_BLOB_DIRS
  ? process.env.CLV_BLOB_DIRS.split(path.delimiter).filter(Boolean)
  : [
    '/workspace/omega-clv-wf/inputs/blobs',
    '/workspace/omega-autopilot/run-1008/research/clv',
  ];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadDays(dir, book, from, to) {
  const map = new Map();
  if (!fs.existsSync(dir)) throw new Error(`CLV inventory missing: ${dir}`);
  for (const name of fs.readdirSync(dir)) {
    const match = new RegExp(`^day-${book}-(\\d{4}-\\d{2}-\\d{2})\\.json$`).exec(name);
    if (!match) continue;
    const date = match[1];
    if (date < from || (to && date > to)) continue;
    const doc = readJson(path.join(dir, name));
    if (!doc || doc.available === false || !doc.n) continue;
    map.set(date, doc);
  }
  return map;
}

function listClvFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    let date = null;
    const prefixed = /^clv-(\d{4}-\d{2}-\d{2})(?:\.json)?$/.exec(name);
    const bare = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (prefixed) date = prefixed[1];
    else if (bare) date = bare[1];
    if (!date) continue;
    out.push({ date, file: path.join(dir, name), dir });
  }
  return out;
}

function gradedCount(blob) {
  if (!blob || !Array.isArray(blob.picks)) return 0;
  return blob.picks.filter((pick) => ledger.clvPpOf(pick) != null).length;
}

function chooseBlobs(dirs) {
  const byDate = new Map();
  for (const dir of dirs) {
    for (const item of listClvFiles(dir)) {
      if (item.date < ledger.OMEGA_FROM) continue;
      const prev = byDate.get(item.date);
      if (!prev) {
        byDate.set(item.date, item);
        continue;
      }
      const prevN = gradedCount(readJson(prev.file));
      const nextN = gradedCount(readJson(item.file));
      if (nextN > prevN) byDate.set(item.date, item);
    }
  }
  return byDate;
}

function modelFor(date, blobDir, dirs) {
  const places = [];
  if (blobDir) places.push(blobDir);
  for (const dir of dirs) places.push(dir);
  const names = [`picks-${date}`, `picks-${date}.json`];
  for (const dir of places) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        const doc = readJson(file);
        if (doc && (doc.model || doc.modelVersion)) return doc.model || doc.modelVersion;
      } catch (_) { /* unreadable picks file is not a CLV row */ }
    }
  }
  return null;
}

function seedRows(invDir, blobDirs) {
  const alphaDays = loadDays(invDir, 'alpha', ledger.ALPHA_FROM, ledger.ALPHA_TO);
  const omegaDays = loadDays(invDir, 'omega', ledger.OMEGA_FROM, null);
  const blobs = chooseBlobs(blobDirs);
  const rows = [];
  let alphaExpected = 0;
  for (const [date, doc] of alphaDays) {
    alphaExpected += Number(doc.n) || 0;
    rows.push(...ledger.rowsFromDaySummary(doc, { source: 'alpha', date }));
  }
  let omegaExpected = 0;
  let omegaTickets = 0;
  let omegaAggregate = 0;
  const ticketDates = [];
  const aggregateDates = [];
  for (const [date, doc] of [...omegaDays.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    omegaExpected += Number(doc.n) || 0;
    const blob = blobs.get(date);
    if (blob) {
      const parsed = readJson(blob.file);
      const modelVersion = modelFor(date, blob.dir, blobDirs);
      const ticketRows = ledger.rowsFromClvBlob(parsed, { source: 'omega', date, modelVersion });
      if (ticketRows.length !== Number(doc.n)) {
        throw new Error(`omega ${date} blob n ${ticketRows.length} != day n ${doc.n} (${blob.file})`);
      }
      rows.push(...ticketRows);
      omegaTickets += ticketRows.length;
      ticketDates.push(date);
    } else {
      const agg = ledger.rowsFromDaySummary(doc, { source: 'omega', date });
      if (agg.length !== Number(doc.n)) {
        throw new Error(`omega ${date} family rows ${agg.length} != day n ${doc.n}`);
      }
      rows.push(...agg);
      omegaAggregate += agg.length;
      aggregateDates.push(date);
    }
  }
  const merged = ledger.mergeRows(rows);
  const alpha = merged.filter((row) => row.source === 'alpha').length;
  const omega = merged.filter((row) => row.source === 'omega').length;
  if (alpha !== alphaExpected) throw new Error(`alpha rows ${alpha} != inventory ${alphaExpected}`);
  if (omega !== omegaExpected) throw new Error(`omega rows ${omega} != inventory ${omegaExpected}`);
  return {
    rows: merged,
    counts: {
      alpha,
      omega,
      total: merged.length,
      omegaFromTickets: omegaTickets,
      omegaFromFamilyAverage: omegaAggregate,
      alphaFromFamilyAverage: alpha,
    },
    ticketDates,
    aggregateDates,
  };
}

function main() {
  const generatedAt = new Date().toISOString();
  const seeded = seedRows(DEFAULT_INV, DEFAULT_BLOB_DIRS);
  const asOf = seeded.rows.reduce((max, row) => (row.date > max ? row.date : max), '');
  const report = ledger.buildReport({
    rows: seeded.rows,
    asOf,
    generatedAt,
    source: 'seed',
  });
  const payload = {
    schema: 'clv-ledger-seed-v1',
    generatedAt,
    asOf,
    note: 'Alpha Jun 20–Oct 7 and Omega days without a clv blob are one row per graded bet at the stored family average (beat flags match the stored beat rate; price fields are blank). Omega days with an edge-picks-omega clv blob are the ticket rows. Dedupe drops a family-average day when a ticket for that source and date arrives.',
    counts: seeded.counts,
    omegaTicketDates: seeded.ticketDates,
    omegaFamilyAverageDates: seeded.aggregateDates,
    rows: seeded.rows,
  };
  fs.mkdirSync(path.dirname(SEED_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(SEED_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, SEED_PATH)} (${seeded.counts.total} rows)`);
  console.log(`wrote ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(ledger.formatTotalsTable(report));
}

if (require.main === module) main();

module.exports = { seedRows, SEED_PATH, REPORT_PATH };
