"use strict";

const {
  familyParams, isPitcherSensitive, isSharp, isRetail, projWeight, isNflPreseason,
} = require("./sports");

const EV_FLOOR = 0.018;
const HOLD_FLOOR = 0.006;
const VIEW_FLOOR = 0.020;
const MAX_PICKS = 3;
const MAX_UNITS_RUN = 3.5;
const MAX_UNITS_PICK = 1.25;
const MIN_UNITS = 0.25;
const ODDS_LO = -220;
const ODDS_HI = 260;
const SHIN_V_FAIL = 0.28;
const EDGE_FLOOR = EV_FLOOR; // exported name kept for callers

function impliedFromAmerican(o) {
  if (o == null || !Number.isFinite(o) || o === 0) return null;
  return o < 0 ? Math.abs(o) / (Math.abs(o) + 100) : 100 / (o + 100);
}
function americanToDecimal(o) {
  if (o == null || !Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
}
function decimalToAmerican(d) {
  if (d == null || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function fmtOdds(o) {
  if (o == null) return "";
  return o > 0 ? `+${o}` : `${o}`;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function shinTwoWay(piA, piB) {
  if (piA == null || piB == null || piA <= 0 || piB <= 0) return null;
  const v = piA + piB - 1;
  if (v > SHIN_V_FAIL) return null;
  if (v <= 1e-12) {
    const s = piA + piB;
    return { pA: piA / s, pB: piB / s, method: "fair", z: 0, overround: v };
  }
  const pAt = (pi, z) => {
    if (z >= 1) return pi;
    return (Math.sqrt(z * z + 4 * (1 - z) * pi * pi) - z) / (2 * (1 - z));
  };
  const g = (z) => pAt(piA, z) + pAt(piB, z) - 1;
  let lo = 0, hi = 0.999999;
  if (!(g(lo) > 0 && g(hi) < 0)) {
    let a = piA - v / 2, b = piB - v / 2;
    a = Math.min(0.98, Math.max(0.02, a));
    b = Math.min(0.98, Math.max(0.02, b));
    const s = a + b;
    return { pA: a / s, pB: b / s, method: "additive", z: null, overround: v };
  }
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;
  const pA = pAt(piA, z), pB = pAt(piB, z);
  const s = pA + pB;
  if (!(s > 0) || !Number.isFinite(pA) || !Number.isFinite(pB)) return null;
  return { pA: pA / s, pB: pB / s, method: "shin", z, overround: v };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.47047 * ax);
  const y = 1 - ((((0.3480242 * t) - 0.0958798) * t + 0.7478556) * t) * Math.exp(-ax * ax);
  return sign * y;
}
function phi(z) {
  if (z > 8) return 1;
  if (z < -8) return 0;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function logPoissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  let lp = -lambda;
  for (let i = 1; i <= k; i++) lp += Math.log(lambda) - Math.log(i);
  return lp;
}
function poissonPmf(k, lambda) { return Math.exp(logPoissonPmf(k, lambda)); }
function poissonCdf(k, lambda) {
  const kk = Math.floor(k);
  if (kk < 0) return 0;
  let s = 0;
  for (let i = 0; i <= kk; i++) s += poissonPmf(i, lambda);
  return Math.min(1, s);
}
function poissonSupport(lambda) {
  return Math.max(12, Math.ceil(4 * Math.max(lambda, 8) + 24));
}

function skellamHomeWin(lh, la, breakTies) {
  const max = Math.max(poissonSupport(lh), poissonSupport(la));
  const ph = new Array(max + 1), pa = new Array(max + 1);
  for (let i = 0; i <= max; i++) {
    ph[i] = poissonPmf(i, lh);
    pa[i] = poissonPmf(i, la);
  }
  let pWin = 0, pTie = 0;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      const p = ph[i] * pa[j];
      if (i > j) pWin += p;
      else if (i === j) pTie += p;
    }
  }
  if (breakTies) {
    const share = (lh + la) > 0 ? lh / (lh + la) : 0.5;
    pWin += pTie * share;
  }
  return { pWin, pTie };
}

function skellamCover(lh, la, k) {
  const max = Math.max(poissonSupport(lh), poissonSupport(la));
  const ph = new Array(max + 1), pa = new Array(max + 1);
  for (let i = 0; i <= max; i++) {
    ph[i] = poissonPmf(i, lh);
    pa[i] = poissonPmf(i, la);
  }
  const integer = Math.abs(k - Math.round(k)) < 1e-9;
  let pWin = 0, pPush = 0;
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      const adj = i + k;
      const p = ph[i] * pa[j];
      if (integer && Math.abs(adj - j) < 1e-9) pPush += p;
      else if (adj > j) pWin += p;
    }
  }
  if (pPush > 0 && pPush < 0.999) pWin = pWin / (1 - pPush);
  return Math.min(0.95, Math.max(0.05, pWin));
}

