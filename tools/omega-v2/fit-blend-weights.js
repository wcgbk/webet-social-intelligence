'use strict';

/**
 * Offline fit of OMEGA_V2_BLEND_P weights.
 * No network. No Odds API.
 *
 * p_pin and the close target are fairAt (Pinnacle power no-vig, key_convert
 * within 1.5 points) on the 10:00 slot and the close slot. p_model is the
 * calibrated probability the card already carries (coverProb / pCalRaw /
 * coverProb_current). Rows whose model equals the stored market are dropped.
 * Dates are strictly before 2026-11-01. Grid w = 0, 0.05, ..., 0.35.
 * The loss is the soft log-loss of p_blend against the closing probability.
 * A tie within 1e-12 keeps the smaller w. n < 30, or NCAAM, ships w = 0.
 *
 *   node tools/omega-v2/fit-blend-weights.js
 */

const fs = require('fs');
const path = require('path');
const { fairAt, pollsOf, specOf, gkey } = require('../../netlify/functions/lib/omega-v2/sharp_gaps');
const { blendProb, canonSport, unitProb } = require('../../netlify/functions/lib/omega-v2/blend');

const CUTOFF = '2026-11-01';
const MIN_N = 30;
const GRID = [];
for (let i = 0; i <= 7; i += 1) GRID.push(Math.round(i * 0.05 * 100) / 100);
const POLL_DIR = process.env.OMEGA_V2_POLL_DIR || '/workspace/sharp-fix-1115/move/data12';
const DATASET = path.join(__dirname, '../omega-calibration/out/dataset.jsonl');
const BOARD_1031 = '/workspace/force3-1113/lowpay/b2/mb-2026-10-31.json';
const H_BOARDS = process.env.OMEGA_V2_REPLAY_BOARD_DIR || '/workspace/sharp-fix-1115/h/boards';
const SPORTS = ['NBA', 'NFL', 'NHL', 'NCAAF', 'MLB', 'NCAAM'];

function gameAt(index, slot, cand) {
  if (!index || !cand) return null;
  let away = cand.awayTeam;
  let home = cand.homeTeam;
  if ((!away || !home) && cand.matchup && String(cand.matchup).includes('@')) {
    const parts = String(cand.matchup).split('@');
    away = away || parts[0];
    home = home || parts[1];
  }
  const key = gkey(away, home);
  if (!key) return null;
  return index.get(`${slot}|${key}`) || null;
}

function pinFair(index, slot, row) {
  const spec = specOf(row);
  const game = gameAt(index, slot, row);
  if (!spec || !game) return null;
  const fair = fairAt(game, spec);
  if (!fair || fair.book !== 'pinnacle') return null;
  const p = unitProb(fair.p);
  return p;
}

function distinctCal(pRaw, pCal, pMarket) {
  const raw = unitProb(pRaw);
  const cal = unitProb(pCal);
  const mkt = unitProb(pMarket);
  if (cal == null) return null;
  if (raw != null && mkt != null && Math.abs(raw - mkt) <= 1e-6) return null;
  if (mkt != null && Math.abs(cal - mkt) <= 1e-6) return null;
  return cal;
}

