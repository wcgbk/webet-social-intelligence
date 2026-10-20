#!/usr/bin/env node
'use strict';

/**
 * Local V1 + Edge selection dry run. No network, no blobs, no writes.
 *
 * Loads a stored board JSON (Odds API shape: sports.{NFL,NHL,MLB}.games[].books)
 * and runs the same selection helpers the generators use. Pregame is judged
 * at the board's last_update, not wall-clock now.
 *
 *   node tools/dryrun-1019.js
 *   node tools/dryrun-1019.js --board /workspace/fix-1017/board-fresh-1018/board-fresh-1018.json
 *
 * Generator dryRun (not this script; those paths can touch blobs or ESPN):
 *   V1:  run-picks-v1 defaults dryRun=true unless ?dryRun=false (write needs the picks secret)
 *   Edge: node tools/omega-dryrun-selection.js --date YYYY-MM-DD
 *         generateOmegaVnext({ dryRun:true, skipNarrate:true })
 */

global.fetch = function dryrun1019FetchBlocked() {
  throw new Error('dryrun-1019: network is disabled');
};
process.env.OMEGA_REPLAY_NO_WRITE = '1';
process.env.OMEGA_X_AUTOPOST = 'false';
delete process.env.ODDS_API_KEY;
delete process.env.NETLIFY_AUTH_TOKEN;

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { projectAllV1 } = require(path.join(root, 'netlify/functions/lib/v1-lock/project-v1'));
const { selectV1 } = require(path.join(root, 'netlify/functions/lib/v1-lock/select-v1'));
const { loadEfficiencySeeds } = require(path.join(root, 'netlify/functions/lib/omega-vnext/ingest'));
const { etCalendarDate } = require(path.join(root, 'netlify/functions/lib/omega-vnext/odds_math'));
const calibrate = require(path.join(root, 'netlify/functions/lib/omega-vnext/calibrate'));
const edge = require(path.join(root, 'netlify/functions/lib/omega-vnext/edge'));
const gates = require(path.join(root, 'netlify/functions/lib/omega-vnext/gates'));
const select = require(path.join(root, 'netlify/functions/lib/omega-vnext/select'));
const { publishEdgeCard } = require(path.join(root, 'netlify/functions/lib/omega-vnext/assemble'));
const parlay = require(path.join(root, 'netlify/functions/lib/omega-vnext/parlay'));
const nfl = require(path.join(root, 'netlify/functions/lib/omega-vnext/sports/nfl'));
const nhl = require(path.join(root, 'netlify/functions/lib/omega-vnext/sports/nhl'));
const mlb = require(path.join(root, 'netlify/functions/lib/omega-vnext/sports/mlb'));
const cfb = require(path.join(root, 'netlify/functions/lib/omega-vnext/sports/cfb'));
const nba = require(path.join(root, 'netlify/functions/lib/omega-vnext/sports/nba'));

const DEFAULT_BOARD = '/workspace/fix-1017/board-fresh-1018/board-fresh-1018.json';

function argBoard() {
  const i = process.argv.indexOf('--board');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return DEFAULT_BOARD;
}

function loadBoard(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || !doc.sports || typeof doc.sports !== 'object') {
    throw new Error(`board ${file} has no sports.{SPORT}.games shape`);
  }
  return doc;
}

function toOddsEvent(sport, game) {
  const bookmakers = [];
  for (const [key, book] of Object.entries(game.books || {})) {
    const markets = [];
    for (const [mkey, m] of Object.entries((book && book.markets) || {})) {
      if (!m || !Array.isArray(m.outcomes) || !m.outcomes.length) continue;
      markets.push({
        key: mkey,
        outcomes: m.outcomes.map(o => ({
          name: o.name,
          price: o.price,
          ...(o.point != null ? { point: o.point } : {}),
        })),
      });
    }
    if (markets.length) bookmakers.push({ key, markets });
  }
  return {
    id: game.id || null,
    sport,
    home_team: game.home_team,
    away_team: game.away_team,
    commence_time: game.commence_time || null,
    bookmakers,
  };
}

function eventsBySport(doc) {
  const bySport = {};
  for (const [sport, block] of Object.entries(doc.sports || {})) {
    const games = (block && block.games) || [];
    bySport[sport] = games.map(g => toOddsEvent(sport, g));
  }
  return bySport;
}

function boardAsOfMs(doc) {
  let max = null;
  for (const block of Object.values(doc.sports || {})) {
    for (const g of (block && block.games) || []) {
      for (const book of Object.values(g.books || {})) {
        for (const m of Object.values((book && book.markets) || {})) {
          const t = Date.parse(m && m.last_update);
          if (Number.isFinite(t) && (max == null || t > max)) max = t;
        }
      }
    }
  }
  return max;
}