function totalOverProbPoisson(lambda, line) {
  const integer = Math.abs(line - Math.round(line)) < 1e-9;
  if (integer) {
    const pPush = poissonPmf(Math.round(line), lambda);
    const pOver = 1 - poissonCdf(line, lambda);
    if (pPush > 0 && pPush < 0.999) return Math.min(0.95, Math.max(0.05, pOver / (1 - pPush)));
    return Math.min(0.95, Math.max(0.05, pOver));
  }
  return Math.min(0.95, Math.max(0.05, 1 - poissonCdf(Math.floor(line), lambda)));
}

function roundQuarter(x) { return Math.round(x * 4) / 4; }
function round4(x) { return Math.round(x * 10000) / 10000; }

function unitsFromEv(ev) {
  return Math.min(MAX_UNITS_PICK, Math.max(MIN_UNITS, roundQuarter(10 * ev)));
}
function letterForUnits(u) {
  if (u >= 1.00) return "A";
  if (u >= 0.75) return "A-";
  if (u >= 0.50) return "B+";
  return "B";
}
function confidenceForUnits(u) {
  if (u >= 1.00) return "a";
  if (u >= 0.75) return "aminus";
  if (u >= 0.50) return "bplus";
  return "b";
}

function parseInjuryStatus(status, detail) {
  const s = `${status || ""} ${detail || ""}`.toLowerCase();
  if (/out|injured reserve|\bir\b|suspended|doubtful/.test(s)) return 1;
  if (/questionable|day-to-day|gtd/.test(s)) return 0.4;
  return 0;
}
function isStarterish(detail, name) {
  return /starter|starting|probable starter/.test(`${detail || ""} ${name || ""}`.toLowerCase());
}
function looksPitcher(detail, name, position) {
  return /\bp\b|pitcher|sp\b|starting pitcher/.test(`${detail || ""} ${name || ""} ${position || ""}`.toLowerCase());
}
function looksGoalie(detail, name, position) {
  return /goalie|goaltender|\bg\b/.test(`${detail || ""} ${name || ""} ${position || ""}`.toLowerCase());
}

function injuryImpact(injuries, params, family) {
  if (!injuries || !injuries.length) return 0;
  let impact = 0;
  for (const inj of injuries) {
    const w = parseInjuryStatus(inj.status, inj.detail);
    if (!w) continue;
    if (family === "runs") impact += w * (looksPitcher(inj.detail, inj.name, inj.position) ? params.injPitcher : params.injPos);
    else if (family === "points") impact += w * (isStarterish(inj.detail, inj.name) ? params.injStarter : params.injBench);
    else if (family === "goals") impact += w * (looksGoalie(inj.detail, inj.name, inj.position) ? params.injGoalie : params.injSkater);
  }
  return Math.min(family === "points" ? 9 : family === "runs" ? 1.2 : 1.1, impact);
}

function restDays(playedYesterday) {
  if (playedYesterday === true) return 1;
  return 2;
}

