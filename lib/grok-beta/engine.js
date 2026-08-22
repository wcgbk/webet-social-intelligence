"use strict";

const { familyParams, isPitcherSensitive, US_RETAIL } = require("./sports");

const EDGE_FLOOR = 0.048;
const EV_FLOOR = 0.055;
const MAX_PICKS = 7;
const MAX_UNITS_RUN = 5.0;
const MAX_UNITS_PICK = 1.25;
const MIN_UNITS = 0.25;
const ODDS_LO = -200;
const ODDS_HI = 240;
const SHIN_V_FAIL = 0.28;

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
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

// Shin 1993 two-way de-vig. Distinct from proportional (π/Σπ) de-vig.
// z is the unique root in [0,1) of Σ p_i(z) = 1, with
// p_i(z) = (sqrt(z² + 4(1-z)π_i²) - z) / (2(1-z)).
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
  // g(0)=v>0, g(0.999)<0 for typical overrounds — bisect.
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

// Abramowitz & Stegun 7.1.26 — coefficients chosen here, not copied from Alpha.
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
function poissonPmf(k, lambda) {
  return Math.exp(logPoissonPmf(k, lambda));
}
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
    pTie = 0;
  }
  return { pWin, pTie };
}

function skellamCover(lh, la, k) {
  // P(Xh + k > Xa), push if Xh + k == Xa on integer k.
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
    const pOver = 1 - poissonCdf(line, lambda); // P(sum >= line+1)
    if (pPush > 0 && pPush < 0.999) return Math.min(0.95, Math.max(0.05, pOver / (1 - pPush)));
    return Math.min(0.95, Math.max(0.05, pOver));
  }
  return Math.min(0.95, Math.max(0.05, 1 - poissonCdf(Math.floor(line), lambda)));
}

function roundQuarter(x) {
  return Math.round(x * 4) / 4;
}

function unitsFromEdge(edge, pModel) {
  const raw = 7 * edge * Math.sqrt(Math.max(0, pModel * (1 - pModel)));
  return Math.min(MAX_UNITS_PICK, Math.max(MIN_UNITS, roundQuarter(raw)));
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
  const s = `${detail || ""} ${name || ""}`.toLowerCase();
  return /starter|starting|probable starter/.test(s);
}
function looksPitcher(detail, name, position) {
  const s = `${detail || ""} ${name || ""} ${position || ""}`.toLowerCase();
  return /\bp\b|pitcher|sp\b|starting pitcher/.test(s);
}
function looksGoalie(detail, name, position) {
  const s = `${detail || ""} ${name || ""} ${position || ""}`.toLowerCase();
  return /goalie|goaltender|g\b/.test(s);
}

function injuryImpact(injuries, params, family) {
  if (!injuries || !injuries.length) return 0;
  let impact = 0;
  for (const inj of injuries) {
    const w = parseInjuryStatus(inj.status, inj.detail);
    if (!w) continue;
    if (family === "runs") {
      impact += w * (looksPitcher(inj.detail, inj.name, inj.position) ? params.injPitcher : params.injPos);
    } else if (family === "points") {
      impact += w * (isStarterish(inj.detail, inj.name) ? params.injStarter : params.injBench);
    } else if (family === "goals") {
      impact += w * (looksGoalie(inj.detail, inj.name, inj.position) ? params.injGoalie : params.injSkater);
    }
  }
  return Math.min(family === "points" ? 9 : family === "runs" ? 1.2 : 1.1, impact);
}

function restDays(playedYesterday) {
  if (playedYesterday === true) return 1;
  if (playedYesterday === false) return 3;
  return 2;
}

function teamMeans(game, params, anchor) {
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
  let baseH, baseA;
  if (anchor && anchor.total != null && Number.isFinite(anchor.total) && anchor.homeSpread != null && Number.isFinite(anchor.homeSpread)) {
    baseH = (anchor.total - anchor.homeSpread) / 2;
    baseA = (anchor.total + anchor.homeSpread) / 2;
  } else if (anchor && anchor.total != null && Number.isFinite(anchor.total)) {
    baseH = anchor.total / 2 + h / 2;
    baseA = anchor.total / 2 - h / 2;
  } else {
    baseH = mu + h / 2;
    baseA = mu - h / 2;
  }
  const lh = Math.max(muMin, baseH + rho * (restH - 2) - iH + iA + sH - sA);
  const la = Math.max(muMin, baseA + rho * (restA - 2) - iA + iH + sA - sH);
  return { lh, la, restH, restA, iH, iA };
}

