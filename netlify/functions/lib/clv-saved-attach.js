'use strict';

/**
 * Attach a saved Pinnacle close when the live odds feed has dropped the game.
 * OMEGA_CLV_SAVED_ATTACH defaults on. =off leaves the feed miss unchanged.
 * Sources, in order: the card pick's saved quote (or the 3 AM summary row),
 * clv.odds_snapshots from capture-closes-3am, then a saved-board event.
 * Sport, teams, market, side, and line must match. While OMEGA_CLV_LINE_MATCH
 * is on, a different number is not a close. No Odds API calls.
 *
 * Backfill (same track-clv-omega entrypoint, saved data only, idempotent):
 *   POST /.netlify/functions/track-clv-omega?backfill=2026-11-18..2026-11-24
 *   POST /.netlify/functions/track-clv-omega?days=7
 *   POST body {"backfill":"2026-11-18..2026-11-24"} or {"days":7}
 * A pick that already has closing odds, a closing line, or CLV is not rewritten.
 */

const C = require('./closes-3am');
const { savedClvAttachEnabled, clvLineMatchEnabled } = require('./default_on_flag');
const { etYmd, addDays } = require('./clv-supabase');

const LINE_EPS = 1e-6;
const SOURCE_RE = /capture-closes-3am|odds-master-board/i;

function impliedProbability(americanOdds) {
  const odds = parseInt(americanOdds, 10);
  if (isNaN(odds)) return null;
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

function betLineNumber(pick) {
  const market = C.pickMarket(pick);
  if (!pick || market === 'h2h') return null;
  if (pick.betLine != null && pick.betLine !== '' && Number.isFinite(Number(pick.betLine))) {
    return Number(pick.betLine);
  }
  const text = String(pick.pick || pick.side || '');
  if (market === 'totals') {
    const total = text.match(/(?:over|under)\s*([+-]?\d+(?:\.\d+)?)/i);
    if (total) return Number(total[1]);
  }
  const found = text.match(/([+-]\d+(?:\.\d+)?)/);
  return found ? Number(found[1]) : null;
}

function sameSport(a, b) {
  const norm = (value) => {
    const label = String(value || '').toUpperCase();
    if (label === 'CFB') return 'NCAAF';
    if (label === 'NCAAB') return 'NCAAM';
    return label;
  };
  if (!a || !b) return true;
  return norm(a) === norm(b);
}

function exactLine(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= LINE_EPS;
}

function rowHasClose(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.closingOdds != null && rec.closingOdds !== '') return true;
  if (rec.closingLine != null && rec.closingLine !== '') return true;
  if (rec.clv != null && rec.clv !== '') return true;
  return false;
}

function gameMatchesPick(game, pick, env) {
  if (!game || !pick) return false;
  if (game.sport && pick.sport && !sameSport(game.sport, pick.sport)) return false;
  const home = game.home_team || game.homeTeam;
  const away = game.away_team || game.awayTeam;
  if (!home || !away) return false;
  const teams = C.teamsFromMatchup(pick.matchup);
  const sport = pick.sport;
  if (teams.awayTeam && teams.homeTeam) {
    const direct = C.pairMatch(teams.awayTeam, away, sport, env) && C.pairMatch(teams.homeTeam, home, sport, env);
    const flip = C.pairMatch(teams.awayTeam, home, sport, env) && C.pairMatch(teams.homeTeam, away, sport, env);
    if (direct || flip) return true;
  }
  const blob = `${pick.matchup || ''} ${pick.pick || ''}`;
  return C.pairMatch(home, blob, sport, env) && C.pairMatch(away, blob, sport, env);
}

function isSavedSnap(row) {
  if (!row || row.price == null || row.price === '') return false;
  const book = String(row.book || 'pinnacle').toLowerCase();
  if (book !== 'pinnacle') return false;
  const kind = String(row.line_type || 'closing').toLowerCase();
  if (kind !== 'closing') return false;
  const source = row.source == null ? '' : String(row.source);
  if (source && !SOURCE_RE.test(source)) return false;
  return true;
}

