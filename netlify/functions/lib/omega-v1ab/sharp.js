'use strict';
/**
 * Omega V1 A/B duplicate — sharp-desk fixes (Math Audit, 2026-10-22).
 * Pure functions, no network. Input: Omega's own position pool (parlayPool of
 * edge-picks-omega/picks-{date}, read-only): same projections, same 10 AM board.
 *
 *  1) Calibration: p = fair + W*(1-uncertainty)*(coverProb - fair)
 *  2) Rank by calibrated edge (p - implied at best DK/HR price). Require
 *     EV > 0, edge >= 0.5pp, odds in [-300, +300].
 *  3) No padding: publish only qualifiers (0-3), labeled when short.
 *  4) Market-match guard: |fair - implied| > 5pp => data defect, dropped.
 *     Parlay legs reuse the straights' stored p/EV.
 *  Staking: quarter Kelly on calibrated p (Omega unit scale, 1.25u cap).
 */
const { americanToDecimal, kellyFraction, kellyToUnits } = require('../omega-vnext/odds_math');

const V1AB_MODEL_VERSION = 'v1ab-1.0.0-omega-sharp';
const V1AB_STORE = 'edge-picks-omega-v1ab';
const V1AB_KPI_START = '2026-10-22';

const SHARP = Object.freeze({
  W: 1.0,
  minEdge: 0.005,
  minEv: 0,          // strict >
  oddsFloor: -300,
  oddsCeil: 300,
  maxFairImpliedGap: 0.05,
  kellyFraction: 0.25,
  maxStraights: 3,
  maxUnitsPerPick: 1.25,
  parlayUnits: 0.5,
  sameGameHaircut: 0.95,
});

