'use strict';

/**
 * V1 sheet model. The rules are the Good Bet Checker spreadsheet
 * (Goals, Thresholds, Bet Check). This file does not price a game and
 * it does not publish the Edge card.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.V1Sheet = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 'v1-sheet-1018';

  const THRESHOLDS = {
    minEdgePts: 2,
    minEv: 0.02,
    realisticEdgePts: 5,
    auditEdgePts: 10,
    auditEv: 0.10,
    implausibleEdgePts: 24,
    implausibleEv: 0.40,
    unitDollars: 150,
    minProfitDollars: 3,
    minRoi: 0.02,
  };

  const THRESHOLD_NOTES = [
    { key: 'minEdgePts', label: 'Minimum edge (pts)', value: '2', basis: 'Wong 53.5% at -110 is a 2% edge. Buchdahl uses a 2% value threshold. The cutoff is a judgment on those sources.' },
    { key: 'minEv', label: 'Minimum EV', value: '2.0%', basis: 'Buchdahl verified bettors averaged 2.19% against the de-vigged Pinnacle close. Using 2% as the floor is a judgment.' },
    { key: 'realisticEdgePts', label: 'Top of realistic edge band (pts)', value: '5', basis: 'Rule of thumb. A realistic daily edge sits about 1.5 to 4 points. 5 is the high end.' },
    { key: 'auditEdgePts', label: 'Audit edge above (pts)', value: '10', basis: 'Rule of thumb. More than 10 points on a liquid main line is a manual audit, not a bet.' },
    { key: 'auditEv', label: 'Audit EV above', value: '10.0%', basis: 'Rule of thumb. Published short samples top out near 6% to 10%. Above 10% is an audit.' },
    { key: 'implausibleEdgePts', label: 'Implausible edge at or above (pts)', value: '24', basis: 'The old V1 top 10 sat at 24 to 27 points. That is treated as a pipeline defect.' },
    { key: 'implausibleEv', label: 'Implausible EV at or above', value: '40.0%', basis: 'The old V1 top 10 sat at 40% to 83% EV. That is treated as a pipeline defect.' },
    { key: 'unitDollars', label: 'Unit size', value: '$150', basis: '1u = $150.' },
    { key: 'minProfitDollars', label: 'Minimum expected profit per 1u', value: '$3', basis: '2% of a $150 unit, rounded up to whole dollars.' },
    { key: 'minRoi', label: 'Minimum ROI per bet', value: '2.0%', basis: 'Same basis as minimum EV. For one bet, ROI on the stake equals EV.' },
  ];

  const GOALS = {
    straights: { accuracy: 0.55, roi: 0.15 },
    parlays: { accuracy: 0.20, roi: 0.50 },
    clv: { scope: 'All Daily Data', target: 0.02 },
    card: { candidates: 10, straights: 3 },
  };

  const SEASONS = [
    { sport: 'NCAAF', start: '8/23', end: '1/20', months: ['September', 'October', 'November', 'December', 'January'] },
    { sport: 'NFL', start: '9/4', end: '2/8', months: ['September', 'October', 'November', 'December', 'January', 'February'] },
    { sport: 'NHL', start: '10/7', end: '6/20', months: ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June'] },
    { sport: 'NBA', start: '10/21', end: '6/22', months: ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June'] },
    { sport: 'NCAAM', start: '11/3', end: '4/6', months: ['November', 'December', 'January', 'February', 'March'] },
    { sport: 'MLB', start: '3/26', end: '11/1', months: ['April', 'May', 'June', 'July', 'August', 'September', 'October'] },
  ];

  const EXAMPLES = [
    { odds: -110, p: 0.550, note: 'EXAMPLE', verdict: 'GOOD BET', band: 'IN REALISTIC BAND', credibility: 'OK', edge: '2.62', ev: '5.0%', profit: '$8' },
    { odds: 122, p: 0.707, note: 'EXAMPLE - V1 Jets Under at model p', verdict: 'DO NOT BET - AUDIT', band: 'ABOVE BAND', credibility: 'IMPLAUSIBLE', edge: '25.65', ev: '57.0%', profit: '$86' },
    { odds: 327, p: 0.392, note: 'EXAMPLE', verdict: 'DO NOT BET - AUDIT', band: 'ABOVE BAND', credibility: 'IMPLAUSIBLE', edge: '15.78', ev: '67.4%', profit: '$102' },
    { odds: -109, p: 0.623, note: 'EXAMPLE', verdict: 'DO NOT BET - AUDIT', band: 'ABOVE BAND', credibility: 'SUSPECT - AUDIT', edge: '10.15', ev: '19.5%', profit: '$30' },
  ];

  function parseAmerican(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value == null || value === '') return null;
    const n = parseInt(String(value).replace(/[−–—]/g, '-').replace(/[^0-9+-]/g, ''), 10);
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  function decimalFromAmerican(american) {
    return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  }

  function roundTo(n, digits) {
    const f = 10 ** digits;
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  function roundUpAwayFromZero(n) {
    const sign = n < 0 ? -1 : 1;
    const abs = Math.abs(n);
    const nearest = Math.round(abs);
    const whole = Math.abs(abs - nearest) < 1e-9 ? nearest : Math.ceil(abs - 1e-12);
    return sign * whole;
  }

  function formatPct(fraction, digits) {
    return `${(fraction * 100).toFixed(digits)}%`;
  }

  function formatMoney(dollars) {
    const sign = dollars < 0 ? '-' : '';
    return `${sign}$${Math.abs(dollars)}`;
  }

  function edgeBand(edgePts, t) {
    if (edgePts < t.minEdgePts) return 'BELOW BAND';
    if (edgePts <= t.realisticEdgePts) return 'IN REALISTIC BAND';
    return 'ABOVE BAND';
  }

  function credibility(edgePts, ev, t) {
    if (edgePts >= t.implausibleEdgePts || ev >= t.implausibleEv) return 'IMPLAUSIBLE';
    if (edgePts > t.auditEdgePts || ev > t.auditEv) return 'SUSPECT - AUDIT';
    return 'OK';
  }

  function checkBet(odds, p, thresholds) {
    const t = thresholds || THRESHOLDS;
    const american = parseAmerican(odds);
    const prob = Number(p);
    if (american == null || !Number.isFinite(prob) || prob < 0 || prob > 1) return null;
    const decimal = decimalFromAmerican(american);
    const implied = 1 / decimal;
    const edgePts = (prob - implied) * 100;
    const ev = prob * decimal - 1;
    const roi = ev;
    const profit = roundUpAwayFromZero(ev * t.unitDollars);
    const tests = {
      edge: edgePts >= t.minEdgePts,
      ev: ev >= t.minEv,
      roi: roi >= t.minRoi,
      profit: profit >= t.minProfitDollars,
    };
    const band = edgeBand(edgePts, t);
    const cred = credibility(edgePts, ev, t);
    let verdict = 'NO BET';
    if (cred !== 'OK') verdict = 'DO NOT BET - AUDIT';
    else if (tests.edge && tests.ev && tests.roi && tests.profit) verdict = 'GOOD BET';
    return {
      odds: american,
      p: prob,
      decimal: roundTo(decimal, 3),
      implied: implied,
      impliedDisplay: formatPct(implied, 1),
      edgePts: edgePts,
      edgeDisplay: roundTo(edgePts, 2).toFixed(2),
      ev: ev,
      evDisplay: formatPct(ev, 1),
      roi: roi,
      roiDisplay: formatPct(roi, 1),
      profit: profit,
      profitDisplay: formatMoney(profit),
      tests: tests,
      band: band,
      credibility: cred,
      verdict: verdict,
    };
  }

  function selectCard(rows) {
    const checked = [];
    (rows || []).forEach((row, index) => {
      if (!row) return;
      const result = checkBet(row.odds, row.p);
      if (!result) return;
      checked.push(Object.assign({ index: index }, row, result));
    });
    checked.sort((a, b) => b.edgePts - a.edgePts || b.ev - a.ev);
    const top10 = checked.slice(0, GOALS.card.candidates);
    const used = new Set();
    const straights = [];
    for (let i = 0; i < checked.length; i += 1) {
      const row = checked[i];
      if (row.verdict !== 'GOOD BET') continue;
      const game = String(row.matchup || row.game || row.pick || row.index);
      if (used.has(game)) continue;
      used.add(game);
      straights.push(row);
      if (straights.length === GOALS.card.straights) break;
    }
    return { top10: top10, straights: straights };
  }

  return {
    VERSION: VERSION,
    THRESHOLDS: THRESHOLDS,
    THRESHOLD_NOTES: THRESHOLD_NOTES,
    GOALS: GOALS,
    SEASONS: SEASONS,
    EXAMPLES: EXAMPLES,
    parseAmerican: parseAmerican,
    checkBet: checkBet,
    selectCard: selectCard,
  };
}));
