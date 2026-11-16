'use strict';

/**
 * 3 AM ET historical closes for the previous ET day.
 * One Odds API historical call per (sport, 10-minute commence bucket).
 * Snapshot time is the earliest tip in the bucket minus 60 seconds.
 * OMEGA_CLOSES_AT_3AM defaults on. OMEGA_CLOSES_3AM_CAP defaults to the
 * Saturday 2026-11-14 estimate plus about 25% headroom (see DEFAULT_CAP).
 * No schedule of its own. capture-odds-3am fires the background worker.
 */

const S = require('./clv-supabase');
const FB = require('./full-board-closes');
const { closesAt3amEnabled } = require('./default_on_flag');

const SPORTS = ['NFL', 'NBA', 'NCAAF', 'NCAAM', 'NHL'];
const MARKETS = ['h2h', 'spreads', 'totals'];
/**
 * 12 books plus the Hard Rock state feeds the old close job stored.
 * Keys match Odds API bookmakers used elsewhere (full-board-closes, verify, generate).
 * williamhill_us is Caesars.
 */
const BOOKS = [
  'pinnacle',
  'hardrockbet',
  'hardrockbet_fl',
  'hardrockbet_oh',
  'draftkings',
  'fanduel',
  'betmgm',
  'williamhill_us',
  'espnbet',
  'fanatics',
  'betrivers',
  'betonlineag',
  'bovada',
  'lowvig',
];
const CLOSE_BOOK = 'pinnacle';
const STORE = 'clv-close-capture';
const PICKS_STORE = 'edge-picks-omega';
const SOURCE = 'oddsapi-historical:capture-closes-3am';
const BUCKET_MS = 10 * 60 * 1000;
const SNAPSHOT_LEAD_MS = 60 * 1000;
const HISTORICAL_MULTIPLIER = 10;
const BOOKS_PER_REGION = 10;
const REGION_EQUIVALENTS = Math.ceil(BOOKS.length / BOOKS_PER_REGION);
/**
 * Historical cost = 10 × markets × region-equivalents.
 * Bookmakers are billed per 10 books. 14 books → 2. Three markets → 60.
 */
const EST_COST = HISTORICAL_MULTIPLIER * MARKETS.length * REGION_EQUIVALENTS;
/**
 * Peak measured slate: 2026-11-14 (Saturday) 49 sport-buckets × 60 = 2940.
 * Default cap is that estimate plus 25% (3675). Sunday 2026-11-15 was 30
 * buckets (1800). Monday 2026-11-16 was 16 buckets (960). Override with
 * OMEGA_CLOSES_3AM_CAP.
 */
const DEFAULT_CAP = 3675;
const RESERVE_FLOOR = 10000;
const CREDIT_PATH = 'closes-3am-historical';
const BACKFILL_DAYS = 7;
const ALLOWED_NO_CLOSE = new Set(['pinnacle-not-priced', 'not-in-historical-snapshot']);

function capFor(env) {
  const raw = env && env.OMEGA_CLOSES_3AM_CAP;
  if (raw == null || String(raw).trim() === '') return DEFAULT_CAP;
  const text = String(raw).trim();
  if (!/^[+]?\d+$/.test(text)) return DEFAULT_CAP;
  const n = Number(text);
  return Number.isFinite(n) ? n : DEFAULT_CAP;
}