function pModelForMarket(game, market, side, line, params, anchor) {
  const family = params.family;
  if (family === "fight") {
    const outH = (game.homeInjuries || []).some(i => parseInjuryStatus(i.status, i.detail) >= 1);
    const outA = (game.awayInjuries || []).some(i => parseInjuryStatus(i.status, i.detail) >= 1);
    if (outH || outA) return { fail: "fighter-out" };
    const gap = restDays(game.homePlayedYesterday) - restDays(game.awayPlayedYesterday);
    let pHome = 0.5 + 0.03 * Math.sign(gap);
    if (side === "home") return { p: pHome };
    if (side === "away") return { p: 1 - pHome };
    return { fail: "mma-ml-only" };
  }

  const { lh, la } = teamMeans(game, params, anchor);

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
      // `line` is the points the `side` team is getting.
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
      // `line` is the handicap on the named side (home -5.5 → line=-5.5).
      if (side === "home") return { p: phi((m + line) / params.sigmaM), lh, la };
      return { p: phi((-(m) + line) / params.sigmaM), lh, la };
    }
  }

  return { fail: "unsupported-market" };
}

function collectTwoWay(gameOdds, marketKey, homeTeam, awayTeam) {
  const books = (gameOdds.bookmakers || []).slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
  if (marketKey === "h2h") {
    const homePx = [], awayPx = [], homeRetail = [], awayRetail = [];
    const homeImplied = [], awayImplied = [];
    for (const b of books) {
      const m = (b.markets || []).find(x => x.key === "h2h");
      if (!m || (m.outcomes || []).length !== 2) continue;
      const h = m.outcomes.find(o => o.name === homeTeam);
      const a = m.outcomes.find(o => o.name === awayTeam);
      if (!h || !a || h.price == null || a.price == null) continue;
      homePx.push(h.price); awayPx.push(a.price);
      homeImplied.push(impliedFromAmerican(h.price));
      awayImplied.push(impliedFromAmerican(a.price));
      if (US_RETAIL.has(String(b.key).toLowerCase())) {
        homeRetail.push(h.price); awayRetail.push(a.price);
      }
    }
    if (!homePx.length) return null;
    return {
      market: "h2h",
      home: { median: Math.round(median(homePx)), bestRetail: homeRetail.length ? Math.max(...homeRetail.map(americanToDecimal)) : americanToDecimal(median(homePx)), implieds: homeImplied },
      away: { median: Math.round(median(awayPx)), bestRetail: awayRetail.length ? Math.max(...awayRetail.map(americanToDecimal)) : americanToDecimal(median(awayPx)), implieds: awayImplied },
      nBooks: homePx.length,
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
      if (!groups.has(line)) groups.set(line, { over: [], under: [], overR: [], underR: [], overI: [], underI: [] });
      const g = groups.get(line);
      g.over.push(over.price); g.under.push(under.price);
      g.overI.push(impliedFromAmerican(over.price)); g.underI.push(impliedFromAmerican(under.price));
      if (US_RETAIL.has(String(b.key).toLowerCase())) {
        g.overR.push(over.price); g.underR.push(under.price);
      }
    }
    // Consensus line = most-booked total, tie → median line.
    let best = null;
    for (const [line, g] of groups) {
      if (!best || g.over.length > best.n || (g.over.length === best.n && line < best.line)) {
        best = { line, n: g.over.length, g };
      }
    }
    if (!best) return null;
    const g = best.g;
    return {
      market: "totals", line: best.line, nBooks: best.n,
      Over: { median: Math.round(median(g.over)), bestRetail: g.overR.length ? Math.max(...g.overR.map(americanToDecimal)) : americanToDecimal(median(g.over)), implieds: g.overI },
      Under: { median: Math.round(median(g.under)), bestRetail: g.underR.length ? Math.max(...g.underR.map(americanToDecimal)) : americanToDecimal(median(g.under)), implieds: g.underI },
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
      if (!groups.has(line)) groups.set(line, { home: [], away: [], homeR: [], awayR: [], homeI: [], awayI: [], awayLine: a.point });
      const g = groups.get(line);
      g.home.push(h.price); g.away.push(a.price);
      g.homeI.push(impliedFromAmerican(h.price)); g.awayI.push(impliedFromAmerican(a.price));
      if (US_RETAIL.has(String(b.key).toLowerCase())) {
        g.homeR.push(h.price); g.awayR.push(a.price);
      }
    }
    let best = null;
    for (const [line, g] of groups) {
      if (!best || g.home.length > best.n || (g.home.length === best.n && Math.abs(line) < Math.abs(best.line))) {
        best = { line, n: g.home.length, g };
      }
    }
    if (!best) return null;
    const g = best.g;
    return {
      market: "spreads", lineHome: best.line, lineAway: g.awayLine, nBooks: best.n,
      home: { median: Math.round(median(g.home)), bestRetail: g.homeR.length ? Math.max(...g.homeR.map(americanToDecimal)) : americanToDecimal(median(g.home)), implieds: g.homeI },
      away: { median: Math.round(median(g.away)), bestRetail: g.awayR.length ? Math.max(...g.awayR.map(americanToDecimal)) : americanToDecimal(median(g.away)), implieds: g.awayI },
    };
  }
  return null;
}