function eventFromSnapshots(game, snaps) {
  const id = game.game_id || game.id;
  const rows = (snaps || []).filter((row) => row && String(row.game_id) === String(id) && isSavedSnap(row));
  rows.sort((a, b) => (Date.parse(b.snapshot_ts) || 0) - (Date.parse(a.snapshot_ts) || 0));
  const markets = new Map();
  for (const row of rows) {
    const key = String(row.market || '');
    if (!key) continue;
    if (!markets.has(key)) markets.set(key, []);
    const outcome = { name: row.side, price: Number(row.price) };
    if (row.point != null && row.point !== '') outcome.point = Number(row.point);
    markets.get(key).push(outcome);
  }
  if (!markets.size) return null;
  return {
    id,
    sport: game.sport,
    home_team: game.home_team || game.homeTeam,
    away_team: game.away_team || game.awayTeam,
    commence_time: game.commence_time || game.commenceTime || null,
    bookmakers: [{
      key: 'pinnacle',
      title: 'pinnacle',
      markets: [...markets.entries()].map(([key, outcomes]) => ({ key, outcomes })),
    }],
  };
}

function eventFromQuote(pick, quote, env) {
  if (!quote || quote.closingOdds == null || quote.oppOdds == null) return null;
  const teams = C.teamsFromMatchup(pick.matchup);
  const home = teams.homeTeam;
  const away = teams.awayTeam;
  if (!home || !away) return null;
  const market = C.pickMarket(pick);
  const line = quote.closingLine == null || quote.closingLine === '' ? null : Number(quote.closingLine);
  let sideName = home;
  let oppName = away;
  let sidePoint = line;
  let oppPoint = line;
  if (market === 'totals') {
    const under = /^under\b/i.test(String(pick.pick || pick.side || ''));
    sideName = under ? 'Under' : 'Over';
    oppName = under ? 'Over' : 'Under';
  } else if (market === 'h2h') {
    sidePoint = null;
    oppPoint = null;
    const text = String(pick.pick || '').replace(/\bML\b/gi, '').trim();
    if (C.pairMatch(text, away, pick.sport, env)) {
      sideName = away;
      oppName = home;
    }
  } else {
    const text = String(pick.pick || '').replace(/[+-]?\d+(?:\.\d+)?/g, '').trim();
    if (C.pairMatch(text, away, pick.sport, env) && !C.pairMatch(text, home, pick.sport, env)) {
      sideName = away;
      oppName = home;
    }
    oppPoint = line == null ? null : -line;
  }
  const side = { name: sideName, price: Number(quote.closingOdds) };
  const opp = { name: oppName, price: Number(quote.oppOdds) };
  if (sidePoint != null) side.point = sidePoint;
  if (oppPoint != null) opp.point = oppPoint;
  return {
    id: 'saved-pick',
    sport: pick.sport,
    home_team: home,
    away_team: away,
    bookmakers: [{ key: 'pinnacle', title: 'pinnacle', markets: [{ key: market, outcomes: [side, opp] }] }],
    closeSnapshotAt: quote.closeSnapshotAt || null,
  };
}

function toClose(quote, stamp) {
  if (!quote || quote.closingOdds == null || quote.oppOdds == null) return null;
  const sideRaw = impliedProbability(quote.closingOdds);
  const oppRaw = impliedProbability(quote.oppOdds);
  if (sideRaw == null || oppRaw == null) return null;
  const overround = sideRaw + oppRaw;
  if (!(overround > 0)) return null;
  return {
    sideOdds: Number(quote.closingOdds),
    sideRaw,
    overround,
    closingLine: quote.closingLine == null || quote.closingLine === '' ? null : Number(quote.closingLine),
    oppOdds: Number(quote.oppOdds),
    anchor: 'pinnacle',
    anchorBook: 'pinnacle',
    savedAttach: true,
    closeSnapshotAt: stamp || quote.closeSnapshotAt || null,
  };
}

