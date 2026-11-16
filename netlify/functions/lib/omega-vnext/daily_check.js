'use strict';

/**
 * Daily ops health check for the card date D (ET) and D-1.
 * Reads stored boards, the card, the mirror, the v1 copy, grades, KPIs,
 * closes, the news log, the last stored Odds API credit header, and whether
 * main commits and production deploys came through deploy.sh.
 * It does not call The Odds API, does not write the main card, and does not
 * revert a commit or a deploy.
 * dryRun=1 and OMEGA_REPLAY_NO_WRITE skip the report write and every correction.
 * OMEGA_DAILY_CHECK defaults on. =off skips the run.
 */

const { etParts } = require('../et-schedule');
const { replayNoWrite } = require('./no_write');
const { opsAlert } = require('./ops_alert');
const { americanToDecimal, americanToImplied } = require('./odds_math');
const { stakeUsd } = require('../omega-v2/size');
const { SITE_ID, BLOB_STORE } = require('./config');
const { blobRestUrl } = require('./blob_key');
const { resolveFetch } = require('./audit_log');
const { SPORTS: ODDS_MASTER_SPORTS } = require('../odds-master/pull');

const REPORT_STORE = BLOB_STORE;
const NEWS_SNAPSHOT_STORE = 'omega-news-snapshots';
const V1_STORE = 'edge-picks-omega-v1ab';
const CLOSE_CAPTURE_STORE = 'clv-close-capture';
const CLOSE_WARN_REASONS = new Set(['pinnacle-not-priced', 'not-in-historical-snapshot']);
const RESULTS_CACHE_KEY = 'results-omega-cache-v9-kpi1030';
const SUPABASE_URL = 'https://qvfgebrkolfyggfizgkx.supabase.co';
const DAILY_FLAG = 'OMEGA_DAILY_CHECK';
const WRITE_TIMEOUT_MS = 8000;
const DK_HR = new Set(['draftkings', 'hardrockbet', 'hardrock', 'hardrockbet_oh']);
const P_LO = 0.02;
const P_HI = 0.98;
const ALT_LO = 0.30;
const ALT_HI = 0.70;
const UNIT_MIN = 0.25;
const UNIT_MAX = 2;
const PARLAY_UNIT_MAX = 1;
const B_UNIT_MAX = 0.5;
const TOL = 1e-3;
const CREDIT_FAIL = 10000;
const CREDIT_WARN = 12000;
const GITHUB_TIMEOUT_MS = 10 * 1000;
const EXTERNAL_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEPLOY_PAIR_MS = 120 * 1000;
const LEDGER_STORE = 'omega-ops';
/**
 * CLI `netlify blobs:set` uses getStore({ name, siteID, token }).
 * @netlify/blobs prefixes that name with `site:` (site-wide store).
 * Function REST (store.js blobFetch) uses the bare store name, which is
 * the legacy namespace. Both are read. deploy.sh writes the legacy URL.
 */
const SITE_LEDGER_STORE = 'site:omega-ops';
const LEDGER_PREFIX = 'deploy-ledger/';
const NEWS_FIRST_DAY = '2026-11-16';
const PULL_SPORTS = ODDS_MASTER_SPORTS.map((row) => row[0]);
const GITHUB_COMMITS_URL = 'https://api.github.com/repos/wcgbk/webet-social-intelligence/commits';
const DEFAULT_DEPLOY_ACTORS = 'edge-executor';

function dailyCheckEnabled(env) {
  const source = env == null ? process.env : env;
  if (source == null || source[DAILY_FLAG] == null) return true;
  const v = String(source[DAILY_FLAG]).trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no' || v === '') return false;
  return true;
}

