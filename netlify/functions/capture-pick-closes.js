'use strict';
/**
 * capture-pick-closes — closing lines (approved card path 2026-10-30; full board 2026-11-14).
 * Schedule "*\/5 * * * *". Card legs on today's / yesterday's card whose kickoff is
 * 2–8 minutes away are pulled once per (sport, kickoff, market): that market only,
 * Pinnacle + DraftKings, region us (1 credit). OMEGA_FULL_BOARD_CLOSES defaults on
 * and also saves Pinnacle + DraftKings + Hard Rock h2h/spreads/totals for every
 * NFL, NCAAF, NBA, NCAAM, and NHL game on the stored odds-master slate in that
 * same window (one call per sport, worst-case 3 credits). off / 0 / false restores
 * the card-leg-only calls. Daily cap 100 credits, tracked in blob
 * clv-close-capture/credits/{ET date}. Done markers prevent repeat pulls.
 * Does not touch picks, grading, pricing, staking, or the card.
 */
const S = require('./lib/clv-supabase');
const mirror = require('./lib/supa-mirror');
const FB = require('./lib/full-board-closes');

const MIRROR_BUDGET_MS = 8000;

function raceTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => v,
      (e) => ({ ok: false, error: e && e.message ? e.message : String(e) })
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

const REQUIRED_ENV = ['ODDS_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NETLIFY_AUTH_TOKEN'];
const STORE = 'clv-close-capture';
const DAILY_CAP = 100;
const WINDOW_MIN = 2;
const WINDOW_MAX = 8;
const EST_COST = 1;
// Scheduled runs die around 30s. A Saturday NCAAM tip is 40+ due games;
// blob gets and done-marker puts stay capped so one tick can finish.
const BLOB_IO_CONCURRENCY = 16;

function cardLegs(card) {
  const out = [];
  for (const p of (card && card.picks) || []) out.push(p);
  for (const parlay of (card && card.parlayLegs) || []) for (const l of parlay.legs || []) out.push(l);
  return out.filter((p) => p && p.sport && p.commenceTime && S.ODDS_SPORT_KEYS[p.sport]);
}

function dueGroups(legs, now) {
  const groups = new Map();
  for (const p of legs) {
    const mins = (new Date(p.commenceTime) - now) / 60000;
    if (!(mins >= WINDOW_MIN && mins <= WINDOW_MAX)) continue;
    const market = S.marketFromBetType(p.betType || p.market, p.pick);
    const ct = new Date(p.commenceTime).toISOString().replace('.000Z', 'Z');
    const key = `${p.sport}|${ct}|${market}`;
    if (!groups.has(key)) groups.set(key, { sport: p.sport, commenceTime: ct, market, picks: [] });
    groups.get(key).picks.push(`${p.matchup} — ${p.pick}`);
  }
  return [...groups.values()];
}

/**
 * Scheduled runs read odds-master. Unit tests pass deps.fetch and no board
 * reader; they must not open a Netlify socket, and they keep the card-leg
 * calls. Pass deps.readBoard to exercise the full-board path.
 */
function resolveBoardReader(deps) {
  if (deps && typeof deps.readBoard === 'function') return deps.readBoard;
  if (deps && deps.fetch) return async () => null;
  return (key) => require('./lib/odds-master/store').readJson(key);
}

async function loadBoardEvents(when, readBoard) {
  const today = S.etYmd(when);
  const events = [];
  for (const day of [today, S.addDays(today, -1)]) {
    let doc = null;
    try {
      doc = await readBoard(`by-date/${day}`);
    } catch (e) {
      console.error(`[capture-pick-closes] board by-date/${day}: ${e.message}`);
    }
    if (doc && Array.isArray(doc.events)) events.push(...doc.events);
  }
  return events;
}

async function eventFullyDone(blobs, ev) {
  if (await blobs.get(STORE, FB.doneEvKey(ev.sport, ev.eventId))) return true;
  for (const market of FB.MARKETS) {
    if (!(await blobs.get(STORE, FB.doneMarketKey(ev.sport, ev.commenceTime, market)))) return false;
  }
  return true;
}

