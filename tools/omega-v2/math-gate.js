'use strict';

/**
 * Omega v2 math gate. Replays stored v2 cards (test/fixtures/omega-v2-cards,
 * last 30 days, 2026-10-31 on) and re-scores them with HEAD rules.
 * Read-only. No network, no Odds API. Spec: stakeaudit GATE_SPEC.md (approved 2026-11-03).
 *
 * A rule fails a day only on or after its effective date. Earlier failures
 * are printed as REPORT and do not block. Exit 1 on any blocking failure.
 */

const fs = require('fs');
const path = require('path');
const {
  KELLY_FRACTION, BANKROLL_UNITS, PER_BET_CAP, STRAIGHT_BUDGET, PARLAY_STAKE_CAP, UNIT_DOLLARS,
} = require('../../netlify/functions/lib/omega-v2/constants');
const { americanToDecimal, ratingToConfidence, EDGE_B_UNIT_CAP } = require('../../netlify/functions/lib/omega-vnext/odds_math');

const FIXTURES = process.env.OMEGA_V2_CARD_FIXTURES
  || path.join(__dirname, '../../test/fixtures/omega-v2-cards');
const V2_FIRST_DAY = '2026-10-31';
const WINDOW_DAYS = 30;
/** Per-rule effective dates (ET card date). b4385ca and 8a197cd deployed 2026-11-03. */
const EFFECTIVE = {
  letter: '2026-11-03',
  units: V2_FIRST_DAY,
  bcap: '2026-11-03',
  parlay: V2_FIRST_DAY,
  confidence: '2026-11-03',
  dollars: '2026-11-04',
};
const BOOKS = new Set(['draftkings', 'hardrockbet']);

const num = (v) => Number(String(v == null ? '' : v).replace(/[−–]/g, '-').replace(/[^0-9.+-]/g, ''));
const roundQuarter = (n) => Math.round((Number(n) + 1e-12) * 4) / 4;
const dollars = (u) => (u > 0 ? Math.ceil(u * UNIT_DOLLARS - 1e-9) : 0);

function letterFor(shownPct) {
  if (shownPct >= 5) return 'aplus';
  if (shownPct >= 3.5) return 'a';
  if (shownPct >= 2) return 'aminus';
  return 'b';
}

function quarterKelly(p, decimal, cap) {
  const b = decimal - 1;
  if (!(b > 0) || !(p > 0) || !(p < 1)) return 0;
  const full = (b * p - (1 - p)) / b;
  if (!(full > 0)) return 0;
  let u = roundQuarter(full * KELLY_FRACTION * BANKROLL_UNITS);
  if (u > cap) u = cap;
  return u < 0.25 ? 0 : u;
}

function checkCard(card, date) {
  const fails = [];
  const add = (rule, msg) => fails.push({ rule, msg, blocking: date >= EFFECTIVE[rule] });
  const pool = Array.isArray(card.parlayPool) ? card.parlayPool : [];
  const poolRow = (p) => pool.find((r) => r.pick === p.pick && r.matchup === p.matchup);
  const pCalOf = (p) => {
    if (Number.isFinite(Number(p.pCal))) return Number(p.pCal);
    const r = poolRow(p);
    return r && Number.isFinite(Number(r.pCal)) ? Number(r.pCal) : null;
  };
  let straightSum = 0;
  for (const p of card.picks || []) {
    const u = num(p.unitsNum != null ? p.unitsNum : p.units);
    straightSum += u;
    const shown = num(p.edgePct);
    const want = letterFor(shown);
    if (p.rating !== want) add('letter', `${p.pick} edge ${p.edgePct} is ${p.rating}, want ${want}`);
    const r = poolRow(p);
    const nv = p.edgeNovig != null ? p.edgeNovig : (r && r.edgeNovig);
    if (nv != null && (Number(nv) * 100).toFixed(1) !== shown.toFixed(1)) {
      add('letter', `${p.pick} shows ${p.edgePct}, no-vig edge is ${(nv * 100).toFixed(1)}%`);
    }
    if (!BOOKS.has(String(p.book || '').toLowerCase())) add('units', `${p.pick} book ${p.book} is not DK/Hard Rock`);
    if (roundQuarter(u) !== u || u > PER_BET_CAP || u < 0.25) add('units', `${p.pick} ${p.units} off the 0.25u grid or outside 0.25-${PER_BET_CAP}u`);
    const pc = pCalOf(p);
    if (pc == null) add('units', `${p.pick} has no stored pCal`);
    else {
      let k = quarterKelly(pc, americanToDecimal(num(p.odds)), PER_BET_CAP);
      if (want === 'b' && date >= EFFECTIVE.bcap && k > EDGE_B_UNIT_CAP) k = EDGE_B_UNIT_CAP;
      // Budget trim and B cap only lower a stake. Above quarter-Kelly is a fail.
      if (u > k + 1e-9) add('units', `${p.pick} ${p.units} above quarter-Kelly ${k}u`);
    }
    if (p.rating === 'b' && u > EDGE_B_UNIT_CAP + 1e-9) add('bcap', `${p.pick} is B at ${p.units} (cap ${EDGE_B_UNIT_CAP}u)`);
    if (Number(p.confidence) !== ratingToConfidence(p.rating)) add('confidence', `${p.pick} confidence ${p.confidence}, want ${ratingToConfidence(p.rating)} for ${p.rating}`);
    if (p.stakeUsd == null) add('dollars', `${p.pick} has no stakeUsd`);
    else if (Number(p.stakeUsd) !== dollars(u)) add('dollars', `${p.pick} stakeUsd ${p.stakeUsd}, want ${dollars(u)}`);
  }
  if (straightSum > STRAIGHT_BUDGET + 1e-9) add('units', `straights ${straightSum}u over ${STRAIGHT_BUDGET}u`);
  for (const t of card.parlayLegs || []) {
    const legs = t.legs || [];
    const prod = legs.reduce((a, l) => a * americanToDecimal(num(l.odds)), 1);
    if (!(Math.abs(prod - Number(t.combinedDecimal)) <= 0.01)) add('parlay', `combined ${t.combinedDecimal} vs leg product ${prod.toFixed(4)}`);
    const tu = num(t.unitsNum != null ? t.unitsNum : t.units);
    if (tu > PARLAY_STAKE_CAP + 1e-9) add('parlay', `ticket ${t.units} over ${PARLAY_STAKE_CAP}u cap`);
    let joint = 1;
    for (const l of legs) {
      const pc = pCalOf(l);
      if (pc == null) { joint = NaN; break; }
      joint *= pc;
    }
    if (!Number.isFinite(joint)) add('parlay', 'a leg has no stored pCal');
    else {
      const k = quarterKelly(joint, prod, PARLAY_STAKE_CAP);
      if (Math.abs(k - tu) > 1e-9) add('parlay', `ticket ${t.units} vs quarter-Kelly ${k}u on joint ${(joint * 100).toFixed(1)}%`);
    }
    if (t.stakeUsd == null) add('dollars', 'ticket has no stakeUsd');
    else if (Number(t.stakeUsd) !== dollars(tu)) add('dollars', `ticket stakeUsd ${t.stakeUsd}, want ${dollars(tu)}`);
  }
  return fails;
}

