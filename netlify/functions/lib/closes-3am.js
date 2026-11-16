'use strict';

/**
 * 3 AM ET historical closes for the previous ET day.
 * One Odds API historical call per (sport, 10-minute commence bucket).
 * Snapshot time is the earliest tip in the bucket minus 60 seconds.
 * The commence filter is 30 minutes before the earliest tip through 30
 * minutes after the latest. Close rows are written only for events that
 * belong to the bucket. Card and candidate legs still missing Pinnacle
 * are retried once at the earliest tip minus 15 minutes.
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
/** Odds API commenceTimeFrom / commenceTimeTo around the bucket tips. */
const QUERY_PAD_MS = 30 * 60 * 1000;
/** Unlisted events are this bucket's only when the tip is inside this pad. */
const BELONG_PAD_MS = 2 * 60 * 1000;
/** One earlier historical snapshot for card and candidate legs still no-close. */
const FALLBACK_LEAD_MS = 15 * 60 * 1000;
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

/** Card labels (Spread, Moneyline, Total, betType) and Odds API keys both map here. */
function pickMarket(pick) {
  if (!pick) return null;
  return S.marketFromBetType(pick.betType || pick.market, pick.pick || pick.side);
}

function leadMinutes(commenceTime, snapshotAt) {
  const tip = Date.parse(commenceTime);
  const snap = Date.parse(snapshotAt);
  if (!Number.isFinite(tip) || !Number.isFinite(snap)) return null;
  return Math.round((tip - snap) / 60000);
}

function pickKey(pick) {
  return [
    pick.kind || '',
    pick.sport || '',
    pick.matchup || '',
    pick.pick || '',
    pickMarket(pick) || '',
    pick.commenceTime || '',
  ].join('|');
}

function mergePickRow(existing, incoming) {
  if (!incoming) return existing || null;
  if (existing && existing.status === 'closed') return existing;
  return incoming;
}

/**
 * Games whose commence times fall within 10 minutes of the bucket start,
 * one bucket per sport. Snapshot is the earliest tip minus 60s.
 * `from` / `to` are the wider Odds API commence window, not the 1-second tip.
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
    const priority = bucket.games.some((game) => game.roles && game.roles.has('card'))
      ? 0
      : (bucket.games.some((game) => game.roles && game.roles.has('candidate')) ? 1 : 2);
    return {
      sport: bucket.sport,
      sportKey: sportKeyOf(bucket.sport),
      snapshotAt: isoSecond(snapshotMs),
      fallbackAt: isoSecond(min - FALLBACK_LEAD_MS),
      from: isoSecond(min - QUERY_PAD_MS),
      to: isoSecond(max + QUERY_PAD_MS),
      startMs: min,
      endMs: max,
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

function slateIdSet(slateEvents) {
  const ids = new Set();
  for (const ev of slateEvents || []) {
    const id = ev && (ev.eventId || ev.id);
    if (id) ids.add(String(id));
  }
  return ids;
}

/**
 * A response event belongs to this bucket when its id is one of the bucket
 * games, or it is not on the slate and its commence falls inside
 * [earliest tip − 2 min, latest tip + 2 min]. Other events stay in the
 * archived body and are not written as closes.
 */
function eventBelongsToBucket(event, bucket, slateIds) {
  if (!event || !bucket) return false;
  const id = event.id == null ? '' : String(event.id);
  const bucketIds = new Set();
  for (const game of bucket.games || []) {
    if (game && game.eventId) bucketIds.add(String(game.eventId));
  }
  if (id && bucketIds.has(id)) return true;
  if (id && slateIds && slateIds.has(id)) return false;
  const ct = Date.parse(event.commence_time || '');
  if (!Number.isFinite(ct)) return false;
  const min = bucket.startMs;
  const max = bucket.endMs != null ? bucket.endMs : bucket.startMs;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  return ct >= min - BELONG_PAD_MS && ct <= max + BELONG_PAD_MS;
}