function dailyCheckKey(dateISO) {
  const d = String(dateISO || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('daily-check refused bad date');
  return `omega-ops/daily-check-${d}`;
}

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function safeErr(err) {
  return String(err && err.message ? err.message : err || 'error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/apiKey=[^&\s]+/gi, 'apiKey=[redacted]')
    .slice(0, 240);
}

function writesBlocked(opts) {
  const src = opts || {};
  if (src.dryRun === true || src.dryRun === 1 || src.dryRun === '1') return true;
  const event = src.event;
  const qs = (event && event.queryStringParameters) || {};
  if (qs.dryRun === '1' || qs.dryRun === 'true' || qs.dryRun === 'yes') return true;
  let body = null;
  if (event && event.body && typeof event.body === 'object') body = event.body;
  else if (event && typeof event.body === 'string' && event.body) {
    try { body = JSON.parse(event.body); } catch (_) { body = null; }
  }
  if (body && (body.dryRun === 1 || body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true')) return true;
  return replayNoWrite(src.env);
}

function webhookUrl(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'webhookUrl')) return opts.webhookUrl || '';
  const source = opts && opts.env != null ? opts.env : process.env;
  return (source && source.OMEGA_OPS_WEBHOOK_URL) || '';
}

function etWallUtcMs(ymd, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const wantIso = `${ymd}T${hh}:${mm}:00Z`;
  let utc = Date.parse(wantIso);
  if (!Number.isFinite(utc)) return null;
  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));
    const g = (t) => {
      const piece = parts.find((p) => p.type === t);
      return piece ? piece.value : '00';
    };
    let seenHour = g('hour');
    if (seenHour === '24') seenHour = '00';
    const seen = Date.parse(`${g('year')}-${g('month')}-${g('day')}T${seenHour}:${g('minute')}:${g('second')}Z`);
    const want = Date.parse(wantIso);
    const delta = want - seen;
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

function generatedBeforeDeadline(iso, dateISO) {
  const t = Date.parse(iso);
  const deadline = etWallUtcMs(dateISO, 11, 0);
  if (!Number.isFinite(t) || deadline == null) return false;
  return t <= deadline;
}

function normText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function americanNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null;
  const n = Number(String(value).trim().replace(/[−–]/g, '-').replace(/^\+/, ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function americanValid(value) {
  const n = americanNumber(value);
  if (n == null) return false;
  return n <= -100 || n >= 100;
}

function canonBook(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'hardrock' || key === 'hardrockbet_oh') return 'hardrockbet';
  return key;
}

function bookIsDkHr(value) {
  const key = String(value || '').trim().toLowerCase();
  return DK_HR.has(key);
}

function unitsNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') {
    if (value.unitsNum != null) return unitsNumber(value.unitsNum);
    if (value.units != null) return unitsNumber(value.units);
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function unitsOf(row) {
  if (!row || typeof row !== 'object') return unitsNumber(row);
  if (row.unitsNum != null && row.unitsNum !== '') {
    const n = unitsNumber(row.unitsNum);
    if (n != null) return n;
  }
  return unitsNumber(row.units);
}

function onQuarterGrid(n) {
  if (!Number.isFinite(n)) return false;
  return Math.abs(n * 4 - Math.round(n * 4)) < 1e-6;
}

function unitsKey(value) {
  const n = typeof value === 'number' ? value : unitsNumber(value);
  if (n == null) return '';
  return (Math.round(n * 4) / 4).toFixed(2);
}

function pickText(row) {
  if (!row) return '';
  return normText(row.pick || row.side);
}

function idKey(row, withUnits) {
  const parts = [pickText(row), String(americanNumber(row && row.odds) == null ? '' : americanNumber(row.odds)), canonBook(row && row.book)];
  if (withUnits) parts.push(unitsKey(unitsOf(row)));
  return parts.join('|');
}

function multiset(rows, withUnits) {
  return (rows || []).filter(Boolean).map((row) => idKey(row, withUnits)).sort();
}

function sameMultiset(a, b, withUnits) {
  const left = multiset(a, withUnits);
  const right = multiset(b, withUnits);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function marketKind(row) {
  const token = String((row && (row.market || row.betType)) || '').toLowerCase();
  const text = String((row && row.pick) || '');
  if (token.includes('total') || /^\s*(over|under)\b/i.test(text)) return 'total';
  if (/spread|puck|run line/.test(token)) return 'spread';
  if (/[+-]\d/.test(text) && !/\bml\b/i.test(text) && !/\b(over|under)\b/i.test(text)) return 'spread';
  return 'ml';
}

function pBetOf(row) {
  const n = Number(row && row.pBet);
  return Number.isFinite(n) ? n : null;
}

function printedProb(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1 && value <= 100) return value / 100;
    return value;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/%/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return n > 1 && n <= 100 ? n / 100 : n;
}

function evNumber(primary, alt) {
  const value = primary != null && primary !== '' ? primary : alt;
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return null;
  const n = parseFloat(s.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return /%/.test(s) ? n / 100 : n;
}

function isGradeB(row) {
  const letters = [row && row.grade, row && row.rating, row && row.qualityGrade];
  return letters.some((letter) => String(letter || '').trim().toLowerCase() === 'b');
}

function parlayTicket(card) {
  const raw = card && card.parlayLegs;
  if (!Array.isArray(raw) || !raw.length) return null;
  const ticket = raw.find((item) => item && Array.isArray(item.legs));
  return ticket || null;
}

function straightsOf(card) {
  return ((card && card.picks) || []).filter(Boolean);
}

/**
 * capture-done markers are written only by writeCaptureDone, which the
 * post-10/18 odds-master pull does not call. The live record is
 * odds-master pulls/{date}/{slot}: every sport key, errors[], games.
 * A complete doc is a finished pull. A missing or partial doc still fails.
 */
function hasSlotCheck(doc, slot) {
  for (const eventDoc of (doc && doc.events) || []) {
    for (const check of (eventDoc && eventDoc.checks) || []) {
      if (check && String(check.slot) === slot) return true;
    }
  }
  return false;
}

function pullDocPresent(pullDoc, slot) {
  if (!pullDoc || typeof pullDoc !== 'object' || Array.isArray(pullDoc)) return false;
  if (pullDoc.slot != null && String(pullDoc.slot) !== String(slot)) return false;
  return true;
}

function livePullComplete(pullDoc, slot) {
  if (!pullDocPresent(pullDoc, slot)) return false;
  if (pullDoc.ok === false || pullDoc.complete === false) return false;
  if (!Array.isArray(pullDoc.errors) || pullDoc.errors.length) return false;
  const sports = pullDoc.sports;
  if (!sports || typeof sports !== 'object' || Array.isArray(sports)) return false;
  for (const label of PULL_SPORTS) {
    if (!Object.prototype.hasOwnProperty.call(sports, label)) return false;
  }
  const requests = pullDoc.requests != null ? pullDoc.requests : pullDoc.requestCount;
  if (requests != null && !(Number(requests) >= PULL_SPORTS.length)) return false;
  if (pullDoc.games != null && !Number.isFinite(Number(pullDoc.games))) return false;
  return true;
}

function assessPullSlot(slot, input) {
  const src = input || {};
  const marker = src.marker;
  const board = pullDocPresent(src.pullDoc, slot);
  if (livePullComplete(src.pullDoc, slot)) {
    return {
      status: 'ok',
      code: 'ok',
      marker: !!(marker && marker.ok !== false),
      board: true,
      slot,
      phase: (marker && marker.phase) || null,
      games: src.pullDoc.games,
      errors: 0,
    };
  }
  if (board || (marker && marker.ok === false)) {
    return { status: 'fail', code: `partial-${slot}-pull`, marker: !!marker, board, slot };
  }
  if (marker && marker.ok !== false) {
    return { status: 'fail', code: 'board-missing', marker: true, board: false, slot };
  }
  if (src.started) {
    return { status: 'fail', code: 'capture-started-not-finished', marker: false, board, slot, started: true };
  }
  if (Array.isArray(src.sports) && src.sports.length === 0 && !hasSlotCheck(src.lineMoves, slot)) {
    return { status: 'ok', code: 'no-slate', marker: false, board: false, slot, sports: [] };
  }
  return {
    status: 'fail',
    code: `missed-${slot}-pull`,
    marker: false,
    board: false,
    slot,
    sports: Array.isArray(src.sports) ? src.sports : [],
  };
}

function worstStatus(list) {
  const rank = { fail: 3, warn: 2, fixed: 1, ok: 0 };
  let best = 'ok';
  for (const status of list || []) {
    if ((rank[status] || 0) > (rank[best] || 0)) best = status;
  }
  return best;
}

function assessCardShape(card, dateISO) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { status: 'fail', code: 'card-missing' };
  }
  const issues = [];
  if (!generatedBeforeDeadline(card.generatedAt, dateISO)) issues.push('generated-after-1100-et');
  const picks = straightsOf(card);
  if (picks.length !== 3) issues.push('straight-count');
  const ticket = parlayTicket(card);
  const legs = ticket && Array.isArray(ticket.legs) ? ticket.legs.filter(Boolean) : [];
  if (legs.length !== 3) issues.push('parlay-leg-count');
  else if (picks.length === 3 && !sameMultiset(picks, legs, false)) issues.push('parlay-legs-differ');
  if (!issues.length) return { status: 'ok', code: 'ok', straights: picks.length, legs: legs.length };
  return { status: 'fail', code: issues[0], issues, straights: picks.length, legs: legs.length };
}

function assessBounds(card) {
  const issues = [];
  const picks = straightsOf(card);
  picks.forEach((pick, index) => {
    const p = pBetOf(pick);
    const kind = marketKind(pick);
    if (p == null || !(p > P_LO) || !(p < P_HI)) issues.push({ index, code: 'pbet-range', pBet: p });
    if ((kind === 'spread' || kind === 'total') && (p == null || p < ALT_LO || p > ALT_HI)) {
      issues.push({ index, code: 'pbet-spread-total', pBet: p, market: kind });
    }
    if (!americanValid(pick.odds)) issues.push({ index, code: 'odds', odds: pick.odds == null ? null : String(pick.odds) });
    if (!bookIsDkHr(pick.book)) issues.push({ index, code: 'book', book: pick.book || null });
    const units = unitsOf(pick);
    if (units == null || !onQuarterGrid(units) || units < UNIT_MIN || units > UNIT_MAX) {
      issues.push({ index, code: 'units', units });
    }
    if (isGradeB(pick) && !(units != null && units <= B_UNIT_MAX + 1e-9)) {
      issues.push({ index, code: 'b-grade-units', units });
    }
    if (units != null && units > 0) {
      const want = stakeUsd(units);
      const got = Number(pick.stakeUsd);
      if (!(Number.isFinite(got) && got === want)) issues.push({ index, code: 'stake', stakeUsd: pick.stakeUsd == null ? null : got, want });
    }
    const dec = americanToDecimal(pick.odds);
    const ev = p != null && dec != null ? p * dec - 1 : null;
    const storedEv = evNumber(pick.evRaw, pick.ev);
    if (ev == null || storedEv == null || Math.abs(storedEv - ev) > TOL) {
      issues.push({ index, code: 'ev', ev: storedEv, want: ev });
    }
    const printed = printedProb(pick.winProbability);
    if (p == null || printed == null || Math.abs(printed - p) > TOL) {
      issues.push({ index, code: 'win-probability', winProbability: pick.winProbability == null ? null : String(pick.winProbability), pBet: p });
    }
  });
  const ticket = parlayTicket(card);
  if (ticket) {
    const units = unitsOf(ticket);
    if (units == null || !onQuarterGrid(units) || units < UNIT_MIN || units > PARLAY_UNIT_MAX) {
      issues.push({ index: 'parlay', code: 'parlay-units', units });
    }
    const legs = (ticket.legs || []).filter(Boolean);
    let product = 1;
    let pJoint = 1;
    let priced = legs.length > 0;
    for (const leg of legs) {
      const dec = americanToDecimal(leg.odds);
      const p = pBetOf(leg);
      if (!(dec > 1) || p == null) priced = false;
      else {
        product *= dec;
        pJoint *= p;
      }
    }
    const storedDec = Number(ticket.combinedDecimal != null ? ticket.combinedDecimal : ticket.decimal);
    if (!priced || !Number.isFinite(storedDec) || Math.abs(storedDec - product) > TOL) {
      issues.push({ index: 'parlay', code: 'parlay-decimal', combinedDecimal: Number.isFinite(storedDec) ? storedDec : null });
    }
    const storedEv = evNumber(ticket.evRaw, ticket.ev);
    const wantEv = priced && Number.isFinite(storedDec) ? pJoint * storedDec - 1 : null;
    if (wantEv == null || storedEv == null || Math.abs(storedEv - wantEv) > TOL) {
      issues.push({ index: 'parlay', code: 'parlay-ev', ev: storedEv, want: wantEv });
    }
  }
  if (!issues.length) return { status: 'ok', code: 'ok' };
  return { status: 'fail', code: issues[0].code, issues: issues.slice(0, 12) };
}

function creditStatus(remaining, source) {
  if (remaining == null || remaining === '') {
    return { status: 'fail', code: 'credits-unknown', remaining: null, source: source || null };
  }
  const n = Number(remaining);
  if (!Number.isFinite(n)) return { status: 'fail', code: 'credits-unknown', remaining: null, source: source || null };
  if (n < CREDIT_FAIL) return { status: 'fail', code: 'credits-low', remaining: n, source: source || null };
  if (n < CREDIT_WARN) return { status: 'warn', code: 'credits-warn', remaining: n, source: source || null };
  return { status: 'ok', code: 'ok', remaining: n, source: source || null };
}

function latestRemaining(samples) {
  let best = null;
  for (const row of samples || []) {
    const n = Number(row && row.remaining);
    if (!Number.isFinite(n)) continue;
    const parsed = row.at ? Date.parse(row.at) : NaN;
    const t = Number.isFinite(parsed) ? parsed : 0;
    if (!best || t >= best.t) best = { t, remaining: n, at: row.at || null, source: row.source || null };
  }
  return best;
}

function mirrorRows(rows) {
  return (rows || []).filter((row) => row && (row.kind == null || row.kind === 'straight'));
}

function cacheDay(cache, dateISO) {
  const days = cache && Array.isArray(cache.days) ? cache.days : [];
  return days.find((day) => day && day.date === dateISO) || null;
}

function kpiFields(cumulative) {
  const src = cumulative || {};
  return {
    wins: src.wins == null ? null : src.wins,
    losses: src.losses == null ? null : src.losses,
    pushes: src.pushes == null ? null : src.pushes,
    pending: src.pending == null ? null : src.pending,
    roi: src.roi == null ? null : String(src.roi),
    totalWagered: src.totalWagered == null ? null : src.totalWagered,
    totalProfit: src.totalProfit == null ? null : src.totalProfit,
  };
}

function sameKpi(a, b) {
  const left = kpiFields(a);
  const right = kpiFields(b);
  const keys = Object.keys(left);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

function resultOf(row) {
  if (!row) return null;
  const text = String(row.result || '').trim().toLowerCase();
  return text || null;
}

function gradedIndex(day) {
  const map = new Map();
  for (const row of (day && day.picks) || []) {
    if (!row || row.sport === 'PARLAY') continue;
    map.set(`${pickText(row)}|${normText(row.matchup)}`, row);
  }
  return map;
}

function storedStraight(cacheRow, cardPick) {
  const fromCache = resultOf(cacheRow);
  if (fromCache) return { result: fromCache, via: 'results-cache' };
  const fromCard = resultOf(cardPick);
  if (fromCard) return { result: fromCard, via: 'card' };
  return { result: null, via: null };
}

function assessGrades(card, cacheDayRow, gradedDay) {
  const issues = [];
  const expected = gradedIndex(gradedDay);
  const stored = gradedIndex(cacheDayRow);
  for (const pick of straightsOf(card).slice(0, 3)) {
    const key = `${pickText(pick)}|${normText(pick.matchup)}`;
    const want = resultOf(expected.get(key));
    const have = storedStraight(stored.get(key), pick);
    if (!want) {
      issues.push({ pick: pick.pick || null, code: 'ungraded', stored: have.result, expected: null });
      continue;
    }
    if (want === 'pending') {
      if (have.result && have.result !== 'pending' && have.result !== 'skip') {
        issues.push({ pick: pick.pick || null, code: 'mismatch', stored: have.result, expected: want });
      }
      continue;
    }
    if (!have.result || have.result === 'pending' || have.result === 'skip') {
      issues.push({ pick: pick.pick || null, code: 'ungraded', stored: have.result, expected: want });
      continue;
    }
    if (have.result !== want) {
      issues.push({ pick: pick.pick || null, code: 'mismatch', stored: have.result, expected: want, via: have.via });
    }
  }
  const wantParlay = gradedDay && gradedDay.parlayResult ? String(gradedDay.parlayResult).toLowerCase() : null;
  const cacheParlay = cacheDayRow && cacheDayRow.parlayResult ? String(cacheDayRow.parlayResult).toLowerCase() : null;
  const ticket = parlayTicket(card);
  const cardParlay = ticket && ticket.result ? String(ticket.result).toLowerCase() : null;
  const haveParlay = cacheParlay || cardParlay || null;
  if (wantParlay && wantParlay !== 'skip' && wantParlay !== 'pending') {
    if (!haveParlay || haveParlay === 'pending' || haveParlay === 'skip') {
      issues.push({ pick: 'parlay', code: 'ungraded', stored: haveParlay, expected: wantParlay });
    } else if (haveParlay !== wantParlay) {
      issues.push({ pick: 'parlay', code: 'mismatch', stored: haveParlay, expected: wantParlay });
    }
  }
  if (!issues.length) return { status: 'ok', code: 'ok' };
  return { status: 'fail', code: issues[0].code, issues: issues.slice(0, 8) };
}

function rowHasPickClose(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.closingOdds != null && row.closingOdds !== '') return true;
  if (row.clv != null && Number.isFinite(Number(row.clv))) return true;
  if (row.trueClose != null && typeof row.trueClose === 'object') return true;
  if (row.closeOdds != null && row.closeOdds !== '') return true;
  return false;
}

function rowHasCandidateClose(row) {
  return !!(row && row.closeNoVig != null && Number.isFinite(Number(row.closeNoVig)));
}

function findClose(rows, pick, has) {
  const want = pickText(pick);
  const matchup = normText(pick.matchup);
  const hits = (rows || []).filter((row) => row && pickText(row) === want);
  if (!hits.length) return null;
  const narrowed = hits.filter((row) => !matchup || normText(row.matchup) === matchup);
  const pool = narrowed.length ? narrowed : hits;
  return pool.find((row) => has(row)) || null;
}

function assessCloses(card, clvDoc, candidateDoc, extraRows) {
  const missing = [];
  const clvRows = []
    .concat((clvDoc && clvDoc.picks) || [])
    .concat((clvDoc && clvDoc.pickClv) || []);
  const candidates = []
    .concat((candidateDoc && candidateDoc.candidates) || (Array.isArray(candidateDoc) ? candidateDoc : []))
    .concat((clvDoc && clvDoc.candidates) || [])
    .concat((clvDoc && clvDoc.pickClv) || [])
    .concat(extraRows || []);
  for (const pick of straightsOf(card)) {
    const pickClose = findClose(clvRows, pick, rowHasPickClose);
    const candidateClose = findClose(candidates, pick, rowHasCandidateClose);
    if (!pickClose) missing.push({ pick: pick.pick || null, matchup: pick.matchup || null, code: 'pick-close-missing' });
    if (!candidateClose) missing.push({ pick: pick.pick || null, matchup: pick.matchup || null, code: 'candidate-close-missing' });
  }
  if (!missing.length) return { status: 'ok', code: 'ok', picks: straightsOf(card).length };
  return { status: 'fail', code: missing[0].code, missing: missing.slice(0, 8) };
}

function raceTimeout(work, timeoutMs) {
  let timer;
  const pending = Promise.resolve().then(work);
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function refuseCardKey(key) {
  const text = String(key || '');
  if (/^(?:picks-\d{4}-\d{2}-\d{2}|latest-date|picks-dates|picks-sim-)/.test(text)) {
    throw new Error(`daily-check refused card key: ${text}`);
  }
  if (!/^omega-ops\/daily-check-\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`daily-check refused key: ${text}`);
  }
  return text;
}

async function restPutReport(key, doc, timeoutMs, opts) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('blob token missing');
  const url = blobRestUrl(SITE_ID, REPORT_STORE, key, 'canonical');
  const doFetch = opts && typeof opts.blobFetch === 'function' ? opts.blobFetch : resolveFetch(fetch);
  const resp = await raceTimeout(() => doFetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(doc),
  }), timeoutMs);
  if (!resp || resp.ok !== true) {
    const status = resp && resp.status != null ? resp.status : 'no-response';
    throw new Error(`blob PUT ${key} → ${status}`);
  }
}