function impliedFromAmerican(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

function pickLabel(c) {
  const m = String(c.market || '');
  if (/moneyline/i.test(m)) return `${c.side} ML`;
  return c.side;
}

function calibrateSharp(c, cfg = SHARP) {
  const cover = Number(c.coverProb);
  const edgeOmega = Number(c.edgePct);
  const odds = Number(c.bestDkHr && c.bestDkHr.american != null ? c.bestDkHr.american : c.odds);
  const book = (c.bestDkHr && c.bestDkHr.book) || c.book || null;
  const unc = Number.isFinite(Number(c.uncertainty)) ? Math.min(1, Math.max(0, Number(c.uncertainty))) : 1;
  const out = { ...c, odds, book, uncertainty: unc };
  if (!Number.isFinite(cover) || !Number.isFinite(edgeOmega) || !Number.isFinite(odds)) {
    return { ...out, status: 'out', reason: 'missing coverProb/edge/odds' };
  }
  const fair = cover - edgeOmega;
  const implied = impliedFromAmerican(odds);
  const dec = americanToDecimal(odds);
  const p = fair + cfg.W * (1 - unc) * (cover - fair);
  const calEdge = p - implied;
  const ev = p * dec - 1;
  const kelly = kellyFraction(p, odds, cfg.kellyFraction);
  return { ...out, fair, implied, decimal: dec, pSharp: p, calEdge, evSharp: ev, kellyPct: kelly };
}

function qualifyReason(x, cfg = SHARP) {
  if (x.status === 'out') return x.reason;
  if (Math.abs(x.fair - x.implied) > cfg.maxFairImpliedGap) return 'market-match guard: |fair - implied| > 5pp';
  if (!(x.evSharp > cfg.minEv)) return 'EV <= 0 at best price';
  if (x.odds < cfg.oddsFloor || x.odds > cfg.oddsCeil) return 'odds outside -300/+300';
  if (!(x.calEdge >= cfg.minEdge)) return 'calibrated edge below 0.5pp';
  return null;
}

/** Full sharp pass over a pool. Returns { picks, qualified, rejected, all }. */
function selectSharp(pool, { nowMs = Date.now(), cfg = SHARP } = {}) {
  const all = (pool || []).map(c => calibrateSharp(c, cfg)).map(x => {
    let reason = qualifyReason(x, cfg);
    if (!reason && x.commenceTime && Date.parse(x.commenceTime) <= nowMs) reason = 'game already started';
    return { ...x, status: reason ? 'out' : 'pass', reason: reason || 'qualifies' };
  });
  // One side per game: best calibrated edge.
  const byGame = new Map();
  for (const x of all.filter(a => a.status === 'pass')) {
    const g = byGame.get(x.matchup);
    if (!g || x.calEdge > g.calEdge) byGame.set(x.matchup, x);
  }
  for (const x of all) {
    if (x.status === 'pass' && byGame.get(x.matchup) !== x) { x.status = 'out'; x.reason = 'not best side in game'; }
  }
  const qualified = all.filter(x => x.status === 'pass').sort((a, b) => b.calEdge - a.calEdge);
  qualified.forEach((x, i) => { x.sharpRank = i + 1; });
  const published = qualified.slice(0, cfg.maxStraights);
  for (const x of qualified.slice(cfg.maxStraights)) { x.status = 'out'; x.reason = `qualified #${x.sharpRank} but card max is ${cfg.maxStraights}`; }
  const picks = published.map(x => toPick(x, cfg));
  return { picks, qualified, rejected: all.filter(x => x.status === 'out'), all };
}

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

function toPick(x, cfg = SHARP) {
  const units = Math.min(cfg.maxUnitsPerPick, kellyToUnits(x.kellyPct, cfg.maxUnitsPerPick));
  const fmtOdds = x.odds > 0 ? `+${x.odds}` : String(x.odds);
  const betType = /total/i.test(x.market) ? 'Total' : /spread/i.test(x.market) ? 'Spread' : 'Moneyline';
  return {
    pick: pickLabel(x),
    pickDisplay: pickLabel(x),
    matchup: x.matchup,
    sport: x.sport,
    odds: fmtOdds,
    units: `${units}u`,
    unitsNum: units,
    betType,
    book: x.book,
    commenceTime: x.commenceTime || null,
    coverProb: pct(x.pSharp),
    winProbability: pct(x.pSharp),
    edgePct: pct(x.calEdge, 2),
    ev: pct(x.evSharp),
    modelEdge: `Calibrated p ${pct(x.pSharp)} vs fair ${pct(x.fair)} (uncertainty ${x.uncertainty}); implied ${pct(x.implied)}; edge ${pct(x.calEdge, 2)}; EV ${pct(x.evSharp)}; ¼ Kelly ${pct(x.kellyPct, 2)}`,
    source: 'omega-v1ab',
    sharp: {
      pSharp: +x.pSharp.toFixed(6), fair: +x.fair.toFixed(6), implied: +x.implied.toFixed(6),
      calEdge: +x.calEdge.toFixed(6), ev: +x.evSharp.toFixed(6), kellyPct: +x.kellyPct.toFixed(6),
      uncertainty: x.uncertainty, omegaCoverProb: x.coverProb, omegaEdge: x.edgePct, rank: x.sharpRank,
      line: x.line != null ? x.line : null, market: x.market, side: x.side,
    },
  };
}

/** Parlay from published straights only; reuses each leg's stored p and EV. */
function buildParlay(picks, cfg = SHARP) {
  if (!Array.isArray(picks) || picks.length < 2) return [];
  let p = 1, dec = 1;
  const games = new Map();
  for (const l of picks) { p *= l.sharp.pSharp; dec *= americanToDecimal(Number(l.odds)); games.set(l.matchup, (games.get(l.matchup) || 0) + 1); }
  let haircut = 1;
  for (const n of games.values()) if (n > 1) haircut *= Math.pow(cfg.sameGameHaircut, n - 1);
  p *= haircut;
  const ev = p * dec - 1;
  if (!(ev > 0) || picks.some(l => !(l.sharp.ev > 0))) return [];
  const american = dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
  return [{
    type: `${picks.length}-leg-parlay-straight`,
    units: `${cfg.parlayUnits}u`,
    combinedOdds: american > 0 ? `+${american}` : String(american),
    combinedDecimal: +dec.toFixed(2),
    combinedProb: pct(p),
    ev: pct(ev),
    uniqueGames: games.size,
    uniqueSports: new Set(picks.map(l => l.sport)).size,
    independent: haircut === 1,
    correlationHaircut: String(haircut),
    correlationNote: 'Parlay of the published straights. Legs reuse each straight\'s stored calibrated p and EV.',
    legMarkets: picks.map(l => l.betType),
    source: 'omega-v1ab',
    legs: picks.map(l => ({ ...l })),
  }];
}

function shortCardLabel(n, cfg = SHARP) {
  if (n >= cfg.maxStraights) return null;
  if (n === 0) return 'No picks today: nothing cleared every minimum. V1 does not pad the card.';
  return `Short card: only ${n} of ${cfg.maxStraights} picks cleared every minimum today. V1 does not pad the card.`;
}

// ── Calibration KPIs ──
function brierScore(rows) {
  const r = rows.filter(x => Number.isFinite(x.p) && (x.y === 0 || x.y === 1));
  if (!r.length) return null;
  return r.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / r.length;
}
function reliabilityBuckets(rows, edges = [0, 0.3, 0.4, 0.5, 0.55, 0.6, 0.7, 1.0001]) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const r = rows.filter(x => (x.y === 0 || x.y === 1) && x.p >= edges[i] && x.p < edges[i + 1]);
    out.push({
      bucket: `${Math.round(edges[i] * 100)}-${Math.min(100, Math.round(edges[i + 1] * 100))}%`,
      n: r.length,
      meanP: r.length ? +(r.reduce((s, x) => s + x.p, 0) / r.length).toFixed(4) : null,
      hitRate: r.length ? +(r.reduce((s, x) => s + x.y, 0) / r.length).toFixed(4) : null,
    });
  }
  return out;
}

module.exports = {
  V1AB_MODEL_VERSION, V1AB_STORE, V1AB_KPI_START, SHARP,
  impliedFromAmerican, calibrateSharp, qualifyReason, selectSharp, toPick, buildParlay,
  shortCardLabel, brierScore, reliabilityBuckets,
};