const EDGE_CLIP = 0.10; // day-one hard cap on |p_model - p_market|

function shrinkToMarket(pRaw, pMkt, implieds) {
  const cv = (implieds && implieds.length >= 2 && implieds[0] != null)
    ? stdev(implieds.filter(x => x != null)) / Math.max(1e-6, implieds.reduce((s, x) => s + x, 0) / implieds.length)
    : 0;
  const w = 1 / (1 + 10 * cv * cv);
  let p = w * pRaw + (1 - w) * pMkt;
  if (p - pMkt > EDGE_CLIP) p = pMkt + EDGE_CLIP;
  if (pMkt - p > EDGE_CLIP) p = pMkt - EDGE_CLIP;
  return { p, w, cv };
}

function blendPredMarket(pFeat, pmPrice) {
  if (pmPrice == null || pmPrice <= 0.05 || pmPrice >= 0.95) return pFeat;
  return 0.88 * pFeat + 0.12 * pmPrice;
}

function priceSide({ pRaw, pMkt, implieds, bestDecimal, consensusAmerican, pmPrice }) {
  if (pRaw == null || pMkt == null) return null;
  const shrunk = shrinkToMarket(pRaw, pMkt, implieds);
  let pModel = blendPredMarket(shrunk.p, pmPrice);
  pModel = Math.min(0.95, Math.max(0.05, pModel));
  const edge = pModel - pMkt;
  const d = bestDecimal || americanToDecimal(consensusAmerican);
  const ev = pModel * d - 1;
  return { pModel, pMarket: pMkt, edge, ev, shrinkW: shrunk.w, cv: shrunk.cv, decimal: d };
}

function inOddsBand(american) {
  return american >= ODDS_LO && american <= ODDS_HI;
}

function pickLabel(market, side, line, homeTeam, awayTeam) {
  if (market === "h2h") return `${side === "home" ? homeTeam : awayTeam} ML`;
  if (market === "totals") return `${side} ${line}`;
  const team = side === "home" ? homeTeam : awayTeam;
  const v = line > 0 ? `+${line}` : `${line}`;
  return `${team} ${v}`;
}