function independentMeans(game, params) {
  const restH = restDays(game.homePlayedYesterday);
  const restA = restDays(game.awayPlayedYesterday);
  const iH = injuryImpact(game.homeInjuries, params, params.family);
  const iA = injuryImpact(game.awayInjuries, params, params.family);
  const sH = game.homeStarterAdj || 0;
  const sA = game.awayStarterAdj || 0;
  const mu = params.mu;
  const h = params.hfa || 0;
  const rho = params.restCoef || 0;
  const muMin = params.muMin;
  const sigmaM = params.sigmaM || Math.sqrt(2 * Math.max(mu, 1));

  let baseH, baseA, source = "mu";
  const pfH = game.homePF, paH = game.homePA, pfA = game.awayPF, paA = game.awayPA;
  if ([pfH, paH, pfA, paA].every(x => Number.isFinite(x) && x > 0)) {
    baseH = 0.5 * (pfH + paA) + h / 2;
    baseA = 0.5 * (pfA + paH) - h / 2;
    source = "espn-pfpa";
  } else if (Number.isFinite(game.homeWinPct) && Number.isFinite(game.awayWinPct)) {
    baseH = mu + h / 2 + (game.homeWinPct - 0.5) * 1.1 * sigmaM;
    baseA = mu - h / 2 + (game.awayWinPct - 0.5) * 1.1 * sigmaM;
    source = "winpct";
  } else {
    baseH = mu + h / 2;
    baseA = mu - h / 2;
  }

  const lh = Math.max(muMin, baseH + rho * (restH - 2) - iH + iA + sH - sA);
  const la = Math.max(muMin, baseA + rho * (restA - 2) - iA + iH + sA - sH);
  return { lh, la, restH, restA, iH, iA, source };
}

function nflKeyBump(pCover, line, side) {
  // line is the handicap on the named side. Ball on 2.5/3.5/6.5/7.5.
  let p = pCover;
  const L = Math.abs(line);
  const favoriteGetting = (side === "home" && line < 0) || (side === "away" && line < 0);
  const bump = (kn, w) => {
    if (L >= kn - 0.5 && L < kn) p += favoriteGetting ? w : -w; // 2.5: favorite does not need the 3
    if (L > kn && L <= kn + 0.5) p += favoriteGetting ? -w : w; // 3.5: favorite must clear 3
  };
  bump(3, 0.018);
  bump(7, 0.012);
  return Math.min(0.92, Math.max(0.08, p));
}

function pProjForMarket(game, market, side, line, params, means) {
  const family = params.family;
  if (family === "fight") {
    const outH = (game.homeInjuries || []).some(i => parseInjuryStatus(i.status, i.detail) >= 1);
    const outA = (game.awayInjuries || []).some(i => parseInjuryStatus(i.status, i.detail) >= 1);
    if (outH || outA) return { fail: "fighter-out" };
    let pHome = 0.5;
    if (Number.isFinite(game.homeWinPct) && Number.isFinite(game.awayWinPct)) {
      pHome = 0.5 + 0.5 * (game.homeWinPct - game.awayWinPct);
    }
    pHome = Math.min(0.72, Math.max(0.28, pHome));
    if (side === "home") return { p: pHome, ...means };
    if (side === "away") return { p: 1 - pHome, ...means };
    return { fail: "mma-ml-only" };
  }

  const { lh, la } = means;

  if (family === "runs" || family === "goals") {
    const breakTies = family === "runs" || game.label === "NHL";
    if (market === "h2h") {
      const { pWin } = skellamHomeWin(lh, la, breakTies);
      return { p: side === "home" ? pWin : 1 - pWin, lh, la };
    }
    if (market === "totals") {
      const pOver = totalOverProbPoisson(lh + la, line);
      return { p: side === "Over" ? pOver : 1 - pOver, lh, la };
    }
    if (market === "spreads") {
      if (side === "home") return { p: skellamCover(lh, la, line), lh, la };
      return { p: skellamCover(la, lh, line), lh, la };
    }
  }

  if (family === "points") {
    const m = lh - la;
    const t = lh + la;
    if (market === "h2h") {
      const pHome = phi(m / params.sigmaM);
      return { p: side === "home" ? pHome : 1 - pHome, lh, la };
    }
    if (market === "totals") {
      const pOver = 1 - phi((line - t) / params.sigmaT);
      return { p: side === "Over" ? pOver : 1 - pOver, lh, la };
    }
    if (market === "spreads") {
      let p = side === "home" ? phi((m + line) / params.sigmaM) : phi((-(m) + line) / params.sigmaM);
      if (game.label === "NFL" || game.label === "NCAAF") p = nflKeyBump(p, line, side);
      return { p, lh, la };
    }
  }
  return { fail: "unsupported-market" };
}

