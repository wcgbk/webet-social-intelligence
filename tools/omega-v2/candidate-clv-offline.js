'use strict';

/**
 * Offline close report for stored cards. Reads local files only.
 * Does not write blobs and does not call a remote odds host.
 *
 *   node tools/omega-v2/candidate-clv-offline.js 2026-11-01 2026-11-02 2026-11-03
 */

const fs = require('fs');
const path = require('path');
const clv = require('../../netlify/functions/lib/omega-v2/candidate_clv');

const DATES = ['2026-11-01', '2026-11-02', '2026-11-03'];

function rootsFromArgs(argv) {
  const roots = [];
  if (process.env.CANDIDATE_CLV_ROOT) roots.push(process.env.CANDIDATE_CLV_ROOT);
  for (const arg of argv) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) continue;
    roots.push(arg);
  }
  roots.push(
    '/workspace/stakeaudit',
    '/workspace/netlify-export',
    '/workspace/supabase-netlify/stage',
    '/workspace/odds-backfill',
    path.join(__dirname, '../../test/fixtures'),
  );
  return [...new Set(roots)];
}

function walk(dir, acc, depth) {
  if (depth > 5 || acc.length > 20000) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc, depth + 1);
    else if (entry.isFile()) acc.push(full);
  }
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function looksLikeBoard(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.games1000 || doc.games0300 || doc.games) return true;
  if (Array.isArray(doc.polls)) return true;
  if (Array.isArray(doc.candidates) && doc.candidates.length && (doc.candidates[0].homeTeam || doc.candidates[0].matchup)) {
    return false;
  }
  return false;
}

function snapshotsFromFile(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (doc.games0300 || doc.games1000 || doc.at0300 || doc.at1000) {
    return clv.snapshotsFromMaster(doc);
  }
  if (Array.isArray(doc.polls)) return clv.snapshotsFromPolls(doc.polls);
  if (doc.games && (doc.hhmm || doc.slot || doc.capturedAt)) return clv.snapshotsFromPolls([doc]);
  return [];
}

function cardCandidates(doc) {
  const rows = clv.candidatesFromCard(doc);
  return rows.length ? rows : (Array.isArray(doc.candidates) ? doc.candidates : []);
}

function morningCount(doc) {
  const meta = doc && doc.pipelineV2 && doc.pipelineV2.morningBoard;
  return meta && Number.isFinite(Number(meta.count)) ? Number(meta.count) : null;
}

function reportDate(date, files) {
  const named = files.filter((file) => file.includes(date));
  let morning = null;
  let morningFile = null;
  let card = null;
  let cardFile = null;
  const snapshots = [];
  const snapshotFiles = [];
  for (const file of named) {
    const base = path.basename(file);
    const doc = readJson(file);
    if (!doc) continue;
    const isMorning = base.includes('morning-board') || (doc && Array.isArray(doc.candidates) && doc.count != null && base.includes(date));
    if (isMorning && Array.isArray(doc.candidates) && doc.candidates.length) {
      if (!morning || doc.candidates.length > morning.length) {
        morning = doc.candidates;
        morningFile = file;
      }
      continue;
    }
    const snaps = snapshotsFromFile(doc);
    if (snaps.length) {
      snapshots.push(...snaps);
      snapshotFiles.push(path.basename(file));
      continue;
    }
    const isCard = base === `card-${date}.json` || base === `picks-${date}` || base === `picks-${date}.json`;
    if (isCard && !card) {
      card = doc;
      cardFile = file;
    }
  }

  let candidates = morning;
  let gradedFrom = morning ? 'morning-board' : null;
  if (!candidates && card) {
    candidates = cardCandidates(card);
    gradedFrom = 'card-picks-and-pool';
  }
  const metaCount = card ? morningCount(card) : null;
  const graded = candidates && candidates.length
    ? clv.gradeScoredCandidates(candidates, {
      snapshots,
      published: card ? clv.candidatesFromCard({ picks: card.picks || [], parlayLegs: card.parlayLegs || [] }) : [],
      betAt: card && card.generatedAt || null,
    })
    : [];
  const bySport = {};
  let withClose = 0;
  for (const row of graded) {
    const sport = row.sport || 'UNK';
    if (!bySport[sport]) bySport[sport] = { scored: 0, withClose: 0 };
    bySport[sport].scored += 1;
    if (clv.hasCloseClv(row)) {
      withClose += 1;
      bySport[sport].withClose += 1;
    }
  }
  console.log(date);
  console.log(`  gradedFrom: ${gradedFrom || 'none'}`);
  if (morningFile) console.log(`  morningFile: ${path.basename(morningFile)} count=${morning.length}`);
  if (cardFile) console.log(`  cardFile: ${path.basename(cardFile)}`);
  if (metaCount != null) console.log(`  morningBoardCount: ${metaCount}`);
  console.log(`  snapshotFiles: ${snapshotFiles.length ? snapshotFiles.join(', ') : 'none'}`);
  console.log(`  scored: ${graded.length}`);
  console.log(`  withClose: ${withClose}`);
  const sports = Object.keys(bySport).sort();
  if (!sports.length) console.log('  bySport: none');
  for (const sport of sports) {
    console.log(`  ${sport}: scored=${bySport[sport].scored} withClose=${bySport[sport].withClose}`);
  }
  if (!morning) console.log('  note: full scored board is not on disk; counts above are the stored card subset');
  if (!snapshots.length) console.log('  note: no closing board for this date is on disk');
  if (metaCount != null && graded.length !== metaCount) {
    console.log(`  note: graded ${graded.length} of morningBoardCount ${metaCount}`);
  }
}

function main() {
  const dates = process.argv.slice(2).filter((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
  const wanted = dates.length ? dates : DATES;
  const files = [];
  for (const root of rootsFromArgs(process.argv.slice(2))) {
    if (!root || !fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) files.push(root);
    else walk(root, files, 0);
  }
  for (const date of wanted) reportDate(date, files);
}

main();