function majorityEtDate(events) {
  const counts = new Map();
  for (const ev of events) {
    const d = etCalendarDate(ev.commence_time);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null;
  let n = -1;
  for (const [d, c] of counts) {
    if (c > n) { best = d; n = c; }
  }
  return { date: best, counts: [...counts.entries()] };
}

function printStraight(p, i) {
  const pick = p.pick || p.pickDisplay || p.side;
  const odds = p.odds != null ? p.odds : '';
  const units = p.units || '';
  const book = p.book || p.executionBook || '';
  const ev = p.ev != null ? p.ev : '';
  const rating = p.rating || p.grade || '';
  const tag = p.fallback ? ' fallback' : '';
  console.log(`  ${i + 1}. ${p.sport || ''}  ${p.matchup || ''}  ${pick}  ${odds}  ${book}  ${units}  ev ${ev}  ${rating}${tag}`);
}

function printLegs(legs) {
  (legs || []).forEach((leg, i) => {
    const pick = leg.pick || leg.pickDisplay || leg.side;
    const ev = leg.ev != null ? leg.ev : '';
    console.log(`  L${i + 1}. ${leg.sport || ''}  ${leg.matchup || ''}  ${pick}  ${leg.odds || ''}  ${leg.book || ''}  ${leg.units || ''}  ev ${ev}`);
  });
}

/** Three regular-season games when the stored board has no basketball_nba rows. */
function syntheticNbaEvents(cardDate) {
  const commence = `${cardDate || '2026-10-20'}T23:30:00Z`;
  const pairs = [
    ['Boston Celtics', 'New York Knicks'],
    ['Golden State Warriors', 'Los Angeles Lakers'],
    ['Milwaukee Bucks', 'Miami Heat'],
  ];
  return pairs.map(([home, away]) => ({
    id: `synthetic-nba-${home}`,
    sport: 'NBA',
    home_team: home,
    away_team: away,
    commence_time: commence,
    bookmakers: ['pinnacle', 'draftkings', 'hardrockbet'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [
          { name: home, price: key === 'pinnacle' ? -130 : (key === 'draftkings' ? 110 : 105) },
          { name: away, price: key === 'pinnacle' ? 110 : (key === 'draftkings' ? -130 : -125) },
        ] },
        { key: 'spreads', outcomes: [
          { name: home, price: -110, point: -2.5 },
          { name: away, price: -110, point: 2.5 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over', price: -110, point: 220.5 },
          { name: 'Under', price: -110, point: 220.5 },
        ] },
      ],
    })),
  }));
}

function runV1(bySport) {
  const events = [];
  for (const sport of ['NFL', 'NCAAF', 'NHL', 'NBA', 'NCAAM', 'MLB']) {
    for (const ev of bySport[sport] || []) events.push(ev);
  }
  const seeds = loadEfficiencySeeds();
  const { candidates, passes } = projectAllV1(events, { NFL: seeds.NFL || {}, NCAAF: seeds.NCAAF || {} }, {});
  const sel = selectV1(candidates, passes);
  console.log(`\nV1  candidates=${candidates.length} straights=${sel.picks.length} parlayLegs=${(sel.parlayLegs[0] && sel.parlayLegs[0].legs || []).length} fallbackFills=${sel.funnel.fallbackFill}`);
  console.log('V1 straights');
  sel.picks.slice(0, 3).forEach(printStraight);
  console.log('V1 parlay');
  if (!sel.parlayLegs.length) console.log('  (none)');
  else {
    const pl = sel.parlayLegs[0];
    console.log(`  ${pl.type}  ${pl.units}  ${pl.combinedOdds}  ev ${pl.ev}`);
    printLegs(pl.legs);
  }
  return sel;
}

