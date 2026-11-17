// Offline replay of the live v2 card on saved morning boards.
// No network. Usage:
//   node tools/omega-v2/replay-sharp.js OUT.json [worktree]
// New sharp flags default OFF in this process when unset, so a bare run
// matches /workspace/opt90-1114/rp_main_a.json. Set a flag to on/1/true to
// replay that fix. Polls are the 3 AM / 10 AM / close blobs and travel on
// opts.linePolls, the same field publishFromOmegaCandidates reads.
//
// Optional window. Unset, the date list and the stored boards are the
// 10/31-11/14 run and the file is byte-identical to that baseline.
//   OMEGA_V2_REPLAY_FROM / OMEGA_V2_REPLAY_TO   YYYY-MM-DD, inclusive
//   OMEGA_V2_REPLAY_BOARD_DIR                   mb-DATE.json directory
// Board dir is used only for a date that has no stored mb board.
// Stored boards (b2/mb-DATE.json, and b2_1114.json on 11/14) keep priority.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAG_KEYS = [
  'OMEGA_V2_LINE_MOVE',
  'OMEGA_V2_MOVE_SHRINK',
  'OMEGA_V2_PINNACLE_FAIR',
  'OMEGA_V2_KEY_CONVERT',
  'OMEGA_V2_EV_FIRST',
  'OMEGA_V2_EV_FIRST_CAPPED',
  'OMEGA_V2_NBA_INJURY',
  'OMEGA_NFL_QB_ADJ',
  'OMEGA_V2_NHL_GOALIE',
  // News log is not read on this path. Unset stays off so a replay does not fetch.
  'OMEGA_NEWS_SNAPSHOT',
  // Default-on blend. A bare replay stays the pre-blend card. Set =on to replay it.
  // Weight and trim env vars are not here: an unset value would become the string off.
  'OMEGA_V2_BLEND_P',
  // Default-on win-probability floor. A bare replay stays the 0.001 clamp.
  'OMEGA_V2_P_FLOOR',
  // Default-on same ET day. A bare replay stays the old selector.
  'OMEGA_SAME_DAY_ONLY',
];
for (const key of FLAG_KEYS) {
  if (process.env[key] == null || String(process.env[key]).trim() === '') {
    process.env[key] = 'off';
  }
}

// argv[3] is the worktree only when this file is the program. A require()
// from the poll builder must not treat the parent's argv as a worktree.
const WT = (require.main === module && process.argv[3])
  ? process.argv[3]
  : path.resolve(__dirname, '../..');