async function restGetReport(key, timeoutMs, opts) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  const url = blobRestUrl(SITE_ID, REPORT_STORE, key, 'canonical');
  const doFetch = opts && typeof opts.blobFetch === 'function' ? opts.blobFetch : resolveFetch(fetch);
  const resp = await raceTimeout(() => doFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }), timeoutMs);
  if (!resp || resp.ok !== true) return null;
  return resp.json();
}

/** SDK first, REST second. Same fallback news_snapshot uses. Never a card key. */
async function writeDailyReport(dateISO, report, opts) {
  const key = refuseCardKey(dailyCheckKey(dateISO));
  const timeoutMs = opts && Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : WRITE_TIMEOUT_MS;
  if (opts && typeof opts.writeReport === 'function') return opts.writeReport(key, report);
  let sdkErr = null;
  try {
    const store = opts && opts.store ? opts.store : await openStore(REPORT_STORE);
    await raceTimeout(() => {
      if (typeof store.setJSON === 'function') return store.setJSON(key, report);
      return store.set(key, JSON.stringify(report));
    }, timeoutMs);
    return { key, path: 'sdk' };
  } catch (err) {
    sdkErr = err;
  }
  try {
    await restPutReport(key, report, timeoutMs, opts || {});
    return { key, path: 'rest' };
  } catch (restErr) {
    throw new Error(safeErr(restErr || sdkErr));
  }
}