async function readOddsBody(resp) {
  if (resp && typeof resp.text === 'function') {
    const rawText = await resp.text();
    if (rawText) {
      try { return JSON.parse(rawText); } catch (_) { return rawText; }
    }
  }
  if (resp && typeof resp.json === 'function') return resp.json();
  return null;
}

function emptyFullBoard(enabled, extra) {
  return Object.assign({
    enabled: !!enabled,
    dueSports: [],
    calls: 0,
    events: 0,
    skippedDone: 0,
    budgetBlocked: 0,
  }, extra || {});
}

function pushCreditCall(credits, row) {
  if (!Array.isArray(credits.calls)) credits.calls = [];
  credits.calls.push(row);
}

async function handle(event, now, deps = {}) {
  const when = now instanceof Date ? now : new Date();
  const env = deps.env || process.env;
  try { S.requireEnv(env, REQUIRED_ENV); } catch (e) {
    console.error(`[capture-pick-closes] FATAL ${e.message}`);
    return S.json(500, { ok: false, error: e.message, missingEnv: e.missing });
  }
  const f = deps.fetch || fetch;
  const blobs = deps.blobs || S.blobClient(env, f);
  const today = S.etYmd(when);
  const legs = [];
  let todayCard = null;
  for (const d of [today, S.addDays(today, -1)]) {
    const card = await blobs.get('edge-picks-omega', `picks-${d}`);
    if (d === today) todayCard = card;
    legs.push(...cardLegs(card));
  }
  async function withMirror(statusCode, body) {
    if (!mirror.enabled(env) || !todayCard) return S.json(statusCode, body);
    const mirrorResult = await raceTimeout(
      mirror.mirrorTodayCard(today, { env, fetch: f, blobs }),
      MIRROR_BUDGET_MS
    );
    return S.json(statusCode, { ...body, mirror: mirrorResult });
  }

  const fullOn = FB.fullBoardEnabled(env);
  const fullBoard = emptyFullBoard(fullOn);
  let pending = [];
  if (fullOn) {
    const slate = await loadBoardEvents(when, resolveBoardReader(deps));
    const dueEvents = FB.dueBoardEvents(slate, when, WINDOW_MIN, WINDOW_MAX);
    const fullyDone = await S.mapLimit(dueEvents, BLOB_IO_CONCURRENCY, (ev) => eventFullyDone(blobs, ev));
    for (let i = 0; i < dueEvents.length; i++) {
      if (fullyDone[i]) {
        fullBoard.skippedDone += 1;
        continue;
      }
      pending.push(dueEvents[i]);
    }
  }
  const bySport = FB.groupBySport(pending);
  fullBoard.dueSports = [...bySport.keys()];

  const groups = dueGroups(legs, when);
  if (!groups.length && !pending.length) {
    return withMirror(200, { ok: true, due: 0, fullBoard });
  }

  const coveredKey = new Set(pending.map((ev) => `${ev.sport}|${ev.commenceTime}`));
  const creditKey = `credits/${today}`;
  const credits = (await blobs.get(STORE, creditKey)) || { date: today, used: 0, calls: [] };
  if (!Array.isArray(credits.calls)) credits.calls = [];
  const results = [];
  const errors = [];
  const sportsCalled = new Set();
  const satisfied = new Set();

  function budgetLeft() {
    return DAILY_CAP - FB.spentCredits(credits);
  }

  async function runCardLeg(g) {
    const doneKey = `done/${g.sport}/${g.commenceTime}/${g.market}`;
    if (!FB.canAfford(credits, EST_COST, DAILY_CAP)) {
      console.error(`[capture-pick-closes] daily cap ${DAILY_CAP} reached; skipping ${doneKey}`);
      results.push({ ...g, skipped: 'cap' });
      return;
    }
    try {
      const from = new Date(new Date(g.commenceTime).getTime() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const to = new Date(new Date(g.commenceTime).getTime() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const qs = new URLSearchParams({
        apiKey: env.ODDS_API_KEY, regions: 'us', markets: g.market, bookmakers: 'pinnacle,draftkings',
        oddsFormat: 'american', commenceTimeFrom: from, commenceTimeTo: to,
      });
      const resp = await f(`https://api.the-odds-api.com/v4/sports/${S.ODDS_SPORT_KEYS[g.sport]}/odds?${qs}`);
      const actual = FB.actualFromHeader(FB.headerValue(resp, 'x-requests-last'));
      const last = actual == null ? EST_COST : actual;
      FB.applySpend(credits, EST_COST, actual);
      credits.remaining = FB.headerValue(resp, 'x-requests-remaining');
      pushCreditCall(credits, {
        at: when.toISOString(),
        path: 'card-leg',
        sport: g.sport,
        commenceTime: g.commenceTime,
        market: g.market,
        nEvents: null,
        estCost: EST_COST,
        ...(actual == null ? {} : { actualCost: actual }),
        cost: last,
        used: credits.used,
        remaining: credits.remaining,
      });
      if (!resp.ok) throw new Error(`Odds API HTTP ${resp.status}`);
      const events = await resp.json();
      const call = credits.calls[credits.calls.length - 1];
      call.nEvents = (events || []).length;
      const rows = { games: [], snaps: [] };
      for (const ev of events || []) {
        const r = S.rowsFromOddsEvent(g.sport, ev, { lineType: 'closing', source: 'oddsapi-live:capture-pick-closes', books: ['pinnacle', 'draftkings'], markets: [g.market] });
        rows.games.push(r.game);
        rows.snaps.push(...r.snaps);
      }
      const posted = await S.writeRows(rows, env, f);
      await blobs.set(STORE, doneKey, { at: when.toISOString(), picks: g.picks, events: (events || []).length, posted });
      results.push({ ...g, events: (events || []).length, posted, cost: last });
    } catch (e) {
      console.error(`[capture-pick-closes] ${g.sport} ${g.commenceTime} ${g.market}: ${e.message}`);
      errors.push(e.message);
    }
  }

  async function runFullBoard(sport, sportEvents) {
    if (sportsCalled.has(sport)) return false;
    sportsCalled.add(sport);
    if (!sportEvents || !sportEvents.length) return false;
    if (!FB.canAfford(credits, FB.COST, DAILY_CAP)) {
      fullBoard.budgetBlocked += 1;
      return false;
    }
    const sportKey = S.ODDS_SPORT_KEYS[sport];
    if (!sportKey) return false;
    const bounds = FB.commenceBounds(sportEvents);
    if (!bounds) return false;
    const url = FB.buildFullBoardUrl(env.ODDS_API_KEY, sportKey, bounds.from, bounds.to);
    try {
      const resp = await f(url);
      const fetchedAt = new Date().toISOString();
      const actual = FB.actualFromHeader(FB.headerValue(resp, 'x-requests-last'));
      FB.applySpend(credits, FB.COST, actual);
      const remainingHeader = FB.headerValue(resp, 'x-requests-remaining');
      credits.remaining = remainingHeader;
      fullBoard.calls += 1;
      const call = {
        at: when.toISOString(),
        path: 'full-board',
        sport,
        nEvents: null,
        estCost: FB.COST,
        ...(actual == null ? {} : { actualCost: actual }),
        used: credits.used,
        remaining: remainingHeader != null ? remainingHeader : (DAILY_CAP - FB.spentCredits(credits)),
      };
      pushCreditCall(credits, call);
      const body = await readOddsBody(resp);
      const events = Array.isArray(body) ? body : [];
      call.nEvents = events.length;
      const safeUrl = FB.publicUrl(url);
      try {
        await blobs.set(STORE, FB.archiveKey(today, sport, fetchedAt), {
          meta: {
            sport,
            url: safeUrl,
            fetchedAt,
            headers: {
              'x-requests-used': FB.headerValue(resp, 'x-requests-used'),
              'x-requests-remaining': remainingHeader,
              'x-requests-last': FB.headerValue(resp, 'x-requests-last'),
            },
            eventIds: events.map((ev) => ev && ev.id).filter(Boolean),
          },
          body,
        });
      } catch (archiveErr) {
        console.error(`[capture-pick-closes] raw archive ${sport}: ${archiveErr.message}`);
      }
      if (!resp.ok) throw new Error(`Odds API HTTP ${resp.status}`);
      const rows = { games: [], snaps: [] };
      for (const ev of events) {
        const r = S.rowsFromOddsEvent(sport, ev, {
          lineType: 'closing',
          source: FB.SOURCE,
          books: FB.BOOKS,
        });
        if (r.game) rows.games.push(r.game);
        rows.snaps.push(...r.snaps);
      }
      const posted = await S.writeRows(rows, env, f);
      const returnedIds = new Set(events.map((ev) => ev && ev.id).filter(Boolean).map(String));
      // Per-market done/{sport}/{ct}/{market} repeats for events that share a
      // kickoff and again for slate rows the response already covered. One
      // put per key; the last payload matches the old sequential overwrite.
      const doneWrites = new Map();
      for (const ev of events) {
        const ct = FB.normalizeCommence(ev && ev.commence_time);
        if (ct) {
          satisfied.add(`${sport}|${ct}`);
          for (const market of FB.MARKETS) {
            doneWrites.set(FB.doneMarketKey(sport, ct, market), {
              at: when.toISOString(), via: 'full-board', events: events.length, posted,
            });
          }
        }
        if (ev && ev.id) {
          doneWrites.set(FB.doneEvKey(sport, ev.id), {
            at: when.toISOString(), commenceTime: ct,
          });
        }
      }
      for (const wanted of sportEvents) {
        if (!returnedIds.has(String(wanted.eventId))) continue;
        satisfied.add(`${sport}|${wanted.commenceTime}`);
        for (const market of FB.MARKETS) {
          doneWrites.set(FB.doneMarketKey(sport, wanted.commenceTime, market), {
            at: when.toISOString(), via: 'full-board', events: events.length, posted,
          });
        }
      }
      await S.mapLimit([...doneWrites], BLOB_IO_CONCURRENCY, ([key, payload]) => blobs.set(STORE, key, payload));
      fullBoard.events += events.length;
      return true;
    } catch (e) {
      console.error(`[capture-pick-closes] full-board ${sport}: ${e.message}`);
      errors.push(e.message);
      return false;
    }
  }

  // Card legs first. A leg whose game is in a due full-board sport group is
  // satisfied by that sport's 3-credit call. Games missing from the slate,
  // and every card leg when fewer than 3 credits remain, keep the 1-credit call.
  for (const g of groups) {
    const doneKey = `done/${g.sport}/${g.commenceTime}/${g.market}`;
    if (await blobs.get(STORE, doneKey)) {
      results.push({ ...g, skipped: 'done' });
      continue;
    }
    const covered = fullOn && coveredKey.has(`${g.sport}|${g.commenceTime}`);
    if (covered && !sportsCalled.has(g.sport)) {
      if (budgetLeft() < FB.COST) {
        if (!sportsCalled.has(g.sport)) fullBoard.budgetBlocked += 1;
        sportsCalled.add(g.sport);
      } else {
        await runFullBoard(g.sport, bySport.get(g.sport));
      }
    }
    if (covered && satisfied.has(`${g.sport}|${g.commenceTime}`)) {
      results.push({ ...g, skipped: 'full-board' });
      continue;
    }
    await runCardLeg(g);
  }

  for (const [sport, sportEvents] of bySport) {
    if (sportsCalled.has(sport)) continue;
    if (budgetLeft() < FB.COST) {
      fullBoard.budgetBlocked += 1;
      sportsCalled.add(sport);
      continue;
    }
    await runFullBoard(sport, sportEvents);
  }

  await blobs.set(STORE, creditKey, credits);
  return withMirror(errors.length ? 500 : 200, {
    ok: !errors.length,
    due: groups.length,
    results,
    creditsToday: credits.used,
    errors,
    fullBoard,
  });
}

exports.handler = (event) => handle(event, new Date());
exports.handle = handle;
exports.dueGroups = dueGroups;
exports.cardLegs = cardLegs;
exports.DAILY_CAP = DAILY_CAP;
exports.WINDOW_MIN = WINDOW_MIN;
exports.WINDOW_MAX = WINDOW_MAX;
