// Offline replay of the live v2 card on saved morning boards.
// No network. Usage:
//   node tools/omega-v2/replay-sharp.js OUT.json [worktree]
// New sharp flags default OFF in this process when unset, so a bare run
// matches /workspace/opt90-1114/rp_main_a.json. Set a flag to on/1/true to
// replay that fix. Polls are the 3 AM / 10 AM / close blobs and travel on
// opts.linePolls, the same field publishFromOmegaCandidates reads.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAG_KEYS = [
  'OMEGA_V2_LINE_MOVE',
  'OMEGA_V2_MOVE_SHRINK',
  'OMEGA_V2_PINNACLE_FAIR',
  'OMEGA_V2_KEY_CONVERT',
  'OMEGA_V2_EV_FIRST',
];
for (const key of FLAG_KEYS) {
  if (process.env[key] == null || String(process.env[key]).trim() === '') {
    process.env[key] = 'off';
  }
}

const WT = process.argv[3] || path.resolve(__dirname, '../..');
const L = path.join(WT, 'netlify/functions/lib/omega-v2') + path.sep;
const sel = require(L + 'select');
const size = require(L + 'size');
const par = require(L + 'parlay');
const g = require(L + 'guards');
const PL = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);
const DATES = ['2026-10-31'].concat(Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`));
const POLL_DIR = process.env.OMEGA_V2_POLL_DIR || '/workspace/sharp-fix-1115/data';

function flagOn(name) {
  const text = String(process.env[name] || '').trim().toLowerCase();
  return text === 'on' || text === '1' || text === 'true' || text === 'yes';
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

const out = {};
for (const date of DATES) {
  const f = date === '2026-11-14'
    ? '/workspace/force3-1113/lowpay/b2_1114.json'
    : `/workspace/force3-1113/lowpay/b2/mb-${date}.json`;
  let B = JSON.parse(fs.readFileSync(f)).candidates;
  const pollDoc = loadPolls(date);
  if (flagOn('OMEGA_V2_KEY_CONVERT') && pollDoc) {
    const gaps = require(L + 'sharp_gaps');
    if (gaps && typeof gaps.synthesizeOffLine === 'function') {
      const extra = gaps.synthesizeOffLine(pollDoc, B) || [];
      if (extra.length) B = B.concat(extra);
    }
  }
  const asOf = Date.parse(`${date}T10:05:00-05:00`);
  const cands = B.filter((c) => PL.has(String(c.book || '').toLowerCase()) && c.lineAgrees !== false).map(toCand);
  const opts = { pregameAsOfMs: asOf, linePolls: pollDoc };
  const ann = cands.map((c) => sel.annotateCandidate(c, opts));
  const st = size.sizeStraights(sel.selectStraights(ann.filter((c) => c.qualified), opts), opts);
  const pl = par.buildForcedParlay ? par.buildForcedParlay(st) : null;
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
  out[date] = {
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
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