async function readDailyReport(dateISO, opts) {
  const key = refuseCardKey(dailyCheckKey(dateISO));
  const timeoutMs = opts && Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : WRITE_TIMEOUT_MS;
  if (opts && opts.store) {
    if (typeof opts.store.get !== 'function') return null;
    const doc = await opts.store.get(key, { type: 'json' });
    return doc || null;
  }
  try {
    const store = await openStore(REPORT_STORE);
    const doc = await raceTimeout(() => store.get(key, { type: 'json' }), timeoutMs);
    if (doc) return doc;
  } catch (_) { /* REST below */ }
  try {
    return await restGetReport(key, timeoutMs, opts || {});
  } catch (_) {
    return null;
  }
}

async function openStore(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore(name);
}

async function defaultReadCaptureDone(dateISO, slot) {
  const { readCaptureDone } = require('./capture_gate');
  return readCaptureDone(dateISO, slot);
}

async function defaultReadCaptureStart(dateISO, slot) {
  const { readCaptureStart } = require('./capture_gate');
  return readCaptureStart(dateISO, slot);
}

async function defaultReadMoves(dateISO) {
  const { readPinnacleLineMoves } = require('./pinnacle_line_move');
  return readPinnacleLineMoves(dateISO);
}

async function defaultSports(dateISO, env) {
  const { sportsForCard } = require('./season_calendar');
  return sportsForCard(dateISO, { env });
}

async function defaultReadPull(dateISO, slot) {
  const { readJson } = require('../odds-master/store');
  return readJson(`pulls/${dateISO}/${slot}`);
}

async function defaultReadCard(dateISO) {
  const store = require('./store');
  return store.readPicks(dateISO);
}

async function defaultReadV1(dateISO) {
  const { store } = require('../omega-v1ab/blob');
  return store(V1_STORE).getJSON(`picks-${dateISO}`);
}

async function defaultReadMirror(dateISO, env) {
  const source = env || process.env;
  const key = source && source.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return { rows: null, error: 'mirror-unconfigured' };
  const url = `${SUPABASE_URL}/rest/v1/card_picks?date=eq.${encodeURIComponent(dateISO)}&select=date,kind,pick,odds,book,units`;
  const resp = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'clv',
    },
  });
  if (!resp || !resp.ok) return { rows: null, error: `mirror-http-${resp ? resp.status : 'none'}` };
  const rows = await resp.json();
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function defaultReadCache() {
  const store = require('./store');
  return store.readJson(RESULTS_CACHE_KEY);
}

async function defaultReadClv(dateISO) {
  const store = require('./store');
  return store.readJson(`clv-${dateISO}`);
}

async function defaultReadCandidates(dateISO) {
  const store = require('./store');
  return store.readJson(`clv-candidates-v2/${dateISO}`);
}

async function defaultFetchGames(dateISO, sports) {
  const { fetchESPNScores } = require('../espn-scoreboard');
  const out = [];
  for (const sport of sports || []) {
    const games = await fetchESPNScores(dateISO, sport);
    for (const game of games || []) out.push(Object.assign({}, game, { _sport: game._sport || sport }));
  }
  return out;
}

function graderFns() {
  const results = require('../../get-results-omega');
  return results && results._test ? results._test : {};
}

async function recomputeGrades(dateISO, card, games) {
  const { gradeDay } = graderFns();
  if (typeof gradeDay !== 'function') throw new Error('grader missing');
  return gradeDay(dateISO, card || { picks: [] }, { games: games || [] });
}

function recomputeKpis(days) {
  const { aggregateDays } = graderFns();
  if (typeof aggregateDays !== 'function') throw new Error('kpi aggregate missing');
  return aggregateDays(days || []);
}

async function defaultRegrade() {
  const results = require('../../get-results-omega');
  const resp = await results.handler({
    httpMethod: 'GET',
    queryStringParameters: { refresh: '1', range: 'all' },
    headers: {},
  });
  const status = resp && resp.statusCode;
  let errored = false;
  try {
    const body = resp && resp.body ? JSON.parse(resp.body) : null;
    errored = !!(body && body.error);
  } catch (_) { errored = false; }
  return {
    ok: status === 200 && !errored,
    statusCode: status == null ? null : status,
    error: errored,
  };
}

async function defaultMirror(dateISO, card, env) {
  const { mirrorTodayCard } = require('../supa-mirror');
  return mirrorTodayCard(dateISO, { env, card });
}

async function defaultSyncV1(dateISO, card, env) {
  const { syncMainCardToV1 } = require('../omega-v1ab/sync-main');
  return syncMainCardToV1(dateISO, card, { env });
}

async function listPrefix(storeName, prefix) {
  try {
    const store = await openStore(storeName);
    const listed = await store.list({ prefix: String(prefix || '') });
    return ((listed && listed.blobs) || []).map((blob) => (blob && blob.key) || '').filter(Boolean);
  } catch (_) {
    return null;
  }
}

async function defaultReadNews(dateISO) {
  const prefix = `${dateISO}/`;
  let keys = await listPrefix(NEWS_SNAPSHOT_STORE, prefix);
  if (keys == null) {
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      if (!token) return null;
      const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${NEWS_SNAPSHOT_STORE}?prefix=${encodeURIComponent(prefix)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp || !resp.ok) return null;
      const data = await resp.json();
      keys = ((data && data.blobs) || []).map((blob) => blob && blob.key).filter(Boolean);
    } catch (_) {
      return null;
    }
  }
  if (!keys || !keys.length) return null;
  return { present: true, key: keys[0], count: keys.length };
}

async function auditCreditSamples(dateISO) {
  const prefix = `omega-audit/${dateISO}/`;
  const keys = await listPrefix(BLOB_STORE, prefix);
  if (!keys || !keys.length) return [];
  const store = require('./store');
  const samples = [];
  const slice = keys.slice(-12);
  for (const key of slice) {
    let doc = null;
    try { doc = await store.readJson(key); } catch (_) { doc = null; }
    for (const entry of (doc && doc.entries) || []) {
      if (!entry || entry['x-requests-remaining'] == null) continue;
      samples.push({
        remaining: entry['x-requests-remaining'],
        at: entry.ts || null,
        source: 'audit-log',
      });
    }
  }
  return samples;
}

async function defaultReadCredits(ctx) {
  const samples = [];
  const readMoves = ctx.readPinnacleLineMoves || defaultReadMoves;
  for (const dateISO of [ctx.date, ctx.prev]) {
    let pack = null;
    try { pack = await readMoves(dateISO); } catch (_) { pack = null; }
    for (const eventDoc of (pack && pack.events) || []) {
      for (const check of (eventDoc && eventDoc.checks) || []) {
        if (check && check.requestsRemaining != null) {
          samples.push({ remaining: check.requestsRemaining, at: check.at || null, source: 'line-move' });
        }
      }
    }
  }
  try {
    const { readJson } = require('../odds-master/store');
    for (const dateISO of [ctx.date, ctx.prev]) {
      const doc = await readJson(`credits/${dateISO}`, CLOSE_CAPTURE_STORE);
      if (!doc) continue;
      const calls = Array.isArray(doc.calls) ? doc.calls : [];
      if (!calls.length && doc.remaining != null) {
        samples.push({ remaining: doc.remaining, at: null, source: 'clv-close-capture' });
      }
      for (const call of calls) {
        if (call && call.remaining != null) {
          samples.push({ remaining: call.remaining, at: call.at || null, source: 'clv-close-capture' });
        }
      }
    }
  } catch (_) { /* credit blob is optional */ }
  try {
    const audited = await auditCreditSamples(ctx.date);
    for (const row of audited) samples.push(row);
  } catch (_) { /* audit list is optional */ }
  return latestRemaining(samples);
}

