'use strict';

/**
 * Omega v2 math gate. Replays stored v2 cards (test/fixtures/omega-v2-cards,
 * last 30 days, 2026-10-31 on) and re-scores them with HEAD rules.
 * Fixtures must come from stored cards and include stakeUsd on every straight
 * and parlay ticket (refresh with tools/omega-v2/refresh-fixtures.js).
 * Read-only. No network, no Odds API. Spec: stakeaudit GATE_SPEC.md (approved 2026-11-03).
 *
 * Card fixtures are not the only input. The same letter, stake, and B-cap
 * rules also run on the results blob and the public picks JSON for each
 * card date: get-results-omega days (stakeDollars, rating), the picks-{date}
 * blob those handlers read, and any public trim refresh-fixtures.js saved
 * outside the hand-aligned card fixture. Offline files only.
 *
 * A rule fails a day only on or after its effective date. Earlier failures
 * are printed as REPORT and do not block. Exit 1 on any blocking failure.
 */

const fs = require('fs');
const path = require('path');
const {
  KELLY_FRACTION, BANKROLL_UNITS, PER_BET_CAP, STRAIGHT_BUDGET, PARLAY_STAKE_CAP, UNIT_DOLLARS,
  MODEL_SPORTS,
} = require('../../netlify/functions/lib/omega-v2/constants');
const { americanToDecimal, ratingToConfidence, EDGE_B_UNIT_CAP } = require('../../netlify/functions/lib/omega-vnext/odds_math');

const FIXTURES = process.env.OMEGA_V2_CARD_FIXTURES
  || path.join(__dirname, '../../test/fixtures/omega-v2-cards');
const V2_FIRST_DAY = '2026-10-31';
const WINDOW_DAYS = 30;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$/;
/** Per-rule effective dates (ET card date). b4385ca and 8a197cd deployed 2026-11-03. */
const EFFECTIVE = {
  letter: '2026-11-03',
  units: V2_FIRST_DAY,
  bcap: '2026-11-03',
  parlay: V2_FIRST_DAY,
  parlayBook: '2026-11-03',
  confidence: '2026-11-03',
  dollars: '2026-11-04',
};
const BOOKS = new Set(['draftkings', 'hardrockbet']);
/** Parlay legs accept the same aliases straights canonicalize (hardrock, hardrockbet_oh). */
const PARLAY_BOOKS = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);

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
    for (const l of legs) {
      const posted = String(l.book || '').toLowerCase();
      if (!posted) continue;
      if (!PARLAY_BOOKS.has(posted)) add('parlayBook', `${l.pick} book ${l.book} is not DK/Hard Rock`);
    }
    let joint = 1;
    for (const l of legs) {
      const pc = pCalOf(l);
      if (pc == null) { joint = NaN; break; }
      joint *= pc;
    }
    if (!Number.isFinite(joint)) add('parlay', 'a leg has no stored pCal');
    else {
      const b = prod - 1;
      const full = b > 0 ? (b * joint - (1 - joint)) / b : 0;
      const raw = full > 0 ? full * KELLY_FRACTION * BANKROLL_UNITS : 0;
      const stepped = full > 0 ? roundQuarter(raw) : 0;
      const k = quarterKelly(joint, prod, PARLAY_STAKE_CAP);
      // Nearest 0.25u. A positive quarter-Kelly that steps to 0 must not be published at 0.25u.
      if (raw > 0 && stepped < 0.25 && tu >= 0.25) {
        add('parlay', `ticket ${t.units} floors sub-0.25u quarter-Kelly (raw ${raw.toFixed(3)}u rounds to 0)`);
      } else if (Math.abs(k - tu) > 1e-9) add('parlay', `ticket ${t.units} vs quarter-Kelly ${k}u on joint ${(joint * 100).toFixed(1)}%`);
    }
    if (t.stakeUsd == null) add('dollars', 'ticket has no stakeUsd');
    else if (Number(t.stakeUsd) !== dollars(tu)) add('dollars', `ticket stakeUsd ${t.stakeUsd}, want ${dollars(tu)}`);
  }
  return fails;
}

function normLetter(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[−–]/g, '-').replace(/\s+/g, '');
  if (s === 'a+' || s === 'aplus') return 'aplus';
  if (s === 'a-' || s === 'aminus') return 'aminus';
  if (s === 'b+' || s === 'bplus') return 'bplus';
  return s;
}

