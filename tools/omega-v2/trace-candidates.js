#!/usr/bin/env node
'use strict';

/**
 * Print the best 3 sides per sport from a dry-run card.
 * Does not call The Odds API. Does not read a Netlify config file.
 * Does not print the token.
 *
 *   node tools/omega-v2/trace-candidates.js --json /tmp/dryrun.json
 *   NETLIFY_AUTH_TOKEN=... node tools/omega-v2/trace-candidates.js --date 2026-11-24
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return null;
}

function tracesFrom(doc) {
  const found = [];
  const push = (card) => {
    if (card && card.debugTrace) found.push({ card, trace: card.debugTrace });
  };
  if (!doc || typeof doc !== 'object') return found;
  if (doc.debugTrace) found.push({ card: doc, trace: doc.debugTrace });
  push(doc.card);
  if (Array.isArray(doc.days)) {
    for (const day of doc.days) {
      if (!day || typeof day !== 'object') continue;
      if (day.v2) push(day.v2.card);
      push(day.card);
    }
  }
  return found;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function money(v) {
  const n = num(v);
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}pp`;
}

function printSide(row) {
  const proj = row.projection
    ? `${row.projection.kind} ${row.projection.value}${row.projection.method ? ` (${row.projection.method})` : ''}`
    : 'none';
  const conv = row.discounts && row.discounts.lineConversion;
  const convText = conv
    ? `${conv.fromPoint} -> ${conv.toPoint} sigma ${conv.sigma == null ? 'none' : conv.sigma} dist ${conv.distance}`
    : 'none';
  const d = row.discounts || {};
  console.log(`  ${row.finalRank == null ? '—' : `#${row.finalRank}`}${row.selected ? ' SELECTED' : ''}  ${row.sport}  ${row.pick}  ${row.odds}  ${row.book || ''}`);
  console.log(`    matchup: ${row.matchup || '—'}`);
  console.log(`    projection: ${proj}`);
  console.log(`    p_model: ${pct(row.p_model)}   p_pin: ${pct(row.p_pin)} (${row.p_pin_method || '—'})   w: ${row.w == null ? '—' : row.w}`);
  console.log(`    p_final: ${pct(row.p_final)}   implied: ${pct(row.implied)}   edge: ${money(row.edge)}   EV: ${money(row.ev)}   EV_rank: ${money(row.evRank)}`);
  console.log(`    discounts: longshotTrim=${!!d.longshotTrim} pFloor=${!!d.pFloor} priceBand=${d.priceBand || 'none'} favCap=${!!d.favCap} movedAgainst=${!!d.movedAgainst} modellessHaircut=${d.modellessHaircut == null ? 0 : d.modellessHaircut} pushQ=${d.pushQ || 0}`);
  console.log(`    lineConversion: ${convText}`);
  if (row.rejectReason) console.log(`    reject: ${row.rejectReason}`);
}

function printTrace(trace) {
  console.log(trace.note || '');
  console.log(`formula: ${trace.formula ? 'on' : 'off'}  modellessHaircut: ${trace.modellessHaircut}`);
  const drops = trace.drops || {};
  const dropText = Object.keys(drops).sort().map((key) => `${key}=${drops[key]}`).join('  ') || 'none';
  console.log(`drops: ${dropText}`);
  const bySport = trace.bestBySport || {};
  const sports = Object.keys(bySport).sort();
  if (!sports.length) {
    console.log('no qualified sides');
    return;
  }
  for (const sport of sports) {
    console.log(`\n${sport}`);
    for (const row of bySport[sport]) printSide(row);
  }
}

function printDoc(doc) {
  const traces = tracesFrom(doc);
  if (!traces.length) {
    console.error('No debugTrace on this JSON. Re-run the dry run with the current builder.');
    process.exit(1);
  }
  traces.forEach((item, i) => {
    if (traces.length > 1) console.log(`\n===== card ${i + 1} =====`);
    printTrace(item.trace);
  });
}

function main() {
  const jsonPath = argValue('--json');
  if (jsonPath) {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    printDoc(JSON.parse(raw));
    return;
  }
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    console.error('NETLIFY_AUTH_TOKEN is not set. Pass --json <dryrun.json>, or export the token in the environment. This tool does not read config files.');
    process.exit(1);
  }
  const date = argValue('--date');
  const out = path.join('/tmp', 'omega-trace-dryrun.json');
  const args = [path.join(__dirname, 'dryrun-card.js'), '--out', out];
  if (date) args.push('--date', date);
  const child = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (child.status !== 0) process.exit(child.status == null ? 1 : child.status);
  printDoc(JSON.parse(fs.readFileSync(out, 'utf8')));
}

main();