async function postWebhook(url, report) {
  const resp = await resolveFetch(fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
  return resp;
}

function row(id, dateISO, assessed) {
  const src = assessed || { status: 'fail', code: 'empty' };
  return {
    id,
    date: dateISO,
    status: src.status || 'fail',
    evidence: src.evidence || (() => {
      const evidence = Object.assign({}, src);
      delete evidence.status;
      return evidence;
    })(),
  };
}

async function checkPulls(ctx) {
  const readDone = ctx.readCaptureDone || defaultReadCaptureDone;
  const readStart = ctx.readCaptureStart || defaultReadCaptureStart;
  const readMoves = ctx.readPinnacleLineMoves || defaultReadMoves;
  const sportsFn = ctx.sportsForCard || ((date, env) => defaultSports(date, env));
  const readPull = ctx.readOddsMasterPull || defaultReadPull;
  let moves = null;
  let sports = null;
  try { moves = await readMoves(ctx.date); } catch (_) { moves = null; }
  try { sports = await sportsFn(ctx.date, ctx.env); } catch (_) { sports = null; }
  const slots = {};
  for (const slot of ['0300', '1000']) {
    let marker = null;
    let started = null;
    let pullDoc = null;
    try { marker = await readDone(ctx.date, slot); } catch (_) { marker = null; }
    try { started = await readStart(ctx.date, slot); } catch (_) { started = null; }
    try { pullDoc = await readPull(ctx.date, slot); } catch (_) { pullDoc = null; }
    slots[slot] = assessPullSlot(slot, { marker, started, lineMoves: moves, sports, pullDoc });
  }
  const status = worstStatus([slots['0300'].status, slots['1000'].status]);
  const failed = ['0300', '1000'].map((slot) => slots[slot]).find((slot) => slot.status === status) || slots['0300'];
  return { status, code: failed.code, slots };
}

async function checkCard(ctx) {
  const readCard = ctx.readCard || defaultReadCard;
  const card = await readCard(ctx.date);
  ctx.card = card;
  return assessCardShape(card, ctx.date);
}

async function checkBounds(ctx) {
  if (!ctx.card) {
    const readCard = ctx.readCard || defaultReadCard;
    try { ctx.card = await readCard(ctx.date); } catch (_) { ctx.card = null; }
  }
  if (!ctx.card) return { status: 'fail', code: 'card-missing' };
  return assessBounds(ctx.card);
}

async function loadMirrorView(ctx) {
  const readMirror = ctx.readMirrorPicks || ((date) => defaultReadMirror(date, ctx.env));
  const readV1 = ctx.readV1Card || defaultReadV1;
  const mirror = await readMirror(ctx.date);
  const v1 = await readV1(ctx.date);
  return { mirror, v1 };
}

function mirrorDiff(card, view) {
  const picks = straightsOf(card);
  const mirrorRowsIn = view && view.mirror && Array.isArray(view.mirror.rows) ? view.mirror.rows : null;
  const mirrorError = view && view.mirror && view.mirror.error ? view.mirror.error : null;
  const v1Card = view && view.v1;
  const v1Picks = v1Card && Array.isArray(v1Card.picks) ? v1Card.picks : null;
  return {
    mirrorOk: !mirrorError && mirrorRowsIn != null && sameMultiset(picks, mirrorRows(mirrorRowsIn), true),
    v1Ok: v1Picks != null && sameMultiset(picks, v1Picks, true),
    mirrorError: mirrorError || (mirrorRowsIn == null ? 'mirror-missing' : null),
    v1Error: v1Picks == null ? 'v1-missing' : null,
  };
}

async function checkMirror(ctx) {
  if (!ctx.card) {
    const readCard = ctx.readCard || defaultReadCard;
    ctx.card = await readCard(ctx.date);
  }
  if (!ctx.card) return { status: 'fail', code: 'card-missing' };
  let view = await loadMirrorView(ctx);
  let diff = mirrorDiff(ctx.card, view);
  if (diff.mirrorOk && diff.v1Ok) return { status: 'ok', code: 'ok', mirror: 'match', v1: 'match' };
  const corrected = [];
  if (!ctx.dry) {
    if (!diff.mirrorOk && !diff.mirrorError) {
      const run = ctx.mirrorTodayCard || ((date, card, env) => defaultMirror(date, card, env));
      try {
        await run(ctx.date, ctx.card, ctx.env);
        corrected.push('mirror');
      } catch (err) {
        diff.mirrorError = safeErr(err);
      }
    }
    if (!diff.v1Ok) {
      const run = ctx.syncMainCardToV1 || ((date, card, env) => defaultSyncV1(date, card, env));
      try {
        await run(ctx.date, ctx.card, ctx.env);
        corrected.push('v1');
      } catch (err) {
        diff.v1Error = safeErr(err);
      }
    }
    if (corrected.length) {
      try {
        view = await loadMirrorView(ctx);
        diff = mirrorDiff(ctx.card, view);
      } catch (err) {
        return { status: 'fail', code: 'recheck-failed', corrected, detail: safeErr(err) };
      }
      if (diff.mirrorOk && diff.v1Ok) {
        return { status: 'fixed', code: 'fixed', corrected, mirror: 'match', v1: 'match' };
      }
    }
  }
  return {
    status: 'fail',
    code: !diff.mirrorOk && !diff.v1Ok ? 'mirror-and-v1' : (!diff.mirrorOk ? 'mirror' : 'v1'),
    mirror: diff.mirrorOk ? 'match' : (diff.mirrorError || 'mismatch'),
    v1: diff.v1Ok ? 'match' : (diff.v1Error || 'mismatch'),
    corrected,
  };
}

async function gamesFor(ctx) {
  if (ctx._games) return ctx._games;
  const card = ctx.prevCard;
  const sports = [...new Set(straightsOf(card).map((pick) => pick.sport).filter(Boolean))];
  const ticket = parlayTicket(card);
  for (const leg of (ticket && ticket.legs) || []) if (leg && leg.sport) sports.push(leg.sport);
  const unique = [...new Set(sports)];
  const fetchGames = ctx.fetchGames || ((date, list) => defaultFetchGames(date, list));
  ctx._games = await fetchGames(ctx.prev, unique);
  return ctx._games;
}

async function gradeView(ctx) {
  const readCard = ctx.readCard || defaultReadCard;
  if (!ctx.prevCard) ctx.prevCard = await readCard(ctx.prev);
  const games = await gamesFor(ctx);
  const recompute = ctx.recomputeGrades || recomputeGrades;
  const graded = await recompute(ctx.prev, ctx.prevCard, Array.isArray(games) ? games : []);
  return graded;
}

async function checkGrading(ctx) {
  const readCache = ctx.readResultsCache || defaultReadCache;
  if (!ctx.prevCard) {
    const readCard = ctx.readCard || defaultReadCard;
    ctx.prevCard = await readCard(ctx.prev);
  }
  if (!ctx.prevCard || !straightsOf(ctx.prevCard).length) return { status: 'fail', code: 'card-missing' };
  let cache = null;
  try { cache = await readCache(); } catch (_) { cache = null; }
  let graded = null;
  try { graded = await gradeView(ctx); } catch (err) {
    return { status: 'fail', code: 'grade-failed', detail: safeErr(err) };
  }
  let assessed = assessGrades(ctx.prevCard, cacheDay(cache, ctx.prev), graded);
  if (assessed.status === 'ok') return assessed;
  if (ctx.dry) return assessed;
  const rebuilt = await rebuildOnce(ctx);
  try { cache = await readCache(); } catch (_) { cache = null; }
  try { graded = await gradeView(ctx); } catch (_) { graded = graded; }
  assessed = assessGrades(ctx.prevCard, cacheDay(cache, ctx.prev), graded);
  if (assessed.status === 'ok') return { status: 'fixed', code: 'fixed', corrected: ['results-cache'], rebuild: rebuilt };
  return Object.assign({}, assessed, { corrected: ['results-cache'], rebuild: rebuilt });
}

async function rebuildOnce(ctx) {
  if (ctx._rebuild) return ctx._rebuild;
  const run = ctx.regrade || defaultRegrade;
  ctx._rebuild = Promise.resolve()
    .then(() => run(ctx.prev, ctx))
    .then((out) => ({ ran: true, out: out || null }))
    .catch((err) => ({ ran: true, error: safeErr(err) }));
  return ctx._rebuild;
}

async function checkKpis(ctx) {
  const readCache = ctx.readResultsCache || defaultReadCache;
  let cache = null;
  try { cache = await readCache(); } catch (_) { cache = null; }
  const compare = () => {
    if (!cache || !Array.isArray(cache.days)) return { status: 'fail', code: 'kpi-cache-missing' };
    const agg = (ctx.recomputeKpis || recomputeKpis)(cache.days);
    const want = kpiFields(agg && agg.cumulative);
    const have = kpiFields(cache.cumulative);
    if (sameKpi(have, want)) return { status: 'ok', code: 'ok', kpi: have };
    return { status: 'fail', code: 'kpi-mismatch', have, want };
  };
  let assessed = compare();
  if (assessed.status === 'ok') return assessed;
  if (ctx.dry) return assessed;
  const rebuilt = await rebuildOnce(ctx);
  try { cache = await readCache(); } catch (_) { cache = null; }
  assessed = compare();
  if (assessed.status === 'ok') return { status: 'fixed', code: 'fixed', corrected: ['results-cache'], kpi: assessed.kpi, rebuild: rebuilt };
  return Object.assign({}, assessed, { corrected: ['results-cache'], rebuild: rebuilt });
}

function compactName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickTeamCompact(pick) {
  const text = String((pick && pick.pick) || '')
    .replace(/[+-]?\d+(?:\.\d+)?/g, ' ')
    .replace(/\b(?:ml|moneyline)\b/ig, ' ');
  return compactName(text);
}

function splitMatchup(matchup) {
  const parts = String(matchup || '').trim().split(/\s+@\s+|\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  return { left: compactName(parts[0]), right: compactName(parts[1]) };
}

function gameMatchesPick(game, pick) {
  const sides = splitMatchup(pick && pick.matchup);
  if (!sides || !sides.left || !sides.right) return false;
  const home = compactName(game && game.home_team);
  const away = compactName(game && game.away_team);
  if (!home || !away) return false;
  return (away === sides.left && home === sides.right) || (away === sides.right && home === sides.left);
}

function apiMarket(pick) {
  const kind = marketKind(pick);
  if (kind === 'spread') return 'spreads';
  if (kind === 'total') return 'totals';
  return 'h2h';
}

function finiteImplied(value) {
  const n = americanToImplied(value);
  return n != null && Number.isFinite(n) ? n : null;
}

function closeFromStoredRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.closing_novig != null && row.closing_novig !== '') {
    const n = Number(row.closing_novig);
    if (Number.isFinite(n)) return n;
  }
  return finiteImplied(row.closing_odds);
}