function windowDates(dates) {
  return [...new Set((dates || []).filter((d) => DATE_RE.test(d) && d >= V2_FIRST_DAY))].sort().slice(-WINDOW_DAYS);
}

function publishedRoots() {
  const roots = [];
  const add = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  add(process.env.OMEGA_V2_RESULTS);
  add(process.env.OMEGA_V2_PUBLIC);
  add(process.env.OMEGA_V2_BLOBS);
  add(path.join(path.dirname(FIXTURES), 'omega-v2-results'));
  add(FIXTURES);
  return roots;
}

function isPublishedName(name, skipCards) {
  if (skipCards && name.startsWith('card-')) return false;
  if (/^card-\d{4}-\d{2}-\d{2}\.json$/.test(name)) return true;
  if (/^picks-\d{4}-\d{2}-\d{2}(?:\.json)?$/.test(name)) return true;
  if (/^(?:res|results|public)-\d{4}-\d{2}-\d{2}\.json$/.test(name)) return true;
  if (/^results-omega-cache/.test(name)) return true;
  return false;
}

function filesInRoot(root, skipCards) {
  if (!root || !fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!isPublishedName(name, skipCards)) continue;
    const full = path.join(root, name);
    if (fs.statSync(full).isFile()) out.push(full);
  }
  return out;
}

function dateFromName(file) {
  const m = path.basename(file).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function kindOf(doc) {
  const picks = (doc && doc.picks) || [];
  const graded = picks.some((p) => p && (p.stakeDollars != null || p.result != null) && (p.edgePct == null || p.edgePct === ''));
  if (graded && !doc.parlayPool && !doc.parlayLegs) return 'results';
  if (doc && (doc.parlayLegs || picks.some((p) => p && p.edgePct != null && p.edgePct !== ''))) return 'public';
  return 'results';
}

function pushDoc(out, doc, file, fallbackDate) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.picks)) return;
  const date = (typeof doc.date === 'string' && DATE_RE.test(doc.date) && doc.date) || fallbackDate;
  if (!date) return;
  out.push({ date, doc, file, kind: kindOf(doc) });
}

function expandPublished(json, file) {
  const out = [];
  const fallback = dateFromName(file);
  if (Array.isArray(json)) {
    for (const day of json) pushDoc(out, day, file, fallback);
    return out;
  }
  if (json && Array.isArray(json.days)) {
    for (const day of json.days) pushDoc(out, day, file, null);
    return out;
  }
  pushDoc(out, json, file, fallback);
  return out;
}

function dayFingerprint(date, doc) {
  const rows = [];
  for (const p of (doc && doc.picks) || []) {
    rows.push([p && p.pick, p && p.matchup, p && p.rating, p && p.grade, p && p.units, p && p.stakeUsd, p && p.stakeDollars, p && p.edgePct].join('|'));
  }
  for (const t of (doc && doc.parlayLegs) || []) {
    rows.push(['ticket', t && t.units, t && t.stakeUsd, t && t.stakeDollars].join('|'));
  }
  return `${date}#${rows.join(';')}`;
}

/**
 * Offline results / public picks. A pointed-at file is always read.
 * A directory contributes blob keys and per-date dumps, not the hand-aligned
 * card fixtures when the directory is the card-fixture root.
 */
function loadPublished(roots, opts) {
  const list = Array.isArray(roots) ? roots : publishedRoots();
  const fixtureRoot = (opts && opts.fixtureRoot) || FIXTURES;
  const seenFile = new Set();
  const items = [];
  const errors = [];
  for (const root of list) {
    if (!root) continue;
    const skipCards = path.resolve(root) === path.resolve(fixtureRoot);
    for (const file of filesInRoot(root, skipCards)) {
      const abs = path.resolve(file);
      if (seenFile.has(abs)) continue;
      seenFile.add(abs);
      let json;
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        errors.push({ file, msg: err && err.message });
        continue;
      }
      items.push(...expandPublished(json, file));
    }
  }
  const keep = new Set(windowDates(items.map((item) => item.date)));
  const seenDay = new Set();
  const published = [];
  for (const item of items) {
    if (!keep.has(item.date)) continue;
    const fp = dayFingerprint(item.date, item.doc);
    if (seenDay.has(fp)) continue;
    seenDay.add(fp);
    published.push(item);
  }
  published.sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
  return { items: published, errors };
}

function isParlayRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.sport || '').toUpperCase() === 'PARLAY') return true;
  if (normLetter(row.rating) === 'p' || String(row.rating || '').trim().toUpperCase() === 'P') return true;
  if (Array.isArray(row.legs)) return true;
  return false;
}

function unitsOfRow(row) {
  if (!row) return NaN;
  return num(row.unitsNum != null ? row.unitsNum : row.units);
}

function findCardRow(card, row) {
  if (!card || !row) return null;
  const pool = [];
  for (const p of card.picks || []) pool.push(p);
  for (const t of card.parlayLegs || []) {
    for (const leg of t.legs || []) pool.push(leg);
  }
  const name = row.pick;
  if (!name) return null;
  const hits = pool.filter((p) => p && (p.pick === name || p.pickDisplay === name));
  if (row.matchup) {
    const matched = hits.filter((p) => p.matchup === row.matchup);
    if (matched.length) return matched[0];
  }
  return hits[0] || null;
}

function rowEdge(row, cardRow) {
  if (row && row.edgePct != null && row.edgePct !== '') return row.edgePct;
  if (cardRow && cardRow.edgePct != null && cardRow.edgePct !== '') return cardRow.edgePct;
  return null;
}

/**
 * Letter, stake, and B-cap on a results day or a public/stored picks card.
 * Letter uses the row's printed edge, or the paired card fixture's edge when
 * the results row does not store one. Parlay tickets are stake-only.
 */
function checkPublished(doc, date, card, meta) {
  const fails = [];
  const src = meta && meta.file ? path.basename(meta.file) : 'results';
  const add = (rule, msg) => fails.push({
    rule,
    msg: `${src}: ${msg}`,
    blocking: !!(EFFECTIVE[rule] && date >= EFFECTIVE[rule]),
    source: src,
  });
  const straights = [];
  for (const row of (doc && doc.picks) || []) {
    if (!isParlayRow(row)) straights.push(row);
    else checkStake(row, 'parlay', card, add);
  }
  for (const row of straights) checkStraight(row, card, add);
  for (const ticket of (doc && doc.parlayLegs) || []) {
    checkStake(ticket, 'parlay', card, add);
    for (const leg of ticket.legs || []) {
      const posted = String(leg && leg.book || '').toLowerCase();
      if (posted && !PARLAY_BOOKS.has(posted)) {
        add('parlayBook', `${leg.pick || leg.side} book ${leg.book} is not DK/Hard Rock`);
      }
      if (!isParlayRow(leg)) checkStraight(leg, card, add, { leg: true });
    }
  }
  return fails;
}

function checkStake(row, role, card, add) {
  const label = (row && (row.pick || row.type)) || (role === 'parlay' ? 'ticket' : 'pick');
  const u = unitsOfRow(row);
  if (!(u > 0)) {
    add('units', `${label} has no stake units`);
    return;
  }
  if (role !== 'parlay') {
    if (roundQuarter(u) !== u || u > PER_BET_CAP || u < 0.25) {
      add('units', `${label} ${row.units} off the 0.25u grid or outside 0.25-${PER_BET_CAP}u`);
    }
  } else if (roundQuarter(u) !== u || u < 0.25) {
    add('units', `${label} ${row.units} off the 0.25u grid`);
  }
  const want = dollars(u);
  const hasUsd = row.stakeUsd != null && row.stakeUsd !== '';
  const hasDollars = row.stakeDollars != null && row.stakeDollars !== '';
  if (hasUsd && Number(row.stakeUsd) !== want) add('dollars', `${label} stakeUsd ${row.stakeUsd}, want ${want}`);
  if (hasDollars && Number(row.stakeDollars) !== want) add('dollars', `${label} stakeDollars ${row.stakeDollars}, want ${want}`);
  if (!hasUsd && !hasDollars && role !== 'leg') add('dollars', `${label} has no stakeUsd or stakeDollars`);
  if (role === 'straight' && card) {
    const cardRow = findCardRow(card, row);
    if (cardRow) {
      const cu = unitsOfRow(cardRow);
      if (Number.isFinite(cu) && Math.abs(cu - u) > 1e-9) {
        add('units', `${label} stake ${row.units} vs card ${cardRow.units}`);
      }
    }
  }
}