function evaluateGame(game, gameOdds, predPrice) {
  const params = familyParams(game.label, game.family);
  const rejections = [];
  const candidates = [];
  const homeTeam = gameOdds.home_team || game.homeTeam;
  const awayTeam = gameOdds.away_team || game.awayTeam;
  const twTotals = collectTwoWay(gameOdds, "totals", homeTeam, awayTeam);
  const twSpreads = collectTwoWay(gameOdds, "spreads", homeTeam, awayTeam);
  const anchor = {
    total: twTotals && twTotals.line != null ? twTotals.line : null,
    homeSpread: twSpreads && twSpreads.lineHome != null ? twSpreads.lineHome : null,
  };

  const tryMarket = (marketKey) => {
    const tw = collectTwoWay(gameOdds, marketKey, homeTeam, awayTeam);
    if (!tw) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "two-way odds missing" });
      return;
    }
    if (isPitcherSensitive(game.label, marketKey) && !game.homeStarter && !game.awayStarter) {
      rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, reason: "pitcher-sensitive market with no starter" });
      return;
    }

    const sides = [];
    if (marketKey === "h2h") {
      const shin = shinTwoWay(impliedFromAmerican(tw.home.median), impliedFromAmerican(tw.away.median));
      if (!shin) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: "h2h", reason: "de-vig failed (overround or missing prices)" });
        return;
      }
      sides.push({ side: "home", line: null, twSide: tw.home, pMkt: shin.pA, shin });
      sides.push({ side: "away", line: null, twSide: tw.away, pMkt: shin.pB, shin });
    } else if (marketKey === "totals") {
      const shin = shinTwoWay(impliedFromAmerican(tw.Over.median), impliedFromAmerican(tw.Under.median));
      if (!shin) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: "totals", reason: "de-vig failed" });
        return;
      }
      sides.push({ side: "Over", line: tw.line, twSide: tw.Over, pMkt: shin.pA, shin });
      sides.push({ side: "Under", line: tw.line, twSide: tw.Under, pMkt: shin.pB, shin });
    } else if (marketKey === "spreads") {
      const shin = shinTwoWay(impliedFromAmerican(tw.home.median), impliedFromAmerican(tw.away.median));
      if (!shin) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: "spreads", reason: "de-vig failed" });
        return;
      }
      sides.push({ side: "home", line: tw.lineHome, twSide: tw.home, pMkt: shin.pA, shin });
      sides.push({ side: "away", line: tw.lineAway, twSide: tw.away, pMkt: shin.pB, shin });
    }

    for (const s of sides) {
      const modeled = pModelForMarket(game, marketKey, s.side, s.line, params, anchor);
      if (modeled.fail) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: s.side, reason: modeled.fail });
        continue;
      }
      const neutralGame = {
        ...game,
        homeInjuries: [], awayInjuries: [],
        homePlayedYesterday: undefined, awayPlayedYesterday: undefined,
        homeStarterAdj: 0, awayStarterAdj: 0,
      };
      const baseline = pModelForMarket(neutralGame, marketKey, s.side, s.line, params, anchor);
      if (!baseline.fail && baseline.p != null) {
        modeled.delta = modeled.p - baseline.p;
        modeled.pNeutral = baseline.p;
        modeled.p = s.pMkt + modeled.delta;
      }
      const american = s.twSide.median;
      if (!inOddsBand(american)) {
        rejections.push({ matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: s.side, reason: `odds ${fmtOdds(american)} outside [${ODDS_LO}, ${ODDS_HI}]` });
        continue;
      }
      const pm = predPrice && predPrice.market === marketKey && predPrice.side === s.side ? predPrice.price : null;
      const priced = priceSide({
        pRaw: modeled.p,
        pMkt: s.pMkt,
        implieds: s.twSide.implieds,
        bestDecimal: s.twSide.bestRetail,
        consensusAmerican: american,
        pmPrice: pm,
      });
      if (!priced) continue;
      if (priced.edge < EDGE_FLOOR || priced.ev < EV_FLOOR) {
        rejections.push({
          matchup: `${awayTeam} @ ${homeTeam}`, market: marketKey, side: s.side,
          reason: `edge ${(priced.edge * 100).toFixed(2)}pt EV ${(priced.ev * 100).toFixed(2)}% below floor`,
        });
        continue;
      }
      const bestAm = decimalToAmerican(priced.decimal) ?? american;
      const units = unitsFromEdge(priced.edge, priced.pModel);
      const pickName = pickLabel(marketKey, s.side, s.line, homeTeam, awayTeam);
      candidates.push({
        sport: game.label,
        family: game.family,
        matchup: `${awayTeam} @ ${homeTeam}`,
        homeTeam, awayTeam,
        pick: pickName,
        side: s.side,
        market: marketKey,
        betType: marketKey === "h2h" ? "Moneyline" : marketKey === "totals" ? "Total" : "Spread",
        line: s.line,
        odds: fmtOdds(bestAm),
        oddsAmerican: bestAm,
        consensusOdds: fmtOdds(american),
        units,
        rating: letterForUnits(units),
        confidence: confidenceForUnits(units),
        pModel: round4(priced.pModel),
        pMarket: round4(priced.pMarket),
        edge: round4(priced.edge),
        ev: round4(priced.ev),
        modelEdge: `${(priced.edge * 100).toFixed(1)}pt vs Shin market`,
        commenceTime: gameOdds.commence_time,
        nBooks: tw.nBooks,
        shinMethod: s.shin.method,
        shrinkW: round4(priced.shrinkW),
        reasoning: featureReason(game, params, modeled, priced, marketKey, s),
      });
    }
  };

  tryMarket("h2h");
  tryMarket("spreads");
  tryMarket("totals");

  return { candidates, rejections };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