function snapshotClose(snaps, pick) {
  const market = apiMarket(pick);
  const rows = (snaps || []).filter((row) => row && String(row.market || '') === market && finiteImplied(row.price) != null);
  if (!rows.length) return null;
  const team = pickTeamCompact(pick);
  const matched = team ? rows.find((row) => compactName(row.side) === team) : null;
  return finiteImplied((matched || rows[0]).price);
}

function serviceRoleKey(ctx) {
  const source = ctx && ctx.env != null ? ctx.env : process.env;
  if (!source || source.SUPABASE_SERVICE_ROLE_KEY == null) return '';
  return String(source.SUPABASE_SERVICE_ROLE_KEY).trim();
}

async function supabaseSelect(ctx, pathAndQuery) {
  const key = serviceRoleKey(ctx);
  if (!key) return [];
  const doFetch = externalFetch(ctx);
  const resp = await raceTimeout(() => doFetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'clv',
    },
  }), GITHUB_TIMEOUT_MS);
  if (!responseOk(resp)) return [];
  const data = typeof resp.json === 'function' ? await resp.json() : null;
  return Array.isArray(data) ? data : [];
}

/**
 * Live candidate closes are not clv-candidates-v2. capture-candidate-closes
 * returns before that write. supa-mirror writes clv.pick_clv. capture-pick-closes
 * writes clv.odds_snapshots pinnacle closing rows. No service key returns no
 * rows, so a missing blob close still fails.
 */
async function defaultReadStoredCandidateCloses(dateISO, ctx) {
  if (!serviceRoleKey(ctx)) return [];
  const picks = straightsOf(ctx && ctx.prevCard);
  const rows = [];
  let stored = [];
  try {
    const qs = new URLSearchParams();
    qs.set('date', `eq.${dateISO}`);
    qs.set('select', 'pick,matchup,closing_novig,closing_odds');
    stored = await supabaseSelect(ctx, `pick_clv?${qs.toString()}`);
  } catch (_) {
    stored = [];
  }
  const unmatched = [];
  for (const pick of picks) {
    const hit = (stored || []).find((row) => pickText(row) === pickText(pick) && closeFromStoredRow(row) != null);
    if (!hit) {
      unmatched.push(pick);
      continue;
    }
    rows.push({
      pick: hit.pick || pick.pick,
      matchup: hit.matchup || pick.matchup,
      closeNoVig: closeFromStoredRow(hit),
    });
  }
  if (!unmatched.length) return rows;
  try {
    const from = `${shiftYmd(dateISO, -1)}T00:00:00.000Z`;
    const to = `${shiftYmd(dateISO, 2)}T00:00:00.000Z`;
    const gameQs = new URLSearchParams();
    gameQs.set('select', 'game_id,home_team,away_team,commence_time');
    gameQs.set('commence_time', `gte.${from}`);
    gameQs.append('commence_time', `lt.${to}`);
    const games = await supabaseSelect(ctx, `games?${gameQs.toString()}`);
    const wanted = new Map();
    for (const pick of unmatched) {
      const game = (games || []).find((row) => gameMatchesPick(row, pick));
      const gameId = game && game.game_id ? String(game.game_id) : '';
      if (!/^[A-Za-z0-9_.-]+$/.test(gameId)) continue;
      if (!wanted.has(gameId)) wanted.set(gameId, []);
      wanted.get(gameId).push(pick);
    }
    const ids = [...wanted.keys()];
    if (!ids.length) return rows;
    const snapQs = new URLSearchParams();
    snapQs.set('select', 'game_id,market,side,point,price');
    snapQs.set('game_id', `in.(${ids.join(',')})`);
    snapQs.set('book', 'eq.pinnacle');
    snapQs.set('line_type', 'eq.closing');
    const snaps = await supabaseSelect(ctx, `odds_snapshots?${snapQs.toString()}`);
    for (const [gameId, gamePicks] of wanted) {
      const mine = (snaps || []).filter((row) => String(row.game_id) === gameId);
      for (const pick of gamePicks) {
        const closeNoVig = snapshotClose(mine, pick);
        if (closeNoVig == null) continue;
        rows.push({ pick: pick.pick, matchup: pick.matchup, closeNoVig });
      }
    }
  } catch (_) { /* keep the pick_clv rows already found */ }
  return rows;
}

function closes3amSummaryOk(summary, dateISO) {
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.picks)) return false;
  if (summary.date != null && String(summary.date) !== String(dateISO)) return false;
  return true;
}

function excusedCloseReason(miss, summary) {
  const picks = (summary && summary.picks) || [];
  const want = normText(miss && miss.pick);
  const matchup = normText(miss && miss.matchup);
  let hits = picks.filter((row) => row && normText(row.pick) === want);
  if (matchup) {
    const narrowed = hits.filter((row) => normText(row.matchup) === matchup);
    if (narrowed.length) hits = narrowed;
  }
  const hit = hits.find((row) => row && row.status === 'no-close' && CLOSE_WARN_REASONS.has(row.reason));
  return hit ? hit.reason : null;
}

async function defaultReadCloses3am(dateISO) {
  try {
    const { readJson } = require('../odds-master/store');
    return await readJson(`closes-3am/${dateISO}`, CLOSE_CAPTURE_STORE);
  } catch (_) {
    return null;
  }
}

async function checkCloses(ctx) {
  if (!ctx.prevCard) {
    const readCard = ctx.readCard || defaultReadCard;
    try { ctx.prevCard = await readCard(ctx.prev); } catch (_) { ctx.prevCard = null; }
  }
  if (!ctx.prevCard) return { status: 'fail', code: 'card-missing' };
  const readClv = ctx.readClv || defaultReadClv;
  const readCandidates = ctx.readCandidateCloses || defaultReadCandidates;
  const readStored = ctx.readStoredCandidateCloses
    || ((dateISO) => defaultReadStoredCandidateCloses(dateISO, ctx));
  let clv = null;
  let candidates = null;
  let extra = [];
  try { clv = await readClv(ctx.prev); } catch (_) { clv = null; }
  try { candidates = await readCandidates(ctx.prev); } catch (_) { candidates = null; }
  try { extra = await readStored(ctx.prev, ctx); } catch (_) { extra = []; }
  if (!Array.isArray(extra)) extra = [];
  const assessed = assessCloses(ctx.prevCard, clv, candidates, extra);
  const readSummary = ctx.readCloses3am || defaultReadCloses3am;
  let summary = null;
  try { summary = await readSummary(ctx.prev, ctx); } catch (_) { summary = null; }
  if (!closes3amSummaryOk(summary, ctx.prev)) {
    return { status: 'fail', code: 'closes-3am-missing', missing: assessed.missing || [] };
  }
  if (assessed.status === 'ok') return assessed;
  const hard = [];
  const warned = [];
  for (const miss of assessed.missing || []) {
    const reason = excusedCloseReason(miss, summary);
    if (reason) warned.push(Object.assign({}, miss, { reason }));
    else hard.push(miss);
  }
  if (hard.length) {
    return { status: 'fail', code: hard[0].code, missing: hard.slice(0, 8), warned: warned.slice(0, 8) };
  }
  if (warned.length) {
    return { status: 'warn', code: warned[0].reason, missing: warned.slice(0, 8) };
  }
  return assessed;
}

async function checkNews(ctx) {
  const readNews = ctx.readNews || defaultReadNews;
  const doc = await readNews(ctx.date);
  if (doc && (doc.present === true || doc.date === ctx.date || doc.key)) {
    return { status: 'ok', code: 'ok', key: doc.key || null };
  }
  if (String(ctx.date) < NEWS_FIRST_DAY) return { status: 'warn', code: 'news-missing' };
  return { status: 'fail', code: 'news-missing' };
}

async function checkCredits(ctx) {
  const readCredits = ctx.readCredits || ((inner) => defaultReadCredits(inner));
  const sample = await readCredits(ctx);
  if (sample && typeof sample === 'object' && Object.prototype.hasOwnProperty.call(sample, 'remaining')) {
    return creditStatus(sample.remaining, sample.source);
  }
  return creditStatus(sample, null);
}