const L = path.join(WT, 'netlify/functions/lib/omega-v2') + path.sep;
const sel = require(L + 'select');
const { filterSameEtDay, logSameDayDrops, sameDayMeta } = require(L + 'same_day');
const size = require(L + 'size');
const par = require(L + 'parlay');
const g = require(L + 'guards');
const PL = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);
const DATES = ['2026-10-31'].concat(Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`));
const POLL_DIR = process.env.OMEGA_V2_POLL_DIR || '/workspace/sharp-fix-1115/data';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function flagOn(name) {
  const text = String(process.env[name] || '').trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
}

function nextDate(iso) {
  const t = Date.parse(`${iso}T12:00:00Z`) + 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function replayDates() {
  const from = String(process.env.OMEGA_V2_REPLAY_FROM || '').trim();
  const to = String(process.env.OMEGA_V2_REPLAY_TO || '').trim();
  if (!from && !to) return DATES;
  const start = from || DATES[0];
  const end = to || DATES[DATES.length - 1];
  if (!YMD.test(start) || !YMD.test(end) || start > end) {
    throw new Error(`OMEGA_V2_REPLAY_FROM/TO must be YYYY-MM-DD with from <= to (got ${start}..${end})`);
  }
  const out = [];
  for (let cur = start; cur <= end; cur = nextDate(cur)) out.push(cur);
  return out;
}

function storedBoardPath(date) {
  if (date === '2026-11-14') return '/workspace/force3-1113/lowpay/b2_1114.json';
  return `/workspace/force3-1113/lowpay/b2/mb-${date}.json`;
}

function loadCandidates(date) {
  const stored = storedBoardPath(date);
  if (fs.existsSync(stored)) {
    return JSON.parse(fs.readFileSync(stored, 'utf8')).candidates;
  }
  const dir = String(process.env.OMEGA_V2_REPLAY_BOARD_DIR || '').trim();
  if (dir) {
    const alt = path.join(dir, `mb-${date}.json`);
    if (fs.existsSync(alt)) {
      return JSON.parse(fs.readFileSync(alt, 'utf8')).candidates;
    }
  }
  throw new Error(`no morning board for ${date}`);
}

function loadPolls(date) {
  const file = path.join(POLL_DIR, `polls-${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function toCand(c) {
  const odds = Number(String(c.odds).replace('+', ''));
  const pCal = c.pCalRaw != null ? c.pCalRaw : c.coverProb;
  return {
    sport: c.sport,
    matchup: c.matchup,
    pick: c.side,
    market: c.market,
    marketFamily: sel.marketFamily(c.market, c.side),
    odds,
    oddsText: c.odds,
    line: c.line,
    book: c.book,
    bestDkHr: c.bestDkHr || null,
    needsKeyConvert: c.needsKeyConvert === true,
    commenceTime: c.commenceTime,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    gameKey: sel.gameKey(c.matchup),
    pinnPrices: c.pinnPrices || null,
    calibration: { pCal, pMkt: c.pMkt, pModel: c.pModel, method: 'board' },
  };
}

function buildDay(date, B, pollDoc) {
  let rows = B;
  if (flagOn('OMEGA_V2_KEY_CONVERT') && pollDoc) {
    const gaps = require(L + 'sharp_gaps');
    if (gaps && typeof gaps.synthesizeOffLine === 'function') {
      const extra = gaps.synthesizeOffLine(pollDoc, rows) || [];
      if (extra.length) rows = rows.concat(extra);
    }
  }
  const dayFilter = filterSameEtDay(rows, date);
  if (dayFilter.applied) {
    logSameDayDrops(dayFilter);
    rows = dayFilter.rows;
  }
  const asOf = Date.parse(`${date}T10:05:00-05:00`);
  const cands = rows.filter((c) => PL.has(String(c.book || '').toLowerCase()) && c.lineAgrees !== false).map(toCand);
  const opts = { pregameAsOfMs: asOf, linePolls: pollDoc, cardDate: date };
  const ann = cands.map((c) => sel.annotateCandidate(c, opts));
  const st = size.sizeStraights(sel.selectStraights(ann.filter((c) => c.qualified), opts), opts);
  const pl = par.buildForcedParlay ? par.buildForcedParlay(st, opts) : null;
  let card = {
    date,
    modelVersion: require(L + 'constants').MODEL_VERSION,
    leakageChecked: true,
    selectionRule: 'force-top3',
    picks: st.map(g.toPick),
    parlayLegs: g.toParlay(pl, ann.length),
    parlayPool: [],
  };
  card = g.autoCorrectCard(card, opts);
  const day = {
    picks: card.picks.map((p) => ({
      sport: p.sport,
      matchup: p.matchup,
      side: p.pick,
      market: p.market,
      line: p.line,
      odds: p.odds,
      book: p.book,
      commenceTime: (st.find((s) => s.pick === p.pick) || {}).commenceTime,
      homeTeam: (st.find((s) => s.pick === p.pick) || {}).homeTeam,
      awayTeam: (st.find((s) => s.pick === p.pick) || {}).awayTeam,
      winProbability: p.winProbability,
      edgePct: p.edgePct,
      ev: p.ev,
      rating: p.rating,
      units: p.units,
      stakeUsd: p.stakeUsd,
      filler: p.filler || false,
      label: p.label || null,
      ...(p.lineMovePinn ? { lineMovePinn: p.lineMovePinn } : {}),
      ...(p.staleSoft ? { staleSoft: true, softLagPp: p.softLagPp != null ? p.softLagPp : null } : {}),
      ...(p.pushQ ? { pushQ: p.pushQ } : {}),
      ...(p.blendApplied ? {
        pPinnacle: p.pPinnacle != null ? p.pPinnacle : null,
        pModel: p.pModel != null ? p.pModel : null,
        pBlend: p.pBlend != null ? p.pBlend : null,
        blendW: p.blendW != null ? p.blendW : 0,
        breakeven: p.breakeven != null ? p.breakeven : null,
      } : {}),
    })),
    parlay: card.parlayLegs[0] ? {
      combinedOdds: card.parlayLegs[0].combinedOdds,
      units: card.parlayLegs[0].units,
      stakeUsd: card.parlayLegs[0].stakeUsd,
      legs: (card.parlayLegs[0].legs || []).map((l) => l.pick),
    } : null,
    errors: g.validateCard(card),
    notes: card.qaNotes,
  };
  if (dayFilter.applied) day.sameDay = sameDayMeta(dayFilter, date);
  return day;
}

function main() {
  const out = {};
  for (const date of replayDates()) {
    const B = loadCandidates(date);
    const pollDoc = loadPolls(date);
    out[date] = buildDay(date, B, pollDoc);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}

if (require.main === module) main();

module.exports = { buildDay, loadCandidates, loadPolls, replayDates, DATES };