function loadDays(dir) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^card-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
  return files
    .map((f) => ({ date: f.slice(5, 15), file: path.join(dir, f) }))
    .filter((d) => d.date >= V2_FIRST_DAY)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-WINDOW_DAYS);
}

async function buildCheck() {
  // Check 7: the live v2 module graph loads and a fixture day builds end to end.
  const fails = [];
  try {
    require('../../netlify/functions/lib/omega-vnext/narrate_text');
    const v2 = require('../../netlify/functions/lib/omega-v2');
    const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const row = (matchup, pick, market, odds) => ({
      sport: 'NFL', matchup, pick, market, odds, book: 'draftkings',
      pModel: 0.68, pMkt: 0.5, uncertainty: 0.18, commenceTime: future,
    });
    const card = await v2.buildCard({
      date: '2026-10-20',
      candidates: [
        row('A @ B', 'A ML', 'Moneyline', '-110'),
        row('C @ D', 'Over 45.5', 'Total', '-110'),
        row('E @ F', 'E ML', 'Moneyline', '+120'),
      ],
      history: [],
    });
    if (!Array.isArray(card.picks)) fails.push({ rule: 'build', msg: 'buildCard returned no picks array', blocking: true });
    // New builds must carry whole-dollar stakes.
    for (const f of checkCard(card, '9999-12-31')) {
      if (f.rule === 'dollars' || f.rule === 'bcap' || f.rule === 'confidence') fails.push({ ...f, msg: `fresh build: ${f.msg}` });
    }
  } catch (err) {
    fails.push({ rule: 'build', msg: `card build threw: ${err && err.message}`, blocking: true });
  }
  return fails;
}

async function main() {
  const days = loadDays(FIXTURES);
  let blocking = 0;
  if (!days.length) {
    console.log(`BLOCK no v2 card fixtures in ${FIXTURES}`);
    blocking += 1;
  }
  for (const d of days) {
    const card = JSON.parse(fs.readFileSync(d.file, 'utf8'));
    const fails = checkCard(card, d.date);
    if (!fails.length) { console.log(`${d.date} PASS`); continue; }
    for (const f of fails) {
      console.log(`${d.date} ${f.blocking ? 'BLOCK' : 'REPORT'} [${f.rule}] ${f.msg}`);
      if (f.blocking) blocking += 1;
    }
  }
  const build = await buildCheck();
  if (!build.length) console.log('build PASS');
  for (const f of build) {
    console.log(`build ${f.blocking ? 'BLOCK' : 'REPORT'} [${f.rule}] ${f.msg}`);
    if (f.blocking) blocking += 1;
  }
  if (blocking) {
    console.log(`FAIL omega-v2 math gate: ${blocking} blocking`);
    process.exit(1);
  }
  console.log('PASS omega-v2 math gate');
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { checkCard, letterFor, quarterKelly, EFFECTIVE };
