'use strict';

/**
 * Walk-forward replay of the graded derived set.
 * CURRENT is the origin/main probability blend (linear, no intercept).
 * NEW is the log-odds blend with the per-market intercept.
 * No Odds API. No writes except the JSON path in OMEGA_V2_REPLAY_OUT.
 */

const fs = require('fs');
const v2 = require('../../netlify/functions/lib/omega-v2');
const { americanToDecimal } = require('../../netlify/functions/lib/omega-vnext/odds_math');

const DERIVED = process.env.OMEGA_V2_DERIVED
  || '/workspace/omega-sizing-v2/tools/sizing-v2/derived.json';

function parseAmerican(v) {
  const n = Number(String(v == null ? '' : v).replace(/[−–]/g, '-').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function rowsOf(day) {
  const map = new Map();
  const legs = day.parlay && Array.isArray(day.parlay.legs) ? day.parlay.legs : [];
  for (const row of [...(day.straights || []), ...legs]) {
    const key = `${v2.gameKey(row.matchup)}|${String(row.pick || '').toLowerCase()}`;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function candidate(row, date) {
  const odds = parseAmerican(row.odds);
  const pModel = Number(row.pModel);
  const pMkt = Number(row.pMkt);
  if (odds == null || !(pModel > 0 && pModel < 1) || !(pMkt > 0 && pMkt < 1)) return null;
  return {
    sport: row.sport,
    matchup: row.matchup,
    pick: row.pick,
    market: row.market || row.betType,
    odds,
    bestDkHr: { american: odds, book: 'draftkings' },
    book: 'draftkings',
    pModel,
    pMkt,
    commenceTime: row.commenceTime || `${date}T23:00:00Z`,
    result: row.result || null,
    clvPp: row.clvPp != null && row.clvPp !== '' ? Number(row.clvPp) : null,
    line: row.betPoint != null ? row.betPoint : row.line,
  };
}

function asOf(day, cands) {
  let earliest = Infinity;
  for (const c of cands) {
    const t = Date.parse(c.commenceTime || '');
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (Number.isFinite(earliest)) return earliest - 6 * 60 * 1000;
  return Date.parse(`${day.date}T12:00:00Z`);
}

function cellOf(row) {
  return `${String(row.sport || '').toUpperCase()}|${v2.marketFamily(row.market, row.pick)}`;
}

function profitUnits(result, odds, units) {
  if (!(units > 0)) return null;
  if (result === 'push') return 0;
  if (result === 'loss') return -units;
  if (result === 'win') {
    const dec = americanToDecimal(odds);
    if (dec == null) return null;
    return units * (dec - 1);
  }
  return null;
}

function profitDollars(result, stake, odds) {
  if (!(stake > 0)) return null;
  if (result === 'push') return 0;
  if (result === 'loss') return -stake;
  if (result === 'win') {
    const dec = americanToDecimal(odds);
    if (dec == null) return null;
    return Math.ceil(stake * (dec - 1) - 1e-9);
  }
  return null;
}

function settleTicket(ticket) {
  const legs = ticket.legs || [];
  if (!legs.length) return null;
  if (legs.some((leg) => !leg.result || leg.result === 'pending')) return null;
  if (legs.some((leg) => leg.result === 'loss')) return { result: 'loss' };
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

async function runMode(mode, days) {
  v2.setMathMode(mode);
  const hist = [];
  const cells = {};
  let profitU = 0;
  let profitUsd = 0;
  let riskU = 0;
  let riskUsd = 0;
  let clvS = 0;
  let clvN = 0;
  let straightBets = 0;
  let parlayBets = 0;
  let wins = 0;
  let losses = 0;
  for (const day of days) {
    const cands = rowsOf(day).map((row) => candidate(row, day.date)).filter(Boolean);
    const fit = v2.fitWalkForward(hist, day.date);
    for (const c of cands) {
      const cal = v2.applyCalibration(c, fit);
      if (!cal) continue;
      const key = cellOf(c);
      if (!cells[key]) cells[key] = { n: 0, before: 0, after: 0 };
      cells[key].n += 1;
      cells[key].before += c.pModel - c.pMkt;
      cells[key].after += cal.pCal - cal.pMkt;
    }
    const card = await v2.buildCard({
      date: day.date,
      history: hist,
      candidates: cands,
      pregameAsOfMs: asOf(day, cands),
    });
    const seenClv = new Set();
    for (const p of card.picks || []) {
      const u = Number(p.unitsNum);
      const pu = profitUnits(p.result, p.odds, u);
      const pd = profitDollars(p.result, Number(p.stakeUsd), p.odds);
      if (pu == null) continue;
      profitU += pu;
      riskU += p.result === 'push' ? 0 : u;
      if (pd != null) {
        profitUsd += pd;
        riskUsd += p.result === 'push' ? 0 : Number(p.stakeUsd);
      }
      straightBets += 1;
      if (p.result === 'win') wins += 1;
      else if (p.result === 'loss') losses += 1;
      if (p.clvPp != null && Number.isFinite(Number(p.clvPp))) {
        clvS += Number(p.clvPp);
        clvN += 1;
        seenClv.add(`${p.matchup}|${p.pick}`);
      }
    }
    for (const ticket of card.parlayLegs || []) {
      const settled = settleTicket(ticket);
      if (!settled) continue;
      const u = Number(ticket.unitsNum);
      const stake = Number(ticket.stakeUsd);
      let pu = 0;
      let pd = 0;
      if (settled.result === 'loss') {
        pu = -u;
        pd = -stake;
      } else if (settled.result === 'win') {
        pu = u * (settled.decimal - 1);
        pd = Math.ceil(stake * (settled.decimal - 1) - 1e-9);
      }
      profitU += pu;
      profitUsd += pd;
      if (settled.result !== 'push') {
        riskU += u;
        riskUsd += stake;
      }
      parlayBets += 1;
      if (settled.result === 'win') wins += 1;
      else if (settled.result === 'loss') losses += 1;
      for (const leg of ticket.legs || []) {
        const id = `${leg.matchup}|${leg.pick}`;
        if (seenClv.has(id)) continue;
        if (leg.clvPp != null && Number.isFinite(Number(leg.clvPp))) {
          clvS += Number(leg.clvPp);
          clvN += 1;
          seenClv.add(id);
        }
      }
    }
    for (const c of cands) {
      if (c.result === 'win' || c.result === 'loss') hist.push({ ...c, date: day.date });
    }
  }
  const residual = {};
  for (const key of Object.keys(cells).sort()) {
    const g = cells[key];
    residual[key] = {
      n: g.n,
      before: +(g.before / g.n).toFixed(4),
      after: +(g.after / g.n).toFixed(4),
    };
  }
  return {
    mode,
    days: days.length,
    straightBets,
    parlayBets,
    wins,
    losses,
    profitU: +profitU.toFixed(2),
    profitUsd: Math.round(profitUsd),
    riskU: +riskU.toFixed(2),
    riskUsd: Math.round(riskUsd),
    roi: riskU > 0 ? +(profitU / riskU).toFixed(4) : null,
    meanClv: clvN ? +(clvS / clvN).toFixed(4) : null,
    clvN,
    residual,
  };
}

async function main() {
  const derived = JSON.parse(fs.readFileSync(DERIVED, 'utf8'));
  const days = (derived.days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const current = await runMode('linear', days);
  const next = await runMode('logodds', days);
  v2.setMathMode('logodds');
  const out = {
    source: DERIVED,
    window: [days[0] && days[0].date, days[days.length - 1] && days[days.length - 1].date],
    days: days.length,
    current,
    next,
    beatsProfit: next.profitU > current.profitU && next.profitUsd > current.profitUsd,
    beatsClv: next.meanClv != null && current.meanClv != null && next.meanClv > current.meanClv,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