function closeFromEvent(event, pick, env, lineMatchOn) {
  if (!event || !gameMatchesPick(event, pick, env)) return null;
  const quote = C.quoteFromEvent(event, pick, env);
  if (!quote || quote.closingOdds == null || quote.oppOdds == null) return null;
  if (lineMatchOn && quote.closeFallback === 'posted-line') return null;
  const market = C.pickMarket(pick);
  if (lineMatchOn && market !== 'h2h') {
    const want = betLineNumber(pick);
    if (!exactLine(want, quote.closingLine)) return null;
  }
  return toClose(quote, event.closeSnapshotAt || quote.closeSnapshotAt || null);
}

function summaryQuote(pick, summaryPicks) {
  if (!pick || !Array.isArray(summaryPicks)) return null;
  const want = String(pick.pick || '');
  const matchup = String(pick.matchup || '');
  return summaryPicks.find((row) => {
    if (!row || row.pick !== want) return false;
    if (matchup && row.matchup && row.matchup !== matchup) return false;
    return row.closingOdds != null && row.oppOdds != null;
  }) || null;
}

function resolveSavedClose(pick, bundle, env) {
  if (!savedClvAttachEnabled(env) || !pick) return null;
  const lineMatchOn = clvLineMatchEnabled(env);
  const own = (pick.closingOdds != null && pick.oppOdds != null) ? pick : summaryQuote(pick, bundle && bundle.summaryPicks);
  if (own && own.closingOdds != null && own.oppOdds != null) {
    const synthetic = eventFromQuote(pick, own, env);
    const fromPick = synthetic && closeFromEvent(synthetic, pick, env, lineMatchOn);
    if (fromPick) return fromPick;
  }
  const games = (bundle && bundle.games) || [];
  const snaps = (bundle && bundle.snapshots) || [];
  const game = games.find((row) => gameMatchesPick(row, pick, env));
  if (game) {
    const event = eventFromSnapshots(game, snaps);
    const fromSnap = event && closeFromEvent(event, pick, env, lineMatchOn);
    if (fromSnap) return fromSnap;
  }
  for (const event of (bundle && bundle.events) || []) {
    const fromEvent = closeFromEvent(event, pick, env, lineMatchOn);
    if (fromEvent) return fromEvent;
  }
  return null;
}

function eachDate(from, to) {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const out = [];
  for (let t = start; t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > 31) return null;
  }
  return out;
}

function parseBackfillRequest(params, body, now) {
  const src = Object.assign({}, params || {}, body || {});
  const hasBackfill = src.backfill != null && String(src.backfill).trim() !== '';
  const hasDays = src.days != null && String(src.days).trim() !== '';
  if (!hasBackfill && !hasDays) return null;
  if (hasBackfill) {
    const text = String(src.backfill).trim();
    const range = text.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (range) {
      const dates = eachDate(range[1], range[2]);
      if (!dates) return { error: 'bad-backfill' };
      return { dates };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { dates: [text] };
    return { error: 'bad-backfill' };
  }
  const n = Number(src.days);
  if (!Number.isInteger(n) || n < 1 || n > 31) return { error: 'bad-days' };
  const end = etYmd(now instanceof Date ? now : new Date(now || Date.now()));
  const dates = [];
  for (let i = n - 1; i >= 0; i -= 1) dates.push(addDays(end, -i));
  return { dates };
}

function safeReason(err) {
  return String(err && err.message || err || 'error')
    .replace(/bearer\s+\S+/gi, 'bearer redacted')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'redacted')
    .slice(0, 180);
}