function shiftFairToLine(pFair, fromLine, toLine, market, params) {
  if (fromLine == null || toLine == null || fromLine === toLine) return pFair;
  const d = toLine - fromLine;
  if (market === "totals") {
    const sigma = params.sigmaT || 10;
    // pOver at L0 → back out implied t, then pOver at L1. For Under, pFair is P(under).
    return pFair; // caller passes the matching side's p; we adjust via z-shift
  }
  if (market === "spreads") {
    const sigma = params.sigmaM || 12;
    const z = phiInv(pFair);
    // receiving extra half-point increases cover
    return phi(z + d / sigma);
  }
  return pFair;
}

function phiInv(p) {
  // Acklam inverse-normal approximation
  const a = [0, -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577459590091e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [0, -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [0, -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [0, 7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[1]*q+c[2])*q+c[3])*q+c[4])*q+c[5])*q+c[6]) / ((((d[1]*q+d[2])*q+d[3])*q+d[4])*q+1);
  }
  if (phigh < p) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[1]*q+c[2])*q+c[3])*q+c[4])*q+c[5])*q+c[6]) / ((((d[1]*q+d[2])*q+d[3])*q+d[4])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[1]*r+a[2])*r+a[3])*r+a[4])*r+a[5])*r+a[6])*q / (((((b[1]*r+b[2])*r+b[3])*r+b[4])*r+b[5])*r+1);
}

function shiftTotalFair(pOverFair, sharpLine, retailLine, params, family) {
  if (sharpLine == null || retailLine == null || sharpLine === retailLine) return pOverFair;
  if (family === "points") {
    const sigma = params.sigmaT || 12;
    const z = phiInv(Math.min(0.99, Math.max(0.01, pOverFair)));
    // pOver = 1 - Φ((L-t)/σ) ⇒ z_over = (t-L)/σ. Higher L → lower pOver.
    return phi(z - (retailLine - sharpLine) / sigma);
  }
  // Poisson: back out lambda from pOver then recompute. Approximate with 0.08 per run/goal.
  const shift = (retailLine - sharpLine) * 0.08;
  return Math.min(0.92, Math.max(0.08, pOverFair - shift));
}

function pickLabel(market, side, line, homeTeam, awayTeam) {
  if (market === "h2h") return `${side === "home" ? homeTeam : awayTeam} ML`;
  if (market === "totals") return `${side} ${line}`;
  const team = side === "home" ? homeTeam : awayTeam;
  const v = line > 0 ? `+${line}` : `${line}`;
  return `${team} ${v}`;
}

function inOddsBand(american) {
  return american >= ODDS_LO && american <= ODDS_HI;
}

