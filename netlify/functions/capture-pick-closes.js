'use strict';
/**
 * capture-pick-closes — true closing line for published Omega picks (approved 2026-10-30).
 * Schedule "*\/5 * * * *". For each straight and parlay leg on today's / yesterday's card
 * (picks-{date} in edge-picks-omega, read-only) whose kickoff is 2-8 minutes away, pull the
 * LIVE Odds API odds once per (sport, kickoff, market): pick's market only, Pinnacle +
 * DraftKings, region us (Odds API bills 1 credit per market per region on live odds).
 * Writes every event at that kickoff to clv.games / clv.odds_snapshots line_type 'closing',
 * insert-or-ignore. Daily cap 100 credits (x-requests-last), tracked in blob
 * clv-close-capture/credits/{date}; done markers prevent repeat pulls.
 * Does not touch picks, grading or the card.
 */
const S = require('./lib/clv-supabase');

const REQUIRED_ENV = ['ODDS_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NETLIFY_AUTH_TOKEN'];
const STORE = 'clv-close-capture';
const DAILY_CAP = 100;
const WINDOW_MIN = 2;
const WINDOW_MAX = 8;
const EST_COST = 1;

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
  for (const d of [today, S.addDays(today, -1)]) {
    const card = await blobs.get('edge-picks-omega', `picks-${d}`);
    legs.push(...cardLegs(card));
  }
  const groups = dueGroups(legs, when);
  if (!groups.length) return S.json(200, { ok: true, due: 0 });
  const creditKey = `credits/${today}`;
  const credits = (await blobs.get(STORE, creditKey)) || { date: today, used: 0, calls: [] };
  const results = [];
  const errors = [];
  for (const g of groups) {
    const doneKey = `done/${g.sport}/${g.commenceTime}/${g.market}`;
    if (await blobs.get(STORE, doneKey)) { results.push({ ...g, skipped: 'done' }); continue; }
    if (credits.used + EST_COST > DAILY_CAP) {
      console.error(`[capture-pick-closes] daily cap ${DAILY_CAP} reached; skipping ${doneKey}`);
      results.push({ ...g, skipped: 'cap' });
      continue;
    }
    try {
      const from = new Date(new Date(g.commenceTime).getTime() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const to = new Date(new Date(g.commenceTime).getTime() + 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const qs = new URLSearchParams({
        apiKey: env.ODDS_API_KEY, regions: 'us', markets: g.market, bookmakers: 'pinnacle,draftkings',
        oddsFormat: 'american', commenceTimeFrom: from, commenceTimeTo: to,
      });
      const resp = await f(`https://api.the-odds-api.com/v4/sports/${S.ODDS_SPORT_KEYS[g.sport]}/odds?${qs}`);
      const last = Number(resp.headers && resp.headers.get ? resp.headers.get('x-requests-last') : EST_COST) || 0;
      credits.used += last;
      credits.remaining = resp.headers && resp.headers.get ? resp.headers.get('x-requests-remaining') : null;
      credits.calls.push({ at: when.toISOString(), sport: g.sport, commenceTime: g.commenceTime, market: g.market, cost: last });
      if (!resp.ok) throw new Error(`Odds API HTTP ${resp.status}`);
      const events = await resp.json();
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
  await blobs.set(STORE, creditKey, credits);
  return S.json(errors.length ? 500 : 200, { ok: !errors.length, due: groups.length, results, creditsToday: credits.used, errors });
}

exports.handler = (event) => handle(event, new Date());
exports.handle = handle;
exports.dueGroups = dueGroups;
exports.cardLegs = cardLegs;
exports.DAILY_CAP = DAILY_CAP;