async function supaGet(env, fetchImpl, table, pairs) {
  const key = env && env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return [];
  const { SUPABASE_URL } = require('./clv-supabase');
  const url = new URL(`${String(SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${table}`);
  for (const [name, value] of pairs) url.searchParams.append(name, value);
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
    init.signal = AbortSignal.timeout(4000);
  }
  const resp = await (fetchImpl || fetch)(url.toString(), init);
  if (!resp || !resp.ok) {
    throw new Error(`supabase ${table} HTTP ${resp && resp.status ? resp.status : 'error'}`);
  }
  const body = await resp.json();
  if (!Array.isArray(body)) throw new Error(`supabase ${table} bad payload`);
  return body;
}

async function loadSupabaseBundle(date, picks, env, fetchImpl) {
  if (!env || !env.SUPABASE_SERVICE_ROLE_KEY) return { games: [], snapshots: [] };
  const from = `${addDays(date, -1)}T00:00:00.000Z`;
  const to = `${addDays(date, 2)}T00:00:00.000Z`;
  const games = await supaGet(env, fetchImpl, 'games', [
    ['select', 'game_id,sport,commence_time,home_team,away_team'],
    ['commence_time', `gte.${from}`],
    ['commence_time', `lt.${to}`],
  ]);
  const matched = (games || []).filter((game) => (picks || []).some((pick) => gameMatchesPick(game, pick, env)));
  const ids = [...new Set(matched.map((game) => game && game.game_id).filter((id) => /^[A-Za-z0-9_.-]+$/.test(String(id || ''))))];
  if (!ids.length) return { games: matched, snapshots: [] };
  const snapshots = await supaGet(env, fetchImpl, 'odds_snapshots', [
    ['select', 'game_id,sport,book,market,side,point,price,line_type,snapshot_ts,source'],
    ['game_id', `in.(${ids.join(',')})`],
    ['book', 'eq.pinnacle'],
    ['line_type', 'eq.closing'],
    ['source', 'like.*capture-closes-3am*'],
  ]);
  return { games: matched, snapshots: snapshots || [] };
}

async function loadBoardEvents(date, picks, opts) {
  const events = [];
  const sports = [...new Set((picks || []).map((pick) => pick && pick.sport).filter(Boolean))];
  for (const sport of sports) {
    const key = C.sportKeyOf(sport);
    if (!key) continue;
    try {
      const rows = await C.loadStoredEventsForSport(key, {
        date,
        env: opts.env,
        blobs: opts.blobs,
        readMaster: opts.readMaster,
        storedEventsBySport: opts.storedEventsBySport,
      });
      for (const event of rows || []) events.push(event);
    } catch (err) {
      console.log(`[track-clv] saved board ${sport}: ${safeReason(err)}`);
    }
  }
  return events;
}

async function readClosesSummary(date) {
  try {
    const { readJson } = require('./odds-master/store');
    return await readJson(`closes-3am/${date}`, C.STORE);
  } catch (_) {
    return null;
  }
}

async function loadSavedBundle(date, picks, opts) {
  const options = opts || {};
  if (options.provided) {
    return {
      games: options.games || [],
      snapshots: options.snapshots || [],
      events: options.events || [],
      summaryPicks: options.summaryPicks || [],
    };
  }
  const out = { games: [], snapshots: [], events: options.events || [], summaryPicks: options.summaryPicks || [] };
  if (options.allowRemote !== false) {
    try {
      const summary = await readClosesSummary(date);
      if (summary && Array.isArray(summary.picks)) out.summaryPicks = summary.picks;
    } catch (err) {
      console.log(`[track-clv] saved summary: ${safeReason(err)}`);
    }
    try {
      const loaded = await loadSupabaseBundle(date, picks, options.env, options.fetchImpl);
      out.games = loaded.games;
      out.snapshots = loaded.snapshots;
    } catch (err) {
      console.log(`[track-clv] saved snapshots: ${safeReason(err)}`);
    }
  }
  if (options.allowBoard) {
    const board = await loadBoardEvents(date, picks, options);
    out.events = out.events.concat(board);
  }
  return out;
}

module.exports = {
  resolveSavedClose,
  loadSavedBundle,
  parseBackfillRequest,
  rowHasClose,
  gameMatchesPick,
  betLineNumber,
};