function runEdge(bySport, cardDate, asOfMs) {
  const seeds = loadEfficiencySeeds();
  const raw = []
    .concat(nfl.project({ oddsEvents: bySport.NFL || [], standings: {}, efficiency: seeds.NFL || {}, gameDay: {} }))
    .concat(cfb.project({ oddsEvents: bySport.NCAAF || [], standings: {}, efficiency: seeds.NCAAF || {}, gameDay: {} }))
    .concat(nhl.project({ oddsEvents: bySport.NHL || [], standings: {}, gameDay: {} }))
    .concat(mlb.project({ oddsEvents: bySport.MLB || [], standings: {}, gameDay: {} }))
    .concat(nba.project({ oddsEvents: bySport.NBA || [], standings: {}, gameDay: {}, forCard: true }));
  const rawSplit = select.splitRawMiscalibrated(raw);
  const calibrated = calibrate.calibrateAll(rawSplit.candidates).map(c => edge.attachEv(c));
  const prepared = select.prepareEdgePositions(calibrated);
  const miscalibrated = rawSplit.miscalibrated.concat((prepared.diagnostics && prepared.diagnostics.miscalibrated) || []);
  const { yesPool, rejected } = gates.applyGates(prepared.positions, { cardDate, asOfMs });
  const chosen = select.selectStraights(yesPool, 3);
  const built = publishEdgeCard({
    positions: prepared.positions,
    qualified: chosen,
    yesPool,
    rejected,
    miscalibrated,
    hardFails: [],
    cardDate,
    modelVersion: 'dryrun-1019',
    dateFormatted: cardDate,
  });
  const picks = built.picks;
  const parlayLegs = built.parlayLegs;
  const mis = miscalibrated.length;
  console.log(`\nEdge  raw=${raw.length} positions=${prepared.positions.length} miscalibrated=${mis} pre=${rawSplit.miscalibrated.length} yesPool=${yesPool.length} rejected=${rejected.length} straights=${picks.length} parlayLegs=${(parlayLegs[0] && parlayLegs[0].legs || []).length}`);
  console.log('Edge straights');
  picks.slice(0, 3).forEach(printStraight);
  console.log('Edge parlay');
  if (!parlayLegs.length) console.log('  (none)');
  else {
    const pl = parlayLegs[0];
    console.log(`  ${pl.type}  ${pl.units}  ${pl.combinedOdds}  ev ${pl.ev}`);
    printLegs(pl.legs);
  }
  return { picks, parlayLegs, miscalibrated };
}

function assertCard(name, picks, parlayLegs) {
  const legs = parlayLegs && parlayLegs[0] && parlayLegs[0].legs;
  if (!picks || picks.length !== 3) {
    console.error(`${name} parlay guard FAIL: expected 3 straights, got ${picks ? picks.length : 0}`);
    process.exitCode = 1;
    return;
  }
  if (!legs || legs.length !== 3) {
    console.error(`${name} parlay guard FAIL: expected a 3-leg parlay, got ${legs ? legs.length : 0}`);
    process.exitCode = 1;
    return;
  }
  for (const leg of legs) {
    const hit = picks.find(s => parlay.conflictsWithStraight(leg, s));
    if (hit) {
      console.error(`${name} parlay guard FAIL: ${leg.pick || leg.side} conflicts with ${hit.pick || hit.side}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`${name} parlay guard: pass (3 straights + 3-leg)`);
}

function main() {
  const file = argBoard();
  if (!fs.existsSync(file)) {
    console.error(`dryrun-1019: board not found: ${file}`);
    process.exit(1);
  }
  const doc = loadBoard(file);
  const bySport = eventsBySport(doc);
  if (Array.isArray(bySport.basketball_nba) && bySport.basketball_nba.length && !(bySport.NBA || []).length) {
    bySport.NBA = bySport.basketball_nba.map((ev) => ({ ...ev, sport: 'NBA' }));
  }
  const flat = Object.values(bySport).flat();
  const slate = majorityEtDate(flat);
  const asOfMs = boardAsOfMs(doc);
  if (!(bySport.NBA || []).length) {
    bySport.NBA = syntheticNbaEvents(slate.date);
    console.log(`NBA events: synthetic ${bySport.NBA.length} (no basketball_nba games on this board)`);
  } else {
    console.log(`NBA events: board ${bySport.NBA.length}`);
  }
  const counts = Object.entries(bySport).map(([s, evs]) => `${s}:${evs.length}`).join(' ');
  console.log(`board ${file}`);
  console.log(`source ${doc.source || ''} ${doc.generated || ''}`);
  console.log(`games ${counts}`);
  console.log(`slate ET ${slate.date} counts ${JSON.stringify(slate.counts)}`);
  console.log(`asOf ${asOfMs != null ? new Date(asOfMs).toISOString() : 'none'} cardDate ${slate.date}`);
  const v1 = runV1(bySport);
  assertCard('V1', v1.picks, v1.parlayLegs);
  const edgeCard = runEdge(bySport, slate.date, asOfMs);
  assertCard('Edge', edgeCard.picks, edgeCard.parlayLegs);
  if (process.exitCode) process.exit(process.exitCode);
}

main();