function isoSecond(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function etDateOf(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function lastWord(value) {
  const parts = normName(value).split(' ');
  return parts[parts.length - 1] || '';
}

function teamsMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const la = lastWord(a);
  const lb = lastWord(b);
  return la.length > 3 && la === lb;
}

function teamsFromMatchup(matchup) {
  const parts = String(matchup || '').split(/\s+(?:@|vs\.?|at)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { awayTeam: parts[0], homeTeam: parts[1] };
  return { awayTeam: null, homeTeam: null };
}

function sportKeyOf(sport) {
  const label = String(sport || '').toUpperCase();
  if (label === 'CFB') return S.ODDS_SPORT_KEYS.NCAAF;
  if (label === 'NCAAB') return S.ODDS_SPORT_KEYS.NCAAM;
  return S.ODDS_SPORT_KEYS[label] || null;
}

function sportLabelOf(sportKey) {
  const want = String(sportKey || '');
  for (const [label, key] of Object.entries(S.ODDS_SPORT_KEYS)) {
    if (key === want) return label;
  }
  return null;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function scrub(text) {
  return String(text || '').replace(/apiKey=[^&\s]+/gi, 'apiKey=REDACTED').slice(0, 300);
}

function bucketDoneKey(sport, snapshotAt) {
  return `done-bucket/${sport}/${snapshotAt}`;
}

function summaryKey(date) {
  return `closes-3am/${date}`;
}

function pickKey(pick) {
  return [
    pick.kind || '',
    pick.sport || '',
    pick.matchup || '',
    pick.pick || '',
    pick.market || '',
    pick.commenceTime || '',
  ].join('|');
}

/**
 * Games whose commence times fall within 10 minutes of the bucket start,
 * one bucket per sport. Snapshot is the earliest tip minus 60s.
 */
function planBuckets(games) {
  const bySport = new Map();
  for (const game of games || []) {
    if (!game || !game.sport || !game.commenceTime) continue;
    const commenceMs = Date.parse(game.commenceTime);
    if (!Number.isFinite(commenceMs)) continue;
    if (!bySport.has(game.sport)) bySport.set(game.sport, []);
    bySport.get(game.sport).push(game);
  }
  const buckets = [];
  for (const [sport, list] of bySport) {
    list.sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
    let current = null;
    for (const game of list) {
      const commenceMs = Date.parse(game.commenceTime);
      if (!current || commenceMs > current.startMs + BUCKET_MS) {
        current = { sport, startMs: commenceMs, games: [] };
        buckets.push(current);
      }
      current.games.push(game);
    }
  }
  const planned = buckets.map((bucket) => {
    const times = bucket.games.map((game) => Date.parse(game.commenceTime));
    const min = Math.min(...times);
    const max = Math.max(...times);
    const snapshotMs = min - SNAPSHOT_LEAD_MS;
    const toMs = max === min ? min + 1000 : max;
    const priority = bucket.games.some((game) => game.roles && game.roles.has('card'))
      ? 0
      : (bucket.games.some((game) => game.roles && game.roles.has('candidate')) ? 1 : 2);
    return {
      sport: bucket.sport,
      sportKey: sportKeyOf(bucket.sport),
      snapshotAt: isoSecond(snapshotMs),
      from: isoSecond(min),
      to: isoSecond(toMs),
      startMs: min,
      priority,
      games: bucket.games,
    };
  });
  planned.sort((a, b) => a.priority - b.priority || a.snapshotAt.localeCompare(b.snapshotAt) || a.sport.localeCompare(b.sport));
  return planned;
}

function buildHistoricalUrl(apiKey, sportKey, snapshotAt, from, to) {
  const qs = new URLSearchParams({
    apiKey,
    date: snapshotAt,
    markets: MARKETS.join(','),
    oddsFormat: 'american',
    bookmakers: BOOKS.join(','),
    commenceTimeFrom: from,
    commenceTimeTo: to,
  });
  return `https://api.the-odds-api.com/v4/historical/sports/${sportKey}/odds?${qs}`;
}

/** Historical payloads wrap events in `.data` and carry timestamp / previous_timestamp. */
function unwrapHistorical(body) {
  if (Array.isArray(body)) {
    return { events: body, timestamp: null, previous_timestamp: null };
  }
  if (body && Array.isArray(body.data)) {
    return {
      events: body.data,
      timestamp: body.timestamp || null,
      previous_timestamp: body.previous_timestamp || null,
    };
  }
  return { events: [], timestamp: null, previous_timestamp: null };
}

function pinnacleBook(event) {
  return ((event && event.bookmakers) || []).find((book) => String(book.key || '').toLowerCase() === CLOSE_BOOK) || null;
}

function pinnacleMarket(event, market) {
  const book = pinnacleBook(event);
  if (!book) return null;
  const found = (book.markets || []).find((row) => row && row.key === market);
  if (!found || !Array.isArray(found.outcomes) || !found.outcomes.length) return null;
  const priced = found.outcomes.some((outcome) => outcome && outcome.price != null && outcome.price !== '');
  return priced ? found : null;
}

function eventInResponse(wanted, events) {
  const list = events || [];
  if (wanted && wanted.eventId) {
    const byId = list.find((event) => event && event.id != null && String(event.id) === String(wanted.eventId));
    if (byId) return byId;
  }
  if (!wanted || !wanted.homeTeam || !wanted.awayTeam) return null;
  return list.find((event) => {
    if (!event) return false;
    const home = event.home_team;
    const away = event.away_team;
    return (teamsMatch(wanted.homeTeam, home) && teamsMatch(wanted.awayTeam, away))
      || (teamsMatch(wanted.homeTeam, away) && teamsMatch(wanted.awayTeam, home));
  }) || null;
}

/**
 * A pick is satisfied only by its own event and its own market at Pinnacle.
 * A sibling game in the same bucket does not count.
 */
function assessPick(pick, events) {
  const event = eventInResponse(pick, events);
  if (!event) return { status: 'no-close', reason: 'not-in-historical-snapshot', event: null };
  if (!pinnacleMarket(event, pick.market)) return { status: 'no-close', reason: 'pinnacle-not-priced', event };
  return { status: 'closed', reason: null, event };
}

function reserveBlocks(remaining, cost) {
  if (remaining == null || remaining === '') return false;
  const n = Number(remaining);
  if (!Number.isFinite(n)) return false;
  return (n - cost) < RESERVE_FLOOR;
}

function sameGame(a, b) {
  if (!a || !b) return false;
  if (a.sport !== b.sport) return false;
  if (a.eventId && b.eventId && String(a.eventId) === String(b.eventId)) return true;
  if (a.commenceTime && b.commenceTime && a.commenceTime !== b.commenceTime) return false;
  if (!a.homeTeam || !a.awayTeam || !b.homeTeam || !b.awayTeam) return false;
  return (teamsMatch(a.homeTeam, b.homeTeam) && teamsMatch(a.awayTeam, b.awayTeam))
    || (teamsMatch(a.homeTeam, b.awayTeam) && teamsMatch(a.awayTeam, b.homeTeam));
}

function findListed(games, probe) {
  return (games || []).find((game) => sameGame(game, probe)) || null;
}

function pushPick(game, kind, pick) {
  game.roles.add(kind);
  game.picks.push({
    kind,
    sport: game.sport,
    matchup: pick.matchup || null,
    pick: pick.pick || pick.side || null,
    market: pick.market,
    eventId: game.eventId || null,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    commenceTime: game.commenceTime,
  });
}

function addTarget(games, probe, kind, pick) {
  const sport = String(probe.sport || '').toUpperCase();
  if (sport === 'CFB') probe = Object.assign({}, probe, { sport: 'NCAAF' });
  else if (sport === 'NCAAB') probe = Object.assign({}, probe, { sport: 'NCAAM' });
  else probe = Object.assign({}, probe, { sport });
  if (!SPORTS.includes(probe.sport)) return null;
  const commenceTime = FB.normalizeCommence(probe.commenceTime);
  if (!commenceTime) return null;
  const wanted = {
    sport: probe.sport,
    eventId: probe.eventId ? String(probe.eventId) : '',
    homeTeam: probe.homeTeam || null,
    awayTeam: probe.awayTeam || null,
    commenceTime,
  };
  let game = findListed(games, wanted);
  if (!game) {
    game = {
      sport: wanted.sport,
      eventId: wanted.eventId,
      homeTeam: wanted.homeTeam,
      awayTeam: wanted.awayTeam,
      commenceTime,
      roles: new Set(),
      picks: [],
    };
    games.push(game);
  } else if (!game.eventId && wanted.eventId) {
    game.eventId = wanted.eventId;
  }
  if (kind) pushPick(game, kind, Object.assign({ market: probe.market }, pick || {}));
  else game.roles.add('board');
  return game;
}

function collectGames(slateEvents, card, candidates, date) {
  const games = [];
  for (const ev of slateEvents || []) {
    const sport = String(ev.sport || '').toUpperCase();
    if (!SPORTS.includes(sport)) continue;
    const commenceTime = FB.normalizeCommence(ev.commenceTime || ev.commence_time);
    if (!commenceTime || etDateOf(commenceTime) !== date) continue;
    addTarget(games, {
      sport,
      eventId: ev.eventId || ev.id,
      homeTeam: ev.homeTeam || ev.home_team,
      awayTeam: ev.awayTeam || ev.away_team,
      commenceTime,
    }, null, null);
  }
  const legs = [];
  for (const pick of (card && card.picks) || []) legs.push(pick);
  for (const ticket of (card && card.parlayLegs) || []) {
    for (const leg of (ticket && ticket.legs) || []) legs.push(leg);
  }
  for (const leg of legs) {
    if (!leg) continue;
    const names = teamsFromMatchup(leg.matchup);
    const market = S.marketFromBetType(leg.betType || leg.market, leg.pick || leg.side);
    addTarget(games, {
      sport: leg.sport,
      eventId: leg.eventId || leg.event_id,
      homeTeam: leg.homeTeam || names.homeTeam,
      awayTeam: leg.awayTeam || names.awayTeam,
      commenceTime: leg.commenceTime,
      market,
    }, 'card', leg);
  }
  const rows = (candidates && (candidates.candidates || candidates.rows)) || (Array.isArray(candidates) ? candidates : []);
  for (const row of rows) {
    if (!row) continue;
    const names = teamsFromMatchup(row.matchup);
    const market = S.marketFromBetType(row.market || row.betType, row.side || row.pick);
    addTarget(games, {
      sport: row.sport,
      eventId: row.eventId || row.event_id,
      homeTeam: row.homeTeam || names.homeTeam,
      awayTeam: row.awayTeam || names.awayTeam,
      commenceTime: row.commenceTime,
      market,
    }, 'candidate', row);
  }
  return games;
}

function trackedPicks(games) {
  const out = [];
  for (const game of games || []) {
    for (const pick of game.picks || []) out.push(pick);
  }
  return out;
}

function decodeBlobKey(key) {
  return String(key || '').split('/').map((part) => {
    try { return decodeURIComponent(part); } catch (_) { return part; }
  }).join('/');
}

async function latestRemaining(blobs, now) {
  const today = S.etYmd(now);
  let best = null;
  let bestAt = -Infinity;
  for (const day of [today, S.addDays(today, -1), S.addDays(today, -2)]) {
    let doc = null;
    try { doc = await blobs.get(STORE, `credits/${day}`); } catch (_) { doc = null; }
    if (!doc) continue;
    const calls = Array.isArray(doc.calls) ? doc.calls : [];
    if (!calls.length && doc.remaining != null) {
      best = doc.remaining;
      bestAt = Date.parse(`${day}T00:00:00Z`) || bestAt;
    }
    for (const call of calls) {
      if (!call || call.remaining == null) continue;
      const at = Date.parse(call.at || '') || 0;
      if (at >= bestAt) {
        bestAt = at;
        best = call.remaining;
      }
    }
  }
  return best;
}

function spentOnPath(credits) {
  let spent = 0;
  for (const call of (credits && credits.calls) || []) {
    if (!call || call.path !== CREDIT_PATH) continue;
    spent += Number(call.estCost) || EST_COST;
  }
  return spent;
}

async function readOddsBody(resp) {
  if (resp && typeof resp.text === 'function') {
    const rawText = await resp.text();
    if (rawText) {
      try { return JSON.parse(rawText); } catch (_) { return null; }
    }
  }
  if (resp && typeof resp.json === 'function') return resp.json();
  return null;
}

function safeLog(message) {
  console.error(scrub(message));
}

/**
 * Apply one historical body to the stores the old close job writes.
 * `events` must already be unwrapped. Does not call the Odds API.
 */
async function applyBucketResponse(bucket, unpacked, ctx) {
  const when = ctx.now instanceof Date ? ctx.now : new Date();
  const events = unpacked.events || [];
  const rows = { games: [], snaps: [] };
  const pickResults = [];
  const satisfiedEventMarkets = new Set();
  const blockedCommence = new Set();
  for (const game of bucket.games) {
    for (const pick of game.picks || []) {
      const assessed = assessPick(pick, events);
      const row = Object.assign({}, pick, {
        status: assessed.status,
        reason: assessed.reason,
        eventId: (assessed.event && assessed.event.id) || pick.eventId || null,
      });
      pickResults.push(row);
      if (assessed.status !== 'closed') blockedCommence.add(`${pick.commenceTime}|${pick.market}`);
    }
    const event = eventInResponse(game, events);
    if (!event) continue;
    for (const market of MARKETS) {
      if (pinnacleMarket(event, market)) satisfiedEventMarkets.add(`${event.id}|${market}`);
    }
  }
  for (const event of events) {
    if (!event) continue;
    const built = S.rowsFromOddsEvent(bucket.sport, event, {
      lineType: 'closing',
      source: SOURCE,
      books: BOOKS,
      markets: MARKETS,
    });
    if (built.game) rows.games.push(built.game);
    rows.snaps.push(...built.snaps);
  }
  let posted = { games: 0, odds_snapshots: 0, requests: 0 };
  if (!ctx.dryRun) {
    const writeRows = ctx.writeRows || S.writeRows;
    posted = await writeRows(rows, ctx.env, ctx.fetch);
  } else {
    posted = { games: rows.games.length, odds_snapshots: rows.snaps.length, requests: 0, dryRun: true };
  }
  const doneWrites = [];
  if (!ctx.dryRun && ctx.blobs) {
    for (const event of events) {
      if (!event || event.id == null) continue;
      const ct = FB.normalizeCommence(event.commence_time);
      let any = false;
      for (const market of MARKETS) {
        if (!pinnacleMarket(event, market)) continue;
        any = true;
        if (ct && blockedCommence.has(`${ct}|${market}`)) continue;
        const key = FB.doneMarketKey(bucket.sport, ct, market);
        const payload = {
          at: when.toISOString(),
          via: 'closes-3am',
          events: events.length,
          posted,
          eventId: String(event.id),
        };
        doneWrites.push(key);
        await ctx.blobs.set(STORE, key, payload);
      }
      if (any) {
        const key = FB.doneEvKey(bucket.sport, event.id);
        doneWrites.push(key);
        await ctx.blobs.set(STORE, key, {
          at: when.toISOString(),
          commenceTime: ct,
          via: 'closes-3am',
        });
      }
    }
    if (ctx.storeClose) {
      for (const event of events) {
        if (!event || !pinnacleBook(event)) continue;
        try {
          await ctx.storeClose(event, {
            sport: bucket.sport,
            snapshotAt: unpacked.timestamp || bucket.snapshotAt,
            requestedAt: bucket.snapshotAt,
            commenceTime: event.commence_time,
            source: SOURCE,
          });
        } catch (err) {
          safeLog(`[closes-3am] odds-master ${bucket.sport}: ${err && err.message}`);
        }
      }
    }
  }
  return { events, rows, posted, pickResults, doneWrites, satisfiedEventMarkets };
}

async function loadInputs(date, ctx) {
  const readBoard = ctx.readBoard || ((key) => require('./odds-master/store').readJson(key));
  let slate = [];
  try {
    const doc = await readBoard(`by-date/${date}`);
    slate = (doc && doc.events) || [];
  } catch (err) {
    safeLog(`[closes-3am] board by-date/${date}: ${err && err.message}`);
  }
  let card = null;
  let candidates = null;
  if (ctx.blobs) {
    try { card = await ctx.blobs.get(PICKS_STORE, `picks-${date}`); } catch (err) {
      safeLog(`[closes-3am] card ${date}: ${err && err.message}`);
    }
    try { candidates = await ctx.blobs.get(PICKS_STORE, `omega-candidates/${date}`); } catch (err) {
      safeLog(`[closes-3am] candidates ${date}: ${err && err.message}`);
    }
  }
  if (ctx.card) card = ctx.card;
  if (ctx.candidates) candidates = ctx.candidates;
  if (ctx.slateEvents) slate = ctx.slateEvents;
  return { slate, card, candidates, games: collectGames(slate, card, candidates, date) };
}

function priorStatus(summary) {
  const map = new Map();
  for (const row of (summary && summary.picks) || []) {
    if (row) map.set(pickKey(row), row);
  }
  return map;
}

function pickMissing(row, prior) {
  if (!row || row.kind !== 'card') return false;
  const prev = prior.get(pickKey(row));
  if (!prev) return true;
  if (prev.status === 'closed') return false;
  // A completed look that found no Pinnacle price is terminal. onlyMissing
  // must not pay for that bucket again. fetch-failed, cap, and reserve-guard stay retryable.
  if (prev.status === 'no-close' && ALLOWED_NO_CLOSE.has(prev.reason)) return false;
  return true;
}

async function runCloses(ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now || Date.now());
  const env = ctx.env || process.env;
  const date = ctx.date;
  const cap = capFor(env);
  const onlyMissing = !!(ctx.onlyMissing || ctx.picksOnly);
  const dryRun = !!ctx.dryRun;
  const result = {
    ok: true,
    date,
    cap,
    estCost: EST_COST,
    creditFormula: `${HISTORICAL_MULTIPLIER} x ${MARKETS.length} markets x ${REGION_EQUIVALENTS} region-equivalents (${BOOKS.length} books) = ${EST_COST}`,
    onlyMissing,
    dryRun,
    reserveGuard: false,
    calls: [],
    errors: [],
    picks: [],
    buckets: [],
    skippedDone: 0,
    skippedCap: 0,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    result.ok = false;
    result.errors.push('bad-date');
    return result;
  }
  const { games } = await loadInputs(date, ctx);
  let buckets = planBuckets(games);
  const blobs = ctx.blobs;
  let summary = null;
  if (blobs) {
    try { summary = await blobs.get(STORE, summaryKey(date)); } catch (_) { summary = null; }
  }
  const prior = priorStatus(summary);
  if (onlyMissing) {
    buckets = buckets.filter((bucket) => bucket.games.some((game) => (game.picks || []).some((pick) => pickMissing(pick, prior))));
  }
  const runDate = S.etYmd(now);
  const creditKey = `credits/${runDate}`;
  let credits = { date: runDate, used: 0, calls: [] };
  if (blobs && !dryRun) {
    try {
      const existing = await blobs.get(STORE, creditKey);
      if (existing && typeof existing === 'object') credits = existing;
    } catch (err) {
      safeLog(`[closes-3am] credits read: ${err && err.message}`);
    }
  }
  if (!Array.isArray(credits.calls)) credits.calls = [];
  let spent = spentOnPath(credits);
  let remaining = ctx.requestsRemaining != null ? ctx.requestsRemaining : null;
  if (remaining == null && blobs) {
    try { remaining = await latestRemaining(blobs, now); } catch (_) { remaining = null; }
  }
  result.remainingBefore = remaining;

  const pickRows = [];
  const seenPicks = new Set();
  function remember(rows) {
    for (const row of rows || []) {
      const key = pickKey(row);
      seenPicks.add(key);
      const at = pickRows.findIndex((item) => pickKey(item) === key);
      if (at >= 0) pickRows[at] = row;
      else pickRows.push(row);
    }
  }

  for (const bucket of buckets) {
    const doneKey = bucketDoneKey(bucket.sport, bucket.snapshotAt);
    let already = false;
    if (blobs) {
      try { already = !!(await blobs.get(STORE, doneKey)); } catch (_) { already = false; }
    }
    if (already) {
      result.skippedDone += 1;
      result.buckets.push({ sport: bucket.sport, snapshotAt: bucket.snapshotAt, from: bucket.from, to: bucket.to, status: 'done' });
      for (const game of bucket.games) {
        for (const pick of game.picks || []) {
          const prev = prior.get(pickKey(pick));
          if (prev) remember([prev]);
        }
      }
      continue;
    }
    if (spent + EST_COST > cap) {
      result.skippedCap += 1;
      result.buckets.push({ sport: bucket.sport, snapshotAt: bucket.snapshotAt, status: 'cap' });
      for (const game of bucket.games) {
        for (const pick of game.picks || []) {
          remember([Object.assign({}, pick, { status: 'no-close', reason: 'cap' })]);
        }
      }
      continue;
    }
    if (reserveBlocks(remaining, EST_COST)) {
      result.reserveGuard = true;
      result.ok = false;
      safeLog('[closes-3am] reserve-guard');
      result.buckets.push({ sport: bucket.sport, snapshotAt: bucket.snapshotAt, status: 'reserve-guard' });
      for (const later of buckets.slice(buckets.indexOf(bucket))) {
        for (const game of later.games) {
          for (const pick of game.picks || []) {
            if (!seenPicks.has(pickKey(pick))) {
              remember([Object.assign({}, pick, { status: 'no-close', reason: 'reserve-guard' })]);
            }
          }
        }
      }
      break;
    }
    if (!bucket.sportKey) {
      result.errors.push(`sport-key ${bucket.sport}`);
      continue;
    }
    const url = buildHistoricalUrl(env.ODDS_API_KEY || '', bucket.sportKey, bucket.snapshotAt, bucket.from, bucket.to);
    try {
      const resp = await ctx.fetch(url);
      const actual = FB.actualFromHeader(FB.headerValue(resp, 'x-requests-last'));
      const headerRemaining = FB.headerValue(resp, 'x-requests-remaining');
      if (headerRemaining != null && headerRemaining !== '') remaining = headerRemaining;
      else if (remaining != null && actual != null) remaining = Number(remaining) - Number(actual);
      const body = await readOddsBody(resp);
      const unpacked = unwrapHistorical(body);
      const call = {
        at: now.toISOString(),
        path: CREDIT_PATH,
        sport: bucket.sport,
        snapshot: bucket.snapshotAt,
        bucket: `${bucket.from}..${bucket.to}`,
        nEvents: unpacked.events.length,
        estCost: EST_COST,
        ...(actual == null ? {} : { actualCost: actual }),
        remaining,
      };
      credits.calls.push(call);
      credits.remaining = remaining;
      spent += EST_COST;
      result.calls.push(call);
      if (resp && resp.ok === false) throw new Error(`Odds API HTTP ${resp.status}`);
      const fetchedAt = unpacked.timestamp || now.toISOString();
      if (blobs && !dryRun) {
        try {
          await blobs.set(STORE, FB.archiveKey(date, bucket.sport, fetchedAt), {
            meta: {
              sport: bucket.sport,
              url: FB.publicUrl(url),
              fetchedAt,
              snapshot: bucket.snapshotAt,
              timestamp: unpacked.timestamp,
              previous_timestamp: unpacked.previous_timestamp,
              headers: {
                'x-requests-used': FB.headerValue(resp, 'x-requests-used'),
                'x-requests-remaining': headerRemaining,
                'x-requests-last': FB.headerValue(resp, 'x-requests-last'),
              },
              eventIds: unpacked.events.map((event) => event && event.id).filter(Boolean),
            },
            body,
          });
        } catch (archiveErr) {
          safeLog(`[closes-3am] archive ${bucket.sport}: ${archiveErr && archiveErr.message}`);
        }
      }
      const applied = await applyBucketResponse(bucket, unpacked, {
        now,
        env,
        fetch: ctx.fetch,
        blobs,
        dryRun,
        writeRows: ctx.writeRows,
        storeClose: ctx.storeClose,
      });
      remember(applied.pickResults);
      if (blobs && !dryRun) {
        await blobs.set(STORE, doneKey, {
          at: now.toISOString(),
          sport: bucket.sport,
          snapshotAt: bucket.snapshotAt,
          from: bucket.from,
          to: bucket.to,
          nEvents: unpacked.events.length,
        });
        await blobs.set(STORE, creditKey, credits);
      }
      result.buckets.push({
        sport: bucket.sport,
        snapshotAt: bucket.snapshotAt,
        from: bucket.from,
        to: bucket.to,
        nGames: bucket.games.length,
        nEvents: unpacked.events.length,
        status: 'called',
        posted: applied.posted,
      });
    } catch (err) {
      result.ok = false;
      result.errors.push(scrub(err && err.message));
      safeLog(`[closes-3am] ${bucket.sport} ${bucket.snapshotAt}: ${err && err.message}`);
      result.buckets.push({ sport: bucket.sport, snapshotAt: bucket.snapshotAt, status: 'error' });
      for (const game of bucket.games) {
        for (const pick of game.picks || []) {
          remember([Object.assign({}, pick, { status: 'no-close', reason: 'fetch-failed' })]);
        }
      }
    }
  }

  for (const game of games) {
    for (const pick of game.picks || []) {
      if (!seenPicks.has(pickKey(pick))) {
        const prev = prior.get(pickKey(pick));
        if (prev) remember([prev]);
        else remember([Object.assign({}, pick, { status: 'no-close', reason: 'not-scheduled' })]);
      }
    }
  }
  result.picks = pickRows;
  const summaryDoc = {
    date,
    ranAt: now.toISOString(),
    cap,
    estCostPerCall: EST_COST,
    creditFormula: result.creditFormula,
    books: BOOKS,
    onlyMissing,
    reserveGuard: result.reserveGuard,
    remaining: remaining,
    calls: result.calls,
    buckets: result.buckets,
    picks: pickRows,
    errors: result.errors,
  };
  result.summary = summaryDoc;
  if (blobs && !dryRun) {
    try { await blobs.set(STORE, summaryKey(date), summaryDoc); } catch (err) {
      result.ok = false;
      safeLog(`[closes-3am] summary: ${err && err.message}`);
    }
    try { await blobs.set(STORE, creditKey, credits); } catch (err) {
      safeLog(`[closes-3am] credits write: ${err && err.message}`);
    }
  }
  return result;
}

/**
 * Archived raw bodies for one Odds API sport key, unwrapped.
 * Used by track-clv-omega in stored-closes mode. Never calls the Odds API.
 */
async function loadStoredEventsForSport(sportKey, opts) {
  const label = sportLabelOf(sportKey);
  if (!label) return [];
  const date = opts && opts.date;
  if (opts && opts.storedEventsBySport && Object.prototype.hasOwnProperty.call(opts.storedEventsBySport, sportKey)) {
    const injected = opts.storedEventsBySport[sportKey];
    return Array.isArray(injected) ? injected : [];
  }
  const blobs = opts && opts.blobs;
  if (!blobs || typeof blobs.list !== 'function' || typeof blobs.get !== 'function') return [];
  let keys = [];
  try { keys = await blobs.list(STORE, `raw/${date}/${label}/`); } catch (_) { keys = []; }
  const events = [];
  const seen = new Set();
  for (const key of keys || []) {
    let doc = null;
    try { doc = await blobs.get(STORE, decodeBlobKey(key)); } catch (_) { doc = null; }
    const unpacked = unwrapHistorical(doc && doc.body);
    for (const event of unpacked.events) {
      if (!event || event.id == null || seen.has(String(event.id))) continue;
      seen.add(String(event.id));
      events.push(event);
    }
  }
  return events;
}

function dateAllowed(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const yesterday = S.addDays(today, -1);
  const oldest = S.addDays(today, -BACKFILL_DAYS);
  return date >= oldest && date <= yesterday;
}

module.exports = {
  SPORTS,
  BOOKS,
  MARKETS,
  CLOSE_BOOK,
  STORE,
  SOURCE,
  BUCKET_MS,
  SNAPSHOT_LEAD_MS,
  EST_COST,
  DEFAULT_CAP,
  RESERVE_FLOOR,
  CREDIT_PATH,
  ALLOWED_NO_CLOSE,
  REGION_EQUIVALENTS,
  closesAt3amEnabled,
  capFor,
  isoSecond,
  etDateOf,
  teamsMatch,
  teamsFromMatchup,
  planBuckets,
  buildHistoricalUrl,
  unwrapHistorical,
  assessPick,
  eventInResponse,
  pinnacleMarket,
  reserveBlocks,
  collectGames,
  trackedPicks,
  applyBucketResponse,
  runCloses,
  loadStoredEventsForSport,
  dateAllowed,
  summaryKey,
  bucketDoneKey,
  sportKeyOf,
  sportLabelOf,
  scrub,
};
