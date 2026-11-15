'use strict';

/**
 * Replace an early clv-{date} close with the Pinnacle true close already
 * stored by capture-pick-closes (clv.games + clv.odds_snapshots).
 * OMEGA_CLV_TRUE_CLOSE defaults on. off / 0 / false leaves the ledger alone.
 * No Odds API calls. Failures return an empty map and a reason.
 */

const { SUPABASE_URL } = require('./clv-supabase');
const { defaultOnFlag } = require('./default_on_flag');
const { summarizePickClv } = require('./clv-summary');
const { pickClvEnabled } = require('./omega-v2/constants');
const { noVigTwoWay, americanToImplied } = require('./omega-vnext/odds_math');
const {
  publishedTickets,
  pickClvKey,
  mergePickClv,
  marketOf,
  lineOf,
  explicitBet,
} = require('./omega-v2/candidate_clv');

const WINDOW_BEFORE_MS = 20 * 60 * 1000;
const WINDOW_AFTER_MS = 3 * 60 * 1000;
const GAME_MATCH_MS = 10 * 60 * 1000;
const EARLY_MIN = 10;
const POINT_EPS = 0.001;
const FETCH_TIMEOUT_MS = 3500;

function trueCloseEnabled(env) {
  return defaultOnFlag('OMEGA_CLV_TRUE_CLOSE', env);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundTo(n, places) {
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(places));
}

function samePoint(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) <= POINT_EPS;
}

function safeReason(err) {
  let msg = String(err && err.message || err || 'error');
  msg = msg.replace(/bearer\s+\S+/gi, 'bearer redacted');
  msg = msg.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'redacted');
  return msg.slice(0, 180);
}

function trackerApi() {
  const mod = require('../track-clv-omega');
  const t = mod._test;
  return {
    teamsMatch: t.teamsMatch,
    stripLine: t.stripLine,
    parseBetLine: t.parseBetLine,
    pickSideInfo: t.pickSideInfo,
    impliedProbability: t.impliedProbability,
    summarizeTrackedPicks: mod.summarizeTrackedPicks,
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function mergeWindows(commenceTimes) {
  const pts = [];
  const seen = new Set();
  for (const raw of commenceTimes || []) {
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms) || seen.has(ms)) continue;
    seen.add(ms);
    pts.push(ms);
  }
  pts.sort((a, b) => a - b);
  if (!pts.length) return [];
  const out = [];
  let start = pts[0] - GAME_MATCH_MS;
  let end = pts[0] + GAME_MATCH_MS;
  for (let i = 1; i < pts.length; i += 1) {
    const nextStart = pts[i] - GAME_MATCH_MS;
    const nextEnd = pts[i] + GAME_MATCH_MS;
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      out.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  out.push([start, end]);
  return out;
}

function sameSport(game, pick) {
  if (!pick || !pick.sport || !game || !game.sport) return true;
  const a = String(pick.sport).toUpperCase();
  const b = String(game.sport).toUpperCase();
  if (a === b) return true;
  if ((a === 'CFB' || a === 'NCAAF') && (b === 'CFB' || b === 'NCAAF')) return true;
  if ((a === 'NCAAB' || a === 'NCAAM') && (b === 'NCAAB' || b === 'NCAAM')) return true;
  return false;
}

function gameTeamsMatch(game, pick, teamsMatch) {
  const home = game && game.home_team;
  const away = game && game.away_team;
  if (!home || !away || !pick) return false;
  if (pick.homeTeam && pick.awayTeam) {
    if (teamsMatch(pick.homeTeam, home) && teamsMatch(pick.awayTeam, away)) return true;
    if (teamsMatch(pick.homeTeam, away) && teamsMatch(pick.awayTeam, home)) return true;
  }
  const matchup = String(pick.matchup || '');
  const parts = matchup.split(/\s+(?:@|vs\.?|at)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const [a, b] = parts;
    if ((teamsMatch(a, away) && teamsMatch(b, home)) || (teamsMatch(a, home) && teamsMatch(b, away))) return true;
  }
  const blob = `${matchup} ${pick.pick || ''} ${pick.side || ''}`;
  return teamsMatch(home, blob) && teamsMatch(away, blob);
}

function betLineOf(pick, sideInfo, api) {
  if (!sideInfo || sideInfo.marketBase === 'h2h') return null;
  const direct = num(pick && (pick.betLine != null && pick.betLine !== '' ? pick.betLine : pick.line));
  if (direct != null) return direct;
  try {
    return num(api.parseBetLine(pick || {}, sideInfo));
  } catch (_) {
    return null;
  }
}

function oddsString(price) {
  const n = Math.round(Number(price));
  if (!Number.isFinite(n) || n === 0) return null;
  return String(n);
}

function isEarlyClose(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const mins = num(rec.captureMinsToCommence);
  if (mins == null || mins > EARLY_MIN) return true;
  const commence = Date.parse(rec.commenceTime);
  const snap = Date.parse(rec.closeSnapshotAt);
  if (Number.isFinite(commence) && Number.isFinite(snap) && (commence - snap) > EARLY_MIN * 60 * 1000) {
    return true;
  }
  return false;
}

async function supabaseGet(table, pairs, env, fetchImpl) {
  const key = env && env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    const err = new Error('missing env: SUPABASE_SERVICE_ROLE_KEY');
    err.code = 'missing-env';
    throw err;
  }
  const url = new URL(`${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${table}`);
  for (const [k, v] of pairs) url.searchParams.append(k, v);
  const init = {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Accept-Profile': 'clv',
    },
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }
  const resp = await (fetchImpl || fetch)(url.toString(), init);
  if (!resp || !resp.ok) {
    throw new Error(`supabase ${table} HTTP ${resp && resp.status ? resp.status : 'error'}`);
  }
  const body = await resp.json();
  if (!Array.isArray(body)) throw new Error(`supabase ${table} bad payload`);
  return body;
}