function featureReason(game, params, modeled, priced, market, s) {
  const bits = [];
  bits.push(`Shin p_market ${(priced.pMarket * 100).toFixed(1)}% vs p_model ${(priced.pModel * 100).toFixed(1)}% (${(priced.edge * 100).toFixed(1)} pt, EV ${(priced.ev * 100).toFixed(1)}%).`);
  if (modeled.lh != null) bits.push(`Scoring means ${game.awayTeam} ${modeled.la.toFixed(2)} / ${game.homeTeam} ${modeled.lh.toFixed(2)} ${params.family}.`);
  const restH = restDays(game.homePlayedYesterday);
  const restA = restDays(game.awayPlayedYesterday);
  if (restH !== 2 || restA !== 2) bits.push(`Rest: away ${restA}d, home ${restH}d.`);
  const nH = (game.homeInjuries || []).filter(i => parseInjuryStatus(i.status, i.detail) > 0).length;
  const nA = (game.awayInjuries || []).filter(i => parseInjuryStatus(i.status, i.detail) > 0).length;
  if (nH || nA) bits.push(`Injury flags: away ${nA}, home ${nH}.`);
  if (game.homeStarter || game.awayStarter) bits.push(`Starters: ${game.awayStarter || "n/a"} vs ${game.homeStarter || "n/a"}.`);
  bits.push(`Not Alpha. Grok Beta family=${params.family} market=${market} ${s.side}.`);
  return bits.join(" ");
}

function selectAndCap(candidates) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.edge !== a.edge) return b.edge - a.edge;
    const m = String(a.matchup).localeCompare(String(b.matchup));
    if (m) return m;
    return String(a.market).localeCompare(String(b.market));
  });
  // One pick per matchup (highest edge).
  const seen = new Set();
  const unique = [];
  for (const c of sorted) {
    if (seen.has(c.matchup)) continue;
    seen.add(c.matchup);
    unique.push(c);
    if (unique.length >= MAX_PICKS) break;
  }
  let total = unique.reduce((s, p) => s + p.units, 0);
  if (total > MAX_UNITS_RUN && total > 0) {
    const scale = MAX_UNITS_RUN / total;
    for (const p of unique) {
      p.units = Math.max(0, roundQuarter(p.units * scale));
      if (p.units > 0 && p.units < MIN_UNITS) p.units = MIN_UNITS;
      p.rating = letterForUnits(p.units);
      p.confidence = confidenceForUnits(p.units);
    }
  }
  return unique.filter(p => p.units >= MIN_UNITS);
}

module.exports = {
  EDGE_FLOOR, EV_FLOOR, MAX_PICKS, MAX_UNITS_RUN, MAX_UNITS_PICK, MIN_UNITS,
  impliedFromAmerican, americanToDecimal, shinTwoWay, evaluateGame, selectAndCap,
  fmtOdds, letterForUnits,
};