function eventWithMarkets(event, markets) {
  if (!event || !markets) return event;
  const allow = new Set(markets);
  const bookmakers = [];
  for (const book of event.bookmakers || []) {
    if (!book) continue;
    const kept = (book.markets || []).filter((market) => market && allow.has(market.key));
    if (!kept.length) continue;
    bookmakers.push(Object.assign({}, book, { markets: kept }));
  }
  return Object.assign({}, event, { bookmakers });
}

/**
 * A pick is satisfied only by its own event and its own market at Pinnacle.
 * A sibling game in the same bucket does not count.
 */
function assessPick(pick, events) {
  const event = eventInResponse(pick, events);
  const market = pickMarket(pick);
  if (!event) return { status: 'no-close', reason: 'not-in-historical-snapshot', event: null, market };
  if (!pinnacleMarket(event, market)) return { status: 'no-close', reason: 'pinnacle-not-priced', event, market };
  return { status: 'closed', reason: null, event, market };
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
    betType: pick.betType || null,
    market: pickMarket(pick),
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
    const market = S.marketFromBetType(row.betType || row.market, row.pick || row.side);
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

function marketsForEvent(event, picks) {
  if (!picks) return MARKETS.slice();
  const wanted = [];
  for (const pick of picks) {
    if (!eventInResponse(pick, [event])) continue;
    const market = pickMarket(pick);
    if (market && !wanted.includes(market)) wanted.push(market);
  }
  return wanted;
}

/**
 * Apply one historical body to the stores the old close job writes.
 * `events` must already be unwrapped. Does not call the Odds API.
 * Events outside this bucket are ignored here. The caller archives the raw body.
 * `ctx.onlyPicks` limits assessment and writes to those legs (fallback).
 */
async function applyBucketResponse(bucket, unpacked, ctx) {
  const when = ctx.now instanceof Date ? ctx.now : new Date();
  const snapshotAt = ctx.snapshotAt || bucket.snapshotAt;
  const allEvents = unpacked.events || [];
  const slateIds = ctx.slateIds || slateIdSet(null);
  const belonging = allEvents.filter((event) => eventBelongsToBucket(event, bucket, slateIds));
  const onlyPicks = Array.isArray(ctx.onlyPicks) ? ctx.onlyPicks : null;
  const events = onlyPicks
    ? belonging.filter((event) => marketsForEvent(event, onlyPicks).length > 0)
    : belonging;
  const picks = onlyPicks || (bucket.games || []).reduce((list, game) => list.concat(game.picks || []), []);
  const rows = { games: [], snaps: [] };
  const pickResults = [];
  const satisfiedEventMarkets = new Set();
  const blockedCommence = new Set();
  for (const pick of picks) {
    const assessed = assessPick(pick, belonging);
    const market = assessed.market || pickMarket(pick);
    const row = Object.assign({}, pick, {
      market,
      status: assessed.status,
      reason: assessed.reason,
      eventId: (assessed.event && assessed.event.id) || pick.eventId || null,
      closeLeadMin: leadMinutes(pick.commenceTime, snapshotAt),
    });
    pickResults.push(row);
    const ctPick = FB.normalizeCommence(pick.commenceTime) || pick.commenceTime;
    if (assessed.status !== 'closed') blockedCommence.add(`${ctPick}|${market}`);
  }
  for (const event of events) {
    if (!event) continue;
    const markets = marketsForEvent(event, onlyPicks);
    for (const market of markets) {
      if (pinnacleMarket(event, market)) satisfiedEventMarkets.add(`${event.id}|${market}`);
    }
    const priced = eventWithMarkets(event, markets);
    const built = S.rowsFromOddsEvent(bucket.sport, priced, {
      lineType: 'closing',
      source: SOURCE,
      books: BOOKS,
      markets,
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
      const markets = marketsForEvent(event, onlyPicks);
      let any = false;
      for (const market of markets) {
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
        const markets = marketsForEvent(event, onlyPicks);
        const priced = eventWithMarkets(event, markets);
        if (!pinnacleBook(priced)) continue;
        try {
          await ctx.storeClose(priced, {
            sport: bucket.sport,
            snapshotAt: unpacked.timestamp || snapshotAt,
            requestedAt: snapshotAt,
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

function pickMissing(row, prior, retryNoClose) {
  if (!row) return false;
  const retry = !!retryNoClose;
  if (row.kind !== 'card' && !(retry && row.kind === 'candidate')) return false;
  const prev = prior.get(pickKey(row));
  if (!prev) return true;
  if (prev.status === 'closed') return false;
  // A completed look that found no Pinnacle price is terminal. onlyMissing
  // must not pay for that bucket again. retryNoClose reopens card and candidate
  // no-closes. fetch-failed, cap, and reserve-guard stay retryable.
  if (prev.status === 'no-close' && ALLOWED_NO_CLOSE.has(prev.reason)) return retry;
  return true;
}

function bucketRetryNoClose(bucket, prior, retryNoClose) {
  if (!retryNoClose) return false;
  for (const game of bucket.games || []) {
    for (const pick of game.picks || []) {
      if (pick.kind !== 'card' && pick.kind !== 'candidate') continue;
      const prev = prior.get(pickKey(pick));
      if (prev && prev.status === 'no-close') return true;
    }
  }
  return false;
}

function trackedLegs(bucket) {
  const out = [];
  for (const game of bucket.games || []) {
    for (const pick of game.picks || []) {
      if (pick.kind === 'card' || pick.kind === 'candidate') out.push(pick);
    }
  }
  return out;
}

async function runCloses(ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now || Date.now());
  const env = ctx.env || process.env;
  const date = ctx.date;
  const cap = capFor(env);
  const onlyMissing = !!(ctx.onlyMissing || ctx.picksOnly);
  const retryNoClose = !!ctx.retryNoClose;
  const dryRun = !!ctx.dryRun;
  const result = {
    ok: true,
    date,
    cap,
    estCost: EST_COST,
    creditFormula: `${HISTORICAL_MULTIPLIER} x ${MARKETS.length} markets x ${REGION_EQUIVALENTS} region-equivalents (${BOOKS.length} books) = ${EST_COST}`,
    onlyMissing,
    retryNoClose,
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
  const loaded = await loadInputs(date, ctx);
  const games = loaded.games;
  const slateIds = slateIdSet(loaded.slate);
  let buckets = planBuckets(games);
  const blobs = ctx.blobs;
  let summary = null;
  if (blobs) {
    try { summary = await blobs.get(STORE, summaryKey(date)); } catch (_) { summary = null; }
  }
  const prior = priorStatus(summary);
  if (onlyMissing) {
    buckets = buckets.filter((bucket) => bucket.games.some((game) => (game.picks || []).some((pick) => pickMissing(pick, prior, retryNoClose))));
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
      if (!row) continue;
      const key = pickKey(row);
      seenPicks.add(key);
      const at = pickRows.findIndex((item) => pickKey(item) === key);
      const existing = at >= 0 ? pickRows[at] : prior.get(key);
      const merged = mergePickRow(existing, row);
      if (at >= 0) pickRows[at] = merged;
      else pickRows.push(merged);
    }
  }

  function rowFor(pick) {
    const key = pickKey(pick);
    return pickRows.find((item) => pickKey(item) === key) || prior.get(key) || null;
  }

  async function blobHas(key) {
    if (!blobs) return false;
    try { return !!(await blobs.get(STORE, key)); } catch (_) { return false; }
  }

  const calledPrimary = new Set();

  async function attempt(bucket, snapshotAt, options) {
    const fallback = !!(options && options.fallback);
    const ignoreDone = !!(options && options.ignoreDone);
    const onlyPicks = options && options.onlyPicks;
    const doneKey = bucketDoneKey(bucket.sport, snapshotAt);
    const mark = (status) => {
      const entry = {
        sport: bucket.sport,
        snapshotAt,
        from: bucket.from,
        to: bucket.to,
        status,
      };
      if (fallback) entry.fallback = true;
      result.buckets.push(entry);
      return status;
    };
    if (!ignoreDone && await blobHas(doneKey)) {
      result.skippedDone += 1;
      if (!fallback) {
        for (const game of bucket.games) {
          for (const pick of game.picks || []) {
            const prev = prior.get(pickKey(pick));
            if (prev) remember([prev]);
          }
        }
      }
      return mark('done');
    }
    if (spent + EST_COST > cap) {
      result.skippedCap += 1;
      if (!fallback) {
        for (const game of bucket.games) {
          for (const pick of game.picks || []) {
            remember([Object.assign({}, pick, { status: 'no-close', reason: 'cap', market: pickMarket(pick) })]);
          }
        }
      }
      return mark('cap');
    }
    if (reserveBlocks(remaining, EST_COST)) {
      result.reserveGuard = true;
      result.ok = false;
      safeLog('[closes-3am] reserve-guard');
      return mark('reserve-guard');
    }
    if (!bucket.sportKey) {
      result.errors.push(`sport-key ${bucket.sport}`);
      return 'error';
    }
    const url = buildHistoricalUrl(env.ODDS_API_KEY || '', bucket.sportKey, snapshotAt, bucket.from, bucket.to);
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
        snapshot: snapshotAt,
        bucket: `${bucket.from}..${bucket.to}`,
        nEvents: unpacked.events.length,
        estCost: EST_COST,
        ...(actual == null ? {} : { actualCost: actual }),
        remaining,
      };
      if (fallback) call.fallback = true;
      credits.calls.push(call);
      credits.remaining = remaining;
      spent += EST_COST;
      result.calls.push(call);
      if (resp && resp.ok === false) throw new Error(`Odds API HTTP ${resp.status}`);
      const stamp = unpacked.timestamp || snapshotAt;
      const fetchedAt = `${stamp}--${snapshotAt}`;
      if (blobs && !dryRun) {
        try {
          await blobs.set(STORE, FB.archiveKey(date, bucket.sport, fetchedAt), {
            meta: {
              sport: bucket.sport,
              url: FB.publicUrl(url),
              fetchedAt,
              snapshot: snapshotAt,
              timestamp: unpacked.timestamp,
              previous_timestamp: unpacked.previous_timestamp,
              fallback: fallback || undefined,
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
        slateIds,
        snapshotAt,
        onlyPicks: onlyPicks || null,
      });
      remember(applied.pickResults);
      if (blobs && !dryRun) {
        await blobs.set(STORE, doneKey, {
          at: now.toISOString(),
          sport: bucket.sport,
          snapshotAt,
          from: bucket.from,
          to: bucket.to,
          nEvents: unpacked.events.length,
          ...(fallback ? { fallback: true } : {}),
        });
        await blobs.set(STORE, creditKey, credits);
      }
      const entry = {
        sport: bucket.sport,
        snapshotAt,
        from: bucket.from,
        to: bucket.to,
        nGames: bucket.games.length,
        nEvents: unpacked.events.length,
        nKept: applied.events.length,
        status: 'called',
        posted: applied.posted,
      };
      if (fallback) entry.fallback = true;
      result.buckets.push(entry);
      return 'called';
    } catch (err) {
      result.ok = false;
      result.errors.push(scrub(err && err.message));
      safeLog(`[closes-3am] ${bucket.sport} ${snapshotAt}: ${err && err.message}`);
      const failed = onlyPicks || (bucket.games || []).reduce((list, game) => list.concat(game.picks || []), []);
      for (const pick of failed) {
        remember([Object.assign({}, pick, { status: 'no-close', reason: 'fetch-failed', market: pickMarket(pick) })]);
      }
      return mark('error');
    }
  }

  let halt = false;
  for (const bucket of buckets) {
    const ignoreDone = bucketRetryNoClose(bucket, prior, retryNoClose);
    const status = await attempt(bucket, bucket.snapshotAt, { ignoreDone, fallback: false });
    if (status === 'called') calledPrimary.add(bucket);
    if (status === 'reserve-guard') {
      for (const later of buckets.slice(buckets.indexOf(bucket))) {
        for (const game of later.games) {
          for (const pick of game.picks || []) {
            if (!seenPicks.has(pickKey(pick))) {
              remember([Object.assign({}, pick, { status: 'no-close', reason: 'reserve-guard', market: pickMarket(pick) })]);
            }
          }
        }
      }
      halt = true;
      break;
    }
  }

  if (!halt) {
    for (const bucket of buckets) {
      const legs = trackedLegs(bucket);
      const fromThisCall = calledPrimary.has(bucket);
      let unresolved = [];
      if (fromThisCall) {
        unresolved = legs.filter((pick) => {
          const row = rowFor(pick);
          return row && row.status === 'no-close' && ALLOWED_NO_CLOSE.has(row.reason);
        });
      } else {
        const primaryDone = await blobHas(bucketDoneKey(bucket.sport, bucket.snapshotAt));
        const fallbackDone = await blobHas(bucketDoneKey(bucket.sport, bucket.fallbackAt));
        const reopen = bucketRetryNoClose(bucket, prior, retryNoClose);
        if (primaryDone && (!fallbackDone || reopen)) {
          unresolved = legs.filter((pick) => {
            const row = rowFor(pick);
            if (!row || row.status === 'closed') return false;
            if (reopen && row.status === 'no-close') return true;
            return row.reason === 'cap' || row.reason === 'fetch-failed' || row.reason === 'reserve-guard';
          });
        }
      }
      if (!unresolved.length) continue;
      const ignoreDone = bucketRetryNoClose(bucket, prior, retryNoClose);
      const status = await attempt(bucket, bucket.fallbackAt, {
        ignoreDone,
        fallback: true,
        onlyPicks: unresolved,
      });
      if (status === 'cap') {
        for (const pick of unresolved) {
          remember([Object.assign({}, pick, { status: 'no-close', reason: 'cap', market: pickMarket(pick) })]);
        }
      }
      if (status === 'reserve-guard') {
        for (const pick of unresolved) {
          if (rowFor(pick) && rowFor(pick).status === 'closed') continue;
          remember([Object.assign({}, pick, { status: 'no-close', reason: 'reserve-guard', market: pickMarket(pick) })]);
        }
        break;
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
    retryNoClose,
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
  const best = new Map();
  for (const key of keys || []) {
    let doc = null;
    try { doc = await blobs.get(STORE, decodeBlobKey(key)); } catch (_) { doc = null; }
    const unpacked = unwrapHistorical(doc && doc.body);
    const snapMs = archiveSnapshotMs(doc);
    for (const event of unpacked.events) {
      if (!event || event.id == null) continue;
      const id = String(event.id);
      const prev = best.get(id);
      if (!prev) {
        best.set(id, { event, snapMs });
        continue;
      }
      if (snapMs >= prev.snapMs) best.set(id, { event: mergeStoredEvent(prev.event, event), snapMs });
      else best.set(id, { event: mergeStoredEvent(event, prev.event), snapMs: prev.snapMs });
    }
  }
  return [...best.values()].map((row) => row.event);
}

function marketPriced(market) {
  return !!(market && Array.isArray(market.outcomes) && market.outcomes.some((outcome) => outcome && outcome.price != null && outcome.price !== ''));
}

/** Later snapshot wins a market. An earlier snapshot fills markets the later one did not price. */
function mergeStoredEvent(older, newer) {
  if (!older) return newer;
  if (!newer) return older;
  const books = new Map();
  function take(event, overwrite) {
    for (const book of event.bookmakers || []) {
      if (!book || !book.key) continue;
      const key = String(book.key).toLowerCase();
      if (!books.has(key)) books.set(key, Object.assign({}, book, { markets: new Map() }));
      const slot = books.get(key);
      for (const market of book.markets || []) {
        if (!marketPriced(market)) continue;
        if (overwrite || !slot.markets.has(market.key)) slot.markets.set(market.key, market);
      }
    }
  }
  take(older, false);
  take(newer, true);
  const bookmakers = [];
  for (const book of books.values()) {
    bookmakers.push(Object.assign({}, book, { markets: [...book.markets.values()] }));
  }
  return Object.assign({}, newer, { bookmakers });
}

function archiveSnapshotMs(doc) {
  const meta = doc && doc.meta;
  const raw = (meta && (meta.timestamp || meta.snapshot)) || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
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
  QUERY_PAD_MS,
  BELONG_PAD_MS,
  FALLBACK_LEAD_MS,
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
  eventBelongsToBucket,
  pickMarket,
  leadMinutes,
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