function externalFetch(ctx) {
  if (ctx && typeof ctx.fetch === 'function') return ctx.fetch;
  return resolveFetch(fetch);
}

function netlifyToken(ctx) {
  const source = ctx && ctx.env != null ? ctx.env : process.env;
  if (!source || source.NETLIFY_AUTH_TOKEN == null) return '';
  return String(source.NETLIFY_AUTH_TOKEN).trim();
}

function approvedActors(env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.OMEGA_DEPLOY_ACTORS;
  const text = raw == null || String(raw).trim() === '' ? DEFAULT_DEPLOY_ACTORS : String(raw);
  const set = new Set();
  for (const part of text.split(',')) {
    const actor = part.trim();
    if (actor) set.add(actor);
  }
  return set;
}

function formatEt(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const g = (type) => {
    const piece = parts.find((item) => item.type === type);
    return piece ? piece.value : '00';
  };
  let hour = g('hour');
  if (hour === '24') hour = '00';
  return `${g('year')}-${g('month')}-${g('day')} ${hour}:${g('minute')}:${g('second')} ET`;
}

function responseOk(resp) {
  if (!resp) return false;
  if (resp.ok === true) return true;
  if (resp.ok === false) return false;
  const status = Number(resp.status);
  return status >= 200 && status < 300;
}

function nextPageUrl(resp) {
  const headers = resp && resp.headers;
  let link = '';
  if (headers && typeof headers.get === 'function') link = headers.get('link') || headers.get('Link') || '';
  else if (headers) link = headers.link || headers.Link || '';
  if (!link) return '';
  const parts = String(link).split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return '';
}

async function fetchJson(doFetch, url, options) {
  const resp = await raceTimeout(() => doFetch(url, options), GITHUB_TIMEOUT_MS);
  if (!responseOk(resp)) {
    const status = resp && resp.status != null ? resp.status : 'no-response';
    throw new Error(`http ${status}`);
  }
  const data = typeof resp.json === 'function' ? await resp.json() : null;
  return { data, resp };
}

function commitRecord(row) {
  if (!row || !row.sha) return null;
  const commit = row.commit || {};
  const author = commit.author || {};
  const committer = commit.committer || {};
  const at = committer.date || author.date || null;
  const title = String(commit.message || '').split('\n')[0] || null;
  return { sha: String(row.sha).trim(), at, title };
}

function githubCommitsUrl(sinceIso) {
  return `${GITHUB_COMMITS_URL}?sha=main&since=${encodeURIComponent(sinceIso)}&per_page=100`;
}

async function loadGithubCommits(ctx, sinceIso) {
  const doFetch = externalFetch(ctx);
  const commits = [];
  let url = githubCommitsUrl(sinceIso);
  try {
    for (let page = 0; page < 5 && url; page += 1) {
      const { data, resp } = await fetchJson(doFetch, url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'omega-daily-check',
        },
      });
      if (!Array.isArray(data)) return { ok: false, commits: [] };
      for (const row of data) {
        const rec = commitRecord(row);
        if (rec) commits.push(rec);
      }
      const next = nextPageUrl(resp);
      if (!next || next === url) break;
      url = next;
    }
    return { ok: true, commits };
  } catch (_) {
    return { ok: false, commits: [] };
  }
}

function isProductionDeploy(deploy) {
  return !!(deploy && String(deploy.context || '').toLowerCase() === 'production');
}

function deployUntitled(deploy) {
  if (!deploy) return true;
  const title = deploy.title;
  return title == null || String(title).trim() === '';
}

function deployReady(deploy) {
  return String(deploy && deploy.state || '').toLowerCase() === 'ready';
}

function deployCreatedMs(deploy) {
  return Date.parse(deploy && (deploy.created_at || deploy.createdAt));
}

async function loadProductionDeploys(ctx) {
  const token = netlifyToken(ctx);
  if (!token) return { ok: false, deploys: [] };
  const doFetch = externalFetch(ctx);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const deploys = [];
  let url = `https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys?per_page=50`;
  try {
    for (let page = 0; page < 3 && url; page += 1) {
      const { data, resp } = await fetchJson(doFetch, url, { method: 'GET', headers });
      if (!Array.isArray(data)) return { ok: false, deploys: [] };
      for (const row of data) if (isProductionDeploy(row)) deploys.push(row);
      const next = nextPageUrl(resp);
      if (!next || next === url) break;
      url = next;
    }
    return { ok: true, deploys };
  } catch (_) {
    return { ok: false, deploys: [] };
  }
}

function normalizeLedger(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const commits = Array.isArray(doc.commits)
    ? doc.commits.map((sha) => String(sha || '').trim()).filter(Boolean)
    : [];
  return {
    sha: doc.sha ? String(doc.sha).trim() : '',
    prevMain: doc.prevMain ? String(doc.prevMain).trim() : '',
    commits,
    actor: doc.actor == null ? '' : String(doc.actor).trim(),
    at: doc.at || null,
  };
}

async function readLedgerSdk() {
  const store = await openStore(LEDGER_STORE);
  const keys = [];
  const listed = await store.list({ prefix: LEDGER_PREFIX, paginate: true });
  if (listed && typeof listed[Symbol.asyncIterator] === 'function') {
    for await (const page of listed) {
      for (const blob of (page && page.blobs) || []) {
        if (blob && blob.key) keys.push(blob.key);
      }
      if (keys.length >= 5000) break;
    }
  } else {
    for (const blob of (listed && listed.blobs) || []) {
      if (blob && blob.key) keys.push(blob.key);
    }
  }
  const entries = [];
  for (const key of keys) {
    let doc = null;
    try { doc = await store.get(key, { type: 'json' }); } catch (_) { doc = null; }
    const entry = normalizeLedger(doc);
    if (entry) entries.push(entry);
  }
  if (keys.length && !entries.length) throw new Error('ledger-unreadable');
  return entries;
}

