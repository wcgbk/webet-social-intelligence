'use strict';

/**
 * Walk-forward replay of pipeline v2 against the live card.
 * Reads the reconciled sizing-v2 derived set (pick-time pMkt, latest close,
 * exact-line CLV). Joins stored DraftKings and Hard Rock quotes before a
 * row can be priced. Does not call The Odds API and does not write to Supabase.
 *
 * Dollars and units in the report are whole numbers, rounded away from zero.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const v2 = require('../../netlify/functions/lib/omega-v2');
const { americanToDecimal } = require('../../netlify/functions/lib/omega-vnext/odds_math');
const { joinStoredDkHr } = require('./dkhr-quotes');

const DERIVED = process.env.OMEGA_V2_DERIVED
  || '/workspace/omega-sizing-v2/tools/sizing-v2/derived.json';
const REPO_ROOT = path.join(__dirname, '../..');
const BOOT_N = 10000;
const BOOT_SEED = 1030;

/**
 * Where REPLAY-V2.json and REPLAY-V2.md are written.
 * Direct `npm run omega-v2:replay` still writes the repo copies.
 * The deploy gate (`OMEGA_V2_GATE=1`) writes under os.tmpdir() so the
 * working tree stays clean. REPLAY_V2_OUT_DIR overrides that directory.
 * REPLAY_V2_WRITE_REPO=1 forces the repo copies even from the gate.
 */