function checkStraight(row, card, add, opts) {
  const leg = opts && opts.leg;
  checkStake(row, leg ? 'leg' : 'straight', card, add);
  const cardRow = findCardRow(card, row);
  const edge = rowEdge(row, cardRow);
  const shown = edge == null ? null : num(edge);
  const want = shown == null || Number.isNaN(shown) ? null : letterFor(shown);
  if (want) {
    const bad = [];
    if (normLetter(row.rating) !== want) bad.push(`rating ${row.rating}`);
    if (row.grade != null && row.grade !== '' && normLetter(row.grade) !== want) bad.push(`grade ${row.grade}`);
    if (row.qualityGrade != null && row.qualityGrade !== '' && normLetter(row.qualityGrade) !== want) bad.push(`qualityGrade ${row.qualityGrade}`);
    if (bad.length) add('letter', `${row.pick} edge ${edge} is ${bad.join(', ')}, want ${want}`);
  }
  if (!leg) {
    const storedB = [row.rating, row.grade, row.qualityGrade].some((value) => normLetter(value) === 'b');
    const u = unitsOfRow(row);
    if (storedB && u > EDGE_B_UNIT_CAP + 1e-9) {
      add('bcap', `${row.pick} is B at ${row.units} (cap ${EDGE_B_UNIT_CAP}u)`);
    }
  }
  if (row.confidence != null && row.confidence !== '') {
    const stored = normLetter(row.rating) || normLetter(row.grade) || normLetter(row.qualityGrade);
    if (stored && Number(row.confidence) !== ratingToConfidence(stored)) {
      add('confidence', `${row.pick} confidence ${row.confidence}, want ${ratingToConfidence(stored)} for ${stored}`);
    }
  }
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
      const freshBook = f.rule === 'parlayBook';
      const freshFloor = f.rule === 'parlay' && /floors sub-0\.25u/.test(f.msg);
      if (f.rule === 'dollars' || f.rule === 'bcap' || f.rule === 'confidence' || freshBook || freshFloor) {
        fails.push({ ...f, msg: `fresh build: ${f.msg}` });
      }
    }
  } catch (err) {
    fails.push({ rule: 'build', msg: `card build threw: ${err && err.message}`, blocking: true });
  }
  return fails;
}

function logFails(date, fails) {
  let blocking = 0;
  for (const f of fails) {
    console.log(`${date} ${f.blocking ? 'BLOCK' : 'REPORT'} [${f.rule}] ${f.msg}`);
    if (f.blocking) blocking += 1;
  }
  return blocking;
}

/**
 * Every enabled model sport must receive a calibrated probability on a
 * one-row replay. A thin NCAAM slate must leave the projector on the sharp fair.
 */
async function sportReachCheck() {
  const fails = [];
  const { SPORTS_ENABLED } = require('../../netlify/functions/lib/omega-vnext/config');
  const ncaam = require('../../netlify/functions/lib/omega-vnext/sports/ncaam');
  const v2 = require('../../netlify/functions/lib/omega-v2');
  for (const sport of MODEL_SPORTS) {
    if (SPORTS_ENABLED[sport] !== true) {
      fails.push({ rule: 'sports', msg: `${sport} is not enabled`, blocking: true });
    }
  }
  const event = {
    home_team: 'Home College',
    away_team: 'Away College',
    commence_time: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    bookmakers: ['pinnacle', 'draftkings'].map((key) => ({
      key,
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Away College', price: 150 }, { name: 'Home College', price: -170 }] },
        { key: 'spreads', outcomes: [{ name: 'Away College', price: -110, point: 4.5 }, { name: 'Home College', price: -110, point: -4.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 145.5 }, { name: 'Under', price: -110, point: 145.5 }] },
      ],
    })),
  };
  const projected = ncaam.project({ oddsEvents: [event], standings: {} });
  if (!projected.length) {
    fails.push({ rule: 'sports', msg: 'NCAAM projector returned no rows', blocking: true });
  } else {
    const ml = projected.find((row) => row.market === 'Moneyline' && row.side === 'Away College');
    if (!ml || !Number.isFinite(Number(ml.modelRawP)) || !Number.isFinite(Number(ml.fair_sharp_p))) {
      fails.push({ rule: 'sports', msg: 'NCAAM moneyline has no model or Pinnacle fair', blocking: true });
    } else if (Math.abs(Number(ml.modelRawP) - Number(ml.fair_sharp_p)) > 0.02) {
      fails.push({ rule: 'sports', msg: 'thin NCAAM slate did not anchor to the sharp fair', blocking: true });
    }
  }
  const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  for (const sport of MODEL_SPORTS) {
    const card = await v2.buildCard({
      date: '2026-11-04',
      candidates: [{
        sport,
        matchup: 'Away @ Home',
        pick: 'Away ML',
        market: 'Moneyline',
        odds: '-110',
        book: 'draftkings',
        pModel: 0.56,
        pMkt: 0.50,
        commenceTime: future,
      }],
      history: [],
    });
    const rows = [...(card.picks || []), ...(card.rejections || [])].filter((row) => row.sport === sport);
    const scored = rows.some((row) => Number.isFinite(Number(row.pCal)) && row.reason !== 'missing-prob' && row.reason !== 'no-dk-hr-price');
    if (!scored) {
      fails.push({ rule: 'sports', msg: `${sport} did not reach scoring on replay`, blocking: true });
    }
  }
  return fails;
}