function twoWayFromBooks(gameOdds, marketKey, homeTeam, awayTeam, filterFn) {
  const books = (gameOdds.bookmakers || []).filter(b => !filterFn || filterFn(b.key));
  books.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  if (marketKey === "h2h") {
    const homePx = [], awayPx = [];
    let n = 0;
    for (const b of books) {
      const m = (b.markets || []).find(x => x.key === "h2h");
      if (!m || (m.outcomes || []).length !== 2) continue;
      const h = m.outcomes.find(o => o.name === homeTeam);
      const a = m.outcomes.find(o => o.name === awayTeam);
      if (!h || !a || h.price == null || a.price == null) continue;
      homePx.push(h.price); awayPx.push(a.price); n++;
    }
    if (!n) return null;
    return {
      market: "h2h", n, line: null,
      home: Math.round(median(homePx)), away: Math.round(median(awayPx)),
    };
  }
  if (marketKey === "totals") {
    const groups = new Map();
    for (const b of books) {
      const m = (b.markets || []).find(x => x.key === "totals");
      if (!m) continue;
      const over = (m.outcomes || []).find(o => o.name === "Over");
      const under = (m.outcomes || []).find(o => o.name === "Under");
      if (!over || !under || over.point == null || over.price == null || under.price == null) continue;
      const line = over.point;
      if (!groups.has(line)) groups.set(line, { over: [], under: [] });
      const g = groups.get(line);
      g.over.push(over.price); g.under.push(under.price);
    }
    let best = null;
    for (const [line, g] of groups) {
      if (!best || g.over.length > best.n || (g.over.length === best.n && line < best.line)) {
        best = { line, n: g.over.length, g };
      }
    }
    if (!best) return null;
    return {
      market: "totals", n: best.n, line: best.line,
      Over: Math.round(median(best.g.over)), Under: Math.round(median(best.g.under)),
    };
  }
  if (marketKey === "spreads") {
    const groups = new Map();
    for (const b of books) {
      const m = (b.markets || []).find(x => x.key === "spreads");
      if (!m) continue;
      const h = (m.outcomes || []).find(o => o.name === homeTeam);
      const a = (m.outcomes || []).find(o => o.name === awayTeam);
      if (!h || !a || h.point == null || a.point == null || h.price == null || a.price == null) continue;
      const line = h.point;
      if (!groups.has(line)) groups.set(line, { home: [], away: [], awayLine: a.point });
      const g = groups.get(line);
      g.home.push(h.price); g.away.push(a.price);
    }
    let best = null;
    for (const [line, g] of groups) {
      if (!best || g.home.length > best.n || (g.home.length === best.n && Math.abs(line) < Math.abs(best.line))) {
        best = { line, n: g.home.length, g };
      }
    }
    if (!best) return null;
    return {
      market: "spreads", n: best.n, lineHome: best.line, lineAway: best.g.awayLine,
      home: Math.round(median(best.g.home)), away: Math.round(median(best.g.away)),
    };
  }
  return null;
}

function bestRetailQuotes(gameOdds, marketKey, homeTeam, awayTeam) {
  const out = [];
  for (const b of (gameOdds.bookmakers || [])) {
    if (!isRetail(b.key)) continue;
    const m = (b.markets || []).find(x => x.key === marketKey);
    if (!m) continue;
    if (marketKey === "h2h") {
      for (const side of ["home", "away"]) {
        const name = side === "home" ? homeTeam : awayTeam;
        const o = (m.outcomes || []).find(x => x.name === name);
        if (o && o.price != null) out.push({ side, line: null, american: o.price, decimal: americanToDecimal(o.price), book: b.key });
      }
    } else if (marketKey === "totals") {
      for (const side of ["Over", "Under"]) {
        const o = (m.outcomes || []).find(x => x.name === side);
        if (o && o.price != null && o.point != null) out.push({ side, line: o.point, american: o.price, decimal: americanToDecimal(o.price), book: b.key });
      }
    } else if (marketKey === "spreads") {
      for (const side of ["home", "away"]) {
        const name = side === "home" ? homeTeam : awayTeam;
        const o = (m.outcomes || []).find(x => x.name === name);
        if (o && o.price != null && o.point != null) out.push({ side, line: o.point, american: o.price, decimal: americanToDecimal(o.price), book: b.key });
      }
    }
  }
  // keep best decimal per (side, line)
  const best = new Map();
  for (const q of out) {
    const k = `${q.side}|${q.line}`;
    const prev = best.get(k);
    if (!prev || q.decimal > prev.decimal) best.set(k, q);
  }
  return [...best.values()];
}

