'use strict';

/**
 * Read-only dry run for the 3 AM historical close step.
 * Reads Netlify blobs. Writes nothing. Does not call The Odds API or Supabase.
 * Strips ODDS_API_KEY and SUPABASE_SERVICE_ROLE_KEY before any library work.
 */

const fs = require('fs');
const path = require('path');

delete process.env.ODDS_API_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const realFetch = global.fetch;
function scrub(text) {
  return String(text || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/apiKey=[^&\s]+/gi, 'apiKey=REDACTED')
    .replace(/authorization["']?\s*[:=]\s*["'][^"']+/gi, 'authorization:REDACTED');
}
global.fetch = async (url, opts) => {
  const href = String(url);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  if (href.includes('the-odds-api.com')) throw new Error('blocked Odds API');
  if (href.includes('supabase.co')) throw new Error('blocked Supabase');
  if (method !== 'GET' && method !== 'HEAD') throw new Error(`blocked ${method}`);
  return realFetch(url, opts);
};

const SITE = '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!token) {
  console.error('NETLIFY_AUTH_TOKEN missing');
  process.exit(1);
}

const C = require('../netlify/functions/lib/closes-3am');
const FB = require('../netlify/functions/lib/full-board-closes');
const S = require('../netlify/functions/lib/clv-supabase');
const track = require('../netlify/functions/track-clv-omega');
const { applyTrueClose } = require('../netlify/functions/lib/clv-true-close');

const DATES = ['2026-11-14', '2026-11-15', '2026-11-16'];
const OLD_SOURCE = 'oddsapi-live:capture-all-closes';

async function blobGet(store, key) {
  const enc = String(key).split('/').map(encodeURIComponent).join('/');
  const resp = await realFetch(`https://api.netlify.com/api/v1/blobs/${SITE}/${store}/${enc}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`blob GET ${store} HTTP ${resp.status}`);
  let body = await resp.json();
  if (body && typeof body.url === 'string' && Object.keys(body).length <= 2 && /^https:/.test(body.url)) {
    const follow = await realFetch(body.url);
    if (!follow.ok) return null;
    body = await follow.json();
  }
  return body;
}

async function blobList(store, prefix) {
  const keys = [];
  let cursor = null;
  for (let page = 0; page < 40; page += 1) {
    const url = new URL(`https://api.netlify.com/api/v1/blobs/${SITE}/${store}`);
    url.searchParams.set('prefix', prefix);
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await realFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`blob LIST ${store} HTTP ${resp.status}`);
    const data = await resp.json();
    for (const blob of data.blobs || []) if (blob && blob.key) keys.push(blob.key);
    cursor = data.next_cursor || null;
    if (!cursor) break;
  }
  return keys;
}

function decodeKey(key) {
  return String(key || '').split('/').map((part) => {
    try { return decodeURIComponent(part); } catch (_) { return part; }
  }).join('/');
}

function snapSig(row) {
  return [row.game_id, row.book, row.market, row.side, row.point, row.price, row.line_type].join('|');
}

function legCount(card) {
  let n = 0;
  for (const pick of (card && card.picks) || []) if (pick) n += 1;
  for (const ticket of (card && card.parlayLegs) || []) n += ((ticket && ticket.legs) || []).length;
  return n;
}