/**
 * Board games with nothing scored warn and attempt one market-anchored
 * rescore. The card still publishes. A rescore that throws is a warning,
 * not a block. Every model sport is a row on the coverage report.
 */
async function coverageCheck() {
  const fails = [];
  const { applySportCoverage } = require('../../netlify/functions/lib/omega-v2/coverage');
  const v2 = require('../../netlify/functions/lib/omega-v2');
  const want = ['NBA', 'NCAAM', 'NFL', 'NCAAF', 'NHL'];
  const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  const boardEvent = {
    home_team: 'Home College',
    away_team: 'Away College',
    commence_time: future,
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [
        { name: 'Away College', price: 150 }, { name: 'Home College', price: -170 },
      ] }] },
      { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [
        { name: 'Away College', price: 140 }, { name: 'Home College', price: -160 },
      ] }] },
    ],
  };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((part) => String(part)).join(' '));
  };
  const add = (msg) => fails.push({ rule: 'coverage', msg, blocking: true });
  const rowFor = (report, sport) => ((report && report.rows) || []).find((row) => row.sport === sport);
  const missingSports = (report) => want.filter((sport) => !rowFor(report, sport));
  const attempt = (action) => action === 'auto-corrected' || action === 'no-score-warn';
  const published = (card) => {
    const empty = card.picks.length === 0 && (card.parlayLegs || []).length === 0;
    return !empty || card.pass === true;
  };
  try {
    const stageCounts = { board: { NBA: 1 }, raw: { NBA: 0 } };
    const boardBySport = { NBA: [boardEvent] };
    let report = null;
    try {
      report = applySportCoverage([], stageCounts, { boardBySport, candidates: [] });
    } catch (err) {
      add(`zero-score coverage threw: ${err && err.message}`);
    }
    const nba = rowFor(report, 'NBA');
    if (!nba) add('NBA missing from coverage report after a board with 0 scored');
    else if (!attempt(nba.action)) add(`NBA action ${nba.action} is not an auto-correct attempt`);
    else if (nba.scored !== 0 || !(nba.board > 0)) {
      add(`NBA board=${nba.board} scored=${nba.scored}, want games on the board and 0 scored`);
    }
    if (!warnings.some((line) => line.includes('[coverage]') && line.includes('NBA') && /scored=0/.test(line))) {
      add('zero-score board did not log a [coverage] warning');
    }
    const gapSports = missingSports(report);
    if (report && gapSports.length) add(`coverage report missing ${gapSports.join(', ')}`);

    let card = null;
    let cardErr = null;
    try {
      card = await v2.buildCard({
        date: '2026-11-04',
        candidates: [],
        history: [],
        stageCounts,
        boardBySport,
      });
    } catch (err) {
      cardErr = err;
    }
    if (cardErr || !card || !Array.isArray(card.picks)) {
      add(`zero-score board blocked the card: ${cardErr && cardErr.message}`);
    } else {
      const cardNba = rowFor(card.sportCoverage, 'NBA');
      if (!cardNba || !attempt(cardNba.action)) {
        add(`published card NBA action ${cardNba && cardNba.action} did not record the auto-correct`);
      }
      const cardGap = missingSports(card.sportCoverage);
      if (cardGap.length) add(`published card coverage report missing ${cardGap.join(', ')}`);
      if (!published(card)) add('zero-score board built a card but did not publish the pass');
    }

    const boomBoard = new Proxy({}, {
      get() { throw new Error('rescore failed'); },
    });
    const boomCounts = { board: { NHL: 2 }, raw: { NHL: 1 } };
    let boomReport = null;
    let boomErr = null;
    try {
      boomReport = applySportCoverage([], boomCounts, { boardBySport: boomBoard, candidates: [] });
    } catch (err) {
      boomErr = err;
    }
    if (boomErr) add(`auto-correct throw escaped applySportCoverage: ${boomErr.message}`);
    else {
      const nhl = rowFor(boomReport, 'NHL');
      if (!nhl || nhl.action !== 'no-score-warn') {
        add(`throwing auto-correct action ${nhl && nhl.action}, want no-score-warn`);
      }
      const boomGap = missingSports(boomReport);
      if (boomGap.length) add(`throwing auto-correct dropped ${boomGap.join(', ')} from the report`);
    }
    if (!warnings.some((line) => line.includes('[coverage]') && line.includes('auto-correct failed'))) {
      add('throwing auto-correct did not warn');
    }

    let boomCard = null;
    let boomCardErr = null;
    try {
      boomCard = await v2.buildCard({
        date: '2026-11-04',
        candidates: [],
        history: [],
        stageCounts: boomCounts,
        boardBySport: boomBoard,
      });
    } catch (err) {
      boomCardErr = err;
    }
    if (boomCardErr || !boomCard || !Array.isArray(boomCard.picks)) {
      add(`throwing auto-correct blocked publish: ${boomCardErr && boomCardErr.message}`);
    } else if (!published(boomCard)) {
      add('throwing auto-correct returned a card that did not publish');
    } else {
      const boomGap = missingSports(boomCard.sportCoverage);
      if (boomGap.length) add(`published card after a throwing auto-correct missing ${boomGap.join(', ')}`);
    }
  } finally {
    console.warn = origWarn;
  }
  return fails;
}