function shinFromTwoWay(tw, market) {
  if (!tw) return null;
  if (market === "h2h") return shinTwoWay(impliedFromAmerican(tw.home), impliedFromAmerican(tw.away));
  if (market === "totals") return shinTwoWay(impliedFromAmerican(tw.Over), impliedFromAmerican(tw.Under));
  if (market === "spreads") return shinTwoWay(impliedFromAmerican(tw.home), impliedFromAmerican(tw.away));
  return null;
}

function fairSide(shin, market, side) {
  if (!shin) return null;
  if (market === "totals") return side === "Over" ? shin.pA : shin.pB;
  return side === "home" ? shin.pA : shin.pB;
}

function evaluateGame(game, gameOdds, predPrice) {
  const params = familyParams(game.label, game.family, game);
  const rejections = [];
  const candidates = [];
  const homeTeam = gameOdds.home_team || game.homeTeam;
  const awayTeam = gameOdds.away_team || game.awayTeam;
  const means = independentMeans(game, params);
  const w = projWeight(game);
  const nBooks = (gameOdds.bookmakers || []).length;

  const tryMarket = (marketKey) => {
    if (isPitcherSensitive(game.label, marketKey) && !game.homeStarter && !game.awayStarter) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "pitcher-sensitive market with no starter" });
      return;
    }
    const sharpTW = twoWayFromBooks(gameOdds, marketKey, homeTeam, awayTeam, isSharp);
    const allTW = twoWayFromBooks(gameOdds, marketKey, homeTeam, awayTeam, null);
    const tw = sharpTW || allTW;
    if (!tw) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "two-way odds missing" });
      return;
    }
    const shin = shinFromTwoWay(tw, marketKey);
    if (!shin || (shin.overround != null && shin.overround < -0.005)) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "de-vig failed (overround or missing prices)" });
      return;
    }
    const retail = bestRetailQuotes(gameOdds, marketKey, homeTeam, awayTeam);
    if (!retail.length) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "no US retail quote" });
      return;
    }

    const sharpLine = marketKey === "totals" ? tw.line : marketKey === "spreads" ? tw.lineHome : null;

    for (const q of retail) {
      if (!inOddsBand(q.american)) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: q.side, reason: `odds ${fmtOdds(q.american)} outside [${ODDS_LO}, ${ODDS_HI}]` });
        continue;
      }
      const lineForSide = marketKey === "spreads"
        ? (q.side === "home" ? q.line : q.line)
        : q.line;

      const proj = pProjForMarket(game, marketKey, q.side, lineForSide, params, means);
      if (proj.fail) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: q.side, reason: proj.fail });
        continue;
      }

      let pFair = fairSide(shin, marketKey, q.side === "away" && marketKey === "spreads" ? "away" : q.side);
      if (marketKey === "totals" && sharpLine != null && q.line != null && q.line !== sharpLine) {
        let pOverFair = shin.pA;
        pOverFair = shiftTotalFair(pOverFair, sharpLine, q.line, params, params.family);
        pFair = q.side === "Over" ? pOverFair : 1 - pOverFair;
      } else if (marketKey === "spreads" && tw.lineHome != null && q.side === "home" && q.line !== tw.lineHome) {
        pFair = shiftFairToLine(shin.pA, tw.lineHome, q.line, "spreads", params);
      } else if (marketKey === "spreads" && tw.lineAway != null && q.side === "away" && q.line !== tw.lineAway) {
        pFair = shiftFairToLine(shin.pB, tw.lineAway, q.line, "spreads", params);
      }

      if (pFair == null) continue;
      // Totals at ~even should not come back as 90%+ — that's an exchange/alt-line artifact.
      if (marketKey === "totals" && (pFair > 0.72 || pFair < 0.28)) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: q.side, reason: `fair ${ (pFair*100).toFixed(1) }% on a total is not a two-way main` });
        continue;
      }
      if (marketKey === "spreads" && Math.abs(lineForSide) >= 10 && game.family === "fight") {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: q.side, reason: "UFC alt spread skipped" });
        continue;
      }

      let pModel = w * proj.p + (1 - w) * pFair;
      if (predPrice && predPrice.market === marketKey && predPrice.side === q.side && predPrice.price > 0.05 && predPrice.price < 0.95) {
        pModel = 0.92 * pModel + 0.08 * predPrice.price;
      }
      pModel = Math.min(0.92, Math.max(0.08, pModel));

      const ev = pModel * q.decimal - 1;
      const holdEv = pFair * q.decimal - 1;
      const viewGap = Math.abs(proj.p - pFair);
      const edge = pModel - pFair;

      // Never bet a worse number than sharp no-vig (holdEv must be positive).
      // Independent projection may upgrade a lag; it may not fade Pinnacle.
      // Hold > 10% on a main is almost always a broken two-way / alt line.
      if (ev < EV_FLOOR || holdEv < HOLD_FLOOR || holdEv > 0.10 || ev > 0.18) {
        rejections.push({
          matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: q.side,
          reason: `EV ${(ev * 100).toFixed(2)}% hold ${(holdEv * 100).toFixed(2)}% view ${(viewGap * 100).toFixed(2)}pt below floor`,
        });
        continue;
      }

      const units = unitsFromEv(ev);
      candidates.push({
        sport: game.label,
        family: game.family,
        matchup: `${awayTeam} @ ${homeTeam}`,
        homeTeam, awayTeam,
        pick: pickLabel(marketKey, q.side, lineForSide, homeTeam, awayTeam),
        side: q.side,
        market: marketKey,
        betType: marketKey === "h2h" ? "Moneyline" : marketKey === "totals" ? "Total" : "Spread",
        line: lineForSide,
        odds: fmtOdds(q.american),
        oddsAmerican: q.american,
        book: q.book,
        units,
        rating: letterForUnits(units),
        confidence: confidenceForUnits(units),
        pModel: round4(pModel),
        pMarket: round4(pFair),
        pProj: round4(proj.p),
        edge: round4(edge),
        ev: round4(ev),
        holdEv: round4(holdEv),
        modelEdge: `${(ev * 100).toFixed(1)}% EV vs ${sharpTW ? "sharp Shin" : "consensus Shin"}`,
        commenceTime: gameOdds.commence_time,
        nBooks,
        shinMethod: shin.method + (sharpTW ? "/sharp" : "/consensus"),
        projSource: means.source,
        projWeight: w,
        reasoning: reasonText(game, params, means, proj, pFair, pModel, ev, holdEv, marketKey, q, sharpTW),
      });
    }
  };

  tryMarket("h2h");
  tryMarket("spreads");
  tryMarket("totals");
  return { candidates, rejections };
}