function replayOutputDir() {
  if (process.env.REPLAY_V2_WRITE_REPO === '1') return REPO_ROOT;
  if (process.env.REPLAY_V2_OUT_DIR) return process.env.REPLAY_V2_OUT_DIR;
  if (process.env.OMEGA_V2_GATE === '1') {
    const dir = path.join(os.tmpdir(), 'omega-replay-v2-gate');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return REPO_ROOT;
}

function replayOutputPaths() {
  const dir = replayOutputDir();
  return {
    dir,
    json: path.join(dir, 'REPLAY-V2.json'),
    md: path.join(dir, 'REPLAY-V2.md'),
  };
}

function ceilAway(x) {
  if (!Number.isFinite(x)) return null;
  if (x > 0) return Math.ceil(x - 1e-9);
  if (x < 0) return -Math.ceil(-x - 1e-9);
  return 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadDerived() {
  if (!fs.existsSync(DERIVED)) throw new Error(`missing derived dataset: ${DERIVED}`);
  return JSON.parse(fs.readFileSync(DERIVED, 'utf8'));
}

function legKey(row) {
  return `${v2.gameKey(row.matchup)}|${String(row.pick || '').toLowerCase()}`;
}

function candidateFrom(row, quote) {
  const base = {
    sport: row.sport,
    matchup: row.matchup,
    pick: row.pick,
    market: row.market || row.betType,
    odds: row.odds,
    line: row.betPoint != null ? row.betPoint : row.line,
    pModel: row.pModel,
    pMkt: row.pMkt,
    commenceTime: row.commenceTime || '',
    result: row.result || null,
    clvPp: row.clvPp != null ? row.clvPp : null,
    book: row.book || null,
  };
  if (!quote || !Number.isFinite(quote.american) || !quote.book) return base;
  const px = { american: quote.american, book: quote.book };
  if (quote.point != null && Number.isFinite(Number(quote.point))) {
    px.point = Number(quote.point);
    px.line = Number(quote.point);
  }
  return {
    ...base,
    odds: quote.american,
    book: quote.book,
    bestDkHr: px,
    dkHrSource: quote.source || null,
  };
}

/** Card clock before the first kickoff, outside the 5-minute grace. */
function replayPregameAsOfMs(day) {
  let earliest = Infinity;
  for (const row of dayPool(day)) {
    const t = Date.parse(row.commenceTime || '');
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (Number.isFinite(earliest)) return earliest - (6 * 60 * 1000);
  const noon = Date.parse(`${day.date}T12:00:00Z`);
  return Number.isFinite(noon) ? noon : Date.now();
}

function dayPool(day) {
  const map = new Map();
  const rows = [...(day.straights || [])];
  const legs = day.parlay && Array.isArray(day.parlay.legs) ? day.parlay.legs : [];
  for (const row of legs) rows.push(row);
  for (const row of rows) {
    const key = legKey(row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function settleStraight(result, odds, stake) {
  if (result === 'push') return { profit: 0, risk: 0 };
  if (result === 'loss') return { profit: -stake, risk: stake };
  if (result === 'win') {
    const dec = americanToDecimal(odds);
    if (dec == null) return null;
    return { profit: Math.ceil(stake * (dec - 1) - 1e-9), risk: stake };
  }
  return null;
}

function parlayOutcome(legs) {
  if (!legs.length) return null;
  if (legs.some((leg) => !leg.result || leg.result === 'pending')) return null;
  if (legs.some((leg) => leg.result === 'loss')) return { result: 'loss', decimal: null };
  let dec = 1;
  let live = 0;
  for (const leg of legs) {
    if (leg.result === 'push') continue;
    if (leg.result !== 'win') return null;
    const d = americanToDecimal(leg.odds);
    if (d == null) return null;
    dec *= d;
    live += 1;
  }
  if (!live) return { result: 'push', decimal: 1 };
  return { result: 'win', decimal: dec };
}

function scanErrors(derived) {
  const errors = {
    unmatched: [],
    altLine: [],
    missingClose: [],
    duplicateSnapshots: {
      games: (derived.straySnapshotDrops || []).length,
      droppedRows: (derived.straySnapshotDrops || []).reduce((s, row) => s + (Number(row.dropped) || 0), 0),
      examples: (derived.straySnapshotDrops || []).slice(0, 12),
    },
    reconstructedPrice: [],
    name: [],
    other: derived.issues || [],
  };
  for (const day of derived.days || []) {
    const rows = dayPool(day);
    for (const row of rows) {
      const id = { date: day.date, pick: row.pick, matchup: row.matchup, sport: row.sport };
      if (!row.closeGameId) errors.unmatched.push(id);
      if (row.clvPp == null) errors.missingClose.push({ ...id, clvMethod: row.clvMethod || null, pMktSource: row.pMktSource || null });
      const betPoint = row.betPoint != null ? Number(row.betPoint) : null;
      const closePoint = row.closePoint != null ? Number(row.closePoint) : null;
      if (betPoint != null && closePoint != null && Math.abs(betPoint - closePoint) > 1e-9) {
        errors.altLine.push({ ...id, betPoint, closePoint, clvPp: row.clvPp != null ? row.clvPp : null, clvMethod: row.clvMethod || null });
      }
      const sizing = String(row.pMktSizingSource || '');
      if (sizing.startsWith('reconstructed-edge') || sizing.startsWith('none')) {
        errors.reconstructedPrice.push({ ...id, pMktSizingSource: sizing });
      }
      const blob = `${row.matchup || ''} ${row.pick || ''}`.toLowerCase();
      if (blob.includes('state louis') || blob.includes('st. louis')) {
        errors.name.push({ ...id, note: 'normalized st. louis / state louis before the game key' });
      }
    }
  }
  return errors;
}

function historyBefore(derived, cardDate) {
  const rows = [];
  for (const day of derived.days) {
    if (!(day.date < cardDate)) continue;
    for (const row of dayPool(day)) {
      if (row.result !== 'win' && row.result !== 'loss') continue;
      if (row.pModel == null || row.pMkt == null) continue;
      rows.push({
        date: day.date,
        sport: row.sport,
        pModel: row.pModel,
        pMkt: row.pMkt,
        result: row.result,
      });
    }
  }
  return rows;
}

function loadNetlifyToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return 'env';
  const tokenPath = '/home/box/.config/netlify/config.json';
  let raw;
  try { raw = fs.readFileSync(tokenPath, 'utf8'); } catch (_) { return 'missing-file'; }
  let json;
  try { json = JSON.parse(raw); } catch (_) { return 'bad-json'; }
  const users = json && json.users;
  if (!users || typeof users !== 'object') return 'no-users';
  for (const user of Object.values(users)) {
    const token = user && user.auth && user.auth.token;
    if (typeof token === 'string' && token.length > 0) {
      process.env.NETLIFY_AUTH_TOKEN = token;
      return 'config';
    }
  }
  return 'no-token';
}

const boardMemo = new Map();

/** Morning boards dated before cardDate. Picks mode does not read them. */
async function boardRowsBefore(cardDate) {
  const key = String(cardDate || '');
  if (boardMemo.has(key)) return boardMemo.get(key);
  const source = String(process.env.OMEGA_V2_BIAS_SOURCE || 'board').trim().toLowerCase();
  if (source === 'picks') {
    boardMemo.set(key, []);
    return [];
  }
  let timer;
  let rows = [];
  try {
    rows = await Promise.race([
      v2.loadBoardHistory(key),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('board history timeout')), 20000);
      }),
    ]);
  } catch (err) {
    console.error(`[replay] board history skipped for ${key}: ${err && err.message ? err.message : err}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(rows)) rows = [];
  boardMemo.set(key, rows);
  return rows;
}

function liveBets(derived) {
  const bets = [];
  for (const day of derived.days) {
    for (const row of day.straights || []) {
      if (!['win', 'loss', 'push'].includes(row.result)) continue;
      if (row.units == null || row.unitsMissing) continue;
      const profit = Number(row.profitUsd);
      const risk = row.result === 'push' ? 0 : Number(row.riskUsd);
      if (!Number.isFinite(profit) || !Number.isFinite(risk)) continue;
      bets.push({
        kind: 'straight',
        date: day.date,
        pick: row.pick,
        matchup: row.matchup,
        sport: row.sport,
        market: row.market,
        odds: String(row.odds),
        result: row.result,
        profitUsd: profit,
        riskUsd: risk,
        clvPp: row.clvPp == null ? null : Number(row.clvPp),
        pModel: row.pModel == null ? null : Number(row.pModel),
        pMkt: row.pMkt == null ? null : Number(row.pMkt),
        commenceTime: row.commenceTime || '',
      });
    }
    const parlay = day.parlay;
    if (!parlay || !['win', 'loss', 'push'].includes(parlay.result)) continue;
    const risk = parlay.result === 'push' ? 0 : Number(parlay.settledRiskUsd);
    const profit = Number(parlay.settledProfitUsd);
    if (!Number.isFinite(risk) || !Number.isFinite(profit)) continue;
    bets.push({
      kind: 'parlay',
      date: day.date,
      pick: `${(parlay.legs || []).length}-leg`,
      result: parlay.result,
      profitUsd: profit,
      riskUsd: risk,
      clvPp: null,
      legs: (parlay.legs || []).length,
    });
  }
  return bets;
}

async function v2Bets(derived, quotes) {
  const bets = [];
  const cards = [];
  const quoteFor = quotes || new Map();
  for (const day of derived.days) {
    const boardRows = await boardRowsBefore(day.date);
    const card = await v2.buildCard({
      date: day.date,
      candidates: dayPool(day).map((row) => candidateFrom(row, quoteFor.get(`${day.date}|${legKey(row)}`))),
      history: historyBefore(derived, day.date),
      boardRows,
      recheck: null,
      pregameAsOfMs: replayPregameAsOfMs(day),
    });
    let straightN = 0;
    for (const pick of card.picks) {
      const settled = settleStraight(pick.result, pick.odds, pick.stakeUsd);
      if (!settled) continue;
      straightN += 1;
      bets.push({
        kind: 'straight',
        date: day.date,
        pick: pick.pick,
        matchup: pick.matchup,
        sport: pick.sport,
        market: pick.betType || pick.market,
        odds: pick.odds,
        result: pick.result,
        profitUsd: settled.profit,
        riskUsd: settled.risk,
        clvPp: pick.clvPp == null ? null : Number(pick.clvPp),
        pModel: pick.pModel,
        pCal: pick.pCal,
        pMkt: pick.pMkt,
        units: pick.unitsNum,
        commenceTime: pick.commenceTime,
        book: pick.book || null,
        dkHrSource: (quoteFor.get(`${day.date}|${legKey(pick)}`) || {}).source || null,
      });
    }
    let parlayHit = null;
    if (card.parlayLegs.length) {
      const parlay = card.parlayLegs[0];
      const outcome = parlayOutcome(parlay.legs.map((leg) => ({ result: leg.result, odds: leg.odds })));
      if (outcome) {
        parlayHit = outcome.result;
        const stake = parlay.stakeUsd;
        let profit = 0;
        let risk = 0;
        if (outcome.result === 'loss') {
          profit = -stake;
          risk = stake;
        } else if (outcome.result === 'win') {
          profit = Math.ceil(stake * (outcome.decimal - 1) - 1e-9);
          risk = stake;
        }
        bets.push({
          kind: 'parlay',
          date: day.date,
          pick: parlay.type,
          result: outcome.result,
          profitUsd: profit,
          riskUsd: risk,
          clvPp: null,
          legs: parlay.legs.length,
          ev: parlay.evRaw,
          haircut: parlay.correlationFactor,
        });
      }
    }
    cards.push({
      date: day.date,
      straights: card.picks.length,
      parlay: card.parlayLegs.length ? card.parlayLegs[0].legs.length : 0,
      pass: card.pass,
      short: card.picks.length > 0 && card.picks.length < 3,
      trainN: card.calibration.trainN,
      method: card.calibration.method,
      parlayResult: parlayHit,
    });
  }
  return { bets, cards };
}

function record(bets, kind) {
  const rows = bets.filter((b) => (kind ? b.kind === kind : true) && ['win', 'loss', 'push'].includes(b.result));
  const wins = rows.filter((b) => b.result === 'win').length;
  const losses = rows.filter((b) => b.result === 'loss').length;
  const pushes = rows.filter((b) => b.result === 'push').length;
  const profit = rows.reduce((s, b) => s + b.profitUsd, 0);
  const risk = rows.reduce((s, b) => s + (b.riskUsd || 0), 0);
  return { wins, losses, pushes, bets: rows.length, profit, risk };
}

function clvStats(bets) {
  const rows = bets.filter((b) => b.kind === 'straight' && b.clvPp != null && Number.isFinite(b.clvPp));
  if (!rows.length) return { n: 0, mean: null, beat: null };
  const mean = rows.reduce((s, b) => s + b.clvPp, 0) / rows.length;
  const beat = rows.filter((b) => b.clvPp > 0).length / rows.length;
  return { n: rows.length, mean, beat };
}

function scoreProb(bets, field) {
  const rows = bets.filter((b) => b.kind === 'straight' && (b.result === 'win' || b.result === 'loss') && Number.isFinite(b[field]));
  if (!rows.length) return { n: 0, brier: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const y = row.result === 'win' ? 1 : 0;
    const p = Math.min(1 - 1e-6, Math.max(1e-6, row[field]));
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return { n: rows.length, brier: brier / rows.length, logLoss: logLoss / rows.length };
}

function maxDrawdown(bets) {
  const ordered = bets
    .filter((b) => b.result === 'win' || b.result === 'loss' || b.result === 'push')
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === 'parlay') - (b.kind === 'parlay')));
  let bank = 0;
  let peak = 0;
  let dd = 0;
  for (const bet of ordered) {
    bank += bet.profitUsd;
    if (bank > peak) peak = bank;
    dd = Math.max(dd, peak - bank);
  }
  return dd;
}

function byDay(bets, days, field) {
  const map = new Map(days.map((d) => [d, 0]));
  for (const bet of bets) map.set(bet.date, (map.get(bet.date) || 0) + (Number(bet[field]) || 0));
  return days.map((d) => map.get(d));
}

function bootstrap(live, v2bets, days) {
  const liveP = byDay(live, days, 'profitUsd');
  const v2P = byDay(v2bets, days, 'profitUsd');
  const liveR = byDay(live, days, 'riskUsd');
  const v2R = byDay(v2bets, days, 'riskUsd');
  const diff = v2P.map((v, i) => v - liveP[i]);
  const rng = mulberry32(BOOT_SEED);
  const profitSims = [];
  const roiSims = [];
  const n = days.length;
  for (let i = 0; i < BOOT_N; i += 1) {
    let p = 0;
    let lp = 0;
    let vp = 0;
    let lr = 0;
    let vr = 0;
    for (let j = 0; j < n; j += 1) {
      const k = Math.floor(rng() * n);
      p += diff[k];
      lp += liveP[k];
      vp += v2P[k];
      lr += liveR[k];
      vr += v2R[k];
    }
    profitSims.push(p);
    const liveRoi = lr > 0 ? lp / lr : 0;
    const v2Roi = vr > 0 ? vp / vr : 0;
    roiSims.push(v2Roi - liveRoi);
  }
  function pack(sims) {
    const sorted = sims.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(0.025 * BOOT_N)];
    const hi = sorted[Math.floor(0.975 * BOOT_N)];
    const le = sims.filter((x) => x <= 0).length;
    const ge = sims.filter((x) => x >= 0).length;
    const p = Math.min(1, (2 * Math.min(le, ge)) / BOOT_N);
    return { lo, hi, p: +p.toFixed(3), sig: lo > 0 || hi < 0 };
  }
  return {
    n: BOOT_N,
    seed: BOOT_SEED,
    profit: pack(profitSims),
    roi: pack(roiSims),
    observedProfit: diff.reduce((s, v) => s + v, 0),
  };
}

function displayMoney(rec) {
  return {
    wl: `${rec.wins}-${rec.losses}-${rec.pushes}`,
    bets: rec.bets,
    profitUsd: ceilAway(rec.profit),
    units: ceilAway(rec.profit / v2.UNIT_DOLLARS),
    roiPct: rec.risk > 0 ? ceilAway((100 * rec.profit) / rec.risk) : null,
    rawProfitUsd: Math.round(rec.profit),
    rawUnits: +(rec.profit / v2.UNIT_DOLLARS).toFixed(2),
    rawRoi: rec.risk > 0 ? rec.profit / rec.risk : null,
  };
}

function summarize(name, bets, cards, days) {
  const all = record(bets);
  const straights = record(bets, 'straight');
  const parlays = record(bets, 'parlay');
  const clv = clvStats(bets);
  const placed = scoreProb(bets, name === 'v2' ? 'pCal' : 'pModel');
  const decidedParlays = parlays.wins + parlays.losses;
  return {
    name,
    straights: displayMoney(straights),
    parlays: {
      ...displayMoney(parlays),
      hitRate: decidedParlays ? parlays.wins / decidedParlays : null,
    },
    overall: displayMoney(all),
    clv: {
      n: clv.n,
      cents: clv.mean == null ? null : +clv.mean.toFixed(2),
      beatClose: clv.beat == null ? null : clv.beat,
    },
    brier: placed.brier == null ? null : +placed.brier.toFixed(4),
    logLoss: placed.logLoss == null ? null : +placed.logLoss.toFixed(4),
    probN: placed.n,
    maxDrawdownUsd: maxDrawdown(bets),
    maxDrawdownUnits: ceilAway(maxDrawdown(bets) / v2.UNIT_DOLLARS),
    passDays: cards ? cards.filter((c) => c.pass).length : null,
    shortDays: cards ? cards.filter((c) => c.short).length : null,
    days: days.length,
  };
}

function liveCards(derived) {
  return derived.days.map((day) => ({
    date: day.date,
    straights: (day.straights || []).filter((row) => ['win', 'loss', 'push'].includes(row.result)).length,
    parlay: day.parlay && ['win', 'loss', 'push'].includes(day.parlay.result) ? (day.parlay.legs || []).length : 0,
    pass: (day.straights || []).length === 0,
    short: (day.straights || []).length > 0 && (day.straights || []).length < 3,
  }));
}

function allStraightScores(derived, cardsByDate) {
  const liveRows = [];
  const v2Rows = [];
  for (const day of derived.days) {
    const card = cardsByDate.get(day.date);
    for (const row of day.straights || []) {
      if (row.result !== 'win' && row.result !== 'loss') continue;
      if (row.pModel == null) continue;
      liveRows.push({ kind: 'straight', result: row.result, pModel: Number(row.pModel), pMkt: row.pMkt == null ? null : Number(row.pMkt) });
      const match = card && card.quoted.get(legKey(row));
      v2Rows.push({
        kind: 'straight',
        result: row.result,
        pCal: match ? match.pCal : null,
        pModel: Number(row.pModel),
      });
    }
  }
  return {
    live: scoreProb(liveRows, 'pModel'),
    market: scoreProb(liveRows.filter((r) => r.pMkt != null).map((r) => ({ ...r, kind: 'straight' })), 'pMkt'),
    v2: scoreProb(v2Rows.filter((r) => r.pCal != null), 'pCal'),
  };
}

function money(n) {
  if (n == null) return '—';
  if (n < 0) return `-$${Math.abs(n)}`;
  if (n > 0) return `+$${n}`;
  return '$0';
}

function signed(n) {
  if (n == null) return '—';
  return n > 0 ? `+${n}` : String(n);
}

function pct(x) {
  if (x == null) return '—';
  return `${Math.round(x * 1000) / 10}%`;
}

function replayStatusLines(dkhr) {
  const quoted = dkhr && Number(dkhr.quotedRows);
  if (!(quoted > 0)) return ['no stored DK/HR quotes'];
  const lines = [`stored DK/HR quotes: ${quoted} of ${dkhr.candidateRows} candidate rows`];
  if (!dkhr.sufficient && dkhr.primaryReplay) {
    lines.push(`primary 30-day replay for ship decisions: ${dkhr.primaryReplay}`);
  }
  return lines;
}

function sourceLabel(key) {
  const labels = {
    'line-snap': 'line snaps',
    stakeaudit: 'stakeaudit cards',
    'odds-master-1000': 'odds-master 10:00 board',
    'odds-master-0300': 'odds-master 3:00 board',
    urgent1103: 'urgent1103 boards',
  };
  return labels[key] || key;
}

function coverageLines(dkhr) {
  if (!dkhr) return [];
  const lines = [];
  if (dkhr.status === 'no stored DK/HR quotes') lines.push('no stored DK/HR quotes');
  const sources = Object.entries(dkhr.bySource || {})
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${sourceLabel(key)} ${n}`)
    .join(', ');
  lines.push(`Stored DraftKings and Hard Rock quotes, joined on game, market, side, and line: ${dkhr.quotedRows} of ${dkhr.candidateRows} candidate rows (${dkhr.quotedStoredRows} of ${dkhr.storedRows} stored rows).${sources ? ` Sources: ${sources}.` : ''}`);
  if (!dkhr.sufficient) {
    const missing = (dkhr.unquotedDates || []).length
      ? ` Dates with candidate rows and no stored quote: ${(dkhr.unquotedDates || []).join(', ')}.`
      : '';
    lines.push(`Coverage is short of the full candidate pool.${missing} The primary 30-day replay used for ship decisions is tools/omega-v2/replay-bp1104.js. This replay prices a row only from a stored DraftKings or Hard Rock quote.`);
  }
  return lines;
}

function buildMarkdown(report) {
  const L = report.live;
  const V = report.v2;
  const boot = report.bootstrap;
  const lines = [];
  lines.push('# Pipeline v2 replay');
  lines.push('');
  for (const line of coverageLines(report.dkhr)) {
    lines.push(line);
    lines.push('');
  }
  lines.push(`Walk-forward on the stored card, ${report.window[0]} to ${report.window[1]} (${report.days} days). 1u = $150. Profit dollars and units are whole numbers rounded away from zero. The close is used only for CLV. Prices and win/loss grades are the stored card. A bet price is the stored DraftKings or Hard Rock quote when one matches the row.`);
  lines.push('');
  lines.push('The candidate pool each day is the published straights plus that day\'s parlay legs. Full morning boards are not stored, so v2 can drop or resize a published leg. It cannot add a bet that never made the card.');
  lines.push('');
  lines.push('| | Live | v2 |');
  lines.push('|---|---:|---:|');
  const row = (label, a, b) => lines.push(`| ${label} | ${a} | ${b} |`);
  row('Straights W-L-P', L.straights.wl, V.straights.wl);
  row('Straight bets', L.straights.bets, V.straights.bets);
  row('Straight units', signed(L.straights.units), signed(V.straights.units));
  row('Straight $', money(L.straights.profitUsd), money(V.straights.profitUsd));
  row('Parlay W-L-P', L.parlays.wl, V.parlays.wl);
  row('Parlay hit rate', pct(L.parlays.hitRate), pct(V.parlays.hitRate));
  row('Parlay units', signed(L.parlays.units), signed(V.parlays.units));
  row('Parlay $', money(L.parlays.profitUsd), money(V.parlays.profitUsd));
  row('Overall units', signed(L.overall.units), signed(V.overall.units));
  row('Overall $', money(L.overall.profitUsd), money(V.overall.profitUsd));
  row('Overall ROI', L.overall.roiPct == null ? '—' : `${signed(L.overall.roiPct)}%`, V.overall.roiPct == null ? '—' : `${signed(V.overall.roiPct)}%`);
  row('CLV cents (n)', L.clv.cents == null ? '—' : `${L.clv.cents} (${L.clv.n})`, V.clv.cents == null ? '—' : `${V.clv.cents} (${V.clv.n})`);
  row('Beat close', pct(L.clv.beatClose), pct(V.clv.beatClose));
  row('Brier on bets', L.brier, V.brier);
  row('Log loss on bets', L.logLoss, V.logLoss);
  row('Brier, all straights', report.calibration.live.brier == null ? '—' : report.calibration.live.brier.toFixed(4), report.calibration.v2.brier == null ? '—' : report.calibration.v2.brier.toFixed(4));
  row('Log loss, all straights', report.calibration.live.logLoss == null ? '—' : report.calibration.live.logLoss.toFixed(4), report.calibration.v2.logLoss == null ? '—' : report.calibration.v2.logLoss.toFixed(4));
  row('Market Brier', report.calibration.market.brier == null ? '—' : report.calibration.market.brier.toFixed(4), '—');
  row('Pass days', L.passDays, V.passDays);
  row('Short-card days', L.shortDays, V.shortDays);
  row('Max drawdown', `${L.maxDrawdownUnits}u`, `${V.maxDrawdownUnits}u`);
  lines.push('');
  lines.push(`Bootstrap, ${boot.n} day resamples, seed ${boot.seed}. Difference is v2 minus live.`);
  lines.push('');
  lines.push(`- Profit: ${money(ceilAway(boot.observedProfit))} raw ${Math.round(boot.observedProfit)}. 95% CI ${money(ceilAway(boot.profit.lo))} to ${money(ceilAway(boot.profit.hi))}. p=${boot.profit.p}${boot.profit.sig ? ' (excludes 0)' : ''}.`);
  lines.push(`- ROI: ${(boot.roi.lo * 100).toFixed(1)} to ${(boot.roi.hi * 100).toFixed(1)} percentage points. p=${boot.roi.p}${boot.roi.sig ? ' (excludes 0)' : ''}.`);
  lines.push('');
  lines.push('## Read');
  lines.push('');
  lines.push(`On this window v2 published ${V.straights.bets} straights and ${V.parlays.bets} parlays. The live card published ${L.straights.bets} straights and ${L.parlays.bets} parlays. The candidate pool is the published card, not the morning board, so a leg that never made the card cannot be added.`);
  lines.push('');
  lines.push(`Recommendation: ${report.recommendation.ship ? 'Recommend enabling the flag.' : 'Do not replace the live card.'} ${report.recommendation.text}`);
  lines.push('');
  lines.push('## Data and mapping');
  lines.push('');
  const e = report.errors;
  lines.push(`- Unmatched games (no close id): ${e.unmatched.length}`);
  lines.push(`- Alt-line mismatches (close point ≠ bet point): ${e.altLine.length}`);
  lines.push(`- Missing closes (no CLV cents): ${e.missingClose.length}`);
  lines.push(`- Duplicate snapshots dropped: ${e.duplicateSnapshots.droppedRows} rows across ${e.duplicateSnapshots.games} games. The replay keeps the latest close per game.`);
  lines.push(`- Pick-time price reconstructed from the card edge, because no pre-pick Pinnacle pair matched the number: ${e.reconstructedPrice.length}`);
  lines.push(`- St. Louis / "state louis" spellings normalized before the game key: ${e.name.length}`);
  if (e.other.length) {
    lines.push(`- Other derived-set notes: ${e.other.map((item) => `${item.date} ${item.issue}`).join('; ')}`);
  }
  lines.push('');
  lines.push('CLV cents stay on the stored grade. A moved NHL or MLB number is left unmatched rather than scored off an alt line. `clvPp` is cents.');
  lines.push('');
  return lines.join('\n');
}

function recommend(live, next, boot, calibration) {
  const brierBetter = calibration.v2.brier != null && calibration.live.brier != null
    && calibration.v2.brier < calibration.live.brier - 0.002;
  if (boot.profit.hi < 0) {
    return {
      ship: false,
      text: 'v2 profit is significantly worse than the live card on this window. Keep the flag off.',
    };
  }
  if (boot.profit.lo > 0 && brierBetter) {
    return {
      ship: true,
      text: 'v2 profit is significantly better and the walk-forward probabilities are better calibrated. Enable the flag for the next card, and keep the pre-publish recheck on.',
    };
  }
  return {
    ship: false,
    text: 'The profit gap is not significant. v2 does not force a pick, and a parlay leg has to be +EV at a DraftKings or Hard Rock price with no shared game or club. This 30-day pool does not justify replacing the live card. Leave the pipeline flag off.',
    brierBetter,
  };
}

async function main() {
  const tokenSource = loadNetlifyToken();
  console.error(`[replay] tokenSource=${tokenSource}`);
  const derived = loadDerived();
  const joined = await joinStoredDkHr(derived);
  const dkhr = joined.summary;
  const days = derived.days.map((day) => day.date);
  const errors = scanErrors(derived);
  const live = liveBets(derived);
  const replay = await v2Bets(derived, joined.quotes);
  const quoted = new Map();
  // Score every straight with the same fit, including ones v2 did not bet.
  for (const day of derived.days) {
    const map = new Map();
    const fit = v2.fitWalkForward(historyBefore(derived, day.date), day.date, {
      boardRows: await boardRowsBefore(day.date),
    });
    for (const row of day.straights || []) {
      const cand = v2.normalizeCandidate(candidateFrom(row));
      const cal = cand.pModel != null && cand.pMkt != null ? v2.applyCalibration(cand, fit) : null;
      if (cal) map.set(legKey(row), { pCal: cal.pCal });
    }
    quoted.set(day.date, { quoted: map });
  }
  const calibrationRaw = allStraightScores(derived, quoted);
  const calibration = {
    live: {
      n: calibrationRaw.live.n,
      brier: calibrationRaw.live.brier == null ? null : +calibrationRaw.live.brier.toFixed(4),
      logLoss: calibrationRaw.live.logLoss == null ? null : +calibrationRaw.live.logLoss.toFixed(4),
    },
    v2: {
      n: calibrationRaw.v2.n,
      brier: calibrationRaw.v2.brier == null ? null : +calibrationRaw.v2.brier.toFixed(4),
      logLoss: calibrationRaw.v2.logLoss == null ? null : +calibrationRaw.v2.logLoss.toFixed(4),
    },
    market: {
      n: calibrationRaw.market.n,
      brier: calibrationRaw.market.brier == null ? null : +calibrationRaw.market.brier.toFixed(4),
      logLoss: calibrationRaw.market.logLoss == null ? null : +calibrationRaw.market.logLoss.toFixed(4),
    },
  };
  const liveSummary = summarize('live', live, liveCards(derived), days);
  const v2Summary = summarize('v2', replay.bets, replay.cards, days);
  const boot = bootstrap(live, replay.bets, days);
  let recommendation = recommend(liveSummary, v2Summary, boot, calibration);
  if (!dkhr.sufficient) {
    recommendation = {
      ship: false,
      text: dkhr.status === 'no stored DK/HR quotes'
        ? 'no stored DK/HR quotes. Ship decisions use tools/omega-v2/replay-bp1104.js for this window.'
        : `Stored DraftKings and Hard Rock quotes cover ${dkhr.quotedRows} of ${dkhr.candidateRows} candidate rows. Ship decisions use tools/omega-v2/replay-bp1104.js for this window.`,
    };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    window: derived.window,
    days: days.length,
    unitDollars: v2.UNIT_DOLLARS,
    modelVersion: v2.MODEL_VERSION,
    pool: 'Published straights plus parlay legs on each stored card. Not the full morning board.',
    dkhr,
    live: liveSummary,
    v2: v2Summary,
    calibration,
    bootstrap: {
      n: boot.n,
      seed: boot.seed,
      observedProfit: boot.observedProfit,
      profit: boot.profit,
      roi: {
        lo: +boot.roi.lo.toFixed(4),
        hi: +boot.roi.hi.toFixed(4),
        p: boot.roi.p,
        sig: boot.roi.sig,
      },
    },
    recommendation,
    errors: {
      unmatched: errors.unmatched,
      altLine: errors.altLine,
      missingClose: errors.missingClose,
      duplicateSnapshots: errors.duplicateSnapshots,
      reconstructedPrice: errors.reconstructedPrice,
      name: errors.name,
      other: errors.other,
    },
    cards: replay.cards,
    v2Bets: replay.bets.map((bet) => ({
      date: bet.date,
      kind: bet.kind,
      pick: bet.pick,
      matchup: bet.matchup || null,
      sport: bet.sport || null,
      odds: bet.odds || null,
      result: bet.result,
      profitUsd: bet.profitUsd,
      riskUsd: bet.riskUsd,
      clvPp: bet.clvPp == null ? null : bet.clvPp,
      commenceTime: bet.commenceTime || null,
      book: bet.book || null,
      dkHrSource: bet.dkHrSource || null,
    })),
  };
  // markdown wants the nested error arrays' lengths via report.errors shape used above.
  // buildMarkdown reads report.errors.unmatched.length — I stored counts, not arrays.
  // Pass a view that matches the markdown reader.
  const mdReport = {
    ...report,
    errors: {
      unmatched: errors.unmatched,
      altLine: errors.altLine,
      missingClose: errors.missingClose,
      duplicateSnapshots: errors.duplicateSnapshots,
      reconstructedPrice: errors.reconstructedPrice,
      name: errors.name,
      other: errors.other,
    },
  };
  const outs = replayOutputPaths();
  fs.mkdirSync(outs.dir, { recursive: true });
  fs.writeFileSync(outs.json, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outs.md, buildMarkdown(mdReport));
  console.log(`replay out: ${outs.dir}`);
  for (const line of replayStatusLines(dkhr)) console.log(line);
  console.log(JSON.stringify({
    dkhr,
    live: liveSummary.overall,
    v2: v2Summary.overall,
    straights: { live: liveSummary.straights.wl, v2: v2Summary.straights.wl },
    parlays: { live: liveSummary.parlays, v2: v2Summary.parlays },
    brier: calibration,
    boot: report.bootstrap,
    recommend: recommendation,
    errors: {
      unmatched: errors.unmatched.length,
      altLine: errors.altLine.length,
      missingClose: errors.missingClose.length,
    },
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { replayStatusLines, replayOutputDir, replayOutputPaths };
