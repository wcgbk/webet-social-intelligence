'use strict';
/**
 * V1 formula-first projection (Lock §2): ratings -> formula spread/total ->
 * raw model probability at the bet line. NO market blend, NO shrink, NO
 * calibrate — the market is contacted only after, as the Pinnacle receipt
 * (§4.3, power de-vig) and the named bet-book price (§3 line 4).
 * Shared low-level utilities only: footballProjection (ratings core,
 * HFA NFL 2.0 / NCAAF 2.6 inside), probability conversions, market-bundle
 * parsing, power de-vig. Omega's calibrate/select/gates are NOT used.
 * Zero hand-set points: QB status never enters this module (§7.4).
 */
const { footballProjection } = require('../omega-vnext/sports/epa');
const { spreadCoverProb, totalCoverProb, mlFromSpread, formatMatchup } = require('../omega-vnext/sports/_common');
const { collectMarketOutcomes } = require('../omega-vnext/edge');
const { noVigTwoWay, formatAmerican } = require('../omega-vnext/odds_math');
const { US_BOOKS } = require('../omega-vnext/config');
const { anchorWeightForV1, biasCorrectionForV1 } = require('./config-v1');

function pinnaclePairV1(bundles, target) {
  if (!target) return null;
  const opp = (bundles || []).find(s => s !== target
    && (target.point == null ? s.side !== target.side
      : (/over|under/i.test(target.side) ? (/over|under/i.test(s.side) && s.side !== target.side && s.point === target.point)
        : (s.point === -target.point || s.point === target.point) && s.side !== target.side)));
  if (!opp) return null;
  const a1 = (target.prices || []).find(p => p.book === 'pinnacle');
  const a2 = (opp.prices || []).find(p => p.book === 'pinnacle');
  if (!a1 || !a2 || !Number.isFinite(a1.american) || !Number.isFinite(a2.american)) return null;
  const nv = noVigTwoWay(a1.american, a2.american); // power de-vig (Lock §4.3)
  if (!nv) return null;
  return { pFair: nv.p1, pinAmerican: a1.american, pinOppAmerican: a2.american,
    receiptPoint: target.point, k: nv.k };
}
function bestBetPriceV1(target) {
  let best = null;
  for (const p of (target && target.prices) || []) {
    if (!US_BOOKS.includes(p.book)) continue;
    if (!Number.isFinite(p.american)) continue;
    if (!best || p.american > best.american) best = p;
  }
  return best; // {book, american} at this exact line (bundle is per-line)
}
/** One game -> V1 candidates. Ratings-missing games emit a pass record. */
function projectGameV1(event, sport, efficiency, meta = {}) {
  const home = event.home_team, away = event.away_team;
  const commenceTime = event.commence_time;
  const env = footballProjection({ sport, home, away, standings: {}, efficiency: efficiency || {} });
  const matchup = formatMatchup(away, home);
  const formulaComplete = !!(env && env.usedEpa && Number.isFinite(env.modelMargin) && Number.isFinite(env.modelTotal));
  if (!formulaComplete) {
    return { candidates: [], pass: { matchup, sport, commenceTime,
      reason: 'lock-missing-formula', detail: 'ratings inputs missing (no EPA rating for one or both teams)' } };
  }
  const bias = biasCorrectionForV1(sport, commenceTime);
  const modelMargin = env.modelMargin - bias; // home margin, bias within window only
  const modelTotal = env.modelTotal;
  const qb = meta.qbByGame && meta.qbByGame[matchup];
  const qbFlag = qb && qb.flag ? qb.flag : null;
  const qbUnknown = !!(qb && qb.unknownReplacement);
  const base = { sport, homeTeam: home, awayTeam: away, matchup, commenceTime,
    formulaSpreadHome: +modelMargin.toFixed(2), formulaTotal: +modelTotal.toFixed(2),
    biasCorrectionPts: bias, projMethod: env.methods && env.methods.family,
    qbFlag, qbUnknownReplacement: qbUnknown, boardSlot: meta.boardSlot || null };
  const out = [];
  const emit = (bundles, build) => {
    for (const b of bundles) {
      if (b.point === undefined) continue;
      const built = build(b);
      if (!built) continue;
      const pin = pinnaclePairV1(bundles, b);
      const bet = bestBetPriceV1(b);
      const w = anchorWeightForV1(sport, built.market);
      const pModel = built.pModel;
      const pFair = pin ? pin.pFair : null;
      const anchored = (pFair != null && w != null && Number.isFinite(pModel))
        ? w * pModel + (1 - w) * pFair : null;
      out.push({ ...base, ...built,
        modelPureP: Number.isFinite(pModel) ? +pModel.toFixed(6) : null,
        pFair: pFair != null ? +pFair.toFixed(6) : null,
        anchorWeight: w,
        coverProb: anchored != null ? +anchored.toFixed(6) : null,
        pinnacleReceipt: pin ? { point: pin.receiptPoint, american: pin.pinAmerican,
          oppAmerican: pin.pinOppAmerican, powerK: pin.k } : null,
        receiptSpreadHome: sport && pin ? receiptSpreadHome(bundles, home) : null,
        receiptTotal: receiptTotal(bundles),
        odds: bet ? bet.american : null,
        oddsStr: bet ? formatAmerican(bet.american) : null,
        book: bet ? bet.book : null });
    }
  };
  emit(collectMarketOutcomes(event, 'h2h'), (b) => {
    const isHome = b.side === home;
    const p = isHome ? mlFromSpread(modelMargin, sport) : 1 - mlFromSpread(modelMargin, sport);
    return { market: 'Moneyline', side: b.side, line: null, pModel: p };
  });
  emit(collectMarketOutcomes(event, 'spreads'), (b) => {
    if (b.point == null) return null;
    const isHome = b.side === home;
    const p = spreadCoverProb(isHome ? modelMargin : -modelMargin, b.point, sport);
    return { market: 'Spread', side: b.point > 0 ? `${b.side} +${b.point}` : `${b.side} ${b.point}`,
      line: b.point, pModel: p };
  });
  emit(collectMarketOutcomes(event, 'totals'), (b) => {
    if (b.point == null) return null;
    const p = totalCoverProb(modelTotal, b.point, b.side, sport);
    return { market: 'Total', side: `${b.side} ${b.point}`, line: b.point, pModel: p };
  });
  return { candidates: out, pass: null };
}
function receiptSpreadHome(bundles, home) {
  const b = (bundles || []).find(x => x.side === home && x.point != null);
  return b ? b.point : null;
}
function receiptTotal(bundles) {
  const b = (bundles || []).find(x => x.point != null);
  return b ? b.point : null;
}
function projectAllV1(events, efficiencyBySport, meta = {}) {
  const candidates = [], passes = [];
  for (const ev of events || []) {
    const sport = ev.sport;
    if (sport !== 'NFL' && sport !== 'NCAAF') continue; // football only (Lock scope)
    try {
      const r = projectGameV1(ev, sport, (efficiencyBySport || {})[sport] || {}, meta);
      candidates.push(...r.candidates);
      if (r.pass) passes.push(r.pass);
    } catch (e) {
      passes.push({ matchup: `${ev.away_team} @ ${ev.home_team}`, sport,
        commenceTime: ev.commence_time, reason: 'lock-missing-formula', detail: e.message });
    }
  }
  return { candidates, passes };
}
module.exports = { projectGameV1, projectAllV1, pinnaclePairV1, bestBetPriceV1 };