function reasonText(game, params, means, proj, pFair, pModel, ev, holdEv, market, q, sharpTW) {
  const bits = [];
  bits.push(`${(ev * 100).toFixed(1)}% EV at ${q.book} ${fmtOdds(q.american)} (hold ${(holdEv * 100).toFixed(1)}%).`);
  bits.push(`p_model ${(pModel * 100).toFixed(1)}% = ${Math.round(projWeight(game) * 100)}% proj ${(proj.p * 100).toFixed(1)}% + fair ${(pFair * 100).toFixed(1)}% (${sharpTW ? "sharp" : "consensus"} Shin).`);
  if (proj.lh != null) bits.push(`Proj ${game.awayTeam} ${proj.la.toFixed(2)} / ${game.homeTeam} ${proj.lh.toFixed(2)} ${params.family} (${means.source}).`);
  if (means.restH === 1 || means.restA === 1) bits.push(`Short rest: away ${means.restA}d home ${means.restH}d.`);
  if (means.iH || means.iA) bits.push(`Injury impact away ${means.iA.toFixed(2)} home ${means.iH.toFixed(2)}.`);
  if (game.homeStarter || game.awayStarter) bits.push(`Starters ${game.awayStarter || "n/a"} vs ${game.homeStarter || "n/a"}.`);
  if (isNflPreseason(game)) bits.push("NFL preseason μ=17.4; records unused.");
  bits.push("Grok Beta v0.2 sharp-retail + independent proj. Not Alpha.");
  return bits.join(" ");
}

