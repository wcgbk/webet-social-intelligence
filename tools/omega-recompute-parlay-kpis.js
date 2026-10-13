'use strict';
/**
 * Recompute stored Omega parlay KPI rows from the card's own parlay stake.
 *
 *   node tools/omega-recompute-parlay-kpis.js <file-or-directory> [--write]
 *
 * Dry-run is the default. --write rewrites result rows only.
 * Input is a directory of JSON files, or one JSON document:
 *   { results|days, cards } or an array of result rows and cards.
 * Straight results already on the row are reused. Nothing is fetched.
 */
const fs = require('fs');
const path = require('path');
const { recomputeParlayFields } = require('../netlify/functions/get-results-omega')._test;

function isResultDay(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (row.parlayResult != null) return true;
  if (Array.isArray(row.picks) && row.picks.some((p) => p && p.sport === 'PARLAY')) return true;
  return row.wagered != null && row.wins != null && row.date && !row.parlayLegs;
}

function isCard(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !row.date) return false;
  if (isResultDay(row)) return false;
  return Array.isArray(row.picks) || Array.isArray(row.parlayLegs);
}

function parlayView(day) {
  const row = (day.picks || []).find((p) => p && p.sport === 'PARLAY') || null;
  return {
    date: day.date || null,
    parlayResult: day.parlayResult == null ? null : day.parlayResult,
    parlayProfit: day.parlayProfit == null ? null : day.parlayProfit,
    parlayRisk: day.parlayRisk == null ? null : day.parlayRisk,
    wagered: day.wagered == null ? null : day.wagered,
    profit: day.profit == null ? null : day.profit,
    units: row ? row.units : null,
    result: row ? row.result : null,
  };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collect(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const cards = [];
    const results = [];
    const files = new Map();
    for (const name of fs.readdirSync(target).filter((item) => item.endsWith('.json')).sort()) {
      const file = path.join(target, name);
      absorb(loadJson(file), file, cards, results, files);
    }
    return { cards, results, files, combined: null, combinedPath: null, daysKey: null };
  }
  const data = loadJson(target);
  if (data && typeof data === 'object' && !Array.isArray(data) && (Array.isArray(data.results) || Array.isArray(data.days))) {
    const daysKey = Array.isArray(data.results) ? 'results' : 'days';
    return {
      cards: Array.isArray(data.cards) ? data.cards.filter(isCard) : [],
      results: data[daysKey].filter(isResultDay),
      files: new Map(),
      combined: data,
      combinedPath: target,
      daysKey,
    };
  }
  const cards = [];
  const results = [];
  const files = new Map();
  absorb(data, target, cards, results, files);
  return { cards, results, files, combined: null, combinedPath: null, daysKey: null };
}

function absorb(data, file, cards, results, files) {
  if (Array.isArray(data)) {
    for (const item of data) absorb(item, file, cards, results, files);
    return;
  }
  if (isResultDay(data)) {
    results.push(data);
    if (data.date) files.set(data.date, file);
    return;
  }
  if (isCard(data)) cards.push(data);
}

function cardFor(cards, day) {
  return cards.find((card) => card && card.date === day.date) || null;
}

function changed(before, after) {
  return JSON.stringify(parlayView(before)) !== JSON.stringify(parlayView(after));
}

function printDiff(before, after) {
  const left = parlayView(before);
  const right = parlayView(after);
  console.log(`${before.date || '(no date)'}`);
  for (const key of Object.keys(left)) {
    if (key === 'date') continue;
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      console.log(`  ${key}: ${JSON.stringify(left[key])} -> ${JSON.stringify(right[key])}`);
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  const write = args.includes('--write');
  const target = args.find((arg) => arg !== '--write');
  if (!target) {
    console.error('usage: node tools/omega-recompute-parlay-kpis.js <file-or-directory> [--write]');
    process.exit(2);
  }
  const loaded = collect(path.resolve(target));
  const nextByDate = new Map();
  let n = 0;
  for (const day of loaded.results) {
    const card = cardFor(loaded.cards, day);
    const next = recomputeParlayFields(day, card);
    if (!changed(day, next)) continue;
    n += 1;
    printDiff(day, next);
    nextByDate.set(day.date, next);
  }
  if (!n) console.log('no parlay rows changed');
  else console.log(`${n} parlay row${n === 1 ? '' : 's'} changed${write ? '' : ' (dry-run)'}`);
  if (!write) return;
  if (loaded.combined) {
    loaded.combined[loaded.daysKey] = loaded.combined[loaded.daysKey].map((day) => (
      isResultDay(day) && nextByDate.has(day.date) ? nextByDate.get(day.date) : day
    ));
    fs.writeFileSync(loaded.combinedPath, JSON.stringify(loaded.combined, null, 2));
    return;
  }
  const byFile = new Map();
  for (const day of loaded.results) {
    const file = loaded.files.get(day.date);
    if (!file || !nextByDate.has(day.date)) continue;
    if (!byFile.has(file)) byFile.set(file, loadJson(file));
  }
  for (const [file, data] of byFile) {
    const replaced = Array.isArray(data)
      ? data.map((day) => (isResultDay(day) && nextByDate.has(day.date) ? nextByDate.get(day.date) : day))
      : (isResultDay(data) && nextByDate.has(data.date) ? nextByDate.get(data.date) : data);
    fs.writeFileSync(file, JSON.stringify(replaced, null, 2));
  }
}

if (require.main === module) main(process.argv);
module.exports = { main, parlayView };