async function readLedgerStore(ctx, storeName) {
  const token = netlifyToken(ctx);
  if (!token) throw new Error('netlify-unreadable');
  const doFetch = externalFetch(ctx);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const keys = [];
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams();
    qs.set('prefix', LEDGER_PREFIX);
    if (cursor) qs.set('cursor', cursor);
    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${storeName}?${qs.toString()}`;
    const resp = await raceTimeout(() => doFetch(url, { method: 'GET', headers }), GITHUB_TIMEOUT_MS);
    if (resp && Number(resp.status) === 404) return [];
    if (!responseOk(resp)) throw new Error('ledger-unreadable');
    const data = typeof resp.json === 'function' ? await resp.json() : null;
    const blobs = data && Array.isArray(data.blobs) ? data.blobs : (Array.isArray(data) ? data : null);
    if (!blobs) throw new Error('ledger-unreadable');
    for (const blob of blobs) if (blob && blob.key) keys.push(String(blob.key));
    cursor = data && data.next_cursor ? String(data.next_cursor) : '';
    if (!cursor) break;
    if (keys.length >= 5000) break;
  }
  const entries = [];
  let matched = 0;
  for (const key of keys) {
    if (!String(key).startsWith(LEDGER_PREFIX)) continue;
    matched += 1;
    try {
      const url = blobRestUrl(SITE_ID, storeName, key, 'canonical');
      const { data } = await fetchJson(doFetch, url, { method: 'GET', headers });
      const entry = normalizeLedger(data);
      if (entry) entries.push(entry);
    } catch (_) { /* one bad blob must not look like an empty ledger */ }
  }
  if (matched && !entries.length) throw new Error('ledger-unreadable');
  return entries;
}

function mergeLedger(buckets) {
  const out = [];
  const seen = new Set();
  for (const bucket of buckets || []) {
    for (const entry of bucket || []) {
      const id = `${entry.sha}|${entry.at || ''}|${entry.actor || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out;
}

async function loadLedger(ctx) {
  const buckets = [];
  let anyOk = false;
  if (!(ctx && typeof ctx.fetch === 'function')) {
    try {
      buckets.push(await readLedgerSdk());
      anyOk = true;
    } catch (_) { /* REST below. A throw is the only SDK fallback. */ }
  }
  for (const storeName of [LEDGER_STORE, SITE_LEDGER_STORE]) {
    try {
      buckets.push(await readLedgerStore(ctx, storeName));
      anyOk = true;
    } catch (_) { /* the other namespace may still be readable */ }
  }
  if (!anyOk) return { ok: false, entries: [] };
  return { ok: true, entries: mergeLedger(buckets) };
}

function earliestLedgerMs(entries) {
  let min = null;
  for (const entry of entries || []) {
    const t = Date.parse(entry && entry.at);
    if (!Number.isFinite(t)) continue;
    if (min == null || t < min) min = t;
  }
  return min;
}

function inExternalWindow(ms, nowMs, baselineMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return false;
  if (ms < nowMs - EXTERNAL_WINDOW_MS) return false;
  if (baselineMs != null && ms < baselineMs) return false;
  return true;
}

function coveredCommitSet(entries) {
  const set = new Set();
  for (const entry of entries || []) {
    for (const sha of (entry && entry.commits) || []) set.add(String(sha).toLowerCase());
  }
  return set;
}

function ledgerHeadSet(entries) {
  const set = new Set();
  for (const entry of entries || []) {
    if (entry && entry.sha) set.add(String(entry.sha).toLowerCase());
  }
  return set;
}

function hasTitledPair(deploy, deploys) {
  const at = deployCreatedMs(deploy);
  if (!Number.isFinite(at)) return false;
  for (const other of deploys || []) {
    if (!other || other === deploy || deployUntitled(other)) continue;
    const otherAt = deployCreatedMs(other);
    if (!Number.isFinite(otherAt)) continue;
    const delta = at - otherAt;
    if (delta > 0 && delta <= DEPLOY_PAIR_MS) return true;
  }
  return false;
}

function flagCommit(commit) {
  return {
    kind: 'commit',
    code: 'foreign-commit',
    sha: commit.sha,
    deployId: null,
    timeEt: formatEt(commit.at),
    title: commit.title || null,
  };
}

function flagDeploy(deploy, code) {
  const title = deployUntitled(deploy) ? null : String(deploy.title);
  return {
    kind: 'deploy',
    code,
    sha: deploy.commit_ref ? String(deploy.commit_ref).trim() : null,
    deployId: deploy.id || null,
    timeEt: formatEt(deploy.created_at || deploy.createdAt),
    title,
  };
}

function flagActor(entry) {
  return {
    kind: 'actor',
    code: 'unknown-actor',
    sha: entry.sha || null,
    deployId: null,
    timeEt: formatEt(entry.at),
    title: null,
    actor: entry.actor || null,
  };
}

/**
 * Check j. Flags main commits and production deploys that did not come from
 * deploy.sh's ledger. Never auto-corrects and never reverts.
 * An empty ledger is baseline-pending: history from before the ledger existed
 * is not a failure.
 */
async function checkExternalChanges(ctx) {
  const nowMs = ctx && ctx.now instanceof Date ? ctx.now.getTime() : Date.now();
  const sinceIso = new Date(nowMs - EXTERNAL_WINDOW_MS - 1000).toISOString();
  const [github, netlify, ledger] = await Promise.all([
    loadGithubCommits(ctx, sinceIso),
    loadProductionDeploys(ctx),
    loadLedger(ctx),
  ]);
  const flagged = [];
  if (ledger.ok && ledger.entries.length) {
    const baselineMs = earliestLedgerMs(ledger.entries);
    const approved = approvedActors(ctx && ctx.env);
    const covered = coveredCommitSet(ledger.entries);
    const heads = ledgerHeadSet(ledger.entries);
    const seenActors = new Set();
    for (const entry of ledger.entries) {
      const actor = String(entry.actor || '').trim();
      const key = `${entry.sha}|${actor}`;
      if (seenActors.has(key)) continue;
      seenActors.add(key);
      if (!approved.has(actor)) flagged.push(flagActor(entry));
    }
    if (github.ok) {
      const seen = new Set();
      for (const commit of github.commits) {
        const ms = Date.parse(commit.at);
        if (!inExternalWindow(ms, nowMs, baselineMs)) continue;
        const sha = String(commit.sha || '').toLowerCase();
        if (!sha || seen.has(sha)) continue;
        seen.add(sha);
        if (!covered.has(sha)) flagged.push(flagCommit(commit));
      }
    }
    if (netlify.ok) {
      for (const deploy of netlify.deploys) {
        if (!inExternalWindow(deployCreatedMs(deploy), nowMs, baselineMs)) continue;
        if (!deployUntitled(deploy)) {
          const ref = String(deploy.commit_ref || '').trim().toLowerCase();
          if (!ref || !heads.has(ref)) flagged.push(flagDeploy(deploy, 'foreign-deploy'));
        } else if (deployReady(deploy) && !hasTitledPair(deploy, netlify.deploys)) {
          flagged.push(flagDeploy(deploy, 'untitled-deploy'));
        }
      }
    }
  }
  if (flagged.length) {
    return {
      status: 'fail',
      code: flagged[0].code,
      flagged,
      github: github.ok ? 'ok' : 'github-unreachable',
      netlify: netlify.ok ? 'ok' : 'netlify-unreadable',
    };
  }
  if (!github.ok) return { status: 'warn', code: 'github-unreachable' };
  if (!netlify.ok) return { status: 'warn', code: 'netlify-unreadable' };
  if (!ledger.ok) return { status: 'warn', code: 'ledger-unreadable' };
  if (!ledger.entries.length) return { status: 'warn', code: 'baseline-pending', ledger: 0 };
  return { status: 'ok', code: 'ok', ledger: ledger.entries.length };
}

const CHECKS = [
  ['pulls', (ctx) => ctx.date, checkPulls],
  ['card', (ctx) => ctx.date, checkCard],
  ['mirror', (ctx) => ctx.date, checkMirror],
  ['bounds', (ctx) => ctx.date, checkBounds],
  ['grading', (ctx) => ctx.prev, checkGrading],
  ['kpis', (ctx) => ctx.date, checkKpis],
  ['closes', (ctx) => ctx.prev, checkCloses],
  ['news', (ctx) => ctx.date, checkNews],
  ['credits', (ctx) => ctx.date, checkCredits],
  ['external-changes', (ctx) => ctx.date, checkExternalChanges],
];

async function runDailyCheck(opts) {
  const options = opts || {};
  const env = options.env != null ? options.env : process.env;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const qs = (options.event && options.event.queryStringParameters) || {};
  const date = options.date || qs.date || etParts(now).ymd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('daily-check refused bad date');
  }
  const prev = shiftYmd(date, -1);
  const dry = writesBlocked(options);
  if (!dailyCheckEnabled(env)) {
    return {
      schema: 'omega-ops-daily-check-v1',
      date,
      prevDate: prev,
      ranAt: now.toISOString(),
      dryRun: dry,
      skipped: 'flag-off',
      ok: true,
      checks: [],
    };
  }
  const ctx = Object.assign({}, options, { env, now, date, prev, dry });
  const checks = [];
  for (const [id, dateOf, fn] of CHECKS) {
    try {
      const assessed = await fn(ctx);
      checks.push(row(id, dateOf(ctx), assessed));
    } catch (err) {
      checks.push({
        id,
        date: dateOf(ctx),
        status: 'fail',
        evidence: { code: 'check-failed', detail: safeErr(err) },
      });
    }
  }
  const report = {
    schema: 'omega-ops-daily-check-v1',
    date,
    prevDate: prev,
    ranAt: now.toISOString(),
    dryRun: dry,
    ok: checks.every((item) => item.status === 'ok' || item.status === 'fixed'),
    checks,
  };
  if (!dry) {
    try {
      await writeDailyReport(date, report, options);
    } catch (err) {
      opsAlert('daily-check-store-failed', `date=${date} ${safeErr(err)}`);
    }
  }
  for (const item of checks) {
    if (item.status !== 'ok') {
      const code = item.evidence && item.evidence.code ? item.evidence.code : item.status;
      opsAlert(`daily-check-${item.id}`, `date=${item.date} status=${item.status} code=${code}`);
    }
  }
  const url = webhookUrl(options);
  if (!dry && url) {
    const post = options.postWebhook || postWebhook;
    try {
      const resp = await post(url, report);
      if (resp && resp.ok === false) {
        console.warn(JSON.stringify({ event: 'dailyCheckWebhookSoftFail', date, status: resp.status }));
      }
    } catch (err) {
      console.warn(JSON.stringify({ event: 'dailyCheckWebhookSoftFail', date, error: safeErr(err) }));
    }
  }
  return report;
}

module.exports = {
  DAILY_FLAG,
  RESULTS_CACHE_KEY,
  NEWS_SNAPSHOT_STORE,
  V1_STORE,
  CLOSE_CAPTURE_STORE,
  REPORT_STORE,
  dailyCheckEnabled,
  dailyCheckKey,
  shiftYmd,
  writesBlocked,
  webhookUrl,
  etWallUtcMs,
  generatedBeforeDeadline,
  assessPullSlot,
  assessCardShape,
  assessBounds,
  assessGrades,
  assessCloses,
  creditStatus,
  latestRemaining,
  sameMultiset,
  stakeUsd,
  runDailyCheck,
  readDailyReport,
  writeDailyReport,
  refuseCardKey,
};