function parlayEv(legs) {
  const p = legs.reduce((s, l) => s * l.pModel, 1);
  const d = legs.reduce((s, l) => s * americanToDecimal(l.oddsAmerican), 1);
  return p * d - 1;
}

function parlayAmerican(legs) {
  const d = legs.reduce((s, l) => s * americanToDecimal(l.oddsAmerican), 1);
  return fmtOdds(decimalToAmerican(d));
}

function combinations(arr, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < arr.length; i++) rec(i + 1, acc.concat([arr[i]]));
  };
  rec(0, []);
  return out;
}

function scoreSet(set) {
  const straight = set.reduce((s, p) => s + p.ev, 0);
  const pev = parlayEv(set);
  const nSports = new Set(set.map(p => p.sport)).size;
  const nMarkets = new Set(set.map(p => p.betType)).size;
  const allOvers = set.every(p => String(p.pick).toLowerCase().startsWith("over"));
  return straight + 0.55 * pev + 0.05 * (nSports - 1) + 0.04 * (nMarkets - 1) - (allOvers ? 0.06 : 0);
}

function selectAndCap(candidates) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.ev !== a.ev) return b.ev - a.ev;
    const m = String(a.matchup).localeCompare(String(b.matchup));
    if (m) return m;
    return String(a.market).localeCompare(String(b.market));
  });
  const seen = new Set();
  const unique = [];
  for (const c of sorted) {
    if (seen.has(c.matchup)) continue;
    seen.add(c.matchup);
    unique.push({ ...c });
  }

  let picks;
  if (unique.length <= MAX_PICKS) {
    picks = unique;
  } else {
    const pool = unique.slice(0, 12);
    let best = null, bestScore = -Infinity;
    for (const set of combinations(pool, MAX_PICKS)) {
      const sc = scoreSet(set);
      if (sc > bestScore) { bestScore = sc; best = set; }
    }
    picks = best || pool.slice(0, MAX_PICKS);
  }

  let total = picks.reduce((s, p) => s + p.units, 0);
  if (total > MAX_UNITS_RUN && total > 0) {
    const scale = MAX_UNITS_RUN / total;
    for (const p of picks) {
      p.units = Math.max(MIN_UNITS, roundQuarter(p.units * scale));
      p.rating = letterForUnits(p.units);
      p.confidence = confidenceForUnits(p.units);
    }
  }

  let parlay = null;
  if (picks.length >= 2) {
    const pev = parlayEv(picks);
    if (pev > 0) {
      const pu = picks.every(p => p.ev >= 0.03) && picks.length === 3 ? 0.5 : 0.25;
      parlay = {
        name: `${picks.length}-leg Grok Beta parlay`,
        combinedOdds: parlayAmerican(picks),
        units: pu,
        ev: round4(pev),
        legs: picks.map(p => ({
          sport: p.sport,
          matchup: p.matchup,
          pick: p.pick,
          odds: p.odds,
          commenceTime: p.commenceTime,
        })),
      };
    }
  }
  return { picks, parlay };
}

module.exports = {
  EDGE_FLOOR, EV_FLOOR, MAX_PICKS, MAX_UNITS_RUN, MAX_UNITS_PICK, MIN_UNITS,
  impliedFromAmerican, americanToDecimal, shinTwoWay, evaluateGame, selectAndCap,
  fmtOdds, letterForUnits, parlayEv,
};