function rowKey(row) {
  const side = String(row.side || row.pick || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const line = row.line == null ? '' : String(row.line);
  return [
    row.date,
    canonSport(row.sport),
    gkey(row.awayTeam, row.homeTeam) || String(row.matchup || '').toLowerCase().trim(),
    String(row.market || '').toLowerCase(),
    side,
    line,
  ].join('|');
}

function loadPoll(date) {
  const file = path.join(POLL_DIR, `polls-${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return pollsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return null;
  }
}

function consider(bucket, seen, row) {
  const date = String(row.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(date < CUTOFF)) return;
  const sport = canonSport(row.sport);
  const cal = distinctCal(row.pRaw, row.pCal, row.pMarket);
  if (cal == null) {
    bucket.skippedModel += 1;
    return;
  }
  const key = rowKey(row);
  if (seen.has(key)) {
    bucket.dupes += 1;
    return;
  }
  seen.add(key);
  if (!bucket.byDate[date]) bucket.byDate[date] = [];
  bucket.byDate[date].push({
    date,
    sport,
    matchup: row.matchup,
    side: row.side || row.pick,
    pick: row.side || row.pick,
    market: row.market,
    line: row.line,
    awayTeam: row.awayTeam,
    homeTeam: row.homeTeam,
    pModel: cal,
  });
  bucket.queued += 1;
}

function logLoss(p, q) {
  const eps = 1e-12;
  const pp = Math.min(1 - eps, Math.max(eps, p));
  return -((q * Math.log(pp)) + ((1 - q) * Math.log(1 - pp)));
}

function fitSport(rows) {
  const n = rows.length;
  const scores = GRID.map((w) => {
    let loss = 0;
    let brier = 0;
    for (const row of rows) {
      const p = blendProb(row.pPin, row.pModel, w);
      const q = row.pClose;
      loss += logLoss(p, q);
      brier += (p - q) ** 2;
    }
    return {
      w,
      logLoss: n ? loss / n : null,
      brier: n ? brier / n : null,
    };
  });
  let best = scores[0];
  for (const row of scores) {
    if (row.logLoss + 1e-12 < best.logLoss) best = row;
  }
  const w0 = scores[0];
  let w = best.w;
  let reason = 'min-logloss';
  if (canonSport(rows[0] && rows[0].sport) === 'NCAAM' || n < MIN_N) {
    w = 0;
    reason = n < MIN_N ? `n<${MIN_N}` : 'no-model';
  }
  return { n, w, reason, bestW: best.w, best: best.logLoss, brier: best.brier, w0: w0.logLoss, w0Brier: w0.brier, grid: scores };
}

function main() {
  const bucket = { byDate: {}, queued: 0, skippedModel: 0, dupes: 0, sources: {} };
  const seen = new Set();
  const add = (source, row) => {
    const before = bucket.queued;
    consider(bucket, seen, row);
    if (bucket.queued > before) bucket.sources[source] = (bucket.sources[source] || 0) + 1;
  };

  if (fs.existsSync(DATASET)) {
    const text = fs.readFileSync(DATASET, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      add('dataset', {
        date: r.date,
        sport: r.sport,
        matchup: r.matchup,
        side: r.side,
        market: r.market,
        line: r.line,
        awayTeam: r.awayTeam,
        homeTeam: r.homeTeam,
        pRaw: r.p_model,
        pCal: r.coverProb_current,
        pMarket: r.fair_sharp_p,
      });
    }
  }

  function addBoard(file, date) {
    if (!fs.existsSync(file)) return;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of doc.candidates || []) {
      add('board', {
        date: date || doc.date,
        sport: c.sport,
        matchup: c.matchup,
        side: c.side || c.pick,
        market: c.market,
        line: c.line,
        awayTeam: c.awayTeam,
        homeTeam: c.homeTeam,
        pRaw: c.pModel,
        pCal: c.pCalRaw != null ? c.pCalRaw : c.coverProb,
        pMarket: c.pMkt,
      });
    }
  }

  addBoard(BOARD_1031, '2026-10-31');
  if (fs.existsSync(H_BOARDS)) {
    for (const name of fs.readdirSync(H_BOARDS)) {
      const m = name.match(/^mb-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m || !(m[1] < CUTOFF)) continue;
      addBoard(path.join(H_BOARDS, name), m[1]);
    }
  }

  const joined = [];
  const miss = { noPoll: 0, noPin: 0, noClose: 0 };
  for (const date of Object.keys(bucket.byDate).sort()) {
    const index = loadPoll(date);
    if (!index) {
      miss.noPoll += bucket.byDate[date].length;
      continue;
    }
    for (const row of bucket.byDate[date]) {
      const pPin = pinFair(index, '1000', row);
      const pClose = pinFair(index, 'close', row);
      if (pPin == null) {
        miss.noPin += 1;
        continue;
      }
      if (pClose == null) {
        miss.noClose += 1;
        continue;
      }
      joined.push({ ...row, pPin, pClose });
    }
  }

  const bySport = {};
  for (const row of joined) {
    if (!bySport[row.sport]) bySport[row.sport] = [];
    bySport[row.sport].push(row);
  }
  const fits = {};
  for (const sport of SPORTS) fits[sport] = fitSport(bySport[sport] || []);
  for (const sport of Object.keys(bySport)) {
    if (!fits[sport]) fits[sport] = fitSport(bySport[sport]);
  }

  const report = {
    cutoff: CUTOFF,
    grid: GRID,
    minN: MIN_N,
    queued: bucket.queued,
    skippedModel: bucket.skippedModel,
    dupes: bucket.dupes,
    sources: bucket.sources,
    joined: joined.length,
    miss,
    fits,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { fitSport, GRID, MIN_N, CUTOFF };