async function loadGames(commenceTimes, env, fetchImpl) {
  const windows = mergeWindows(commenceTimes);
  if (!windows.length) return [];
  const games = [];
  const chunkSize = 8;
  for (let i = 0; i < windows.length; i += chunkSize) {
    const chunk = windows.slice(i, i + chunkSize);
    const orValue = `(${chunk.map(([start, end]) => `and(commence_time.gte.${iso(start)},commence_time.lte.${iso(end)})`).join(',')})`;
    const rows = await supabaseGet('games', [
      ['select', 'game_id,sport,commence_time,home_team,away_team'],
      ['or', orValue],
    ], env, fetchImpl);
    games.push(...rows);
  }
  return games;
}

function inFilter(ids) {
  const parts = ids.map((id) => {
    const s = String(id);
    return /^[A-Za-z0-9_.-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`;
  });
  return `in.(${parts.join(',')})`;
}

async function loadSnapshots(gameIds, env, fetchImpl) {
  // Pinnacle + closing only. Not filtered by source, so capture-pick-closes
  // and capture-all-closes rows both count.
  const ids = [...new Set((gameIds || []).filter(Boolean).map((id) => String(id)))];
  const rows = [];
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const part = await supabaseGet('odds_snapshots', [
      ['select', 'game_id,sport,book,market,side,point,price,line_type,snapshot_ts,source'],
      ['game_id', inFilter(chunk)],
      ['line_type', 'eq.closing'],
      ['book', 'eq.pinnacle'],
    ], env, fetchImpl);
    rows.push(...part);
  }
  return rows;
}

function pinnacleClosingRows(rows, gameId, marketBase) {
  return (rows || []).filter((row) => {
    if (!row) return false;
    if (String(row.game_id) !== String(gameId)) return false;
    if (String(row.book || '').toLowerCase() !== 'pinnacle') return false;
    if (String(row.line_type || '').toLowerCase() !== 'closing') return false;
    if (marketBase && String(row.market || '') !== marketBase) return false;
    return true;
  });
}

function inCloseWindow(row, commenceMs) {
  const ts = Date.parse(row && row.snapshot_ts);
  if (!Number.isFinite(ts) || !Number.isFinite(commenceMs)) return false;
  const delta = ts - commenceMs;
  return delta >= -WINDOW_BEFORE_MS && delta <= WINDOW_AFTER_MS;
}

function teamTextOf(pick, api) {
  return api.stripLine((pick && (pick.pick || pick.side)) || '');
}

function findPair(group, pick, game, sideInfo, betLine, api) {
  const teamsMatch = api.teamsMatch;
  if (sideInfo.marketBase === 'spreads') {
    if (betLine == null) return null;
    const teamText = teamTextOf(pick, api);
    const sideRow = group.find((row) => teamsMatch(row.side, teamText) && samePoint(row.point, betLine));
    if (!sideRow) return null;
    const oppRow = group.find((row) => row !== sideRow
      && samePoint(row.point, -Number(betLine))
      && !teamsMatch(row.side, sideRow.side));
    if (!oppRow) return { oneSide: true };
    return { sideRow, oppRow, closingLine: num(sideRow.point) };
  }
  if (sideInfo.marketBase === 'totals') {
    if (betLine == null) return null;
    const sideName = sideInfo.isOver ? 'over' : (sideInfo.isUnder ? 'under' : '');
    if (!sideName) return null;
    const oppName = sideName === 'over' ? 'under' : 'over';
    const sideRow = group.find((row) => String(row.side || '').toLowerCase() === sideName && samePoint(row.point, betLine));
    if (!sideRow) return null;
    const oppRow = group.find((row) => String(row.side || '').toLowerCase() === oppName && samePoint(row.point, betLine));
    if (!oppRow) return { oneSide: true };
    return { sideRow, oppRow, closingLine: num(sideRow.point) };
  }
  const teamText = teamTextOf(pick, api);
  const homeRow = group.find((row) => teamsMatch(row.side, game.home_team));
  const awayRow = group.find((row) => teamsMatch(row.side, game.away_team));
  if (!homeRow || !awayRow || homeRow === awayRow) {
    const sideOnly = group.find((row) => teamsMatch(row.side, teamText));
    return sideOnly ? { oneSide: true } : null;
  }
  const sideRow = teamsMatch(teamText, homeRow.side) ? homeRow : (teamsMatch(teamText, awayRow.side) ? awayRow : null);
  if (!sideRow) return null;
  const oppRow = sideRow === homeRow ? awayRow : homeRow;
  return { sideRow, oppRow, closingLine: null };
}

function chooseClose(rows, pick, game, sideInfo, betLine, api) {
  const commenceMs = Date.parse(game.commence_time);
  const windowRows = rows.filter((row) => inCloseWindow(row, commenceMs));
  if (!windowRows.length) {
    return { close: null, reason: 'no pinnacle closing snapshot in the close window' };
  }
  const groups = new Map();
  for (const row of windowRows) {
    const key = String(row.snapshot_ts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [];
  let oneSide = false;
  let otherLine = false;
  for (const [stamp, group] of groups) {
    const pair = findPair(group, pick, game, sideInfo, betLine, api);
    if (pair && pair.sideRow && pair.oppRow) {
      const ts = Date.parse(stamp);
      candidates.push({ ts, stamp, pair });
    } else if (pair && pair.oneSide) oneSide = true;
    else otherLine = true;
  }
  if (!candidates.length) {
    if (oneSide && !otherLine) return { close: null, reason: 'missing the other side at the bet line' };
    return { close: null, reason: 'closing line differs from bet line' };
  }
  const before = candidates.filter((c) => c.ts <= commenceMs).sort((a, b) => b.ts - a.ts);
  const chosen = before.length ? before[0] : candidates.filter((c) => c.ts > commenceMs).sort((a, b) => a.ts - b.ts)[0];
  const sideOdds = Math.round(Number(chosen.pair.sideRow.price));
  const oppOdds = Math.round(Number(chosen.pair.oppRow.price));
  if (!Number.isFinite(sideOdds) || !Number.isFinite(oppOdds) || sideOdds === 0 || oppOdds === 0) {
    return { close: null, reason: 'power devig failed' };
  }
  const fair = noVigTwoWay(sideOdds, oppOdds);
  if (!fair || !Number.isFinite(fair.p1)) return { close: null, reason: 'power devig failed' };
  const implied = api.impliedProbability(sideOdds);
  return {
    close: {
      sideOdds,
      oppOdds,
      closingOdds: oddsString(sideOdds),
      closingLine: chosen.pair.closingLine,
      closingNoVig: roundTo(fair.p1, 4),
      closeNoVig: roundTo(fair.p1, 6),
      fairP: fair.p1,
      closingImplied: implied == null ? null : roundTo(implied, 4),
      snapshotTs: chosen.stamp,
      gameId: game.game_id,
      commenceTime: game.commence_time,
      rowSource: chosen.pair.sideRow && chosen.pair.sideRow.source,
    },
    reason: null,
  };
}

function closeSourceLabel(rowSource) {
  const s = String(rowSource || '');
  if (s.includes('capture-all-closes')) return 'supabase:capture-all-closes';
  if (s.includes('capture-pick-closes')) return 'supabase:capture-pick-closes';
  if (s.startsWith('oddsapi-live:')) return `supabase:${s.slice('oddsapi-live:'.length)}`;
  return 'supabase:capture-pick-closes';
}

/** Same pick-price CLV numbers buildPickClvRow stores. clvPp is percentage points. */
function pickClvNumbers(close, betPrice) {
  const impliedRaw = betPrice == null ? null : americanToImplied(betPrice);
  const betImplied = impliedRaw == null ? null : roundTo(impliedRaw, 6);
  const closeNoVig = close && Number.isFinite(close.fairP)
    ? roundTo(close.fairP, 6)
    : (close && close.closeNoVig);
  const clvPp = closeNoVig != null && betImplied != null ? roundTo((closeNoVig - betImplied) * 100, 2) : null;
  return {
    betImplied,
    closeNoVig,
    clvPp,
    beatClose: clvPp == null ? null : clvPp > 0,
  };
}

function matchGame(games, pick, api) {
  const commence = Date.parse(pick && pick.commenceTime);
  if (!Number.isFinite(commence)) return { game: null, reason: 'no commenceTime' };
  const hits = (games || []).filter((game) => {
    const ts = Date.parse(game && game.commence_time);
    if (!Number.isFinite(ts) || Math.abs(ts - commence) > GAME_MATCH_MS) return false;
    if (!gameTeamsMatch(game, pick, api.teamsMatch)) return false;
    return true;
  });
  if (!hits.length) return { game: null, reason: 'no game within 10 minutes of commence' };
  const sportHits = hits.filter((game) => sameSport(game, pick));
  const pool = sportHits.length ? sportHits : hits;
  pool.sort((a, b) => Math.abs(Date.parse(a.commence_time) - commence) - Math.abs(Date.parse(b.commence_time) - commence));
  return { game: pool[0], reason: null };
}

function entryForPick(pick, games, snapshots, api) {
  if (!pick || typeof pick !== 'object') return { ok: false, close: null, reason: 'empty pick' };
  let sideInfo;
  try { sideInfo = api.pickSideInfo(pick); } catch (_) { sideInfo = null; }
  if (!sideInfo || !sideInfo.marketBase) return { ok: false, close: null, reason: 'unparsed market' };
  const matched = matchGame(games, pick, api);
  if (!matched.game) return { ok: false, close: null, reason: matched.reason };
  const betLine = betLineOf(pick, sideInfo, api);
  if (sideInfo.marketBase !== 'h2h' && betLine == null) {
    return { ok: false, close: null, reason: 'no bet line' };
  }
  const rows = pinnacleClosingRows(snapshots, matched.game.game_id, sideInfo.marketBase);
  const chosen = chooseClose(rows, pick, matched.game, sideInfo, betLine, api);
  return { ok: !!chosen.close, close: chosen.close, reason: chosen.reason, gameId: matched.game.game_id };
}

/**
 * Read Pinnacle closing snapshots for these picks.
 * @returns {Promise<{date: string|null, reason: string|null, entries: Array}>}
 * entries[i] lines up with picks[i]. On failure, entries are empty-close and reason is set.
 */
async function loadTrueCloses(dateISO, picks, env, fetchImpl) {
  const list = Array.isArray(picks) ? picks : [];
  const blank = (reason) => list.map(() => ({ ok: false, close: null, reason }));
  try {
    const api = trackerApi();
    const commenceTimes = [];
    for (const pick of list) {
      if (pick && pick.commenceTime) commenceTimes.push(pick.commenceTime);
    }
    if (!commenceTimes.length) {
      const reason = list.length ? 'no commenceTime' : null;
      return { date: dateISO || null, reason, entries: blank(reason) };
    }
    const games = await loadGames(commenceTimes, env, fetchImpl);
    const gameIds = [];
    const matched = list.map((pick) => {
      const hit = matchGame(games, pick, api);
      if (hit.game && hit.game.game_id) gameIds.push(hit.game.game_id);
      return hit;
    });
    const snapshots = gameIds.length ? await loadSnapshots(gameIds, env, fetchImpl) : [];
    const entries = list.map((pick, i) => {
      if (!matched[i] || !matched[i].game) {
        return { ok: false, close: null, reason: (matched[i] && matched[i].reason) || 'no game within 10 minutes of commence' };
      }
      return entryForPick(pick, [matched[i].game], snapshots, api);
    });
    return { date: dateISO || null, reason: null, entries };
  } catch (err) {
    const reason = safeReason(err);
    return { date: dateISO || null, reason, entries: blank(reason) };
  }
}

function refreshAliases(rec) {
  if (Object.prototype.hasOwnProperty.call(rec, 'beatClose')) rec.beatClose = rec.beatClosing;
  if (Object.prototype.hasOwnProperty.call(rec, 'clvPct') && rec.clv != null) rec.clvPct = roundTo(rec.clv * 100, 4);
  if (Object.prototype.hasOwnProperty.call(rec, 'realizedClvCents')) rec.realizedClvCents = rec.clvCents;
  if (Object.prototype.hasOwnProperty.call(rec, 'realizedCloseAt')) rec.realizedCloseAt = rec.closeSnapshotAt;
  if (Object.prototype.hasOwnProperty.call(rec, 'closeBook')) rec.closeBook = rec.anchorBook;
}

function applyCloseToLedgerRow(rec, close) {
  if (!rec.preTrueClose) {
    rec.preTrueClose = {
      closingOdds: rec.closingOdds == null ? null : rec.closingOdds,
      closingNoVig: rec.closingNoVig == null ? null : rec.closingNoVig,
      clv: rec.clv == null ? null : rec.clv,
      clvCents: rec.clvCents == null ? null : rec.clvCents,
      beatClosing: rec.beatClosing == null ? null : rec.beatClosing,
      closeSnapshotAt: rec.closeSnapshotAt == null ? null : rec.closeSnapshotAt,
      captureMinsToCommence: rec.captureMinsToCommence == null ? null : rec.captureMinsToCommence,
    };
  }
  const pickNv = num(rec.pickTimeNoVig);
  const closingNoVig = close.closingNoVig;
  const clv = (pickNv == null || closingNoVig == null) ? null : roundTo(closingNoVig - pickNv, 4);
  rec.closingOdds = close.closingOdds;
  rec.closingLine = close.closingLine;
  rec.closingNoVig = closingNoVig;
  rec.closingImplied = close.closingImplied;
  rec.clv = clv;
  rec.clvCents = clv == null ? null : roundTo(clv * 100, 2);
  rec.beatClosing = clv == null ? null : clv > 0;
  rec.closeSnapshotAt = close.snapshotTs;
  rec.captureMinsToCommence = 0;
  // Same rule as the tracker: a capture inside the pre-pitch window scores 0.
  rec.captureScore = 0;
  rec.anchor = 'pinnacle';
  rec.anchorBook = 'pinnacle';
  rec.closeSource = closeSourceLabel(close && close.rowSource);
  refreshAliases(rec);
}

function buildPickClvRow(ticket, close) {
  const cand = ticket && ticket.cand;
  const kind = ticket && ticket.kind === 'leg' ? 'leg' : 'straight';
  const idx = ticket && ticket.idx != null ? ticket.idx : 0;
  const market = cand && typeof cand === 'object' ? marketOf(cand) : null;
  const bet = explicitBet(cand);
  const numbers = pickClvNumbers(close, bet.price);
  return {
    rowKey: pickClvKey(cand, kind, idx),
    kind,
    sport: cand && cand.sport ? String(cand.sport).toUpperCase() : null,
    matchup: cand && cand.matchup ? String(cand.matchup) : null,
    side: cand && (cand.side || cand.pick) ? String(cand.side || cand.pick) : null,
    market,
    line: cand && typeof cand === 'object' ? lineOf(cand, marketOf(cand)) : null,
    betPrice: bet.price,
    betImplied: numbers.betImplied,
    closeNoVig: numbers.closeNoVig,
    sharpBook: 'pinnacle',
    sharpDevig: 'power',
    clvPp: numbers.clvPp,
    beatClose: numbers.beatClose,
    closeSource: closeSourceLabel(close && close.rowSource),
  };
}

function emptyReport(clvData, extra) {
  const n = clvData && Array.isArray(clvData.picks) ? clvData.picks.length : 0;
  return Object.assign({
    changed: false,
    picksExamined: n,
    upgraded: 0,
    stillEarly: 0,
    noTrueClose: [],
    reason: null,
  }, extra || {});
}

/**
 * Upgrade early ledger rows in place and recompute the day aggregates.
 * Pick-price pickClv rows are merged only when OMEGA_V2_PICK_CLV is on.
 * Flag off: the object is not touched.
 */
function upgradeLedger(clvData, picksData, closes, env) {
  if (!clvData || typeof clvData !== 'object') return emptyReport(clvData);
  if (!trueCloseEnabled(env)) return emptyReport(clvData, { skipped: 'flag-off' });
  const ledger = Array.isArray(clvData.picks) ? clvData.picks : [];
  const ledgerEntries = (closes && closes.ledgerEntries)
    || (closes && Array.isArray(closes.entries) ? closes.entries : []);
  const globalReason = closes && closes.reason;
  const noTrueClose = [];
  let upgraded = 0;
  let stillEarly = 0;
  ledger.forEach((rec, i) => {
    if (!rec || typeof rec !== 'object') return;
    if (!isEarlyClose(rec)) return;
    const entry = ledgerEntries[i] || { close: null, reason: globalReason || 'no true close' };
    if (entry.close) {
      applyCloseToLedgerRow(rec, entry.close);
      upgraded += 1;
      return;
    }
    stillEarly += 1;
    noTrueClose.push({
      pick: rec.pick == null ? null : rec.pick,
      matchup: rec.matchup == null ? null : rec.matchup,
      reason: entry.reason || globalReason || 'no true close',
    });
  });
  if (upgraded > 0) {
    const summary = trackerApi().summarizeTrackedPicks(ledger);
    Object.assign(clvData, summary);
  }

  let pickClvChanged = false;
  if (pickClvEnabled(env)) {
    const tickets = Array.isArray(closes && closes.tickets) ? closes.tickets : [];
    const ticketEntries = Array.isArray(closes && closes.ticketEntries) ? closes.ticketEntries : [];
    const rows = [];
    tickets.forEach((ticket, i) => {
      const entry = ticketEntries[i];
      if (!entry || !entry.close || !ticket || !ticket.cand) return;
      rows.push(buildPickClvRow(ticket, entry.close));
    });
    if (rows.length) {
      const prevRows = Array.isArray(clvData.pickClv) ? clvData.pickClv : [];
      const merged = mergePickClv(prevRows, rows);
      const summary = summarizePickClv(merged);
      const sameRows = JSON.stringify(merged) === JSON.stringify(clvData.pickClv || null);
      const sameSummary = JSON.stringify(summary) === JSON.stringify(clvData.pickClvSummary || null);
      if (!sameRows || !sameSummary) {
        clvData.pickClv = merged;
        clvData.pickClvSummary = summary;
        pickClvChanged = true;
      }
    }
  }

  return {
    changed: upgraded > 0 || pickClvChanged,
    picksExamined: ledger.length,
    upgraded,
    stillEarly,
    noTrueClose,
    reason: globalReason || null,
  };
}

async function applyTrueClose(clvData, picksData, env, fetchImpl) {
  if (!trueCloseEnabled(env)) return emptyReport(clvData, { skipped: 'flag-off' });
  if (!clvData || typeof clvData !== 'object') return emptyReport(clvData);
  const ledger = Array.isArray(clvData.picks) ? clvData.picks : [];
  let tickets = [];
  if (pickClvEnabled(env)) {
    try { tickets = publishedTickets(picksData); } catch (_) { tickets = []; }
  }
  const wanted = ledger.concat(tickets.map((ticket) => (ticket && ticket.cand) || null));
  const loaded = await loadTrueCloses(clvData.date, wanted, env, fetchImpl);
  const entries = loaded.entries || [];
  return upgradeLedger(clvData, picksData, {
    reason: loaded.reason,
    ledgerEntries: entries.slice(0, ledger.length),
    ticketEntries: entries.slice(ledger.length),
    tickets,
  }, env);
}

const CANDIDATE_CAP = 240;
const CANDIDATE_BUDGET_MS = 8000;

function candidateBetPrice(cand) {
  if (!cand || typeof cand !== 'object') return null;
  if (cand.betPrice != null && cand.betPrice !== '') return cand.betPrice;
  if (cand.odds != null && cand.odds !== '') return cand.odds;
  return null;
}

/** Graded candidate row or raw board candidate → the pick shape entryForPick reads. */
function candidateAsPick(cand) {
  const marketRaw = String((cand && (cand.market || cand.betType)) || '').toLowerCase();
  const side = String((cand && (cand.side || cand.pick)) || '');
  let betType = 'Moneyline';
  if (marketRaw === 'total' || marketRaw === 'totals' || /total/.test(marketRaw)) betType = 'Total';
  else if (marketRaw === 'spread' || marketRaw === 'spreads' || /spread|puck|run line/.test(marketRaw)) betType = 'Spread';
  else if (marketRaw === 'ml' || marketRaw === 'h2h' || /money/.test(marketRaw)) betType = 'Moneyline';
  let pick = side;
  const lineNum = cand && cand.line != null && cand.line !== '' ? Number(cand.line) : null;
  const line = Number.isFinite(lineNum) ? lineNum : null;
  if (betType === 'Total' && line != null && !/\d/.test(pick)) {
    pick = `${/under/i.test(pick) ? 'Under' : 'Over'} ${line}`;
  } else if (betType === 'Spread' && line != null && !/[+-]\d/.test(pick)) {
    const shown = line > 0 ? `+${line}` : String(line);
    pick = `${pick} ${shown}`.trim();
  } else if (betType === 'Moneyline' && pick && !/\bML\b/i.test(pick)) {
    pick = `${pick} ML`.trim();
  }
  const away = cand && cand.awayTeam;
  const home = cand && cand.homeTeam;
  return {
    sport: cand && cand.sport,
    matchup: (cand && cand.matchup) || (away && home ? `${away} @ ${home}` : null),
    homeTeam: home || null,
    awayTeam: away || null,
    pick,
    side,
    betType,
    market: betType,
    line,
    betLine: line,
    commenceTime: cand && cand.commenceTime,
    odds: candidateBetPrice(cand),
  };
}

function sampleSe(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const ss = values.reduce((sum, v) => sum + ((v - mean) ** 2), 0);
  return Math.sqrt((ss / (n - 1)) / n);
}

function trueCloseBucket(rows) {
  const vals = [];
  let beats = 0;
  for (const row of rows || []) {
    const pp = row && row.trueClose && row.trueClose.clvPp;
    if (pp == null || pp === '' || !Number.isFinite(Number(pp))) continue;
    const n = Number(pp);
    vals.push(n);
    if (row.trueClose.beatClose === true || (row.trueClose.beatClose == null && n > 0)) beats += 1;
  }
  if (!vals.length) return { n: 0, meanClvPp: null, beatRate: null, se: null };
  const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
  const se = sampleSe(vals);
  return {
    n: vals.length,
    meanClvPp: roundTo(mean, 2),
    beatRate: roundTo(beats / vals.length, 4),
    se: se == null ? null : roundTo(se, 4),
  };
}

/** { sport: {n, meanClvPp, beatRate, se}, overall: {...} } from rows that have trueClose.clvPp. */
function summarizeCandidateTrueClose(candidates) {
  const bySport = {};
  const groups = new Map();
  for (const row of candidates || []) {
    if (!row || !row.trueClose || row.trueClose.clvPp == null || !Number.isFinite(Number(row.trueClose.clvPp))) continue;
    const sport = row.sport ? String(row.sport).toUpperCase() : 'UNKNOWN';
    if (!groups.has(sport)) groups.set(sport, []);
    groups.get(sport).push(row);
  }
  for (const [sport, rows] of groups) bySport[sport] = trueCloseBucket(rows);
  bySport.overall = trueCloseBucket((candidates || []).filter((row) => row && row.trueClose && row.trueClose.clvPp != null));
  return bySport;
}

function withCandidateBudget(promise, ms) {
  let timer;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      settled = true;
      reject(new Error('candidate true-close budget'));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const work = Promise.resolve(promise).then(
    (value) => value,
    (err) => {
      if (settled) return undefined;
      throw err;
    },
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Additive true-close CLV on clv.candidates. Does not change other fields
 * or which rows are kept. Failures return a reason and leave the doc alone.
 */
async function upgradeCandidateTrueCloses(clvData, env, fetchImpl) {
  if (!trueCloseEnabled(env)) return { upgraded: 0, skipped: 'flag-off' };
  if (!clvData || typeof clvData !== 'object' || !Array.isArray(clvData.candidates)) {
    return { upgraded: 0, skipped: 'no-candidates' };
  }
  const all = clvData.candidates;
  if (!all.length) return { upgraded: 0, skipped: 'no-candidates' };
  const list = all.slice(0, CANDIDATE_CAP);
  if (all.length > list.length) {
    console.log(`[true-close] candidate cap ${CANDIDATE_CAP} of ${all.length}`);
  }
  try {
    const picks = list.map(candidateAsPick);
    const loaded = await withCandidateBudget(
      loadTrueCloses(clvData.date, picks, env, fetchImpl),
      CANDIDATE_BUDGET_MS,
    );
    if (!loaded || loaded.reason) {
      console.log(`[true-close] candidate upgrade skipped: ${loaded && loaded.reason ? loaded.reason : 'no result'}`);
      return { upgraded: 0, reason: loaded && loaded.reason ? loaded.reason : 'no result' };
    }
    let upgraded = 0;
    list.forEach((cand, i) => {
      const entry = loaded.entries && loaded.entries[i];
      if (!entry || !entry.close || !cand || typeof cand !== 'object') return;
      const numbers = pickClvNumbers(entry.close, candidateBetPrice(cand));
      cand.trueClose = {
        closeNoVig: numbers.closeNoVig,
        clvPp: numbers.clvPp,
        beatClose: numbers.beatClose,
        closeTs: entry.close.snapshotTs,
        source: closeSourceLabel(entry.close.rowSource),
      };
      upgraded += 1;
    });
    clvData.candidateTrueCloseBySport = summarizeCandidateTrueClose(all);
    return { upgraded, examined: list.length };
  } catch (err) {
    const reason = safeReason(err);
    console.log(`[true-close] candidate upgrade failed: ${reason}`);
    return { upgraded: 0, reason };
  }
}

async function upgradeDatesFromStore(dates, opts) {
  const env = opts && opts.env;
  const fetchImpl = opts && opts.fetchImpl;
  const out = [];
  for (const dateISO of dates || []) {
    try {
      const clvData = await opts.readClv(dateISO);
      if (!clvData || typeof clvData !== 'object' || Array.isArray(clvData)) {
        out.push({ date: dateISO, changed: false, wrote: false, skipped: 'no-ledger' });
        continue;
      }
      let picksData = null;
      try { picksData = await opts.readPicks(dateISO); } catch (_) { picksData = null; }
      const before = JSON.stringify(clvData);
      const report = await applyTrueClose(clvData, picksData, env, fetchImpl);
      let candidateTrueClose = null;
      try {
        candidateTrueClose = await upgradeCandidateTrueCloses(clvData, env, fetchImpl);
      } catch (err) {
        const reason = safeReason(err);
        console.log(`[true-close] candidate upgrade failed: ${reason}`);
        candidateTrueClose = { upgraded: 0, reason };
      }
      const changed = JSON.stringify(clvData) !== before;
      if (changed && opts.writeClv) await opts.writeClv(dateISO, clvData);
      out.push(Object.assign({ date: dateISO, wrote: changed }, report, { changed, candidateTrueClose }));
    } catch (err) {
      out.push({ date: dateISO, changed: false, wrote: false, reason: safeReason(err) });
    }
  }
  return out;
}

module.exports = {
  trueCloseEnabled,
  isEarlyClose,
  loadTrueCloses,
  upgradeLedger,
  applyTrueClose,
  upgradeDatesFromStore,
  closeSourceLabel,
  pickClvNumbers,
  upgradeCandidateTrueCloses,
  summarizeCandidateTrueClose,
};