async function main() {
  const days = loadDays(FIXTURES);
  const cards = new Map();
  let blocking = 0;
  if (!days.length) {
    console.log(`BLOCK no v2 card fixtures in ${FIXTURES}`);
    blocking += 1;
  }
  for (const d of days) {
    const card = JSON.parse(fs.readFileSync(d.file, 'utf8'));
    cards.set(d.date, card);
    const fails = checkCard(card, d.date);
    if (!fails.length) console.log(`${d.date} PASS`);
    else blocking += logFails(d.date, fails);
  }
  const published = loadPublished(publishedRoots(), { fixtureRoot: FIXTURES });
  for (const err of published.errors) {
    console.log(`BLOCK [results] unreadable ${path.basename(err.file)}: ${err.msg}`);
    blocking += 1;
  }
  if (!published.items.length && !published.errors.length) {
    console.log('results PASS no separate results or public blob');
  }
  const byKey = new Map();
  for (const item of published.items) {
    const key = `${item.date}\0${item.file}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  for (const item of published.items) {
    const key = `${item.date}\0${item.file}`;
    if (byKey.get(key) === null) continue;
    const group = byKey.get(key);
    byKey.set(key, null);
    const fails = [];
    for (const one of group) fails.push(...checkPublished(one.doc, one.date, cards.get(one.date), one));
    if (!fails.length) console.log(`${item.date} ${item.kind} PASS ${path.basename(item.file)}`);
    else blocking += logFails(item.date, fails);
  }
  const build = await buildCheck();
  const sports = await sportReachCheck();
  build.push(...sports);
  if (!build.length) console.log('build PASS');
  for (const f of build) {
    console.log(`build ${f.blocking ? 'BLOCK' : 'REPORT'} [${f.rule}] ${f.msg}`);
    if (f.blocking) blocking += 1;
  }
  const coverage = await coverageCheck();
  if (!coverage.length) console.log('coverage PASS');
  else blocking += logFails('coverage', coverage);
  if (blocking) {
    console.log(`FAIL omega-v2 math gate: ${blocking} blocking`);
    process.exit(1);
  }
  console.log('PASS omega-v2 math gate');
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  checkCard,
  checkPublished,
  loadPublished,
  letterFor,
  normLetter,
  quarterKelly,
  windowDates,
  publishedRoots,
  EFFECTIVE,
  V2_FIRST_DAY,
};