function memoryStore(seed) {
  const data = {};
  for (const [key, value] of Object.entries(seed || {})) data[key] = JSON.parse(JSON.stringify(value));
  return {
    data,
    writes: [],
    async get(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null; },
    async setJSON(key, value) {
      this.writes.push(key);
      data[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

function numClose(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const report = { plans: [], archiveCompare: null, clv: [], notes: [] };
  const loaded = {};
  for (const date of DATES) {
    const slate = await blobGet('odds-master', `by-date/${date}`);
    const card = await blobGet('edge-picks-omega', `picks-${date}`);
    const candidates = await blobGet('edge-picks-omega', `omega-candidates/${date}`);
    const games = C.collectGames((slate && slate.events) || [], card, candidates, date);
    const buckets = C.planBuckets(games);
    const bySport = {};
    let cardBuckets = 0;
    for (const bucket of buckets) {
      bySport[bucket.sport] = (bySport[bucket.sport] || 0) + 1;
      if (bucket.priority === 0) cardBuckets += 1;
    }
    const sports = {};
    for (const event of (slate && slate.events) || []) {
      const sport = String(event.sport || '');
      sports[sport] = (sports[sport] || 0) + 1;
    }
    loaded[date] = { slate, card, candidates, games, buckets };
    report.plans.push({
      date,
      slateGames: (slate && slate.events && slate.events.length) || 0,
      slateBySport: sports,
      slateUpdatedAt: slate && slate.updatedAt || null,
      cardLegs: legCount(card),
      straightCount: ((card && card.picks) || []).length,
      candidatesPresent: !!(candidates && ((candidates.candidates || candidates.rows || []).length || Array.isArray(candidates))),
      trackedGames: games.length,
      buckets: buckets.length,
      bucketsBySport: bySport,
      cardBuckets,
      estCredits: buckets.length * C.EST_COST,
      cap: C.DEFAULT_CAP,
    });
  }

  const rawKeys = await blobList('clv-close-capture', 'raw/2026-11-15/');
  const decoded = rawKeys.map(decodeKey);
  const oldRows = [];
  const newRows = [];
  const eventsBySport = {};
  const expectedDone = [];
  let archiveBodies = 0;
  let oldSnapCount = 0;
  let newSnapCount = 0;
  const onlyOld = [];
  const onlyNew = [];
  const sourceOld = new Set();
  const sourceNew = new Set();
  for (const key of decoded) {
    const doc = await blobGet('clv-close-capture', key);
    if (!doc || !doc.body) continue;
    archiveBodies += 1;
    const sport = (doc.meta && doc.meta.sport) || key.split('/')[2];
    const unpacked = C.unwrapHistorical(doc.body);
    const sportKey = C.sportKeyOf(sport);
    if (sportKey) {
      if (!eventsBySport[sportKey]) eventsBySport[sportKey] = [];
      eventsBySport[sportKey].push(...unpacked.events);
    }
    for (const event of unpacked.events) {
      if (!event) continue;
      const oldBuilt = S.rowsFromOddsEvent(sport, event, {
        lineType: 'closing', source: OLD_SOURCE, books: FB.BOOKS, markets: FB.MARKETS || C.MARKETS,
      });
      const newBuilt = S.rowsFromOddsEvent(sport, event, {
        lineType: 'closing', source: C.SOURCE, books: C.BOOKS, markets: C.MARKETS,
      });
      for (const snap of oldBuilt.snaps) {
        oldRows.push(snapSig(snap));
        sourceOld.add(snap.source);
        oldSnapCount += 1;
      }
      for (const snap of newBuilt.snaps) {
        newRows.push(snapSig(snap));
        sourceNew.add(snap.source);
        newSnapCount += 1;
      }
      const ct = FB.normalizeCommence(event.commence_time);
      for (const market of C.MARKETS) {
        if (!C.pinnacleMarket(event, market)) continue;
        expectedDone.push(FB.doneMarketKey(sport, ct, market));
        expectedDone.push(FB.doneEvKey(sport, event.id));
      }
    }
  }
  const oldSet = new Set(oldRows);
  const newSet = new Set(newRows);
  for (const sig of oldSet) if (!newSet.has(sig)) onlyOld.push(sig);
  for (const sig of newSet) if (!oldSet.has(sig)) onlyNew.push(sig);
  const doneKeys = [...new Set(expectedDone)];
  let doneFound = 0;
  const doneMissing = [];
  for (const key of doneKeys) {
    const doc = await blobGet('clv-close-capture', key);
    if (doc) doneFound += 1;
    else doneMissing.push(key);
  }
  const credits15 = await blobGet('clv-close-capture', 'credits/2026-11-15');
  const credits14 = await blobGet('clv-close-capture', 'credits/2026-11-14');
  report.archiveCompare = {
    archiveKeys: decoded.length,
    archiveBodies,
    oldSnapCount,
    newSnapCount,
    uniqueOld: oldSet.size,
    uniqueNew: newSet.size,
    onlyOld: onlyOld.slice(0, 12),
    onlyNew: onlyNew.slice(0, 12),
    onlyOldCount: onlyOld.length,
    onlyNewCount: onlyNew.length,
    sourceOld: [...sourceOld],
    sourceNew: [...sourceNew],
    doneExpected: doneKeys.length,
    doneFound,
    doneMissing: doneMissing.slice(0, 12),
    credits15: credits15 ? {
      used: credits15.used,
      usedActual: credits15.usedActual,
      cap: credits15.cap,
      remaining: credits15.remaining,
      calls: (credits15.calls || []).length,
      paths: [...new Set((credits15.calls || []).map((call) => call.path || 'full-board'))],
    } : null,
    credits14: credits14 ? { used: credits14.used, calls: (credits14.calls || []).length, remaining: credits14.remaining } : null,
    raw14: (await blobList('clv-close-capture', 'raw/2026-11-14/')).length,
    raw16: (await blobList('clv-close-capture', 'raw/2026-11-16/')).length,
  };

  for (const date of ['2026-11-14', '2026-11-15']) {
    const card = loaded[date].card;
    const clvDoc = await blobGet('edge-picks-omega', `clv-${date}`);
    const picks = (card && card.picks) || [];
    const entry = { date, straights: picks.length, storedPicks: (clvDoc && clvDoc.picks && clvDoc.picks.length) || 0, rows: [] };
    if (date === '2026-11-14') {
      entry.cause = 'no raw archives in clv-close-capture for 2026-11-14 (credits used 2). Stored-closes recompute has no event bodies.';
      report.clv.push(entry);
      continue;
    }
    const store = memoryStore({ [`picks-${date}`]: card });
    const prevFetch = global.fetch;
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('the-odds-api.com')) throw new Error('blocked Odds API');
      if (href.includes('site.api.espn.com') || href.includes('espn.com')) {
        return { ok: true, status: 200, json: async () => ({ events: [] }) };
      }
      return { ok: false, status: 599, json: async () => ({}) };
    };
    let handled = null;
    try {
      handled = await track.handle({
        httpMethod: 'POST',
        body: JSON.stringify({ date, storedCloses: true }),
      }, {
        now: '2026-11-16T12:00:00Z',
        env: {
          OMEGA_CLOSES_AT_3AM: 'on',
          OMEGA_CLV_TRUE_CLOSE: 'off',
          OMEGA_NCAAM_GRADE: 'off',
          OMEGA_V2_PICK_CLV_FILL: 'off',
        },
        fetch: async () => ({ ok: false, status: 599, json: async () => ({}), text: async () => '' }),
        store,
        storedEventsBySport: eventsBySport,
      });
    } finally {
      global.fetch = prevFetch;
    }
    const recomputed = store.data[`clv-${date}`];
    entry.trackStatus = handled && handled.statusCode;
    const oldByKey = new Map(((clvDoc && clvDoc.picks) || []).map((row) => [`${row.pick}||${row.matchup}`, row]));
    for (const row of (recomputed && recomputed.picks) || []) {
      const prev = oldByKey.get(`${row.pick}||${row.matchup}`) || null;
      const oldClv = numClose(prev && prev.clv);
      const newClv = numClose(row.clv);
      const oldOdds = prev && prev.closingOdds != null ? String(prev.closingOdds) : null;
      const newOdds = row.closingOdds != null ? String(row.closingOdds) : null;
      const clvDelta = oldClv != null && newClv != null ? Math.abs(oldClv - newClv) : null;
      entry.rows.push({
        pick: row.pick,
        matchup: row.matchup,
        sport: row.sport,
        oldClosingOdds: oldOdds,
        newClosingOdds: newOdds,
        oldClv,
        newClv,
        clvDelta,
        oldAnchor: prev && prev.anchorBook || null,
        newAnchor: row.anchorBook || null,
        oddsMatch: oldOdds === newOdds,
        clvMatch: clvDelta != null && clvDelta <= 0.00015,
        error: row.error || null,
      });
    }
    const games = [];
    const snaps = [];
    for (const [sportKey, events] of Object.entries(eventsBySport)) {
      const sport = C.sportLabelOf(sportKey);
      for (const event of events) {
        const built = S.rowsFromOddsEvent(sport, event, {
          lineType: 'closing', source: C.SOURCE, books: ['pinnacle'], markets: C.MARKETS,
        });
        if (built.game) games.push(built.game);
        snaps.push(...built.snaps.filter((row) => row.book === 'pinnacle'));
      }
    }
    const fakeEnv = { SUPABASE_SERVICE_ROLE_KEY: 'dry-run-not-a-real-key', OMEGA_CLV_TRUE_CLOSE: 'on' };
    const clone = JSON.parse(JSON.stringify(clvDoc || { date, picks: [] }));
    clone.date = date;
    let trueReport = null;
    try {
      trueReport = await applyTrueClose(clone, card || { picks: [] }, fakeEnv, async (url) => {
        const href = String(url);
        if (href.includes('the-odds-api.com')) throw new Error('blocked Odds API');
        if (!href.includes('supabase.co')) throw new Error('unexpected url');
        const rows = href.includes('odds_snapshots') ? snaps : games;
        return { ok: true, status: 200, json: async () => rows };
      });
    } catch (err) {
      entry.trueCloseError = scrub(err && err.message);
    }
    entry.trueClose = trueReport ? {
      upgraded: trueReport.upgraded,
      stillEarly: trueReport.stillEarly,
      noTrueClose: (trueReport.noTrueClose || []).map((row) => ({ pick: row.pick, reason: row.reason })),
    } : null;
    const afterByKey = new Map(((clone && clone.picks) || []).map((row) => [`${row.pick}||${row.matchup}`, row]));
    for (const row of entry.rows) {
      const after = afterByKey.get(`${row.pick}||${row.matchup}`);
      row.trueCloseOdds = after && after.closingOdds != null ? String(after.closingOdds) : null;
      row.trueCloseClv = numClose(after && after.clv);
      const delta = row.oldClv != null && row.trueCloseClv != null ? Math.abs(row.oldClv - row.trueCloseClv) : null;
      row.trueCloseMatch = row.oldClosingOdds === row.trueCloseOdds && delta != null && delta <= 0.00015;
    }
    report.clv.push(entry);
  }

  const out = path.join('/tmp', 'closes-dryrun-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(out);
  console.log(JSON.stringify({
    plans: report.plans.map((plan) => ({
      date: plan.date,
      slateGames: plan.slateGames,
      buckets: plan.buckets,
      estCredits: plan.estCredits,
      cardLegs: plan.cardLegs,
    })),
    archives: report.archiveCompare && {
      bodies: report.archiveCompare.archiveBodies,
      onlyOld: report.archiveCompare.onlyOldCount,
      onlyNew: report.archiveCompare.onlyNewCount,
      doneFound: report.archiveCompare.doneFound,
      doneExpected: report.archiveCompare.doneExpected,
    },
    clvDates: report.clv.map((row) => row.date),
  }));
})().catch((err) => {
  console.error(scrub(err && err.stack));
  process.exit(1);
});
